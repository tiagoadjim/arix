'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Image from 'next/image';
import { CheckIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import type { Receipt, StaffOrder } from '@/lib/types';
import { useT } from '@/lib/i18n/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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

const MATCH_VARIANT: Record<Receipt['match_status'], 'success' | 'destructive' | 'outline'> = {
  match: 'success',
  mismatch: 'destructive',
  unreadable: 'outline',
  pending: 'outline',
};

const REVIEW_VARIANT: Record<Receipt['review_status'], 'success' | 'destructive' | 'warning' | 'outline'> = {
  approved: 'success',
  rejected: 'destructive',
  processing: 'warning',
  pending: 'outline',
};

type Decision = 'approved' | 'rejected';

interface ReceiptsPanelProps {
  receipts: Receipt[];
  onReviewed: (receipt: Receipt, order?: StaffOrder) => void;
}

/**
 * Receipt recognition is evidence, never authority: match_status shows the
 * automated extraction, while review_status requires an explicit staff
 * decision before the backend may update WooCommerce, unless an administrator
 * explicitly enabled the separately warned auto-confirm flow.
 */
export function ReceiptsPanel({ receipts, onReviewed }: ReceiptsPanelProps) {
  const { t } = useT();
  const [reviewTarget, setReviewTarget] = useState<{ receipt: Receipt; decision: Decision } | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    setReviewNote('');
  }, [reviewTarget?.receipt.id, reviewTarget?.decision]);

  async function submitReview(event: FormEvent) {
    event.preventDefault();
    if (!reviewTarget) return;
    setReviewing(true);
    try {
      const result = await api.reviewReceipt(reviewTarget.receipt.id, reviewTarget.decision, reviewNote);
      onReviewed(result.receipt, result.order);
      toast.success(
        reviewTarget.decision === 'approved' ? t.conversation.reviewSuccessApproved : t.conversation.reviewSuccessRejected,
      );
      setReviewTarget(null);
    } catch (error) {
      toast.error(t.conversation.reviewFailed, { description: apiErrorMessage(error, t, t.conversation.reviewFailed) });
    } finally {
      setReviewing(false);
    }
  }

  const approving = reviewTarget?.decision === 'approved';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t.conversation.receiptsTitle}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3" aria-live="polite">
        {receipts.length === 0 && <p className="text-sm text-muted-foreground">{t.conversation.receiptsEmpty}</p>}
        {receipts.map((receipt) => (
          <article key={receipt.id} className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            {receipt.media_url && (
              <Image
                src={api.mediaUrl(receipt.media_url)}
                alt={t.conversation.receiptImageAlt}
                width={288}
                height={360}
                unoptimized
                className="mb-2 h-auto max-w-full rounded-md object-contain"
              />
            )}
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptOrderLabel}</span>
              <span>{receipt.order_number ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptAmountLabel}</span>
              <span>{receipt.extracted_amount ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptTotalLabel}</span>
              <span>
                {receipt.woo_total ?? '—'} {receipt.currency ?? ''}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptResultLabel}</span>
              <Badge variant={MATCH_VARIANT[receipt.match_status]}>{t.conversation.matchStatus[receipt.match_status]}</Badge>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptReviewLabel}</span>
              <Badge variant={REVIEW_VARIANT[receipt.review_status]}>{t.conversation.reviewStatus[receipt.review_status]}</Badge>
            </div>
            {receipt.transaction_reference && (
              <div className="mt-1 flex justify-between gap-2 text-xs">
                <span className="text-muted-foreground">{t.conversation.receiptReferenceLabel}</span>
                <span className="break-all text-right">{receipt.transaction_reference}</span>
              </div>
            )}
            {receipt.note && <p className="mt-2 text-xs text-muted-foreground">{receipt.note}</p>}

            {receipt.review_status === 'pending' && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  onClick={() => setReviewTarget({ receipt, decision: 'approved' })}
                  disabled={receipt.match_status !== 'match' || !receipt.woo_order_id}
                  title={receipt.match_status !== 'match' || !receipt.woo_order_id ? t.conversation.receiptNotApprovable : undefined}
                >
                  <CheckIcon className="size-3.5" />
                  {t.conversation.approveReceipt}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setReviewTarget({ receipt, decision: 'rejected' })}>
                  <XIcon className="size-3.5" />
                  {t.conversation.rejectReceipt}
                </Button>
                {(receipt.match_status !== 'match' || !receipt.woo_order_id) && (
                  <p className="col-span-2 text-xs text-muted-foreground">{t.conversation.receiptNotApprovable}</p>
                )}
              </div>
            )}
          </article>
        ))}
      </CardContent>

      <Dialog open={reviewTarget !== null} onOpenChange={(open) => !open && !reviewing && setReviewTarget(null)}>
        <DialogContent>
          <form onSubmit={(event) => void submitReview(event)}>
            <DialogHeader>
              <DialogTitle>
                {approving ? t.conversation.reviewDialogApproveTitle : t.conversation.reviewDialogRejectTitle}
              </DialogTitle>
              <DialogDescription>
                {approving ? t.conversation.reviewDialogApproveDescription : t.conversation.reviewDialogRejectDescription}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 py-3">
              <Label htmlFor="receipt-review-note">{t.conversation.reviewNoteLabel}</Label>
              <Textarea
                id="receipt-review-note"
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                placeholder={t.conversation.reviewNotePlaceholder}
                disabled={reviewing}
                maxLength={1_000}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={reviewing}>{t.common.cancel}</Button>
              </DialogClose>
              <Button type="submit" variant={approving ? 'default' : 'destructive'} disabled={reviewing} aria-busy={reviewing}>
                {reviewing
                  ? t.conversation.reviewSubmitting
                  : approving
                    ? t.conversation.reviewSubmitApprove
                    : t.conversation.reviewSubmitReject}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
