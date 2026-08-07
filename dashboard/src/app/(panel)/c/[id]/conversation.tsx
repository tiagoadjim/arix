'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ArrowLeftIcon,
  BotIcon,
  FileIcon,
  ImageIcon,
  MicIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
  SendHorizontalIcon,
  StickerIcon,
  UserIcon,
  VideoIcon,
  XIcon,
} from 'lucide-react';
import { api, ApiError, apiErrorMessage } from '@/lib/api';
import type { Conversation as Conv, Message, Receipt, StaffOrder } from '@/lib/types';
import type { Dictionary } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { formatClockTime } from '@/lib/format';
import { usePolling } from '@/hooks/usePolling';
import { useServerEvents } from '@/hooks/useServerEvents';
import { cn } from '@/lib/utils';
import { createClientId } from '@/lib/id';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { OrdersPanel } from './orders-panel';
import { ReceiptsPanel } from './receipts-panel';

const INITIAL_MESSAGE_LIMIT = 100;
const MESSAGE_PAGE_SIZE = 50;
const NEW_MESSAGE_PAGE_SIZE = 100;
const METADATA_POLL_INTERVAL = 5;

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

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => {
    const byTime = a.created_at.localeCompare(b.created_at);
    return byTime === 0 ? a.id.localeCompare(b.id) : byTime;
  });
}

function nearBottom(element: HTMLElement | null): boolean {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
}

