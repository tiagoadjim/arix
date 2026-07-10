import { EventEmitter } from 'node:events';

export interface ArixEvent {
  type:
    | 'conversation.updated'
    | 'message.created'
    | 'message.updated'
    | 'receipt.updated'
    | 'settings.updated'
    | 'whatsapp.updated';
  conversationId?: string;
  at: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(1_000);

export function publishEvent(event: Omit<ArixEvent, 'at'>): void {
  emitter.emit('event', { ...event, at: new Date().toISOString() } satisfies ArixEvent);
}

export function subscribeEvents(listener: (event: ArixEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}
