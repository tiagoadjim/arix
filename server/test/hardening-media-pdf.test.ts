import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const { downloadMediaMessage, spawnedChild, spawnMock } = vi.hoisted(() => {
  const spawnedChild = {
    kill: vi.fn(),
    on: vi.fn().mockReturnThis(),
  };
  return {
    downloadMediaMessage: vi.fn(),
    spawnedChild,
    spawnMock: vi.fn(() => spawnedChild),
  };
});

vi.mock('baileys', () => ({ downloadMediaMessage }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../src/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config', () => ({
  config: {
    MAX_MEDIA_BYTES: 1_024,
    MEDIA_DOWNLOAD_TIMEOUT_MS: 20,
    MAX_IMAGE_PIXELS: 1_000_000,
    MAX_IMAGE_DIMENSION: 2_000,
    MAX_PDF_BYTES: 1_024,
    PDF_TIMEOUT_MS: 5,
  },
}));

import { pdfFirstPageToPng } from '../src/pdf';
import { downloadMedia, isVisionImage, normalizeReceiptImage, sniffMediaMime } from '../src/whatsapp/media';
import type { proto, WAMessage, WASocket } from 'baileys';

const sock = { updateMediaMessage: vi.fn() } as unknown as WASocket;
const message = { key: { id: 'wa-1' } } as WAMessage;

beforeEach(() => {
  downloadMediaMessage.mockReset();
  spawnMock.mockClear();
  spawnedChild.kill.mockClear();
  spawnedChild.on.mockClear();
});

describe('WhatsApp media bounds', () => {
  it('rejects a declared oversized attachment before downloading it', async () => {
    const content = {
      imageMessage: { mimetype: 'image/jpeg', fileLength: 101 },
    } as unknown as proto.IMessage;

    await expect(downloadMedia(sock, message, content, 100)).resolves.toBeNull();
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('rejects an attachment that exceeds the bound despite a small declaration', async () => {
    downloadMediaMessage.mockResolvedValue(Buffer.alloc(101));
    const content = {
      imageMessage: { mimetype: 'image/png', fileLength: 10 },
    } as unknown as proto.IMessage;

    await expect(downloadMedia(sock, message, content, 100)).resolves.toBeNull();
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
  });

  it('returns a bounded attachment with its declared MIME for later byte sniffing', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    downloadMediaMessage.mockResolvedValue(png);
    const content = {
      imageMessage: { mimetype: 'image/png', fileLength: png.byteLength },
    } as unknown as proto.IMessage;

    await expect(downloadMedia(sock, message, content, 100)).resolves.toEqual({
      buffer: png,
      mime: 'image/png',
    });
  });

  it('aborts a media stream that stops producing bytes', async () => {
    const destroy = vi.fn();
    downloadMediaMessage.mockResolvedValue({
      destroy,
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    });
    const content = {
      imageMessage: { mimetype: 'image/png', fileLength: 10 },
    } as unknown as proto.IMessage;

    await expect(downloadMedia(sock, message, content, 100)).resolves.toBeNull();
    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ message: 'WhatsApp media download timed out' }));
  });

  it('bounds the initial media acquisition before a stream is returned', async () => {
    downloadMediaMessage.mockReturnValue(new Promise(() => {}));
    const content = {
      imageMessage: { mimetype: 'image/png', fileLength: 10 },
    } as unknown as proto.IMessage;

    await expect(downloadMedia(sock, message, content, 100)).resolves.toBeNull();
  });

  it('decodes and re-encodes a single bounded raster image as JPEG', async () => {
    const source = await sharp({
      create: { width: 32, height: 24, channels: 4, background: '#55aa77' },
    }).png().toBuffer();

    const normalized = await normalizeReceiptImage(source);

    expect(normalized?.mime).toBe('image/jpeg');
    expect(normalized?.buffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

describe('media signature sniffing', () => {
  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    [Buffer.from('GIF89a payload'), 'image/gif'],
    [Buffer.from('RIFF0000WEBP payload'), 'image/webp'],
    [Buffer.from('%PDF-1.7 payload'), 'application/pdf'],
  ])('recognizes trusted magic bytes as %s', (buffer, expected) => {
    expect(sniffMediaMime(buffer)).toBe(expected);
  });

  it('does not trust a filename, extension, or claimed MIME when magic bytes are absent', () => {
    expect(sniffMediaMime(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(isVisionImage('text/html')).toBe(false);
    expect(isVisionImage('IMAGE/PNG')).toBe(true);
  });
});

describe('PDF rasterization guardrails', () => {
  it('rejects malformed PDF bytes before spawning pdftoppm', async () => {
    await expect(pdfFirstPageToPng(Buffer.from('not a PDF'))).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects oversized PDFs before spawning pdftoppm', async () => {
    const oversized = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(1_020)]);
    await expect(pdfFirstPageToPng(oversized)).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('kills a hung pdftoppm process when the conversion deadline expires', async () => {
    await expect(pdfFirstPageToPng(Buffer.from('%PDF-1.7\n'))).resolves.toBeNull();

    expect(spawnMock).toHaveBeenCalledWith(
      'pdftoppm',
      expect.arrayContaining(['-f', '1', '-l', '1', '-singlefile']),
      { stdio: 'ignore' },
    );
    expect(spawnedChild.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
