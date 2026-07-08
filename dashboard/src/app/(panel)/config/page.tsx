'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const SECTIONS = [
  { key: 'info.payment', label: 'Medios de pago', hint: 'Alias para transferir, recargos, etc. El agente responde con esto.' },
  { key: 'info.shipping', label: 'Formas de envío', hint: 'Zonas, horarios y tiempos de entrega.' },
  { key: 'info.general', label: 'Información general / FAQ', hint: 'Cualquier otra cosa que el agente deba saber.' },
  {
    key: 'dispatch.template',
    label: 'Mensaje de envío Uber Moto',
    hint: 'Plantilla del WhatsApp al despachar un pedido. Placeholders: {numero} {link} {codigo}.',
  },
];

export default function ConfigPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, 'idle' | 'saving' | 'ok' | 'error'>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .settings()
      .then((s) => setValues(s))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save(key: string) {
    setSaved((s) => ({ ...s, [key]: 'saving' }));
    try {
      await api.saveSetting(key, values[key] ?? '');
      setSaved((s) => ({ ...s, [key]: 'ok' }));
      setTimeout(() => setSaved((s) => ({ ...s, [key]: 'idle' })), 2000);
    } catch {
      setSaved((s) => ({ ...s, [key]: 'error' }));
    }
  }

  return (
    <div className="config-page">
      <h2>Configuración</h2>
      <p style={{ color: 'var(--muted)', marginTop: -8 }}>
        Esta info la usa el agente para responder consultas (envíos, pagos, alias, horarios…).
      </p>
      {loading && <div style={{ color: 'var(--muted)' }}>Cargando…</div>}
      {!loading &&
        SECTIONS.map((sec) => (
          <div key={sec.key} className="config-section">
            <label>
              {sec.label} <small>{sec.hint}</small>
            </label>
            <textarea
              value={values[sec.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [sec.key]: e.target.value }))}
              rows={6}
            />
            <div className="config-actions">
              <button className="btn" onClick={() => save(sec.key)} disabled={saved[sec.key] === 'saving'}>
                {saved[sec.key] === 'saving' ? 'Guardando…' : 'Guardar'}
              </button>
              {saved[sec.key] === 'ok' && <span style={{ color: 'var(--green)' }}>✓ Guardado</span>}
              {saved[sec.key] === 'error' && <span style={{ color: 'var(--red)' }}>Error al guardar</span>}
            </div>
          </div>
        ))}
    </div>
  );
}
