'use client';

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ArrowLeftIcon,
  CalendarPlusIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  PhoneIcon,
} from 'lucide-react';
import { api, apiErrorMessage, ApiError } from '@/lib/api';
import type { AgendaAppointment, AppointmentStatus } from '@/lib/types';
import { usePolling } from '@/hooks/usePolling';
import { interpolate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const POLL_MS = 30_000;

/** Local YYYY-MM-DD for a Date. The server resolves this to a day window in the
 * business's own timezone, so a member of staff in another timezone still sees
 * the same day the shop is working. */
function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return isoDate(new Date(y, m - 1, d + days));
}

const STATUS_VARIANT: Record<AppointmentStatus, 'default' | 'secondary' | 'destructive' | 'outline'> =
  {
    booked: 'secondary',
    confirmed: 'default',
    completed: 'outline',
    no_show: 'destructive',
    cancelled: 'outline',
  };

/** Statuses that are over: their row is dimmed and its actions retired. */
const CLOSED: ReadonlySet<AppointmentStatus> = new Set(['completed', 'no_show', 'cancelled']);

export default function AgendaPage() {
  const { t, locale } = useT();
  const [date, setDate] = useState(() => isoDate(new Date()));
  const [appointments, setAppointments] = useState<AgendaAppointment[] | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [service, setService] = useState('');
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState('60');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await api.agenda(date, 1, signal);
        setAppointments(data.appointments);
        setTimezone(data.timezone);
        setFailed(false);
      } catch {
        // Keep the last known day on screen; the next tick reconciles.
        setFailed(true);
      }
    },
    [date],
  );

  const { refresh } = usePolling(load, POLL_MS, { restartKey: date });

  const clock = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'es' ? 'es-AR' : 'en-GB', {
        timeZone: timezone ?? undefined,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    [locale, timezone],
  );

  const heading = useMemo(() => {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    return new Intl.DateTimeFormat(locale === 'es' ? 'es-AR' : 'en-GB', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
    }).format(new Date(y, m - 1, d));
  }, [date, locale]);

  const live = appointments?.filter((a) => !CLOSED.has(a.status)) ?? [];

  async function changeStatus(appointment: AgendaAppointment, status: AppointmentStatus) {
    setBusyId(appointment.id);
    try {
      await api.setAppointmentStatus(appointment.id, status);
      toast.success(t.agenda.updated);
      refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setBusyId(null);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!service.trim() || !/^\d{2}:\d{2}$/.test(time)) {
      toast.error(t.agenda.incomplete);
      return;
    }
    setSaving(true);
    try {
      // The wall-clock time the operator typed, sent as an instant. The input
      // is in the browser's timezone, which for the person standing at the
      // counter is the shop's timezone.
      const [y, m, d] = date.split('-').map(Number) as [number, number, number];
      const [hh, mm] = time.split(':').map(Number) as [number, number];
      const startsAt = new Date(y, m - 1, d, hh, mm);

      await api.createAppointment({
        service: service.trim(),
        starts_at: startsAt.toISOString(),
        duration_minutes: Number(duration) || 60,
        customer_name: name.trim() || undefined,
        customer_phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success(t.agenda.created);
      setAddOpen(false);
      setService('');
      setName('');
      setPhone('');
      setNotes('');
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slot_taken') toast.error(t.agenda.slotTaken);
      else toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
          <Link href="/" aria-label={t.common.back}>
            <ArrowLeftIcon />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-col">
          <h1 className="text-lg font-semibold">{t.agenda.title}</h1>
          <p className="text-sm text-muted-foreground">{t.agenda.subtitle}</p>
        </div>
        <Button className="ms-auto" onClick={() => setAddOpen(true)}>
          <CalendarPlusIcon />
          {t.agenda.addButton}
        </Button>
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setDate((d) => shiftDay(d, -1))}
              aria-label={t.agenda.previousDay}
            >
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDate(isoDate(new Date()))}>
              {t.agenda.today}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setDate((d) => shiftDay(d, 1))}
              aria-label={t.agenda.nextDay}
            >
              <ChevronRightIcon />
            </Button>
            <Input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="w-auto"
              aria-label={t.agenda.title}
            />
          </div>
          <CardTitle className="capitalize">{heading}</CardTitle>
          <CardDescription>
            {appointments ? interpolate(t.agenda.count, { n: live.length }) : ' '}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-2">
          {failed && (
            <Alert variant="destructive">
              <AlertDescription>{t.agenda.loadFailed}</AlertDescription>
            </Alert>
          )}

          {appointments === null && (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          )}

          {appointments?.length === 0 && (
            <p className="text-sm text-muted-foreground">{t.agenda.empty}</p>
          )}

          {appointments?.map((appointment) => {
            const closed = CLOSED.has(appointment.status);
            return (
              <div
                key={appointment.id}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between',
                  closed && 'opacity-60',
                )}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold tabular-nums">
                      {clock.format(new Date(appointment.starts_at))}
                    </span>
                    <span className="font-medium break-words">{appointment.service}</span>
                    <Badge variant={STATUS_VARIANT[appointment.status]}>
                      {t.agenda.statuses[appointment.status] ?? appointment.status}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    {appointment.customer_name && <span>{appointment.customer_name}</span>}
                    {appointment.customer_phone && <span>{appointment.customer_phone}</span>}
                    {appointment.from_chat && appointment.conversation_id ? (
                      <Link
                        href={`/c/${appointment.conversation_id}`}
                        className="inline-flex items-center gap-1 underline underline-offset-2"
                      >
                        <MessageSquareIcon className="size-3" aria-hidden />
                        {t.agenda.fromChat}
                      </Link>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1"
                        title={t.agenda.walkInHint}
                      >
                        <PhoneIcon className="size-3" aria-hidden />
                        {t.agenda.walkIn}
                      </span>
                    )}
                    {appointment.from_chat && !appointment.reminders_enabled && (
                      <Badge variant="outline">{t.agenda.noReminders}</Badge>
                    )}
                  </div>

                  {appointment.notes && (
                    <p className="text-sm text-muted-foreground break-words whitespace-pre-wrap">
                      {appointment.notes}
                    </p>
                  )}
                </div>

                {!closed && (
                  <div className="flex shrink-0 flex-wrap gap-1">
                    {appointment.status === 'booked' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === appointment.id}
                        onClick={() => void changeStatus(appointment, 'confirmed')}
                      >
                        {t.agenda.markConfirmed}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === appointment.id}
                      onClick={() => void changeStatus(appointment, 'completed')}
                    >
                      {t.agenda.markCompleted}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === appointment.id}
                      onClick={() => void changeStatus(appointment, 'no_show')}
                    >
                      {t.agenda.markNoShow}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === appointment.id}
                      onClick={() => void changeStatus(appointment, 'cancelled')}
                    >
                      {t.agenda.markCancelled}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <form onSubmit={create} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t.agenda.addTitle}</DialogTitle>
              <DialogDescription>{t.agenda.walkInHint}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="ap-service">{t.agenda.service}</Label>
                <Input
                  id="ap-service"
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                  placeholder={t.agenda.servicePlaceholder}
                  maxLength={200}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ap-time">{t.agenda.time}</Label>
                <Input id="ap-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ap-duration">{t.agenda.durationMinutes}</Label>
                <Input
                  id="ap-duration"
                  type="number"
                  min={5}
                  max={480}
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ap-name">{t.agenda.customerName}</Label>
                <Input
                  id="ap-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t.agenda.customerNamePlaceholder}
                  maxLength={200}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ap-phone">{t.agenda.customerPhone}</Label>
                <Input
                  id="ap-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={40}
                />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="ap-notes">{t.agenda.notes}</Label>
                <Textarea
                  id="ap-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  maxLength={2000}
                />
              </div>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={saving}>
                  {t.agenda.cancel}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={saving}>
                {saving ? t.agenda.adding : t.agenda.addButton}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
