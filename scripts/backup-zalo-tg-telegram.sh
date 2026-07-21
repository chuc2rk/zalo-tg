#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${TG_TOKEN:?Missing TG_TOKEN in .env}"
: "${TG_GROUP_ID:?Missing TG_GROUP_ID in .env}"

BACKUP_DIR="${ZALO_TG_BACKUP_DIR:-/home/chuc2rk/backups/zalo-tg}"
META_DIR="$ROOT_DIR/data/backup-meta"
THREAD_FILE="$META_DIR/telegram-backup-thread-id"
TOPIC_NAME="${ZALO_TG_BACKUP_TOPIC_NAME:-Zalo bridge backups}"
RETENTION_DAYS="${ZALO_TG_BACKUP_RETENTION_DAYS:-30}"
INCLUDE_SECRETS="${ZALO_TG_BACKUP_INCLUDE_SECRETS:-0}"
DRY_RUN="${ZALO_TG_BACKUP_DRY_RUN:-0}"
PASSPHRASE_FILE="${ZALO_TG_BACKUP_PASSPHRASE_FILE:-$META_DIR/backup-passphrase}"
STAMP="$(date +%F-%H%M%S)"
PLAIN_ARCHIVE="$BACKUP_DIR/zalo-tg-backup-$STAMP.tar.gz"
ARCHIVE="$PLAIN_ARCHIVE"
MANIFEST="$BACKUP_DIR/manifest-$STAMP.txt"

mkdir -p "$BACKUP_DIR" "$META_DIR"
chmod 700 "$META_DIR" "$BACKUP_DIR" 2>/dev/null || true

# Rebuildable/heavy paths are always excluded. Auth/session secrets are excluded
# by default and may only be included in a GPG-encrypted archive.
EXCLUDES=(
  "--exclude=.git"
  "--exclude=node_modules"
  "--exclude=dist"
  "--exclude=logs"
  "--exclude=data/bot-api"
  "--exclude=data/backup-meta/backup-passphrase"
  "--exclude=data/zalo-tg.pid"
  "--exclude=*.log"
)
SECRET_FIND_EXCLUDES=(
  "!" "-path" "./.env"
  "!" "-path" "./credentials.json"
  "!" "-path" "./app-session.json"
  "!" "-path" "./data/credentials.json"
  "!" "-path" "./data/app-session.json"
  "!" "-path" "./data/backup-meta/backup-passphrase"
)

if [[ "$INCLUDE_SECRETS" != "1" ]]; then
  EXCLUDES+=(
    "--exclude=.env"
    "--exclude=credentials.json"
    "--exclude=app-session.json"
    "--exclude=data/credentials.json"
    "--exclude=data/app-session.json"
    "--exclude=*.pem"
    "--exclude=*.key"
    "--exclude=*.secret"
  )
else
  command -v gpg >/dev/null 2>&1 || { echo "gpg is required for secret backups" >&2; exit 1; }
  [[ -f "$PASSPHRASE_FILE" && -s "$PASSPHRASE_FILE" ]] || {
    echo "Secret backup requested but passphrase file is missing/empty: $PASSPHRASE_FILE" >&2
    exit 1
  }
  chmod 600 "$PASSPHRASE_FILE" 2>/dev/null || true
fi

: > "$MANIFEST"
{
  echo "zalo-tg backup manifest"
  echo "created_at=$(date -Is)"
  echo "root=$ROOT_DIR"
  echo "contains_secrets=$INCLUDE_SECRETS"
  echo
  echo "included files sha256/size/path:"
  if [[ "$INCLUDE_SECRETS" == "1" ]]; then
    find . -type f \
      ! -path './.git/*' ! -path './node_modules/*' ! -path './dist/*' \
      ! -path './logs/*' ! -path './data/bot-api/*' ! -path './data/zalo-tg.pid' \
      ! -path './data/backup-meta/backup-passphrase' ! -name '*.log' -print0
  else
    find . -type f \
      ! -path './.git/*' ! -path './node_modules/*' ! -path './dist/*' \
      ! -path './logs/*' ! -path './data/bot-api/*' ! -path './data/zalo-tg.pid' \
      "${SECRET_FIND_EXCLUDES[@]}" \
      ! -name '*.log' ! -name '*.pem' ! -name '*.key' ! -name '*.secret' -print0
  fi | sort -z | while IFS= read -r -d '' f; do
    size="$(stat -c '%s' "$f")"
    sha="$(sha256sum "$f" | awk '{print $1}')"
    printf '%s  %s bytes  %s\n' "$sha" "$size" "${f#./}"
  done
} >> "$MANIFEST"

tar -czf "$PLAIN_ARCHIVE" "${EXCLUDES[@]}" .
chmod 600 "$PLAIN_ARCHIVE" "$MANIFEST" 2>/dev/null || true

if [[ "$INCLUDE_SECRETS" == "1" ]]; then
  ARCHIVE="$PLAIN_ARCHIVE.gpg"
  gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" \
    --symmetric --cipher-algo AES256 \
    --output "$ARCHIVE" "$PLAIN_ARCHIVE"
  rm -f "$PLAIN_ARCHIVE"
  chmod 600 "$ARCHIVE"
fi

if [[ "$DRY_RUN" != "1" ]]; then
TOPIC_NAME="$TOPIC_NAME" THREAD_FILE="$THREAD_FILE" ARCHIVE="$ARCHIVE" MANIFEST="$MANIFEST" INCLUDE_SECRETS="$INCLUDE_SECRETS" node --input-type=module <<'NODE'
import fs from 'node:fs';
import { basename } from 'node:path';

const token = process.env.TG_TOKEN;
const chatId = process.env.TG_GROUP_ID;
const topicName = process.env.TOPIC_NAME;
const threadFile = process.env.THREAD_FILE;
const archivePath = process.env.ARCHIVE;
const manifestPath = process.env.MANIFEST;
const includeSecrets = process.env.INCLUDE_SECRETS === '1';

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description || JSON.stringify(json)}`);
  return json.result;
}

let threadId = null;
if (fs.existsSync(threadFile)) {
  const raw = fs.readFileSync(threadFile, 'utf8').trim();
  if (/^\d+$/.test(raw)) threadId = Number(raw);
}
if (!threadId) {
  const topic = await tg('createForumTopic', { chat_id: chatId, name: topicName });
  threadId = topic.message_thread_id;
  fs.writeFileSync(threadFile, `${threadId}\n`, { mode: 0o600 });
}

async function sendDocument(filePath, caption) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('message_thread_id', String(threadId));
  form.append('caption', caption);
  form.append('document', await fs.openAsBlob(filePath), basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  const json = await res.json();
  if (!json.ok) throw new Error(`sendDocument: ${json.description || JSON.stringify(json)}`);
}

const caption = includeSecrets
  ? `🔐 Encrypted zalo-tg recovery backup\n${basename(archivePath)}`
  : `📦 zalo-tg backup (secrets excluded)\n${basename(archivePath)}`;
await sendDocument(archivePath, caption);
await sendDocument(manifestPath, `📋 zalo-tg backup manifest\n${basename(manifestPath)}`);
NODE
fi

find "$BACKUP_DIR" -type f \( -name 'zalo-tg-backup-*.tar.gz' -o -name 'zalo-tg-backup-*.tar.gz.gpg' -o -name 'manifest-*.txt' \) -mtime +"$RETENTION_DAYS" -delete

echo "Backup uploaded: $ARCHIVE"
echo "Manifest: $MANIFEST"
if [[ -f "$THREAD_FILE" ]]; then echo "Thread id: $(cat "$THREAD_FILE")"; fi
