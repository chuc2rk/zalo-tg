import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function runStoreScript(dataDir: string, script: string): string {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        TG_TOKEN: process.env.TG_TOKEN || 'test-token',
        TG_GROUP_ID: process.env.TG_GROUP_ID || '-1001234567890',
      },
    },
  ).trim();
  return output.split('\n').at(-1) ?? '';
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sentMsgStore restart persistence', () => {
  it('restores TG→Zalo reverse lookup after a fresh process starts', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'zalo-tg-sent-store-'));
    tempDirs.push(dataDir);

    runStoreScript(dataDir, `
      const { sentMsgStore, flushStores } = await import('./src/store.ts');
      sentMsgStore.save(71234, {
        msgIds: ['zalo-global-1', 'zalo-cli-1'],
        zaloId: 'group-42',
        threadType: 1,
      });
      flushStores();
    `);

    const restored = runStoreScript(dataDir, `
      const { sentMsgStore } = await import('./src/store.ts');
      console.log(JSON.stringify({
        global: sentMsgStore.getByZaloMsgId('zalo-global-1'),
        cli: sentMsgStore.getByZaloMsgId('zalo-cli-1'),
        info: sentMsgStore.get(71234),
      }));
    `);

    expect(JSON.parse(restored)).toEqual({
      global: 71234,
      cli: 71234,
      info: {
        msgIds: ['zalo-global-1', 'zalo-cli-1'],
        zaloId: 'group-42',
        threadType: 1,
      },
    });
  });

  it('does not persist synthetic auto-reply IDs as Telegram reply targets', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'zalo-tg-sent-store-'));
    tempDirs.push(dataDir);

    runStoreScript(dataDir, `
      const { sentMsgStore, flushStores } = await import('./src/store.ts');
      sentMsgStore.save(-1, { msgIds: ['auto-reply-1'], zaloId: 'dm-1', threadType: 0 });
      flushStores();
    `);

    const restored = runStoreScript(dataDir, `
      const { sentMsgStore } = await import('./src/store.ts');
      console.log(JSON.stringify({
        reverse: sentMsgStore.getByZaloMsgId('auto-reply-1') ?? null,
        entries: sentMsgStore.stats().entries,
      }));
    `);

    expect(JSON.parse(restored)).toEqual({ reverse: null, entries: 0 });
  });
});
