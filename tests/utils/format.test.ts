import { describe, it, expect } from 'vitest';
import {
  truncate,
  escapeHtml,
  applyMentionsHtml,
  applyZaloMarkupHtml,
  senderBadge,
  senderMarker,
  formatGroupMsg,
  formatGroupMsgHtml,
  groupCaption,
  topicName,
} from '../../src/utils/format.js';

describe('truncate', () => {
  it('returns short text as-is', () => {
    expect(truncate('hello')).toBe('hello');
  });

  it('truncates long text with ellipsis', () => {
    const long = 'a'.repeat(100);
    const result = truncate(long, 10);
    expect(result).toBe('aaaaaaaaa…');
    expect(result.length).toBe(10);
  });

  it('defaults to 4096 max', () => {
    const long = 'a'.repeat(5000);
    expect(truncate(long).length).toBe(4096);
  });
});

describe('escapeHtml', () => {
  it('escapes & < >', () => {
    expect(escapeHtml('&<>')).toBe('&amp;&lt;&gt;');
  });

  it('passes safe text through', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('applyMentionsHtml', () => {
  it('wraps mention spans in <b>', () => {
    const result = applyMentionsHtml('@Alice hello', [{ pos: 0, len: 6, type: 0 }]);
    expect(result).toBe('<b>@Alice</b> hello');
  });

  it('returns escaped text when no mentions', () => {
    expect(applyMentionsHtml('hello <world>', [])).toBe('hello &lt;world&gt;');
  });

  it('handles multiple mentions', () => {
    const result = applyMentionsHtml('@Alice @Bob hi', [
      { pos: 0, len: 6, type: 0 },
      { pos: 7, len: 4, type: 0 },
    ]);
    expect(result).toBe('<b>@Alice</b> <b>@Bob</b> hi');
  });

  it('skips out-of-range mentions', () => {
    const result = applyMentionsHtml('hi', [{ pos: 10, len: 5, type: 0 }]);
    expect(result).toBe('hi');
  });
});

describe('applyZaloMarkupHtml', () => {
  it('applies bold style', () => {
    const result = applyZaloMarkupHtml('hello world', undefined, [{ start: 0, len: 5, st: 'b' }]);
    expect(result).toBe('<b>hello</b> world');
  });

  it('applies italic and underline', () => {
    const result = applyZaloMarkupHtml('test', undefined, [
      { start: 0, len: 2, st: 'i' },
      { start: 2, len: 2, st: 'u' },
    ]);
    expect(result).toBe('<i>te</i><u>st</u>');
  });

  it('replaces mention with label', () => {
    const result = applyZaloMarkupHtml('@Alice hi', [
      { pos: 0, len: 6, type: 0, label: '@Người dùng' },
    ]);
    expect(result).toBe('<b>@Người dùng</b> hi');
  });

  it('escapes HTML in text', () => {
    const result = applyZaloMarkupHtml('<script>', undefined, [{ start: 0, len: 8, st: 'b' }]);
    expect(result).toBe('<b>&lt;script&gt;</b>');
  });

  it('returns escaped text when no styles or mentions', () => {
    expect(applyZaloMarkupHtml('a < b')).toBe('a &lt; b');
  });

  it('ignores unknown style tags', () => {
    const result = applyZaloMarkupHtml('hello', undefined, [{ start: 0, len: 5, st: 'c_ff0000' }]);
    expect(result).toBe('hello');
  });
});

describe('sender scan marker', () => {
  it('is deterministic for the same key', () => {
    expect(senderBadge('Tấn Lê', 'uid-1')).toBe(senderBadge('Tấn Lê', 'uid-1'));
    expect(senderMarker('Tấn Lê', 'uid-1')).toBe(senderMarker('Tấn Lê', 'uid-1'));
  });

  it('keeps the same visual marker when only the resolved display name changes', () => {
    expect(senderBadge('Tấn Lê', 'uid-1')).toBe(senderBadge('Lê Tấn', 'uid-1'));
    expect(senderMarker('Tấn Lê', 'uid-1')).toBe(senderMarker('Lê Tấn', 'uid-1'));
  });

  it('returns compact visual markers without initials', () => {
    expect(senderBadge('Tấn Lê', 'uid-1')).toMatch(/^\S+$/u);
    expect(senderMarker('Tấn Lê', 'uid-1')).toMatch(/^\S+$/u);
    expect(senderMarker('Tấn Lê', 'uid-1')).not.toContain('TL');
  });

  it('adds a secondary shape to reduce same-colour collisions', () => {
    expect(senderMarker('Tấn Lê', 'uid-1').length).toBeGreaterThan(senderBadge('Tấn Lê', 'uid-1').length);
  });
});

describe('formatGroupMsg', () => {
  it('formats content first, then separator and sender attribution', () => {
    expect(formatGroupMsg('Alice', 'Hello', 'uid-a')).toMatch(/^Hello\n└ \S+ <b>ALICE<\/b>$/u);
  });

  it('escapes sender name and content', () => {
    const result = formatGroupMsg('A < B', 'x & y', 'uid-a');
    expect(result).toContain('<b>A &lt; B</b>');
    expect(result).toContain('x &amp; y');
  });

  it('truncates long sender names', () => {
    const longName = 'A'.repeat(100);
    const result = formatGroupMsg(longName, 'Hi');
    const displayedName = result.match(/<b>([^<]+)<\/b>/)?.[1];
    expect(displayedName).toBeDefined();
    expect(displayedName!.length).toBeLessThanOrEqual(65);
  });
});

describe('formatGroupMsgHtml', () => {
  it('keeps pre-escaped body first and puts the bold sender below', () => {
    expect(formatGroupMsgHtml('Alice', '<b>Hello</b>', 'uid-a')).toMatch(/^<b>Hello<\/b>\n└ \S+ <b>ALICE<\/b>$/u);
  });
});

describe('groupCaption', () => {
  it('returns sender marker plus bold uppercase sender name', () => {
    expect(groupCaption('Alice', 'uid-a')).toMatch(/^└ \S+ <b>ALICE<\/b>$/u);
  });

  it('uppercases Vietnamese sender names for media captions', () => {
    expect(groupCaption('Nguyễn Văn A', 'uid-a')).toContain('<b>NGUYỄN VĂN A</b>');
  });
});

describe('topicName', () => {
  it('formats DM topic', () => {
    expect(topicName('Alice', 0)).toContain('Alice');
  });

  it('formats group topic', () => {
    expect(topicName('Friends', 1)).toContain('Friends');
  });

  it('limits to 128 chars', () => {
    const long = 'A'.repeat(200);
    expect(topicName(long, 0).length).toBeLessThanOrEqual(128);
  });
});
