/**
 * Protocol self-test: a fake DSH upstream, the real LAN bridge, and a fake
 * phone. Verifies pairing, cookie gating, header rewriting and HTML injection
 * without booting a Harness.
 */

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Store, Upstream } from '../core.js';
import { LanBridge } from '../lan.js';

const CRLF = '\r\n';
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

// Fake DSH: mint a cookie at /?token=..., then require it on every request.
const upstreamServer = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    if (url.searchParams.get('token') === 'launch-token') {
      response.writeHead(303, {
        location: './',
        'set-cookie': 'dsh-auth-abc=secret-value; Path=/; HttpOnly; SameSite=Strict',
      });
      response.end();
      return;
    }
    if (!String(request.headers.cookie ?? '').includes('dsh-auth-abc=secret-value')) {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('authentication required');
      return;
    }
    if (request.headers.host !== '127.0.0.1:9999') {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end(`bad host ${request.headers.host}`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><link rel="manifest" href="./manifest.webmanifest"><title>DSH</title></head><body>ok</body></html>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(`echo:${url.pathname}`);
});

upstreamServer.on('upgrade', (request, socket) => {
  if (request.headers.host !== '127.0.0.1:9999') {
    socket.end(`HTTP/1.1 403 Forbidden${CRLF}${CRLF}bad host ${request.headers.host}`);
    return;
  }
  if (!String(request.headers.cookie ?? '').includes('dsh-auth-abc=secret-value')) {
    socket.end(`HTTP/1.1 401 Unauthorized${CRLF}${CRLF}`);
    return;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols${CRLF}Upgrade: websocket${CRLF}Connection: Upgrade${CRLF}${CRLF}`);
  socket.end();
});

await new Promise((resolve) => upstreamServer.listen(9999, '127.0.0.1', resolve));

const ctx = {
  webServer: { getOrigin: () => 'http://127.0.0.1:9999' },
  connection: { authenticatedUrl: (base) => `${base}?token=launch-token` },
};

const store = await new Store('./.test-store.json').load();
store.data.devices = {};
const upstream = new Upstream(ctx);
await upstream.start();

const lan = new LanBridge({
  ctx,
  upstream,
  store,
  config: { enabled: true, host: '127.0.0.1', port: 0, sessionDays: 30 },
  assets: fileURLToPath(new URL('../assets/', import.meta.url)),
});
await lan.start();

const base = `http://127.0.0.1:${lan.port}`;

// 1. Unauthenticated root shows the pairing page.
const page = await fetch(`${base}/`);
const pageText = await page.text();
check('pairing page for an unknown device', page.status === 200 && pageText.includes('配对码'));

// 2. Assets are public.
const manifest = await fetch(`${base}/__mobile/manifest.webmanifest`);
check('public manifest', manifest.status === 200 && (await manifest.json()).short_name === 'DSH');
const icon = await fetch(`${base}/__mobile/icon-192.png`);
check('public icon', icon.status === 200 && icon.headers.get('content-type') === 'image/png');

// 3. Wrong code is refused.
const wrong = await fetch(`${base}/__pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'code=000000',
  redirect: 'manual',
});
check('wrong pairing code refused', wrong.status === 401);

// 4. Correct code issues a grant and redirects.
const code = lan.currentCode();
const paired = await fetch(`${base}/__pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: `code=${code}`,
  redirect: 'manual',
});
const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0];
check('correct pairing code accepted', paired.status === 303 && cookie.startsWith('dshmb='), cookie.slice(0, 16));

// 5. The grant proxies the DSH index with the owner cookie and injected PWA head.
const index = await fetch(`${base}/`, { headers: { cookie } });
const html = await index.text();
check('index proxied through the grant', index.status === 200 && html.includes('ok'));
check('manifest link rewritten', html.includes('/__mobile/manifest.webmanifest') && !html.includes('href="./manifest.webmanifest"'));
check('PWA meta injected', html.includes('apple-mobile-web-app-capable'));
check('owner cookie stays on the host', !html.includes('secret-value'));

// 6. Other paths are proxied verbatim.
const echo = await fetch(`${base}/api/ping?x=1`, { headers: { cookie } });
check('path proxied', (await echo.text()) === 'echo:/api/ping');

// 7. A paired cookie cannot be forged.
const forged = await fetch(`${base}/`, { headers: { cookie: 'dshmb=deadbeef.deadbeef' } });
check('forged grant refused', forged.status === 200 && (await forged.text()).includes('配对码'));

// 8. A WebSocket upgrade is forwarded with the owner cookie.
const upgradeStatus = await new Promise((resolve) => {
  const socket = connect(lan.port, '127.0.0.1', () => {
    socket.write(
      `GET /api/stream HTTP/1.1${CRLF}Host: 127.0.0.1:9999${CRLF}Upgrade: websocket${CRLF}Connection: Upgrade${CRLF}`
      + `Cookie: ${cookie}${CRLF}Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==${CRLF}Sec-WebSocket-Version: 13${CRLF}${CRLF}`,
    );
  });
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('latin1');
    if (buffer.includes(CRLF)) {
      socket.destroy();
      resolve(buffer.split(CRLF)[0]);
    }
  });
  socket.on('error', () => resolve('error'));
  setTimeout(() => {
    socket.destroy();
    resolve('timeout');
  }, 3000);
});
check('upgrade reaches the upstream', upgradeStatus.startsWith('HTTP/1.1 101'), upgradeStatus);

// 9. Revocation clears grants.
lan.revokeAll();
const revoked = await fetch(`${base}/`, { headers: { cookie } });
check('revoked grant refused', (await revoked.text()).includes('配对码'));

await lan.stop();
await upstream.stop();
upstreamServer.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
