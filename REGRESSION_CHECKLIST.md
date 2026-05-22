# zalo-tg Regression Checklist

Before adding a feature, applying upstream changes, or committing a fix, preserve previous local patches. Do not cherry-pick/merge blindly.

## Required checks

- Review `git diff` and confirm no previous fix was removed accidentally.
- Run `npm run build`.
- For upstream changes, prefer manual porting when conflicts touch local fixes.
- Check these behavior contracts:
  - `nameCache.preferred()` / manual aliases stay authoritative (`Ly(KHKT)`, `Nguyễn Toàn(ICV)`).
  - Zalo group mentions render saved aliases correctly.
  - Own mentions still notify Telegram as `@chuc2rk`.
  - Zalo DM topics still prefix owner mention (`ZALO_DM_MENTION`).
  - Telegram/Zalo reply quote metadata keeps rich file/media previews and `cliMsgId` fallbacks.
  - Forwarded bridge-generated sender-only media captions are stripped, real captions preserved.
  - DM topic name sync avoids unchanged Telegram renames to prevent 429/TOPIC_NOT_MODIFIED spam.

Rule from Chức: **new fixes/features must not regress old patches we already spent time fixing.**
