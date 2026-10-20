/**
 * Shared pieces of the mobile bridge: persisted state, the loopback upstream
 * proxy, HTML/PWA injection, and the small crypto helpers the relay uses.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const FRAME = {
  HELLO: 0,
  OPEN: 1,
  DATA: 2,
  FIN: 3,
  RST: 4,
  PING: 5,
  CHANNEL_CLOSED: 6,
};

export const MAX_CHUNK = 16 * 1024;

export function log(...parts) {
  console.log('[mobile-bridge]', ...parts);
}

export function warn(...parts) {
  console.warn('[mobile-bridge]', ...parts);
}

export function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 16) {
  return base64url(randomBytes(bytes));
}

export function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hmacHex(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function deriveKey(master, salt, info) {
  return Buffer.from(hkdfSync('sha256', master, salt, info, 16));
}

function nonceFor(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

/**
 * Seal one payload. `header` is the 8-byte frame header carrying the final
 * length; only its 7 bytes after the channel take part, because the relay
 * rewrites the channel byte on the client leg.
 */
export function seal(key, counter, header, plaintext) {
  const cipher = createCipheriv('aes-128-gcm', key, nonceFor(counter));
  cipher.setAAD(header.subarray(1));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Open one sealed payload. Throws when the tag does not verify. */
export function openSealed(key, counter, header, ciphertext) {
  if (ciphertext.length < 16) throw new Error('short ciphertext');
  const decipher = createDecipheriv('aes-128-gcm', key, nonceFor(counter));
  decipher.setAAD(header.subarray(1));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
}

export function frameHeader(channel, stream, type, length) {
  const header = Buffer.alloc(8);
  header[0] = channel & 0xff;
  header.writeUInt32BE(stream >>> 0, 1);
  header[5] = type & 0xff;
  header.writeUInt16BE(length & 0xffff, 6);
  return header;
}

export function encodeFrame(channel, stream, type, payload) {
  const body = payload ?? Buffer.alloc(0);
  return Buffer.concat([frameHeader(channel, stream, type, body.length), body]);
}

export function handshakeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental reader over an async iterator of Buffers. */
export class ByteReader {
  constructor(iterator) {
    this.iterator = iterator;
    this.buffer = Buffer.alloc(0);
  }

  async read(length) {
    while (this.buffer.length < length) {
      const { value, done } = await this.iterator.next();
      if (done) throw new Error('eof');
      this.buffer = this.buffer.length === 0 ? value : Buffer.concat([this.buffer, value]);
    }
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }
}

export function writeAsync(socket, buffer) {
  if (socket.destroyed || socket.writableEnded) return Promise.resolve(false);
  if (socket.write(buffer)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (value) => {
      socket.off('drain', onDrain);
      socket.off('close', onClose);
      resolve(value);
    };
    const onDrain = () => settle(true);
    const onClose = () => settle(false);
    socket.once('drain', onDrain);
    socket.once('close', onClose);
  });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function homeDirectory() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** Persisted bridge state: LAN device grants plus the relay room credentials. */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { secret: randomToken(32), devices: {}, relay: null };
    this.saving = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof raw?.secret === 'string' && raw.secret.length >= 32) this.data.secret = raw.secret;
      if (raw?.devices !== null && typeof raw?.devices === 'object') this.data.devices = raw.devices;
      if (raw?.relay !== null && typeof raw?.relay === 'object') this.data.relay = raw.relay;
    } catch {
      /* first run or unreadable file: start fresh */
    }
    if (this.data.relay === null) {
      this.data.relay = { room: randomBytes(16).toString('hex'), key: base64url(randomBytes(16)) };
      await this.save();
    }
    return this;
  }

  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) {
        warn('cannot persist state:', error.message);
      }
    });
    return this.saving;
  }
}

function decompress(buffer, encoding) {
  const value = String(encoding ?? '').toLowerCase();
  if (value === '') return buffer;
  if (value === 'gzip' || value === 'x-gzip') return gunzipSync(buffer);
  if (value === 'deflate') return inflateSync(buffer);
  if (value === 'br') return brotliDecompressSync(buffer);
  throw new Error(`unsupported content-encoding: ${value}`);
}

