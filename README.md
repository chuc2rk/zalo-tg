<div align="center">

# ⚡ zalo-tg

### A production-oriented, stateful interoperability bridge between **Zalo** and **Telegram**

`zalo-tg` transforms Telegram Forum Topics into a structured operational console for Zalo conversations, while preserving message identity, media semantics, replies, reactions, recalls, mentions, polls, and long-lived conversation state.

<br />

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](#)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5_18-339933?style=for-the-badge&logo=node.js&logoColor=white)](#requirements)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](#architecture)
[![Zalo](https://img.shields.io/badge/Zalo-Bridge-0068FF?style=for-the-badge&logo=zalo&logoColor=white)](#zalo-authentication)
[![License](https://img.shields.io/badge/License-Repository_File-111827?style=for-the-badge)](#license)

<br />

[Overview](#-system-overview) •
[Architecture](#-architecture) •
[Features](#-capability-surface) •
[Installation](#-installation) •
[Configuration](#-configuration) •
[Commands](#-bot-command-surface) •
[Security](#-security-model)

<br />

> **Vietnamese documentation:** [README.vi.md](README.vi.md)

</div>

---

## 📌 Table of Contents

- [System Overview](#-system-overview)
- [Architectural Principles](#-architectural-principles)
- [Architecture](#-architecture)
- [Capability Surface](#-capability-surface)
- [Message Compatibility Matrix](#-message-compatibility-matrix)
- [Interaction Synchronisation](#-interaction-synchronisation)
- [Poll Synchronisation](#-poll-synchronisation)
- [Group and Topic Lifecycle](#-group-and-topic-lifecycle)
- [Requirements](#-requirements)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Running the Bridge](#-running-the-bridge)
- [Zalo Authentication](#-zalo-authentication)
- [Large File Transfer](#-large-file-transfer--20-mb)
- [Bot Command Surface](#-bot-command-surface)
- [Project Structure](#-project-structure)
- [Persistent Data Model](#-persistent-data-model)
- [Security Model](#-security-model)
- [Contributors](#-contributors)
- [License](#-license)

---

## 🧭 System Overview

`zalo-tg` is a **bidirectional, state-aware synchronisation layer** that connects the Zalo messaging ecosystem with Telegram through a Telegram bot. Each Zalo conversation—either a direct message or a group conversation—is deterministically represented as an isolated **Telegram Forum Topic** inside a configured Telegram supergroup.

Unlike a conventional relay bot that merely forwards text payloads, this project implements a richer interoperability model. It maintains cross-platform message correlation, reconstructs reply chains, translates media objects, mirrors selected interaction primitives, resolves mentions and aliases, and coordinates poll state between two messaging platforms with fundamentally different event models.

> [!IMPORTANT]
> `zalo-tg` is designed as an operational bridge, not a stateless message forwarder. Its correctness depends on persisted topic mappings, runtime message indexes, session material, and careful event translation across Zalo and Telegram.

### High-level Behaviour

| Domain | Behaviour |
|---|---|
| Conversation mapping | Each Zalo thread maps to one Telegram Forum Topic. |
| Inbound Zalo events | Zalo messages are decoded, normalised, enriched, then emitted to Telegram. |
| Inbound Telegram updates | Telegram messages are interpreted, transformed, uploaded, then delivered to Zalo. |
| Message identity | Zalo and Telegram message identifiers are indexed bidirectionally. |
| Context preservation | Replies, recalls, reactions, mentions, media albums, and poll updates are reconstructed when enough metadata is available. |
| Failure posture | Missing historical mappings degrade gracefully instead of breaking the forwarding pipeline. |

---

## 🧠 Architectural Principles

`zalo-tg` is built around a few core engineering principles:

<table>
<tr>
<td width="33%">

### 🧩 Semantic Preservation

The bridge attempts to preserve the *meaning* of messages, not only their raw textual content. Attachments, replies, mentions, reactions, locations, contacts, and polls are translated into the closest platform-native representation.

</td>
<td width="33%">

### 🔁 Bidirectional Correlation

Every supported event direction maintains a correlation layer between Zalo message identifiers and Telegram message identifiers, enabling reply resolution, recall propagation, and contextual reconstruction.

</td>
<td width="33%">

### 🛡️ Graceful Degradation

When a mapping, media object, quote target, or metadata fragment cannot be resolved, the system continues forwarding the message while omitting only the unavailable semantic layer.

</td>
</tr>
</table>

---

## 🏗️ Architecture

The bridge executes as a single long-lived **Node.js** process. It maintains two concurrently active client layers:

1. A **Telegram Bot API client**, implemented with [`Telegraf`](https://github.com/telegraf/telegraf), using long polling.
2. A **Zalo client**, implemented with [`zca-js`](https://github.com/RFS-ADRENO/zca-js), connected to Zalo's internal WebSocket interface.

Both clients communicate through shared runtime stores and persisted metadata. These stores act as the correlation substrate required to translate stateful message semantics between the two platforms.

```mermaid
flowchart LR
    ZALO["Zalo WebSocket API"]
    ZClient["src/zalo/client.ts<br/>Session lifecycle<br/>Web API login"]
    LoginApp["src/zalo/loginApp.ts<br/>PC App QR login"]
    AppApi["src/zalo/appApi.ts<br/>PC App API<br/>Rate-limit isolation"]
    ZHandler["src/zalo/handler.ts<br/>Zalo event decoder"]
    Store[("src/store.ts<br/>Runtime + persistent state")]
    THandler["src/telegram/handler.ts<br/>Telegram update decoder"]
    TBot["Telegram Bot API<br/>Long polling"]

    ZALO --> ZClient
    ZClient --> LoginApp
    ZClient --> AppApi
    ZClient --> ZHandler
    ZHandler --> Store
    Store --> THandler
    THandler --> TBot
    TBot --> THandler
    THandler --> Store
    Store --> ZHandler
    ZHandler --> ZClient
```

### Runtime State Plane

```mermaid
flowchart TB
    Store["Central Store"]
    Topic["topicStore<br/>Zalo conversation ↔ Telegram topic"]
    Msg["msgStore<br/>Zalo message ↔ Telegram message"]
    Sent["sentMsgStore<br/>Telegram-originated reverse index"]
    Poll["pollStore<br/>Poll metadata + score message"]
    Media["mediaGroupStore<br/>Telegram album buffer"]
    Album["zaloAlbumStore<br/>Zalo album buffer"]
    User["userCache<br/>UID/display-name lookup"]
    Alias["aliasCache<br/>Local nickname resolution"]
    Friends["friendsCache<br/>5-minute friends TTL"]

    Store --> Topic
    Store --> Msg
    Store --> Sent
    Store --> Poll
    Store --> Media
    Store --> Album
    Store --> User
    Store --> Alias
    Store --> Friends
```

### State Model

The topic mapping is persisted in `data/topics.json`, ensuring that known Zalo conversations remain attached to stable Telegram Forum Topics across process restarts.

Message-ID mappings are primarily maintained in memory with LRU-style eviction. A compressed persisted mapping file, `data/msg-map.json`, allows reply-chain resolution to survive restarts. If a historical mapping is unavailable, the system deliberately degrades by omitting Telegram `reply_parameters` or Zalo quote metadata rather than failing the forwarding operation.

---

## ✨ Capability Surface

| Capability | Status | Technical Notes |
|---|:---:|---|
| Bidirectional message forwarding | ✅ | Zalo ⇄ Telegram event projection. |
| Forum Topic provisioning | ✅ | Automatic topic creation per Zalo conversation. |
| Rich media forwarding | ✅ | Photos, albums, videos, GIFs, files, stickers, voice notes, contacts, locations, and selected web content. |
| Reply-chain preservation | ✅ | Requires available message correlation metadata. |
| Reaction propagation | ✅ | Emoji compatibility mapping and contextual fallback messages. |
| Message recall | ✅ | Zalo undo → Telegram deletion; Telegram `/recall` → Zalo undo. |
| Poll synchronisation | ✅ | Native polls, score messages, vote propagation, and lock handling. |
| Mention resolution | ✅ | Display names, Telegram usernames, Zalo UIDs, and aliases. |
| Rate-limit mitigation | ✅ | Optional PC App API session for selected lookup paths. |
| Large file transfer | ✅ | Optional local Telegram Bot API server, up to 2 GB. |

---

## 🧾 Message Compatibility Matrix

### Zalo → Telegram

| Zalo message type | Telegram representation | Notes |
|---|---|---|
| `webchat` | `sendMessage` | HTML parse mode; Zalo mentions are rendered safely. |
| `chat.photo` | `sendPhoto` / `sendMediaGroup` | Albums are buffered for 600 ms before emission. |
| `chat.video.msg` | `sendVideo` | Preserves native video representation. |
| `chat.gif` | `sendAnimation` | Uses Telegram animation semantics. |
| `share.file` | `sendDocument` | Retains the original filename. |
| `chat.voice` | `sendVoice` | Preserves voice-note UX. |
| `chat.sticker` | `sendSticker` / `sendPhoto` | WebP sticker path with photo fallback for oversized assets. |
| `chat.doodle` | `sendPhoto` | Rendered as an image asset. |
| `chat.recommended` | `sendMessage` | Inline link preview. |
| `chat.location.new` | `sendLocation` | Telegram native map widget. |
| `chat.webcontent` — bank card | `sendPhoto` | VietQR image plus account metadata. |
| `chat.webcontent` — generic | `sendMessage` | Icon and label metadata. |
| Contact card | `sendPhoto` / text fallback | QR code, name, and ID when available. |
| `group.poll` — create | `sendPoll` + score message | Includes editable score message and inline lock control. |
| `group.poll` — vote update | Score-message edit | Updated counts with compact bar visualization. |

### Telegram → Zalo

| Telegram content | Zalo operation | Notes |
|---|---|---|
| Text | `sendMessage` | Includes mention-resolution pipeline. |
| Single photo | `sendMessage` with image attachment | Caption participates in mention resolution. |
| Photo album | `sendMessage` with multiple attachments | Albums are buffered for 500 ms. |
| Single video | `sendMessage` with video attachment | Native attachment upload. |
| Video album | `sendMessage` with multiple attachments | Buffered media-group handling. |
| Animation / GIF | `sendMessage` with attachment | Download and upload pipeline. |
| Document | `sendMessage` with attachment | Preserves document payload. |
| Voice note | `sendVoice` | Converts OGG Opus to M4A through `ffmpeg`. |
| Static WebP sticker | `sendMessage` with attachment | Static sticker forwarding. |
| Animated/video sticker | Thumbnail attachment | JPEG thumbnail fallback. |
| Location | `sendLink` / `sendMessage` fallback | Google Maps URL bridge. |
| Contact | `sendMessage` | Name and phone number serialization. |
| Poll | `createPoll` | Also creates a bot-owned non-anonymous Telegram clone poll for vote tracking. |

---

## 🔄 Interaction Synchronisation

### Reply Chains

When a Telegram message replies to another Telegram message, the bridge attempts to resolve the target message back to a Zalo-compatible quote object. That quote metadata is then passed to `sendMessage`, allowing the forwarded Zalo message to retain conversational context.

For messages originally sent from Telegram to Zalo, the reverse lookup is performed through `sentMsgStore`, ensuring that replies remain coherent even when the original message did not originate from Zalo.

```mermaid
sequenceDiagram
    participant TG as Telegram Topic
    participant Store as Mapping Store
    participant Bridge as zalo-tg
    participant Zalo as Zalo Conversation

    TG->>Bridge: Reply message update
    Bridge->>Store: Resolve reply target
    alt Mapping exists
        Store-->>Bridge: Zalo quote metadata
        Bridge->>Zalo: sendMessage(text, quote)
    else Mapping missing
        Store-->>Bridge: No historical mapping
        Bridge->>Zalo: sendMessage(text)
    end
```

### Reactions

Telegram `message_reaction` updates are mapped through a static emoji compatibility table and forwarded to Zalo with `addReaction`. In the opposite direction, Zalo reactions are represented in Telegram as concise contextual replies so that reaction activity remains visible even when Telegram lacks a one-to-one representation for the source event.

### Message Recall

Zalo `undo` events are mirrored by deleting the corresponding Telegram message when a mapping exists. On the Telegram side, the `/recall` command invokes `api.undo` for messages previously sent by the bot into Zalo.

### Mentions and Aliases

Zalo `@mention` spans are rendered on Telegram with safe HTML formatting. Telegram `@username` entities and plain-text `@Name` patterns are resolved to Zalo UIDs through `userCache`.

The bridge also supports Zalo contact aliases. If a Zalo user has a local nickname configured in the address book, `@Alias` can resolve to the correct UID even when the visible display name differs. Captions attached to photos, videos, and documents participate in the same mention-resolution pipeline.

---

## 🗳️ Poll Synchronisation

Poll synchronisation is implemented as a coordinated state machine rather than a naive forwarding rule. This is necessary because Zalo and Telegram expose materially different poll models, authoring constraints, and vote-update events.

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Mirrored: Create native counterpart
    Mirrored --> Voting: Receive vote event
    Voting --> Refreshing: Fetch authoritative poll detail
    Refreshing --> Mirrored: Edit score message
    Mirrored --> Locked: Close / lock poll
    Locked --> Finalized: Stop poll + final score update
    Finalized --> [*]
```

Supported flows:

| Flow | Implementation |
|---|---|
| Zalo poll creation → Telegram | Creates a native Telegram poll and an editable score message. |
| Telegram poll creation → Zalo | Calls Zalo `createPoll` and creates a bot-owned Telegram clone poll. |
| Telegram `poll_answer` → Zalo | Calls Zalo `votePoll`, then refreshes score state through `getPollDetail`. |
| Zalo vote event → Telegram | Handles `group_event` with `boardType=3`, then edits the score message. |
| Poll closure | Calls Zalo `lockPoll`, Telegram `stopPoll`, and final score-message update. |

> [!NOTE]
> The bot-owned clone poll is required because Telegram only emits `poll_answer` updates for polls created by the bot itself. This design preserves vote visibility while keeping the user-facing interface native to Telegram.

---

## 🧵 Group and Topic Lifecycle

When the bridge observes a new Zalo group conversation, it automatically creates a dedicated Telegram Forum Topic for that conversation. If a group avatar is available, the avatar is fetched and pinned as the first topic message, making the topic immediately recognisable.

Group lifecycle events—joins, leaves, removals, blocks, and selected administrative updates—are forwarded as italicised system messages inside the corresponding Telegram topic.

```mermaid
flowchart LR
    A["Observe unknown Zalo group"] --> B["Create Telegram Forum Topic"]
    B --> C["Persist mapping in data/topics.json"]
    C --> D["Fetch group avatar if available"]
    D --> E["Pin avatar / identity message"]
    E --> F["Forward future group events into topic"]
```

---

## 📦 Requirements

| Dependency | Required Version | Purpose |
|---|---:|---|
| Node.js | `>= 18` | Runtime with native ESM support. |
| npm | `>= 9` | Dependency installation and script execution. |
| ffmpeg | Recent version | OGG Opus → M4A conversion for Telegram voice notes. |
| Telegram Bot | — | Created through [@BotFather](https://t.me/BotFather). |
| Telegram Supergroup | — | Forum Topics must be enabled. |
| Zalo account | — | Active account with persisted session material. |

### Required Telegram Administrator Permissions

- Manage topics.
- Delete messages.
- Pin messages.
- Manage the group, including reaction-related update access.

---

## 🚀 Installation

```bash
git clone https://github.com/williamcachamwri/zalo-tg
cd zalo-tg
npm install
cp .env.example .env
```

After installing dependencies, configure the environment variables in `.env` before starting the bridge.

---

## ⚙️ Configuration

Edit `.env` with the required runtime configuration:

```env
# Telegram Bot token obtained from @BotFather
TG_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Telegram supergroup ID. This is a negative integer, for example: -1001234567890
TG_GROUP_ID=-1001234567890

# Directory for persistent bridge state. Defaults to ./data when omitted.
DATA_DIR=./data

# Skip forwarding messages from muted Zalo groups.
# Accepted truthy values: true, 1, yes, on
ZALO_SKIP_MUTED_GROUPS=false
```

### Configuration Reference

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `TG_TOKEN` | ✅ | — | Telegram bot token issued by BotFather. |
| `TG_GROUP_ID` | ✅ | — | Target Telegram supergroup ID with Forum Topics enabled. |
| `DATA_DIR` | ❌ | `./data` | Directory used for persistent bridge state. |
| `ZALO_SKIP_MUTED_GROUPS` | ❌ | `false` | Skips forwarding from muted Zalo groups when enabled. |
| `LOCAL_BOT_API` | ❌ | `0` | Enables local Telegram Bot API mode when set to `1`. |
| `TG_LOCAL_SERVER` | Conditional | — | Local Bot API base URL. |
| `TG_API_ID` | Conditional | — | Telegram application API ID for local Bot API setup. |
| `TG_API_HASH` | Conditional | — | Telegram application API hash for local Bot API setup. |

---

## ▶️ Running the Bridge

### Development Mode

```bash
npm run dev
```

Development mode uses `tsx watch`, enabling hot reload during local iteration.

### Production Mode

```bash
npm run build
npm start
```

Production mode compiles the TypeScript source before starting the Node.js process.

### Recommended Runtime Checklist

- [ ] `.env` is configured.
- [ ] Telegram bot is added to the target supergroup.
- [ ] Forum Topics are enabled in the supergroup.
- [ ] Bot has the required administrator permissions.
- [ ] Zalo session has been created through `/loginweb` or `/login`.
- [ ] Optional PC App session has been created through `/loginapp`.
- [ ] `ffmpeg` is available in `PATH` if voice-note bridging is required.

---

## 🔐 Zalo Authentication

The bridge supports two independent Zalo authentication mechanisms. Either flow can be initiated from the configured Telegram group through bot commands.

### `/loginweb` — Web API Session

`/loginweb` creates a standard `zca-js` Web API session. This is equivalent to the legacy `/login` command.

**Procedure**

1. Send `/loginweb` in any topic of the bridged Telegram group.
2. The bot replies with a Zalo QR code image.
3. Scan the QR code in the Zalo mobile app through **Settings → QR Code Login**.
4. The session is persisted to `data/credentials.json`.

> [!WARNING]
> The Web API is subject to endpoint-level rate limits. During startup with many groups, HTTP `221` rate-limit responses may occur. The PC App session provides a separate lookup path for selected operations.

### `/loginapp` — PC App API Session

`/loginapp` creates a Zalo PC App session using the `wpa.zaloapp.com` and `zaloapp.com` cookie domains. This session is stored independently from the Web API session and is primarily used for group-member lookup operations.

**Procedure**

1. Send `/loginapp` in any topic of the bridged Telegram group.
2. The bot replies with a Zalo QR code.
3. Scan the QR code in the Zalo mobile app. Zalo treats this as a PC App login.
4. The session is persisted to `data/app-session.json`.

The stored session includes:

| Field | Description |
|---|---|
| `zpw_enk` | Base64-encoded AES session encryption key. |
| `imei` | Device identifier. |
| `cookies` | Raw `zaloapp.com` cookie array. |

### Why the PC App Session Matters

The PC App session allows `populateGroupMemberCache` to query `group-wpa.zaloapp.com` instead of relying exclusively on the Web API. This places member lookup traffic into a different rate-limit bucket and substantially reduces startup failure probability when many groups must be indexed.

The same session is also used by member-name lookups through `profile-wpa.zaloapp.com/api/social/group/members`. If no PC App session is available, the bridge falls back to the Web API automatically.

### Member Cache Population Strategy

| Tier | Source | Additional API Call | Operational Cost |
|---:|---|:---:|---|
| 1 | `currentMems` embedded in `getGroupInfo` | No | Lowest |
| 2 | `profile-wpa.zaloapp.com/api/social/group/members` through PC App API | Yes | Isolated rate-limit bucket |
| 3 | `getUserInfo` through Web API | Yes | Rate-limited fallback |

Tiers 2 and 3 are only used for UIDs not already resolved by tier 1, which is typically sufficient for groups below approximately 200 members.

---

## 📁 Large File Transfer &gt; 20 MB

The official Telegram Bot API imposes restrictive file-size limits for bot downloads and uploads. To support larger transfers—up to **2 GB**—`zalo-tg` can optionally operate against a **local Telegram Bot API server**.

### Quick Start

1. Build or download the local Telegram Bot API server. See [Local Bot API Setup Guide](LOCAL_BOT_API_SETUP.md).

2. Log the bot out of the official Telegram Bot API once:

   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/logOut"
   ```

3. Start the local Bot API server:

   ```bash
   telegram-bot-api \
     --api-id=<YOUR_API_ID> \
     --api-hash=<YOUR_API_HASH> \
     --local \
     --dir=~/zalo-tg-bot-api/data \
     --http-port=8081
   ```

4. Enable local mode in `.env`:

   ```env
   LOCAL_BOT_API=1
   TG_LOCAL_SERVER=http://localhost:8081
   TG_API_ID=your_api_id
   TG_API_HASH=your_api_hash
   ```

5. Rebuild and restart the bridge:

   ```bash
   npm run build
   npm start
   ```

### `LOCAL_BOT_API` Behaviour

| Value | Behaviour |
|---|---|
| `LOCAL_BOT_API=1` | Uses the local server configured by `TG_LOCAL_SERVER`. File transfers can reach up to **2 GB**. |
| `LOCAL_BOT_API=0` | Uses the official `api.telegram.org` endpoint. File limits follow official Bot API constraints. |

Important operational details:

- When local mode is enabled, all Telegram Bot API traffic is routed through the configured local server.
- When local mode is disabled or omitted, `TG_LOCAL_SERVER`, `TG_API_ID`, and `TG_API_HASH` are ignored.
- Switching between official and local modes requires a logout/login cycle.
- `file_id` values are not portable between official and local Bot API modes.
- Upload timeouts are computed dynamically from file size, with a 30-second minimum and a 10-minute upper cap.

To switch from local mode back to the official Telegram Bot API:

```bash
curl "http://localhost:8081/bot<YOUR_BOT_TOKEN>/logOut"
```

Then stop the local server and set:

```env
LOCAL_BOT_API=0
```

### Local Bot API Advantages

- Supports file transfers up to **2 GB**.
- Avoids unnecessary download overhead by copying files directly from the local server when possible.
- Can be enabled or disabled through configuration without changing source code.
- Preserves compatibility with older official-api `file_id` values through fallback logic.
- Performs automatic cleanup of local files after successful delivery.

For platform-specific setup instructions, including macOS, Linux, Windows, systemd, Windows Task Scheduler, and troubleshooting, see [Local Bot API Setup Guide](LOCAL_BOT_API_SETUP.md).

> Vietnamese version: [Hướng dẫn thiết lập Local Bot API](LOCAL_BOT_API_SETUP.vi.md)

---

## 🤖 Bot Command Surface

| Command | Description |
|---|---|
| `/login` | Starts Zalo QR login through the Web API. Equivalent to `/loginweb`. |
| `/loginweb` | Starts Zalo QR login through the Web API and persists the session to `credentials.json`. |
| `/loginapp` | Starts Zalo QR login through the PC App API and persists the session to `app-session.json`. Enables lower-pressure group-member lookups. |
| `/search <query>` | Searches the Zalo friends list and allows the user to create a direct-message topic from a selected result. |
| `/recall` | Retracts a message previously sent by the bot from Telegram to Zalo. Must be used as a reply to the target message. |
| `/topic list` | Lists active Telegram-topic-to-Zalo-conversation mappings. |
| `/topic info` | Shows the Zalo conversation metadata associated with the current topic. |
| `/topic delete` | Removes the mapping associated with the current topic. |

---

## 🧬 Project Structure

```text
src/
├── index.ts                  Application entry point. Initialises Telegraf,
│                             creates the Zalo client, attaches handlers,
│                             and starts polling.
│
├── config.ts                 Reads, validates, and normalises environment variables.
│
├── store.ts                  Centralised runtime and persistent state management:
│                               - topicStore       persisted topic mappings
│                               - msgStore         Zalo msgId ↔ Telegram message_id
│                               - sentMsgStore     Telegram-to-Zalo reverse index
│                               - pollStore        poll and score-message mappings
│                               - mediaGroupStore  Telegram media-group buffer
│                               - zaloAlbumStore   Zalo album buffer
│                               - userCache        UID and display-name lookup
│                               - aliasCache       alias-to-UID resolution
│                               - friendsCache     friends list with 5-minute TTL
│
├── telegram/
│   ├── bot.ts                Telegraf instance configuration, allowed updates,
│   │                         and bot-command registration.
│   └── handler.ts            Telegram update processor. Handles text, media,
│                             voice, stickers, polls, locations, contacts,
│                             reactions, callback queries, and poll answers.
│                             Mention resolution uses display names first,
│                             followed by aliases.
│
├── zalo/
│   ├── client.ts             Zalo API initialisation and Web API QR login.
│   ├── loginApp.ts           PC App QR login flow and zaloapp.com session storage.
│   ├── appApi.ts             Direct PC App API helpers for group and member
│   │                         lookups. Supports AES-128, AES-192, and AES-256
│   │                         session-key detection.
│   ├── types.ts              TypeScript interfaces and ZALO_MSG_TYPES constants.
│   └── handler.ts            Zalo listener processor. Handles message events,
│                             undo events, reactions, and group events including
│                             joins, leaves, poll updates, and board updates.
│
└── utils/
    ├── format.ts             HTML escaping, mention application, and caption helpers.
    └── media.ts              Temporary media download, cleanup, and OGG-to-M4A conversion.
```

---

## 🗄️ Persistent Data Model

### `data/credentials.json`

Stores the Zalo **Web API** session created by `/loginweb` or `/login`. This file contains authentication material equivalent to account credentials and must be protected accordingly.

### `data/app-session.json`

Stores the Zalo **PC App** session created by `/loginapp`.

| Field | Purpose |
|---|---|
| `zpw_enk` | Base64-encoded AES session key. AES-128, AES-192, and AES-256 are auto-detected by key length. |
| `imei` | Device identifier. |
| `cookies` | Raw `zaloapp.com` cookie array. |

This session is consumed exclusively by `appApi.ts` for calls to `group-wpa.zaloapp.com` and `profile-wpa.zaloapp.com`. The file is listed in `.gitignore` and must be handled with the same care as `credentials.json`.

### `data/topics.json`

Stores the persistent mapping between each Zalo conversation ID and its Telegram Forum Topic ID. The file also includes conversation metadata such as display name and conversation type. It is written whenever a new topic mapping is created and read once at startup.

### `data/msg-map.json`

Stores the bidirectional relationship between Zalo message IDs and Telegram message IDs. Despite the `.json` suffix, the file is gzip-compressed and detected through the `0x1F 0x8B` gzip magic bytes at load time.

The current v2 format uses string interning and positional arrays to reduce I/O overhead and disk usage.

#### v2 Format

```jsonc
{
  "v": 2,
  // String intern table. Repeated strings such as zaloId, msgType, and UID
  // are stored once and referenced by index in the arrays below.
  "s": ["850431…", "webchat", "uid123", …],

  // Message pairs: [zaloMsgIdIndex, telegramMessageId]
  "p": [[0, 123456], [1, 123457], …],

  // Quote metadata used for reply-chain reconstruction and auto-mention:
  // [tgId, msgIdIdx, cliMsgIdIdx, uidFromIdx, ts, msgTypeIdx, content, ttl, zaloIdIdx, threadType]
  "q": [[123456, 0, 1, 2, 1746000000, 5, "hello", 0, 0, 1], …]
}
```

#### Filtering `"0"` Message IDs

Zalo may emit `realMsgId = 0` for messages without a secondary identifier. In earlier formats, these values were serialised as the string `"0"`, which caused unrelated messages to collide under the same lookup key.

The current implementation discards these entries during both save and load:

- Legitimate Zalo message lookups do not target `"0"`; real Zalo message IDs are timestamp-like identifiers.
- Retaining `"0"` entries can produce false-positive reply targets because the most recent message with `realMsgId = 0` overwrites previous entries.
- Filtering these entries substantially reduces persisted mapping size.

#### Size Evolution

| Format | Approximate Size |
|---|---:|
| v1 plain JSON | ~80 KB |
| v2 interned strings and positional arrays | ~46 KB, approximately 44% smaller |
| v2 with gzip level 9 and zero-ID filtering | ~13 KB, approximately 85% smaller |

For the current mapping size, `gunzipSync` on the compressed file is measurably faster than parsing the original 80 KB JSON representation. Compression is implemented with Node.js' built-in `node:zlib` module and requires no additional dependency.

---

## 🛡️ Security Model

> [!CAUTION]
> Treat `.env`, `credentials.json`, and `app-session.json` as sensitive operational secrets. They should never be committed, shared, or copied into untrusted environments.

Security considerations:

- Never commit `.env`, `credentials.json`, or `app-session.json` to version control.
- `credentials.json` contains a Zalo Web API session and should be treated as equivalent to an account password.
- `app-session.json` contains a Zalo PC App session and must be protected with the same level of care.
- The bridge is designed for a trusted, single-operator or small-team environment.
- The Telegram supergroup should remain private and restricted to trusted members, because group members can send messages through the bridge.
- Outbound requests to Telegram and Zalo are transmitted over TLS.
- The bridge does not intentionally log credentials.
- The `/recall` command is available to group members and can retract messages sent by the bot. Restrict group membership and bot permissions according to your operational risk model.

---

## 👥 Contributors

Thanks to everyone who has contributed to this project.

### Code Contributors

- [@thanhnguyenhy234](https://github.com/thanhnguyenhy234)
- [@leolionart](https://github.com/leolionart)
- [@chuc2rk](https://github.com/chuc2rk)

### Contributing

Contributions are welcome. Bug fixes, documentation improvements, architectural refinements, compatibility patches, and feature proposals can be submitted through pull requests.

To be listed as a contributor, submit a meaningful contribution through a pull request that is reviewed and merged into the project.

---

## 📜 License

See the repository license file for licensing terms.

<div align="center">

<br />

**Built for resilient cross-platform messaging operations.**

</div>
