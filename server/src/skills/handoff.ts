import { setConversationMode, insertOutboundMessage } from '../db/repo';
import { logger } from '../logger';
import type { ToolSpec } from '../agent/tool-spec';
import type { ToolContext } from '../types';

export const handoffTools: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'handoff_to_human',
        description:
          'Hands the conversation off to a human teammate and pauses your automatic replies. Use it ONLY when: (1) the customer explicitly asks to talk to a person, or (2) the request is out of your scope (you can\'t resolve it with your tools). After calling this tool, warmly let the customer know a teammate will be with them shortly.',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description:
                'Brief reason for the handoff (e.g. "customer asked to speak with a person", "out of scope: shipping complaint").',
            },
          },
          required: ['reason'],
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const reason = String(args.reason ?? '').trim() || 'sin motivo especificado';
      await setConversationMode(ctx.conversationId, 'human', { escalationReason: reason });
      await insertOutboundMessage({
        conversationId: ctx.conversationId,
        sender: 'system',
        body: `🙋 Derivado a un humano. Motivo: ${reason}`,
        sendStatus: 'sent', // internal note, not sent to WhatsApp
      });
      logger.info({ conversationId: ctx.conversationId, reason }, 'escalated to human');
      return { ok: true, derivado: true };
    },
  },
];
