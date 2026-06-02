import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { downloadToTemp, cleanTemp } from '../../src/utils/media.js';
import { aliasCache } from '../../src/store.js';
import { __test_isSenderOnlyForwardCaption } from '../../src/telegram/handler.js';

const testRoot = path.join(os.tmpdir(), `zalo-tg-media-test-${process.pid}`);
const dataDir = path.join(testRoot, 'bot-api-data');

describe('downloadToTemp local Bot API file paths', () => {
  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    process.env.TGBOTAPI_DATA_DIR = dataDir;
    aliasCache.setAll([]);
  });

  afterEach(() => {
    delete process.env.TGBOTAPI_DATA_DIR;
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('remaps container /var/lib/telegram-bot-api file:// path to host data dir', async () => {
    const suffix = path.join('123456:token', 'documents', 'file_0.pdf');
    const hostPath = path.join(dataDir, suffix);
    mkdirSync(path.dirname(hostPath), { recursive: true });
    writeFileSync(hostPath, 'pdf-bytes');

    const containerPath = `/var/lib/telegram-bot-api/${suffix}`;
    const tempPath = await downloadToTemp(pathToFileURL(containerPath).toString(), 'Bao cao.pdf');

    expect(existsSync(tempPath)).toBe(true);
    expect(existsSync(hostPath)).toBe(false);
    await cleanTemp(tempPath);
  });
});

describe('forwarded bridge media captions', () => {
  beforeEach(() => {
    aliasCache.setAll([]);
  });

  it('strips self/sender-only captions instead of forwarding "Bạn" as real text', () => {
    expect(__test_isSenderOnlyForwardCaption('Bạn', undefined)).toBe(true);
    expect(__test_isSenderOnlyForwardCaption('👤 Bạn:', undefined)).toBe(true);
  });

  it('strips known contact-name captions but keeps real captions', () => {
    aliasCache.setAll([{ userId: 'u1', alias: 'Lê Mạnh Hùng' }]);
    expect(__test_isSenderOnlyForwardCaption('Lê Mạnh Hùng', undefined)).toBe(true);
    expect(__test_isSenderOnlyForwardCaption('🔵 Lê Mạnh Hùng:', undefined)).toBe(true);
    expect(__test_isSenderOnlyForwardCaption('Báo giá rãnh loại 7,8', undefined)).toBe(false);
  });
});
