/**
 * Zalo send timeout helpers (dependency-free so they stay unit-testable).
 *
 * Large attachments need proportionally longer guards: a fixed 90s timeout
 * makes heavy albums/videos falsely fail while Zalo may still deliver them
 * late — producing ghost duplicates on both sides.
 */

export const ZALO_SEND_TIMEOUT_MS = 90_000;
export const ZALO_ATTACHMENT_TIMEOUT_MAX_MS = 30 * 60_000;

export function attachmentTimeoutMs(fileSize?: number): number {
  if (!fileSize || fileSize <= 0) return ZALO_SEND_TIMEOUT_MS;
  const sizeMb = fileSize / 1024 / 1024;
  // Keep normal sends protected by the 90s guard, but allow very large
  // files enough time to upload to Zalo. Example: 800 MB gets ~27 minutes.
  return Math.min(ZALO_ATTACHMENT_TIMEOUT_MAX_MS, Math.max(ZALO_SEND_TIMEOUT_MS, ZALO_SEND_TIMEOUT_MS + sizeMb * 2_000));
}

/**
 * True when a withZaloTimeout guard fired. The underlying Zalo call may
 * STILL complete late on the server — callers must not blindly retry or
 * fall back to another send path, or the file lands on Zalo twice.
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Timeout after');
}
