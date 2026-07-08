import { downloadMediaMessage, type WAMessage, type WASocket, type proto } from 'baileys';
import { logger } from '../logger';

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
): Promise<{ buffer: Buffer; mime: string } | null> {
  try {
    const mime =
      content?.imageMessage?.mimetype ??
      content?.documentMessage?.mimetype ??
      content?.stickerMessage?.mimetype ??
      content?.videoMessage?.mimetype ??
      'application/octet-stream';

    // downloadMediaMessage unwraps the envelope internally to fetch the bytes.
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: logger as never,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    return { buffer, mime };
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
