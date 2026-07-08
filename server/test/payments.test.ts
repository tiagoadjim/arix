import { describe, it, expect } from 'vitest';
import { parseAmount, amountsMatch } from '../src/skills/payments';

describe('parseAmount', () => {
  it('passes through finite numbers', () => {
    expect(parseAmount(15400)).toBe(15400);
    expect(parseAmount(15400.5)).toBe(15400.5);
  });

  it('parses plain integer strings', () => {
    expect(parseAmount('15400')).toBe(15400);
  });

  it('parses Argentine format (1.234,56)', () => {
    expect(parseAmount('15.400,50')).toBe(15400.5);
    expect(parseAmount('1.234.567,89')).toBe(1234567.89);
  });

  it('parses US format (1,234.56)', () => {
    expect(parseAmount('15,400.50')).toBe(15400.5);
  });

  it('treats a lone dot with 3 trailing digits as thousands (AR)', () => {
    expect(parseAmount('1.500')).toBe(1500);
    expect(parseAmount('1.234')).toBe(1234);
  });

  it('treats a lone comma with 2 trailing digits as decimal', () => {
    expect(parseAmount('12,50')).toBe(12.5);
  });

  it('strips currency symbols and spaces', () => {
    expect(parseAmount('$ 1.500')).toBe(1500);
    expect(parseAmount('ARS 15400')).toBe(15400);
  });

  it('returns null for non-numeric input', () => {
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });
});

describe('parseAmount with a currency decimal-separator hint', () => {
  it('treats a lone dot with 3 trailing digits as a decimal when the hint says dot-is-decimal (USD)', () => {
    expect(parseAmount('1.234', 'dot')).toBe(1.234);
  });

  it('still treats a lone dot with 3 trailing digits as thousands when the hint says comma-is-decimal (ARS)', () => {
    expect(parseAmount('1.234', 'comma')).toBe(1234);
  });

  it('treats a lone comma with 3 trailing digits as a decimal when the hint says comma-is-decimal (ARS/EUR)', () => {
    expect(parseAmount('1,234', 'comma')).toBe(1.234);
  });

  it('still treats a lone comma with 3 trailing digits as thousands when the hint says dot-is-decimal (USD)', () => {
    expect(parseAmount('1,234', 'dot')).toBe(1234);
  });

  it('does not change unambiguous inputs regardless of the hint', () => {
    expect(parseAmount('15.400,50', 'comma')).toBe(15400.5);
    expect(parseAmount('15,400.50', 'dot')).toBe(15400.5);
    expect(parseAmount('12,50', 'dot')).toBe(12.5);
  });

  it('behaves exactly as before when no hint is passed', () => {
    expect(parseAmount('1.234')).toBe(1234);
    expect(parseAmount('1,234')).toBe(1234);
  });
});

describe('amountsMatch', () => {
  it('matches exact amounts', () => {
    expect(amountsMatch(15400, 15400, 1)).toBe(true);
  });
  it('matches within tolerance', () => {
    expect(amountsMatch(15400, 15399.5, 1)).toBe(true);
    expect(amountsMatch(15400, 15401, 1)).toBe(true);
  });
  it('rejects beyond tolerance', () => {
    expect(amountsMatch(15400, 15398, 1)).toBe(false);
    expect(amountsMatch(15400, 20000, 1)).toBe(false);
  });
});
