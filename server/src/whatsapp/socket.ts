import makeWASocket, {
  DisconnectReason,
  type WASocket,
  type WAMessage,
  type AnyMessageContent,
} from 'baileys';
import qrcodeTerminal from 'qrcode-terminal';
import { createHash } from 'node:crypto';
import { config } from '../config';
import { logger, logIdentifier } from '../logger';
import { usePostgresAuthState } from './auth-postgres';

export type IncomingHandler = (sock: WASocket, msg: WAMessage) => Promise<void>;

/** Deterministic WhatsApp id derived from our durable idempotency key. Baileys
 * accepts a custom messageId, so an ambiguous retry reuses the same remote key
 * instead of creating a duplicate bubble. */
export function stableWhatsAppMessageId(clientId: string): string {
  return createHash('sha256').update(`arix-wa:${clientId}`).digest('hex').slice(0, 32).toUpperCase();
}

interface DisconnectErr {
  output?: { statusCode?: number };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

class GatewayTimeoutError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function withTimeout<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GatewayTimeoutError(message)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const MESSAGE_DRAIN_TIMEOUT_MS = Math.min(config.SHUTDOWN_TIMEOUT_MS, 10_000);
const LOGOUT_TIMEOUT_MS = 5_000;
const CREDENTIAL_WRITE_ATTEMPTS = 3;
const CREDENTIAL_RETRY_BASE_MS = 250;

/**
 * Owns the single Baileys socket: connect, reconnect with backoff, persist
 * creds to Postgres, surface the QR (terminal + health endpoint), and dispatch
 * inbound messages to a handler. Sending also goes through here.
 *
 * Lifecycle operations are serialized and generation-fenced. Incrementing the
 * generation happens synchronously when restart()/stop() is requested, so a
 * slow auth-state read from an older start can never publish a stale socket.
 */
export class WhatsAppGateway {
  sock: WASocket | null = null;
  latestQR: string | null = null;
  connected = false;
  stopped = false;
  private reconnectAttempts = 0;
  private clearState: (() => Promise<void>) | null = null;
  private clearStateFailure: Error | null = null;
  private generation = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private pendingLifecycle: Promise<void> | null = null;
  private activeStart: Promise<void> | null = null;
  private credentialsTail: Promise<void> = Promise.resolve();
  private credentialsFailure: Error | null = null;
  private credentialsFailCloseTail: Promise<void> = Promise.resolve();
  private readonly messageTails = new Map<string, Promise<void>>();

  /** Set by the wiring in index.ts. Defaults to a no-op. */
  onMessage: IncomingHandler = async () => {};
  /** Called each time the socket reaches 'open' (used to recover unanswered chats). */
  onConnected: () => void | Promise<void> = () => {};
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Connect once. Concurrent calls coalesce into the same lifecycle operation. */
  start(): Promise<void> {
    // If restart/stop already owns the lifecycle, wait for that operation
    // rather than reporting completion while it is still draining resources.
    if (this.stopped) return this.pendingLifecycle ?? Promise.resolve();
    if (this.activeStart) return this.activeStart;

    const expectedGeneration = this.generation;
    return this.trackStart(this.enqueueLifecycle(() => this.startGeneration(expectedGeneration)));
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const run = this.lifecycleTail.then(operation, operation);
    // Keep the mutex usable after a failed operation while returning the real
    // rejection to its caller.
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private trackStart(operation: Promise<void>): Promise<void> {
    this.activeStart = operation;
    void operation.then(
      () => {
        if (this.activeStart === operation) this.activeStart = null;
      },
      () => {
        if (this.activeStart === operation) this.activeStart = null;
      },
    );
    return operation;
  }

  private trackLifecycle(operation: Promise<void>): Promise<void> {
    this.pendingLifecycle = operation;
    void operation.then(
      () => {
        if (this.pendingLifecycle === operation) this.pendingLifecycle = null;
      },
      () => {
        if (this.pendingLifecycle === operation) this.pendingLifecycle = null;
      },
    );
    return operation;
  }

  private isCurrent(sock: WASocket, generation: number): boolean {
    return !this.stopped && this.generation === generation && this.sock === sock;
  }

  private async startGeneration(expectedGeneration: number): Promise<void> {
    if (this.stopped || expectedGeneration !== this.generation) return;
    if (this.clearStateFailure) throw this.clearStateFailure;

    this.clearReconnectTimer();

    // Detach listeners before awaiting the write tail: after detachment no new
    // creds.update can be admitted from the old socket, so the awaited tail is
    // a stable drain point.
    const previous = this.detachSocket();
    await this.drainMessages();
    this.endSocket(previous);
    await this.credentialsTail;
    await this.credentialsFailCloseTail;

    if (this.stopped || expectedGeneration !== this.generation) return;
    if (this.credentialsFailure) throw this.credentialsFailure;
    const { state, saveCreds, clearState } = await usePostgresAuthState(config.WA_ACCOUNT_ID);

    // A restart/stop may have won while Postgres was loading. Do not expose a
    // socket (or even its state clearer) from the obsolete generation.
    if (this.stopped || expectedGeneration !== this.generation) return;
    this.clearState = clearState;

    const sock = makeWASocket({
      auth: state,
      logger: logger as never,
      markOnlineOnConnect: config.WA_MARK_ONLINE,
      // Avoid heavy full-history sync; we only care about live messages.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      if (!this.isCurrent(sock, expectedGeneration)) return;
      this.enqueueCredentialsWrite(saveCreds, sock, expectedGeneration);
    });

    sock.ev.on('connection.update', (update) => {
      if (!this.isCurrent(sock, expectedGeneration)) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.latestQR = qr;
        if (config.WA_QR_TERMINAL) {
          logger.warn('WhatsApp pairing QR terminal output is enabled; treat retained logs as credentials');
          qrcodeTerminal.generate(qr, { small: true });
        } else {
          logger.info('WhatsApp pairing QR available in the authenticated dashboard');
        }
      }

      if (connection === 'open') {
        this.connected = true;
        this.latestQR = null;
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        logger.info({ userHash: logIdentifier(sock.user?.id) }, '✓ WhatsApp conectado');
        void Promise.resolve()
          .then(() => this.onConnected())
          .catch((err: unknown) => logger.error({ err }, 'WhatsApp onConnected callback failed'));
      }

      if (connection === 'close') {
        this.connected = false;
        const code = (lastDisconnect?.error as DisconnectErr | undefined)?.output?.statusCode;
        void this.handleClose(code, sock, expectedGeneration).catch((err: unknown) => {
          logger.error({ err, code }, 'WhatsApp close handler failed; gateway remains stopped');
        });
      }
    });

    sock.ev.on('messages.upsert', ({ type, messages }) => {
      if (!this.isCurrent(sock, expectedGeneration) || type !== 'notify') return;
      for (const message of messages) {
        if (message.key.fromMe) continue;
        this.enqueueMessage(sock, message);
      }
    });
  }

