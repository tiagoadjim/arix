'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface PollingOptions {
  enabled?: boolean;
  /** Restarts the polling lifecycle and aborts the old request when this value changes. */
  restartKey?: string | number;
}

export interface PollingControls {
  /** Coalesce a fresh serialized execution after any in-flight request. */
  refresh: () => void;
}

type PollingCallback = (signal: AbortSignal) => void | Promise<void>;

/**
 * Runs a cancellable callback immediately and then on a completion-based
 * schedule. Unlike setInterval, the next tick is never started until the
 * previous callback settles, so a slow response cannot overlap or arrive out
 * of order. Refresh/SSE bursts coalesce behind the active request instead of
 * repeatedly aborting it (which could otherwise starve polling forever).
 * Hiding the tab, unmounting, or changing restartKey still aborts promptly.
 */
export function usePolling(
  callback: PollingCallback,
  intervalMs: number,
  { enabled = true, restartKey = 'default' }: PollingOptions = {},
): PollingControls {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  const refreshCommand = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshCommand.current(), []);

  useEffect(() => {
    if (!enabled) {
      refreshCommand.current = () => {};
      return;
    }

    let disposed = false;
    let running = false;
    let runQueued = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = () => {
      clearTimer();
      if (disposed || document.hidden) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, intervalMs);
    };

    const run = async () => {
      if (disposed || document.hidden) return;
      if (running) {
        runQueued = true;
        return;
      }

      running = true;
      const currentController = new AbortController();
      controller = currentController;

      try {
        await savedCallback.current(currentController.signal);
      } catch (error) {
        // An abort is a normal control-flow event. Poll callbacks are expected
        // to surface their own operational errors in context (inline or toast).
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          // Keep polling after an unexpected callback rejection without
          // creating an unhandled promise rejection.
        }
      } finally {
        if (controller === currentController) controller = null;
        running = false;

        if (!disposed && !document.hidden) {
          if (runQueued) {
            runQueued = false;
            void run();
          } else {
            schedule();
          }
        }
      }
    };

    const requestRun = () => {
      if (disposed) return;
      clearTimer();
      if (document.hidden) return;
      if (running) {
        runQueued = true;
      } else {
        void run();
      }
    };

    const pause = () => {
      clearTimer();
      runQueued = false;
      controller?.abort();
    };

    const onVisibility = () => {
      if (document.hidden) pause();
      else requestRun();
    };

    refreshCommand.current = requestRun;
    requestRun();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      clearTimer();
      runQueued = false;
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      if (refreshCommand.current === requestRun) refreshCommand.current = () => {};
    };
  }, [enabled, intervalMs, restartKey]);

  return useMemo(() => ({ refresh }), [refresh]);
}
