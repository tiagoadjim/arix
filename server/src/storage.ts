import { mkdir, writeFile, readFile, readdir, stat, unlink, rmdir } from 'node:fs/promises';
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

export async function cleanupExpiredReceipts(now = Date.now()): Promise<number> {
  const retentionDays = config.RECEIPT_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (full !== ROOT && !full.startsWith(ROOT + sep)) continue;
      if (entry.isDirectory()) {
        await walk(full);
        await rmdir(full).catch(() => {});
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null);
        if (info && info.mtimeMs < cutoff) {
          await unlink(full).catch(() => {});
          removed += 1;
        }
      }
    }
  };
  await walk(ROOT);
  if (removed > 0) logger.info({ removed, retentionDays }, 'expired receipt files removed');
  return removed;
}

export function startReceiptCleanup(): () => void {
  void cleanupExpiredReceipts().catch((err) => logger.warn({ err }, 'receipt retention cleanup failed'));
  const timer = setInterval(
    () => void cleanupExpiredReceipts().catch((err) => logger.warn({ err }, 'receipt retention cleanup failed')),
    24 * 60 * 60 * 1000,
  );
  timer.unref();
  return () => clearInterval(timer);
}
