import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock, httpsRequestMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  httpsRequestMock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('node:https', () => ({ request: httpsRequestMock }));

import { safeFetch } from '../src/net/safe-fetch';

beforeEach(() => {
  lookupMock.mockReset();
  httpsRequestMock.mockReset();
  httpsRequestMock.mockImplementation(
    (options: RequestOptions, callback: (message: IncomingMessage) => void) => {
      const outgoing = Object.assign(new EventEmitter(), {
        end: vi.fn(() => {
          const incoming = Readable.from([Buffer.from('pinned response')]) as IncomingMessage;
          Object.assign(incoming, {
            statusCode: 200,
            statusMessage: 'OK',
            rawHeaders: ['content-type', 'text/plain'],
            headers: { 'content-type': 'text/plain' },
          });
          incoming.once('end', () => outgoing.emit('close'));
          queueMicrotask(() => callback(incoming));
        }),
        destroy: vi.fn((error?: Error) => {
          if (error) queueMicrotask(() => outgoing.emit('error', error));
          queueMicrotask(() => outgoing.emit('close'));
          return outgoing;
        }),
        __options: options,
      });
      return outgoing as unknown as ClientRequest;
    },
  );
});

describe('DNS-rebinding resistance', () => {
  it('connects to the one validated IP without a second DNS lookup', async () => {
    // A rebinding name would return a public address for policy validation and
    // a private address on a subsequent lookup. The second answer must remain
    // unused because the TCP connection is made directly to the first address.
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

    const response = await safeFetch('https://rebind.attacker.example/resource', {
      headers: { host: 'forged.internal', 'x-test': 'preserved' },
    });

    await expect(response.text()).resolves.toBe('pinned response');
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith('rebind.attacker.example', {
      all: true,
      verbatim: true,
    });
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    const options = httpsRequestMock.mock.calls[0]![0] as RequestOptions & {
      servername?: string;
    };
    expect(options).toMatchObject({
      protocol: 'https:',
      hostname: '93.184.216.34',
      family: 4,
      path: '/resource',
      servername: 'rebind.attacker.example',
      agent: false,
    });
    expect(options.headers).toMatchObject({
      host: 'rebind.attacker.example',
      'x-test': 'preserved',
    });
    expect(options).not.toHaveProperty('lookup');
  });

  it('falls back across the already-validated DNS answers without resolving again', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    const seen: string[] = [];
    const transport = vi.fn(async (_request: Request, remote: { address: string }) => {
      seen.push(remote.address);
      if (remote.address.includes(':')) throw new Error('IPv6 route unavailable');
      return new Response('fallback ok');
    });

    const response = await safeFetch('https://dual-stack.example/resource', {}, { transport });

    await expect(response.text()).resolves.toBe('fallback ok');
    expect(seen).toEqual(['2001:4860:4860::8888', '93.184.216.34']);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('does not replay a write across addresses after an ambiguous transport failure', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]);
    const transport = vi.fn().mockRejectedValue(new Error('connection reset after request write'));

    await expect(
      safeFetch('https://dual-stack.example/write', { method: 'POST', body: '{}' }, { transport }),
    ).rejects.toThrow('connection reset');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
