# Hướng dẫn phục hồi zalo-tg từ Telegram backup

Tài liệu này dùng cho các file backup được upload định kỳ vào topic Telegram **Zalo bridge backups**.

## 1. Backup chứa gì?

Backup mặc định (không chứa secrets) có dạng:

```text
zalo-tg-backup-YYYY-MM-DD-HHMMSS.tar.gz
```

Bản mặc định chứa mã nguồn và dữ liệu vận hành:

```text
data/*
src/*
scripts/*
package.json
package-lock.json
Dockerfile
docker-compose.yml
README...
```

Không bao gồm các thứ có thể tạo lại hoặc không cần restore:

```text
.git
node_modules
dist
logs
data/bot-api
data/zalo-tg.pid
*.log
```

Các file `.env`, `credentials.json` và `app-session.json` bị loại khỏi backup mặc định. Khi cần phục hồi cả phiên đăng nhập, bật `ZALO_TG_BACKUP_INCLUDE_SECRETS=1`; script sẽ chỉ upload file `*.tar.gz.gpg` đã mã hóa GPG và xóa archive plaintext trước khi upload.

## 2. Chuẩn bị máy mới

Cài các gói cơ bản:

```bash
sudo apt update
sudo apt install -y git curl ffmpeg tar
```

Cài Node.js >= 18. Khuyến nghị Node 22 nếu được:

```bash
node -v
npm -v
```

Nếu chưa có Node, cài bằng cách phù hợp với máy mới, ví dụ `nvm`, NodeSource, hoặc package manager.

## 3. Tải backup từ Telegram

Vào group/topic Telegram:

```text
Zalo bridge backups
```

Tải file mới nhất: bản thường `*.tar.gz`, hoặc bản phục hồi đầy đủ đã mã hóa `*.tar.gz.gpg`.

Nên tải kèm file manifest tương ứng:

```text
manifest-YYYY-MM-DD-HHMMSS.txt
```

Ví dụ lưu vào:

```bash
mkdir -p ~/restore-zalo-tg
cd ~/restore-zalo-tg
# đặt file backup vừa tải vào đây
```

## 4. Giải mã (nếu có) và giải nén backup

Với file `.gpg`, giải mã trước:

```bash
gpg --output ~/restore-zalo-tg/zalo-tg-backup.tar.gz --decrypt ~/restore-zalo-tg/zalo-tg-backup-*.tar.gz.gpg
```

Sau đó giải nén:

```bash
mkdir -p ~/zalo-tg-restored
cd ~/zalo-tg-restored
tar -xzf ~/restore-zalo-tg/zalo-tg-backup-YYYY-MM-DD-HHMMSS.tar.gz
```

Do backup được tạo từ root repo bằng `tar .`, sau khi giải nén sẽ thấy các file như:

```text
data/
src/
scripts/
package.json
package-lock.json
```

Nếu thấy thư mục lồng kiểu `home/chuc2rk/...` thì kiểm tra lại lệnh giải nén hoặc nội dung archive bằng:

```bash
tar -tzf ~/restore-zalo-tg/zalo-tg-backup-YYYY-MM-DD-HHMMSS.tar.gz | head
```

## 5. Cài dependency và build

Trong thư mục vừa restore:

```bash
npm install
npm run build
```

## 6. Kiểm tra config quan trọng

Mở `.env` kiểm tra:

```bash
cat .env
```

Các biến quan trọng:

```text
TG_TOKEN
TG_GROUP_ID
DATA_DIR=./data
ZALO_CREDENTIALS_PATH
LOCAL_BOT_API
TG_LOCAL_SERVER
```

Với setup hiện tại của Chức, session Zalo đang ở root repo:

```text
credentials.json
app-session.json
```

Nếu `.env` không set `ZALO_CREDENTIALS_PATH`, app mặc định dùng:

```text
credentials.json
```

Tức là đúng với backup này.

## 7. Chạy thử

```bash
npm start
```

Nếu chạy OK, bridge sẽ dùng lại:

```text
data/topics.json
```

để forward tin mới vào đúng các topic Telegram cũ.

## 8. Nếu Zalo session hết hạn

Nếu log báo thiếu/hỏng/expired `credentials.json`, vào supergroup Telegram đang dùng với bot và gõ:

```text
/loginweb
```

Quét QR bằng app Zalo trên điện thoại.

Nếu cần app session/API phụ, gõ:

```text
/loginapp
```

Quét QR tiếp.

## 9. Chạy như service/systemd

Nếu muốn chạy lâu dài như máy cũ, có thể dùng service file trong repo:

```text
zalo-tg.service
```

Cần sửa lại đường dẫn `WorkingDirectory`/`ExecStart` trong service cho đúng thư mục restore trên máy mới.

Ví dụ kiểm tra service:

```bash
cat zalo-tg.service
```

Sau đó copy vào systemd:

```bash
sudo cp zalo-tg.service /etc/systemd/system/zalo-tg.service
sudo systemctl daemon-reload
sudo systemctl enable --now zalo-tg
sudo systemctl status zalo-tg
```

Nếu service file vẫn trỏ về path máy cũ, sửa trước khi enable.

## 10. Checklist phục hồi nhanh

```bash
# 1) Tạo thư mục restore
mkdir -p ~/zalo-tg-restored
cd ~/zalo-tg-restored

# 2) Giải nén backup
tar -xzf /path/to/zalo-tg-backup-YYYY-MM-DD-HHMMSS.tar.gz

# 3) Cài dependency + build
npm install
npm run build

# 4) Chạy thử
npm start
```

Nếu cần đăng nhập lại Zalo:

```text
/loginweb
/loginapp
```

## 11. File quan trọng nhất

Nếu chỉ còn cứu được vài file, ưu tiên:

```text
data/topics.json
data/msg-map.json
data/name-cache.json
```

Trong đó `data/topics.json` là file giữ mapping Zalo conversation ↔ Telegram topic. Mất file này thì topic cũ dễ bị mồ côi và bridge có thể tạo topic mới.
