/** Truncate a string to `max` characters, appending ellipsis if cut. */
export function truncate(text: string, max = 4096): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Escape characters special to Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Apply Zalo mention metadata to a plain-text message body, returning an
 * HTML-escaped string with each mention span wrapped in `<b>` tags.
 *
 * @param text     Raw (unescaped) message content.
 * @param mentions Array of {pos, len, type} from TGroupMessage.mentions.
 */
export function applyMentionsHtml(
  text: string,
  mentions: ReadonlyArray<{ pos: number; len: number; type: number }>,
): string {
  if (!mentions.length) return escapeHtml(text);

  const sorted = [...mentions].sort((a, b) => a.pos - b.pos);
  let result = '';
  let cursor = 0;

  for (const m of sorted) {
    // Guard against out-of-range or overlapping mentions
    if (m.pos < cursor || m.pos >= text.length) continue;
    if (m.pos > cursor) result += escapeHtml(text.slice(cursor, m.pos));
    const span = text.slice(m.pos, m.pos + m.len);
    result += `<b>${escapeHtml(span)}</b>`;
    cursor = m.pos + m.len;
  }

  if (cursor < text.length) result += escapeHtml(text.slice(cursor));
  return result;
}

// ── Zalo rich text markup ────────────────────────────────────────────────────

/** Zalo style code → HTML tag mapping (only tags valid in Telegram HTML mode). */
const ZALO_STYLE_TAGS: Readonly<Record<string, string>> = {
  b: 'b',
  i: 'i',
  u: 'u',
  s: 's',
};

export interface ZaloStyle {
  start: number;
  len: number;
  /** 'b' | 'i' | 'u' | 's' | 'c_xxxxxx' | 'f_xx' | 'lst_x' | 'ind_xx' */
  st: string;
}

/**
 * Apply both Zalo text styles (bold/italic/underline/strike) AND mention spans
 * to a raw plain-text string, returning a fully HTML-escaped string suitable
 * for Telegram's HTML parse mode.
 *
 * Both `mentions` and `styles` use character-index ranges in the original text.
 * Overlapping/nested ranges are handled by tracking open/close events per
 * position — Telegram's HTML parser tolerates non-strictly-nested tags.
 */
export function applyZaloMarkupHtml(
  text: string,
  mentions?: ReadonlyArray<{ pos: number; len: number; type: number; label?: string }>,
  styles?: ReadonlyArray<ZaloStyle>,
): string {
  const opens  = new Map<number, string[]>();
  const closes = new Map<number, string[]>();

  const addOpen  = (pos: number, tag: string) => { if (!opens.has(pos))  opens.set(pos, []);  opens.get(pos)!.push(tag); };
  const addClose = (pos: number, tag: string) => { if (!closes.has(pos)) closes.set(pos, []); closes.get(pos)!.push(tag); };

  // Register style spans
  if (styles?.length) {
    const sorted = [...styles].sort((a, b) => a.start - b.start || a.len - b.len);
    for (const s of sorted) {
      const tag = ZALO_STYLE_TAGS[s.st];
      if (!tag || s.len <= 0 || s.start < 0 || s.start >= text.length) continue;
      const end = Math.min(s.start + s.len, text.length);
      addOpen(s.start, tag);
      addClose(end, tag);
    }
  }

  // Register mention spans (bold)
  if (mentions?.length) {
    for (const m of mentions) {
      if (m.pos < 0 || m.pos >= text.length || m.len <= 0) continue;
      const end = Math.min(m.pos + m.len, text.length);
      addOpen(m.pos, 'b');
      addClose(end, 'b');
    }
  }

  const replacements = new Map<number, { end: number; label: string }>();
  if (mentions?.length) {
    for (const m of mentions) {
      if (!m.label || m.pos < 0 || m.pos >= text.length || m.len <= 0) continue;
      replacements.set(m.pos, { end: Math.min(m.pos + m.len, text.length), label: m.label });
    }
  }

  if (opens.size === 0 && replacements.size === 0) return escapeHtml(text);

  let result = '';
  for (let i = 0; i <= text.length; i++) {
    // Close tags before opening new ones at the same position
    const cls = closes.get(i);
    if (cls) for (const t of cls) result += `</${t}>`;
    const opn = opens.get(i);
    if (opn) for (const t of opn) result += `<${t}>`;
    if (i < text.length) {
      const replacement = replacements.get(i);
      if (replacement) {
        result += escapeHtml(replacement.label);
        i = replacement.end - 1;
      } else {
        result += escapeHtml(text[i]!);
      }
    }
  }
  return result;
}

