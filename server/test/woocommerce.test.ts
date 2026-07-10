import { describe, it, expect } from 'vitest';
import { normalizePhone, phoneSuffix } from '../src/integrations/woocommerce';

describe('phoneSuffix', () => {
  it('keeps the last 8 digits, ignoring formatting', () => {
    expect(phoneSuffix('+54 9 11 1234-5678')).toBe('12345678');
    expect(phoneSuffix('1112345678')).toBe('12345678');
  });

  it('matches the same number across formats (country code differences)', () => {
    expect(phoneSuffix('5491112345678')).toBe(phoneSuffix('+54 9 11 1234 5678'));
  });

  it('handles empty / null', () => {
    expect(phoneSuffix(null)).toBe('');
    expect(phoneSuffix(undefined)).toBe('');
    expect(phoneSuffix('')).toBe('');
  });
});

describe('normalizePhone', () => {
  it('ignores formatting but preserves the full country and area code', () => {
    expect(normalizePhone('+54 9 11 1234-5678')).toBe('5491112345678');
    expect(normalizePhone('+54 (9) 11 1234 5678')).toBe('5491112345678');
  });

  it('does not authorize two numbers that only share the same local suffix', () => {
    expect(normalizePhone('+54 9 11 1234-5678')).not.toBe(normalizePhone('+34 6 12 34 56 78'));
    expect(phoneSuffix('+54 9 11 1234-5678')).toBe(phoneSuffix('+34 6 12 34 56 78'));
  });
});
