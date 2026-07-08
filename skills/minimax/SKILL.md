---
name: minimax
description: |
  Use the Minimax LLM platform (platform.minimax.io) from Node/TypeScript via
  the OpenAI-compatible API. Use when wiring a chat agent, reading images
  (vision), or doing tool/function calling against MiniMax-M3. Triggers:
  "Minimax", "MiniMax-M3", "api.minimax.io", "OpenAI SDK base URL", "vision
  receipt", "function calling minimax".
---

# Minimax (OpenAI-compatible) — for Nico

Minimax exposes an **OpenAI-compatible** API. We drive it with the official
`openai` Node SDK, just pointing `baseURL` at Minimax.

## Client

```ts
import OpenAI from 'openai';
const minimax = new OpenAI({
  apiKey: process.env.MINIMAX_API_KEY,     // NOT OPENAI_API_KEY — read it explicitly
  baseURL: 'https://api.minimax.io/v1',
});
```

Implemented in `server/src/agent/minimax.ts`.

## Model

- **`MiniMax-M3`** is the model we use: it supports **both vision (image input)
  and tool calling**, and has a 1M-token context window. (M2.x supports tools
  but not documented vision — use M3 for receipt reading + tools.)

## Vision (reading a transfer receipt)

Send the image as an OpenAI content part with a base64 data URL:

```ts
content: [
  { type: 'text', text: 'Leé el monto total del comprobante.' },
  { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}`, detail: 'high' } },
]
```

- Formats: JPEG, PNG, GIF, WEBP. Image ≤ 10 MB, whole request ≤ 64 MB.
- `detail`: `low` | `default` | `high` (note: Minimax uses `default`, not OpenAI's `auto`).

See `server/src/agent/nico.ts` (`historyToMessages`).

## Tool calling (multi-turn loop)

Standard OpenAI shape — `tools: [{ type: 'function', function: { name, description, parameters } }]`.
Do **not** use the deprecated `function_call` param. `tool_choice` is undocumented; omit it.

Loop (the key gotcha is **preserving the assistant message**):

```ts
const messages = [{ role: 'system', content }, ...history];
while (true) {
  const resp = await minimax.chat.completions.create({ model, messages, tools, temperature: 0.4 });
  const msg = resp.choices[0].message;
  messages.push(msg);                       // push the FULL message UNCHANGED (incl. reasoning)
  if (!msg.tool_calls?.length) break;        // finish_reason 'stop' → final answer in msg.content
  for (const tc of msg.tool_calls) {
    const result = await runTool(tc.function.name, tc.function.arguments, ctx); // arguments is a JSON string
    messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
  }
}
```

- **`tool_calls[].function.arguments` is a JSON string** — `JSON.parse` it.
- **M3 is a thinking model.** Push the full assistant message back each turn
  without modifying it (it may carry `reasoning_details` or inline
  `<think>…</think>`). Strip `<think>…</think>` only from the text you show the
  user — see `stripThinking()` in `minimax.ts`.

## Token plan / subscription

Flat-fee plans (Plus/Max/Ultra) cover all platform models with 5-hour rolling +
weekly windows. Docs: https://platform.minimax.io/docs/token-plan/intro
