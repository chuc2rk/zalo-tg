import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Telegraf, Telegram } from 'telegraf';

import { config } from './config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let _notifiedCommit: string | null = null;

function gitExec(cmd: string): string {
  return execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
}

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

/** Send update notification without auto-pulling over local stable fixes. */
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

  const autoCheck = async () => {
    const commit = getNewCommit();
    if (!commit) return;
    if (_notifiedCommit === commit) return;
    await sendUpdateNotification(bot.telegram, commit);
  };

  setTimeout(autoCheck, 60_000);
  setInterval(autoCheck, 10 * 60_000);
}

/** Manual trigger — safe notify-only /update command. */
export async function triggerUpdateCheck(tg: Telegram): Promise<boolean> {
  const commit = getNewCommit();
  if (!commit) return false;
  await sendUpdateNotification(tg, commit);
  return true;
}
