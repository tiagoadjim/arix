'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { RefreshCwIcon, TruckIcon } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import type { StaffOrder } from '@/lib/types';
import { useT } from '@/lib/i18n/provider';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { createClientId } from '@/lib/id';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Mirrors the server's STATUS_ES (server/src/skills/orders.ts) for the status
// dropdown — keep this list in sync if the server adds/removes a status.
const ORDER_STATUS_VALUES = [
  'pending',
  'processing',
  'en-camino',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const;

const SUCCESS_STATUSES = new Set(['processing', 'completed']);

interface OrdersPanelProps {
  conversationId: string;
  orders: StaffOrder[];
  state: 'idle' | 'loading' | 'error';
  onReload: () => void | Promise<void>;
}

export function OrdersPanel({ conversationId, orders, state, onReload }: OrdersPanelProps) {
  const { t, locale } = useT();
  const [statusSel, setStatusSel] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [dispatchOrder, setDispatchOrder] = useState<StaffOrder | null>(null);

  function statusLabel(status: string, fallback: string): string {
    return (t.conversation.orderStatuses as Record<string, string>)[status] ?? fallback;
  }

  async function changeStatus(o: StaffOrder) {
    const status = statusSel[o.id] ?? o.status;
    if (status === o.status) return;
    setBusy((b) => ({ ...b, [o.id]: true }));
    try {
      await api.updateOrderStatus(conversationId, o.id, status);
      toast.success(t.conversation.statusChanged);
      await onReload();
    } catch (err) {
      toast.error(t.conversation.statusChangeFailed, { description: apiErrorMessage(err, t, t.conversation.statusChangeFailed) });
    } finally {
      setBusy((b) => ({ ...b, [o.id]: false }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t.conversation.ordersTitle}
        </CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void onReload()}
            disabled={state === 'loading'}
            aria-label={t.conversation.ordersRefreshAria}
          >
            <RefreshCwIcon className={cn('size-3.5', state === 'loading' && 'animate-spin')} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3" aria-busy={state === 'loading'} aria-live="polite">
        {state === 'error' && <p className="text-sm text-muted-foreground" role="alert">{t.conversation.ordersError}</p>}
        {state !== 'error' && orders.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {state === 'loading' ? t.conversation.ordersLoading : t.conversation.ordersEmpty}
          </p>
        )}
        {orders.map((o) => (
          <article key={o.id} className="rounded-md border border-border bg-muted/40 p-3 text-sm" aria-labelledby={`order-${o.id}-title`}>
            <div className="flex items-center justify-between gap-2 font-medium">
              <span id={`order-${o.id}-title`}>#{o.number}</span>
              <Badge variant={SUCCESS_STATUSES.has(o.status) ? 'success' : 'outline'}>{statusLabel(o.status, o.status)}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatDate(o.date, locale)} · {o.total} {o.currency}
              {o.payment_method ? ` · ${o.payment_method}` : ''}
            </p>
            {o.shipping.address && (
              <p className="mt-1 text-xs text-muted-foreground">
                {[o.shipping.name, o.shipping.address, o.shipping.city, o.shipping.state].filter(Boolean).join(', ')}
              </p>
            )}
            <ul className="mt-2 list-disc pl-4 text-xs">
              {o.items.map((it, idx) => (
                <li key={idx}>
                  {it.quantity}× {it.product}
                </li>
              ))}
            </ul>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row xl:flex-col 2xl:flex-row">
              <Select
                value={statusSel[o.id] ?? o.status}
                onValueChange={(v) => setStatusSel((s) => ({ ...s, [o.id]: v }))}
                disabled={busy[o.id]}
              >
                <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={`${t.conversation.changeStatusButton} #${o.number}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_STATUS_VALUES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {statusLabel(v, v)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void changeStatus(o)}
                disabled={busy[o.id] || (statusSel[o.id] ?? o.status) === o.status}
              >
                {t.conversation.changeStatusButton}
              </Button>
            </div>

            <Button variant="secondary" size="sm" className="mt-2 w-full gap-1.5" onClick={() => setDispatchOrder(o)}>
              <TruckIcon className="size-3.5" />
              {t.conversation.dispatchButton}
            </Button>
          </article>
        ))}
      </CardContent>

      <DispatchDialog
        order={dispatchOrder}
        conversationId={conversationId}
        onOpenChange={(open) => !open && setDispatchOrder(null)}
        onSent={onReload}
      />
    </Card>
  );
}

interface DispatchDialogProps {
  order: StaffOrder | null;
  conversationId: string;
  onOpenChange: (open: boolean) => void;
  onSent: () => void | Promise<void>;
}

function DispatchDialog({ order, conversationId, onOpenChange, onSent }: DispatchDialogProps) {
  const { t } = useT();
  const [trackingUrl, setTrackingUrl] = useState('');
  const [deliveryCode, setDeliveryCode] = useState('');
  const [sending, setSending] = useState(false);
  const attemptRef = useRef<{ fingerprint: string; clientId: string } | null>(null);

  // Reset the form fields whenever a different order's dialog opens.
  useEffect(() => {
    setTrackingUrl('');
    setDeliveryCode('');
    attemptRef.current = null;
  }, [order?.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!order) return;
    if (!trackingUrl.trim() || !deliveryCode.trim()) {
      toast.error(t.conversation.dispatchMissingFields);
      return;
    }
    setSending(true);
    const fingerprint = `${order.id}\n${trackingUrl.trim()}\n${deliveryCode.trim()}`;
    const previous = attemptRef.current;
    const clientId = previous?.fingerprint === fingerprint ? previous.clientId : createClientId();
    attemptRef.current = { fingerprint, clientId };
    try {
      const r = await api.sendDelivery(conversationId, order.id, {
        trackingUrl: trackingUrl.trim(),
        deliveryCode: deliveryCode.trim(),
        clientId,
      });
      attemptRef.current = null;
      toast.success(r.statusUpdated ? t.conversation.dispatchSent : t.conversation.dispatchSentNoStatus);
      onOpenChange(false);
      await onSent();
    } catch (err) {
      toast.error(t.conversation.dispatchFailed, { description: apiErrorMessage(err, t, t.conversation.dispatchFailed) });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={order !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{t.conversation.dispatchDialogTitle}</DialogTitle>
            <DialogDescription>{t.conversation.dispatchDialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dispatch-tracking-url">{t.conversation.trackingUrlLabel}</Label>
              <Input
                id="dispatch-tracking-url"
                value={trackingUrl}
                onChange={(e) => setTrackingUrl(e.target.value)}
                placeholder={t.conversation.trackingUrlPlaceholder}
                disabled={sending}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dispatch-code">{t.conversation.deliveryCodeLabel}</Label>
              <Input
                id="dispatch-code"
                value={deliveryCode}
                onChange={(e) => setDeliveryCode(e.target.value)}
                placeholder={t.conversation.deliveryCodePlaceholder}
                disabled={sending}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t.common.cancel}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={sending}>
              {sending ? t.conversation.dispatchSubmitting : t.conversation.dispatchSubmit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
