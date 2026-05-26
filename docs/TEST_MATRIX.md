# zalo-tg Test Matrix

This matrix maps bridge behavior to proof. Keep it current when changing user-visible bridge behavior.

| Story | Contract | Unit | Integration | E2E/Manual | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| REG-name-cache | Manual aliases and `nameCache.preferred()` remain authoritative. | no | no | regression checklist | implemented | `REGRESSION_CHECKLIST.md` |
| REG-mentions | Zalo group mentions render aliases/contact names; own mentions notify `@chuc2rk`. | no | no | regression checklist | implemented | `REGRESSION_CHECKLIST.md` |
| REG-dm-notify | Incoming Zalo DMs include `ZALO_DM_MENTION` in Telegram topics. | no | no | regression checklist | implemented | `REGRESSION_CHECKLIST.md` |
| REG-rich-quotes | Reply quote metadata preserves rich file/media previews and `cliMsgId` fallbacks. | no | no | regression checklist | implemented | `REGRESSION_CHECKLIST.md` |
| REG-caption-strip | Bridge-generated sender-only media captions are stripped when forwarding TG → Zalo; real captions are preserved. | no | no | regression checklist | implemented | `REGRESSION_CHECKLIST.md` |
| US-001-scan-sender-prefix | Zalo → Telegram group/DM messages show a stable visual sender badge plus bold sender name so humans can scan who sent a message quickly. | yes | no | build/manual screenshot | implemented | `npm run build`; `npm test` |
