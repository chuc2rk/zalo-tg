# US-001 Scan-Friendly Sender Prefix

## Status

implemented

## Lane

normal

## Product Contract

Zalo → Telegram forwarded messages should make the original Zalo sender easy to identify at a glance. The bridge should add a stable visual badge derived from the sender name/id before the bold sender name for message headers and media captions.

## Relevant Product Docs

- `docs/ARCHITECTURE.md`
- `docs/TEST_MATRIX.md`
- `REGRESSION_CHECKLIST.md`

## Acceptance Criteria

- Text messages use an HTML-safe sender prefix like `🔵 TL <b>Tấn Lê:</b>` before the content.
- Media captions use the same sender badge before the bold sender name.
- Prefixes are deterministic so the same sender gets the same badge across restarts.
- The formatter remains Telegram HTML-safe.
- Existing DM mention behavior (`@chuc2rk`) is preserved.
- Telegram → Zalo sender-only caption stripping still recognizes bridge captions.

## Design Notes

- Implement pure formatting in `src/utils/format.ts` so it can be unit-tested.
- Use a small stable hash over sender name/id to select an emoji.
- Add initials to reduce confusion when emoji colors repeat.
- Keep the original sender name visible and bold.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | formatter tests for initials, stable emoji, HTML escaping, truncation |
| Integration | `npm run build` |
| E2E/Manual | send/observe Telegram forwarded group message |
| Release | git diff inspection against regression checklist |

## Harness Delta

Added lightweight Harness docs for architecture, test matrix, and this story.

## Evidence

- `npm run build` passed.
- `npm test` passed: 26 formatter tests.
- Diff inspected against `REGRESSION_CHECKLIST.md`.
