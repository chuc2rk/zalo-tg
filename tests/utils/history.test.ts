import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { ThreadType } from 'zca-js';
import { GroupHistoryCoordinator, messageTimestampMs, selectRecentHistory } from '../../src/zalo/history.js';
import type { ZaloMessage } from '../../src/zalo/types.js';

function message(threadId: string, msgId: string, ts: number): ZaloMessage {
  return {
    type: ThreadType.Group,
    threadId,
    isSelf: false,
    data: {
      content: `message-${msgId}`,
      msgId,
      uidFrom: 'u1',
      idTo: threadId,
      ts: String(ts),
      msgType: 'webchat',
    },
  };
}

function fakeApi() {
  const listener = Object.assign(new EventEmitter(), {
    requestOldMessages: vi.fn(),
  });
  return { listener };
}

describe('history timestamp safety', () => {
  it('normalizes second and millisecond timestamps', () => {
    expect(messageTimestampMs(message('g', 'seconds', 1_784_600_000))).toBe(1_784_600_000_000);
    expect(messageTimestampMs(message('g', 'millis', 1_784_600_000_123))).toBe(1_784_600_000_123);
  });

  it('selects only recent timestamped items and sorts oldest first', () => {
    const now = 1_784_600_000_000;
    const selected = selectRecentHistory([
      message('g', 'future', now + 120_000),
      message('g', 'newer', now - 1_000),
      message('g', 'missing', 0),
      message('g', 'older', now - 20_000),
      message('g', 'stale', now - 3_600_000),
    ], now, 60_000);
    expect(selected.map(item => item.data.msgId)).toEqual(['older', 'newer']);
  });
});

describe('GroupHistoryCoordinator', () => {
  it('collects only the requested group, deduplicates and requests the next page', async () => {
    const api = fakeApi();
    const coordinator = new GroupHistoryCoordinator();
    const pending = coordinator.request(api, 'target', 3, { timeoutMs: 1_000, maxPages: 3 });

    expect(api.listener.requestOldMessages).toHaveBeenCalledWith(ThreadType.Group);
    expect(coordinator.consume(api, [
      message('other', 'x', 400),
      message('target', 'b', 300),
      message('target', 'a', 200),
    ], ThreadType.Group)).toBe(true);
    expect(api.listener.requestOldMessages).toHaveBeenLastCalledWith(ThreadType.Group, 'a');

    coordinator.consume(api, [
      message('target', 'a', 200),
      message('target', 'c', 400),
    ], ThreadType.Group);

    await expect(pending).resolves.toMatchObject([
      { data: { msgId: 'a' } },
      { data: { msgId: 'b' } },
      { data: { msgId: 'c' } },
    ]);
  });

  it('does not consume unrelated DM old_messages and blocks concurrent requests', async () => {
    const api = fakeApi();
    const coordinator = new GroupHistoryCoordinator();
    const pending = coordinator.request(api, 'target', 1, { timeoutMs: 1_000 });
    await expect(coordinator.request(api, 'target', 1)).rejects.toThrow('Đang có một yêu cầu');
    expect(coordinator.consume(api, [message('target', 'dm', 100)], ThreadType.User)).toBe(false);
    coordinator.consume(api, [message('target', 'group', 200)], ThreadType.Group);
    await expect(pending).resolves.toMatchObject([{ data: { msgId: 'group' } }]);
  });

  it('finishes cleanly when Zalo returns an empty history page', async () => {
    const api = fakeApi();
    const coordinator = new GroupHistoryCoordinator();
    const pending = coordinator.request(api, 'target', 5, { timeoutMs: 1_000 });
    expect(coordinator.consume(api, [], ThreadType.Group)).toBe(true);
    await expect(pending).resolves.toEqual([]);
  });

  it('rejects a pending request when its listener session is replaced', async () => {
    const api = fakeApi();
    const coordinator = new GroupHistoryCoordinator();
    const pending = coordinator.request(api, 'target', 5, { timeoutMs: 1_000 });
    coordinator.cancel(api);
    await expect(pending).rejects.toThrow('Phiên Zalo đã được thay thế');
  });
});
