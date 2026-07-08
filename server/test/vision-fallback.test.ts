import { vi, describe, it, expect, beforeEach } from 'vitest';

// `providerCaps.supportsVision` lets each test control whether the mocked
// provider can "see" images, independent of agent.test.ts's own mock.
const { create, runTool, providerCaps } = vi.hoisted(() => ({
  create: vi.fn(),
  runTool: vi.fn(),
  providerCaps: { supportsVision: false },
}));

vi.mock('../src/agent/llm/client', () => {
  const stripThinking = (t?: string | null) =>
    (t ?? '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think>/gi, '')
      .trim();
  return {
    getLlm: async () => ({
      provider: {
        id: 'test-provider',
        label: 'Test Provider',
        supportsVision: () => providerCaps.supportsVision,
        supportsForcedToolChoice: true,
        prepareBody: () => {
          // no-op — vision gating doesn't depend on prepareBody
        },
        postprocess: stripThinking,
      },
      model: 'test-model',
      chatComplete: create,
      postprocess: stripThinking,
    }),
    LlmRequestError: class LlmRequestError extends Error {},
  };
});

vi.mock('../src/agent/tools', () => ({ toolDefinitions: [], toolNames: [], runTool }));

// `llm.vision_fallback` has no env seed (settings-schema.ts) — the only way
// to reach 'handoff' is a DB row, so mock runtime.ts directly to control it
// without needing a real/fake `db/repo`.
const visionFallbackSetting = vi.hoisted(() => ({ value: 'ask_details' as 'ask_details' | 'handoff' }));

vi.mock('../src/config/runtime', () => ({
  businessProfile: async () => ({
    businessName: 'Test Store',
    agentName: 'Arix',
    language: 'es' as const,
    discloseBot: false,
    timezone: 'America/Argentina/Buenos_Aires',
  }),
  hoursConfig: async () => [null, null, null, null, null, null, null],
  infoBlocks: async () => ({ payment: '', shipping: '', general: '' }),
  complianceRules: async () => '',
  woo: async () => ({
    url: 'https://shop.example.com',
    consumerKey: '',
    consumerSecret: '',
    frontUrl: '',
    currency: 'USD',
    statusAfterPayment: 'processing',
    statusAfterDispatch: '',
    tolerance: 1,
    configured: false,
  }),
  llm: async () => ({
    provider: 'minimax',
    apiKey: '',
    model: '',
    baseUrl: '',
    reasoningSplit: false,
    thinkingDisabled: false,
    visionFallback: visionFallbackSetting.value,
    configured: false,
  }),
}));

import { runAgent } from '../src/agent/agent';
import { esGuardrails } from '../src/agent/guardrails/es';
import type { Message, ToolContext } from '../src/types';

const ctx: ToolContext = {
  conversationId: 'c1',
  jid: '549111@s.whatsapp.net',
  phone: '549111',
  customerName: 'Juan',
  lastImage: { base64: 'ZmFrZQ==', mime: 'image/jpeg', mediaUrl: null, messageId: 'wamid.1' },
};

const historyWithImage = [
  { id: 'm1', direction: 'in', sender: 'customer', body: 'te mando el comprobante', msg_type: 'image' },
] as unknown as Message[];

interface SentMessage {
  role: string;
  content: unknown;
}

function sentMessages(): SentMessage[] {
  return create.mock.calls[0][0].messages as SentMessage[];
}

function hasImagePart(messages: SentMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as { type?: string }[]).some((part) => part?.type === 'image_url'),
  );
}

beforeEach(() => {
  create.mockReset();
  runTool.mockReset();
  providerCaps.supportsVision = false;
  visionFallbackSetting.value = 'ask_details';
  create.mockResolvedValue({
    choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content: 'Dale, pasame esos datos', tool_calls: [] } },
    ],
  });
});

describe('vision fallback when the configured provider has no vision support', () => {
  it('does not attach an image_url content part to the request', async () => {
    await runAgent(ctx, historyWithImage);
    expect(hasImagePart(sentMessages())).toBe(false);
  });

  it("preserves the customer's own text as a normal user turn", async () => {
    await runAgent(ctx, historyWithImage);
    const messages = sentMessages();
    expect(messages.some((m) => m.role === 'user' && m.content === 'te mando el comprobante')).toBe(true);
  });

  it('vision_fallback=ask_details: injects the note asking for order number + amount paid', async () => {
    visionFallbackSetting.value = 'ask_details';
    await runAgent(ctx, historyWithImage);
    const messages = sentMessages();
    expect(messages.some((m) => m.content === esGuardrails.visionUnsupportedAskDetails)).toBe(true);
    // The copy itself must actually steer toward order number + amount paid.
    expect(esGuardrails.visionUnsupportedAskDetails).toMatch(/n[uú]mero de pedido/i);
    expect(esGuardrails.visionUnsupportedAskDetails).toMatch(/monto/i);
  });

  it('vision_fallback=handoff: injects the note instructing a handoff_to_human call', async () => {
    visionFallbackSetting.value = 'handoff';
    await runAgent(ctx, historyWithImage);
    const messages = sentMessages();
    expect(messages.some((m) => m.content === esGuardrails.visionUnsupportedHandoff)).toBe(true);
    expect(esGuardrails.visionUnsupportedHandoff).toMatch(/handoff_to_human/);
  });
});

describe('vision-capable provider (contrast case — unaffected by the fallback)', () => {
  it('still attaches the image_url content part', async () => {
    providerCaps.supportsVision = true;
    await runAgent(ctx, historyWithImage);
    expect(hasImagePart(sentMessages())).toBe(true);
  });

  it('does not inject any vision-fallback note', async () => {
    providerCaps.supportsVision = true;
    await runAgent(ctx, historyWithImage);
    const messages = sentMessages();
    expect(messages.some((m) => m.content === esGuardrails.visionUnsupportedAskDetails)).toBe(false);
    expect(messages.some((m) => m.content === esGuardrails.visionUnsupportedHandoff)).toBe(false);
  });
});
