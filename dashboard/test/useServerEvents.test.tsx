import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useServerEvents } from '../src/hooks/useServerEvents';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly close = vi.fn();
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
}

describe('useServerEvents', () => {
  let hidden = false;

  beforeEach(() => {
    FakeEventSource.instances = [];
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the authenticated stream and forwards only valid events', () => {
    const onEvent = vi.fn();
    renderHook(() => useServerEvents(onEvent));
    const source = FakeEventSource.instances[0]!;

    expect(source.url).toBe('/api/events');
    expect(source.options).toEqual({ withCredentials: true });

    act(() => {
      source.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'message.created', conversationId: 'c1', at: '2026-07-10T12:00:00Z' }),
        }),
      );
      source.onmessage?.(new MessageEvent('message', { data: '{not-json' }));
      source.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 42, at: null }) }));
    });

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      type: 'message.created',
      conversationId: 'c1',
      at: '2026-07-10T12:00:00Z',
    });
  });

  it('closes while hidden, reconnects when visible, and closes on unmount', () => {
    const { unmount } = renderHook(() => useServerEvents(vi.fn()));
    const first = FakeEventSource.instances[0]!;

    act(() => {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(first.close).toHaveBeenCalledOnce();

    act(() => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(FakeEventSource.instances).toHaveLength(2);

    const second = FakeEventSource.instances[1]!;
    unmount();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('does nothing when EventSource is unavailable', () => {
    vi.stubGlobal('EventSource', undefined);

    expect(() => renderHook(() => useServerEvents(vi.fn()))).not.toThrow();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
