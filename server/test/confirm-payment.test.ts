import { vi, describe, it, expect, beforeEach } from 'vitest';

const { resolveOrderByNumber, updateOrderStatus, insertReceipt, setConversationEmail } = vi.hoisted(() => ({
  resolveOrderByNumber: vi.fn(),
  updateOrderStatus: vi.fn(),
  insertReceipt: vi.fn(),
  setConversationEmail: vi.fn(),
}));

vi.mock('../src/integrations/woocommerce', () => ({
  woo: { resolveOrderByNumber, updateOrderStatus },
  phoneSuffix: (p?: string | null) => (p ?? '').replace(/\D/g, '').slice(-8),
}));
vi.mock('../src/db/repo', () => ({ insertReceipt, setConversationEmail }));

import { paymentTools } from '../src/skills/payments';
import type { ToolContext } from '../src/types';

const confirmar = (args: Record<string, unknown>, ctx: ToolContext) =>
  paymentTools[0]!.handler(args, ctx) as Promise<Record<string, unknown>>;

function ctxWith(phone: string | null, onReceiptConsumed = vi.fn()): ToolContext {
  return { conversationId: 'c1', jid: 'j', phone, customerName: null, lastImage: null, onReceiptConsumed };
}

const order = (over: Record<string, unknown> = {}) => ({
  id: 5,
  number: '1042',
  status: 'on-hold',
  total: '15400.00',
  currency: 'ARS',
  billing: { phone: '+54 9 11 1234-5678', email: 'cliente@mail.com' },
  ...over,
});

beforeEach(() => {
  resolveOrderByNumber.mockReset();
  updateOrderStatus.mockReset();
  insertReceipt.mockReset().mockResolvedValue({});
  setConversationEmail.mockReset().mockResolvedValue(undefined);
});

describe('confirmar_pago', () => {
  it('confirms when phone matches, state is on-hold, and amount matches', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    updateOrderStatus.mockResolvedValue({ status: 'processing' });
    const onConsumed = vi.fn();
    const res = await confirmar({ numero_orden: '1042', monto_comprobante: 15400 }, ctxWith('5491112345678', onConsumed));
    expect(res.ok).toBe(true);
    expect(res.confirmada).toBe(true);
    expect(updateOrderStatus).toHaveBeenCalledWith(5, 'processing');
    expect(onConsumed).toHaveBeenCalled();
  });

  it('confirms by EMAIL when the phone does not match', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    updateOrderStatus.mockResolvedValue({ status: 'processing' });
    const res = await confirmar(
      { numero_orden: '1042', monto_comprobante: 15400, email: 'Cliente@Mail.com' },
      ctxWith('5499999999999'),
    );
    expect(res.ok).toBe(true);
    expect(res.identidad_verificada).toBe(true);
  });

  it('asks for email (pedir_email) when phone does not match and no email given', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar({ numero_orden: '1042', monto_comprobante: 15400 }, ctxWith('5499999999999'));
    expect(res.ok).toBe(false);
    expect(res.motivo).toBe('pedir_email');
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('asks for email when the chat phone is unknown', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar({ numero_orden: '1042', monto_comprobante: 15400 }, ctxWith(null));
    expect(res.motivo).toBe('pedir_email');
  });

  it('rejects (identidad_no_verificable) when phone and email both wrong', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar(
      { numero_orden: '1042', monto_comprobante: 15400, email: 'otro@mail.com' },
      ctxWith('5499999999999'),
    );
    expect(res.ok).toBe(false);
    expect(res.motivo).toBe('identidad_no_verificable');
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('does NOT reactivate a refunded order even if the amount matches', async () => {
    resolveOrderByNumber.mockResolvedValue(order({ status: 'refunded' }));
    const res = await confirmar({ numero_orden: '1042', monto_comprobante: 15400 }, ctxWith('5491112345678'));
    expect(res.ok).toBe(false);
    expect(res.motivo).toBe('orden_no_confirmable');
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('rejects when the amount does not match', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar({ numero_orden: '1042', monto_comprobante: 99999 }, ctxWith('5491112345678'));
    expect(res.ok).toBe(false);
    expect(res.motivo).toBe('monto_no_coincide');
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('reports orden_no_encontrada when the order does not resolve', async () => {
    resolveOrderByNumber.mockResolvedValue(null);
    const res = await confirmar({ numero_orden: 'zzz', monto_comprobante: 15400 }, ctxWith('5491112345678'));
    expect(res.ok).toBe(false);
    expect(res.motivo).toBe('orden_no_encontrada');
  });
});
