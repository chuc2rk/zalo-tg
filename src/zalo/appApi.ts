/**
 * appApi.ts
 * ─────────
 * Direct PC App API helper using profile-wpa.zaloapp.com.
 * Used as a faster / potentially less rate-limited alternative to the
 * zca-js web API for fetching group member profiles.
 *
 * Requires data/app-session.json to be present (written by loginApp.ts after
 * a successful /loginapp flow).
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import axios from 'axios';
import { config } from '../config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const GROUP_DOMAIN   = 'https://group-wpa.zaloapp.com';
const PROFILE_DOMAIN = 'https://profile-wpa.zaloapp.com';
const FRIEND_DOMAIN  = 'https://friend-wpa.zaloapp.com';
const API_TYPE       = 30;
const API_VERSION    = 671;
const PC_UA          = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ZaloPC/23.12.1 Chrome/102.0.5005.167 Electron/19.1.9 Safari/537.36';

// ── Session ───────────────────────────────────────────────────────────────────

interface AppSession {
  zpw_enk: string;
  imei:    string;
  cookies: Array<{ name: string; value: string; domain: string }>;
}

let _session: AppSession | null | undefined;  // undefined = not yet loaded

function loadAppSession(): AppSession | null {
  if (_session !== undefined) return _session;
  const p = path.join(path.dirname(config.zalo.credentialsPath), 'app-session.json');
  if (!existsSync(p)) { _session = null; return null; }
  try {
    _session = JSON.parse(readFileSync(p, 'utf8')) as AppSession;
    return _session;
  } catch {
    _session = null;
    return null;
  }
}

/** Call this after a new /loginapp to reload the session from disk. */
export function invalidateAppSession(): void {
  _session = undefined;
}

// ── Crypto (same as loginApp.ts) ──────────────────────────────────────────────

function aesCipher(keyBuf: Buffer): string {
  const bits = keyBuf.length * 8;
  if (bits === 128) return 'aes-128-cbc';
  if (bits === 192) return 'aes-192-cbc';
  return 'aes-256-cbc';  // 256
}

