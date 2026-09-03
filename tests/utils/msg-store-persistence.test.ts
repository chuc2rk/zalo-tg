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

describe('msgStore restart persistence', () => {
  it('restores text quote propertyExt needed by zca-js native quote attachments', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'zalo-tg-msg-store-'));
    tempDirs.push(dataDir);

    runStoreScript(dataDir, `
      const { msgStore, flushStores } = await import('./src/store.ts');
      msgStore.save(81234, ['zalo-text-1'], {
        msgId: 'zalo-text-1',
        cliMsgId: 'zalo-cli-1',
        uidFrom: 'owner-1',
        ts: '1786660000000',
        msgType: 'webchat',
        content: 'Nội dung có định dạng',
        ttl: 0,
        propertyExt: { color: 1, size: 2, type: 3, subType: 4, ext: '{"styles":[]}' },
        zaloId: 'group-42',
        threadType: 1,
      });
      flushStores();
    `);

    const restored = runStoreScript(dataDir, `
      const { msgStore } = await import('./src/store.ts');
      console.log(JSON.stringify({
        globalReplyTarget: msgStore.getTgMsgId('zalo-text-1') ?? null,
        cliReplyTarget: msgStore.getTgMsgId('zalo-cli-1') ?? null,
        propertyExt: msgStore.getQuote(81234)?.propertyExt ?? null,
      }));
    `);

    expect(JSON.parse(restored)).toEqual({
      globalReplyTarget: 81234,
      cliReplyTarget: 81234,
      propertyExt: {
        color: 1,
        size: 2,
        type: 3,
        subType: 4,
        ext: '{"styles":[]}',
      },
    });
  });

  it('keeps an older rich file quote after more than the former 10k-ID limit', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'zalo-tg-msg-store-'));
    tempDirs.push(dataDir);

    runStoreScript(dataDir, `
      const { msgStore, flushStores } = await import('./src/store.ts');
      msgStore.save(95118, ['file-global', 'file-cli'], {
        msgId: 'file-global',
        cliMsgId: 'file-cli',
        uidFrom: 'sender-1',
        ts: '1786660000000',
        msgType: 'share.file',
        content: { title: 'Mau hop dong.docx', href: 'https://example.invalid/file' },
        ttl: 0,
        zaloId: 'dm-hai-khkt',
        threadType: 0,
      });
      for (let i = 0; i < 6000; i++) {
        msgStore.save(100000 + i, ['global-' + i, 'cli-' + i], {
          msgId: 'global-' + i,
          cliMsgId: 'cli-' + i,
          uidFrom: 'sender-2',
          ts: String(1786660000001 + i),
          msgType: 'webchat',
          content: 'message ' + i,
          ttl: 0,
          zaloId: 'busy-group',
          threadType: 1,
        });
      }
      flushStores();
      console.log(JSON.stringify({
        globalReplyTarget: msgStore.getTgMsgId('file-global') ?? null,
        cliReplyTarget: msgStore.getTgMsgId('file-cli') ?? null,
        quoteType: msgStore.getQuote(95118)?.msgType ?? null,
      }));
    `);

    const restored = runStoreScript(dataDir, `
      const { msgStore } = await import('./src/store.ts');
      console.log(JSON.stringify({
        globalReplyTarget: msgStore.getTgMsgId('file-global') ?? null,
        cliReplyTarget: msgStore.getTgMsgId('file-cli') ?? null,
        quoteType: msgStore.getQuote(95118)?.msgType ?? null,
      }));
    `);

    expect(JSON.parse(restored)).toEqual({
      globalReplyTarget: 95118,
      cliReplyTarget: 95118,
      quoteType: 'share.file',
    });
  });
});
