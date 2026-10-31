/**
 * Socket-pool self-test: the bridge must keep serving ordinary requests while
 * phones hold their long-lived /plugins/events streams open, and must release
 * the upstream half as soon as a stream's client goes away.
 *
 * DSH's client HMR channel is an SSE stream that every open page keeps for its
 * whole lifetime. With a fixed-size keep-alive pool, opening enough pages
 * starves the bridge: this test pins both halves of that contract.
 */

import { createServer, request } from 'node:http';
import { Store, Upstream } from '../core.js';

const STREAMS = 40;
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

let openStreams = 0;
let closedStreams = 0;

const upstreamServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' && url.searchParams.get('token') === 'launch-token') {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-abc=secret; Path=/; HttpOnly' });
    res.end();
    return;
  }
  if (url.pathname === '/plugins/events') {
    // The real HMR channel: headers now, then nothing until something changes.
    openStreams += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': connected\n\n');
    res.on('close', () => {
      closedStreams += 1;
      openStreams -= 1;
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('pong');
});
await new Promise((resolve) => upstreamServer.listen(9997, '127.0.0.1', resolve));

const ctx = {
  webServer: { getOrigin: () => 'http://127.0.0.1:9997' },
  connection: { authenticatedUrl: (base) => `${base}?token=launch-token` },
};

const store = await new Store('./.test-pool-store.json').load();
const upstream = new Upstream(ctx);
await upstream.start();

/** Open one proxied request and keep it open; give up after `ms`. */
function open(path, ms = 2000) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: upstream.port, path }, (res) => {
      clearTimeout(timer);
      resolve({ req, res });
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ req, timedOut: true });
    }, ms);
    req.on('error', () => {
      clearTimeout(timer);
      resolve({ req, failed: true });
    });
    req.end();
  });
}

/** One ordinary request, resolved or rejected within `ms`. */
function ping(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    const req = request({ host: '127.0.0.1', port: upstream.port, path: '/api/ping' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message });
    });
    req.end();
  });
}

// 1. Baseline: nothing open yet.
const baseline = await ping(2000);
check('ordinary request served before any stream', baseline.body === 'pong', JSON.stringify(baseline));

// 2. Forty open streams - more than the old 32-socket pool.
const streams = [];
let refused = 0;
for (let i = 0; i < STREAMS; i += 1) {
  const stream = await open('/plugins/events');
  if (stream.timedOut || stream.failed) refused += 1;
  streams.push(stream);
}
await new Promise((resolve) => setTimeout(resolve, 300));
check(
  `${STREAMS} phone streams reach the upstream`,
  openStreams === STREAMS,
  `open=${openStreams} rejected=${refused}`,
);

const started = Date.now();
const during = await ping(4000);
check(
  'ordinary request still served with every stream open',
  during.body === 'pong',
  during.timedOut ? 'timed out after 4s' : `${during.status} in ${Date.now() - started}ms`,
);

// 3. A closed page must release its upstream socket.
const opened = openStreams;
for (const stream of streams) stream.req.destroy();
const deadline = Date.now() + 4000;
while (closedStreams < opened && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check('closing a phone stream releases the upstream socket', opened > 0 && closedStreams === opened, `closed=${closedStreams}/${opened}`);

await upstream.stop();
upstreamServer.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
