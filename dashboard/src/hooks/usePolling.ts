'use client';

import { useEffect, useRef } from 'react';

/**
 * Runs `callback` immediately, then every `intervalMs`. Polling fully stops
 * while the tab is hidden (`document.hidden`) — not just skips a tick — and
 * resumes with an immediate call as soon as it becomes visible again, so a
 * backgrounded tab never hammers the API. Always cleans up on unmount.
 */
export function usePolling(callback: () => void | Promise<void>, intervalMs: number): void {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer || document.hidden) return;
      void savedCallback.current();
      timer = setInterval(() => void savedCallback.current(), intervalMs);
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}
