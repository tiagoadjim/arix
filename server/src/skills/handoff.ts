import { setConversationMode, insertOutboundMessage } from '../db/repo';
import { logger } from '../logger';
import type { ToolSpec } from '../agent/tool-spec';
import type { ToolContext } from '../types';

export const handoffTools: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'derivar_a_humano',
        description:
          'Deriva la conversación a un agente humano y pausa tus respuestas automáticas. Usalo SOLO cuando: (1) el cliente pide explícitamente hablar con una persona, o (2) la consulta o acción está fuera de tu alcance (no podés resolverla con tus tools). Después de llamar esta tool, avisale al cliente con calidez que en un momento lo atiende una persona del equipo.',
        parameters: {
          type: 'object',
          properties: {
            motivo: {
              type: 'string',
              description:
                'Motivo breve de la derivación (ej: "el cliente pidió hablar con una persona", "consulta fuera de alcance: reclamo de envío").',
            },
          },
          required: ['motivo'],
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const motivo = String(args.motivo ?? '').trim() || 'sin motivo especificado';
      await setConversationMode(ctx.conversationId, 'human', { escalationReason: motivo });
      await insertOutboundMessage({
        conversationId: ctx.conversationId,
        sender: 'system',
        body: `🙋 Derivado a un humano. Motivo: ${motivo}`,
        sendStatus: 'sent', // internal note, not sent to WhatsApp
      });
      logger.info({ conversationId: ctx.conversationId, motivo }, 'escalated to human');
      return { ok: true, derivado: true };
    },
  },
];