function encodeAes(plaintext: string, zpwEnk: string): string {
  const key    = Buffer.from(zpwEnk, 'base64');
  const iv     = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv(aesCipher(key), key, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

function decodeAes(ciphertext: string, zpwEnk: string): string {
  const key      = Buffer.from(zpwEnk, 'base64');
  const iv       = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv(aesCipher(key), key, iv);
  const ct       = Buffer.from(decodeURIComponent(ciphertext), 'base64');
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/** Common URL query params for PC App API requests. */
function commonParams(imei: string): Record<string, string> {
  return { zpw_type: String(API_TYPE), zpw_ver: String(API_VERSION), imei };
}

function buildCookieHeader(cookies: Array<{ name: string; value: string; domain: string }>, url: string): string {
  const { hostname } = new URL(url);
  return cookies
    .filter(c => hostname.endsWith(c.domain) || hostname === c.domain)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ── Group info (PC App, bypasses web-API rate limit) ─────────────────────────

export interface AppGroupData {
  name?: string;
  avt?: string;
  memVerList?:  string[];
  currentMems?: Array<{ id: string; dName?: string; zaloName?: string }>;
  totalMember?: number;
  hasMoreMember?: number;
}

/**
 * Fetch group info from the PC App group domain (group-wpa.zaloapp.com).
 * Mirrors zca-js getGroupInfo but uses the PC App session cookies, which
 * have a separate rate-limit bucket from the web API.
 *
 * Returns null if no app session is available or on error.
 */
export async function appGetGroupInfo(groupId: string): Promise<AppGroupData | null> {
  const sess = loadAppSession();
  if (!sess) return null;

  const url = `${GROUP_DOMAIN}/api/group/getmg-v2`;
  const body = { gridVerMap: JSON.stringify({ [groupId]: 0 }) };
  const encBody = encodeAes(JSON.stringify(body), sess.zpw_enk);

  try {
    const resp = await axios.post<{ error_code: number; data?: string; error_message?: string }>(
      url,
      `params=${encodeURIComponent(encBody)}`,
      {
        params:  commonParams(sess.imei),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   PC_UA,
          'Cookie':       buildCookieHeader(sess.cookies, url),
        },
        timeout: 15_000,
      },
    );

    if (resp.data.error_code !== 0 || !resp.data.data) {
      console.warn(`[AppApi] getGroupInfo [${resp.data.error_code}] ${resp.data.error_message ?? ''}`);
      return null;
    }

    const parsed = JSON.parse(decodeAes(resp.data.data, sess.zpw_enk)) as {
      data?: { gridInfoMap?: Record<string, AppGroupData> };
    };
    return parsed?.data?.gridInfoMap?.[groupId] ?? null;
  } catch (err) {
    console.warn(`[AppApi] getGroupInfo failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Group member profiles ─────────────────────────────────────────────────────

/**
 * Fetch display names for a list of UIDs using the PC App profile endpoint.
 *
 * Returns a Map<uid, displayName>. Returns null if no app session is available.
 *
 * Endpoint: POST profile-wpa.zaloapp.com/api/social/group/members
 * Uses AES-256-CBC encrypted params (PC App API pattern, same domain cookies).
 */
export async function appGetGroupMembersInfo(uids: string[]): Promise<Map<string, string> | null> {
  const sess = loadAppSession();
  if (!sess) return null;  // no app session available yet

  const BATCH = 50;
  const result = new Map<string, string>();

  for (let i = 0; i < uids.length; i += BATCH) {
    const batch = uids.slice(i, i + BATCH);
    const friendPversionMap = batch.map(u => u.endsWith('_0') ? u : u + '_0');

    const body    = { friend_pversion_map: friendPversionMap };
    const encBody = encodeAes(JSON.stringify(body), sess.zpw_enk);
    const url     = `${PROFILE_DOMAIN}/api/social/group/members`;

    try {
      const resp = await axios.post<{ error_code: number; data?: string; error_message?: string }>(
        url,
        `params=${encodeURIComponent(encBody)}`,
        {
          params:  commonParams(sess.imei),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':   PC_UA,
            'Cookie':       buildCookieHeader(sess.cookies, url),
          },
          timeout: 15_000,
        },
      );

      if (resp.data.error_code !== 0) {
        console.warn(`[AppApi] /api/social/group/members error [${resp.data.error_code}]: ${resp.data.error_message ?? ''}`);
        continue;
      }

      // Response data is AES-encrypted
      const raw = resp.data.data;
      if (!raw) continue;

      const decrypted = decodeAes(raw, sess.zpw_enk);
      const parsed = JSON.parse(decrypted) as {
        error_code?: number;
        data?: {
          profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        };
      };

      const profiles = parsed?.data?.profiles ?? {};
      for (const uid of batch) {
        const key = uid.endsWith('_0') ? uid : uid + '_0';
        const p   = profiles[key] ?? profiles[uid];
        const name = p?.displayName?.trim() || p?.zaloName?.trim();
        if (name) result.set(uid, name);
      }
    } catch (err) {
      console.warn(`[AppApi] /api/social/group/members request failed:`, err instanceof Error ? err.message : err);
      // Return whatever we have so far; caller falls back to web API
      break;
    }
  }

  return result;
}

// ── Friend Requests (PC App) ──────────────────────────────────────────────────

/**
 * Fetch the FULL list of received friend requests (recommendations) via PC App API.
 * The Web API truncates the list, but this bypasses it.
 */
export async function appGetReceivedFriendRequests(count = 200, offset = 0): Promise<any[]> {
  const sess = loadAppSession();
  if (!sess) return [];

  const url = `${FRIEND_DOMAIN}/api/friend/recommendsv2/list`;
  const body = { count, offset };
  const encBody = encodeAes(JSON.stringify(body), sess.zpw_enk);

  try {
    const resp = await axios.get<{ error_code: number; data?: string; error_message?: string }>(url, {
      params: { ...commonParams(sess.imei), params: encBody },
      headers: {
        'User-Agent': PC_UA,
        'Cookie': buildCookieHeader(sess.cookies, url),
      },
      timeout: 15_000,
    });

    if (resp.data.error_code !== 0 || !resp.data.data) {
      console.warn(`[AppApi] getReceivedFriendRequests error [${resp.data.error_code}]`);
      return [];
    }

    const parsed = JSON.parse(decodeAes(resp.data.data, sess.zpw_enk));
    return parsed?.data?.recommItems || [];
  } catch (err) {
    console.warn(`[AppApi] getReceivedFriendRequests failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetch the FULL list of sent friend requests via PC App API.
 */
export async function appGetSentFriendRequests(count = 200, offset = 0): Promise<Record<string, any>> {
  const sess = loadAppSession();
  if (!sess) return {};

  const url = `${FRIEND_DOMAIN}/api/friend/requested/list`;
  const body = { count, offset };
  const encBody = encodeAes(JSON.stringify(body), sess.zpw_enk);

  try {
    const resp = await axios.get<{ error_code: number; data?: string; error_message?: string }>(url, {
      params: { ...commonParams(sess.imei), params: encBody },
      headers: {
        'User-Agent': PC_UA,
        'Cookie': buildCookieHeader(sess.cookies, url),
      },
      timeout: 15_000,
    });

    if (resp.data.error_code !== 0 || !resp.data.data) {
      console.warn(`[AppApi] getSentFriendRequests error [${resp.data.error_code}]`);
      return {};
    }

    const parsed = JSON.parse(decodeAes(resp.data.data, sess.zpw_enk));
    return parsed?.data || {};
  } catch (err) {
    console.warn(`[AppApi] getSentFriendRequests failed:`, err instanceof Error ? err.message : err);
    return {};
  }
}
