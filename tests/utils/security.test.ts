import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJson } from '../../src/utils/safeFile.js';
import { parseSafeHttpUrl, parseTrustedBankcardUrl, safeTelegramLinkHtml } from '../../src/utils/urlSafety.js';

const testRoot = path.join(os.tmpdir(), `zalo-tg-security-${process.pid}`);

afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

describe('safe URL rendering', () => {
  it('allows normal http(s) links and escapes Telegram HTML attributes', () => {
    expect(parseSafeHttpUrl('https://example.com/article?a=1&b=2')).not.toBeNull();
    expect(safeTelegramLinkHtml('https://example.com/article?a=1&b=2', '<Báo cáo>'))
      .toContain('<a href="https://example.com/article?a=1&amp;b=2">&lt;Báo cáo&gt;</a>');
  });

  it('rejects active schemes, credentials and private hosts', () => {
    expect(parseSafeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(parseSafeHttpUrl('data:text/html,x')).toBeNull();
    expect(parseSafeHttpUrl('https://user:pass@example.com/x')).toBeNull();
    expect(parseSafeHttpUrl('http://localhost/x')).toBeNull();
    expect(parseSafeHttpUrl('http://127.0.0.1/x')).toBeNull();
    expect(safeTelegramLinkHtml('javascript:alert(1)', 'Click')).not.toContain('<a ');
  });

  it('only permits trusted HTTPS Zalo hosts for bankcard server fetches', () => {
    expect(parseTrustedBankcardUrl('https://bankcard.zaloapp.com/x')).not.toBeNull();
    expect(parseTrustedBankcardUrl('https://sub.zalo.me/x')).not.toBeNull();
    expect(parseTrustedBankcardUrl('http://bankcard.zaloapp.com/x')).toBeNull();
    expect(parseTrustedBankcardUrl('https://zaloapp.com.evil.test/x')).toBeNull();
    expect(parseTrustedBankcardUrl('https://evil-zaloapp.com/x')).toBeNull();
    expect(parseTrustedBankcardUrl('https://zalo.me@evil.test/x')).toBeNull();
  });
});

describe('atomic private JSON writes', () => {
  it('writes valid JSON with owner-only permissions and replaces existing data', () => {
    mkdirSync(testRoot, { recursive: true });
    const file = path.join(testRoot, 'credentials.json');
    writeFileSync(file, '{"old":true}', { mode: 0o644 });

    atomicWriteJson(file, { session: 'new' });

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ session: 'new' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
