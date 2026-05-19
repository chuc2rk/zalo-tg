import { Telegraf } from 'telegraf';
import https from 'https';
import http from 'http';
import { config } from '../config.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });
const localAgent = new http.Agent({ family: 4 });

const BOT_COMMANDS = [
  { command: 'login',          description: 'Đăng nhập Zalo bằng QR (Web API)' },
  { command: 'loginweb',       description: 'Đăng nhập Zalo bằng QR (Web API, giống /login)' },
  { command: 'loginapp',       description: 'Đăng nhập Zalo bằng QR (PC App API)' },
  { command: 'search',         description: 'Tìm tên, nhóm hoặc số điện thoại' },
  { command: 'group_info',     description: 'Xem thông tin & thành viên nhóm Zalo hiện tại' },
  { command: 'group_infoall',  description: 'Xem toàn bộ thành viên nhóm Zalo hiện tại' },
  { command: 'recall',         description: 'Thu hồi tin nhắn đã gửi sang Zalo' },
  { command: 'topic',          description: 'Quản lý topic: list | info | delete' },
  { command: 'addgroup',       description: 'Tạo nhóm Zalo mới từ topic hiện tại' },
  { command: 'addfriend',      description: 'Gửi lời mời kết bạn Zalo' },
  { command: 'friendrequests', description: 'Xem & duyệt lời mời kết bạn đang chờ' },
  { command: 'joingroup',      description: 'Tham gia nhóm Zalo qua link mời' },
  { command: 'leavegroup',     description: 'Rời nhóm Zalo của topic hiện tại' },
  { command: 'status',         description: 'Xem trạng thái kết nối & thống kê bridge' },
  { command: 'admin',          description: 'Admin panel: trạng thái, cache, tra mapping' },
  { command: 'update',         description: 'Kiểm tra bản cập nhật mới cho bridge' },
];

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: config.telegram.localServer
    ? { apiRoot: config.telegram.localServer, agent: localAgent }
    : { agent },
});

export async function syncTelegramCommands(): Promise<void> {
  // Telegram caches command menus per scope. Setting only the default scope can
  // leave the menu empty in supergroups/topics, so sync the scopes we actually use.
  await tgBot.telegram.setMyCommands(BOT_COMMANDS);
  await tgBot.telegram.setMyCommands(BOT_COMMANDS, { scope: { type: 'all_group_chats' } });
  await tgBot.telegram.setMyCommands(BOT_COMMANDS, {
    scope: { type: 'chat', chat_id: config.telegram.groupId },
  });
}
