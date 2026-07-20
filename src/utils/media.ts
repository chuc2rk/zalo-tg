import axios from 'axios';
import { createWriteStream, mkdirSync, copyFileSync, existsSync } from 'fs';
import { stat, unlink } from 'fs/promises';
import { readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';
import ffmpegPath from 'ffmpeg-static';
import { imageSizeFromFile } from 'image-size/fromFile';
import path from 'path';
import os from 'os';

const TMP_DIR = path.join(os.tmpdir(), 'zalo-tg');
const FFMPEG_BIN = ffmpegPath || 'ffmpeg';

function configuredLocalBotApiDataDir(): string | null {
  const raw = process.env.TGBOTAPI_DATA_DIR;
  if (!raw || !raw.trim()) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function resolveLocalTelegramFilePath(srcPath: string): string {
  if (existsSync(srcPath)) return srcPath;

  // Some local Bot API deployments return file:// paths from the server/container
  // namespace (commonly /var/lib/telegram-bot-api/...) while the bridge can only
  // access the host-mounted data directory. Preserve the token/subdir/file suffix
  // and remap it to TGBOTAPI_DATA_DIR before giving up.
  const dataDir = configuredLocalBotApiDataDir();
  if (!dataDir) return srcPath;

  const marker = '/telegram-bot-api/';
  const markerIdx = srcPath.indexOf(marker);
  if (markerIdx >= 0) {
    const suffix = srcPath.slice(markerIdx + marker.length);
    const mapped = path.join(dataDir, suffix);
    if (existsSync(mapped)) return mapped;
  }

  const parts = srcPath.split(path.sep).filter(Boolean);
  const tokenIdx = parts.findIndex(part => /^\d+:.+/.test(part));
  if (tokenIdx >= 0) {
    const mapped = path.join(dataDir, ...parts.slice(tokenIdx));
    if (existsSync(mapped)) return mapped;
  }

  return srcPath;
}

/** Keep readable Unicode filenames, but remove path/control chars unsafe on disk. */
function sanitizeFileName(fileName: string, fallback = `download_${Date.now()}`): string {
  const cleaned = fileName
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/^\.+$/, '_')
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/** Download a remote URL to a temp file. Returns the local file path.
 *  When using a local Telegram Bot API server (--local flag), getFileLink()
 *  returns a file:// URL pointing to the server's working directory.
 *  In that case we copy the file directly instead of downloading via HTTP.
 */
export async function downloadToTemp(url: string, fileName?: string, retries = 3): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });

  // Local Bot API server returns file:// paths — copy directly, no HTTP needed
  if (url.startsWith('file:')) {
    const originalSrcPath = fileURLToPath(url);
    const srcPath = resolveLocalTelegramFilePath(originalSrcPath);
    const baseName = sanitizeFileName(fileName ?? path.basename(srcPath));
    const destPath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);
    copyFileSync(srcPath, destPath);
    // Delete the original from local server's data dir — it's been delivered, no longer needed
    await unlink(srcPath).catch(() => undefined);
    return destPath;
  }

  // Sanitize filename and add a unique prefix so concurrent downloads
  // with the same logical name (e.g. multiple 'photo.jpg' in a media group)
  // do not overwrite each other.
  const baseName = sanitizeFileName(fileName ?? `download_${Date.now()}`);

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1500ms, ...
      await new Promise(r => setTimeout(r, 500 * attempt * attempt));
    }

    const filePath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);
    try {
      const resp = await axios.get<NodeJS.ReadableStream>(url, {
        responseType: 'stream',
        timeout: 30_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZaloTGBridge/1.0)' },
      });

      await new Promise<void>((resolve, reject) => {
        const writer = createWriteStream(filePath);
        resp.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      const { size } = await stat(filePath);
      if (size === 0) {
        await unlink(filePath).catch(() => undefined);
        lastErr = new Error(`Downloaded file is empty: ${url}`);
        continue;
      }

      return filePath;
    } catch (err) {
      await unlink(filePath).catch(() => undefined);
      lastErr = err;
    }
  }

  throw lastErr;
}

/** Remove a temp file, ignoring errors. */
export async function cleanTemp(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
}

export interface SpriteSheetLayout {
  frames: number;
  frameWidth: number;
  frameHeight: number;
  direction: 'horizontal' | 'vertical';
}

/** Resolve equally sized frames from a Zalo animated-sticker sprite sheet. */
export function getSpriteSheetLayout(
  width: number,
  height: number,
  declaredFrames = 0,
): SpriteSheetLayout {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Sprite dimensions must be positive integers');
  }

  const requested = Number.isInteger(declaredFrames) && declaredFrames > 1
    ? declaredFrames
    : 0;
  if (requested > 1 && width % requested === 0) {
    return { frames: requested, frameWidth: width / requested, frameHeight: height, direction: 'horizontal' };
  }
  if (requested > 1 && height % requested === 0) {
    return { frames: requested, frameWidth: width, frameHeight: height / requested, direction: 'vertical' };
  }
  if (width > height && width % height === 0) {
    return { frames: width / height, frameWidth: height, frameHeight: height, direction: 'horizontal' };
  }
  if (height > width && height % width === 0) {
    return { frames: height / width, frameWidth: width, frameHeight: width, direction: 'vertical' };
  }
  return { frames: 1, frameWidth: width, frameHeight: height, direction: 'horizontal' };
}

