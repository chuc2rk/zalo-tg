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
const VOICECALL_DOMAIN = 'https://voicecall-wpa.zaloapp.com';
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

// ── Voice call (PC App) ───────────────────────────────────────────────────────

export type AppCallKind = 'audio' | 'video';

export interface AppVoiceCallResult {
  request: {
    calleeId: string;
    callId: number;
    typeRequest: number;
    codec: string;
  };
  response: {
    errorCode: number;
    errorMessage: string;
    data: unknown;
  };
  signals?: {
    request?: {
      errorCode: number;
      errorMessage: string;
      data: unknown;
    };
    ringring?: {
      errorCode: number;
      errorMessage: string;
      data: unknown;
    };
  };
}

export interface AppGroupVoiceCallResult {
  request: {
    groupId: string;
    callId: number;
    callType: 1;
    partners: string[];
  };
  response: {
    errorCode: number;
    errorMessage: string;
    data: unknown;
  };
  ringrings?: Array<{
    calleeId: string;
    errorCode: number;
    errorMessage: string;
    data: unknown;
  }>;
  diagnostics?: {
    requestSignal?: {
      errorCode: number;
      errorMessage: string;
      data: unknown;
    };
    state?: {
      errorCode: number;
      errorMessage: string;
      data: unknown;
      hostCall: number;
    };
    ringStatuses?: Array<{
      calleeId: string;
      status?: number;
    }>;
  };
}

function randomCallId(): number {
  return Math.floor(100_000_000 + Math.random() * 900_000_000);
}

async function callVoiceEndpoint(
  sess: AppSession,
  endpointPath: string,
  body: Record<string, unknown>,
): Promise<{ errorCode: number; errorMessage: string; data: unknown }> {
  const url = `${VOICECALL_DOMAIN}${endpointPath}`;
  const encBody = encodeAes(JSON.stringify(body), sess.zpw_enk);
  const resp = await axios.post<{ error_code: number; data?: string; error_message?: string }>(
    url,
    `params=${encodeURIComponent(encBody)}`,
    {
      params: commonParams(sess.imei),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': PC_UA,
        'Cookie': buildCookieHeader(sess.cookies, url),
      },
      timeout: 15_000,
    },
  );

  if (resp.data.error_code !== 0 || !resp.data.data) {
    return {
      errorCode: resp.data.error_code,
      errorMessage: resp.data.error_message ?? 'Unknown error',
      data: null,
    };
  }

  const parsed = JSON.parse(decodeAes(resp.data.data, sess.zpw_enk)) as {
    error_code?: number;
    error_message?: string;
    data?: unknown;
  };
  return {
    errorCode: parsed?.error_code ?? -1,
    errorMessage: parsed?.error_message ?? 'Unknown error',
    data: parsed?.data ?? null,
  };
}

async function callVoiceEndpointWithVariants(
  sess: AppSession,
  endpointPath: string,
  variants: Array<Record<string, unknown>>,
): Promise<{ result: { errorCode: number; errorMessage: string; data: unknown }; body: Record<string, unknown> }> {
  let last: { errorCode: number; errorMessage: string; data: unknown } = {
    errorCode: -1,
    errorMessage: 'No variants',
    data: null,
  };
  for (const body of variants) {
    const res = await callVoiceEndpoint(sess, endpointPath, body);
    if (res.errorCode === 0) return { result: res, body };
    last = res;
  }
  return { result: last, body: variants[variants.length - 1] ?? {} };
}

/**
 * Trigger a personal voice/video call request via PC App API.
 *
 * Note:
 * - Requires `data/app-session.json` from /loginapp flow.
 * - This only sends the call request signal (`/api/voicecall/requestcall`).
 */
