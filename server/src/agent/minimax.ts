import OpenAI from 'openai';
import { config } from '../config';

/**
 * Minimax via the OpenAI-compatible API.
 * MiniMax-M3 supports BOTH vision (read receipt images) and tool calling.
 * Base URL: https://api.minimax.io/v1
 */
export const minimax = new OpenAI({
  apiKey: config.LLM_API_KEY,
  baseURL: config.LLM_BASE_URL,
});

export const MODEL = config.LLM_MODEL;

/**
 * M3 is a thinking model: when reasoning is inlined it wraps it in
 * <think>...</think> inside `content`. Strip it before sending to a human.
 * (The raw, unstripped message is still kept in the conversation history that
 * we pass back to the model — preserving the reasoning chain as M3 requires.)
 */
export function stripThinking(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // complete reasoning blocks
    .replace(/<think>[\s\S]*$/i, '') // trailing UNCLOSED block (truncated output) → drop to end
    .replace(/<\/?think>/gi, '') // stray tags
    .trim();
}
