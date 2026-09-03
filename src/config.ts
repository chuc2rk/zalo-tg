import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function resolvePath(envVal: string | undefined, defaultRelative: string): string {
  const raw = envVal ?? defaultRelative;
  // Already absolute → use as-is, otherwise resolve from project root
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function envFlag(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function envInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function envIdSet(key: string): ReadonlySet<string> {
  const raw = process.env[key];
  if (!raw) return new Set();
  return new Set(raw.split(',').map(value => value.trim()).filter(Boolean));
}

export const config = {
  telegram: {
    token:       requireEnv('TG_TOKEN'),
    groupId:     Number(requireEnv('TG_GROUP_ID')),
    /** URL của local Bot API server, ví dụ: http://localhost:8081.
     *  Chỉ dùng khi LOCAL_BOT_API=1 và TG_LOCAL_SERVER được set.
     *  Nếu không → dùng official api.telegram.org. */
    localServer: envFlag('LOCAL_BOT_API')
      ? (process.env.TG_LOCAL_SERVER?.replace(/\/$/, '') || null)
      : null,
  },
  zalo: {
    credentialsPath: resolvePath(process.env.ZALO_CREDENTIALS_PATH, 'credentials.json'),
    skipMutedGroups: envFlag('ZALO_SKIP_MUTED_GROUPS'),
    /** Zalo group IDs that must never be forwarded or create Telegram topics. */
    ignoredGroupIds: envIdSet('ZALO_IGNORED_GROUP_IDS'),
    /** Zalo groups mirrored to Telegram for observation, with all TG→Zalo writes blocked. */
    observeOnlyGroupIds: envIdSet('ZALO_OBSERVE_ONLY_GROUP_IDS'),
    // Mirror Zalo's "mute notifications" → deliver those threads silently on
    // Telegram (messages still arrive, just no ping). On by default; set
    // ZALO_MUTE_SILENT=0 to always notify.
    muteSilentMirror: envFlag('ZALO_MUTE_SILENT', true),
    /**
     * Warm only a small number of already-mapped groups at boot. The rest are
     * lazy-loaded on first message to avoid Zalo code 221 / retry-limit storms
     * for accounts that belong to many large groups.
     */
    startupMemberPreloadMax: envInt('ZALO_STARTUP_MEMBER_PRELOAD_MAX', 12),
    startupMemberPreloadDelayMs: envInt('ZALO_STARTUP_MEMBER_PRELOAD_DELAY_MS', 5_000),
    /** Automatic websocket catch-up window. Timestamp-less history is skipped. */
    catchupWindowMs: envInt('ZALO_CATCHUP_WINDOW_MS', 12 * 60 * 60_000),
  },
  openClawGroupReply: {
    enabled: envFlag('OPENCLAW_GROUP_REPLY_ENABLED'),
    groupIds: envIdSet('OPENCLAW_GROUP_REPLY_GROUP_IDS'),
    agentId: process.env.OPENCLAW_GROUP_REPLY_AGENT_ID?.trim() || 'zalo-12c4',
    model: process.env.OPENCLAW_GROUP_REPLY_MODEL?.trim() || undefined,
    nodeBinary: process.env.OPENCLAW_NODE_BINARY?.trim() || process.execPath,
    cliScript: process.env.OPENCLAW_CLI_SCRIPT?.trim() || 'openclaw',
    timeoutSeconds: envInt('OPENCLAW_GROUP_REPLY_TIMEOUT_SECONDS', 90),
    ownerActiveMs: envInt('OPENCLAW_GROUP_REPLY_OWNER_ACTIVE_MS', 10 * 60_000),
  },
  dataDir: resolvePath(process.env.DATA_DIR, 'data'),
} as const;
