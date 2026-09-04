import { describe, expect, it } from 'vitest';
import {
  ZALO_ATTACHMENT_TIMEOUT_MAX_MS,
  ZALO_SEND_TIMEOUT_MS,
  attachmentTimeoutMs,
  isTimeoutError,
} from '../../src/utils/sendTimeout.js';

describe('attachmentTimeoutMs', () => {
  it('keeps the 90s floor for small/unknown sizes', () => {
    expect(attachmentTimeoutMs(undefined)).toBe(ZALO_SEND_TIMEOUT_MS);
    expect(attachmentTimeoutMs(0)).toBe(ZALO_SEND_TIMEOUT_MS);
    expect(attachmentTimeoutMs(-5)).toBe(ZALO_SEND_TIMEOUT_MS);
    // 10 MB → 90s + 10*2s = 110s
    expect(attachmentTimeoutMs(10 * 1024 * 1024)).toBe(110_000);
  });

  it('scales with size for heavy files', () => {
    // 100 MB → 90s + 200s = 290s
    expect(attachmentTimeoutMs(100 * 1024 * 1024)).toBe(290_000);
  });

  it('caps at the 30-minute maximum', () => {
    expect(attachmentTimeoutMs(2 * 1024 * 1024 * 1024)).toBe(ZALO_ATTACHMENT_TIMEOUT_MAX_MS);
  });
});

describe('isTimeoutError', () => {
  it('detects withZaloTimeout guard errors only', () => {
    expect(isTimeoutError(new Error('Timeout after 90000ms: sendVideo(x)'))).toBe(true);
    expect(isTimeoutError(new Error('Timeout after 90115ms: sendMediaGroup(3 files)'))).toBe(true);
    expect(isTimeoutError(new Error('Request failed with status code 500'))).toBe(false);
    expect(isTimeoutError(new Error('Timeout of 10000ms exceeded'))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError('Timeout after 90000ms')).toBe(false);
  });
});
