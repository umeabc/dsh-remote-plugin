/**
 * LAN listener: pairs a phone with a six-digit code, then reverse-proxies the
 * DSH web UI to it. The phone only ever holds a bridge grant; the DSH session
 * cookie stays inside the desktop process.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import {
  hmacHex,
  log,
  randomToken,
  safeEqualText,
  warn,
} from './core.js';

const COOKIE_NAME = 'dshmb';
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

const MANIFEST = JSON.stringify({
  name: 'DeepSeek Harness',
  short_name: 'DSH',
  description: 'DeepSeek Harness on your phone',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b0f14',
  theme_color: '#0b0f14',
  icons: [
    { src: '/__mobile/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/__mobile/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
});

function pairingPage(message) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0f14">
<title>连接 DeepSeek Harness</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(120% 90% at 50% 0%, #16324a 0%, #0b0f14 55%); color: #e8eef5;
    font: 15px/1.55 -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  .card { width: 100%; max-width: 380px; background: #121820cc; border: 1px solid #ffffff1a;
    border-radius: 20px; padding: 28px 24px; backdrop-filter: blur(12px); box-shadow: 0 24px 60px #0008; }
  .mark { width: 52px; height: 52px; border-radius: 15px; display: grid; place-items: center;
    background: linear-gradient(145deg, #4d9fff, #1f6fe0); font-weight: 700; font-size: 20px; letter-spacing: .5px; }
  h1 { font-size: 20px; margin: 18px 0 6px; }
  p { margin: 0 0 18px; color: #9fb0c3; font-size: 13.5px; }
  b { color: #d8e6f5; font-weight: 600; }
  form { display: grid; gap: 12px; }
  input { width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid #ffffff26;
    background: #0b111a; color: #fff; font-size: 26px; letter-spacing: 10px; text-align: center;
    font-variant-numeric: tabular-nums; outline: none; }
  input:focus { border-color: #4d9fff; box-shadow: 0 0 0 3px #4d9fff33; }
  button { padding: 13px 16px; border: 0; border-radius: 12px; background: #2f7cf6; color: #fff;
    font-size: 15px; font-weight: 600; }
  button:active { transform: scale(.99); }
  .error { margin: 14px 0 0; color: #ff8f8f; font-size: 13px; }
  .hint { margin: 18px 0 0; color: #6d7f93; font-size: 12px; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">DS</div>
    <h1>连接到这台电脑</h1>
    <p>在电脑上打开 <b>设置 → 手机访问</b>，输入其中显示的 6 位配对码。</p>
    <form method="post" action="/__pair">
      <input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000" autofocus>
      <button type="submit">连接</button>
    </form>
    ${message ? `<p class="error">${message}</p>` : ''}
    <p class="hint">同一 Wi-Fi 网络 · 配对码 10 分钟内有效</p>
  </main>
</body>
</html>`;
}

function readBody(request, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function parseCookies(header) {
  const result = new Map();
  if (typeof header !== 'string') return result;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    result.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return result;
}

/** Candidate LAN addresses, most likely first. */
export function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      addresses.push(entry.address);
    }
  }
  const rank = (address) => {
    if (address.startsWith('192.168.')) return 0;
    if (address.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
    if (address.startsWith('169.254.')) return 9;
    return 5;
  };
  return addresses.sort((a, b) => rank(a) - rank(b));
}

