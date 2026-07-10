import { downloadMediaMessage, type WAMessage, type WASocket, type proto } from 'baileys';
import { logger } from '../logger';
import { config } from '../config';
import sharp from 'sharp';

/**
 * Download the media of a WhatsApp message as a Buffer. Returns null on failure.
 * `content` must be the UNWRAPPED message content (ephemeral/view-once peeled),
 * so the MIME type is read correctly — otherwise wrapped images resolve to
 * application/octet-stream and get dropped from vision.
 */
export async function downloadMedia(
  sock: WASocket,
  msg: WAMessage,
  content: proto.IMessage | null | undefined,
  maxBytes = config.MAX_MEDIA_BYTES,
): Promise<{ buffer: Buffer; mime: string } | null> {
  try {
    const mime =
      content?.imageMessage?.mimetype ??
      content?.documentMessage?.mimetype ??
      content?.stickerMessage?.mimetype ??
      content?.videoMessage?.mimetype ??
      'application/octet-stream';

    const declared =
      content?.imageMessage?.fileLength ??
      content?.documentMessage?.fileLength ??
      content?.stickerMessage?.fileLength ??
      content?.videoMessage?.fileLength;
    const declaredBytes = declared == null ? null : Number(String(declared));
    if (declaredBytes !== null && Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      logger.warn({ declaredBytes, maxBytes }, 'refusing oversized WhatsApp media before download');
      return null;
    }

    // Ask Baileys for a stream and enforce the cap while bytes arrive. A
    // post-download buffer length check is too late for a dishonest/missing
    // fileLength: the process may already have exhausted its heap.
    const controller = new AbortController();
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timeoutError = new Error('WhatsApp media download timed out');
    let timedOut = false;
    let activeStream: { destroy?: (error?: Error) => void } | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      activeStream?.destroy?.(timeoutError);
      rejectDeadline(timeoutError);
    }, config.MEDIA_DOWNLOAD_TIMEOUT_MS);
    timer.unref();

    const acquisition = downloadMediaMessage(
      msg,
      'stream',
      { options: { signal: controller.signal } },
      {
        logger: logger as never,
        reuploadRequest: sock.updateMediaMessage,
      },
    ) as Promise<unknown>;
    // If the underlying library does not observe AbortSignal until after its
    // HTTP handshake, destroy any stream that arrives after our caller's
    // deadline instead of leaking a background download.
    void acquisition.then((late) => {
      if (timedOut) (late as { destroy?: (error?: Error) => void }).destroy?.(timeoutError);
    }, () => undefined);
    try {
      const downloaded = await Promise.race([acquisition, deadline]);
      const chunks: Buffer[] = [];
      let bytes = 0;
      const stream = downloaded as AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void };
      activeStream = stream;
      const source: AsyncIterable<Uint8Array> = Buffer.isBuffer(downloaded)
        ? (async function* () { yield downloaded; })()
        : stream;
      const iterator = source[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) break;
        const chunk = next.value;
        const part = Buffer.from(chunk);
        bytes += part.byteLength;
        if (bytes > maxBytes) {
          stream.destroy?.(new Error('WhatsApp media exceeds configured limit'));
          logger.warn({ bytes, maxBytes }, 'discarding oversized WhatsApp media while streaming');
          return null;
        }
        chunks.push(part);
      }
      return { buffer: Buffer.concat(chunks, bytes), mime };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  } catch (err) {
    logger.error({ err }, 'failed to download media');
    return null;
  }
}

/** Raster image formats accepted as a vision content part by every
 * vision-capable provider in the registry (see agent/llm/providers.ts). */
const VISION_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);

export function isVisionImage(mime: string): boolean {
  return VISION_MIMES.has(mime.toLowerCase());
}

export function sniffMediaMime(buffer: Buffer): string | null {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head6 = buffer.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

/** Decode untrusted raster input under a hard pixel ceiling and re-encode a
 * single, bounded JPEG. This removes oversized dimensions, animation/frame
 * bombs and malformed compressed payloads before storage, base64/LLM use or
 * browser rendering. */
export async function normalizeReceiptImage(buffer: Buffer): Promise<{ buffer: Buffer; mime: 'image/jpeg' } | null> {
  try {
    const image = sharp(buffer, {
      failOn: 'warning',
      limitInputPixels: config.MAX_IMAGE_PIXELS,
      pages: 1,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (
      width <= 0 ||
      height <= 0 ||
      width > config.MAX_IMAGE_DIMENSION ||
      height > config.MAX_IMAGE_DIMENSION ||
      width * height > config.MAX_IMAGE_PIXELS
    ) {
      logger.warn({ width, height }, 'discarding receipt image with unsafe dimensions');
      return null;
    }
    const normalized = await image
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90, progressive: true })
      .toBuffer();
    if (normalized.byteLength > config.MAX_MEDIA_BYTES) {
      logger.warn({ bytes: normalized.byteLength }, 'discarding oversized normalized receipt image');
      return null;
    }
    return { buffer: normalized, mime: 'image/jpeg' };
  } catch (err) {
    logger.warn({ errorType: err instanceof Error ? err.name : typeof err }, 'discarding undecodable receipt image');
    return null;
  }
}