  private enqueueCredentialsWrite(saveCreds: () => Promise<void>, sock: WASocket, generation: number): void {
    const write = this.credentialsTail.then(async () => {
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= CREDENTIAL_WRITE_ATTEMPTS; attempt += 1) {
        try {
          await saveCreds();
          this.credentialsFailure = null;
          return;
        } catch (err) {
          lastError = asError(err);
          if (attempt < CREDENTIAL_WRITE_ATTEMPTS) {
            const retryInMs = CREDENTIAL_RETRY_BASE_MS * 2 ** (attempt - 1);
            logger.warn({ err: lastError, attempt, retryInMs }, 'retrying WhatsApp credential persistence');
            await delay(retryInMs);
          }
        }
      }
      throw lastError ?? new Error('failed to persist WhatsApp credentials');
    });
    this.credentialsTail = write.catch((err: unknown) => {
      const failure = asError(err);
      this.credentialsFailure = failure;
      logger.error({ err: failure }, 'failed to persist WhatsApp credentials; gateway stopped fail-closed');
      this.stopped = true;
      this.clearReconnectTimer();
      if (this.generation === generation) this.generation += 1;
      const previous = this.sock === sock ? this.detachSocket() : null;
      const close = this.credentialsFailCloseTail.then(async () => {
        await this.drainMessages();
        this.endSocket(previous);
      });
      this.credentialsFailCloseTail = close.catch(() => undefined);
    });
  }

  private enqueueMessage(sock: WASocket, message: WAMessage): void {
    const jid = message.key.remoteJid ?? '<unknown>';
    const previous = this.messageTails.get(jid) ?? Promise.resolve();
    const run = previous.then(async () => {
      // Admission itself is generation-fenced by messages.upsert. Once admitted,
      // finish the per-JID chain even if a restart is requested; lifecycle
      // teardown drains these promises before closing their transport.
      await this.onMessage(sock, message);
    });
    const settled = run.catch((err: unknown) => {
      logger.error({ err, jidHash: logIdentifier(message.key.remoteJid) }, 'onMessage handler threw');
    });
    this.messageTails.set(jid, settled);
    void settled.then(() => {
      if (this.messageTails.get(jid) === settled) this.messageTails.delete(jid);
    });
  }

  /**
   * Remove listeners and ownership of the current socket synchronously. The
   * returned transport can then be logged out or ended without any stale event
   * being able to mutate the gateway.
   */
  private detachSocket(): WASocket | null {
    const sock = this.sock;
    if (sock) {
      try {
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.upsert');
      } catch {
        /* best-effort */
      }
    }
    this.sock = null;
    this.latestQR = null;
    this.connected = false;
    return sock;
  }

