import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type ResolvedPromptConfig } from '../src/agent/prompt';
import { VERTICALS, hasCatalog, normalizeVertical } from '../src/verticals';
import { defaultEnabledSkills, normalizeEnabledSkills } from '../src/skills/ids';
import { SETTINGS_SCHEMA } from '../src/config/settings-schema';
import type { ToolContext } from '../src/types';

const SCHEDULE = [
  null,
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [600, 840],
] as ResolvedPromptConfig['hoursSchedule'];

const NOW = new Date('2026-03-11T15:30:00Z');

const ctx = {
  conversationId: 'c1',
  customerName: 'Ana',
  phone: '+5491100000000',
} as unknown as ToolContext;

function build(over: Partial<ResolvedPromptConfig> = {}): string {
  return buildSystemPrompt(
    ctx,
    {
      businessName: 'Negocio Test',
      agentName: 'Nico',
      language: 'es',
      discloseBot: false,
      timezone: 'America/Argentina/Buenos_Aires',
      hoursSchedule: SCHEDULE,
      storefrontUrl: 'https://negocio.test',
      infoBlocks: { payment: 'Transferencia', shipping: 'CABA', general: 'Local propio' },
      complianceRules: '',
      ...over,
    },
    NOW,
  );
}

describe('vertical selection', () => {
  it('defaults to ecommerce when the setting is absent or junk', () => {
    expect(normalizeVertical(undefined)).toBe('ecommerce');
    expect(normalizeVertical('not-a-vertical')).toBe('ecommerce');
    expect(normalizeVertical('appointments')).toBe('appointments');
  });

  it('only ecommerce claims a catalog — that is what gates the grounding lock', () => {
    expect(hasCatalog('ecommerce')).toBe(true);
    expect(hasCatalog('services')).toBe(false);
    expect(hasCatalog('appointments')).toBe(false);
  });

  it('keeps the pre-vertical skill set as the ecommerce default', () => {
    expect(defaultEnabledSkills('ecommerce')).toEqual([
      'catalog',
      'orders',
      'payments',
      'handoff',
    ]);
  });

  it('does not enable catalog/orders/payments where there is no store', () => {
    for (const v of ['services', 'appointments'] as const) {
      expect(defaultEnabledSkills(v)).not.toContain('catalog');
      expect(defaultEnabledSkills(v)).not.toContain('orders');
      expect(defaultEnabledSkills(v)).not.toContain('payments');
    }
  });
});

describe('prompt packs', () => {
  it('builds a non-empty prompt for every vertical in both languages', () => {
    for (const vertical of VERTICALS) {
      for (const language of ['es', 'en'] as const) {
        const prompt = build({ vertical, language });
        expect(prompt.length).toBeGreaterThan(500);
        // The neutral base must survive in every combination.
        expect(prompt).toContain('Negocio Test');
        expect(prompt).toContain(language === 'es' ? '# Reglas' : '# Rules');
      }
    }
  });

  it('never leaves a blank-line gap where a vertical omits a section', () => {
    for (const vertical of VERTICALS) {
      for (const language of ['es', 'en'] as const) {
        expect(build({ vertical, language })).not.toMatch(/\n{3,}/);
      }
    }
  });

  it('services drops the store-only sections', () => {
    const prompt = build({
      vertical: 'services',
      enabledToolNames: ['search_knowledge', 'handoff_to_human'],
    });
    expect(prompt).not.toContain('# Cómo se compra');
    expect(prompt).not.toContain('# Horarios de envío');
    expect(prompt).not.toContain('# Solo temas de la tienda');
    expect(prompt).toContain('# Horarios de atención');
    expect(prompt).toContain('# Solo temas del negocio');
  });

  it('appointments advertises the agenda and the reminder-reply flow', () => {
    const prompt = build({
      vertical: 'appointments',
      enabledToolNames: [
        'check_availability',
        'book_appointment',
        'find_appointment',
        'cancel_appointment',
        'confirm_appointment',
        'handoff_to_human',
      ],
    });
    expect(prompt).toContain('# Cómo se saca un turno');
    expect(prompt).toContain('check_availability');
    // A reply to a reminder must be routed to the tools, not answered as a
    // fresh enquiry — the reminder itself is never composed by the model.
    expect(prompt).toContain('# Respuestas a un recordatorio');
    expect(prompt).toContain('confirm_appointment');
  });

  it('degrades honestly when the agenda tools are disabled', () => {
    const prompt = build({
      vertical: 'appointments',
      enabledToolNames: ['handoff_to_human'],
    });
    expect(prompt).toContain('# Agenda no disponible');
    expect(prompt).not.toContain("llamar a 'check_availability'");
  });

  it('never advertises a tool that is not enabled for the turn', () => {
    const prompt = build({ vertical: 'services', enabledToolNames: ['handoff_to_human'] });
    expect(prompt).not.toContain('search_knowledge');
    expect(prompt).toContain('handoff_to_human');
  });

  it('keeps compliance rules first in the rules list for every vertical', () => {
    for (const vertical of VERTICALS) {
      const prompt = build({ vertical, complianceRules: 'Solo mayores de 18.' });
      const rules = prompt.slice(prompt.indexOf('# Reglas'));
      expect(rules.split('\n')[1]).toBe('- Solo mayores de 18.');
    }
  });
});

describe('skills.enabled resolution', () => {
  // Regression: the schema used to default `skills.enabled` to the four
  // ecommerce skills. That concrete list resolved before the vertical could be
  // consulted, so switching to `services` left the agent still advertising
  // search_catalog and confirm_payment. Only an end-to-end run caught it — the
  // unit tests exercised normalizeEnabledSkills directly and never saw the
  // schema default get in the way.
  it('leaves skills.enabled unset so the vertical decides', () => {
    const entry = SETTINGS_SCHEMA.find((definition) => definition.key === 'skills.enabled');
    expect(entry?.default).toBeNull();
  });

  it('treats an explicit empty list as a choice, not an absence', () => {
    // `[]` means "disable everything" and must not fall back to the vertical.
    expect(normalizeEnabledSkills([], defaultEnabledSkills('services'))).toEqual([]);
  });

  it('falls back to the vertical when the value is absent', () => {
    expect(normalizeEnabledSkills(null, defaultEnabledSkills('services'))).toEqual([
      'knowledge',
      'handoff',
    ]);
    expect(normalizeEnabledSkills(undefined, defaultEnabledSkills('ecommerce'))).toEqual([
      'catalog',
      'orders',
      'payments',
      'handoff',
    ]);
  });
});
