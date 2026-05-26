# zalo-tg Architecture Notes

## Surfaces

- Zalo API events enter through `src/zalo/handler.ts`.
- Telegram bot/forum-topic events enter through `src/telegram/handler.ts`.
- Durable bridge state lives in `src/store.ts` plus files under `data/` at runtime.
- Formatting helpers live in `src/utils/format.ts`.

## Zalo → Telegram flow

1. Parse Zalo event and dedupe by Zalo message ids.
2. Resolve sender/topic names via `nameCache`, contacts, friends cache, group member cache, and app API fallbacks.
3. Create/find Telegram forum topic for the Zalo DM/group.
4. Resolve Telegram reply target from Zalo quote ids.
5. Format sender prefix/caption and send text/media to Telegram.
6. Save Telegram message id ↔ Zalo message ids and quote metadata.

## Telegram → Zalo flow

1. Resolve Telegram topic to Zalo peer/group.
2. Strip bridge-generated sender-only captions when forwarding Telegram media back to Zalo.
3. Resolve reply/quote metadata, preferring rich file/media previews and real `cliMsgId` fallbacks.
4. Send to Zalo, then save reverse mapping.

## Behavior contracts that must not regress

- Manual aliases and `nameCache.preferred()` remain authoritative for display names.
- Zalo group mentions render saved aliases/contact names and own mentions notify `@chuc2rk`.
- Zalo DM messages still prefix `ZALO_DM_MENTION` so Telegram notifies Chức.
- Telegram/Zalo reply quote metadata keeps rich file/media previews and `cliMsgId` fallbacks.
- Forwarded bridge-generated sender-only media captions are stripped, while real captions are preserved.
- DM topic name sync avoids unchanged Telegram renames to prevent 429/TOPIC_NOT_MODIFIED spam.
- Zalo → Telegram sender prefixes/captions must be easy to scan without breaking Telegram HTML parse mode.
