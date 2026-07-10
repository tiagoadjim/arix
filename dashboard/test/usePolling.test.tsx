import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePolling } from '../src/hooks/usePolling';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a slow callback to settle before scheduling the next tick', async () => {
    const first = deferred<void>();
    const callback = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);

    renderHook(() => usePolling(callback, 1_000));
    expect(callback).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('coalesces refresh bursts behind an active request without starving it', async () => {
    const first = deferred<void>();
    const signals: AbortSignal[] = [];
    const callback = vi.fn().mockImplementation((signal: AbortSignal) => {
      signals.push(signal);
      return callback.mock.calls.length === 1 ? first.promise : Promise.resolve();
    });
    const { result } = renderHook(() => usePolling(callback, 1_000));

    act(() => result.current.refresh());
    act(() => result.current.refresh());

    expect(callback).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    await act(async () => {
      first.resolve();
      await first.promise;
      await Promise.resolve();
    });

    expect(callback).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('aborts in-flight work on unmount and stays idle when disabled', () => {
    const callback = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
    const { unmount } = renderHook(() => usePolling(callback, 1_000));
    const signal = callback.mock.calls[0]?.[0] as AbortSignal;

    unmount();

    expect(signal.aborted).toBe(true);

    const disabledCallback = vi.fn();
    renderHook(() => usePolling(disabledCallback, 1_000, { enabled: false }));
    expect(disabledCallback).not.toHaveBeenCalled();
  });

  it('pauses while the document is hidden and resumes immediately when visible', async () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const callback = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
    );

    renderHook(() => usePolling(callback, 1_000));
    const firstSignal = callback.mock.calls[0]?.[0] as AbortSignal;

    await act(async () => {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    await act(async () => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
