import { describe, expect, it } from 'vitest';

import { numberBounds, plainUpdate, secretUpdate } from '../src/components/settings/settings-form-utils';
import type { SettingDto } from '../src/lib/api';

function dto(overrides: Partial<SettingDto> = {}): SettingDto {
  return {
    key: 'business.name',
    group: 'business',
    type: 'string',
    label: 'Business name',
    value: 'Arix Store',
    set: true,
    source: 'db',
    readOnly: false,
    secret: false,
    min: undefined,
    max: undefined,
    ...overrides,
  };
}

describe('settings update batches', () => {
  it('omits an unchanged plain value so a stale tab cannot overwrite unrelated edits', () => {
    expect(plainUpdate('business.name', 'Arix Store', [dto()])).toBeNull();
  });

  it('includes only a genuinely changed plain value', () => {
    expect(plainUpdate('business.name', 'New name', [dto()])).toEqual({
      key: 'business.name',
      value: 'New name',
    });
  });

  it('never sends an env-locked field or a blank replacement secret', () => {
    expect(plainUpdate('business.name', 'New name', [dto({ readOnly: true })])).toBeNull();
    expect(
      secretUpdate('llm.api_key', '   ', [
        dto({ key: 'llm.api_key', group: 'llm', secret: true, value: null }),
      ]),
    ).toBeNull();
  });
});

describe('numeric setting bounds', () => {
  it('uses server-provided bounds and safe fallbacks when metadata is absent', () => {
    const cost = dto({
      key: 'llm.input_cost_per_million',
      group: 'llm',
      type: 'number',
      min: 0,
      max: 10_000,
    });
    expect(numberBounds(cost.key, [cost], { min: 0 })).toEqual({ min: 0, max: 10_000 });
    expect(numberBounds('payment.tolerance', undefined, { min: 0 })).toEqual({ min: 0, max: undefined });
  });
});
