import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Telegraf, Telegram } from 'telegraf';

import { config } from './config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Hash of the commit we already sent a notification for (avoid spam)
let _notifiedCommit: string | null = null;

function gitExec(cmd: string): string {
  return execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
}

/** Returns the short hash of origin/main if it's ahead of HEAD, else null. */
function getNewCommit(): string | null {
  try {
    gitExec('git fetch origin main --quiet');
    const behind = gitExec('git log HEAD..origin/main --oneline');
    if (!behind) return null;
    return gitExec('git rev-parse --short origin/main');
  } catch {
    return null;
  }
}

/** Human-readable list of new commits (max 10 lines). */
function getChangelog(): string {
  try {
    return gitExec('git log HEAD..origin/main --oneline --no-merges');
  } catch {
    return '';
  }
}

function formatUpdateMessage(commit: string): string {
  const changelog = getChangelog();
  const lines = changelog
    ? changelog.split('\n').slice(0, 10).map(l => `• ${l}`).join('\n')
    : '';
  return `🔔 <b>Có bản cập nhật mới!</b> (<code>${commit}</code>)\n\n${lines}\n\n` +
    `⚠️ Branch này có local fixes, nên bot chỉ thông báo. Hãy để Claw review/cherry-pick thay vì auto-pull trực tiếp.`;
}

async function sendUpdateNotification(tg: Telegram, commit: string): Promise<void> {
  _notifiedCommit = commit;
  try {
    await tg.sendMessage(
      config.telegram.groupId,
      formatUpdateMessage(commit),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '👀 Đã xem', callback_data: 'upd:skip' },
          ]],
        },
      },
    );
  } catch (err) {
    console.error('[Updater] Failed to send notification:', err);
    _notifiedCommit = null;
  }
}

export function startUpdateChecker(bot: Telegraf): void {
  bot.action('upd:skip', async (ctx) => {
    await ctx.answerCbQuery('Đã ghi nhận').catch(() => undefined);
    await ctx.deleteMessage().catch(() => undefined);
  });

  // ── Periodic check mỗi 10 phút ───────────────────────────────────────────
  const check = async () => {
    const commit = getNewCommit();
    if (!commit) return;                    // không có gì mới
    if (_notifiedCommit === commit) return; // đã nhắn rồi
    await sendUpdateNotification(bot.telegram, commit);
  };

  // Kiểm tra 1 phút sau khi khởi động, sau đó mỗi 10 phút
  setTimeout(check, 60_000);
  setInterval(check, 10 * 60_000);
}

/** Manual trigger — safe notify-only /update command. */
export async function triggerUpdateCheck(tg: Telegram): Promise<boolean> {
  const commit = getNewCommit();
  if (!commit) return false;
  await sendUpdateNotification(tg, commit);
  return true;
}
