'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Agent } from '@/lib/types';

export default function AgentesPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function load() {
    try {
      setAgents(await api.staff());
    } catch {
      /* transient — keep last list */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    setSaving(true);
    try {
      await api.createStaff({ name: name.trim(), email: email.trim(), password });
      setName('');
      setEmail('');
      setPassword('');
      setOk('Agente creado. Ya puede ingresar con su email y contraseña.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el agente.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(a: Agent) {
    if (!confirm(`¿Eliminar al agente ${a.name || a.email}? Su acceso se corta de inmediato.`)) return;
    setError(null);
    setOk(null);
    try {
      await api.deleteStaff(a.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo eliminar el agente.');
    }
  }

  async function resetPassword(a: Agent) {
    const pass = prompt(`Nueva contraseña para ${a.name || a.email} (mínimo 8 caracteres):`);
    if (pass == null) return;
    setError(null);
    setOk(null);
    if (pass.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    try {
      await api.resetStaffPassword(a.id, pass);
      setOk(`Contraseña actualizada para ${a.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar la contraseña.');
    }
  }

  return (
    <div className="config-page">
      <h2>Agentes</h2>
      <p style={{ color: 'var(--muted)', marginTop: -8 }}>
        Gestioná quién puede ingresar al panel como staff. Cada agente entra con su email y contraseña.
      </p>

      <form className="config-section" onSubmit={create}>
        <label>
          Nuevo agente <small>Nombre, email y contraseña (mínimo 8 caracteres).</small>
        </label>
        <div className="agent-form">
          <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Contraseña (mín. 8)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Creando…' : 'Agregar agente'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {ok && <div style={{ color: 'var(--green)', marginTop: 10, fontSize: 13 }}>{ok}</div>}
      </form>

      <div className="config-section">
        <label>Agentes con acceso</label>
        {loading && <div style={{ color: 'var(--muted)' }}>Cargando…</div>}
        {!loading && agents.length === 0 && <div style={{ color: 'var(--muted)' }}>No hay agentes todavía.</div>}
        {agents.map((a) => (
          <div key={a.id} className="agent-row">
            <div>
              <div style={{ fontWeight: 600 }}>{a.name || '—'}</div>
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>{a.email}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn secondary" onClick={() => resetPassword(a)}>
                Resetear contraseña
              </button>
              <button className="btn secondary" onClick={() => remove(a)}>
                Eliminar
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
