import net from 'net';
import { lookup } from 'dns/promises';
import { escapeHtml } from './format.js';

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]!;
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return true;
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized);
}

export function parseSafeHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (!url.hostname || url.hostname.toLowerCase() === 'localhost') return null;
    if (net.isIP(url.hostname) && isPrivateIp(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function isTrustedZaloHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ['zalo.me', 'zaloapp.com', 'zalo.vn', 'zalopay.vn']
    .some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function parseTrustedBankcardUrl(raw: string): URL | null {
  const url = parseSafeHttpUrl(raw);
  if (!url || url.protocol !== 'https:' || !isTrustedZaloHost(url.hostname)) return null;
  return url;
}

export function safeTelegramLinkHtml(rawHref: string, title: string): string {
  const url = parseSafeHttpUrl(rawHref);
  const safeTitle = escapeHtml(title || rawHref);
  if (!url) return `${safeTitle}\n${escapeHtml(rawHref)}`;
  const safeHref = escapeHtml(url.toString()).replace(/"/g, '&quot;');
  return `<a href="${safeHref}">${safeTitle}</a>`;
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function fetchTrustedBankcardHtml(rawUrl: string, timeoutMs = 8_000, maxBytes = 512_000): Promise<string> {
  const initial = parseTrustedBankcardUrl(rawUrl);
  if (!initial) throw new Error('Untrusted bankcard URL');
  initial.searchParams.set('data', 'html');
  let current = initial;
  for (let redirect = 0; redirect <= 3; redirect++) {
    // Resolve immediately before each request and re-check every redirect.
    const addresses = await lookup(current.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(result => isPrivateIp(result.address))) {
      throw new Error('Bankcard URL resolves to a private or reserved network');
    }
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'ZaloTGBridge/1.0' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirect === 3) throw new Error('Unsafe or excessive redirect');
      const next = parseTrustedBankcardUrl(new URL(location, current).toString());
      if (!next) throw new Error('Redirected to an untrusted bankcard URL');
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readTextLimited(response, maxBytes);
  }
  throw new Error('Too many redirects');
}
