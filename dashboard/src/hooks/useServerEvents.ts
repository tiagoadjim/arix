'use client';

import { useEffect, useRef } from 'react';

export interface ServerEvent {
  type: string;
  conversationId?: string;
  at: string;
}

/**
 * Subscribe to the authenticated same-origin SSE stream. EventSource handles
 * transient reconnects itself; hidden tabs close the socket and reconnect on
 * visibility, matching the polling hook's resource policy. Periodic polling
 * remains the fallback for unsupported browsers and prolonged stream failure.
 */
export function useServerEvents(onEvent: (event: ServerEvent) => void): void {
  const savedHandler = useRef(onEvent);
  savedHandler.current = onEvent;

  useEffect(() => {
    let source: EventSource | null = null;

    const close = () => {
      source?.close();
      source = null;
    };

    const connect = () => {
      if (source || document.hidden || typeof EventSource === 'undefined') return;
      source = new EventSource('/api/events', { withCredentials: true });
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as unknown;
          if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            typeof event.type === 'string' &&
            'at' in event &&
            typeof event.at === 'string'
          ) {
            savedHandler.current(event as ServerEvent);
          }
        } catch {
          // Ignore malformed/forward-incompatible events; fallback polling reconciles state.
        }
      };
    };

    const onVisibility = () => {
      if (document.hidden) close();
      else connect();
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      close();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
