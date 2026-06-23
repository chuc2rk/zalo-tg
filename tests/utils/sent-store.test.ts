import { describe, expect, it } from 'vitest';
import { sentMsgStore } from '../../src/store.js';

describe('sentMsgStore concurrent send suppression', () => {
  it('keeps isSendingTo true until all concurrent sends to the same Zalo conversation finish', () => {
    const zaloId = `test-concurrent-${Date.now()}`;

    sentMsgStore.markSending(zaloId);
    sentMsgStore.markSending(zaloId);

    expect(sentMsgStore._testPendingCount(zaloId)).toBe(2);
    expect(sentMsgStore.isSendingTo(zaloId)).toBe(true);

    sentMsgStore.unmarkSending(zaloId);

    expect(sentMsgStore._testPendingCount(zaloId)).toBe(1);
    expect(sentMsgStore.isSendingTo(zaloId)).toBe(true);

    sentMsgStore.unmarkSending(zaloId);

    expect(sentMsgStore._testPendingCount(zaloId)).toBe(0);
    expect(sentMsgStore.isSendingTo(zaloId)).toBe(false);
  });
});
