'use client';

import { api } from '@/lib/api';
import type { Receipt } from '@/lib/types';
import { useT } from '@/lib/i18n/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const MATCH_VARIANT: Record<Receipt['match_status'], 'success' | 'destructive' | 'outline'> = {
  match: 'success',
  mismatch: 'destructive',
  unreadable: 'outline',
  pending: 'outline',
};

interface ReceiptsPanelProps {
  receipts: Receipt[];
}

/** Read-only list of payment receipts detected for this conversation — image,
 * extracted amount vs. order total, and the match verdict (with i18n'd
 * labels instead of the raw `match/mismatch/unreadable/pending` enum). */
export function ReceiptsPanel({ receipts }: ReceiptsPanelProps) {
  const { t } = useT();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t.conversation.receiptsTitle}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {receipts.length === 0 && <p className="text-sm text-muted-foreground">{t.conversation.receiptsEmpty}</p>}
        {receipts.map((r) => (
          <div key={r.id} className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            {r.media_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={api.mediaUrl(r.media_url)} alt={t.conversation.receiptImageAlt} className="mb-2 max-w-full rounded-md" />
            )}
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptOrderLabel}</span>
              <span>{r.order_number ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptAmountLabel}</span>
              <span>{r.extracted_amount ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptTotalLabel}</span>
              <span>
                {r.woo_total ?? '—'} {r.currency ?? ''}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t.conversation.receiptResultLabel}</span>
              <Badge variant={MATCH_VARIANT[r.match_status]}>{t.conversation.matchStatus[r.match_status]}</Badge>
            </div>
            {r.note && <p className="mt-2 text-xs text-muted-foreground">{r.note}</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
