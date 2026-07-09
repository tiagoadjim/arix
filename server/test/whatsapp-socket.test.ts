import { vi, describe, it, expect, beforeEach } from 'vitest';

// Fake Baileys socket + makeWASocket() factory. Each call returns a fresh
// fake socket so WhatsAppGateway.start() creating a new one is observable.
const { makeWASocketMock, sockets, DisconnectReason } = vi.hoisted(() => {
  const sockets: Array<{
    ev: { on: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn> };
    end: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    user?: { id: string };
  }> = [];
  const makeWASocketMock = vi.fn(() => {
    const sock = {
      ev: { on: vi.fn(), removeAllListeners: vi.fn() },
      end: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
    };
    sockets.push(sock);
    return sock;
  });
  const DisconnectReason = { loggedOut: 401, forbidden: 403, restartRequired: 515 };
  return { makeWASocketMock, sockets, DisconnectReason };
});

vi.mock('baileys', () => ({
  __esModule: true,
  default: makeWASocketMock,
  DisconnectReason,
}));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() }, generate: vi.fn() }));
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const { usePostgresAuthState, clearStateMock } = vi.hoisted(() => {
  const clearStateMock = vi.fn().mockResolvedValue(undefined);
  const usePostgresAuthState = vi.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
    clearState: clearStateMock,
  });
  return { usePostgresAuthState, clearStateMock };
});
vi.mock('../src/whatsapp/auth-postgres', () => ({ usePostgresAuthState }));

import { WhatsAppGateway } from '../src/whatsapp/socket';

beforeEach(() => {
  sockets.length = 0;
  makeWASocketMock.mockClear();
  usePostgresAuthState.mockClear();
  clearStateMock.mockClear();
});

describe('WhatsAppGateway.restart()', () => {
  it('without clearSession: just tears down and reconnects with the same stored creds (no logout, no state clear)', async () => {
    const gw = new WhatsAppGateway();
    await gw.start();
    const firstSock = sockets[0]!;

    await gw.restart();

    expect(firstSock.logout).not.toHaveBeenCalled();
    expect(clearStateMock).not.toHaveBeenCalled();
    expect(makeWASocketMock).toHaveBeenCalledTimes(2); // one fresh socket for the restart
  });

  it('with clearSession: true — logs out the current socket AND clears persisted auth state before reconnecting (real re-pair)', async () => {
    const gw = new WhatsAppGateway();
    await gw.start();
    const firstSock = sockets[0]!;

    await gw.restart({ clearSession: true });

    expect(firstSock.logout).toHaveBeenCalledTimes(1);
    expect(clearStateMock).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });

  it('with clearSession: true — a failed logout() never blocks clearing state and restarting', async () => {
    const gw = new WhatsAppGateway();
    await gw.start();
    const firstSock = sockets[0]!;
    firstSock.logout.mockRejectedValueOnce(new Error('socket already closed'));

    await expect(gw.restart({ clearSession: true })).resolves.toBeUndefined();

    expect(clearStateMock).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });

  it('with clearSession: true and no live socket/state yet — skips logout and the (unset) clearState, but still starts fresh', async () => {
    const gw = new WhatsAppGateway(); // never started, so there's nothing to log out of or clear yet

    await expect(gw.restart({ clearSession: true })).resolves.toBeUndefined();

    expect(clearStateMock).not.toHaveBeenCalled();
    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('with clearSession: true — a close event fired WHILE logout() is in flight is ignored (handleClose early-returns on `stopped`), so clearState is never called twice', async () => {
    const gw = new WhatsAppGateway();
    await gw.start();
    const firstSock = sockets[0]!;

    // Grab the 'connection.update' handler socket.ts registered on this
    // socket, so we can simulate Baileys firing its own close event as a
    // side effect of logout() — a real scenario, since logging out a socket
    // can itself trigger a 'close'.
    const onCalls = firstSock.ev.on.mock.calls as Array<[string, (update: unknown) => void]>;
    const connectionUpdateHandler = onCalls.find(([event]) => event === 'connection.update')?.[1];
    expect(connectionUpdateHandler).toBeDefined();

    firstSock.logout.mockImplementationOnce(async () => {
      // Fired mid-restart, while `this.stopped` is already true (set by
      // restart() before calling logout()) and `this.sock` still === firstSock
      // (teardownSocket() hasn't run yet) — handleClose() must early-return
      // instead of running its own DisconnectReason.loggedOut clearState().
      connectionUpdateHandler!({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
      });
    });

    await gw.restart({ clearSession: true });

    // Only restart()'s own explicit clearState() call — handleClose()'s
    // loggedOut branch never ran a second one.
    expect(clearStateMock).toHaveBeenCalledTimes(1);
    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });
});
