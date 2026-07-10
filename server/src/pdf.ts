import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger';
import { config } from './config';

/**
 * Render the first page of a PDF to a PNG buffer using poppler's `pdftoppm`.
 * Many customers send transfer receipts as PDFs; every vision-capable LLM
 * provider's chat-completions image_url only reads images, so we rasterize
 * page 1. Returns null if poppler isn't available.
 */
export async function pdfFirstPageToPng(pdf: Buffer): Promise<Buffer | null> {
  let dir: string | null = null;
  try {
    if (pdf.byteLength > config.MAX_PDF_BYTES || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
      logger.warn({ bytes: pdf.byteLength }, 'refusing invalid or oversized PDF receipt');
      return null;
    }
    dir = await mkdtemp(join(tmpdir(), 'arix-pdf-'));
    const pdfPath = join(dir, 'in.pdf');
    const outPrefix = join(dir, 'out');
    await writeFile(pdfPath, pdf);
    // -singlefile → output is exactly "<prefix>.png" (no page-number suffix).
    await run(
      'pdftoppm',
      ['-png', '-f', '1', '-l', '1', '-r', '120', '-scale-to', '2048', '-singlefile', pdfPath, outPrefix],
      config.PDF_TIMEOUT_MS,
    );
    const output = await readFile(`${outPrefix}.png`);
    if (output.byteLength > config.MAX_MEDIA_BYTES) {
      logger.warn({ bytes: output.byteLength }, 'discarding oversized rasterized PDF receipt');
      return null;
    }
    return output;
  } catch (err) {
    logger.warn({ err }, 'pdftoppm failed — is poppler-utils installed?');
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'ignore' });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, Math.max(1, timeoutMs));
    timer.unref();
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => finish(code === 0 ? undefined : new Error(`${cmd} exited ${code}`)));
  });
}
