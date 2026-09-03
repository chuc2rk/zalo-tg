import { describe, expect, it } from 'vitest';
import { isDirectOwnerAddress, normalizeAgentReply } from '../../src/zalo/openclawGroupReply.js';
import type { ZaloMessage } from '../../src/zalo/types.js';
import { ThreadType } from 'zca-js';

function message(overrides: Partial<ZaloMessage['data']> = {}): ZaloMessage {
  return {
    type: ThreadType.Group,
    isSelf: false,
    threadId: 'test-group',
    data: {
      content: 'hello',
      msgId: '1',
      uidFrom: 'peer',
      idTo: 'test-group',
      ts: '1',
      ...overrides,
    },
  };
}

describe('OpenClaw group reply gates', () => {
  it('accepts direct owner mentions', () => {
    expect(isDirectOwnerAddress(message({
      mentions: [{ uid: 'owner', pos: 0, len: 6, type: 0 }],
    }), 'owner')).toBe(true);
  });

  it('accepts replies to owner messages', () => {
    expect(isDirectOwnerAddress(message({
      quote: {
        ownerId: 'owner', cliMsgId: 1, globalMsgId: 1, cliMsgType: 1,
        ts: 1, msg: 'x', attach: '', fromD: '', ttl: 0,
      },
    }), 'owner')).toBe(true);
  });

  it('rejects ordinary group messages', () => {
    expect(isDirectOwnerAddress(message(), 'owner')).toBe(false);
  });

  it('suppresses empty and NO_REPLY agent outputs', () => {
    expect(normalizeAgentReply(' NO_REPLY ')).toBeNull();
    expect(normalizeAgentReply('   ')).toBeNull();
    expect(normalizeAgentReply('```text\nĐang quan sát.\n```')).toBe('Đang quan sát.');
  });
});