export function Conversation({ conversationId }: { conversationId: string }) {
  const { t, locale } = useT();
  const [conv, setConv] = useState<Conv | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [unseenNew, setUnseenNew] = useState(0);
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [ordersState, setOrdersState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Render the desktop aside during SSR; the media query swaps it for an
  // accessible Radix dialog drawer on narrower viewports after hydration.
  const [wideDetails, setWideDetails] = useState(true);

  const messageListRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const latestMessageIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const metadataPollRef = useRef(0);
  const forceMetadataRef = useRef(false);
  const olderControllerRef = useRef<AbortController | null>(null);
  const ordersControllerRef = useRef<AbortController | null>(null);
  const sendAttemptRef = useRef<{ body: string; clientId: string } | null>(null);
  const scrollModeRef = useRef<ScrollBehavior | null>(null);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);

  const commitMessages = useCallback((next: Message[]) => {
    messagesRef.current = next;
    latestMessageIdRef.current = next.at(-1)?.id ?? null;
    setMessages(next);
  }, []);

  const appendNewMessages = useCallback(
    (incoming: Message[], forceScroll = false): Message[] => {
      if (incoming.length === 0) return [];
      const existingIds = new Set(messagesRef.current.map((message) => message.id));
      const additions = incoming.filter((message) => !existingIds.has(message.id));
      const shouldFollow = forceScroll || nearBottom(messageListRef.current) || messagesRef.current.length === 0;

      if (additions.length > 0) {
        if (shouldFollow) scrollModeRef.current = messagesRef.current.length === 0 ? 'auto' : 'smooth';
        else setUnseenNew((count) => count + additions.length);
      }

      commitMessages(mergeMessages(messagesRef.current, incoming));
      return additions;
    },
    [commitMessages],
  );

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1280px)');
    const update = () => {
      setWideDetails(query.matches);
      if (query.matches) setDetailsOpen(false);
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // Reset all cursor and display state before usePolling restarts for a new id.
  useEffect(() => {
    olderControllerRef.current?.abort();
    ordersControllerRef.current?.abort();
    initializedRef.current = false;
    metadataPollRef.current = 0;
    forceMetadataRef.current = false;
    messagesRef.current = [];
    latestMessageIdRef.current = null;
    sendAttemptRef.current = null;
    setConv(null);
    setMessages([]);
    setReceipts([]);
    setOrders([]);
    setOrdersState('loading');
    setNotFound(false);
    setLoadError(false);
    setHasOlder(false);
    setLoadingOlder(false);
    setHistoryError(false);
    setUnseenNew(0);
    setDetailsOpen(false);
    return () => olderControllerRef.current?.abort();
  }, [conversationId]);

  // Fetch WooCommerce only on open/manual refresh, never in the 3-second poll.
  const loadOrders = useCallback(async () => {
    ordersControllerRef.current?.abort();
    const controller = new AbortController();
    ordersControllerRef.current = controller;
    setOrdersState('loading');
    try {
      const data = await api.orders(conversationId, controller.signal);
      if (controller.signal.aborted) return;
      setOrders(data.orders);
      setOrdersState('idle');
    } catch {
      if (!controller.signal.aborted) setOrdersState('error');
    }
  }, [conversationId]);

  useEffect(() => {
    void loadOrders();
    return () => ordersControllerRef.current?.abort();
  }, [loadOrders]);

  const markRead = useCallback(async (signal: AbortSignal) => {
    try {
      await api.markRead(conversationId, signal);
      if (!signal.aborted) setConv((current) => (current ? { ...current, unread_count: 0 } : current));
    } catch {
      // Idempotent and best-effort. A later poll/open retries naturally.
    }
  }, [conversationId]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        if (!initializedRef.current) {
          const data = await api.conversation(conversationId, signal);
          if (signal.aborted) return;

          setConv({ ...data.conversation, unread_count: 0 });
          setReceipts(data.receipts);
          scrollModeRef.current = 'auto';
          commitMessages(data.messages);
          setHasOlder(data.messages.length >= INITIAL_MESSAGE_LIMIT);
          setNotFound(false);
          setLoadError(false);
          initializedRef.current = true;
          await markRead(signal);
          return;
        }

        let additions: Message[] = [];
        let cursor = latestMessageIdRef.current;

        // Drain every available page in one serialized polling turn. The
        // safety bound prevents a malformed backend response from looping.
        if (cursor) {
          for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
            const page = await api.messages(conversationId, { after: cursor, limit: NEW_MESSAGE_PAGE_SIZE }, signal);
            if (signal.aborted) return;
            const pageAdditions = appendNewMessages(page.messages);
            additions = additions.concat(pageAdditions);
            const nextCursor = page.messages.at(-1)?.id;
            if (!page.hasMore || !nextCursor || nextCursor === cursor) break;
            cursor = nextCursor;
          }
        }

        metadataPollRef.current += 1;
        const refreshMetadata = forceMetadataRef.current || !latestMessageIdRef.current || metadataPollRef.current >= METADATA_POLL_INTERVAL;
        if (refreshMetadata) {
          const data = await api.conversation(conversationId, signal);
          if (signal.aborted) return;
          setConv(data.conversation);
          setReceipts(data.receipts);
          additions = additions.concat(appendNewMessages(data.messages));
          metadataPollRef.current = 0;
          forceMetadataRef.current = false;
        }

        if (additions.some((message) => message.direction === 'in')) await markRead(signal);
        setNotFound(false);
        setLoadError(false);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && (error.status === 404 || error.code === 'conversation_not_found')) {
          setNotFound(true);
        } else {
          setLoadError(true);
        }
      }
    },
    [appendNewMessages, commitMessages, conversationId, markRead],
  );

  const polling = usePolling(load, 15_000, { restartKey: conversationId });
  useServerEvents((event) => {
    if (!event.conversationId || event.conversationId === conversationId) {
      forceMetadataRef.current = true;
      polling.refresh();
    }
  });

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;

    const preserved = preserveScrollRef.current;
    if (preserved) {
      preserveScrollRef.current = null;
      list.scrollTop = preserved.top + (list.scrollHeight - preserved.height);
      return;
    }

    const behavior = scrollModeRef.current;
    if (behavior) {
      scrollModeRef.current = null;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      bottomRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : behavior });
      setUnseenNew(0);
    }
  }, [messages]);

  async function loadOlder() {
    const firstId = messagesRef.current[0]?.id;
    if (!firstId || loadingOlder) return;

    olderControllerRef.current?.abort();
    const controller = new AbortController();
    olderControllerRef.current = controller;
    setLoadingOlder(true);
    setHistoryError(false);

    const list = messageListRef.current;
    const previousPosition = list ? { height: list.scrollHeight, top: list.scrollTop } : null;

    try {
      const page = await api.messages(conversationId, { before: firstId, limit: MESSAGE_PAGE_SIZE }, controller.signal);
      if (controller.signal.aborted) return;
      if (page.messages.length > 0 && previousPosition) preserveScrollRef.current = previousPosition;
      commitMessages(mergeMessages(messagesRef.current, page.messages));
      setHasOlder(page.hasMore);
    } catch {
      if (!controller.signal.aborted) setHistoryError(true);
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

  function refreshAll() {
    forceMetadataRef.current = true;
    polling.refresh();
  }

  function handleReceiptReviewed(receipt: Receipt, order?: StaffOrder) {
    setReceipts((current) => current.map((item) => (item.id === receipt.id ? receipt : item)));
    if (order) {
      setOrders((current) => {
        const exists = current.some((item) => item.id === order.id);
        return exists ? current.map((item) => (item.id === order.id ? order : item)) : [order, ...current];
      });
    }
    // Reconcile receipts/order metadata in case the review had server-side
    // effects beyond the returned rows.
    refreshAll();
  }

  async function setMode(mode: 'bot' | 'human') {
    if (!conv) return;
    try {
      const updated = await api.setMode(conv.id, mode);
      setConv(updated);
    } catch (error) {
      toast.error(t.common.error, { description: apiErrorMessage(error, t, t.common.error) });
    }
  }

  async function send() {
    if (!conv) return;
    const body = text.trim();
    if (!body) return;
    const previousAttempt = sendAttemptRef.current;
    const clientId = previousAttempt?.body === body ? previousAttempt.clientId : createClientId();
    sendAttemptRef.current = { body, clientId };
    setSending(true);
    setText('');
    try {
      const message = await api.send(conv.id, body, clientId);
      sendAttemptRef.current = null;
      appendNewMessages([message], true);
    } catch (error) {
      setText(body);
      toast.error(t.conversation.sendFailed, { description: apiErrorMessage(error, t, t.conversation.sendFailed) });
    } finally {
      setSending(false);
    }
  }

  function scrollToLatest() {
    scrollModeRef.current = 'smooth';
    bottomRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setUnseenNew(0);
  }

  if (notFound) {
    return (
      <div className="grid h-full place-items-center gap-3 p-4 text-center text-muted-foreground">
        <p>{t.conversation.notFound}</p>
        <Button variant="outline" asChild className="md:hidden">
          <Link href="/">{t.sidebar.backToInbox}</Link>
        </Button>
      </div>
    );
  }
  if (!conv) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground" role="status" aria-live="polite">
        {loadError ? (
          <div className="flex flex-col items-center gap-3">
            <span>{t.common.error}</span>
            <Button variant="outline" onClick={refreshAll}>{t.common.retry}</Button>
          </div>
        ) : t.conversation.loadingConversation}
      </div>
    );
  }

  const isHuman = conv.mode === 'human';
  const details = (
    <>
      <OrdersPanel key={`orders:${conversationId}`} conversationId={conversationId} orders={orders} state={ordersState} onReload={loadOrders} />
      <ReceiptsPanel key={`receipts:${conversationId}`} receipts={receipts} onReviewed={handleReceiptReviewed} />
    </>
  );

  return (
    <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-3 py-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button variant="ghost" size="icon-sm" asChild className="md:hidden">
            <Link href="/" aria-label={t.sidebar.backToInbox} title={t.sidebar.backToInbox}>
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate font-semibold">{conv.customer_name || conv.phone || conv.wa_jid}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {conv.phone ?? conv.wa_jid}
              {conv.escalation_reason ? ` · ${conv.escalation_reason}` : ''}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 max-sm:w-full">
          {/* The mode label is spelled out from `sm` up. On a phone the four
              controls together overflow the row and push refresh onto a line of
              its own, so the badge keeps only its icon — the adjacent button
              ("Take chat" / "Return to Arix") already names the current mode,
              and the accessible name below carries the full wording. */}
          <Badge
            variant={isHuman ? 'warning' : 'outline'}
            className={cn('shrink-0', !isHuman && 'text-muted-foreground')}
            aria-label={isHuman ? t.conversation.modeHuman : t.conversation.modeBot}
            title={isHuman ? t.conversation.modeHuman : t.conversation.modeBot}
          >
            {isHuman ? <UserIcon className="size-3" /> : <BotIcon className="size-3" />}
            <span aria-hidden className="max-sm:hidden">
              {isHuman ? t.conversation.modeHuman : t.conversation.modeBot}
            </span>
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
          <DialogTrigger asChild>
            <Button variant="outline" size="icon-sm" className="xl:hidden" aria-label={t.conversation.showDetails} title={t.conversation.showDetails}>
              <PanelRightOpenIcon className="size-4" />
            </Button>
          </DialogTrigger>
          <Button variant="ghost" size="icon-sm" onClick={refreshAll} aria-label={t.common.refresh} title={t.common.refresh}>
            <RefreshCwIcon className={cn('size-4', loadError && 'text-destructive')} />
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
        <section className="relative flex min-h-0" aria-label={t.conversation.messagesLabel}>
          <div
            ref={messageListRef}
            className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3 sm:p-4"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-label={t.conversation.messagesLabel}
          >
            {hasOlder && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mb-2 self-center"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
              >
                {loadingOlder ? t.conversation.loadingOlder : t.conversation.loadOlder}
              </Button>
            )}
            {historyError && <p className="mb-2 self-center text-xs text-destructive" role="alert">{t.conversation.historyError}</p>}
            {loadError && <p className="mb-2 self-center text-xs text-destructive" role="alert">{t.conversation.refreshError}</p>}

            {messages.map((message) => {
              const MediaIcon = MEDIA_ICON[message.msg_type];
              return (
                <article
                  key={message.id}
                  aria-label={t.conversation.sender[message.sender]}
                  className={cn(
                    'flex max-w-[88%] flex-col gap-1 rounded-xl px-3 py-2 text-sm leading-snug break-words whitespace-pre-wrap sm:max-w-[72%]',
                    BUBBLE_CLASS[message.sender],
                  )}
                >
                  {message.body}
                  {!message.body && !message.media_url && MediaIcon && (
                    <span className="inline-flex items-center gap-1.5">
                      <MediaIcon className="size-3.5" aria-hidden="true" />
                      {mediaLabel(t, message.msg_type)}
                    </span>
                  )}
                  {message.media_url && (
                    <Image
                      src={api.mediaUrl(message.media_url)}
                      alt={t.conversation.mediaAlt}
                      width={220}
                      height={220}
                      unoptimized
                      className="mt-1 h-auto max-w-full rounded-md object-contain"
                    />
                  )}
                  <span className="text-[10px] opacity-70">
                    {t.conversation.sender[message.sender]}
                    {' · '}
                    {formatClockTime(message.created_at, locale)}
                    {(message.send_status === 'pending' || message.send_status === 'sending') && ` · ${t.conversation.sending}`}
                    {message.send_status === 'failed' && ` · ${t.conversation.messageFailedTag}`}
                  </span>
                </article>
              );
            })}
            <div ref={bottomRef} aria-hidden="true" />
          </div>

          {unseenNew > 0 && (
            <Button type="button" size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg" onClick={scrollToLatest}>
              {t.conversation.newMessages} ({unseenNew})
            </Button>
          )}
        </section>

        {wideDetails && (
          <aside className="hidden min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain border-l border-border bg-card p-4 xl:flex" aria-label={t.conversation.detailsTitle}>
            {details}
          </aside>
        )}
      </div>

      {isHuman ? (
        <div className="flex items-end gap-2 border-t border-border bg-card px-3 pt-3 pb-[max(0.75rem,var(--safe-bottom))]">
          <Textarea
            placeholder={t.conversation.composerPlaceholder}
            value={text}
            onChange={(event) => {
              const value = event.target.value;
              setText(value);
              if (sendAttemptRef.current && sendAttemptRef.current.body !== value.trim()) sendAttemptRef.current = null;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            className="min-h-11 flex-1 resize-none"
            rows={1}
            disabled={sending}
            aria-label={t.conversation.composerPlaceholder}
          />
          <Button onClick={() => void send()} disabled={sending || !text.trim()} size="icon" aria-label={t.conversation.send} aria-busy={sending}>
            <SendHorizontalIcon className="size-4" />
          </Button>
        </div>
      ) : (
        <p className="border-t border-border p-3 pb-[max(0.75rem,var(--safe-bottom))] text-xs text-muted-foreground" role="status">
          {t.conversation.botHint}
        </p>
      )}

      {!wideDetails && (
        <DialogContent
          showCloseButton={false}
          className="top-0 right-0 left-auto h-[var(--app-height)] max-h-none w-[min(100%,24rem)] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-y-hidden rounded-none p-0 pt-[var(--safe-top)] pr-[var(--safe-right)] sm:max-w-sm sm:p-0"
        >
          <DialogHeader className="flex-row items-center justify-between border-b border-border p-4 text-left">
            <div>
              <DialogTitle>{t.conversation.detailsTitle}</DialogTitle>
              <DialogDescription className="sr-only">{t.conversation.showDetails}</DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t.conversation.closeDetails} title={t.conversation.closeDetails}>
                <XIcon className="size-4" />
              </Button>
            </DialogClose>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain bg-card p-4 pb-[max(1rem,var(--safe-bottom))]">
            {details}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
