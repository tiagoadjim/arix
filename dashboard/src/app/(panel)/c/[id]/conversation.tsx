'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  BotIcon,
  FileIcon,
  ImageIcon,
  MicIcon,
  RefreshCwIcon,
  SendHorizontalIcon,
  StickerIcon,
  UserIcon,
  VideoIcon,
} from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import type { Conversation as Conv, Message, Receipt, StaffOrder } from '@/lib/types';
import type { Dictionary } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { formatClockTime } from '@/lib/format';
import { usePolling } from '@/hooks/usePolling';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { OrdersPanel } from './orders-panel';
import { ReceiptsPanel } from './receipts-panel';

const MEDIA_ICON: Record<string, typeof MicIcon> = {
  audio: MicIcon,
  video: VideoIcon,
  sticker: StickerIcon,
  document: FileIcon,
  image: ImageIcon,
};

const BUBBLE_CLASS: Record<Message['sender'], string> = {
  customer: 'self-start bg-bubble-customer text-bubble-customer-foreground',
  agent: 'self-end bg-bubble-agent text-bubble-agent-foreground',
  human: 'self-end bg-bubble-human text-bubble-human-foreground',
  system: 'max-w-[90%] self-center bg-bubble-system text-xs text-bubble-system-foreground italic',
};

function mediaLabel(t: Dictionary, msgType: string): string {
  return (t.conversation.media as Record<string, string>)[msgType] ?? msgType;
}

export function Conversation({ conversationId }: { conversationId: string }) {
  const { t, locale } = useT();
  const [conv, setConv] = useState<Conv | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [ordersState, setOrdersState] = useState<'idle' | 'loading' | 'error'>('loading');
  const bottomRef = useRef<HTMLDivElement>(null);
  const countRef = useRef(0);

  // Fetch the customer's WooCommerce orders once on open (NOT in the 3s poll, to
  // avoid hammering WooCommerce). OrdersPanel exposes a manual refresh button.
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

  const load = useCallback(async () => {
    try {
      const data = await api.conversation(conversationId);
      setConv(data.conversation);
      setMessages(data.messages);
      setReceipts(data.receipts);
      setNotFound(false);
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) setNotFound(true);
    }
  }, [conversationId]);

  // Reset local state whenever the conversation id changes (navigating between
  // chats) so the previous chat's messages never flash before the fresh load
  // lands. usePolling below already fires an immediate call on mount, so this
  // only needs to force an extra immediate fetch when SWITCHING conversations
  // on an already-mounted component (usePolling's own timer doesn't restart
  // just because the wrapped callback's identity changed).
  const mountedOnce = useRef(false);
  useEffect(() => {
    setConv(null);
    setMessages([]);
    setReceipts([]);
    setNotFound(false);
    countRef.current = 0;
    if (mountedOnce.current) void load();
    mountedOnce.current = true;
  }, [conversationId, load]);

  usePolling(load, 3000);

  // Autoscroll only when new messages arrive.
  useEffect(() => {
    if (messages.length !== countRef.current) {
      countRef.current = messages.length;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  async function setMode(mode: 'bot' | 'human') {
    if (!conv) return;
    try {
      const updated = await api.setMode(conv.id, mode);
      setConv(updated);
    } catch (err) {
      toast.error(t.common.error, { description: apiErrorMessage(err, t, t.common.error) });
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
      toast.error(t.conversation.sendFailed, { description: apiErrorMessage(err, t, t.conversation.sendFailed) });
    } finally {
      setSending(false);
    }
  }

  if (notFound) {
    return <div className="grid h-full place-items-center text-muted-foreground">{t.conversation.notFound}</div>;
  }
  if (!conv) {
    return <div className="grid h-full place-items-center text-muted-foreground">{t.conversation.loadingConversation}</div>;
  }

  const isHuman = conv.mode === 'human';

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{conv.customer_name || conv.phone || conv.wa_jid}</p>
          <p className="truncate text-xs text-muted-foreground">
            {conv.phone ?? conv.wa_jid}
            {conv.escalation_reason ? ` · ${conv.escalation_reason}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={isHuman ? 'warning' : 'outline'} className={cn(!isHuman && 'text-muted-foreground')}>
            {isHuman ? <UserIcon className="size-3" /> : <BotIcon className="size-3" />}
            {isHuman ? t.conversation.modeHuman : t.conversation.modeBot}
          </Badge>
          {isHuman ? (
            <Button variant="outline" size="sm" onClick={() => void setMode('bot')}>
              {t.conversation.returnToBot}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void setMode('human')}>
              {t.conversation.takeChat}
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} aria-label={t.common.refresh} title={t.common.refresh}>
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        <div
          className="flex flex-col gap-2 overflow-y-auto p-4"
          role="log"
          aria-live="polite"
          aria-label={t.conversation.messagesLabel}
        >
          {messages.map((m) => {
            const MediaIcon = MEDIA_ICON[m.msg_type];
            return (
              <div
                key={m.id}
                className={cn(
                  'flex max-w-[72%] flex-col gap-1 rounded-xl px-3 py-2 text-sm leading-snug break-words whitespace-pre-wrap',
                  BUBBLE_CLASS[m.sender],
                )}
              >
                {m.body}
                {!m.body && !m.media_url && MediaIcon && (
                  <span className="inline-flex items-center gap-1.5">
                    <MediaIcon className="size-3.5" />
                    {mediaLabel(t, m.msg_type)}
                  </span>
                )}
                {m.media_url && (
                  <img src={api.mediaUrl(m.media_url)} alt={t.conversation.mediaAlt} className="mt-1 max-w-[220px] rounded-md" />
                )}
                <span className="text-[10px] opacity-70">
                  {t.conversation.sender[m.sender]}
                  {' · '}
                  {formatClockTime(m.created_at, locale)}
                  {m.send_status === 'failed' && ` · ${t.conversation.messageFailedTag}`}
                </span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <aside className="flex flex-col gap-4 overflow-y-auto border-l border-border bg-card p-4">
          <OrdersPanel conversationId={conversationId} orders={orders} state={ordersState} onReload={loadOrders} />
          <ReceiptsPanel receipts={receipts} />
        </aside>
      </div>

      {isHuman ? (
        <div className="flex items-end gap-2 border-t border-border bg-card p-3">
          <Textarea
            placeholder={t.conversation.composerPlaceholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            className="min-h-11 flex-1 resize-none"
            rows={1}
            disabled={sending}
            aria-label={t.conversation.composerPlaceholder}
          />
          <Button onClick={() => void send()} disabled={sending || !text.trim()} size="icon" aria-label={t.conversation.send}>
            <SendHorizontalIcon className="size-4" />
          </Button>
        </div>
      ) : (
        <p className="border-t border-border p-3 text-xs text-muted-foreground">{t.conversation.botHint}</p>
      )}
    </>
  );
}
