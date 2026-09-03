/**
 * Pure helpers for mirroring Zalo group board items (notes, pins, reminders)
 * into Telegram topics (read-only Zalo → Telegram direction).
 *
 * Kept free of I/O on purpose so every branch below is unit-testable:
 * Zalo board payloads are inconsistent in the wild (params may be an object
 * or a JSON string, and two different enums describe the same item kinds).
 *
 * Enum references (from zca-js models):
 * - params.boardType: 1 = Note, 2 = PinnedMessage, 3 = Poll
 * - groupTopic.type (GroupTopicType): 0 = Note, 2 = Message, 3 = Poll
 */

export type BoardMirrorKind = 'note' | 'pin' | 'poll' | 'unknown';

export interface BoardMirrorItem {
  kind: BoardMirrorKind;
  /** Stable board item id (topic id / note id), '' when Zalo omits it. */
  id: string;
  title: string;
  creatorId: string;
}

/** Parse board params that may arrive as an object or a JSON string. */
export function parseBoardParams(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Classify a groupTopic-like object ({ type, params, id, creatorId }) into a
 * mirrorable board item. Returns null when there is nothing worth mirroring
 * (e.g. polls — handled by the poll pipeline — or empty titles).
 */
export function extractBoardMirror(groupTopic: {
  type?: unknown;
  params?: unknown;
  id?: unknown;
  creatorId?: unknown;
} | null | undefined): BoardMirrorItem | null {
  if (!groupTopic || typeof groupTopic !== 'object') return null;
  const params = parseBoardParams(groupTopic.params) ?? {};
  const boardType = typeof params.boardType === 'number' ? params.boardType : undefined;
  const topicType = typeof groupTopic.type === 'number' ? groupTopic.type : undefined;

  let kind: BoardMirrorKind = 'unknown';
  if (boardType === 1 || topicType === 0) kind = 'note';
  else if (boardType === 2 || topicType === 2) kind = 'pin';
  else if (boardType === 3 || topicType === 3) kind = 'poll';

  // Polls already have a dedicated pipeline — never double-mirror them here.
  if (kind !== 'note' && kind !== 'pin') return null;

  const title =
    asNonEmptyString(params.title) ||
    asNonEmptyString((params as { msg?: unknown }).msg);
  if (!title) return null;

  return {
    kind,
    id: asNonEmptyString(groupTopic.id) || asNonEmptyString(params.pollId ?? (params as { topicId?: unknown }).topicId),
    title,
    creatorId: asNonEmptyString(groupTopic.creatorId) || asNonEmptyString(params.creatorId),
  };
}

/** Format a millisecond/second/numeric-string timestamp defensively. '' when unusable. */
export function formatZaloTimestamp(ts: unknown): string {
  let ms: number | null = null;
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    ms = ts < 1e12 ? ts * 1000 : ts;
  } else if (typeof ts === 'string' && ts.trim() !== '') {
    const num = Number(ts.trim());
    if (Number.isFinite(num) && num > 0) ms = num < 1e12 ? num * 1000 : num;
  }
  if (ms === null) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function repeatLabel(repeat: unknown): string {
  // ReminderRepeatMode: 0 = None, 1 = Daily, 2 = Weekly, 3 = Monthly
  if (repeat === 1) return 'hằng ngày';
  if (repeat === 2) return 'hằng tuần';
  if (repeat === 3) return 'hằng tháng';
  return '';
}

/** Escape text for Telegram HTML parse mode (local copy to keep this module dependency-free). */
function escapeHtmlLocal(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildBoardMirrorText(
  item: BoardMirrorItem,
  opts: { actorName?: string; removed?: boolean },
): string {
  const icon = item.kind === 'note' ? '📝' : '📌';
  const action = opts.removed ? 'đã gỡ' : 'mới';
  const actor = opts.actorName?.trim() ? ` — <b>${escapeHtmlLocal(opts.actorName.trim())}</b>` : '';
  return `${icon} <b>Ghi chú ${action}</b>${actor}\n${escapeHtmlLocal(item.title)}`;
}

export interface ReminderMirrorData {
  title: string;
  creatorName?: string;
  startTime?: unknown;
  repeat?: unknown;
}

/** Extract mirrorable fields from a remind_topic event data object. Null when empty. */
export function extractReminderMirror(data: Record<string, unknown> | null | undefined): ReminderMirrorData | null {
  if (!data || typeof data !== 'object') return null;
  const params = parseBoardParams((data as { params?: unknown }).params);
  const title =
    asNonEmptyString((data as { msg?: unknown }).msg) ||
    (params ? asNonEmptyString(params.title) : '');
  if (!title) return null;
  return {
    title,
    creatorName: asNonEmptyString((data as { creatorId?: unknown }).creatorId) ||
      asNonEmptyString((data as { editorId?: unknown }).editorId) || undefined,
    startTime: (data as { startTime?: unknown }).startTime,
    repeat: (data as { repeat?: unknown }).repeat,
  };
}

export function buildReminderMirrorText(reminder: ReminderMirrorData): string {
  const when = formatZaloTimestamp(reminder.startTime);
  const repeat = repeatLabel(reminder.repeat);
  const schedule = [when, repeat ? `lặp lại ${repeat}` : ''].filter(Boolean).join(' · ');
  const header = schedule ? `⏰ <b>Nhắc hẹn</b> — ${escapeHtmlLocal(schedule)}` : '⏰ <b>Nhắc hẹn</b>';
  return `${header}\n${escapeHtmlLocal(reminder.title)}`;
}

/** Bounded dedupe-key tracker for board mirror events (prevents re-emit spam). */
const BOARD_MIRROR_DEDUPE_TTL_MS = 10 * 60_000;
const BOARD_MIRROR_DEDUPE_MAX = 1000;
const _boardMirrorSeen = new Map<string, number>();

export function boardMirrorDedupeKey(parts: Array<string | number | undefined | null>): string {
  return parts.map(part => String(part ?? '')).join('|');
}

/** Returns true when this key was seen within TTL (i.e. caller should skip). */
export function boardMirrorSeen(key: string, now = Date.now()): boolean {
  const prev = _boardMirrorSeen.get(key);
  if (prev !== undefined && now - prev < BOARD_MIRROR_DEDUPE_TTL_MS) return true;
  _boardMirrorSeen.set(key, now);
  if (_boardMirrorSeen.size > BOARD_MIRROR_DEDUPE_MAX) {
    const oldest = [..._boardMirrorSeen.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) _boardMirrorSeen.delete(oldest[0]);
  }
  // Opportunistic expiry sweep.
  if (_boardMirrorSeen.size % 100 === 0) {
    for (const [k, ts] of _boardMirrorSeen) {
      if (now - ts >= BOARD_MIRROR_DEDUPE_TTL_MS) _boardMirrorSeen.delete(k);
    }
  }
  return false;
}
