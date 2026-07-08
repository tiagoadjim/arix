import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger';

/**
 * Render the first page of a PDF to a PNG buffer using poppler's `pdftoppm`.
 * Many customers send transfer receipts as PDFs; Minimax vision only reads
 * images, so we rasterize page 1. Returns null if poppler isn't available.
 */
export async function pdfFirstPageToPng(pdf: Buffer): Promise<Buffer | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'arix-pdf-'));
    const pdfPath = join(dir, 'in.pdf');
    const outPrefix = join(dir, 'out');
    await writeFile(pdfPath, pdf);
    // -singlefile → output is exactly "<prefix>.png" (no page-number suffix).
    await run('pdftoppm', ['-png', '-f', '1', '-l', '1', '-r', '150', '-singlefile', pdfPath, outPrefix]);
    return await readFile(`${outPrefix}.png`);
  } catch (err) {
    logger.warn({ err }, 'pdftoppm failed — is poppler-utils installed?');
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}
