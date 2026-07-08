'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import { CheckCircle2Icon } from 'lucide-react';
import { api, type WhatsAppStatus } from '@/lib/api';
import type { Dictionary } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { usePolling } from '@/hooks/usePolling';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface ForceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  t: Dictionary;
}

function ForceRestartDialog({ open, onOpenChange, onConfirm, busy, t }: ForceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.settings.whatsapp.forceDialogTitle}</DialogTitle>
          <DialogDescription>{t.settings.whatsapp.forceDialogDescription}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t.common.cancel}</Button>
          </DialogClose>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {t.settings.whatsapp.forceConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface WhatsAppPanelProps {
  /** Called once, the first time `connected` flips true — lets the setup
   * wizard auto-advance past the pairing step. Not passed by the settings
   * tab, which just shows the persistent connected state. */
  onConnected?: () => void;
}

/** WhatsApp pairing status + QR — shared verbatim between the settings
 * "WhatsApp" tab and setup-wizard step 6. Polls status every 3s (paused while
 * the tab is hidden, via usePolling) and renders the QR string as an image
 * with the `qrcode` package. */
export function WhatsAppPanel({ onConnected }: WhatsAppPanelProps) {
  const { t } = useT();
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  const notifiedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.whatsappStatus();
      setStatus(s);

      if (s.connected) {
        if (!notifiedRef.current) {
          notifiedRef.current = true;
          onConnected?.();
        }
        setQrDataUrl(null);
        return;
      }
      notifiedRef.current = false;

      if (s.hasQr) {
        const qrString = await api.qr();
        const dataUrl = await QRCode.toDataURL(qrString, { margin: 1, width: 260 });
        setQrDataUrl(dataUrl);
      } else {
        setQrDataUrl(null);
      }
    } catch {
      // transient — keep the last known status/QR on screen
    }
  }, [onConnected]);

  usePolling(refresh, 3000);

  async function restart(force: boolean) {
    setRestarting(true);
    try {
      const r = await api.whatsappRestart(force);
      setStatus(r.whatsapp);
      setConfirmForce(false);
      toast.success(t.settings.whatsapp.restartSuccessToast);
    } catch (err) {
      if (err instanceof Error && err.message === 'already_connected') {
        setConfirmForce(true);
      } else {
        toast.error(t.settings.whatsapp.restartErrorToast);
      }
    } finally {
      setRestarting(false);
    }
  }

  if (!status) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-8">
          <Skeleton className="size-48 rounded-md" />
          <Skeleton className="h-4 w-40" />
        </CardContent>
      </Card>
    );
  }

  if (status.connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-success">
            <CheckCircle2Icon className="size-5" />
            {t.settings.whatsapp.connectedTitle}
          </CardTitle>
          <CardDescription>{t.settings.whatsapp.connectedDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="outline" onClick={() => void restart(false)} disabled={restarting}>
            {restarting ? t.settings.whatsapp.generatingQr : t.settings.whatsapp.generateNewQr}
          </Button>
        </CardContent>
        <ForceRestartDialog open={confirmForce} onOpenChange={setConfirmForce} onConfirm={() => void restart(true)} busy={restarting} t={t} />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.settings.whatsapp.awaitingTitle}</CardTitle>
        <CardDescription>{t.settings.whatsapp.awaitingDescription}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={t.settings.whatsapp.qrAlt}
            className="size-56 rounded-md border border-border bg-white p-2"
          />
        ) : (
          <div className="flex size-56 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            <Skeleton className="size-32 rounded-md" />
            {t.settings.whatsapp.waitingForQr}
          </div>
        )}
        <Button type="button" variant="outline" onClick={() => void restart(false)} disabled={restarting}>
          {restarting ? t.settings.whatsapp.generatingQr : t.settings.whatsapp.generateNewQr}
        </Button>
      </CardContent>
      <ForceRestartDialog open={confirmForce} onOpenChange={setConfirmForce} onConfirm={() => void restart(true)} busy={restarting} t={t} />
    </Card>
  );
}