const SENDER_BADGES = ['🟦', '🟩', '🟪', '🟧', '🟥', '🟨', '🔵', '🟢', '🟣', '🟠', '🔴', '🟡', '🔷', '🔶', '🔹', '🔸', '⬛', '⬜', '🟤'] as const;
const SENDER_ACCENTS = ['▌', '●', '◆', '■', '▲', '✦', '✚', '⬢'] as const;
// Sender attribution goes on TOP of the message body in bold so readers see
// who wrote it without scrolling. All bridged messages share one Telegram
// bot avatar, so a bold name header is easier to scan than a footer stuck at
// the bottom of long messages and heavy file captions.
const SENDER_HEADER_ICON = '👤';

function senderHeader(senderName: string, stableKey?: string): string {
  const displayName = truncate(senderName, 64);
  return `${SENDER_HEADER_ICON} ${escapeHtml(senderMarker(senderName, stableKey))} <b>${escapeHtml(displayName)}</b>`;
}

/**
 * Format a group message with the sender first in bold, then the content:
 *   👤 🟪◆  <b>SenderName</b>
 *   content…
 */
export function formatGroupMsg(senderName: string, content: string, stableKey?: string): string {
  return `${senderHeader(senderName, stableKey)}\n${escapeHtml(truncate(content))}`;
}

/**
 * Format a group message with pre-escaped HTML body (e.g. when mention spans
 * have already been wrapped in <b> tags).
 */
export function formatGroupMsgHtml(senderName: string, bodyHtml: string, stableKey?: string): string {
  return `${senderHeader(senderName, stableKey)}\n${bodyHtml}`;
}

/** Sender attribution used as the first line of media captions. */
export function groupCaption(senderName: string, stableKey?: string): string {
  return senderHeader(senderName, stableKey);
}

function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function senderHash(senderName: string, stableKey = senderName): number {
  // Keep the visual marker stable per person. Prefer immutable IDs (Zalo uid)
  // over display names, because names can resolve differently across message types.
  const key = stableKey || senderName || 'unknown';
  return stableHash(key);
}

/** Stable, compact visual badge for a Zalo sender. */
export function senderBadge(senderName: string, stableKey = senderName): string {
  return SENDER_BADGES[senderHash(senderName, stableKey) % SENDER_BADGES.length];
}

/** Stronger per-sender marker for Telegram group threads.
 *
 * Telegram messages sent by the bridge all share the same bot avatar/name, and
 * Telegram Bot API does not support arbitrary text colours. Use a stable colour
 * emoji plus a secondary shape so people can scan a busy Zalo group quickly even
 * when two senders collide on the same colour.
 */
export function senderMarker(senderName: string, stableKey = senderName): string {
  const hash = senderHash(senderName, stableKey);
  const badge = SENDER_BADGES[hash % SENDER_BADGES.length];
  const accent = SENDER_ACCENTS[Math.floor(hash / SENDER_BADGES.length) % SENDER_ACCENTS.length];
  return `${badge}${accent}`;
}

export function senderLabel(senderName: string, stableKey?: string): string {
  return `${senderMarker(senderName, stableKey)} ${truncate(senderName, 64)}`;
}

/**
 * Format a Telegram Topic name:
 *   👤 Name  (DM)
 *   👥 Name  (Group)
 * Telegram's max topic name length is 128 chars.
 */
export function topicName(name: string, type: 0 | 1): string {
  return `${type === 1 ? '👥' : '👤'} ${name}`.slice(0, 128);
}
