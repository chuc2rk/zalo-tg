import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * Atomically write JSON while keeping private runtime/session data owner-only.
 * The temporary file is created beside the target so rename remains atomic.
 */
export function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'wx', mode);
    writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
    chmodSync(filePath, mode);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** Tighten an existing secret file without failing startup on unsupported FSes. */
export function ensurePrivateFileMode(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch (err) {
    console.warn(`[Security] Could not set private permissions on ${filePath}:`, err);
  }
}
