import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve, normalize, sep } from 'node:path';
import { config } from './config';
import { logger } from './logger';

const ROOT = resolve(config.RECEIPTS_DIR);

// Prevent path traversal: keep everything under ROOT.
function safeJoin(objectPath: string): string {
  const full = resolve(ROOT, normalize(objectPath).replace(/^([.][.][/\\])+/, ''));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) throw new Error('invalid object path');
  return full;
}

/** Save a receipt image under RECEIPTS_DIR. Returns the relative path (media_url) or null. */
export async function saveReceiptImage(buffer: Buffer, objectPath: string): Promise<string | null> {
  try {
    const full = safeJoin(objectPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return objectPath;
  } catch (err) {
    logger.error({ err, objectPath }, 'failed to save receipt image');
    return null;
  }
}

/** Read a stored receipt image (for the authenticated /api/media endpoint). */
export async function readReceiptImage(objectPath: string): Promise<Buffer | null> {
  try {
    return await readFile(safeJoin(objectPath));
  } catch {
    return null;
  }
}
