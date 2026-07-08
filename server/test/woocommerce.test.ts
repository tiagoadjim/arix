import { describe, it, expect } from 'vitest';
import { phoneSuffix } from '../src/integrations/woocommerce';

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
