/**
 * Some "thinking" models inline their reasoning wrapped in
 * <think>...</think> inside `content` when it isn't split into a separate
 * field. Strip it before sending a reply to a human — every provider goes
 * through this same postprocess step (see llm/providers.ts), even ones that
 * never actually emit the tag, since it's a safe no-op on plain text.
 * (The raw, unstripped assistant message is still kept in the conversation
 * history passed back to the model — preserving the reasoning chain for
 * providers that require it.)
 */
export function stripThinking(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // complete reasoning blocks
    .replace(/<think>[\s\S]*$/i, '') // trailing UNCLOSED block (truncated output) → drop to end
    .replace(/<\/?think>/gi, '') // stray tags
    .trim();
}
