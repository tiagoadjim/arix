'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Conversation as Conv, Message, Receipt, StaffOrder } from '@/lib/types';

const SENDER_LABEL: Record<string, string> = {
  customer: 'Cliente',
  agent: 'Agente',
  human: 'Vos',
  system: 'Sistema',
};

// Non-text media is stored with an empty body, so show a label instead of a
// blank bubble (audios/stickers have no image to render either).
const MEDIA_LABEL: Record<string, string> = {
  audio: '🎤 Audio',
  video: '🎬 Video',
  sticker: '💟 Sticker',
  document: '📎 Archivo',
  image: '📎 Imagen',
};

// Mirrors the server's STATUS_ES (server/src/skills/orders.ts) for the status dropdown.
const ORDER_STATUSES: { value: string; label: string }[] = [
  { value: 'pending', label: 'Pago pendiente' },
  { value: 'processing', label: 'En preparación' },
  { value: 'en-camino', label: 'En camino 🛵' },
  { value: 'on-hold', label: 'En espera' },
  { value: 'completed', label: 'Completado' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'refunded', label: 'Reembolsado' },
  { value: 'failed', label: 'Fallido' },
];

export function Conversation({ conversationId }: { conversationId: string }) {
  const [conv, setConv] = useState<Conv | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [ordersState, setOrdersState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [orderBusy, setOrderBusy] = useState<Record<number, boolean>>({});
  const [statusSel, setStatusSel] = useState<Record<number, string>>({});
  const [delivery, setDelivery] = useState<Record<number, { link: string; code: string }>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const countRef = useRef(0);

  // Fetch the customer's WooCommerce orders once on open (NOT in the 3s poll, to
  // avoid hammering WooCommerce). A button lets staff refresh on demand.
  const loadOrders = useCallback(async () => {
    setOrdersState('loading');
    try {
      const data = await api.orders(conversationId);
      setOrders(data.orders);
      setOrdersState('idle');
    } catch {
      setOrdersState('error');
    }
  }, [conversationId]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  // Initial load + poll the full detail every 3s (simple + robust for an internal tool).
  useEffect(() => {
    let alive = true;
    setConv(null);
    setMessages([]);
    setReceipts([]);
    setNotFound(false);
    countRef.current = 0;

    const load = async () => {
      try {
        const data = await api.conversation(conversationId);
        if (!alive) return;
        setConv(data.conversation);
        setMessages(data.messages);
        setReceipts(data.receipts);
      } catch (err) {
        if (alive && err instanceof Error && err.message.includes('404')) setNotFound(true);
      }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [conversationId]);

  // Autoscroll only when new messages arrive.
  useEffect(() => {
    if (messages.length !== countRef.current) {
      countRef.current = messages.length;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  async function setMode(mode: 'bot' | 'human') {
    if (!conv) return;
    const updated = await api.setMode(conv.id, mode);
    setConv(updated);
  }

  async function changeStatus(o: StaffOrder) {
    const status = statusSel[o.id] ?? o.estado;
    if (status === o.estado) return;
    setOrderBusy((b) => ({ ...b, [o.id]: true }));
    try {
      await api.updateOrderStatus(conversationId, o.id, status);
      await loadOrders();
    } catch (err) {
      alert(`No se pudo cambiar el estado: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setOrderBusy((b) => ({ ...b, [o.id]: false }));
    }
  }

  async function sendDelivery(o: StaffOrder) {
    const d = delivery[o.id] ?? { link: '', code: '' };
    if (!d.link.trim() || !d.code.trim()) {
      alert('Pegá el enlace de seguimiento y el código de entrega.');
      return;
    }
    setOrderBusy((b) => ({ ...b, [o.id]: true }));
    try {
      const r = await api.sendDelivery(conversationId, o.id, {
        trackingUrl: d.link.trim(),
        deliveryCode: d.code.trim(),
        orderNumber: o.numero,
      });
      setDelivery((s) => ({ ...s, [o.id]: { link: '', code: '' } }));
      await loadOrders();
      if (!r.statusUpdated) {
        alert(
          'Mensaje enviado al cliente. Aviso: no se pudo poner el estado "en-camino" en WooCommerce (¿está registrado ese estado custom?).',
        );
      }
    } catch (err) {
      alert(`No se pudo enviar: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setOrderBusy((b) => ({ ...b, [o.id]: false }));
    }
  }

  async function send() {
    if (!conv) return;
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setText('');
    try {
      const msg = await api.send(conv.id, body);
      setMessages((prev) => [...prev, msg]);
    } catch (err) {
      setText(body);
      alert(`No se pudo enviar: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setSending(false);
    }
  }

  if (notFound) return <div className="empty">Conversación no encontrada.</div>;
  if (!conv) return <div className="empty">Cargando…</div>;

  const isHuman = conv.mode === 'human';

  return (
    <>
      <div className="chat-header">
        <div>
          <div style={{ fontWeight: 600 }}>{conv.customer_name || conv.phone || conv.wa_jid}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            {conv.phone ?? conv.wa_jid}
            {conv.escalation_reason ? ` · ${conv.escalation_reason}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={`badge ${conv.mode}`}>{isHuman ? '👤 Atiende humano' : '🤖 Atiende Arix'}</span>
          {isHuman ? (
            <button className="btn secondary" onClick={() => setMode('bot')}>
              Devolver a Arix
            </button>
          ) : (
            <button className="btn" onClick={() => setMode('human')}>
              Tomar chat
            </button>
          )}
        </div>
      </div>

      <div className="chat-body">
        <div className="messages">
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.sender}`}>
              {m.body || (!m.media_url && MEDIA_LABEL[m.msg_type]) || null}
              {m.media_url && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={api.mediaUrl(m.media_url)} alt="adjunto" />
              )}
              <span className="meta">
                {SENDER_LABEL[m.sender] ?? m.sender}
                {' · '}
                {new Date(m.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                {m.send_status === 'failed' && ' · ❌ falló'}
              </span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="side">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Pedidos del cliente</h3>
            <button
              className="btn secondary"
              style={{ padding: '3px 8px', fontSize: 11 }}
              onClick={loadOrders}
              disabled={ordersState === 'loading'}
            >
              {ordersState === 'loading' ? '…' : '↻'}
            </button>
          </div>
          <div className="orders" style={{ marginBottom: 18 }}>
            {ordersState === 'error' && (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>No se pudieron traer los pedidos.</div>
            )}
            {ordersState !== 'error' && orders.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                {ordersState === 'loading' ? 'Buscando pedidos…' : 'Sin pedidos para este contacto.'}
              </div>
            )}
            {orders.map((o) => (
              <div key={o.numero} className="order">
                <div className="order-top">
                  <span>#{o.numero}</span>
                  <span className={`match ${o.estado === 'processing' || o.estado === 'completed' ? 'match' : 'pending'}`}>
                    {o.estado_texto}
                  </span>
                </div>
                <div className="meta">
                  {new Date(o.fecha).toLocaleDateString('es-AR')} · {o.total} {o.moneda}
                  {o.metodo_pago ? ` · ${o.metodo_pago}` : ''}
                </div>
                {o.envio.direccion && (
                  <div className="meta">
                    📍 {[o.envio.nombre, o.envio.direccion, o.envio.ciudad, o.envio.provincia].filter(Boolean).join(', ')}
                  </div>
                )}
                <ul>
                  {o.items.map((it, idx) => (
                    <li key={idx}>
                      {it.cantidad}× {it.producto}
                    </li>
                  ))}
                </ul>

                <div className="order-actions">
                  <select
                    value={statusSel[o.id] ?? o.estado}
                    onChange={(e) => setStatusSel((s) => ({ ...s, [o.id]: e.target.value }))}
                    disabled={orderBusy[o.id]}
                  >
                    {ORDER_STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn secondary"
                    onClick={() => changeStatus(o)}
                    disabled={orderBusy[o.id] || (statusSel[o.id] ?? o.estado) === o.estado}
                  >
                    Cambiar
                  </button>
                </div>

                <div className="delivery-form">
                  <div className="delivery-title">🛵 Envío Uber Moto</div>
                  <input
                    placeholder="Enlace de seguimiento"
                    value={delivery[o.id]?.link ?? ''}
                    onChange={(e) =>
                      setDelivery((s) => ({ ...s, [o.id]: { link: e.target.value, code: s[o.id]?.code ?? '' } }))
                    }
                    disabled={orderBusy[o.id]}
                  />
                  <input
                    placeholder="Código de entrega"
                    value={delivery[o.id]?.code ?? ''}
                    onChange={(e) =>
                      setDelivery((s) => ({ ...s, [o.id]: { link: s[o.id]?.link ?? '', code: e.target.value } }))
                    }
                    disabled={orderBusy[o.id]}
                  />
                  <button className="btn" onClick={() => sendDelivery(o)} disabled={orderBusy[o.id]}>
                    {orderBusy[o.id] ? 'Enviando…' : 'Enviar seguimiento por WhatsApp'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <h3>Comprobantes</h3>
          {receipts.length === 0 && <div style={{ color: 'var(--muted)' }}>Sin comprobantes.</div>}
          {receipts.map((r) => (
            <div key={r.id} className="receipt">
              {r.media_url && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={api.mediaUrl(r.media_url)} alt="comprobante" />
              )}
              <div className="row">
                <span>Orden</span>
                <span>{r.order_number ?? '—'}</span>
              </div>
              <div className="row">
                <span>Monto comprobante</span>
                <span>{r.extracted_amount ?? '—'}</span>
              </div>
              <div className="row">
                <span>Total orden</span>
                <span>
                  {r.woo_total ?? '—'} {r.currency ?? ''}
                </span>
              </div>
              <div className="row">
                <span>Resultado</span>
                <span className={`match ${r.match_status}`}>{r.match_status}</span>
              </div>
              {r.note && <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 12 }}>{r.note}</div>}
            </div>
          ))}
        </div>
      </div>

      {isHuman ? (
        <div className="composer">
          <textarea
            placeholder="Escribí tu respuesta…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn" onClick={send} disabled={sending || !text.trim()}>
            Enviar
          </button>
        </div>
      ) : (
        <div className="hint">
          Arix está atendiendo este chat automáticamente. Tocá <b>Tomar chat</b> para responder vos
          (se pausan las respuestas de Arix).
        </div>
      )}
    </>
  );
}
