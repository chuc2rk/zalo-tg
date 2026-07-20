import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaGroupStore } from '../../src/store.js';

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