/** Convert a Zalo PNG/WebP sprite strip into a Telegram-compatible animated GIF. */
export async function convertSpriteSheetToGif(
  inputPath: string,
  declaredFrames: number,
  frameDurationMs: number,
): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const dimensions = await imageSizeFromFile(inputPath);
  if (!dimensions.width || !dimensions.height) throw new Error('Cannot read sticker sprite dimensions');
  const layout = getSpriteSheetLayout(dimensions.width, dimensions.height, declaredFrames);
  if (layout.frames < 2) throw new Error('Sticker sprite does not contain multiple frames');

  const duration = Number.isFinite(frameDurationMs)
    ? Math.min(1_000, Math.max(20, frameDurationMs))
    : 100;
  const frameRate = (1_000 / duration).toFixed(6);
  const position = layout.direction === 'horizontal'
    ? `x='mod(n\\,${layout.frames})*${layout.frameWidth}':y=0`
    : `x=0:y='mod(n\\,${layout.frames})*${layout.frameHeight}'`;
  const crop = `crop=${layout.frameWidth}:${layout.frameHeight}:${position},format=rgba`;
  const outputPath = path.join(TMP_DIR, `zalo_sticker_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.gif`);

  await new Promise<void>((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      '-y', '-loop', '1', '-framerate', frameRate, '-i', inputPath,
      '-vf', crop,
      '-frames:v', String(layout.frames),
      '-loop', '0',
      outputPath,
    ]);
    let stderr = '';
    ff.stderr?.on('data', chunk => { stderr += String(chunk).slice(-2_000); });
    ff.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg sprite conversion exit ${code}: ${stderr.trim().slice(-500)}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

/**
 * Convert an audio file to M4A (AAC) using ffmpeg.
 * Returns the path to the converted file (caller must clean it up).
 */
export async function convertToM4a(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `voice_${Date.now()}.m4a`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      '-y', '-i', inputPath,
      // Keep an iOS/Android-friendly AAC-LC profile and put moov atom first.
      // Some mobile clients show "--:--" or fail playback if metadata is tail-loaded.
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '64k', '-ac', '1', '-ar', '44100',
      '-movflags', '+faststart',
      '-vn', outputPath,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

/**
 * Convert a WebM video (e.g. Telegram video sticker) to GIF using ffmpeg.
 * Returns the path to the output GIF (caller must clean it up).
 */
export async function convertWebmToGif(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `sticker_${Date.now()}.gif`);
  // Two-pass palette for better quality; scale to max 256px wide
  const palettePass = path.join(TMP_DIR, `palette_${Date.now()}.png`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      '-y', '-i', inputPath,
      '-vf', 'fps=15,scale=min(256\\,iw):-2:flags=lanczos,palettegen=stats_mode=diff',
      palettePass,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg palettegen exit ${code}`)));
    ff.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      '-y', '-i', inputPath, '-i', palettePass,
      '-lavfi', 'fps=15,scale=min(256\\,iw):-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5',
      outputPath,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg paletteuse exit ${code}`)));
    ff.on('error', reject);
  });
  await unlink(palettePass).catch(() => undefined);
  return outputPath;
}

/** Convert a Telegram static WebP sticker to a lossless transparent PNG. */
export async function convertStickerToPng(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(inputPath);
  if (!image.width || !image.height) throw new Error('Cannot read static sticker dimensions');
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, image.width, image.height);
  ctx.drawImage(image, 0, 0, image.width, image.height);
  const outputPath = path.join(TMP_DIR, `telegram_sticker_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`);
  await writeFile(outputPath, canvas.toBuffer('image/png'));
  return outputPath;
}

/** Render Telegram's gzip-compressed Lottie/TGS sticker to a transparent GIF. */
export async function convertTgsToGif(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const compressed = await readFile(inputPath);
  let animationData: Buffer;
  try {
    animationData = gunzipSync(compressed);
  } catch {
    animationData = compressed;
  }

  const { createCanvas, GifDisposal, GifEncoder, LottieAnimation } = await import('@napi-rs/canvas');
  const animation = LottieAnimation.loadFromData(animationData);
  const width = Math.round(animation.width);
  const height = Math.round(animation.height);
  const frameCount = Math.max(1, Math.round(animation.frames));
  const fps = Number.isFinite(animation.fps) && animation.fps > 0 ? animation.fps : 30;
  if (width < 1 || height < 1) throw new Error('TGS animation has invalid dimensions');
  if (frameCount > 600) throw new Error(`TGS animation has too many frames: ${frameCount}`);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const encoder = new GifEncoder(width, height, { repeat: 0, quality: 5 });
  const delay = Math.max(20, Math.round(1_000 / fps));
  try {
    for (let frame = 0; frame < frameCount; frame++) {
      ctx.clearRect(0, 0, width, height);
      animation.seekFrame(frame);
      animation.render(ctx);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      encoder.addFrame(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height, {
        delay,
        disposal: GifDisposal.Background,
      });
    }
    const outputPath = path.join(TMP_DIR, `telegram_sticker_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.gif`);
    await writeFile(outputPath, encoder.finish());
    return outputPath;
  } finally {
    encoder.dispose();
  }
}

/**
 * Extract the first frame of a video as a JPEG thumbnail.
 * Returns the path to the thumbnail file (caller must clean it up).
 */
export async function extractVideoThumbnail(videoPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `thumb_${Date.now()}.jpg`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      '-y', '-i', videoPath,
      '-vframes', '1',
      '-q:v', '5',    // quality 1-31, lower=better; 5 is ~90% JPEG
      '-vf', 'scale=\'min(720,iw)\':-2',  // max 720px wide, keep aspect
      outputPath,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg thumb exit ${code}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv']);

/** Guess media type from filename or URL. */
export function detectMediaType(fileNameOrUrl: string): 'image' | 'video' | 'document' {
  const lower = fileNameOrUrl.toLowerCase();
  const ext   = path.extname(lower.split('?')[0] ?? '');
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/.test(lower)) return 'image';
  if (/\.(mp4|mov|avi|mkv|webm)(\?|$)/.test(lower))  return 'video';
  return 'document';
}