export class LanBridge {
  constructor({ ctx, upstream, store, config, assets }) {
    this.ctx = ctx;
    this.upstream = upstream;
    this.store = store;
    this.config = config;
    this.assets = assets;
    this.server = null;
    this.port = 0;
    this.error = null;
    this.code = null;
    this.codeExpiresAt = 0;
    this.attempts = new Map();
    this.lastSeenWrite = 0;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  get urls() {
    if (this.port === 0) return [];
    const addresses = this.config.publicHost
      ? [this.config.publicHost]
      : lanAddresses();
    return addresses.map((address) => `http://${address}:${this.port}/`);
  }

  rotateCode() {
    this.code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    this.codeExpiresAt = Date.now() + CODE_MINUTES * 60 * 1000;
    return this.code;
  }

  currentCode() {
    if (this.code === null || Date.now() >= this.codeExpiresAt) this.rotateCode();
    return this.code;
  }

  grantFor(deviceId) {
    const secret = this.store.data.secret;
    return `${deviceId}.${hmacHex(secret, deviceId)}`;
  }

  deviceFor(request) {
    const value = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    if (typeof value !== 'string') return null;
    const at = value.lastIndexOf('.');
    if (at <= 0) return null;
    const deviceId = value.slice(0, at);
    const signature = value.slice(at + 1);
    if (!safeEqualText(signature, hmacHex(this.store.data.secret, deviceId))) return null;
    const device = this.store.data.devices[deviceId];
    return device === undefined ? null : { id: deviceId, device };
  }

  touch(deviceId) {
    const device = this.store.data.devices[deviceId];
    if (device === undefined) return;
    const now = Date.now();
    if (now - this.lastSeenWrite < 60_000) return;
    this.lastSeenWrite = now;
    device.lastSeen = now;
    void this.store.save();
  }

  async start() {
    if (!this.enabled) return;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on('upgrade', (request, socket, head) => {
      if (this.deviceFor(request) === null) {
        socket.destroy();
        return;
      }
      this.upstream.handleUpgrade(request, socket, head);
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
    this.rotateCode();
    log(`LAN bridge listening on ${this.config.host}:${this.port}`);
  }

  async stop() {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  status() {
    const now = Date.now();
    const devices = Object.values(this.store.data.devices);
    return {
      enabled: this.enabled,
      running: this.server !== null,
      port: this.port,
      urls: this.urls,
      url: this.urls[0] ?? null,
      code: this.server === null ? null : this.currentCode(),
      expiresAt: this.server === null ? null : this.codeExpiresAt,
      remainingMs: this.server === null ? 0 : Math.max(0, this.codeExpiresAt - now),
      devices: devices.length,
      error: this.error,
    };
  }

  async serveAsset(response, name) {
    const file = join(this.assets, name);
    try {
      const data = await readFile(file);
      response.writeHead(200, {
        'content-type': name.endsWith('.png') ? 'image/png' : 'application/manifest+json',
        'cache-control': 'public, max-age=3600',
        'content-length': String(data.length),
      });
      response.end(data);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  }

  async handle(request, response) {
    const pathname = (request.url ?? '/').split('?')[0];

    if (pathname === '/__mobile/manifest.webmanifest') {
      response.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' });
      response.end(MANIFEST);
      return;
    }
    if (pathname === '/__mobile/icon-192.png' || pathname === '/__mobile/icon-512.png') {
      await this.serveAsset(response, pathname.slice('/__mobile/'.length));
      return;
    }

    if (request.method === 'POST' && pathname === '/__pair') {
      await this.handlePair(request, response);
      return;
    }

    const grant = this.deviceFor(request);
    if (grant !== null) {
      this.touch(grant.id);
      await this.upstream.handle(request, response, { allowMobile: true });
      return;
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(pairingPage(''));
      return;
    }

    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('pair this device first');
  }

  async handlePair(request, response) {
    const address = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const record = this.attempts.get(address);
    if (record === undefined || now >= record.resetAt) {
      this.attempts.set(address, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    } else {
      record.count += 1;
      if (record.count > MAX_ATTEMPTS) {
        response.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
        response.end(pairingPage('尝试次数过多，请稍后再试。'));
        return;
      }
    }

    let body = '';
    try {
      body = await readBody(request);
    } catch {
      response.writeHead(413);
      response.end();
      return;
    }
    const submitted = new URLSearchParams(body).get('code') ?? '';
    const expected = this.currentCode();

    if (Date.now() >= this.codeExpiresAt || !safeEqualText(submitted.trim(), expected)) {
      response.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      response.end(pairingPage('配对码不正确或已过期，请在电脑上重新查看。'));
      return;
    }

    const deviceId = randomToken(12);
    this.store.data.devices[deviceId] = {
      createdAt: Date.now(),
      lastSeen: Date.now(),
      agent: String(request.headers['user-agent'] ?? '').slice(0, 200),
    };
    await this.store.save();
    this.rotateCode();

    const maxAge = Math.max(1, Number(this.config.sessionDays ?? 30)) * 24 * 60 * 60;
    response.writeHead(303, {
      location: '/',
      'cache-control': 'no-store',
      'set-cookie': `${COOKIE_NAME}=${this.grantFor(deviceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    });
    response.end();
  }

  revokeAll() {
    this.store.data.devices = {};
    this.rotateCode();
    void this.store.save();
    warn('all paired phones were revoked');
  }
}
