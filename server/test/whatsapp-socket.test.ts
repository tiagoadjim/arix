import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

type EventHandler = (payload: never) => void;

// Fake Baileys socket + makeWASocket() factory. Each call returns a fresh
// socket and retains registered callbacks so lifecycle races can be exercised.
const { makeWASocketMock, fetchLatestWaWebVersionMock, sockets, DisconnectReason } = vi.hoisted(() => {
  const sockets: Array<{
    ev: { on: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn> };
    end: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    user?: { id: string };
  }> = [];
  const makeWASocketMock = vi.fn(() => {
    const sock = {
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      end: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'sent-id' } }),
    };
    sockets.push(sock);
    return sock;
  });
  const fetchLatestWaWebVersionMock = vi.fn();
  const DisconnectReason = { loggedOut: 401, forbidden: 403, restartRequired: 515 };
  return { makeWASocketMock, fetchLatestWaWebVersionMock, sockets, DisconnectReason };
});

vi.mock('baileys', () => ({
  __esModule: true,
  default: makeWASocketMock,
  DisconnectReason,
  fetchLatestWaWebVersion: fetchLatestWaWebVersionMock,
}));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() }, generate: vi.fn() }));

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../src/logger', () => ({ logger: loggerMock, logIdentifier: vi.fn(() => 'hash') }));

const { usePostgresAuthState, clearStateMock, saveCredsMock } = vi.hoisted(() => ({
  usePostgresAuthState: vi.fn(),
  clearStateMock: vi.fn(),
  saveCredsMock: vi.fn(),
}));
vi.mock('../src/whatsapp/auth-postgres', () => ({ usePostgresAuthState }));

import { WhatsAppGateway } from '../src/whatsapp/socket';

