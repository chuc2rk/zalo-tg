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
  - Forwarded bridge-generated sender-only media captions/text headers are stripped, real captions/text preserved, including scan badges like `🔵` and `BẠN / ━━━━━━━━` headers.
  - Telegram forwards never inherit the forum topic root as a Zalo quote, and sender-only forwarded media captions are stripped before any reply auto-mention is added.
  - TG media groups wait long enough for all selected photos/videos to join the same Zalo send; forwarding two photos must not silently flush only the first item.
  - TG→Zalo media groups keep reverse mappings per attachment and visibly warn in the Telegram topic when only part of an album can be downloaded/sent.
  - Zalo→Telegram albums map each Telegram media-group item to its matching Zalo photo IDs/quote, even when another album item fails to download.
  - Zalo→Telegram album buffering must not double-download or leak unused eager photo downloads.
  - Local Bot API `file://` downloads copy into bridge temp storage without deleting the server-owned source file.
  - Zalo shared links accept only valid HTTP(S) URLs and remain HTML-safe; bank-card server fetches accept only trusted Zalo HTTPS hosts with timeout/size limits.
  - Credentials, app-session and auto-reply state are written atomically with owner-only (`0600`) permissions.
  - Scheduled backups exclude auth/session secrets by default; secret-inclusive recovery backups must be GPG-encrypted and never upload the plaintext archive.
  - Startup/reconnect catch-up and `/history` use listener WebSocket `old_messages`, never the removed HTTP `/api/group/history`; automatic catch-up accepts only recent timestamped messages and still deduplicates through `msgStore`.
  - Telegram video/TGS/static stickers retain animation or transparency when bridged to Zalo, with thumbnail/original fallbacks if rendering fails.
  - Zalo animated sticker sprite sheets are converted to real Telegram GIF animations; conversion/upload failures retain a visible static fallback.
  - Telegram GIF animations arrive from Bot API as MP4 (`animation.gif.mp4`) but are transcoded to a real `.gif` before sending to Zalo.
  - Media conversion uses bundled `ffmpeg-static`, so GIF/sticker/audio/video conversion does not depend on a system-wide FFmpeg installation.
  - Zalo reactions in group topics use native Telegram reactions only; they must not create reply/quote summary messages. Unsupported icons are skipped silently.
  - Hidden-member Zalo groups warn when Web API data is partial, and a fresh `/loginapp` clears the loaded-set so member names can be repopulated from PC App API.
  - TG→Zalo long text split into chunks saves all returned Zalo `msgId`s so later self-echo/reply handling does not leak the last chunk back to Telegram.
  - TG→Zalo reverse mappings survive a process restart, so a later Zalo reply still points to the original Telegram message instead of appearing without a quote.
  - Concurrent TG→Zalo sends to the same conversation keep pending echo suppression ref-counted; one fast send must not clear suppression while another long/forwarded send is still active.
  - DM topic name sync avoids unchanged Telegram renames to prevent 429/TOPIC_NOT_MODIFIED spam.
  - Zalo→Telegram sender badges stay deterministic and HTML-safe without breaking captions/replies.

Rule from Chức: **new fixes/features must not regress old patches we already spent time fixing.**
