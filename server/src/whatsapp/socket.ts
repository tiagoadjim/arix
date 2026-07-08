import makeWASocket, {
  DisconnectReason,
  type WASocket,
  type WAMessage,
  type AnyMessageContent,
} from 'baileys';
import qrcodeTerminal from 'qrcode-terminal';
import { config } from '../config';
import { logger } from '../logger';
import { usePostgresAuthState } from './auth-postgres';

export type IncomingHandler = (sock: WASocket, msg: WAMessage) => Promise<void>;

interface DisconnectErr {
  output?: { statusCode?: number };
}

/**
 * Owns the single Baileys socket: connect, reconnect with backoff, persist
 * creds to Postgres, surface the QR (terminal + health endpoint), and dispatch
 * inbound messages to a handler. Sending also goes through here.
 */
export class WhatsAppGateway {
  sock: WASocket | null = null;
  latestQR: string | null = null;
  connected = false;
  stopped = false;
  private reconnectAttempts = 0;
  private clearState: (() => Promise<void>) | null = null;
  /** True while a start() call is in flight — guards against two overlapping
   * start()s (e.g. an automatic reconnect racing a manual restart()) both
   * creating a socket and stomping on `this.sock`. */
  private starting = false;

  /** Set by the wiring in index.ts. Defaults to a no-op. */
  onMessage: IncomingHandler = async () => {};
  /** Called each time the socket reaches 'open' (used to recover unanswered chats). */
  onConnected: () => void = () => {};
  private reconnectTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    if (this.starting) {
      logger.warn('WhatsAppGateway.start() called while a start was already in progress — ignoring');
      return;
    }
    this.starting = true;
    try {
      // Tear down any previous socket so flaps don't leave parallel live sockets
      // (duplicate inbound delivery + stale creds writes).
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.teardownSocket();

      const { state, saveCreds, clearState } = await usePostgresAuthState(config.WA_ACCOUNT_ID);
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

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (update) => {
        if (this.sock !== sock) return; // ignore events from a torn-down socket
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.latestQR = qr;
          logger.info('📱 Escaneá este QR en WhatsApp → Dispositivos vinculados:');
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'open') {
          this.connected = true;
          this.latestQR = null;
          this.reconnectAttempts = 0;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          logger.info({ user: sock.user?.id }, '✓ WhatsApp conectado');
          this.onConnected();
        }

        if (connection === 'close') {
          this.connected = false;
          const code = (lastDisconnect?.error as DisconnectErr | undefined)?.output?.statusCode;
          void this.handleClose(code);
        }
      });

      sock.ev.on('messages.upsert', async ({ type, messages }) => {
        if (this.sock !== sock) return; // ignore events from a torn-down socket
        if (type !== 'notify') return;
        for (const m of messages) {
          if (m.key.fromMe) continue;
          try {
            await this.onMessage(sock, m);
          } catch (err) {
            logger.error({ err, jid: m.key.remoteJid }, 'onMessage handler threw');
          }
        }
      });
    } finally {
      this.starting = false;
    }
  }

  /**
   * Tear down the current socket, if any: remove its listeners first (so an
   * event still in flight from a torn-down socket — e.g. a stale
   * creds.update — can never run stale logic over a fresher socket's state),
   * then end the connection. Also clears latestQR — a QR is bound to the
   * connection attempt that produced it, so it's never valid for whatever
   * socket comes next. Safe to call when there's no socket yet.
   */
  private teardownSocket(): void {
    if (!this.sock) return;
    const sock = this.sock;
    try {
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
    } catch {
      /* best-effort */
    }
    try {
      sock.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
    this.latestQR = null;
  }

  /**
   * Force a fresh socket + QR — used by POST /api/whatsapp/restart when an
   * operator needs to re-pair (e.g. an expired QR, or switching WhatsApp
   * accounts). Composes with the existing reconnect/backoff logic instead of
   * duplicating it: resetting `stopped`/`reconnectAttempts` lets a gateway
   * that had previously given up (e.g. after a `forbidden` disconnect) try
   * again, and start()'s own teardown-then-connect plus its `starting`
   * re-entrancy guard are reused as-is, so a manual restart can never race a
   * concurrent automatic reconnect into a double-socket state.
   */
  async restart(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    await this.start();
  }

  private async handleClose(code: number | undefined): Promise<void> {
    if (this.stopped) return;

    if (code === DisconnectReason.forbidden) {
      logger.fatal('🚫 WhatsApp returned FORBIDDEN — the account may be banned. Stopping reconnects.');
      this.stopped = true;
      return;
    }

    if (code === DisconnectReason.loggedOut) {
      logger.warn('WhatsApp logged out (device removed). Clearing auth — a new QR will appear.');
      await this.clearState?.();
      this.reconnectAttempts = 0;
      this.scheduleReconnect(1000);
      return;
    }

    if (code === DisconnectReason.restartRequired) {
      logger.info('Restart required (normal after QR scan) — recreating socket.');
      this.scheduleReconnect(500);
      return;
    }

    // connectionClosed / connectionLost / timedOut / badSession / etc → backoff.
    const delay = Math.min(30_000, 2 ** this.reconnectAttempts * 1000);
    this.reconnectAttempts += 1;
    logger.warn({ code, delay }, 'Connection closed — reconnecting with backoff.');
    this.scheduleReconnect(delay);
  }

  /** Schedule a single reconnect; dedupes overlapping 'close' events during a flap. */
  private scheduleReconnect(delay: number): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
  }

  async send(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    return this.sock.sendMessage(jid, content);
  }

  async sendText(jid: string, text: string): Promise<string | null> {
    const sent = await this.send(jid, { text });
    return sent?.key?.id ?? null;
  }

  /** Show "typing…" for a moment to feel human, then stop. */
  async indicateTyping(jid: string, ms = 1200): Promise<void> {
    try {
      await this.sock?.presenceSubscribe(jid);
      await this.sock?.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, ms));
      await this.sock?.sendPresenceUpdate('paused', jid);
    } catch {
      // presence is best-effort
    }
  }
}