  private endSocket(sock: WASocket | null): void {
    if (!sock) return;
    try {
      sock.end(undefined);
    } catch {
      /* best-effort */
    }
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async drainMessages(): Promise<void> {
    const admitted = [...this.messageTails.values()];
    if (admitted.length === 0) return;
    try {
      await withTimeout(Promise.allSettled(admitted).then(() => undefined), MESSAGE_DRAIN_TIMEOUT_MS, 'message drain timed out');
    } catch (err) {
      logger.warn({ err, pending: this.messageTails.size }, 'WhatsApp message drain deadline reached');
    }
  }

  /**
   * Recreate the transport. clearSession performs a real re-pair and is
   * fail-closed: if deleting persisted Signal state fails, the old transport
   * remains detached and no replacement socket starts with ambiguous creds.
   * It also works before the first/live socket exists by loading the persisted
   * auth-state clearer directly.
   */
  restart(opts: { clearSession?: boolean } = {}): Promise<void> {
    const requestedGeneration = ++this.generation;
    this.stopped = true;
    this.clearReconnectTimer();

    const operation = this.enqueueLifecycle(async () => {
      const previous = this.detachSocket();
      await this.drainMessages();
      await this.credentialsTail;
      await this.credentialsFailCloseTail;

      if (opts.clearSession) {
        if (previous) {
          try {
            await withTimeout(previous.logout(), LOGOUT_TIMEOUT_MS, 'WhatsApp logout timed out');
          } catch (err) {
            logger.warn({ err }, 'WhatsApp logout() failed during a forced restart; clearing local state anyway');
          }
        }
        this.endSocket(previous);

        try {
          let clearState = this.clearState;
          if (!clearState) {
            ({ clearState } = await usePostgresAuthState(config.WA_ACCOUNT_ID));
          }
          await clearState();
          this.clearState = null;
          this.clearStateFailure = null;
          this.credentialsFailure = null;
        } catch (err) {
          this.clearStateFailure = asError(err);
          this.stopped = true;
          throw this.clearStateFailure;
        }
      } else {
        this.endSocket(previous);
        if (this.clearStateFailure) throw this.clearStateFailure;
        if (this.credentialsFailure) throw this.credentialsFailure;
      }

      // A newer lifecycle request owns the final state. A forced clear above
      // still completes (security-sensitive), but this stale operation must not
      // create its socket.
      if (requestedGeneration !== this.generation) return;
      this.stopped = false;
      this.reconnectAttempts = 0;
      await this.startGeneration(requestedGeneration);
    });

    return this.trackStart(this.trackLifecycle(operation));
  }

  private async handleClose(code: number | undefined, sock: WASocket, generation: number): Promise<void> {
    if (!this.isCurrent(sock, generation)) return;

    if (code === DisconnectReason.forbidden) {
      logger.fatal('🚫 WhatsApp returned FORBIDDEN — the account may be banned. Stopping reconnects.');
      await this.stop();
      return;
    }

    if (code === DisconnectReason.loggedOut) {
      logger.warn('WhatsApp logged out (device removed). Clearing auth — a new QR will appear.');
      // Reuse the same fail-closed reset path as an operator-forced re-pair.
      await this.restart({ clearSession: true });
      return;
    }

    if (code === DisconnectReason.restartRequired) {
      logger.info('Restart required (normal after QR scan) — recreating socket.');
      this.scheduleReconnect(500, generation);
      return;
    }

    // connectionClosed / connectionLost / timedOut / badSession / etc → backoff.
    const delay = Math.min(30_000, 2 ** this.reconnectAttempts * 1000);
    this.reconnectAttempts += 1;
    logger.warn({ code, delay }, 'Connection closed — reconnecting with backoff.');
    this.scheduleReconnect(delay, generation);
  }

  /** Schedule a single reconnect; dedupes overlapping 'close' events during a flap. */
  private scheduleReconnect(delay: number, generation: number): void {
    if (this.stopped || generation !== this.generation || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || generation !== this.generation) return;
      void this.start().catch((err: unknown) => {
        if (this.stopped || generation !== this.generation) return;
        const retryDelay = Math.min(30_000, 2 ** this.reconnectAttempts * 1000);
        this.reconnectAttempts += 1;
        logger.error({ err, retryDelay }, 'automatic WhatsApp reconnect failed; retrying');
        this.scheduleReconnect(retryDelay, generation);
      });
    }, delay);
  }

  async send(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    return this.sock.sendMessage(jid, content);
  }

  async sendText(jid: string, text: string, messageId?: string): Promise<string | null> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    const sent = await this.sock.sendMessage(jid, { text }, messageId ? { messageId } : undefined);
    return sent?.key?.id ?? null;
  }

  /** Stop reconnects and close the live transport without logging the account
   * out (logout would invalidate the persisted pairing). Waits for any older
   * start and admitted credential writes before resolving. */
  stop(): Promise<void> {
    ++this.generation;
    this.stopped = true;
    this.clearReconnectTimer();

    return this.trackLifecycle(this.enqueueLifecycle(async () => {
      const previous = this.detachSocket();
      await this.drainMessages();
      await this.credentialsTail;
      await this.credentialsFailCloseTail;
      this.endSocket(previous);
    }));
  }

  /** Show "typing…" for a moment to feel human, then stop. */
  async indicateTyping(jid: string, ms = 1200): Promise<void> {
    try {
      await this.sock?.presenceSubscribe(jid);
      await this.sock?.sendPresenceUpdate('composing', jid);
      await new Promise((resolve) => setTimeout(resolve, ms));
      await this.sock?.sendPresenceUpdate('paused', jid);
    } catch {
      // presence is best-effort
    }
  }
}
