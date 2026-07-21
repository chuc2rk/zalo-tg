import { ThreadType } from 'zca-js';
import type { ZaloAPI, ZaloMessage } from './types.js';

export function messageTimestampMs(message: ZaloMessage): number {
  const raw = Number(message?.data?.ts ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Some Zalo payloads use seconds, while current listener payloads use ms.
  return raw < 1_000_000_000_000 ? raw * 1_000 : raw;
}

/** Select an automatic catch-up window without allowing timestamp-less old data to flood Telegram. */
export function selectRecentHistory(
  messages: ZaloMessage[],
  nowMs: number,
  windowMs: number,
): ZaloMessage[] {
  return messages
    .filter(message => {
      const ts = messageTimestampMs(message);
      return ts > 0 && ts <= nowMs + 60_000 && nowMs - ts <= windowMs;
    })
    .sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b));
}

interface PendingHistoryRequest {
  api: ZaloAPI;
  groupId: string;
  count: number;
  pages: number;
  maxPages: number;
  messages: ZaloMessage[];
  seen: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (messages: ZaloMessage[]) => void;
  reject: (err: Error) => void;
}

/** Coordinates the listener's account-wide old_messages stream for one /history request at a time. */
export class GroupHistoryCoordinator {
  private pending: PendingHistoryRequest | null = null;

  cancel(api: ZaloAPI, reason = 'Phiên Zalo đã được thay thế.'): void {
    const req = this.pending;
    if (req && req.api === api) this.finish(req, new Error(reason));
  }

  request(
    api: ZaloAPI,
    groupId: string,
    count: number,
    options: { timeoutMs?: number; maxPages?: number } = {},
  ): Promise<ZaloMessage[]> {
    if (this.pending) return Promise.reject(new Error('Đang có một yêu cầu /history khác chạy.'));
    return new Promise<ZaloMessage[]>((resolve, reject) => {
      const req: PendingHistoryRequest = {
        api,
        groupId,
        count,
        pages: 0,
        maxPages: Math.max(1, options.maxPages ?? 5),
        messages: [],
        seen: new Set(),
        resolve,
        reject,
        timer: setTimeout(() => {
          if (req.messages.length > 0) this.finish(req);
          else this.finish(req, new Error('Zalo không trả dữ liệu lịch sử trong thời gian chờ.'));
        }, options.timeoutMs ?? 20_000),
      };
      this.pending = req;
      try {
        api.listener.requestOldMessages(ThreadType.Group);
      } catch (err) {
        this.finish(req, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Returns true when the event belongs to an active manual history request. */
  consume(api: ZaloAPI, messages: ZaloMessage[], oldType: ThreadType): boolean {
    const req = this.pending;
    if (!req || req.api !== api || oldType !== ThreadType.Group) return false;
    req.pages += 1;

    for (const message of messages) {
      if (String(message.threadId) !== req.groupId) continue;
      const id = String(message.data?.msgId ?? `${message.data?.ts}:${req.messages.length}`);
      if (req.seen.has(id)) continue;
      req.seen.add(id);
      req.messages.push(message);
    }

    if (req.messages.length >= req.count || req.pages >= req.maxPages || messages.length === 0) {
      this.finish(req);
      return true;
    }

    const oldest = [...messages].sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b))[0];
    const lastMsgId = oldest?.data?.msgId ? String(oldest.data.msgId) : null;
    if (!lastMsgId) {
      this.finish(req);
      return true;
    }

    try {
      api.listener.requestOldMessages(ThreadType.Group, lastMsgId);
    } catch (err) {
      this.finish(req, err instanceof Error ? err : new Error(String(err)));
    }
    return true;
  }

  private finish(req: PendingHistoryRequest, err?: Error): void {
    if (this.pending !== req) return;
    clearTimeout(req.timer);
    this.pending = null;
    if (err) {
      req.reject(err);
      return;
    }
    const newest = [...req.messages]
      .sort((a, b) => messageTimestampMs(b) - messageTimestampMs(a))
      .slice(0, req.count)
      .sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b));
    req.resolve(newest);
  }
}
