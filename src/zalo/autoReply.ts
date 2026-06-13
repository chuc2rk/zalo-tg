import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ThreadType } from 'zca-js';
import { config } from '../config.js';
import type { ZaloAPI } from './types.js';

/**
 * Bridge-level auto-reply ("offline mode").
 *
 * NOTE: zca-js's createAutoReply targets zBusiness/OA accounts and fails on
 * normal personal accounts, so we implement auto-reply here instead: when
 * enabled, the bridge replies to incoming Zalo DMs via api.sendMessage.
 * Only 1-1 (User) threads are answered — groups are never auto-replied to.
 */

export interface AutoReplyState {
  enabled: boolean;
  message: string;
}

const FILE = path.join(config.dataDir, 'autoreply.json');

/**
 * Anti-ban guards. Automated replies are the strongest "bot" signal Zalo can
 * detect, so we keep them sparse and human-like:
 *  - per-peer cooldown: at most one auto-reply per person every 30 min
 *  - global cap: at most 12 auto-replies per rolling hour (avoids mass-send
 *    bursts when many people message at once)
 *  - human-like delay: wait 3–8 s before replying (instant replies are an
 *    obvious bot tell)
 */
const COOLDOWN_MS = 30 * 60 * 1000;       // 30 minutes per peer
const GLOBAL_MAX_PER_HOUR = 12;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 8000;

const lastRepliedAt = new Map<string, number>();
let recentReplies: number[] = []; // timestamps of recent auto-replies (global)

let state: AutoReplyState = { enabled: false, message: '' };

function load(): void {
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<AutoReplyState>;
      state = { enabled: Boolean(raw.enabled), message: String(raw.message ?? '') };
    }
  } catch (err) {
    console.warn('[AutoReply] Failed to load state:', err);
  }
}
load();

function save(): void {
  try {
    writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AutoReply] Failed to save state:', err);
  }
}

export function getAutoReplyState(): AutoReplyState {
  return { ...state };
}

export function setAutoReplyEnabled(enabled: boolean, message?: string): AutoReplyState {
  state = { enabled, message: message !== undefined ? message : state.message };
  save();
  return getAutoReplyState();
}

/**
 * Fire an auto-reply to an incoming Zalo DM if enabled and not on cooldown.
 * Returns true if a reply was actually sent.
 */
export async function maybeAutoReply(
  api: ZaloAPI,
  threadId: string,
  threadType: number,
): Promise<boolean> {
  if (!state.enabled || !state.message.trim()) return false;
  if (threadType !== ThreadType.User) return false; // DMs only, never groups

  const now = Date.now();

  // Per-peer cooldown.
  if (now - (lastRepliedAt.get(threadId) ?? 0) < COOLDOWN_MS) return false;

  // Global hourly cap — prune old timestamps, then check.
  recentReplies = recentReplies.filter(t => now - t < GLOBAL_WINDOW_MS);
  if (recentReplies.length >= GLOBAL_MAX_PER_HOUR) {
    console.warn('[AutoReply] Global hourly cap reached — skipping (anti-ban)');
    return false;
  }

  // Reserve slots BEFORE the async delay so concurrent messages don't double-send.
  lastRepliedAt.set(threadId, now);
  recentReplies.push(now);

  // Human-like delay: never reply in milliseconds.
  const jitter = MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  await new Promise(r => setTimeout(r, jitter));

  try {
    await api.sendMessage({ msg: state.message }, threadId, ThreadType.User);
    console.log(`[AutoReply] Sent auto-reply to ${threadId} (after ${jitter}ms)`);
    return true;
  } catch (err) {
    console.warn('[AutoReply] Failed to send:', err);
    // Roll back reservations so a transient failure can retry next message.
    lastRepliedAt.set(threadId, 0);
    recentReplies = recentReplies.filter(t => t !== now);
    return false;
  }
}
