'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { Conversation } from '@/lib/types';
import {
  initAudioUnlock,
  isMuted,
  playHumanWaiting,
  playNewMessage,
  setMuted,
} from '@/lib/sounds';

type Filter = 'all' | 'human' | 'unread';

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function InboxList() {
  const router = useRouter();
  const pathname = usePathname();
  const [list, setList] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [muted, setMutedState] = useState(false);

  // Snapshots of the previous poll so we can detect *changes* and chime.
  const prevUnread = useRef<Map<string, number>>(new Map());
  const prevMode = useRef<Map<string, string>>(new Map());
  const primed = useRef(false); // skip sounds on the very first load

  useEffect(() => {
    setMutedState(isMuted());
    initAudioUnlock(); // unlock audio on first user interaction (autoplay policy)
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await api.conversations();
        if (!alive) return;

        // Detect new customer messages (unread grew — never fires on the agent's own
        // replies, which reset unread to 0) and fresh human escalations.
        let gotMessage = false;
        let gotHuman = false;
        for (const c of data) {
          if (c.unread_count > (prevUnread.current.get(c.id) ?? 0)) gotMessage = true;
          if (c.mode === 'human' && prevMode.current.get(c.id) !== 'human') gotHuman = true;
        }
        prevUnread.current = new Map(data.map((c) => [c.id, c.unread_count]));
        prevMode.current = new Map(data.map((c) => [c.id, c.mode]));

        if (primed.current) {
          // A human handoff is more urgent: play that and skip the generic ding.
          if (gotHuman) playHumanWaiting();
          else if (gotMessage) playNewMessage();
        } else {
          primed.current = true; // first load just seeds the snapshots
        }

        setList(data);
      } catch {
        /* transient — keep last list */
      }
    };
    void load();
    const t = setInterval(load, 4000); // poll the inbox
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  function toggleMuted() {
    const next = !muted;
    setMutedState(next);
    setMuted(next);
  }

  const filtered = useMemo(() => {
    if (filter === 'human') return list.filter((c) => c.mode === 'human');
    if (filter === 'unread') return list.filter((c) => c.unread_count > 0);
    return list;
  }, [list, filter]);

  const escalated = list.filter((c) => c.mode === 'human').length;

  async function signOut() {
    await api.logout().catch(() => {});
    router.push('/login');
    router.refresh();
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">Arix</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn secondary"
            style={{ padding: '5px 10px', fontSize: 12 }}
            onClick={toggleMuted}
            title={muted ? 'Sonidos silenciados — clic para activar' : 'Sonidos activados — clic para silenciar'}
            aria-label={muted ? 'Activar sonidos' : 'Silenciar sonidos'}
          >
            {muted ? '🔕' : '🔔'}
          </button>
          <Link className="btn secondary" style={{ padding: '5px 10px', fontSize: 12 }} href="/agentes">
            🧑 Agentes
          </Link>
          <Link className="btn secondary" style={{ padding: '5px 10px', fontSize: 12 }} href="/config">
            ⚙ Config
          </Link>
          <button className="btn secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={signOut}>
            Salir
          </button>
        </div>
      </div>
      <div className="filters">
        <button className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          Todas
        </button>
        <button className={`chip ${filter === 'human' ? 'active' : ''}`} onClick={() => setFilter('human')}>
          Con humano{escalated ? ` (${escalated})` : ''}
        </button>
        <button className={`chip ${filter === 'unread' ? 'active' : ''}`} onClick={() => setFilter('unread')}>
          No leídas
        </button>
      </div>
      <div className="conv-list">
        {filtered.length === 0 && <div style={{ padding: 16, color: 'var(--muted)' }}>Sin conversaciones.</div>}
        {filtered.map((c) => {
          const active = pathname === `/c/${c.id}`;
          return (
            <Link key={c.id} href={`/c/${c.id}`} className={`conv-row ${active ? 'active' : ''}`}>
              <div className="conv-top">
                <span className="conv-name">{c.customer_name || c.phone || c.wa_jid}</span>
                <span className="conv-time">{timeAgo(c.last_message_at)}</span>
              </div>
              <div className="conv-preview">{c.last_message_preview || '—'}</div>
              <div className="badges">
                <span className={`badge ${c.mode}`}>{c.mode === 'human' ? '👤 Humano' : '🤖 Arix'}</span>
                {c.unread_count > 0 && <span className="badge unread">{c.unread_count}</span>}
              </div>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
