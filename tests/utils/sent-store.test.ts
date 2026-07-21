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

  it('keeps album attachment reverse mappings one-to-one', () => {
    const suffix = Date.now();
    const firstTgId = 800_000_000 + (suffix % 10_000_000);
    const secondTgId = firstTgId + 1;
    const captionMsgId = `caption-${suffix}`;
    const firstAttachmentId = `attachment-a-${suffix}`;
    const secondAttachmentId = `attachment-b-${suffix}`;

    sentMsgStore.save(firstTgId, {
      msgIds: [captionMsgId, firstAttachmentId], zaloId: 'album-group', threadType: 1,
    });
    sentMsgStore.save(secondTgId, {
      msgIds: [secondAttachmentId], zaloId: 'album-group', threadType: 1,
    });

    expect(sentMsgStore.getByZaloMsgId(captionMsgId)).toBe(firstTgId);
    expect(sentMsgStore.getByZaloMsgId(firstAttachmentId)).toBe(firstTgId);
    expect(sentMsgStore.getByZaloMsgId(secondAttachmentId)).toBe(secondTgId);
  });
});
