import { ThreadType, FriendEventType } from 'zca-js';
import type { TelegramEmoji } from 'telegraf/types';
import { createReadStream } from 'fs';
import path from 'path';
import QRCode from 'qrcode';

import type { ZaloAPI, ZaloMessage, ZaloMediaContent, ZaloGroupInfoResponse } from './types.js';
import { appGetGroupInfo, appGetGroupMembersInfo, appGetFriendProfilesV2 } from './appApi.js';
import { ZALO_MSG_TYPES } from './types.js';
import { store } from '../store.js';
import { tgBot } from '../telegram/bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp, convertSpriteSheetToGif } from '../utils/media.js';
import { applyZaloMarkupHtml, formatGroupMsgHtml, formatGroupMsg, groupCaption, topicName, truncate, escapeHtml } from '../utils/format.js';
import type { ZaloStyle } from '../utils/format.js';
import { msgStore, userCache, pollStore, sentMsgStore, zaloAlbumStore, reactionEchoStore, reactionEventDedupeStore, aliasCache, friendsCache, nameCache, recentlyRecalledMsgIds, markRecallConfirmed, type ZaloQuoteData } from '../store.js';
import { tgQueue } from '../utils/tgQueue.js';
import { maybeAutoReply } from './autoReply.js';

// Proxy that routes every tg.* call through the rate-limit queue
// so 429 errors are auto-retried instead of crashing the process.
const tg = new Proxy(tgBot.telegram, {
  get(target, prop: string) {
    const orig = (target as unknown as Record<string, unknown>)[prop];
    if (typeof orig !== 'function') return orig;
    return (...args: unknown[]) =>
      tgQueue(() => (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args));
  },
}) as typeof tgBot.telegram;

// ── Bank card HTML parser ────────────────────────────────────────────────────
interface BankCardInfo {
  bankName: string;
  accountNumber: string;
  holderName?: string;
  vietqr: string;
}