export async function appRequestVoiceCall(
  calleeId: string,
  kind: AppCallKind = 'audio',
): Promise<AppVoiceCallResult | null> {
  const sess = loadAppSession();
  if (!sess) return null;

  const callId = randomCallId();
  const typeRequest = kind === 'video' ? 1 : 0;
  const codec = kind === 'video' ? '[]' : '["opus"]';
  const body = {
    calleeId,
    callId,
    codec,
    typeRequest,
    imei: sess.imei,
  };
  console.log(
    `[AppApi][voicecall] requestcall start calleeId=${calleeId} callId=${callId} kind=${kind} typeRequest=${typeRequest}`,
  );

  try {
    const parsed = await callVoiceEndpoint(sess, '/api/voicecall/requestcall', body);
    const status =
      parsed.data && typeof parsed.data === 'object' && 'status' in parsed.data
        ? (parsed.data as { status?: unknown }).status
        : undefined;
    console.log(
      `[AppApi][voicecall] requestcall done calleeId=${calleeId} callId=${callId} errorCode=${parsed.errorCode}` +
      (status !== undefined ? ` status=${String(status)}` : ''),
    );
    if (parsed.data !== undefined) {
      console.log('[AppApi][voicecall] requestcall payload:', JSON.stringify(parsed.data));
    }

    const result: AppVoiceCallResult = {
      request: { calleeId, callId, typeRequest, codec },
      response: {
        errorCode: parsed.errorCode,
        errorMessage: parsed.errorMessage,
        data: parsed.data ?? null,
      },
    };

    // Follow native signaling order discovered from Zalo ASAR:
    // requestcall -> request -> ringring
    if (parsed.errorCode === 0 && parsed.data && typeof parsed.data === 'object') {
      const d = parsed.data as Record<string, unknown>;
      const sid = typeof d.sessId === 'string' ? d.sessId : '';
      const callIdResolved = typeof d.id === 'number' ? d.id : callId;
      const toId = typeof d.toId === 'number' ? d.toId : Number.NaN;
      const fromId = typeof d.fromId === 'number' ? d.fromId : Number.NaN;
      const rtcpIP = typeof d.rtcpIP === 'string' ? d.rtcpIP : '';
      const rtpIP = typeof d.rtpIP === 'string' ? d.rtpIP : '';

      if (sid && Number.isFinite(toId) && Number.isFinite(fromId) && rtcpIP && rtpIP) {
        console.log(
          `[AppApi][voicecall] request start calleeId=${toId} callId=${callIdResolved} session=${sid.slice(0, 12)}...`,
        );
        const requestTry = await callVoiceEndpointWithVariants(sess, '/api/voicecall/request', [
          // Verified working from live test: calleeId must be the original Zalo UID string.
          { calleeId, rtcpAddress: rtcpIP, rtpAddress: rtpIP, codec: '[]', session: sid, callId: callIdResolved, imei: sess.imei },
          // Fallbacks if server-side rules change.
          { calleeId, rtcpAddress: rtcpIP, rtpAddress: rtpIP, codec: '[]', session: sid, callId: callIdResolved },
          { calleeId: String(toId), rtcpAddress: rtcpIP, rtpAddress: rtpIP, codec: '[]', session: sid, callId: callIdResolved, imei: sess.imei },
          { calleeId: toId, rtcpAddress: rtcpIP, rtpAddress: rtpIP, codec: '[]', session: sid, callId: callIdResolved, imei: sess.imei },
        ]);
        const requestSignal = requestTry.result;
        console.log(
          `[AppApi][voicecall] request done callId=${callIdResolved} errorCode=${requestSignal.errorCode}`,
        );
        console.log('[AppApi][voicecall] request body used:', JSON.stringify(requestTry.body));
        console.log('[AppApi][voicecall] request payload:', JSON.stringify(requestSignal.data));

        console.log(
          `[AppApi][voicecall] ringring start callerId=${calleeId} callId=${callIdResolved}`,
        );
        const ringTry = await callVoiceEndpointWithVariants(sess, '/api/voicecall/ringring', [
          // Verified working from live test: callerId must be peer Zalo UID string.
          { callerId: calleeId, callId: callIdResolved, status: 0, imei: sess.imei },
          { callerId: calleeId, callId: callIdResolved, status: 0 },
          // Fallbacks
          { callerId: fromId, callId: callIdResolved, status: 0, imei: sess.imei },
          { callerId: toId, callId: callIdResolved, status: 0, imei: sess.imei },
        ]);
        const ringSignal = ringTry.result;
        console.log(
          `[AppApi][voicecall] ringring done callId=${callIdResolved} errorCode=${ringSignal.errorCode}`,
        );
        console.log('[AppApi][voicecall] ringring body used:', JSON.stringify(ringTry.body));
        console.log('[AppApi][voicecall] ringring payload:', JSON.stringify(ringSignal.data));

        result.signals = {
          request: requestSignal,
          ringring: ringSignal,
        };
      } else {
        console.warn(
          '[AppApi][voicecall] skip request/ringring: missing fields',
          JSON.stringify({ hasSessId: Boolean(sid), toId, fromId, hasRtcp: Boolean(rtcpIP), hasRtp: Boolean(rtpIP) }),
        );
      }
    }

    return result;
  } catch (err) {
    console.warn(
      `[AppApi][voicecall] requestcall failed calleeId=${calleeId} callId=${callId}:`,
      err instanceof Error ? err.message : err,
    );
    return {
      request: { calleeId, callId, typeRequest, codec },
      response: {
        errorCode: -1,
        errorMessage: err instanceof Error ? err.message : String(err),
        data: null,
      },
    };
  }
}

