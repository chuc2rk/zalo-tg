import { describe, expect, it } from 'vitest';
import {
  boardMirrorDedupeKey,
  boardMirrorSeen,
  buildBoardMirrorText,
  buildReminderMirrorText,
  extractBoardMirror,
  extractReminderMirror,
  formatZaloTimestamp,
  parseBoardParams,
  repeatLabel,
} from '../../src/zalo/boardMirror.js';

describe('parseBoardParams', () => {
  it('accepts objects as-is', () => {
    expect(parseBoardParams({ title: 'Họp lớp' })).toEqual({ title: 'Họp lớp' });
  });

  it('parses JSON strings', () => {
    expect(parseBoardParams('{"boardType":1,"title":"Họp"}')).toEqual({ boardType: 1, title: 'Họp' });
  });

  it('rejects garbage', () => {
    expect(parseBoardParams('not-json')).toBeNull();
    expect(parseBoardParams('')).toBeNull();
    expect(parseBoardParams(null)).toBeNull();
    expect(parseBoardParams([1, 2])).toBeNull();
    expect(parseBoardParams(42)).toBeNull();
  });
});

describe('extractBoardMirror', () => {
  it('classifies notes via boardType enum', () => {
    const item = extractBoardMirror({ type: 0, params: { boardType: 1, title: 'Lịch thi' }, id: 'n1', creatorId: 'u1' });
    expect(item).toMatchObject({ kind: 'note', id: 'n1', title: 'Lịch thi', creatorId: 'u1' });
  });

  it('classifies notes via topicType enum with string params', () => {
    const item = extractBoardMirror({ type: 0, params: '{"title":"Quỹ lớp"}', id: 'n2' });
    expect(item).toMatchObject({ kind: 'note', title: 'Quỹ lớp' });
  });

  it('classifies pinned messages', () => {
    const item = extractBoardMirror({ type: 2, params: { boardType: 2, title: 'Nội quy' }, id: 'p1' });
    expect(item?.kind).toBe('pin');
  });

  it('never mirrors polls (dedicated pipeline owns them)', () => {
    expect(extractBoardMirror({ type: 3, params: { boardType: 3, pollId: 9, title: 'Vote' } })).toBeNull();
  });

  it('drops empty titles and null input', () => {
    expect(extractBoardMirror({ type: 0, params: { boardType: 1, title: '  ' } })).toBeNull();
    expect(extractBoardMirror(null)).toBeNull();
  });
});

describe('reminder mirror', () => {
  it('extracts remind_topic data with msg title', () => {
    const reminder = extractReminderMirror({ msg: 'Đóng tiền quỹ', startTime: 1756890000, repeat: 0 });
    expect(reminder).toMatchObject({ title: 'Đóng tiền quỹ' });
  });

  it('returns null for empty reminders', () => {
    expect(extractReminderMirror({ msg: '   ' })).toBeNull();
    expect(extractReminderMirror(null)).toBeNull();
  });

  it('formats schedule line only when usable', () => {
    expect(buildReminderMirrorText({ title: 'Họp' })).toContain('Nhắc hẹn');
    const withSchedule = buildReminderMirrorText({ title: 'Họp', startTime: 1756890000, repeat: 1 });
    expect(withSchedule).toContain('lặp lại hằng ngày');
  });

  it('escapes HTML in titles', () => {
    expect(buildReminderMirrorText({ title: '<b>oops</b>' })).toContain('&lt;b&gt;');
  });
});

describe('buildBoardMirrorText', () => {
  it('marks removed items and escapes actor/title', () => {
    const text = buildBoardMirrorText(
      { kind: 'note', id: 'n1', title: '<kế hoạch>', creatorId: 'u1' },
      { actorName: 'Cô <Lan>', removed: true },
    );
    expect(text).toContain('đã gỡ');
    expect(text).toContain('&lt;kế hoạch&gt;');
    expect(text).toContain('Cô &lt;Lan&gt;');
  });
});

describe('formatZaloTimestamp', () => {
  it('handles seconds and milliseconds', () => {
    expect(formatZaloTimestamp(1756890000)).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    expect(formatZaloTimestamp(1756890000000)).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  });

  it('rejects garbage', () => {
    expect(formatZaloTimestamp(0)).toBe('');
    expect(formatZaloTimestamp('abc')).toBe('');
    expect(formatZaloTimestamp(undefined)).toBe('');
  });
});

describe('repeatLabel', () => {
  it('maps repeat modes', () => {
    expect(repeatLabel(0)).toBe('');
    expect(repeatLabel(1)).toBe('hằng ngày');
    expect(repeatLabel(2)).toBe('hằng tuần');
    expect(repeatLabel(3)).toBe('hằng tháng');
  });
});

describe('boardMirrorSeen', () => {
  it('dedupes within TTL and releases after', () => {
    const key = boardMirrorDedupeKey(['g1', 'note', 'n-test-dedupe-1', 111]);
    expect(boardMirrorSeen(key, 1000)).toBe(false);
    expect(boardMirrorSeen(key, 2000)).toBe(true);
    expect(boardMirrorSeen(key, 1000 + 11 * 60_000)).toBe(false);
  });
});
