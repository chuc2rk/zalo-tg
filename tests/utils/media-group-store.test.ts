import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaGroupStore, zaloAlbumStore, type ZaloQuoteData } from '../../src/store.js';

describe('mediaGroupStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a two-photo Telegram forward together when delivery is delayed', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const meta = { topicId: 7, zaloId: 'group-1', threadType: 1 as const };
    const onFlush = (items: Array<{ fileId: string }>) => flushed.push(items.map(item => item.fileId));

    mediaGroupStore.add('forward-album-1', { fileId: 'photo-1', fname: 'photo.jpg' }, meta, onFlush);
    vi.advanceTimersByTime(900);
    mediaGroupStore.add('forward-album-1', { fileId: 'photo-2', fname: 'photo.jpg' }, meta, onFlush);

    vi.advanceTimersByTime(1499);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([['photo-1', 'photo-2']]);
  });
});

describe('zaloAlbumStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves per-photo IDs and quote metadata instead of flattening the album', () => {
    vi.useFakeTimers();
    const flushed: Array<Array<{ url: string; msgIds: string[]; quoteMsgId: string }>> = [];
    const meta = {
      senderName: 'Alice',
      topicId: 7,
      tgBase: { message_thread_id: 7 },
    };
    const quote = (msgId: string): ZaloQuoteData => ({
      msgId, cliMsgId: `cli-${msgId}`, uidFrom: 'u1', ts: '1', msgType: 'photo',
      content: {}, ttl: 0, zaloId: 'group-1', threadType: 1,
    });
    const onFlush = (buf: { items: Array<{ url: string; msgIds: string[]; quote: ZaloQuoteData }> }) => {
      flushed.push(buf.items.map(item => ({
        url: item.url,
        msgIds: item.msgIds,
        quoteMsgId: item.quote.msgId,
      })));
    };

    zaloAlbumStore.add('album-per-item', { url: 'photo-1', msgIds: ['z1'], quote: quote('z1') }, meta, onFlush, 0);
    zaloAlbumStore.add('album-per-item', { url: 'photo-2', msgIds: ['z2'], quote: quote('z2') }, meta, onFlush, 1);
    vi.advanceTimersByTime(200);

    expect(flushed).toEqual([[
      { url: 'photo-1', msgIds: ['z1'], quoteMsgId: 'z1' },
      { url: 'photo-2', msgIds: ['z2'], quoteMsgId: 'z2' },
    ]]);
  });

  it('merges duplicate re-emit IDs only into the matching photo', () => {
    vi.useFakeTimers();
    const flushed: string[][][] = [];
    const meta = { senderName: 'Alice', topicId: 8, tgBase: { message_thread_id: 8 } };
    const quote: ZaloQuoteData = {
      msgId: 'z1', cliMsgId: 'c1', uidFrom: 'u1', ts: '1', msgType: 'photo',
      content: {}, ttl: 0, zaloId: 'group-1', threadType: 1,
    };

    zaloAlbumStore.add('album-dedupe', { url: 'same-photo', msgIds: ['z1'], quote }, meta, buf => flushed.push(buf.items.map(i => i.msgIds)), 0);
    zaloAlbumStore.add('album-dedupe', { url: 'same-photo', msgIds: ['z1-real'], quote }, meta, buf => flushed.push(buf.items.map(i => i.msgIds)), 0);
    vi.advanceTimersByTime(200);

    expect(flushed).toEqual([[['z1', 'z1-real']]]);
  });
});
