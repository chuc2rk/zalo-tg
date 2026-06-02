import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { downloadToTemp, cleanTemp } from '../../src/utils/media.js';

const testRoot = path.join(os.tmpdir(), `zalo-tg-media-test-${process.pid}`);
const dataDir = path.join(testRoot, 'bot-api-data');

describe('downloadToTemp local Bot API file paths', () => {
  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    process.env.TGBOTAPI_DATA_DIR = dataDir;
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