function authState() {
  return {
    state: { creds: {}, keys: {} },
    saveCreds: saveCredsMock,
    clearState: clearStateMock,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function handler(
  sock: (typeof sockets)[number],
  event: 'creds.update' | 'connection.update' | 'messages.upsert',
): EventHandler {
  const call = (sock.ev.on.mock.calls as Array<[string, EventHandler]>).find(([name]) => name === event);
  expect(call, `missing ${event} handler`).toBeDefined();
  return call![1];
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  sockets.length = 0;
  makeWASocketMock.mockClear();
  fetchLatestWaWebVersionMock.mockReset().mockResolvedValue({
    version: [2, 3000, 1_044_539_926],
    isLatest: true,
  });
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  loggerMock.fatal.mockReset();
  clearStateMock.mockReset().mockResolvedValue(undefined);
  saveCredsMock.mockReset().mockResolvedValue(undefined);
  usePostgresAuthState.mockReset().mockImplementation(async () => authState());
});

afterEach(() => vi.useRealTimers());

describe('WhatsAppGateway lifecycle', () => {
  it('creates the socket with the current WhatsApp Web revision', async () => {
    const gateway = new WhatsAppGateway();

    await gateway.start();

    expect(fetchLatestWaWebVersionMock).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledWith(
      expect.objectContaining({ version: [2, 3000, 1_044_539_926] }),
    );
  });

  it('uses the Baileys fallback and logs a safe warning when version lookup fails', async () => {
    fetchLatestWaWebVersionMock.mockResolvedValueOnce({
      version: [2, 3000, 1_035_194_821],
      isLatest: false,
      error: new Error('lookup failed'),
    });
    const gateway = new WhatsAppGateway();

    await gateway.start();

    expect(makeWASocketMock).toHaveBeenCalledWith(
      expect.objectContaining({ version: [2, 3000, 1_035_194_821] }),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { errorType: 'Error', fallbackVersion: '2.3000.1035194821' },
      'could not resolve current WhatsApp Web version; using Baileys fallback',
    );
  });

  it('coalesces concurrent start calls into one auth read and one socket', async () => {
    const pending = deferred<ReturnType<typeof authState>>();
    usePostgresAuthState.mockReturnValueOnce(pending.promise);
    const gateway = new WhatsAppGateway();

    const first = gateway.start();
    const second = gateway.start();
    expect(second).toBe(first);
    expect(usePostgresAuthState).toHaveBeenCalledTimes(0);

    pending.resolve(authState());
    await Promise.all([first, second]);

    expect(usePostgresAuthState).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('generation-fences a slow start when restart wins the race', async () => {
    const pending = deferred<ReturnType<typeof authState>>();
    usePostgresAuthState.mockReturnValueOnce(pending.promise);
    const gateway = new WhatsAppGateway();

    const obsoleteStart = gateway.start();
    await vi.waitFor(() => expect(usePostgresAuthState).toHaveBeenCalledTimes(1));
    const restart = gateway.restart();
    pending.resolve(authState());

    await Promise.all([obsoleteStart, restart]);
    expect(usePostgresAuthState).toHaveBeenCalledTimes(2);
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
    expect(gateway.sock).toBe(sockets[0]);
  });

  it('stop waits for an in-flight start and prevents it from publishing a socket', async () => {
    const pending = deferred<ReturnType<typeof authState>>();
    usePostgresAuthState.mockReturnValueOnce(pending.promise);
    const gateway = new WhatsAppGateway();

    const start = gateway.start();
    await flushPromises();
    let stopped = false;
    const stop = gateway.stop().then(() => {
      stopped = true;
    });
    await flushPromises();
    expect(stopped).toBe(false);

    pending.resolve(authState());
    await Promise.all([start, stop]);
    expect(makeWASocketMock).not.toHaveBeenCalled();
    expect(gateway.sock).toBeNull();
    expect(gateway.stopped).toBe(true);
  });
});

describe('WhatsAppGateway.restart()', () => {
  it('resolves the WhatsApp Web revision again for the replacement socket', async () => {
    fetchLatestWaWebVersionMock
      .mockResolvedValueOnce({ version: [2, 3000, 1_044_000_001], isLatest: true })
      .mockResolvedValueOnce({ version: [2, 3000, 1_044_000_002], isLatest: true });
    const gateway = new WhatsAppGateway();

    await gateway.start();
    await gateway.restart();

    expect(fetchLatestWaWebVersionMock).toHaveBeenCalledTimes(2);
    expect(makeWASocketMock.mock.calls.map(([options]) => options.version)).toEqual([
      [2, 3000, 1_044_000_001],
      [2, 3000, 1_044_000_002],
    ]);
  });

  it('without clearSession tears down and reconnects with the same stored creds', async () => {
    const gateway = new WhatsAppGateway();
    await gateway.start();
    const firstSock = sockets[0]!;

    await gateway.restart();

    expect(firstSock.logout).not.toHaveBeenCalled();
    expect(clearStateMock).not.toHaveBeenCalled();
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });

  it('clearSession logs out, clears persisted auth, then reconnects for a real re-pair', async () => {
    const gateway = new WhatsAppGateway();
    await gateway.start();
    const firstSock = sockets[0]!;

    await gateway.restart({ clearSession: true });

    expect(firstSock.logout).toHaveBeenCalledTimes(1);
    expect(clearStateMock).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });

  it('a failed logout never blocks clearing state and restarting', async () => {
    const gateway = new WhatsAppGateway();
    await gateway.start();
    const firstSock = sockets[0]!;
    firstSock.logout.mockRejectedValueOnce(new Error('socket already closed'));

    await expect(gateway.restart({ clearSession: true })).resolves.toBeUndefined();

    expect(clearStateMock).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });

  it('clearSession erases DB state even before a live socket/state clearer exists', async () => {
    const gateway = new WhatsAppGateway();

    await expect(gateway.restart({ clearSession: true })).resolves.toBeUndefined();

    // First auth load obtains the DB clearer, second initializes the fresh
    // socket after deletion.
    expect(usePostgresAuthState).toHaveBeenCalledTimes(2);
    expect(clearStateMock).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when persisted auth cannot be cleared, and only a successful forced retry unblocks it', async () => {
    const gateway = new WhatsAppGateway();
    clearStateMock.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(gateway.restart({ clearSession: true })).rejects.toThrow('database unavailable');
    expect(gateway.stopped).toBe(true);
    expect(gateway.sock).toBeNull();
    expect(makeWASocketMock).not.toHaveBeenCalled();

    await expect(gateway.restart()).rejects.toThrow('database unavailable');
    expect(makeWASocketMock).not.toHaveBeenCalled();

    await expect(gateway.restart({ clearSession: true })).resolves.toBeUndefined();
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('ignores the close event emitted by logout so auth is cleared exactly once', async () => {
    const gateway = new WhatsAppGateway();
    await gateway.start();
    const firstSock = sockets[0]!;
    const onConnectionUpdate = handler(firstSock, 'connection.update');

    firstSock.logout.mockImplementationOnce(async () => {
      onConnectionUpdate({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
      } as never);
    });

    await gateway.restart({ clearSession: true });
    expect(clearStateMock).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });
});

describe('WhatsAppGateway async event serialization', () => {
  it('publishes an emitted pairing QR and clears it once connected', async () => {
    const gateway = new WhatsAppGateway();
    await gateway.start();
    const onConnectionUpdate = handler(sockets[0]!, 'connection.update');

    onConnectionUpdate({ qr: 'qr-data' } as never);
    expect(gateway.latestQR).toBe('qr-data');
    expect(gateway.connected).toBe(false);

    onConnectionUpdate({ connection: 'open' } as never);
    expect(gateway.latestQR).toBeNull();
    expect(gateway.connected).toBe(true);
  });

  it('drains every admitted per-JID message before closing the transport', async () => {
    const handled = deferred<void>();
    const gateway = new WhatsAppGateway();
    gateway.onMessage = vi.fn(() => handled.promise);
    await gateway.start();
    const firstSock = sockets[0]!;
    handler(firstSock, 'messages.upsert')({
      type: 'notify',
      messages: [{ key: { id: 'admitted', remoteJid: 'a@example', fromMe: false } }],
    } as never);
    await flushPromises();

    const stop = gateway.stop();
    await flushPromises();
    expect(firstSock.end).not.toHaveBeenCalled();

    handled.resolve();
    await stop;
    expect(firstSock.end).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying an automatic reconnect when socket creation fails transiently', async () => {
    const gateway = new WhatsAppGateway();
    await gateway.start();
    const firstSock = sockets[0]!;
    usePostgresAuthState.mockRejectedValueOnce(new Error('temporary database outage'));
    vi.useFakeTimers();

    handler(firstSock, 'connection.update')({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    } as never);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(usePostgresAuthState).toHaveBeenCalledTimes(2);
    expect(gateway.sock).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(usePostgresAuthState).toHaveBeenCalledTimes(3);
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
    expect(gateway.sock).toBe(sockets[1]);
  });

  it('serializes creds.update writes and stop waits for all admitted writes', async () => {
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    saveCredsMock
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const gateway = new WhatsAppGateway();
    await gateway.start();
    const onCredsUpdate = handler(sockets[0]!, 'creds.update');

    onCredsUpdate(undefined as never);
    onCredsUpdate(undefined as never);
    await flushPromises();
    expect(saveCredsMock).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stop = gateway.stop().then(() => {
      stopped = true;
    });
    await flushPromises();
    expect(stopped).toBe(false);

    firstWrite.resolve();
    await vi.waitFor(() => expect(saveCredsMock).toHaveBeenCalledTimes(2));
    expect(stopped).toBe(false);

    secondWrite.resolve();
    await stop;
    expect(stopped).toBe(true);
  });

  it('retries a credential write failure and continues the serialized queue', async () => {
    saveCredsMock.mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(undefined);
    const gateway = new WhatsAppGateway();
    await gateway.start();
    const onCredsUpdate = handler(sockets[0]!, 'creds.update');

    onCredsUpdate(undefined as never);
    onCredsUpdate(undefined as never);
    await gateway.stop();

    expect(saveCredsMock).toHaveBeenCalledTimes(3);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), attempt: 1 }),
      'retrying WhatsApp credential persistence',
    );
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('processes messages in order per JID while allowing different JIDs in parallel', async () => {
    const a1Done = deferred<void>();
    const a2Done = deferred<void>();
    const b1Done = deferred<void>();
    const started: string[] = [];
    const waits = new Map([
      ['a1', a1Done.promise],
      ['a2', a2Done.promise],
      ['b1', b1Done.promise],
    ]);
    const gateway = new WhatsAppGateway();
    gateway.onMessage = vi.fn(async (_sock, message) => {
      const id = message.key.id!;
      started.push(id);
      await waits.get(id);
    });
    await gateway.start();
    const onMessages = handler(sockets[0]!, 'messages.upsert');

    onMessages({
      type: 'notify',
      messages: [
        { key: { id: 'a1', remoteJid: 'a@example', fromMe: false } },
        { key: { id: 'a2', remoteJid: 'a@example', fromMe: false } },
        { key: { id: 'b1', remoteJid: 'b@example', fromMe: false } },
      ],
    } as never);
    await flushPromises();

    expect(started).toEqual(['a1', 'b1']);
    expect(started).not.toContain('a2');
    b1Done.resolve();
    await flushPromises();
    expect(started).not.toContain('a2');

    a1Done.resolve();
    await vi.waitFor(() => expect(started).toEqual(['a1', 'b1', 'a2']));
    a2Done.resolve();
  });

  it('captures rejected connection callbacks instead of creating unhandled rejections', async () => {
    const gateway = new WhatsAppGateway();
    gateway.onConnected = async () => {
      throw new Error('recovery failed');
    };
    await gateway.start();

    handler(sockets[0]!, 'connection.update')({ connection: 'open' } as never);
    await vi.waitFor(() => {
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'WhatsApp onConnected callback failed',
      );
    });
  });

  it('captures a logged-out clear failure and leaves the gateway stopped', async () => {
    const gateway = new WhatsAppGateway();
    await gateway.start();
    clearStateMock.mockRejectedValueOnce(new Error('clear failed'));

    handler(sockets[0]!, 'connection.update')({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    } as never);

    await vi.waitFor(() => {
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), code: DisconnectReason.loggedOut }),
        'WhatsApp close handler failed; gateway remains stopped',
      );
    });
    expect(gateway.stopped).toBe(true);
    expect(gateway.sock).toBeNull();
  });
});
