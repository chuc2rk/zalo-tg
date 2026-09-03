import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { gzipSync } from 'zlib';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import { convertTgsToGif, convertSpriteSheetToGif, getSpriteSheetLayout, downloadToTemp, cleanTemp } from '../../src/utils/media.js';
import { aliasCache } from '../../src/store.js';
import {
  __test_getExplicitReplyTarget,
  __test_isExplicitTelegramForward,
  __test_isSenderOnlyForwardCaption,
  __test_stripBridgeForwardedTextHeader,
} from '../../src/telegram/handler.js';

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
    expect(existsSync(hostPath)).toBe(true);
    expect(readFileSync(hostPath, 'utf8')).toBe('pdf-bytes');
    const secondTempPath = await downloadToTemp(pathToFileURL(containerPath).toString(), 'Bao cao.pdf');
    expect(existsSync(secondTempPath)).toBe(true);
    await cleanTemp(tempPath);
    await cleanTemp(secondTempPath);
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
    expect(__test_isSenderOnlyForwardCaption('🟪◆ Lê Mạnh Hùng:', undefined)).toBe(true);
    expect(__test_isSenderOnlyForwardCaption('━━━━━━━━\nLê Mạnh Hùng:', undefined)).toBe(true);
    expect(__test_isSenderOnlyForwardCaption('Báo giá rãnh loại 7,8', undefined)).toBe(false);
  });

  it('strips bridge sender header when forwarding text messages', () => {
    const stripped = __test_stripBridgeForwardedTextHeader('🟪◆ BẠN\n━━━━━━━━\nNội dung cần gửi');
    expect(stripped).toEqual({ text: 'Nội dung cần gửi', stripped: true });
  });

  it('recognizes the detached person footer as bridge sender metadata', () => {
    expect(__test_isSenderOnlyForwardCaption('└── 👤 🟪◆  BẠN', undefined)).toBe(true);
  });

  it('keeps normal multi-line text intact', () => {
    const kept = __test_stripBridgeForwardedTextHeader('Bạn ơi\n━━━━━━━━\nkhông phải header bridge');
    expect(kept).toEqual({ text: 'Bạn ơi\n━━━━━━━━\nkhông phải header bridge', stripped: false });
  });

  it('does not turn Telegram forwards or the forum topic root into Zalo quotes', () => {
    expect(__test_isExplicitTelegramForward({ forward_origin: { type: 'user' } })).toBe(true);
    expect(__test_isExplicitTelegramForward({ forward_date: 1_784_553_600 })).toBe(true);
    expect(__test_getExplicitReplyTarget({
      forward_origin: { type: 'user' },
      reply_to_message: { message_id: 9001 },
    }, 7000)).toBeUndefined();
    expect(__test_getExplicitReplyTarget({
      reply_to_message: { message_id: 7000, is_topic_message: true },
    }, 7000)).toBeUndefined();
    expect(__test_getExplicitReplyTarget({
      reply_to_message: { message_id: 6999, is_topic_message: true },
    }, 7000)).toBe(6999);
  });
});

describe('Telegram sticker rendering', () => {
  it('renders TGS/Lottie frames into a GIF', async () => {
    mkdirSync(testRoot, { recursive: true });
    const tgsPath = path.join(testRoot, 'sticker.tgs');
    const lottie = {
      v: '5.7.4', fr: 10, ip: 0, op: 2, w: 32, h: 32, nm: 'test', ddd: 0, assets: [],
      layers: [{
        ddd: 0, ind: 1, ty: 4, nm: 'dot', sr: 1,
        ks: {
          o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [16, 16, 0] },
          a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
        },
        shapes: [{
          ty: 'gr', nm: 'ellipse',
          it: [
            { d: 1, ty: 'el', s: { a: 0, k: [20, 20] }, p: { a: 0, k: [0, 0] } },
            { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1 },
            { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } },
          ],
        }],
        ip: 0, op: 2, st: 0, bm: 0,
      }],
    };
    writeFileSync(tgsPath, gzipSync(JSON.stringify(lottie)));
    const gifPath = await convertTgsToGif(tgsPath);
    expect(readFileSync(gifPath).subarray(0, 6).toString('ascii')).toBe('GIF89a');
    await cleanTemp(gifPath);
    rmSync(testRoot, { recursive: true, force: true });
  });
});

describe('Zalo animated sticker rendering', () => {
  it('resolves horizontal and vertical sprite strips', () => {
    expect(getSpriteSheetLayout(96, 32, 3)).toEqual({
      frames: 3, frameWidth: 32, frameHeight: 32, direction: 'horizontal',
    });
    expect(getSpriteSheetLayout(32, 96, 3)).toEqual({
      frames: 3, frameWidth: 32, frameHeight: 32, direction: 'vertical',
    });
  });

  it('converts a sprite sheet into an animated GIF', async () => {
    mkdirSync(testRoot, { recursive: true });
    const spritePath = path.join(testRoot, 'zalo-sprite.png');
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(96, 32);
    const ctx = canvas.getContext('2d');
    for (const [index, color] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
      ctx.fillStyle = color;
      ctx.fillRect(index * 32, 0, 32, 32);
    }
    writeFileSync(spritePath, canvas.toBuffer('image/png'));

    const gifPath = await convertSpriteSheetToGif(spritePath, 3, 100);
    expect(readFileSync(gifPath).subarray(0, 6).toString('ascii')).toBe('GIF89a');
    await cleanTemp(gifPath);
    rmSync(testRoot, { recursive: true, force: true });
  });
});
