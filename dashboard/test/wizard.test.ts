import { describe, expect, it } from 'vitest';
import { extractWooKeys } from '../src/app/setup/steps/store-step';
import { formatValue, proposalLabel } from '../src/components/wizard/proposal-row';
import { es } from '../src/lib/i18n/es';
import { en } from '../src/lib/i18n/en';

describe('extractWooKeys', () => {
  const key = `ck_${'a'.repeat(40)}`;
  const secret = `cs_${'b'.repeat(40)}`;

  it('pulls both halves out of a pasted WooCommerce success screen', () => {
    // What people actually copy: the whole block, labels and all.
    const pasted = `
      Consumer key
      ${key}
      Consumer secret
      ${secret}
      QRCode
    `;
    expect(extractWooKeys(pasted)).toEqual({ consumerKey: key, consumerSecret: secret });
  });

  it('handles either one on its own', () => {
    expect(extractWooKeys(key)).toEqual({ consumerKey: key });
    expect(extractWooKeys(secret)).toEqual({ consumerSecret: secret });
  });

  it('returns nothing for text with no keys in it', () => {
    expect(extractWooKeys('just some words')).toEqual({});
  });

  it('ignores lookalikes that are too short', () => {
    expect(extractWooKeys('ck_short cs_alsoshort')).toEqual({});
  });

  it('bounds how much text it will scan', () => {
    expect(extractWooKeys(`${'x'.repeat(9_000)}${key}`)).toEqual({});
  });
});

describe('proposal rendering', () => {
  it('renders a week of delivery hours as readable text, not JSON', () => {
    const week = [null, [540, 1080], null, null, null, null, [600, 840]];
    const rendered = formatValue(week as unknown as number[][], es.time.weekdays);
    expect(rendered).toBe('lunes 09:00–18:00\nsábado 10:00–14:00');
  });

  it('leaves text values untouched', () => {
    expect(formatValue('Enviamos a todo el país.', es.time.weekdays)).toBe('Enviamos a todo el país.');
    expect(formatValue(null, es.time.weekdays)).toBe('');
  });

  it('gives every proposable setting a plain-language name in both locales', () => {
    const keys = [
      'business.name',
      'business.timezone',
      'business.hours',
      'wc.currency',
      'info.payment',
      'info.shipping',
      'info.general',
      'compliance.rules',
    ];
    for (const key of keys) {
      expect(proposalLabel(key, es), key).not.toBe(key);
      expect(proposalLabel(key, en), key).not.toBe(key);
    }
  });

  it('falls back to the raw key rather than rendering nothing', () => {
    expect(proposalLabel('some.future.key', es)).toBe('some.future.key');
  });
});

describe('wizard copy', () => {
  it('keeps the two locales structurally identical', () => {
    // The Dictionary interface enforces this at compile time; this guards the
    // runtime shape too, since a missing branch would render `undefined`.
    const shape = (value: unknown): unknown =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .map(([key, nested]): [string, unknown] => [key, shape(nested)])
              .sort((a, b) => a[0].localeCompare(b[0])),
          )
        : typeof value;
    expect(shape(es.wizard)).toEqual(shape(en.wizard));
  });

  it('keeps jargon out of the primary step labels', () => {
    // The whole point of the rewrite: a shop owner should not have to know what
    // an API, an endpoint or a consumer key is to get through setup.
    const jargon = /\bAPI\b|endpoint|consumer key|consumer secret|MCP|LLM|webhook/i;
    for (const dictionary of [es, en]) {
      for (const label of Object.values(dictionary.wizard.nav)) {
        expect(label, label).not.toMatch(jargon);
      }
      expect(dictionary.wizard.store.title).not.toMatch(jargon);
      expect(dictionary.wizard.ai.title).not.toMatch(jargon);
      expect(dictionary.wizard.learn.title).not.toMatch(jargon);
    }
  });

  it('translates every error code the new endpoints can return', () => {
    const codes = [
      'rate_limited',
      'invalid_store_url',
      'unsafe_store_url',
      'llm_not_configured',
      'scan_already_running',
      'scan_not_found',
      'scan_no_pages',
      'scan_blocked_by_robots',
      'scan_extraction_failed',
      'scan_failed',
      'woo_auth_not_delivered',
    ];
    for (const code of codes) {
      expect(es.errors[code], code).toBeTruthy();
      expect(en.errors[code], code).toBeTruthy();
    }
  });
});