function parseBankCardHtml(html: string): BankCardInfo | null {
  const ptags = [...html.matchAll(/<p[^>]*>([^<]+)<\/p>/g)]
    .map(m => m[1].trim()).filter(t => t.length > 0);

  const normalised = html.replace(/&amp;/g, '&');
  const contentMatch = normalised.match(/content=([^&"< ]+)/);
  if (!contentMatch) return null;
  const vietqr = decodeURIComponent(contentMatch[1]);

  // p-tag order from Zalo HTML: [BIN, BankName, AccountNumber, HolderName?, ...]
  const numericTags = ptags.filter(t => /^\d+$/.test(t));
  const textTags    = ptags.filter(t => !/^\d+$/.test(t));

  const accountNumber = numericTags.find(t => t.length !== 6) ?? numericTags[1] ?? numericTags[0] ?? '';
  const bankName      = textTags[0] ?? '';
  const holderName    = textTags[1]?.trim() || undefined;

  if (!vietqr) return null;
  return { bankName, accountNumber, holderName, vietqr };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch group member list and populate `userCache` so mention resolution works
 * immediately even before any group message is received.
 */
async function populateGroupMemberCache(api: ZaloAPI, groupId: string): Promise<void> {
  try {
    const totalMember = await (async () => {
      const info = await api.getGroupInfo(groupId) as { gridInfoMap?: Record<string, { totalMember?: number }> };
      return info?.gridInfoMap?.[groupId]?.totalMember;
    })().catch(() => undefined);

    // --- Step 1: try PC App endpoint first (group-wpa.zaloapp.com, separate rate-limit) ---
    let groupData = await appGetGroupInfo(groupId);
    let usedFallback = false;
    if (groupData) {
      console.log(`[API][APP] getGroupInfo group=${groupId} source=populateGroupMemberCache`);
    }

    if (!groupData) {
      usedFallback = true;
      // Fallback: zca-js web API (rate-limited)
      console.log(`[API][WEB] getGroupInfo group=${groupId} source=populateGroupMemberCache fallback=app_empty`);
      const info = await api.getGroupInfo(groupId) as {
        gridInfoMap?: Record<string, {
          memVerList?: string[];
          currentMems?: Array<{ id: string; dName?: string; zaloName?: string }>;
          totalMember?: number;
          hasMoreMember?: number;
        }>;
      };
      groupData = info?.gridInfoMap?.[groupId] ?? null;
    }

    if (!groupData) {
      console.warn(`[Zalo] getGroupInfo: no data for group ${groupId}`);
      return;
    }

    // --- Step 2: names already embedded in currentMems (zero extra API calls) ---
    const knownNames = new Map<string, string>();
    for (const m of (groupData.currentMems ?? [])) {
      const name = m.dName?.trim() || m.zaloName?.trim();
      if (m.id && name) knownNames.set(m.id, name);
    }

    // memVerList entries are "uid_version" — extract all UIDs
    const allUids = (groupData.memVerList ?? [])
      .map(s => s.split('_')[0])
      .filter(Boolean);

    if (allUids.length === 0) {
      console.warn(`[Zalo] group ${groupId}: empty memVerList (totalMember=${groupData.totalMember})`);
      if (totalMember && totalMember > 0) {
        console.warn(`[Zalo] group ${groupId}: API returned no member IDs for ${totalMember} members; run /loginapp to scan hidden-member groups via PC App API.`);
      }
      return;
    }

    if (usedFallback && totalMember && allUids.length < totalMember) {
      console.warn(`[Zalo] group ${groupId}: web API returned ${allUids.length}/${totalMember} members; run /loginapp for the full hidden-member list.`);
    }

    // Save immediately for members already covered by currentMems
    let saved = 0;
    for (const uid of allUids) {
      const name = knownNames.get(uid);
      if (name) { userCache.saveForGroup(uid, name, groupId); saved++; }
    }

    // --- Step 3: remaining UIDs — try PC App profile endpoint first, then fall back ---
    const missingUids = allUids.filter(uid => !knownNames.has(uid));
    if (missingUids.length > 0) {
      // Try PC App endpoint (profile-wpa.zaloapp.com) — separate rate-limit bucket
      const appNames = await appGetGroupMembersInfo(missingUids).catch(() => null);
      if (appNames) {
        console.log(
          `[API][APP] getGroupMembersInfo group=${groupId} source=populateGroupMemberCache requested=${missingUids.length} resolved=${appNames.size}`,
        );
      } else {
        console.log(`[API][APP] getGroupMembersInfo group=${groupId} source=populateGroupMemberCache unavailable`);
      }
      const stillMissing: string[] = [];

      for (const uid of missingUids) {
        const name = appNames?.get(uid);
        if (name) { userCache.saveForGroup(uid, name, groupId); saved++; }
        else stillMissing.push(uid);
      }

      // Step 3.5: friend profile endpoint (PC App) for unresolved UIDs.
      const stillMissingAfterApp: string[] = [];
      if (stillMissing.length > 0) {
        const BATCH = 50;
        for (let i = 0; i < stillMissing.length; i += BATCH) {
          const batch = stillMissing.slice(i, i + BATCH);
          const profiles = await appGetFriendProfilesV2(batch, {
            phonebookVersion: 0,
            language: 'vi',
            showOnlineStatus: false,
          }).catch(() => null);
          if (profiles) {
            console.log(
              `[API][APP] getFriendProfilesV2 group=${groupId} source=populateGroupMemberCache batch=${batch.length} resolved=${profiles.size}`,
            );
          }

          for (const uid of batch) {
            const p = profiles?.get(uid);
            const name = p?.displayName?.trim() || p?.zaloName?.trim();
            if (uid && name) { userCache.saveForGroup(uid, name, groupId); saved++; }
            else stillMissingAfterApp.push(uid);
          }
        }
      }

      // Final fallback: zca-js getUserInfo (web API)
      if (stillMissingAfterApp.length > 0) {
        const BATCH = 50;
        for (let i = 0; i < stillMissingAfterApp.length; i += BATCH) {
          const batch = stillMissingAfterApp.slice(i, i + BATCH);
          console.log(
            `[API][WEB] getUserInfo group=${groupId} source=populateGroupMemberCache batch=${batch.length} fallback=app_unresolved`,
          );
          const resp = await api.getUserInfo(batch) as {
            changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
            unchanged_profiles?: Record<string, unknown>;
          };
          const profiles = resp?.changed_profiles ?? {};
          const unchanged = resp?.unchanged_profiles ?? {};
          for (const uid of batch) {
            const uidKey = uid.includes('_') ? uid : uid + '_0';
            const p = (profiles[uidKey] ?? profiles[uid] ?? unchanged[uidKey] ?? unchanged[uid]) as
              { displayName?: string; zaloName?: string } | undefined;
            const name = p?.displayName?.trim() || p?.zaloName?.trim();
            if (uid && name) { userCache.saveForGroup(uid, name, groupId); saved++; }
          }
        }
      }
    }

    console.log(`[Zalo] Cached ${saved}/${allUids.length} members for group ${groupId}` +
      (missingUids.length ? ` (currentMems: ${knownNames.size}, extra fetch: ${missingUids.length})` : ' (all from currentMems)') +
      (usedFallback && totalMember && allUids.length < totalMember ? ` — partial; /loginapp can fetch all ${totalMember}` : ''));
  } catch (err) {
    console.warn(`[Zalo] populateGroupMemberCache failed for ${groupId}:`, err);
  }
}

// ── Group info cache (avoid repeated getGroupInfo on every message) ───────────
interface GroupInfoEntry { name: string; avt?: string; ts: number }
const _groupInfoCache = new Map<string, GroupInfoEntry>();
const GROUP_INFO_TTL = 5 * 60 * 1000; // 5 min

function extractGroupInfoName(info: ZaloGroupInfoResponse | undefined, zaloId: string): string {
  const gridInfoMap = info?.gridInfoMap;
  if (!gridInfoMap) return '';

  const exact = gridInfoMap[zaloId]?.name?.trim();
  if (exact) return exact;

  const values = Object.values(gridInfoMap);
  if (values.length === 1) return values[0]?.name?.trim() ?? '';
  return '';
}

async function getCachedGroupInfo(
  api: ZaloAPI,
  zaloId: string,
): Promise<{ name?: string; avt?: string }> {
  const hit = _groupInfoCache.get(zaloId);
  if (hit && Date.now() - hit.ts < GROUP_INFO_TTL) return hit;

  try {
    const appInfo = await appGetGroupInfo(zaloId);
    if (appInfo?.name?.trim() || appInfo?.avt) {
      console.log(`[API][APP] getGroupInfo group=${zaloId} source=getCachedGroupInfo`);
      const entry: GroupInfoEntry = {
        name: appInfo.name?.trim() ?? '',
        avt:  appInfo.avt,
        ts:   Date.now(),
      };
      _groupInfoCache.set(zaloId, entry);
      return entry;
    }

    console.log(`[API][WEB] getGroupInfo group=${zaloId} source=getCachedGroupInfo fallback=app_empty`);
    const info = await api.getGroupInfo(zaloId) as ZaloGroupInfoResponse;
    const entry: GroupInfoEntry = {
      name: extractGroupInfoName(info, zaloId),
      avt:  info?.gridInfoMap?.[zaloId]?.avt,
      ts:   Date.now(),
    };
    _groupInfoCache.set(zaloId, entry);
    return entry;
  } catch { return {}; }
}

// ── Muted group cache (avoid repeated getMute on every message) ───────────────
interface ZaloMuteEntry {
  id: string;
  duration: number;
  startTime: number;
  systemTime?: number;
  currentTime?: number;
}

const MUTED_GROUPS_TTL = 60 * 1000; // 1 min
let _mutedCache: { groups: Set<string>; peers: Set<string>; ts: number } | null = null;

function isActiveMute(entry: ZaloMuteEntry): boolean {
  if (entry.duration === -1) return true;
  if (entry.duration <= 0) return false;

  const now = entry.currentTime ?? entry.systemTime ?? Math.floor(Date.now() / 1000);
  const expiresAt = entry.startTime + entry.duration;
  return now < expiresAt;
}

/**
 * Currently-muted Zalo thread ids, split into groups and DM peers, cached for a
 * minute. getMute() returns `groupChatEntries` (groups) and `chatEntries` (DMs).
 */
async function getMutedZaloIds(api: ZaloAPI): Promise<{ groups: Set<string>; peers: Set<string> }> {
  const cached = _mutedCache;
  if (cached && Date.now() - cached.ts < MUTED_GROUPS_TTL) return cached;

  try {
    const muteInfo = await api.getMute() as {
      groupChatEntries?: ZaloMuteEntry[];
      chatEntries?: ZaloMuteEntry[];
    };
    const groups = new Set((muteInfo.groupChatEntries ?? []).filter(isActiveMute).map(e => String(e.id)));
    const peers  = new Set((muteInfo.chatEntries ?? []).filter(isActiveMute).map(e => String(e.id)));
    _mutedCache = { groups, peers, ts: Date.now() };
    return _mutedCache;
  } catch (err) {
    console.warn('[Zalo→TG] Failed to fetch Zalo mute state:', err);
    return { groups: new Set(), peers: new Set() };
  }
}

/** Skip-muted-groups behavior (opt-in): drop messages from muted Zalo groups. */
async function isMutedZaloGroup(api: ZaloAPI, groupId: string): Promise<boolean> {
  if (!config.zalo.skipMutedGroups) return false;
  return (await getMutedZaloIds(api)).groups.has(groupId);
}

/**
 * Mirror Zalo's "mute notifications" onto Telegram: a thread muted on Zalo is
 * delivered silently (disable_notification) — the message still arrives, it just
 * doesn't ping. Covers both groups and DMs.
 */
async function isMutedOnZalo(api: ZaloAPI, threadId: string, type: 0 | 1): Promise<boolean> {
  if (!config.zalo.muteSilentMirror) return false;
  const { groups, peers } = await getMutedZaloIds(api);
  return type === 1 ? groups.has(threadId) : peers.has(threadId);
}

// In-flight topic creation promises — prevents duplicate topic creation when
// many messages arrive concurrently for the same conversation (e.g. 20-photo album).
const _pendingTopics = new Map<string, Promise<number>>();
const ZALO_DM_MENTION = process.env.ZALO_DM_MENTION?.trim() || '@chuc2rk';
const _pendingUserNameLookups = new Map<string, Promise<string>>();
const _deferredNameResolveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _deferredNameResolveAttempts = new Map<string, number>();

function scheduleDeferredNameResolve(api: ZaloAPI, uid: string): void {
  const cleanUid = uid.trim();
  if (!cleanUid || _deferredNameResolveTimers.has(cleanUid)) return;
  const attempts = _deferredNameResolveAttempts.get(cleanUid) ?? 0;
  if (attempts >= 3) return;

  // Back off instead of hammering Zalo after a 221/rate-limit window.
  const delayMs = [120_000, 300_000, 900_000][attempts] ?? 900_000;
  const timer = setTimeout(async () => {
    _deferredNameResolveTimers.delete(cleanUid);
    _deferredNameResolveAttempts.set(cleanUid, attempts + 1);
    try {
      const before = nameCache.preferred(cleanUid);
      const resolved = await resolveUserDisplayName(api, cleanUid);
      const after = nameCache.preferred(cleanUid, resolved);
      if (after && after !== cleanUid && after !== before) {
        console.log(`[Zalo] Deferred name resolve succeeded for ${cleanUid}: ${after}`);
        const topicId = store.getTopicByZalo(cleanUid, ThreadType.User);
        if (topicId !== undefined) await maybeRenameExistingDmTopic(topicId, cleanUid, after);
      } else if (!after || after === cleanUid) {
        scheduleDeferredNameResolve(api, cleanUid);
      }
    } catch (err) {
      console.warn(`[Zalo] Deferred name resolve failed for ${cleanUid}:`, err instanceof Error ? err.message : err);
      scheduleDeferredNameResolve(api, cleanUid);
    }
  }, delayMs);
  _deferredNameResolveTimers.set(cleanUid, timer);
}

async function resolveUserDisplayName(api: ZaloAPI, uid: string | undefined, fallback = 'ai đó'): Promise<string> {
  const cleanUid = uid?.trim();
  if (!cleanUid) {
    console.log(`[NameResolve][ZALO] uid=<empty> source=fallback_input name="${fallback}"`);
    return fallback;
  }

  const finalize = (source: string, rawName: string): string => {
    const name = rawName.trim();
    console.log(`[NameResolve][ZALO] uid=${cleanUid} source=${source} name="${name}"`);
    return name;
  };

  const persistentName = nameCache.preferred(cleanUid);
  if (persistentName) return finalize('nameCache.preferred', persistentName);

  const friend = friendsCache.get(cleanUid);
  const contactName = friend?.alias?.trim()
    || friend?.displayName?.trim()
    || aliasCache.get(cleanUid)?.trim();
  if (contactName) {
    nameCache.mergeContacts([{ userId: cleanUid, alias: friend?.alias, displayName: contactName }]);
    return finalize('friendsCache/contactAlias', contactName);
  }

  const cached = userCache.getName(cleanUid);
  if (cached?.trim()) {
    nameCache.mergeProfiles([{ userId: cleanUid, displayName: cached }]);
    return finalize('userCache', cached);
  }

  const inFlight = _pendingUserNameLookups.get(cleanUid);
  if (inFlight) {
    console.log(`[NameResolve][ZALO] uid=${cleanUid} source=inflight_reuse`);
    return inFlight;
  }

  const lookup = (async (): Promise<string> => {
    try {
      const names = await appGetGroupMembersInfo([cleanUid]);
      const appName = names?.get(cleanUid)?.trim();
      if (appName) {
        console.log(`[API][APP] getGroupMembersInfo uid=${cleanUid} source=resolveUserDisplayName`);
        userCache.save(cleanUid, appName);
        nameCache.mergeProfiles([{ userId: cleanUid, displayName: appName }]);
        return finalize('app.getGroupMembersInfo', appName);
      }
    } catch (err) {
      console.warn(`[Zalo] app member lookup failed for ${cleanUid}:`, err);
    }

    try {
      // Prefer PC App API scraped from asar:
      // POST /api/social/friend/getprofiles/v2
      const profiles = await appGetFriendProfilesV2([cleanUid], {
        phonebookVersion: 0,
        language: 'vi',
        showOnlineStatus: false,
      });
      const p = profiles?.get(cleanUid);
      const appName = p?.displayName?.trim() || p?.zaloName?.trim();
      if (appName) {
        console.log(`[API][APP] getFriendProfilesV2 uid=${cleanUid} source=resolveUserDisplayName`);
        userCache.save(cleanUid, appName);
        nameCache.mergeProfiles([{ userId: cleanUid, displayName: appName }]);
        return finalize('app.getFriendProfilesV2', appName);
      }
    } catch (err) {
      console.warn(`[Zalo] app profile lookup failed for ${cleanUid}:`, err);
    }

    try {
      console.log(`[API][WEB] getUserInfo uid=${cleanUid} source=resolveUserDisplayName fallback=app_empty`);
      const resp = await api.getUserInfo(cleanUid) as {
        changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        unchanged_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
      };
      // API appends "_0" to bare UIDs before sending, so the response key is "uid_0"
      const uidKey = cleanUid.includes('_') ? cleanUid : `${cleanUid}_0`;
      const profile =
        resp?.changed_profiles?.[uidKey] ??
        resp?.changed_profiles?.[cleanUid] ??
        resp?.unchanged_profiles?.[uidKey] ??
        resp?.unchanged_profiles?.[cleanUid];
      const name = profile?.displayName?.trim() || profile?.zaloName?.trim();
      if (name) {
        console.log(`[API][WEB] getUserInfo uid=${cleanUid} source=resolveUserDisplayName resolved`);
        userCache.save(cleanUid, name);
        nameCache.mergeProfiles([{ userId: cleanUid, displayName: name }]);
        return finalize('web.getUserInfo', name);
      }
    } catch (err) {
      console.warn(`[Zalo] resolveUserDisplayName failed for ${cleanUid}:`, err);
    }

    // Prefer the caller-supplied fallback (e.g. senderName from message data)
    // over the raw UID — only use UID when no real name is available at all.
    const fallbackName = (fallback && fallback !== 'ai đó') ? fallback : (cleanUid || fallback);
    if (!fallbackName || fallbackName === cleanUid) scheduleDeferredNameResolve(api, cleanUid);
    return finalize('fallback', fallbackName);
  })();

  _pendingUserNameLookups.set(cleanUid, lookup);
  try {
    return await lookup;
  } finally {
    if (_pendingUserNameLookups.get(cleanUid) === lookup) {
      _pendingUserNameLookups.delete(cleanUid);
    }
  }
}

async function maybeRenameExistingDmTopic(
  topicId: number,
  zaloId: string,
  displayName: string,
  force = false,
): Promise<void> {
  const entry = store.getEntryByTopic(topicId);
  if (!entry || entry.type !== ThreadType.User) return;
  if (!force && entry.name === displayName) return;

  const nextName = topicName(displayName, ThreadType.User);
  try {
    await tg.editForumTopic(config.telegram.groupId, topicId, { name: nextName });
    store.updateName(topicId, displayName);
    console.log(`[Zalo→TG] Renamed DM topic for ${zaloId}: "${entry.name}" → "${displayName}"${force ? ' (forced)' : ''}`);
  } catch (err) {
    if (isTopicDeletedError(err)) throw err;
    console.warn(`[Zalo→TG] Failed to rename DM topic ${topicId} for ${zaloId}:`, err);
  }
}


export async function syncDmTopicNamesFromCache(): Promise<{ checked: number; renamed: number; failed: number }> {
  let checked = 0;
  let renamed = 0;
  let failed = 0;
  for (const entry of store.all()) {
    if (entry.type !== ThreadType.User) continue;
    checked += 1;
    const preferred = nameCache.preferred(entry.zaloId);
    if (!preferred || preferred === entry.name) continue;
    try {
      await maybeRenameExistingDmTopic(entry.topicId, entry.zaloId, preferred);
      renamed += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[Zalo→TG] Failed cache topic-name sync for ${entry.zaloId}:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked, renamed, failed };
}

async function getOrCreateTopic(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl?: string,
  forceRecreate = false,
): Promise<number> {
  if (!forceRecreate) {
    const existing = store.getTopicByZalo(zaloId, type);
    if (existing !== undefined) {
      await maybeRenameExistingDmTopic(existing, zaloId, displayName);
      return existing;
    }
  }

  const pendingKey = `${type}:${zaloId}`;
  const inFlight = _pendingTopics.get(pendingKey);
  if (inFlight) return inFlight;

  const promise = _doCreateTopic(zaloId, type, displayName, avatarUrl)
    .finally(() => _pendingTopics.delete(pendingKey));
  _pendingTopics.set(pendingKey, promise);
  return promise;
}

/**
 * Check if a TG API error means the topic/thread was deleted.
 * If so, remove the stale mapping and re-throw so the caller can recreate.
 */
function isTopicDeletedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('message thread not found') || msg.includes('TOPIC_CLOSED') || msg.includes('thread not found');
}

/**
 * Wrapper around a TG send call: if it fails because the topic was deleted,
 * remove stale mapping, recreate the topic, and retry once.
 */
async function sendWithTopicRecovery<T>(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl: string | undefined,
  sendFn: (topicId: number) => Promise<T>,
  currentTopicId: number,
): Promise<T> {
  try {
    return await sendFn(currentTopicId);
  } catch (err) {
    if (!isTopicDeletedError(err)) throw err;
    console.warn(`[Zalo→TG] Topic ${currentTopicId} deleted — removing mapping and recreating for ${zaloId}`);
    store.remove(currentTopicId);
    const newTopicId = await getOrCreateTopic(zaloId, type, displayName, avatarUrl, true);
    return sendFn(newTopicId);
  }
}

async function _doCreateTopic(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl?: string,
): Promise<number> {
  // Re-check after acquiring "lock" — another concurrent call may have finished
  const existing = store.getTopicByZalo(zaloId, type);
  if (existing !== undefined) return existing;

  const name  = topicName(displayName, type);
  const color = type === ThreadType.Group ? 0xFF93B2 : 0x6FB9F0;

  let topic: { message_thread_id: number };
  try {
    topic = await tg.createForumTopic(
      config.telegram.groupId,
      name,
      { icon_color: color },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not enough rights') || msg.includes('TOPIC_') || msg.includes('rights to manage')) {
      console.error(`[Zalo→TG] Cannot create topic — bot lacks "Manage Topics" admin right. Falling back to General topic.`);
      // Use topic ID 1 (General) as fallback so messages still get delivered
      const fallbackId = 1;
      store.set({ topicId: fallbackId, zaloId, type, name: displayName });
      return fallbackId;
    }
    throw err;
  }

  const topicId = topic.message_thread_id;
  store.set({ topicId, zaloId, type, name: displayName });
  console.log(`[Zalo→TG] New topic: "${name}" (topicId=${topicId})`);

  // Pin group avatar as the first message in the topic
  if (type === 1 /* Group */ && avatarUrl) {
    try {
      const localPath = await downloadToTemp(avatarUrl, `avatar_${Date.now()}.jpg`);
      const stream = createReadStream(localPath);
      const avatarMsg = await tg.sendPhoto(
        config.telegram.groupId,
        { source: stream },
        {
          message_thread_id: topicId,
          caption: `🖼 Ảnh đại diện nhóm <b>${escapeHtml(displayName)}</b>`,
          parse_mode: 'HTML',
        },
      );
      await cleanTemp(localPath);
      try {
        await tg.pinChatMessage(config.telegram.groupId, avatarMsg.message_id, { disable_notification: true });
      } catch { /* pinning requires admin rights */ }
    } catch (avatarErr) {
      console.warn(`[Zalo→TG] Failed to pin group avatar for ${displayName}:`, avatarErr);
    }
  }

  return topicId;
}

/**
 * Parse `content` field which is either a JSON string, a plain string, or
 * already an object. Returns a normalised `ZaloMediaContent` object.
 */
function parseContent(raw: string | ZaloMediaContent | Record<string, unknown>): {
  text: string | null;
  media: ZaloMediaContent;
} {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as ZaloMediaContent;
      return { text: null, media: parsed };
    } catch {
      // plain text string
      return { text: raw, media: {} };
    }
  }
  return { text: null, media: raw as ZaloMediaContent };
}

// ── Poll helpers ─────────────────────────────────────────────────────────────

import type { PollOptions } from 'zca-js';

function buildScoreText(header: string, options: Pick<PollOptions, 'content' | 'votes'>[], closed: boolean): string {
  const total = options.reduce((s, o) => s + (o.votes ?? 0), 0);
  const lines = options.map(o => {
    const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `${escapeHtml(o.content)}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
  });
  const status = closed ? ' <i>[Đã đóng]</i>' : '';
  return `📊 <b>${escapeHtml(header)}</b>${status}\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
}

// ── Main handler ─────────────────────────────────────────────────────────────

/** Track which groups already had their member cache populated this session. */
const _memberCacheLoaded = new Set<string>();

/** Clear the loaded-set so a fresh Web/App login can repopulate group members. */
export function resetMemberCacheLoaded(): void {
  _memberCacheLoaded.clear();
}

/**
 * In-flight dedup set — holds msgIds that are currently being processed.
 * Prevents race condition where multiple reaction re-emits arrive concurrently
 * before any of them is saved to msgStore, causing all to pass the msgStore check.
 */
const _inFlightMsgIds = new Set<string>();

type HistoricalZaloMessage = ZaloMessage & { __catchup?: true };

function normalizeHistoryMessage(raw: unknown, groupId: string): HistoricalZaloMessage | null {
  const candidate = raw as Partial<ZaloMessage> & { data?: ZaloMessage['data'] };
  const data = candidate?.data;
  if (!data?.msgId) return null;
  return {
    type: ThreadType.Group,
    threadId: candidate.threadId ?? groupId,
    isSelf: Boolean(candidate.isSelf),
    data,
    __catchup: true,
  };
}

/** The active 'message' handler, captured so /history can replay messages
 *  through the exact same pipeline AND await each one (guaranteeing order,
 *  which `listener.emit` cannot since the handler is async and not awaited). */
let _activeMessageHandler: ((msg: ZaloMessage | HistoricalZaloMessage) => Promise<void>) | null = null;

/**
 * Replay messages through the live message pipeline, one at a time, awaiting
 * each so they render to Telegram in the given order. Returns the count
 * processed. Used by the /history backfill command.
 */
export async function replayHistoryMessages(messages: ZaloMessage[], gapMs = 250): Promise<number> {
  const handler = _activeMessageHandler;
  if (!handler) return 0;
  let processed = 0;
  for (const msg of messages) {
    try {
      await handler(msg);
      processed++;
    } catch (err) {
      console.warn('[replayHistory] handler error:', err);
    }
    if (gapMs > 0) await new Promise(r => setTimeout(r, gapMs));
  }
  return processed;
}

async function catchUpMissedGroupMessages(
  api: ZaloAPI,
  handleZaloMessage: (msg: HistoricalZaloMessage) => Promise<void>,
): Promise<void> {
  // Zalo does not replay websocket events that arrive while the bridge is
  // restarting. After listener startup, scan a tiny history window and forward
  // only messages that are not already in msgStore. This makes restarts safe.
  const groups = store.all().filter(e => e.type === 1);
  let forwarded = 0;
  for (const entry of groups) {
    try {
      const history = await api.getGroupChatHistory(entry.zaloId, 5) as { groupMsgs?: unknown[] };
      const msgs = (history.groupMsgs ?? [])
        .map(raw => normalizeHistoryMessage(raw, entry.zaloId))
        .filter((m): m is HistoricalZaloMessage => m !== null)
        .sort((a, b) => Number(a.data.ts || 0) - Number(b.data.ts || 0));
      for (const msg of msgs) {
        const ids = [msg.data.msgId, msg.data.realMsgId, msg.data.cliMsgId]
          .filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== '0');
        if (ids.some(id => msgStore.getTgMsgId(id) !== undefined)) continue;

        // Only catch up recent missed messages. Old group history is intentionally
        // ignored to avoid flooding Telegram on first install/reconfigure.
        const ts = Number(msg.data.ts || 0);
        if (ts > 0 && Date.now() - ts > 15 * 60_000) continue;

        console.log(`[Zalo→TG] Catch-up missed message group=${entry.zaloId} msgId=${msg.data.msgId}`);
        await handleZaloMessage(msg);
        forwarded++;
      }
      // Small delay keeps the startup scan gentle across many groups.
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.warn(`[Zalo→TG] Catch-up failed for group ${entry.zaloId}:`, err instanceof Error ? err.message : err);
    }
  }
  if (forwarded > 0) console.log(`[Zalo→TG] Catch-up forwarded ${forwarded} missed message(s)`);
}


export async function setupZaloHandler(api: ZaloAPI): Promise<void> {
  // Warm only a small slice of existing group topics on startup. Older code
  // tried to preload every mapped group and marked all of them as loaded before
  // the API calls actually succeeded; accounts in many large groups could hit
  // Zalo 221 / retry-limit immediately and then never lazy-retry those groups.
  // Leave unscheduled groups out of _memberCacheLoaded so the first live message
  // can lazy-load them later.
  const allStartupGroups = store.all().filter(e => e.type === 1 /* Group */);
  const startupGroups = allStartupGroups.slice(0, config.zalo.startupMemberPreloadMax);
  if (allStartupGroups.length > startupGroups.length) {
    console.log(`[Zalo] Startup member-cache warmup limited to ${startupGroups.length}/${allStartupGroups.length} groups; remaining groups lazy-load on first message`);
  }
  void (async () => {
    for (let i = 0; i < startupGroups.length; i++) {
      const groupId = startupGroups[i].zaloId;
      // A live message may have already warmed this group via the lazy path
      // during the stagger window — don't redo it, and don't mark groups
      // "loaded" up-front for groups whose cache hasn't actually populated yet.
      if (_memberCacheLoaded.has(groupId)) continue;
      // Keep fork's configurable delay instead of upstream's hard-coded 2s.
      if (i > 0) await new Promise(r => setTimeout(r, config.zalo.startupMemberPreloadDelayMs));
      _memberCacheLoaded.add(groupId);
      void populateGroupMemberCache(api, groupId);
    }
  })();

  // Load address-book names BEFORE attaching listeners so that the first
  // message event already has names available for topic naming.
  // getAliasList only returns explicitly set aliases (small subset), while
  // getAllFriends returns the full contact list with displayName already using
  // the saved contact name when present.
  try {
    let aliasCount = 0;
    const aliasResult = await api.getAliasList() as { items?: Array<{ userId: string; alias: string }> };
    if (aliasResult?.items?.length) {
      aliasCache.setAll(aliasResult.items);
      aliasCount = aliasResult.items.length;
    }

    let friendCount = 0;
    const friends = await api.getAllFriends() as Array<{
      userId: string;
      displayName?: string;
      zaloName?: string;
      username?: string;
    }>;
    if (Array.isArray(friends) && friends.length) {
      friendsCache.set(friends.map(f => ({
        userId:      f.userId,
        // zca-js User.displayName is the logged-in account's address-book label.
        // zaloName is the public profile name. Do NOT overwrite displayName with
        // getAliasList-only aliases, or we lose saved contact names such as "Tỷ cưng".
        displayName: (f.displayName || f.zaloName || f.username || f.userId).trim(),
      })));
      nameCache.mergeContacts(friends.map(f => ({
        userId: f.userId,
        displayName: (f.displayName || f.zaloName || f.username || f.userId).trim(),
      })));
      friendCount = friends.length;
    }

    console.log(`[Zalo] Loaded ${aliasCache.size()} contact names (${aliasCount} aliases, ${friendCount} friends)`);
  } catch (err) {
    console.warn('[Zalo] Failed to load address-book names:', err);
  }

  const handleZaloMessage = async (msg: HistoricalZaloMessage | ZaloMessage): Promise<void> => {
    try {
      // Skip TG→Zalo echo (re-emitted by Zalo server) but forward
      // real self messages sent directly from the Zalo app.
      if (msg.isSelf) {
        // Hydrate quote metadata from self echo:
        // TG→Zalo media is first stored with placeholder quote data; when echo
        // arrives we replace it with real msgType/content so future replies in
        // Telegram produce native quote previews in Zalo.
        const selfMsgIds = [
          msg.data.msgId,
          msg.data.realMsgId ?? '',
          msg.data.cliMsgId ?? '',
        ].filter((id): id is string => Boolean(id) && id !== '0');

        const _tgId = selfMsgIds
          .map(id => msgStore.getTgMsgId(id) ?? sentMsgStore.getByZaloMsgId(id))
          .find((id): id is number => id !== undefined);

        const { text: _echoText, media: _echoMedia } = parseContent(msg.data.content);
        const _echoContent = _echoText !== null ? _echoText : (_echoMedia as Record<string, unknown>);
        const _echoPatch = {
          msgId: msg.data.msgId || msg.data.realMsgId || '',
          cliMsgId: msg.data.cliMsgId ?? '',
          msgType: msg.data.msgType ?? ZALO_MSG_TYPES.TEXT,
          content: _echoContent,
          ts: msg.data.ts,
          ttl: msg.data.ttl ?? 0,
        };

        if (_tgId !== undefined) {
          // Update all known echo IDs for the original TG message so later
          // reply chains can resolve by msgId, realMsgId, or cliMsgId.
          sentMsgStore.save(_tgId, {
            // Keep all IDs mapped for reverse lookup, but prefer the server/global
            // msgId first. cliMsgId may be present in self-echo and is useful for
            // quoting, but trying to undo it as a separate message causes false
            // partial failures (e.g. "1/2 recalled") after the real msgId succeeds.
            msgIds: selfMsgIds,
            zaloId: msg.threadId,
            threadType: msg.type as 0 | 1,
          });
          sentMsgStore.updatePrimaryMsgId(_tgId, msg.data.realMsgId && msg.data.realMsgId !== '0' ? msg.data.realMsgId : msg.data.msgId);
          msgStore.attachQuote(selfMsgIds, {
            msgId: msg.data.realMsgId && msg.data.realMsgId !== '0' ? msg.data.realMsgId : msg.data.msgId,
            cliMsgId: msg.data.cliMsgId ?? msg.data.msgId,
            uidFrom: msg.data.uidFrom ?? String(api.getOwnId?.() ?? ''),
            ts: msg.data.ts,
            msgType: msg.data.msgType ?? ZALO_MSG_TYPES.TEXT,
            content: _echoContent,
            ttl: msg.data.ttl ?? 0,
            zaloId: msg.threadId,
            threadType: msg.type as 0 | 1,
          });
          msgStore.updateQuoteFromEcho(_tgId, _echoPatch);
        } else {
          // Echo can arrive before TG→Zalo sendMessage resolves/saves the mapping.
          // Keep it briefly and let msgStore.save() hydrate the quote later.
          msgStore.rememberPendingQuoteEcho(selfMsgIds, _echoPatch);
        }

        // If any self-echo ID is already tracked in sentMsgStore OR we're in the
        // middle of sending to this Zalo thread → it's an echo, skip.
        const isEcho = selfMsgIds.some(id => sentMsgStore.getByZaloMsgId(id) !== undefined)
          || sentMsgStore.isSendingTo(msg.threadId);
        if (isEcho) {
          console.log(`[Zalo→TG] Skip echo self message (${selfMsgIds.join(', ')})`);
          return;
        }
        // Real self message from Zalo app — fall through and forward to Telegram
      }

      // Skip duplicate deliveries — Zalo re-emits the same message event when
      // someone reacts (❤️, 👍, etc.), causing the same content to be forwarded
      // multiple times. Check both the persistent store AND the in-flight set
      // (handles concurrent re-emits that arrive before any is saved to msgStore).
      const _primaryMsgId = msg.data.msgId;
      if (_primaryMsgId) {
        if (msgStore.getTgMsgId(_primaryMsgId) !== undefined || _inFlightMsgIds.has(_primaryMsgId)) {
          console.log(`[Zalo→TG] Skip duplicate/reaction re-emit msgId=${_primaryMsgId}`);
          return;
        }
        _inFlightMsgIds.add(_primaryMsgId);
        // Auto-remove from in-flight after 10 s (msgStore.save will be the permanent record)
        setTimeout(() => _inFlightMsgIds.delete(_primaryMsgId), 10_000);
      }

      const zaloId     = msg.threadId;
      const type       = msg.type as 0 | 1;
      const ownUid     = String(api.getOwnId?.() ?? '');
      const senderUid  = msg.isSelf && ownUid ? ownUid : (msg.data.uidFrom ?? '');
      const senderName = msg.isSelf ? 'Bạn' : (msg.data.dName ?? msg.data.uidFrom);
      const msgType    = msg.data.msgType ?? ZALO_MSG_TYPES.TEXT;

      if (type === ThreadType.Group && await isMutedZaloGroup(api, zaloId)) {
        console.log(`[Zalo→TG] Skip muted group ${zaloId}`);
        return;
      }

      // Mirror Zalo's mute → deliver this thread silently on Telegram. Computed
      // once here (before any message-type branch) so every send path can use it.
      const silent = await isMutedOnZalo(api, zaloId, type);

      // Pre-populate member cache the first time we see a new group
      if (type === 1 && !_memberCacheLoaded.has(zaloId)) {
        _memberCacheLoaded.add(zaloId);
        void populateGroupMemberCache(api, zaloId);
      }

      // Auto-reply (offline mode): answer incoming text DMs when enabled.
      // Fire-and-forget; only 1-1 threads are answered (see autoReply.ts).
      // Gate on TEXT so we never auto-reply to stickers/media/system events.
      if (!msg.isSelf && msgType === ZALO_MSG_TYPES.TEXT) {
        void maybeAutoReply(api, zaloId, type);
      }

      // Parse content early so we can start media download in parallel with topic resolution
      const { text, media } = parseContent(msg.data.content);

      // Determine media URL eagerly (before topic lookup) so download starts immediately
      const _eagerMediaUrl = (() => {
        if (msgType === ZALO_MSG_TYPES.VIDEO || msgType === ZALO_MSG_TYPES.VOICE ||
            msgType === ZALO_MSG_TYPES.GIF   || msgType === ZALO_MSG_TYPES.FILE) return media.href;
        // PHOTO is intentionally excluded: it may belong to an album. Starting
        // an eager download here caused album photos to be downloaded twice and
        // left the unused early temp files behind.
        return undefined;
      })();
      const _extGuess = _eagerMediaUrl
        ? (path.extname(_eagerMediaUrl.split('?')[0] ?? '').toLowerCase() || '.bin')
        : '.bin';
      // Start download immediately; we'll await it inside the type-specific branch
      const earlyDlPromise = _eagerMediaUrl
        ? downloadToTemp(_eagerMediaUrl, `dl_${Date.now()}${_extGuess}`)
        : null;

      // Resolve display name:
      //   - Group: use group name from getGroupInfo for topic, but use the sender's
      //     contact-book name in message captions/headers when available.
      //   - DM: use the PEER's contact-book name (zaloId = peer UID), not the raw sender dName.
      // NOTE: We do NOT pass `senderName` (msg.data.dName) as fallback to
      // resolveUserDisplayName because Zalo's dName field is unreliable — it can
      // contain filenames or metadata (e.g. "My Documents") instead of the sender's
      // real name. The default fallback chain (UID → 'ai đó') is safer.
      let displayName = senderName;
      let bridgeSenderName = msg.isSelf ? senderName : await resolveUserDisplayName(api, senderUid);
      let groupAvatarUrl: string | undefined;
      if (type === ThreadType.Group) {
        const info = await getCachedGroupInfo(api, zaloId);
        displayName = info.name || senderName;
        groupAvatarUrl = info.avt;
      } else {
        // For DMs, zaloId is the peer's UID — resolve their real name for the topic name.
        // bridgeSenderName is already set correctly above (sender's name, or 'Bạn' if isSelf).
        const realName = await resolveUserDisplayName(api, zaloId);
        displayName = realName;
      }

      // Keep userCache up-to-date so TG→Zalo mention resolution works.
      // Use the resolved bridgeSenderName rather than the raw senderName (dName)
      // to avoid caching metadata-like values (e.g. "My Documents").
      if (type === ThreadType.Group && senderUid) {
        userCache.saveForGroup(senderUid, bridgeSenderName, zaloId);
      } else if (senderUid) {
        userCache.save(senderUid, bridgeSenderName);
      }

      const topicId = await getOrCreateTopic(zaloId, type, displayName, groupAvatarUrl);

      // Resolve Telegram reply target from incoming Zalo quote (if any)
      let tgReplyMsgId: number | undefined;
      if (msg.data.quote) {
        // Zalo sets globalMsgId=0 for DMs — fall back to cliMsgId in that case.
        // Build a list of candidate IDs to try in order.
        const _candidateIds: string[] = [];
        const _g = msg.data.quote.globalMsgId;
        const _c = msg.data.quote.cliMsgId;
        if (_g && _g !== 0) _candidateIds.push(String(_g));
        if (_c && _c !== 0) _candidateIds.push(String(_c));

        for (const globalId of _candidateIds) {
          if (tgReplyMsgId !== undefined) break;
          // Primary: messages received from Zalo and forwarded to TG.
          // IMPORTANT: Zalo globalMsgId is NOT unique across groups — validate the found
          // mapping belongs to the same thread to avoid quoting a message from a different group.
          const _candidateTg = msgStore.getTgMsgId(globalId);
          if (_candidateTg !== undefined) {
            const _quoteData = msgStore.getQuote(_candidateTg);
            if (!_quoteData || _quoteData.zaloId === zaloId) {
              tgReplyMsgId = _candidateTg;
              break;
            } else {
              console.warn(`[Zalo→TG] Quote msgId=${globalId} maps to thread ${_quoteData.zaloId} but current thread is ${zaloId} — ignoring stale cross-group mapping`);
            }
          }
          // Fallback: messages we sent from TG to Zalo (reverse lookup), also validate thread
          const _sentTg = sentMsgStore.getByZaloMsgId(globalId);
          if (_sentTg !== undefined) {
            const _sentInfo = sentMsgStore.get(_sentTg);
            if (!_sentInfo || _sentInfo.zaloId === zaloId) {
              tgReplyMsgId = _sentTg;
              break;
            }
          }
        }
      }

      // Base TG send options (with optional reply_parameters)
      const tgBase: {
        message_thread_id: number;
        reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
        disable_notification?: boolean;
      } = { message_thread_id: topicId };
      if (tgReplyMsgId !== undefined) {
        tgBase.reply_parameters = { message_id: tgReplyMsgId, allow_sending_without_reply: true };
      }
      if (silent) tgBase.disable_notification = true;

      // Preserve the old DM notification behavior: any incoming Zalo DM is
      // forwarded inside its Telegram topic with @chuc2rk prefixed, so Telegram
      // actually alerts Chức even when the topic/chat is otherwise muted.
      const shouldMentionDm = type === ThreadType.User && !msg.isSelf;
      const withDmMention = (html: string): string => shouldMentionDm
        ? `${escapeHtml(ZALO_DM_MENTION)}
${html}`
        : html;
      const senderCaption = groupCaption(bridgeSenderName, senderUid);
      const appendSenderFooter = (bodyHtml?: string): string => withDmMention(
        bodyHtml
          ? `${bodyHtml}\n${senderCaption}`
          : senderCaption,
      );
      const caption = appendSenderFooter();
      const tgOpts  = { ...tgBase, parse_mode: 'HTML' as const, caption };

      // Build quote data + mapping helper — saved after every successful TG send
      const zaloMsgIds = [
        msg.data.msgId,
        ...(msg.data.realMsgId && msg.data.realMsgId !== msg.data.msgId ? [msg.data.realMsgId] : []),
        ...(msg.data.cliMsgId && msg.data.cliMsgId !== msg.data.msgId ? [msg.data.cliMsgId] : []),
      ];
      const zaloQuoteData: ZaloQuoteData = {
        msgId:    msg.data.msgId,
        cliMsgId: msg.data.cliMsgId ?? '',
        uidFrom:  senderUid,
        ts:       msg.data.ts,
        msgType:  msgType,
        // zca-js builds qmsgAttach from object content. File quotes need the
        // attachment object so Zalo app can render the native file preview/card.
        // Keep the whole parsed media payload for both DM and group files; text
        // fallback is still handled by TG→Zalo retry-without-quote on code 114.
        content:  msgType === ZALO_MSG_TYPES.FILE
          ? (media as Record<string, unknown>)
          : (text !== null
              ? (msg.data.content as string)
              : (media as Record<string, unknown>)),
        ttl:      msg.data.ttl ?? 0,
        ...(msg.data.propertyExt ? { propertyExt: msg.data.propertyExt } : {}),
        zaloId,
        threadType: type,
      };
      const saveTgMapping = (sent: { message_id: number }) => {
        msgStore.save(sent.message_id, zaloMsgIds, zaloQuoteData);
      };

      // ── 1. Plain text / rich text ─────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.TEXT || (text !== null)) {
        // Zalo rich-text messages still use msgType "webchat", but content is
        // an object like { title, action: "rtf", params: "{styles:...}" }.
        // Without using media.title here, formatted announcements silently drop.
        const body = text
          ?? ((typeof msg.data.content === 'string' ? msg.data.content : '')
            || media.title
            || '');
        if (!body.trim()) return;
        const mentions = msg.data.mentions;

        // Parse Zalo text-style metadata (bold, italic, underline, strike).
        // Rich text may store styles in msg.data.textProperties OR media.params.
        let styles: ZaloStyle[] | undefined;
        for (const rawProps of [
          (msg.data as unknown as Record<string, unknown>).textProperties,
          media.params,
        ]) {
          try {
            if (typeof rawProps === 'string' && rawProps) {
              const parsed = JSON.parse(rawProps) as { styles?: ZaloStyle[] };
              if (Array.isArray(parsed.styles) && parsed.styles.length > 0) {
                styles = parsed.styles;
                break;
              }
            }
          } catch { /* ignore malformed style metadata */ }
        }

        const safeBody = truncate(body);
        const safeStyles = styles
          ?.filter(s => s.start < safeBody.length)
          .map(s => ({ ...s, len: Math.min(s.len, safeBody.length - s.start) }));
        const ownUid = String(api.getOwnId?.() ?? '');
        const isOwnMentionLabel = (label: string): boolean => {
          const norm = label
            .replace(/^@/, '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
          return norm === 'chuc' || norm === 'chucnd' || norm === 'chuc2rk' || norm.includes('chuc nguyen');
        };
        const safeMentions = mentions
          ?.filter(m => m.pos < safeBody.length)
          .map(m => {
            const len = Math.min(m.len, safeBody.length - m.pos);
            const originalMentionText = safeBody.slice(m.pos, m.pos + len);
            const resolvedContactName = m.type === 0
              ? (nameCache.preferred(m.uid)
                || friendsCache.get(m.uid)?.alias?.trim()
                || aliasCache.get(m.uid)?.trim()
                || friendsCache.get(m.uid)?.displayName?.trim())
              : undefined;
            // Critical: when someone mentions Chức on Zalo, keep the Telegram
            // username in the forwarded text so Telegram actually triggers a
            // notification. Contact-name labels like @Chuc/@Chức render nicely
            // but do not notify @chuc2rk. Some Zalo mention events can carry an
            // unexpected uid, so also recognise the visible/or resolved label.
            const contactName = m.type === 0
              ? ((m.uid === ownUid || isOwnMentionLabel(originalMentionText) || (resolvedContactName && isOwnMentionLabel(resolvedContactName)))
                ? 'chuc2rk'
                : resolvedContactName)
              : undefined;
            if (m.type === 0) {
              console.log(`[Zalo→TG] mention uid=${m.uid} own=${ownUid} text="${originalMentionText}" label="${contactName ?? ''}"`);
            }
            return {
              ...m,
              len,
              label: contactName ? `@${contactName}` : undefined,
            };
          });
        const bodyHtml = (safeMentions?.length || safeStyles?.length)
          ? applyZaloMarkupHtml(safeBody, safeMentions, safeStyles)
          : escapeHtml(safeBody);
        const tgText = withDmMention(formatGroupMsgHtml(bridgeSenderName, bodyHtml, senderUid));
        const sent = await tg.sendMessage(
          config.telegram.groupId,
          tgText,
          { ...tgBase, parse_mode: 'HTML' },
        );
        saveTgMapping(sent);
        return;
      }

      // ── 2. Photo / Image ───────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.PHOTO) {
        // prefer HD from params, fall back to href
        let url = media.href;
        if (media.params) {
          try {
            const p = JSON.parse(media.params) as { hd?: string };
            if (p.hd) url = p.hd;
          } catch { /* ignore */ }
        }
        if (!url) { console.warn('[ZaloHandler] Photo: no URL found in content:', media); return; }

        // Caption attached to the photo by the sender (Zalo stores it in the `title` field)
        const photoCaption = media.title?.trim() || undefined;

        const childnumber: number = (media as { childnumber?: number }).childnumber ?? 0;
        const albumKey = `${zaloId}:${senderUid}`;

        console.log(`[ZaloHandler] Photo: msgId=${msg.data.msgId} childnumber=${childnumber} group=${type === 1} url=${url.substring(0, 80)}...`);

        // If childnumber > 0 OR there's already a buffer for this key → album mode
        // (detected via the add callback which reuses or creates the buffer)

        zaloAlbumStore.add(
          albumKey,
          { url, msgIds: zaloMsgIds, quote: zaloQuoteData, caption: photoCaption },
          { senderName: bridgeSenderName, topicId, tgBase },
          async (buf) => {
            if (buf.items.length === 1) {
              const item = buf.items[0]!;
              const localPath = await downloadToTemp(item.url, `photo_${Date.now()}.jpg`);
              const stream = createReadStream(localPath);
              try {
                const sent = await tg.sendPhoto(
                  config.telegram.groupId,
                  { source: stream },
                  {
                    ...buf.tgBase,
                    parse_mode: 'HTML' as const,
                    caption: item.caption
                      ? appendSenderFooter(escapeHtml(item.caption))
                      : appendSenderFooter(),
                  },
                );
                // Use the item's quote which already has the correct cliMsgId and
                // parsed media content object (not raw JSON string).
                msgStore.save(sent.message_id, item.msgIds, item.quote);
              } finally { await cleanTemp(localPath); }
            } else {
              // Multi-photo album — download all concurrently and send as media group
              const localPaths: string[] = [];
              try {
                const dlResults = await Promise.allSettled(
                  buf.items.map(item => downloadToTemp(item.url, `photo_${Date.now()}.jpg`)),
                );
                const downloadedItems = dlResults.flatMap((result, index) => {
                  if (result.status === 'fulfilled') {
                    return [{ localPath: result.value, item: buf.items[index]! }];
                  }
                  console.warn('[ZaloHandler] Album: skipping failed photo download:', result.reason);
                  return [];
                });
                if (downloadedItems.length === 0) return;
                localPaths.push(...downloadedItems.map(item => item.localPath));
                const albumCaption = downloadedItems.find(item => item.item.caption)?.item.caption;
                const captionText = albumCaption
                  ? appendSenderFooter(escapeHtml(albumCaption))
                  : appendSenderFooter();
                // Telegram limits media groups to 10 items — split into batches
                const BATCH = 10;
                for (let i = 0; i < downloadedItems.length; i += BATCH) {
                  const batch = downloadedItems.slice(i, i + BATCH);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const mediaItems: any[] = batch.map(({ localPath }, j) => ({
                    type: 'photo',
                    media: { source: createReadStream(localPath) },
                    ...(i === 0 && j === 0 && captionText ? { caption: captionText, parse_mode: 'HTML' } : {}),
                  }));
                  const sentMsgs = await tg.sendMediaGroup(
                    config.telegram.groupId,
                    mediaItems,
                    { ...buf.tgBase, message_thread_id: buf.topicId } as Parameters<typeof tg.sendMediaGroup>[2],
                  );
                  // Keep the mapping one-to-one. Failed downloads were removed
                  // before batching, so sentMsgs[j] still matches batch[j].
                  for (let j = 0; j < sentMsgs.length; j++) {
                    const sentMsg = sentMsgs[j];
                    const downloaded = batch[j];
                    if (sentMsg && downloaded) {
                      msgStore.save(sentMsg.message_id, downloaded.item.msgIds, downloaded.item.quote);
                    }
                  }
                }
              } finally {
                for (const lp of localPaths) await cleanTemp(lp);
              }
            }
          },
          childnumber,
        );

        return;
      }

      // ── 2b. Doodle (sketch/drawing) ────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.DOODLE) {
        const url = media.href || media.thumb;
        if (!url) { console.warn('[ZaloHandler] Doodle: no URL'); return; }
        const localPath = await downloadToTemp(url, `doodle_${Date.now()}.jpg`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }


      if (msgType === ZALO_MSG_TYPES.GIF) {
        const url = media.href;
        if (!url) {
          console.warn('[ZaloHandler] GIF: no URL found in content:', media);
          return;
        }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.mp4';
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `gif_${Date.now()}${ext}`));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendAnimation(
            config.telegram.groupId,
            { source: stream },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 4. File ────────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.FILE) {
        const url = media.href;
        // title holds the original filename (e.g. "report.pdf")
        const fileName = media.title ?? `file_${Date.now()}`;
        if (!url) {
          console.warn('[ZaloHandler] File: no URL found in content:', media);
          return;
        }
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, fileName));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendDocument(
            config.telegram.groupId,
            { source: stream, filename: fileName },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 5. Video ───────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.VIDEO) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Video: no URL found in content:', media); return; }
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `video_${Date.now()}.mp4`));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendVideo(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 6. Voice ───────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.VOICE) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Voice: no URL found in content:', media); return; }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.m4a';
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `voice_${Date.now()}${ext}`));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendVoice(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 7. Sticker – fetch real URL via getStickersDetail ──────────────────
      if (msgType === ZALO_MSG_TYPES.STICKER) {
        const stickerId = Number(media.id);
        if (!Number.isFinite(stickerId) || stickerId <= 0) {
          console.warn('[ZaloHandler] Sticker: no id in content:', media);
          return;
        }
        try {
          const details = await api.getStickersDetail(stickerId) as Array<{
            stickerWebpUrl?: string | null;
            stickerUrl?: string;
            stickerSpriteUrl?: string;
            totalFrames?: number;
            duration?: number;
          }>;
          const detail = details?.[0];
          if (!detail) {
            console.warn(`[ZaloHandler] Sticker #${stickerId}: detail API returned no data`);
            return;
          }

          const totalFrames = Number(detail.totalFrames ?? 0);
          const isAnimated = Boolean(detail.stickerSpriteUrl && totalFrames > 1);
          if (isAnimated) {
            let spritePath: string | undefined;
            let gifPath: string | undefined;
            try {
              spritePath = await downloadToTemp(
                detail.stickerSpriteUrl!,
                `sticker_sprite_${Date.now()}.png`,
              );
              gifPath = await convertSpriteSheetToGif(
                spritePath,
                totalFrames,
                Number(detail.duration ?? 100),
              );
              const stream = createReadStream(gifPath);
              const sent = await tg.sendAnimation(
                config.telegram.groupId,
                { source: stream, filename: `zalo_sticker_${stickerId}.gif` },
                {
                  ...tgBase,
                  caption: appendSenderFooter('<i>(sticker động)</i>'),
                  parse_mode: 'HTML',
                },
              );
              saveTgMapping(sent);
              console.log(`[Zalo→TG] Animated sticker sent: stickerId=${stickerId} frames=${totalFrames} msgId=${sent.message_id}`);
              return;
            } catch (animatedErr) {
              console.warn(`[ZaloHandler] Animated sticker #${stickerId} conversion/upload failed; using static fallback:`, animatedErr);
            } finally {
              if (gifPath) await cleanTemp(gifPath);
              if (spritePath) await cleanTemp(spritePath);
            }
          }

          const url: string | undefined =
            detail?.stickerWebpUrl ?? detail?.stickerUrl ?? detail?.stickerSpriteUrl;
          if (!url) {
            console.warn('[ZaloHandler] Sticker: no URL in detail:', detail);
            return;
          }
          const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.webp';
          const localPath = await downloadToTemp(url, `sticker_${Date.now()}${ext}`);
          try {
            let sent: { message_id: number };
            try {
              // Try native TG sticker (webp ≤512 KB displays as a proper sticker)
              const stream = createReadStream(localPath);
              sent = await tg.sendSticker(
                config.telegram.groupId,
                { source: stream },
                tgBase as Parameters<typeof tg.sendSticker>[2],
              );
            } catch {
              // Animated conversion or native sticker may be rejected; always
              // preserve a visible static fallback instead of dropping media.
              const stream = createReadStream(localPath);
              sent = await tg.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
            }
            saveTgMapping(sent);
          } finally { await cleanTemp(localPath); }
        } catch (stickerErr) {
          console.error('[ZaloHandler] Sticker fetch error:', stickerErr);
        }
        return;
      }

      // ── 8. Link (chat.recommended) ─────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.LINK) {
        // ── Missed call notification ──────────────────────────────────────────
        const rawMedia = media as Record<string, unknown>;
        if (media.action === 'recommened.misscall') {
          let params: { duration?: number; isCaller?: number; calltype?: number } = {};
          try { params = JSON.parse(media.params ?? '{}'); } catch { /* ignore */ }
          const callText = params.calltype === 1 ? '📹 cuộc gọi video nhỡ' : '📞 cuộc gọi thoại nhỡ';
          const sent = await tg.sendMessage(config.telegram.groupId, callText, tgBase);
          saveTgMapping(sent);
          return;
        }
        const href = media.href
          || (typeof rawMedia['src']  === 'string' ? rawMedia['src']  : '')
          || (typeof rawMedia['msg']  === 'string' ? rawMedia['msg']  : '')
          || '';
        const title = media.title
          || (typeof rawMedia['desc'] === 'string' ? rawMedia['desc'] : '')
          || href;
        if (!href) {
          console.warn('[ZaloHandler] Link: no URL found in content:', JSON.stringify(rawMedia));
          return;
        }
        const safeTitle = escapeHtml(title);
        const linkText  = appendSenderFooter(`<a href="${href}">${safeTitle}</a>`);
        const sent = await tg.sendMessage(config.telegram.groupId, linkText, {
          ...tgBase,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
        saveTgMapping(sent);
        return;
      }

      // ── 9. Web content (Zalo instant: bank card, mini app, etc.) ──────────
      if (msgType === ZALO_MSG_TYPES.WEBCONTENT) {
        // For bank cards: fetch HTML, parse data, send QR image + caption
        if (media.action === 'zinstant.bankcard' && media.params) {
          try {
            const parsedParams = JSON.parse(media.params) as {
              pcItem?: { data_url?: string };
              item?:   { data_url?: string };
            };
            const dataUrl = parsedParams.pcItem?.data_url ?? parsedParams.item?.data_url;
            if (dataUrl) {
              const htmlResp = await fetch(`${dataUrl}?data=html`);
              const html = await htmlResp.text();
              const info = parseBankCardHtml(html);
              if (info) {
                const qrBuf = await QRCode.toBuffer(info.vietqr, {
                  width: 300, margin: 2,
                  color: { dark: '#000000ff', light: '#ffffffff' },
                });
                let caption = `🏦 <b>Tài khoản ngân hàng</b>`;
                if (info.bankName)      caption += `\nNgân hàng: <b>${info.bankName}</b>`;
                if (info.accountNumber) caption += `\nSTK: <code>${info.accountNumber}</code>`;
                if (info.holderName)    caption += `\nChủ TK: <b>${info.holderName}</b>`;
                const fullCaption = appendSenderFooter(caption);
                const sent = await tg.sendPhoto(
                  config.telegram.groupId,
                  { source: qrBuf },
                  { ...tgBase, caption: fullCaption, parse_mode: 'HTML' },
                );
                saveTgMapping(sent);
                return;
              }
            }
          } catch (err) {
            console.error('[ZaloHandler] bankcard parse error:', err);
          }
        }

        // Generic webcontent fallback
        let label = media.title || '';
        try {
          if (media.params) {
            const p = JSON.parse(media.params) as {
              customMsg?: { msg?: { vi?: string; en?: string } };
            };
            const vi = p.customMsg?.msg?.vi;
            const en = p.customMsg?.msg?.en;
            if (vi && vi.trim()) label = vi.trim();
            else if (en && en.trim()) label = en.trim();
          }
        } catch { /* use fallback */ }
        if (!label) label = '[Nội dung web]';

        const ACTION_ICONS: Record<string, string> = {
          'zinstant.bankcard': '🏦',
          'zinstant.transfer': '💸',
          'zinstant.invoice':  '🧾',
          'zinstant.qr':       '📷',
        };
        const icon = ACTION_ICONS[media.action ?? ''] ?? '📋';
        const body = `${icon} ${label}`;
        const text = appendSenderFooter(body);
        const sent = await tg.sendMessage(config.telegram.groupId, text, {
          ...tgBase,
          parse_mode: 'HTML',
        });
        saveTgMapping(sent);
        return;
      }

      // ── 10. Location ───────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.LOCATION) {
        let lat: number | undefined;
        let lng: number | undefined;
        try {
          const p = JSON.parse(media.params ?? '{}') as { latitude?: number; longitude?: number };
          lat = p.latitude;
          lng = p.longitude;
        } catch { /* ignore */ }

        if (lat !== undefined && lng !== undefined) {
          // Send as native TG location — shows map preview with Maps button
          const sent = await tg.sendLocation(
            config.telegram.groupId,
            lat,
            lng,
            { ...tgBase } as Parameters<typeof tg.sendLocation>[3],
          );
          // Send sender name as a follow-up caption since sendLocation has no HTML caption.
          // Map it too, so Telegram replies to the caption can still quote the Zalo location.
          const captionSent = await tg.sendMessage(
            config.telegram.groupId,
            appendSenderFooter('📍 Vị trí'),
            { ...tgBase, parse_mode: 'HTML' },
          );
          saveTgMapping(sent);
          saveTgMapping(captionSent);
        } else {
          // Fallback: Google Maps link
          const mapsUrl = media.href || '#';
          const body    = `📍 <a href="${mapsUrl}">Vị trí</a>`;
          const text    = appendSenderFooter(body);
          const sent    = await tg.sendMessage(config.telegram.groupId, text, { ...tgBase, parse_mode: 'HTML' });
          saveTgMapping(sent);
        }
        return;
      }

      // ── 11. Poll ────────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.POLL) {
        let pollId: number | undefined;
        let question = '';
        let isAnonymous = false;
        let action = '';
        try {
          const p = JSON.parse(media.params ?? '{}') as {
            pollId?: number;
            question?: string;
            isAnonymous?: boolean;
            action?: string;
          };
          pollId      = p.pollId;
          question    = p.question ?? '';
          isAnonymous = p.isAnonymous ?? false;
          action      = media.action ?? '';
        } catch { /* ignore */ }

        console.log(`[ZaloHandler] Poll event: action="${action}" pollId=${pollId}`);

        if (!pollId) return;

        // Fetch full poll details (options + vote counts)
        let pollDetail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
        try {
          pollDetail = await api.getPollDetail(pollId);
          console.log(`[ZaloHandler] Poll detail: num_vote=${pollDetail?.num_vote} options=`, pollDetail?.options?.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(','));
        } catch (e) {
          console.warn('[ZaloHandler] getPollDetail failed:', e);
        }

        const existingEntry = pollStore.getByPollId(pollId);
        console.log(`[ZaloHandler] Poll existingEntry=${existingEntry ? 'found' : 'NOT found'}`);
        type ZaloPollOption = { option_id: number; content: string; votes: number; voted: boolean; voters: string[] };

        if (action === 'create' && !existingEntry) {
          const options: ZaloPollOption[] = pollDetail?.options ?? [];
          if (options.length < 2) {
            // Can't create TG poll with < 2 options, send as text
            const pollBody = `📊 <b>${escapeHtml(question)}</b>\n<i>Cuộc bình chọn mới (${options.length} lựa chọn)</i>`;
            const text = type === ThreadType.Group
              ? appendSenderFooter(pollBody)
              : `📊 <b>${escapeHtml(question)}</b>`;
            const sent = await tg.sendMessage(config.telegram.groupId, text, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
            return;
          }

          const header = type === ThreadType.Group
            ? `${bridgeSenderName} tạo bình chọn`
            : 'Bình chọn mới';

          const tgPollMsg = await tg.sendPoll(
            config.telegram.groupId,
            question,
            options.map(o => o.content),
            {
              ...tgBase,
              is_anonymous:        isAnonymous,
              allows_multiple_answers: pollDetail?.allow_multi_choices ?? false,
              question_parse_mode: undefined,
            } as Parameters<typeof tg.sendPoll>[3],
          );

          // Send editable score message below
          const scoreText = buildScoreText(header, pollDetail?.options ?? [], pollDetail?.closed ?? false);
          const tgScoreMsg = await tg.sendMessage(
            config.telegram.groupId,
            scoreText,
            { message_thread_id: topicId, parse_mode: 'HTML', disable_notification: silent },
          );

          pollStore.save({
            pollId,
            zaloGroupId:  zaloId,
            tgPollMsgId:  tgPollMsg.message_id,
            tgPollUUID:   (tgPollMsg as { poll?: { id?: string } }).poll?.id ?? '',
            tgScoreMsgId: tgScoreMsg.message_id,
            tgThreadId:   topicId,
            options: options.map(o => ({ option_id: o.option_id, content: o.content })),
          });
          saveTgMapping(tgPollMsg);
        } else {
          // ── Vote update (or unknown existing poll after restart) ──────────
          // Small delay so Zalo server has time to record the vote before we fetch
          await new Promise(r => setTimeout(r, 800));
          let updatedDetail = pollDetail;
          try { updatedDetail = await api.getPollDetail(pollId); } catch { /* use existing */ }
          const header = type === ThreadType.Group
            ? `${bridgeSenderName} vừa bình chọn`
            : 'Cập nhật bình chọn';
          const detailOptions = updatedDetail?.options ?? [];
          const scoreText = buildScoreText(
            header,
            detailOptions.length > 0 ? detailOptions : (existingEntry?.options.map(o => ({ ...o, votes: 0, voted: false, voters: [] })) ?? []),
            updatedDetail?.closed ?? false,
          );
          console.log(`[ZaloHandler] Poll ${pollId} score:`, detailOptions.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(', '));

          if (existingEntry) {
            try {
              await tg.editMessageText(
                config.telegram.groupId,
                existingEntry.tgScoreMsgId,
                undefined,
                scoreText,
                {
                  parse_mode: 'HTML',
                  reply_markup: updatedDetail?.closed
                    ? { inline_keyboard: [] }
                    : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] },
                },
              );
              console.log(`[ZaloHandler] Poll ${pollId} score message edited OK`);
            } catch (editErr) {
              console.warn(`[ZaloHandler] Poll ${pollId} edit failed, sending new:`, editErr);
              const newScore = await tg.sendMessage(
                config.telegram.groupId,
                scoreText,
                { message_thread_id: existingEntry.tgThreadId, parse_mode: 'HTML',
                  reply_parameters: { message_id: existingEntry.tgPollMsgId, allow_sending_without_reply: true } },
              );
              pollStore.updateScoreMsg(pollId, newScore.message_id);
            }
          } else {
            // existingEntry lost (bot restarted) — just send score as standalone message
            const sent = await tg.sendMessage(
              config.telegram.groupId,
              scoreText,
              { ...tgBase, parse_mode: 'HTML' },
            );
            saveTgMapping(sent);
          }
        }
        return;
      }

      // ── Fallback ───────────────────────────────────────────────────────────
      // Before fallback: detect contact card by content shape (contactUid field)
      // Zalo sends contact cards as msgType 'chat.forward' with contactUid in content
      {
        const rawContent = msg.data.content;
        const contactUid: string | undefined =
          (typeof rawContent === 'object' && rawContent !== null && 'contactUid' in rawContent)
            ? String((rawContent as Record<string, unknown>).contactUid)
            : (media.contactUid ? String(media.contactUid) : undefined);

        if (contactUid || msgType === ZALO_MSG_TYPES.CONTACT) {
          const uid = contactUid ?? '';
          const contactName = uid ? await resolveUserDisplayName(api, uid, uid) : uid;
          const qrUrl: string | undefined =
            (typeof rawContent === 'object' && rawContent !== null && 'qrCodeUrl' in rawContent)
              ? String((rawContent as Record<string, unknown>).qrCodeUrl)
              : media.qrCodeUrl;

          const body = `👤 <b>Danh thiếp</b>\nTên: <b>${escapeHtml(contactName)}</b>\nZalo ID: <code>${uid}</code>`;
          const fullText = type === ThreadType.Group ? appendSenderFooter(body) : withDmMention(body);

          if (qrUrl) {
            // Send QR code image + caption
            try {
              const localPath = await downloadToTemp(qrUrl, `qr_${Date.now()}.jpg`);
              const stream = createReadStream(localPath);
              const sent = await tg.sendPhoto(
                config.telegram.groupId,
                { source: stream },
                { ...tgBase, caption: fullText, parse_mode: 'HTML' },
              );
              saveTgMapping(sent);
              await cleanTemp(localPath);
            } catch {
              const sent = await tg.sendMessage(config.telegram.groupId, fullText, { ...tgBase, parse_mode: 'HTML' });
              saveTgMapping(sent);
            }
          } else {
            const sent = await tg.sendMessage(config.telegram.groupId, fullText, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
          }
          return;
        }
      }

      // ── 13. E-card (birthday / event notification) ────────────────────────
      if (msgType === ZALO_MSG_TYPES.ECARD) {
        const ecardTitle = media.title ?? '';
        const ecardDesc  = media.description ?? '';
        let ecardNotify  = '';
        try {
          const p = JSON.parse(media.params ?? '{}') as { notifyTxt?: string };
          ecardNotify = p.notifyTxt ?? '';
        } catch { /* ignore */ }

        const lines: string[] = [];
        lines.push(`🎂 <b>${escapeHtml(ecardTitle)}</b>`);
        if (ecardDesc && ecardDesc !== ecardTitle) lines.push(escapeHtml(ecardDesc));
        if (ecardNotify) lines.push(`<i>${escapeHtml(ecardNotify)}</i>`);
        const ecardBody = lines.join('\n');
        const ecardCaption = type === ThreadType.Group
          ? appendSenderFooter(ecardBody)
          : withDmMention(ecardBody);

        const imgUrl = media.href;
        if (imgUrl) {
          try {
            const localPath = await downloadToTemp(imgUrl, `ecard_${Date.now()}.png`);
            const sent = await tg.sendPhoto(
              config.telegram.groupId,
              { source: createReadStream(localPath) },
              { ...tgBase, caption: ecardCaption, parse_mode: 'HTML' },
            );
            saveTgMapping(sent);
            await cleanTemp(localPath);
          } catch {
            const sent = await tg.sendMessage(config.telegram.groupId, ecardCaption, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
          }
        } else {
          const sent = await tg.sendMessage(config.telegram.groupId, ecardCaption, { ...tgBase, parse_mode: 'HTML' });
          saveTgMapping(sent);
        }
        return;
      }

      // ── 14. Admin xoá tin nhắn (chat.delete) ──────────────────────────────
      if (msgType === 'chat.delete') {
        // content là mảng JSON: [{type,actionType,uidFrom,uidTo,clientDelMsgId,globalDelMsgId,destId}]
        let deletedItems: Array<{
          uidFrom?: string;
          clientDelMsgId?: string | number;
          globalDelMsgId?: string | number;
          destId?: string | number;
        }> = [];
        try {
          const raw = msg.data.content;
          if (typeof raw === 'string') {
            deletedItems = JSON.parse(raw) as typeof deletedItems;
          } else if (Array.isArray(raw)) {
            deletedItems = raw as typeof deletedItems;
          }
        } catch { /* ignore parse error */ }

        if (deletedItems.length === 0) return;

        // Resolve tên admin đã xoá (uidFrom của event, không phải của tin bị xoá)
        const delActorUid = msg.data.uidFrom;
        const delActorName = await resolveUserDisplayName(api, delActorUid, 'Admin');

        for (const item of deletedItems) {
          // Zalo gửi các ID của tin bị xoá trong 3 trường:
          //   globalDelMsgId = server msgId (= globalMsgId / realMsgId)
          //   clientDelMsgId = client cliMsgId
          //   destId         = thường là msgId gốc (thêm vào để tăng khả năng tìm thấy)
          const globalId =
            item.globalDelMsgId !== undefined && String(item.globalDelMsgId) !== '0'
              ? String(item.globalDelMsgId)
              : undefined;
          const clientId =
            item.clientDelMsgId !== undefined && String(item.clientDelMsgId) !== '0'
              ? String(item.clientDelMsgId)
              : undefined;
          const destId =
            item.destId !== undefined && String(item.destId) !== '0'
              ? String(item.destId)
              : undefined;

          // Lookup lần lượt: msgStore (Zalo→TG messages) rồi sentMsgStore (TG→Zalo messages)
          const tgMsgId =
            (globalId ? (msgStore.getTgMsgId(globalId) ?? sentMsgStore.getByZaloMsgId(globalId)) : undefined) ??
            (clientId ? (msgStore.getTgMsgId(clientId) ?? sentMsgStore.getByZaloMsgId(clientId)) : undefined) ??
            (destId   ? (msgStore.getTgMsgId(destId)   ?? sentMsgStore.getByZaloMsgId(destId))   : undefined);

          if (tgMsgId === undefined) {
            // Tin nhắn bị xoá chưa từng được bridge (gửi trước khi bridge start,
            // hoặc từ thiết bị khác) — gửi thông báo chung vào topic, không reply.
            console.log(
              `[ZaloHandler] chat.delete: no TG mapping — globalDelMsgId=${globalId} clientDelMsgId=${clientId} destId=${destId}`,
              JSON.stringify(item),
            );
            await tg.sendMessage(
              config.telegram.groupId,
              `<i>🗑 Admin <b>${escapeHtml(delActorName)}</b> đã xoá một tin nhắn (chưa được bridge) trên Zalo</i>`,
              {
                message_thread_id: topicId,
                parse_mode: 'HTML',
                disable_notification: silent,
              },
            );
            continue;
          }

          await tg.sendMessage(
            config.telegram.groupId,
            `<i>🗑 Tin nhắn này đã bị <b>${escapeHtml(delActorName)}</b> (admin) xoá trên Zalo</i>`,
            {
              message_thread_id: topicId,
              parse_mode: 'HTML',
              reply_parameters: { message_id: tgMsgId, allow_sending_without_reply: true },
              disable_notification: silent,
            },
          );
          console.log(`[ZaloHandler] chat.delete: notified TG msg ${tgMsgId} deleted by ${delActorName} (${delActorUid})`);
        }
        return;
      }

      console.log(`[ZaloHandler] Unhandled msgType="${msgType}" content:`, JSON.stringify(msg.data.content));
      const fallback = type === ThreadType.Group
        ? appendSenderFooter(`<i>[${msgType}]</i>`)
        : withDmMention(`<i>[${msgType}]</i>`);
      const sentFallback = await tg.sendMessage(config.telegram.groupId, fallback, {
        ...tgBase,
        parse_mode: 'HTML',
      });
      saveTgMapping(sentFallback);
    } catch (err) {
      // If the TG topic was deleted, clear the stale mapping so the next message
      // from this conversation will trigger topic recreation automatically.
      if (isTopicDeletedError(err)) {
        const staleTopicId = store.getTopicByZalo(msg.threadId, msg.type as 0 | 1);
        if (staleTopicId !== undefined) {
          console.warn(`[Zalo→TG] Topic ${staleTopicId} was deleted — removing stale mapping for ${msg.threadId}`);
          store.remove(staleTopicId);
        }
      } else {
        console.error('[ZaloHandler] Error:', err);
      }
    }
  };

  _activeMessageHandler = handleZaloMessage;
  api.listener.on('message', handleZaloMessage);

  void catchUpMissedGroupMessages(api, handleZaloMessage);

  // Catch-up stream from zca-js after reconnect.
  // Replays recent messages through the same main handler to refill bridges.
  api.listener.on('old_messages', (messages: ZaloMessage[]) => {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const sorted = [...messages].sort((a, b) => Number(a?.data?.ts ?? 0) - Number(b?.data?.ts ?? 0));
    console.log(`[Zalo→TG] Catch-up old_messages: replay ${sorted.length} item(s)`);
    for (const oldMsg of sorted) {
      api.listener.emit('message', oldMsg);
    }
  });

  // ── Undo (thu hồi tin nhắn) ────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('undo', async (undo: any) => {
    try {
      const data = undo?.data;
      // The recalled Zalo message ID.
      // Group chat: content.globalMsgId is set.
      // Personal chat: globalMsgId=0, realMsgId="0", but content.cliMsgId is the cliMsgId
      // of the recalled message (which we also store in _zaloToTg via zaloMsgIds).
      const rawMsgId =
        (data?.content?.globalMsgId && data.content.globalMsgId !== 0)
          ? String(data.content.globalMsgId)
          : (data?.content?.cliMsgId && String(data.content.cliMsgId) !== '0')
            ? String(data.content.cliMsgId)
            : '';
      const zaloMsgId = rawMsgId;
      if (!zaloMsgId) {
        console.log(`[ZaloHandler] Undo: could not resolve msgId, raw undo data:`, JSON.stringify(data));
        return;
      }

      // Skip notification if we just initiated this recall from Telegram (prevents duplicate "🗑" message)
      if (recentlyRecalledMsgIds.has(zaloMsgId)) {
        markRecallConfirmed(zaloMsgId);
        console.log(`[ZaloHandler] Undo: skip notification for recently-recalled msgId=${zaloMsgId}`);
        return;
      }

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId);
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Undo: no TG mapping for zaloMsgId=${zaloMsgId}`);
        return;
      }

      // Find which topic this message belongs to
      const zaloId = undo?.threadId ?? data?.idTo;
      const type   = (undo?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(String(zaloId), type);
      if (topicId === undefined) return;

      // Reply to the original forwarded TG message to notify it was recalled on Zalo
      await tg.sendMessage(
        config.telegram.groupId,
        `<i>🗑 Tin nhắn này đã bị thu hồi trên Zalo</i>`,
        {
          message_thread_id: topicId,
          parse_mode: 'HTML',
          reply_parameters: { message_id: tgMsgId, allow_sending_without_reply: true },
        },
      );
      console.log(`[ZaloHandler] Undo: notified recall for TG msg ${tgMsgId} (zaloMsgId=${zaloMsgId})`);
    } catch (err) {
      console.error('[ZaloHandler] Undo error:', err);
    }
  });

  // ── Reaction (cảm xúc) ─────────────────────────────────────────────────────
  const REACTION_EMOJI: Record<string, string> = {
    '/-heart':   '❤️',
    '/-strong':  '👍',
    ':>':        '😄',
    ':o':        '😮',
    ':-((':      '😢',
    ':-h':       '😡',
    ':-*':       '😘',
    ":')":       '😂',
    '/-shit':    '💩',
    '/-rose':    '🌹',
    '/-break':   '💔',
    '/-weak':    '👎',
    ';xx':       '🥰',
    ';-/':       '😕',
    ';-)':       '😉',
    '/-fade':    '✨',
    '/-ok':      '👌',
    '/-v':       '✌️',
    '/-thanks':  '🙏',
    '/-punch':   '👊',
    '/-no':      '🙅',
    '/-loveu':   '🤟',
    '--b':       '😞',
    ':((': '😭',
    'x-)':       '😎',
    '_()_':      '🙏',
    '/-bd':      '🎂',
    '/-bome':    '💣',
    '/-beer':    '🍺',
    '/-li':      '☀️',
    '/-share':   '🔁',
    '/-bad':     '😤',
    '':          '❌',  // remove reaction
  };

  // Map a Zalo reaction icon → the closest emoji Telegram actually allows as a
  // *reaction* (Telegram restricts reactions to a fixed set, narrower than
  // arbitrary emoji). Icons without an entry here can't be shown as a native
  // Telegram reaction and fall back to the summary-reply method.
  const ZALO_TO_TG_REACTION: Record<string, TelegramEmoji> = {
    '/-heart':  '❤',  // HEART
    '/-strong': '👍',  // LIKE
    ':>':       '😁',  // HAHA
    ':o':       '🤯',  // WOW
    ':-((':     '😢',  // CRY
    ':((':      '😭',  // VERY_SAD
    '--b':      '😢',  // SAD
    ':-h':      '😡',  // ANGRY
    ':-*':      '😘',  // KISS
    ';xx':      '🥰',  // LOVE
    ":')":      '🤣',  // TEARS_OF_JOY
    '/-shit':   '💩',  // SHIT
    '/-break':  '💔',  // BROKEN_HEART
    '/-weak':   '👎',  // DISLIKE
    ';-/':      '🤔',  // CONFUSED
    '/-ok':     '👌',  // OK
    '_()_':     '🙏',  // PRAY
    '/-thanks': '🙏',  // THANKS
    '/-bd':     '🎉',  // BIRTHDAY
    'x-)':      '😎',  // (cool)
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('reaction', async (reaction: any) => {
    try {
      const data = reaction?.data;
      const rIcon: string = data?.content?.rIcon ?? '';

      const rMsgs: Array<{ gMsgID?: string | number; cMsgID?: string | number }> = data?.content?.rMsg ?? [];
      const targetMsgIds = Array.from(new Set([
        String(rMsgs[0]?.gMsgID ?? ''),
        String(rMsgs[0]?.cMsgID ?? ''),
        String(data?.msgId ?? ''),
        String(data?.cliMsgId ?? ''),
      ].map(id => id.trim()).filter(id => id && id !== '0')));
      if (targetMsgIds.length === 0) return;

      const zaloId = String(reaction?.threadId ?? data?.idTo ?? "");
      if (!zaloId) return;

      const actorUid = typeof data?.uidFrom === 'string' ? data.uidFrom.trim() : '';
      const rawName = typeof data?.dName === 'string' ? data.dName.trim() : '';

      if (reactionEventDedupeStore.isDuplicateZaloInbound({
        zaloId,
        targetMsgIds,
        icon: rIcon,
        actorUid: actorUid || undefined,
        actorName: rawName || undefined,
      })) {
        console.log(`[ZaloHandler] Reaction: skip duplicate event ${zaloId}/${targetMsgIds.join('|')}/${rIcon}`);
        return;
      }

      if (rIcon && reaction?.isSelf && targetMsgIds.some(msgId => reactionEchoStore.consume(zaloId, msgId, rIcon))) {
        console.log(`[ZaloHandler] Reaction: skip bridge echo for ${zaloId}/${targetMsgIds.join('|')}/${rIcon}`);
        return;
      }

      let tgMsgId: number | undefined;
      for (const msgId of targetMsgIds) {
        tgMsgId = msgStore.getTgMsgId(msgId) ?? sentMsgStore.getByZaloMsgId(msgId);
        if (tgMsgId !== undefined) break;
      }
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Reaction: no TG mapping for target=${targetMsgIds.join('|')}`);
        return;
      }

      const type   = (reaction?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(zaloId, type);
      if (topicId === undefined) return;

      // Keep reaction traffic quiet: attach the closest supported reaction
      // directly to the Telegram message in both DMs and group topics. Telegram
      // represents this as the bridge bot's reaction, so it cannot preserve each
      // Zalo actor's identity/count, but it avoids creating a reply/quote message
      // for every reacted-to message. Unsupported icons are intentionally ignored
      // instead of generating noisy summary replies.
      const tgReaction = ZALO_TO_TG_REACTION[rIcon];
      try {
        if (!rIcon) {
          // Zalo emits an empty icon for removal. Since Telegram can only show
          // the bridge bot's aggregate/latest reaction, clear that marker.
          await tg.setMessageReaction(config.telegram.groupId, tgMsgId, []);
          return;
        }
        if (tgReaction) {
          await tg.setMessageReaction(
            config.telegram.groupId,
            tgMsgId,
            [{ type: 'emoji', emoji: tgReaction }],
          );
          return;
        }
        console.log(`[ZaloHandler] Reaction: unsupported native icon ${rIcon}; skipped to avoid summary noise`);
        return;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[ZaloHandler] Native reaction "${tgReaction ?? rIcon}" rejected; skipped to avoid summary noise: ${m}`);
        return;
      }
    } catch (err) {
      console.error('[ZaloHandler] Reaction error:', err);
    }
  });

  // Catch-up stream from zca-js after reconnect.
  // Replays reaction history through the same reaction pipeline + dedupe.
  api.listener.on('old_reactions', (reactions: any[], isGroup: boolean) => {
    if (!Array.isArray(reactions) || reactions.length === 0) return;
    console.log(`[Zalo→TG] Catch-up old_reactions: replay ${reactions.length} item(s), isGroup=${isGroup}`);
    for (const reaction of reactions) {
      if (reaction && reaction.isGroup === undefined) reaction.isGroup = isGroup;
      api.listener.emit('reaction', reaction);
    }
  });

  // ── Group events (vào/rời nhóm) ────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('group_event', async (event: any) => {
    try {
      const type    = event?.type as string | undefined;
      const data    = event?.data;
      const groupId = String(event?.threadId ?? data?.groupId ?? '');
      if (!groupId) return;

      // ── Join request: someone wants to join the group ─────────────────────
      if (type === 'join_request') {
        const uids: string[] = data?.uids ?? [];
        if (!uids.length) return;

        // Check admin status — must call web API (adminIds not in AppGroupData)
        let adminIds: string[] = [];
        let creatorId = '';
        try {
          const fullInfo = await api.getGroupInfo(groupId) as {
            gridInfoMap?: Record<string, { adminIds?: string[]; creatorId?: string }>;
          };
          const gInfo = fullInfo?.gridInfoMap?.[groupId];
          adminIds = gInfo?.adminIds ?? [];
          creatorId = gInfo?.creatorId ?? '';
        } catch { /* ignore */ }

        const ownUid = String(api.getOwnId?.() ?? '');
        const isAdmin = ownUid && (adminIds.includes(ownUid) || creatorId === ownUid);
        if (!isAdmin) {
          console.log(`[ZaloHandler] join_request group=${groupId}: bot is not admin, skip`);
          return;
        }

        const topicId = store.getTopicByZalo(groupId, 1 /* Group */);
        if (topicId === undefined) return;

        const totalPending: number = data?.totalPending ?? uids.length;

        for (const uid of uids) {
          const displayName = await resolveUserDisplayName(api, uid, uid);

          const text = `🔔 <b>${escapeHtml(displayName)}</b> (<code>${uid}</code>) muốn tham gia nhóm.\n\nTổng đang chờ duyệt: ${totalPending}`;
          await tg.sendMessage(
            config.telegram.groupId,
            text,
            {
              message_thread_id: topicId,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Duyệt', callback_data: `gm:approve:${groupId}:${uid}` },
                  { text: '❌ Từ chối', callback_data: `gm:reject:${groupId}:${uid}` },
                ]],
              },
            },
          );
        }
        console.log(`[ZaloHandler] join_request group=${groupId} uids=${uids.join(',')} (admin=${ownUid})`);
        return;
      }

      // ── Poll vote: UPDATE_BOARD with BoardType.Poll ────────────────────────
      if (type === 'update_board' || type === 'remove_board') {
        // groupTopic.params is a JSON string containing poll info
        const rawParams = data?.groupTopic?.params ?? data?.topic?.params ?? '';
        let params: { boardType?: number; pollId?: number } = {};
        try { params = JSON.parse(rawParams); } catch { /* ignore */ }
        // BoardType.Poll = 3
        if (params.boardType === 3 && params.pollId) {
          const pollId = params.pollId;
          console.log(`[ZaloHandler] group_event update_board pollId=${pollId}`);
          const entry = pollStore.getByPollId(pollId);
          if (entry) {
            await new Promise(r => setTimeout(r, 600));
            let detail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
            try { detail = await api.getPollDetail(pollId); } catch { /* ignore */ }
            if (detail?.options) {
              const actorName = data?.updateMembers?.[0]?.dName ?? data?.creatorId ?? '';
              const header = actorName ? `${actorName} vừa bình chọn` : 'Cập nhật bình chọn';
              const scoreText = buildScoreText(header, detail.options, detail.closed ?? false);
              console.log(`[ZaloHandler] Poll ${pollId} update:`, detail.options.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(', '));
              try {
                await tg.editMessageText(
                  config.telegram.groupId,
                  entry.tgScoreMsgId,
                  undefined,
                  scoreText,
                  {
                    parse_mode: 'HTML',
                    reply_markup: detail.closed
                      ? { inline_keyboard: [] }
                      : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] },
                  },
                );
              } catch {
                const newScore = await tg.sendMessage(
                  config.telegram.groupId,
                  scoreText,
                  { message_thread_id: entry.tgThreadId, parse_mode: 'HTML',
                    reply_parameters: { message_id: entry.tgPollMsgId, allow_sending_without_reply: true },
                    reply_markup: detail.closed
                      ? { inline_keyboard: [] }
                      : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] } },
                );
                pollStore.updateScoreMsg(pollId, newScore.message_id);
              }
            }
          } else {
            console.log(`[ZaloHandler] update_board pollId=${pollId} not in pollStore (no TG mapping)`);
          }
        }
        return;
      }

      // ── Group name change: update TG topic name ────────────────────────────────────────
      // Zalo sends act="update" (type="update") when group is renamed, with groupName in data.
      // act="update_setting" is kept as fallback.
      if (type === 'update' || type === 'update_setting') {
        const newName: string = (
          (data?.groupName as string | undefined) ??
          (data?.name     as string | undefined) ??
          ''
        ).trim();
        if (newName) {
          const tId = store.getTopicByZalo(groupId, 1);
          if (tId !== undefined) {
            await tg.editForumTopic(
              config.telegram.groupId, tId, { name: topicName(newName, 1) },
            ).catch(() => undefined);
            const existing = store.getEntryByTopic(tId);
            if (existing) store.set({ ...existing, name: newName });
            _groupInfoCache.delete(groupId);
            console.log(`[ZaloHandler] GroupEvent ${type}: group ${groupId} renamed to "${newName}"`);
          }
        }
        return;
      }

      // Only notify for join/leave/remove — skip other setting changes, pins, etc.
      const NOTIFY_TYPES = new Set(['join', 'leave', 'remove_member', 'block_member']);
      if (!type || !NOTIFY_TYPES.has(type)) return;

      const topicId = store.getTopicByZalo(groupId, 1 /* Group */);
      if (topicId === undefined) return;

      const members: Array<{ uid?: string; id?: string; userId?: string; dName?: string; displayName?: string; zaloName?: string }> = data?.updateMembers ?? [];
      const resolvedNames = await Promise.all(members.map(async (m) => {
        const rawUid = String(m.uid ?? m.id ?? m.userId ?? '').trim();
        const fallbackName = m.dName?.trim() || m.displayName?.trim() || m.zaloName?.trim() || rawUid || '?';

        // group_event payload can miss uid (or use uid_0 variant).
        // Prefer any known cache-backed uid so contact-book names win.
        const uidCandidates = rawUid
          ? [rawUid, rawUid.endsWith('_0') ? rawUid.slice(0, -2) : rawUid]
          : [];
        const knownUid = uidCandidates.find((uid) =>
          !!uid && (
            !!nameCache.preferred(uid)
            || !!friendsCache.get(uid)
            || !!userCache.getName(uid)
          ),
        );

        const resolvedUid = knownUid
          || (rawUid || undefined)
          || nameCache.resolveByName(fallbackName)
          || aliasCache.resolveByAlias(fallbackName)
          || undefined;

        return resolvedUid
          ? await resolveUserDisplayName(api, resolvedUid, fallbackName)
          : fallbackName;
      }));
      const names = resolvedNames.join(', ');
      const actor  = data?.creatorId === data?.sourceId ? '' : '';  // unused for now
      void actor;

      let notifText = '';
      if (type === 'join') {
        notifText = `➕ <b>${escapeHtml(names)}</b> đã tham gia nhóm`;
      } else if (type === 'leave') {
        notifText = `➖ <b>${escapeHtml(names)}</b> đã rời nhóm`;
      } else if (type === 'remove_member') {
        notifText = `🚫 <b>${escapeHtml(names)}</b> đã bị xóa khỏi nhóm`;
      } else if (type === 'block_member') {
        notifText = `🔒 <b>${escapeHtml(names)}</b> đã bị chặn khỏi nhóm`;
      }

      if (!notifText) return;

      await tg.sendMessage(
        config.telegram.groupId,
        `<i>${notifText}</i>`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
      console.log(`[ZaloHandler] GroupEvent type=${type} group=${groupId}`);
    } catch (err) {
      console.error('[ZaloHandler] GroupEvent error:', err);
    }
  });

  // ── Friend events (lời mời kết bạn, chấp nhận, ...) ──────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('friend_event', async (evt: any) => {
    try {
      // Only care about incoming friend request (someone requesting to be our friend)
      if (evt.type !== FriendEventType.REQUEST) return;
      // isSelf = we sent the request, skip
      if (evt.isSelf) return;

      const data = evt.data as { fromUid: string; toUid: string; message: string };
      const fromUid = data?.fromUid;
      if (!fromUid) return;

      const displayName = await resolveUserDisplayName(api, fromUid, fromUid);

      const msgText = data?.message?.trim();

      await tg.sendMessage(
        config.telegram.groupId,
        `👤 <b>${escapeHtml(displayName)}</b> muốn kết bạn với bạn qua Zalo!${msgText ? `\n💬 <i>${escapeHtml(msgText)}</i>` : ''}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Chấp nhận', callback_data: `fr:accept:${fromUid}` },
              { text: '❌ Từ chối',   callback_data: `fr:reject:${fromUid}` },
            ]],
          },
        },
      );
      console.log(`[ZaloHandler] FriendEvent REQUEST from ${fromUid} (${displayName})`);
    } catch (err) {
      console.error('[ZaloHandler] FriendEvent error:', err);
    }
  });

  // ── Typing indicator (đang soạn tin) ───────────────────────────────────────
  // Zalo fires `typing` repeatedly (every ~1s) while someone is composing.
  // We mirror it into the matching Telegram topic via sendChatAction, whose
  // "typing" status auto-clears after ~5s — so we only need to refresh it
  // occasionally. Throttle per-thread to avoid hammering the Telegram API.
  //
  // Direction is Zalo→Telegram only: this handler never sends anything back to
  // Zalo, so it adds zero outbound traffic and no account-ban risk.
  const TYPING_THROTTLE_MS = 4000;
  const lastTypingForwardedAt = new Map<string, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('typing', async (typing: any) => {
    try {
      const zaloId = String(typing?.threadId ?? typing?.data?.gid ?? typing?.data?.uid ?? '');
      if (!zaloId) return;

      const type = (typing?.type === ThreadType.Group || typing?.data?.gid) ? 1 : 0;
      const topicId = store.getTopicByZalo(zaloId, type as 0 | 1);
      if (topicId === undefined) return; // only surface typing for known conversations

      const now = Date.now();
      if (now - (lastTypingForwardedAt.get(zaloId) ?? 0) < TYPING_THROTTLE_MS) return;
      lastTypingForwardedAt.set(zaloId, now);

      await tg.sendChatAction(config.telegram.groupId, 'typing', { message_thread_id: topicId });
    } catch (err) {
      console.warn('[ZaloHandler] Typing error:', err);
    }
  });

  // ── Seen indicator (đã xem) ────────────────────────────────────────────────
  // When the other side reads a message we sent from Telegram, Zalo emits
  // `seen_messages`. We mark the corresponding Telegram message with a 👀
  // reaction so the user can tell their message was read — mirroring Zalo's
  // "Đã xem". Each Telegram message is marked at most once.
  //
  // Direction is Zalo→Telegram only (read-only on the Zalo side).
  const SEEN_DEDUPE_MAX = 2000;
  const seenMarkedTgMsgIds = new Set<number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('seen_messages', async (messages: any[]) => {
    if (!Array.isArray(messages) || messages.length === 0) return;
    for (const m of messages) {
      try {
        const data = m?.data ?? {};
        // Resolve the Zalo message id the peer just read, then map it back to
        // the Telegram message that originated it.
        const candidates = [data.msgId, data.realMsgId]
          .map((id: unknown) => (id === undefined || id === null ? '' : String(id).trim()))
          .filter((id: string) => id && id !== '0');

        let tgMsgId: number | undefined;
        for (const id of candidates) {
          tgMsgId = sentMsgStore.getByZaloMsgId(id) ?? msgStore.getTgMsgId(id);
          if (tgMsgId !== undefined) break;
        }
        if (tgMsgId === undefined || seenMarkedTgMsgIds.has(tgMsgId)) continue;

        // Bound the dedupe set so it can't grow without limit.
        if (seenMarkedTgMsgIds.size >= SEEN_DEDUPE_MAX) {
          seenMarkedTgMsgIds.clear();
        }
        seenMarkedTgMsgIds.add(tgMsgId);

        await tg.setMessageReaction(
          config.telegram.groupId,
          tgMsgId,
          [{ type: 'emoji', emoji: '👀' }],
        );
      } catch (err) {
        console.warn('[ZaloHandler] Seen error:', err);
      }
    }
  });
}