/**
 * Trigger a group voice/video call request via PC App API.
 *
 * ASAR + live-test verified flow:
 * - /api/voicecall/group/requestcall
 * - /api/voicecall/group/ringring
 */
export async function appRequestGroupVoiceCall(
  groupId: string,
  partners: string[],
  kind: AppCallKind = 'video',
): Promise<AppGroupVoiceCallResult | null> {
  const sess = loadAppSession();
  if (!sess) return null;

  const normalizedPartners = Array.from(
    new Set(
      partners
        .map(v => String(v).trim())
        .filter(v => v.length > 0),
    ),
  );
  if (normalizedPartners.length === 0) {
    return {
      request: {
        groupId,
        callId: 0,
        callType: 1,
        partners: [],
      },
      response: {
        errorCode: 114,
        errorMessage: 'No partners',
        data: null,
      },
    };
  }

  const callId = randomCallId();
  const callType = 1; // ASAR flow: group call is video-centric; we force video only.
  const requestBody = {
    groupId,
    callId,
    typeRequest: callType,
    data: {},
    partners: normalizedPartners,
  };

  console.log(
    `[AppApi][groupcall] requestcall start groupId=${groupId} callId=${callId} kind=${kind} partners=${normalizedPartners.length}`,
  );

  try {
    const reqParsed = await callVoiceEndpoint(sess, '/api/voicecall/group/requestcall', requestBody);
    console.log(
      `[AppApi][groupcall] requestcall done groupId=${groupId} callId=${callId} errorCode=${reqParsed.errorCode}`,
    );
    if (reqParsed.data !== undefined) {
      console.log('[AppApi][groupcall] requestcall payload:', JSON.stringify(reqParsed.data));
    }

    const result: AppGroupVoiceCallResult = {
      request: {
        groupId,
        callId,
        callType,
        partners: normalizedPartners,
      },
      response: {
        errorCode: reqParsed.errorCode,
        errorMessage: reqParsed.errorMessage,
        data: reqParsed.data ?? null,
      },
    };

    if (reqParsed.errorCode === 0 && reqParsed.data && typeof reqParsed.data === 'object') {
      const d = reqParsed.data as Record<string, unknown>;
      const resolvedCallId =
        typeof d.id === 'number'
          ? d.id
          : callId;

      const paramsObj = (() => {
        if (typeof d.params !== 'string') return null;
        try {
          return JSON.parse(d.params) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      const hostCall =
        (paramsObj && typeof paramsObj.hostCall === 'number' ? paramsObj.hostCall : undefined)
        ?? (typeof d.hostCall === 'number' ? d.hostCall : undefined)
        ?? (paramsObj && typeof paramsObj.fromId === 'number' ? paramsObj.fromId : undefined)
        ?? 0;
      const ringData =
        (paramsObj && typeof paramsObj.callSetting === 'object' && paramsObj.callSetting !== null)
          ? (paramsObj.callSetting as Record<string, unknown>)
          : paramsObj ?? {};
      const session =
        (paramsObj && typeof paramsObj.callSetting === 'object' && paramsObj.callSetting !== null && typeof (paramsObj.callSetting as Record<string, unknown>).session === 'string')
          ? ((paramsObj.callSetting as Record<string, unknown>).session as string)
          : (typeof (paramsObj as Record<string, unknown>)?.session === 'string' ? ((paramsObj as Record<string, unknown>).session as string) : '');
      const requestGroupId =
        (paramsObj && typeof paramsObj.groupId === 'number')
          ? paramsObj.groupId
          : groupId;

      const ringrings: NonNullable<AppGroupVoiceCallResult['ringrings']> = [];
      const ringStatuses: NonNullable<NonNullable<AppGroupVoiceCallResult['diagnostics']>['ringStatuses']> = [];
      // Deep debug: emulate native '/group/request' signal using the most
      // plausible payload from requestcall response.
      const requestSignal =
        session && normalizedPartners.length > 0
          ? await callVoiceEndpoint(sess, '/api/voicecall/group/request', {
              calleeId: normalizedPartners[0],
              callId: resolvedCallId,
              callType,
              data: paramsObj ?? {},
              session,
              partners: normalizedPartners,
              groupId: requestGroupId,
            })
          : null;
      if (requestSignal) {
        console.log(
          `[AppApi][groupcall] request-signal done groupId=${groupId} callId=${resolvedCallId} errorCode=${requestSignal.errorCode}`,
        );
        if (requestSignal.data !== undefined) {
          console.log('[AppApi][groupcall] request-signal payload:', JSON.stringify(requestSignal.data));
        }
      }
      // Native signature from ASAR:
      // sendRingRingCallGroup(calleeId, callId, callType, hostCall, data, partners)
      for (const calleeId of normalizedPartners) {
        const ringBody = {
          calleeId,
          callId: resolvedCallId,
          callType,
          hostCall,
          data: ringData,
          partners: normalizedPartners,
        };
        console.log(
          `[AppApi][groupcall] ringring start calleeId=${calleeId} groupId=${groupId} callId=${resolvedCallId}`,
        );
        const ring = await callVoiceEndpoint(sess, '/api/voicecall/group/ringring', ringBody);
        console.log(
          `[AppApi][groupcall] ringring done calleeId=${calleeId} callId=${resolvedCallId} errorCode=${ring.errorCode}`,
        );
        if (ring.data !== undefined) {
          console.log('[AppApi][groupcall] ringring payload:', JSON.stringify(ring.data));
        }
        let ringStatus: number | undefined;
        if (ring.data && typeof ring.data === 'object' && 'params' in ring.data) {
          const p = (ring.data as { params?: unknown }).params;
          if (typeof p === 'string') {
            try {
              const parsed = JSON.parse(p) as { status?: unknown };
              if (typeof parsed.status === 'number') ringStatus = parsed.status;
            } catch {
              // ignore malformed params
            }
          }
        }
        ringStatuses.push({ calleeId, status: ringStatus });
        ringrings.push({
          calleeId,
          errorCode: ring.errorCode,
          errorMessage: ring.errorMessage,
          data: ring.data,
        });
      }
      result.ringrings = ringrings;
      // Probe state after ringring to detect "accepted but not active call" cases.
      let state = await callVoiceEndpoint(sess, '/api/voicecall/group/state', {
        callId: resolvedCallId,
        hostCall,
        callType,
      });
      if (state.errorCode !== 0 && hostCall !== 0) {
        state = await callVoiceEndpoint(sess, '/api/voicecall/group/state', {
          callId: resolvedCallId,
          hostCall: 0,
          callType,
        });
        result.diagnostics = {
          requestSignal: requestSignal ?? undefined,
          state: { ...state, hostCall: 0 },
          ringStatuses,
        };
      } else {
        result.diagnostics = {
          requestSignal: requestSignal ?? undefined,
          state: { ...state, hostCall },
          ringStatuses,
        };
      }
      if (
        result.diagnostics.requestSignal?.errorCode !== 0 &&
        result.diagnostics.state?.errorCode !== 0
      ) {
        console.warn(
          '[AppApi][groupcall] diagnostic: request-signal/state not active, ringring alone may not trigger real ringing',
        );
      }
    }

    return result;
  } catch (err) {
    console.warn(
      `[AppApi][groupcall] requestcall failed groupId=${groupId} callId=${callId}:`,
      err instanceof Error ? err.message : err,
    );
    return {
      request: {
        groupId,
        callId,
        callType,
        partners: normalizedPartners,
      },
      response: {
        errorCode: -1,
        errorMessage: err instanceof Error ? err.message : String(err),
        data: null,
      },
    };
  }
}