function rewriteReferer(value, origin) {
  try {
    const url = new URL(value);
    const target = new URL(origin);
    url.protocol = target.protocol;
    url.host = target.host;
    return url.href;
  } catch {
    return origin;
  }
}

const PWA_HEAD = [
  '<meta name="theme-color" content="#0b0f14">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="DSH">',
  '<link rel="apple-touch-icon" href="/__mobile/icon-192.png">',
  '<link rel="manifest" href="/__mobile/manifest.webmanifest">',
  '<link rel="stylesheet" href="/__mobile/mobile.css">',
  '<script src="/__mobile/mobile.js" defer></script>',
  '<style>:root{--dsh-mobile-safe-top:env(safe-area-inset-top,0px);--dsh-mobile-safe-bottom:env(safe-area-inset-bottom,0px);--dshm-safe-bottom:0px}body{padding-bottom:max(var(--dshm-safe-bottom),var(--dsh-mobile-safe-bottom))}</style>',
].join('');

/** Replace the shell's own manifest link with the bridge manifest and add app meta. */
export function injectIndex(html) {
  let stripped = html.replace(/<link[^>]+rel=["']manifest["'][^>]*>/i, '');
  // The first viewport meta wins, so extend the page's own one in place
  // (adding a second would be ignored by browsers).
  stripped = stripped.replace(
    /<meta([^>]+name=["']viewport["'][^>]*)>/i,
    (match, attrs) => (/viewport-fit=cover/i.test(attrs) ? match : `<meta${attrs},viewport-fit=cover>`),
  );
  if (/<\/head>/i.test(stripped)) return stripped.replace(/<\/head>/i, `${PWA_HEAD}</head>`);
  return `${PWA_HEAD}${stripped}`;
}

/**
 * Loopback HTTP proxy in front of the DSH web server.
 *
 * Every browser request the bridge accepts ends up here: headers are rewritten
 * to the listener's own authority (so the DSH Host/Origin fence accepts them),
 * the owner's signed session cookie is attached, and the response flows back.
 */
export class Upstream {
  constructor(ctx) {
    this.ctx = ctx;
    this.origin = null;
    this.authority = null;
    this.cookie = null;
    this.server = null;
    this.port = 0;
    this.minting = null;
    this.agent = null;
  }

  async start() {
    this.origin = this.ctx.webServer.getOrigin();
    this.authority = new URL(this.origin).host;
    this.agent = new Agent({ keepAlive: true, maxSockets: 32 });
    // allowHalfOpen keeps the response writable after a tunnel stream sends FIN
    // for its request side; without it Node ends the socket before we answer.
    this.server = createServer({ allowHalfOpen: true }, (request, response) => {
      // Tunnel streams are already authenticated by the room key, so the same
      // mobile assets and status routes the LAN listener serves stay reachable.
      void this.handle(request, response, { allowMobile: true });
    });
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
    log(`upstream proxy on 127.0.0.1:${this.port} -> ${this.origin}`);
    await this.mintCookie().catch((error) => warn('cannot mint the DSH session cookie yet:', error.message));
  }

  async stop() {
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(resolve));
    }
    this.agent?.destroy();
  }

  /** Exchange the process token for the owner's signed browser cookie. */
  async mintCookie() {
    if (this.minting !== null) return this.minting;
    this.minting = (async () => {
      const authenticated = this.ctx.connection.authenticatedUrl(`${this.origin}/`);
      const response = await fetch(authenticated, { redirect: 'manual' });
      const cookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? ''];
      const session = cookies.find((value) => typeof value === 'string' && value.includes('='));
      if (session === undefined) throw new Error(`upstream answered ${response.status} without a session cookie`);
      this.cookie = session.split(';')[0].trim();
      return this.cookie;
    })();
    try {
      return await this.minting;
    } finally {
      this.minting = null;
    }
  }

  headersFor(request) {
    const headers = { ...request.headers };
    delete headers.connection;
    delete headers['proxy-connection'];
    delete headers['keep-alive'];
    delete headers.cookie;
    headers.host = this.authority;
    if (headers.origin !== undefined) headers.origin = this.origin;
    if (headers.referer !== undefined) headers.referer = rewriteReferer(headers.referer, this.origin);
    if (this.cookie !== null) headers.cookie = this.cookie;
    return headers;
  }

  async handle(request, response, options = {}) {
    if (!options.allowMobile && (request.url ?? '').startsWith('/__mobile')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    await this.forward(request, response, 0);
  }

  forward(request, response, attempt) {
    return new Promise((resolve) => {
      const url = new URL(this.origin);
      const options = {
        hostname: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        method: request.method,
        path: request.url,
        headers: this.headersFor(request),
        agent: this.agent,
      };
      const upstream = httpRequest(options, (incoming) => {
        const setCookie = incoming.headers['set-cookie'];
        if (Array.isArray(setCookie)) {
          const session = setCookie.find((value) => value.startsWith('dsh-auth-'));
          if (session !== undefined) this.cookie = session.split(';')[0].trim();
        }
        if (incoming.statusCode === 401 && attempt === 0 && (request.method === 'GET' || request.method === 'HEAD')) {
          incoming.resume();
          this.cookie = null;
          void this.mintCookie()
            .catch(() => {})
            .then(() => this.forward(request, response, 1))
            .then(resolve);
          return;
        }
        const type = String(incoming.headers['content-type'] ?? '');
        if (type.includes('text/html')) {
          const chunks = [];
          incoming.on('data', (chunk) => chunks.push(chunk));
          incoming.on('end', () => {
            let raw = Buffer.concat(chunks);
            let decoded = true;
            try {
              raw = decompress(raw, incoming.headers['content-encoding']);
            } catch {
              decoded = false;
            }
            const headers = { ...incoming.headers };
            delete headers['content-length'];
            delete headers['transfer-encoding'];
            delete headers.connection;
            if (decoded) {
              const body = Buffer.from(injectIndex(raw.toString('utf8')), 'utf8');
              delete headers['content-encoding'];
              headers['content-length'] = String(body.length);
              response.writeHead(incoming.statusCode ?? 200, headers);
              response.end(body);
            } else {
              // Unknown encoding: pass the bytes through untouched rather than
              // corrupting the page.
              response.writeHead(incoming.statusCode ?? 200, headers);
              response.end(raw);
            }
            resolve();
          });
          incoming.on('error', () => {
            response.destroy();
            resolve();
          });
          return;
        }
        const headers = { ...incoming.headers };
        delete headers.connection;
        delete headers['transfer-encoding'];
        delete headers['set-cookie'];
        // Content-addressed shell and plugin bundles carry a revision in the
        // URL, so the WebView may keep them forever. The DSH static server
        // sends no cache headers of its own.
        const pathname = String(request.url ?? '');
        if ((pathname.startsWith('/plugins/') || pathname.startsWith('/assets/')) && headers['cache-control'] === undefined) {
          headers['cache-control'] = 'public, max-age=31536000, immutable';
        }
        response.writeHead(incoming.statusCode ?? 200, headers);
        incoming.pipe(response);
        incoming.on('end', resolve);
        incoming.on('error', resolve);
      });
      upstream.on('error', (error) => {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(`mobile bridge: upstream unavailable (${error.message})`);
        } else {
          response.destroy();
        }
        resolve();
      });
      request.pipe(upstream);
    });
  }

  handleUpgrade(request, socket, head) {
    const url = new URL(this.origin);
    const upstream = connect(Number(url.port === '' ? 80 : url.port), url.hostname, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        if (request.rawHeaders[i].toLowerCase() === 'host') continue;
        const name = request.rawHeaders[i];
        const value = request.rawHeaders[i + 1];
        const lower = name.toLowerCase();
        if (lower === 'cookie') continue;
        if (lower === 'origin') {
          lines.push(`Origin: ${this.origin}`);
          continue;
        }
        if (lower === 'referer') {
          lines.push(`Referer: ${rewriteReferer(value, this.origin)}`);
          continue;
        }
        lines.push(`${name}: ${value}`);
      }
      if (this.cookie !== null) lines.push(`Cookie: ${this.cookie}`);
      lines.splice(1, 0, `Host: ${this.authority}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  }
}
