'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { BellIcon, BellOffIcon, BotIcon, LogOutIcon, RefreshCwIcon, SettingsIcon, UserIcon } from 'lucide-react';
import { api } from '@/lib/api';
import type { Conversation } from '@/lib/types';
import { initAudioUnlock, isMuted, playHumanWaiting, playNewMessage, setMuted } from '@/lib/sounds';
import { usePolling } from '@/hooks/usePolling';
import { timeAgo } from '@/lib/format';
import { useT } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';

type Filter = 'all' | 'human' | 'unread';

export function InboxList() {
  const router = useRouter();
  const pathname = usePathname();
  const { t, locale } = useT();

  // null = first load still in flight (Skeletons); [] = genuinely no conversations.
  const [list, setList] = useState<Conversation[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [muted, setMutedState] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  // Snapshots of the previous poll so we can detect *changes* and chime.
  const prevUnread = useRef<Map<string, number>>(new Map());
  const prevMode = useRef<Map<string, string>>(new Map());
  const primed = useRef(false); // skip sounds on the very first load

  useEffect(() => {
    setMutedState(isMuted());
    initAudioUnlock(); // unlock audio on first user interaction (autoplay policy)
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.conversations();

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
      setFetchError(false);
    } catch {
      setFetchError(true); // transient — keep the last list, surface a retry affordance
    }
  }, []);

  usePolling(load, 4000);

  function toggleMuted() {
    const next = !muted;
    setMutedState(next);
    setMuted(next);
  }

  const filtered = useMemo(() => {
    if (!list) return [];
    if (filter === 'human') return list.filter((c) => c.mode === 'human');
    if (filter === 'unread') return list.filter((c) => c.unread_count > 0);
    return list;
  }, [list, filter]);

  const escalated = list?.filter((c) => c.mode === 'human').length ?? 0;

  async function signOut() {
    await api.logout().catch(() => {});
    router.push('/login');
    router.refresh();
  }

  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
        <Logo markClassName="h-6 w-6 text-primary" />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleMuted}
          title={muted ? t.sidebar.muteOffTooltip : t.sidebar.muteOnTooltip}
          aria-label={muted ? t.sidebar.muteOffAria : t.sidebar.muteOnAria}
          aria-pressed={muted}
        >
          {muted ? <BellOffIcon className="size-4" /> : <BellIcon className="size-4" />}
        </Button>
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="gap-0 border-b border-border px-3 py-2.5">
        <TabsList className="w-full">
          <TabsTrigger value="all">{t.sidebar.filterAll}</TabsTrigger>
          <TabsTrigger value="human" className="gap-1.5">
            {t.sidebar.filterHuman}
            {escalated > 0 && <Badge variant="warning">{escalated}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="unread">{t.sidebar.filterUnread}</TabsTrigger>
        </TabsList>
        {/* No separate panels — the list below is the shared "content" for every
            filter value. Empty (visually hidden) panels keep each trigger's
            aria-controls pointing at a real element. */}
        <TabsContent value="all" className="hidden" />
        <TabsContent value="human" className="hidden" />
        <TabsContent value="unread" className="hidden" />
      </Tabs>

      {fetchError && (
        <Alert variant="destructive" className="m-3 w-auto py-2.5">
          <AlertDescription className="flex flex-row items-center justify-between gap-3">
            <span>{t.sidebar.fetchError}</span>
            <Button variant="outline" size="xs" onClick={() => void load()}>
              <RefreshCwIcon className="size-3" />
              {t.common.retry}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex-1 overflow-y-auto">
        {list === null &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}

        {list !== null && filtered.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">{t.sidebar.emptyList}</div>
        )}

        {list !== null &&
          filtered.map((c) => {
            const active = pathname === `/c/${c.id}`;
            const name = c.customer_name || c.phone || c.wa_jid;
            const initials = name.slice(0, 2).toUpperCase();
            return (
              <Link
                key={c.id}
                href={`/c/${c.id}`}
                className={cn(
                  'flex gap-3 border-b border-border px-4 py-3 outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  active && 'bg-accent',
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
                  {initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {timeAgo(c.last_message_at, locale, t.time.now)}
                    </span>
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">{c.last_message_preview || '—'}</span>
                  <span className="mt-1.5 flex items-center gap-1.5">
                    {c.mode === 'human' ? (
                      <Badge variant="warning">
                        <UserIcon className="size-3" />
                        {t.sidebar.modeHuman}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        <BotIcon className="size-3" />
                        arix
                      </Badge>
                    )}
                    {c.unread_count > 0 && (
                      <Badge variant="destructive" aria-label={`${c.unread_count} ${t.sidebar.unread}`}>
                        {c.unread_count}
                      </Badge>
                    )}
                  </span>
                </span>
              </Link>
            );
          })}
      </div>

      <div className="flex items-center justify-between gap-1 border-t border-border p-2">
        <Button variant="ghost" size="sm" className="gap-1.5" asChild>
          <Link href="/config">
            <SettingsIcon className="size-4" />
            {t.sidebar.settingsNav}
          </Link>
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="icon-sm" onClick={signOut} aria-label={t.sidebar.signOut} title={t.sidebar.signOut}>
          <LogOutIcon className="size-4" />
        </Button>
      </div>
    </aside>
  );
}
