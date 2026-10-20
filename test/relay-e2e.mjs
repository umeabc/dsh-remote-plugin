/**
 * Relay self-test: spawns the relay, runs the real host-side tunnel, and plays
 * the phone with an independent frame/AEAD implementation. This is the same
 * wire contract the Android client implements.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import {
  ByteReader,
  FRAME,
  Store,
  Upstream,
  deriveKey,
  encodeFrame,
  frameHeader,
  handshakeMessage,
  openSealed,
  seal,
  writeAsync,
} from '../core.js';
import { RelayTunnel } from '../relay.js';

const CRLF = '\r\n';
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

const RELAY_PORT = await new Promise((resolve) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const relayPath = process.env.DSH_RELAY_JS ?? '../../dsh-mobile-relay/relay.js';
if (!existsSync(relayPath)) {
  console.log('skip: set DSH_RELAY_JS to the relay.js from umeabc/dsh-remote-relay');
  process.exit(0);
}
const relay = spawn(process.execPath, [relayPath, '--port', String(RELAY_PORT), '--host', '127.0.0.1'], {
  cwd: import.meta.dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stdout.on('data', (chunk) => process.stdout.write(`  relay| ${chunk}`));
relay.stderr.on('data', (chunk) => process.stderr.write(`  relay! ${chunk}`));
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 5000);
  relay.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('listening on')) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const upstreamServer = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(`hello from dsh: ${request.url}`);
});
await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstreamServer.address().port;

const store = await new Store('./.test-relay-store.json').load();
store.data.relay = { room: randomBytes(16).toString('hex'), key: randomBytes(16).toString('base64url'), url: `127.0.0.1:${RELAY_PORT}` };

const upstream = { port: upstreamPort };
const tunnel = new RelayTunnel({ store, upstream, config: { enabled: true, url: '' } });
tunnel.start();

for (let i = 0; i < 40 && !tunnel.connected; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
check('host tunnel connects to the relay', tunnel.connected);

/** The phone side of the protocol, written independently of the host classes. */
async function openPhone({ room, key, salt }) {
  const socket = connect(RELAY_PORT, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(handshakeMessage({ v: 1, role: 'client', room, salt: salt.toString('base64') }));
  const reader = new ByteReader(socket[Symbol.asyncIterator]());
  const length = (await reader.read(4)).readUInt32BE(0);
  const reply = JSON.parse((await reader.read(length)).toString('utf8'));
  if (!reply.ok) throw new Error(reply.error);

  const master = key;
  const state = {
    channel: reply.channel,
    c2h: deriveKey(master, salt, 'dshm/c2h'),
    h2c: deriveKey(master, salt, 'dshm/h2c'),
    tx: 0,
    rx: 0,
  };

  const phone = {
    channel: state.channel,
    async send(stream, type, payload) {
      const header = frameHeader(0, stream, type, payload === undefined ? 0 : payload.length + 16);
      const body = payload === undefined ? Buffer.alloc(0) : seal(state.c2h, state.tx, header, payload);
      if (payload !== undefined) state.tx += 1;
      await writeAsync(socket, Buffer.concat([header, body]));
    },
    async readFrame() {
      const header = await reader.read(8);
      const length = header.readUInt16BE(6);
      const payload = length === 0 ? Buffer.alloc(0) : await reader.read(length);
      return { header, type: header[5], stream: header.readUInt32BE(1), payload };
    },
    async request(path) {
      const stream = Math.floor(Math.random() * 100000) + 1;
      await phone.send(stream, FRAME.OPEN);
      const body = Buffer.from(`GET ${path} HTTP/1.1${CRLF}Host: 127.0.0.1${CRLF}Connection: close${CRLF}${CRLF}`);
      await phone.send(stream, FRAME.DATA, body);
      const chunks = [];
      for (;;) {
        const frame = await phone.readFrame();
        if (frame.type === FRAME.DATA) {
          chunks.push(openSealed(state.h2c, state.rx, frame.header, frame.payload));
          state.rx += 1;
        } else if (frame.type === FRAME.FIN || frame.type === FRAME.RST) {
          break;
        }
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    socket,
    close() {
      socket.destroy();
    },
  };
  return phone;
}

const saltA = randomBytes(16);
const phoneA = await openPhone({ room: store.data.relay.room, key: Buffer.from(store.data.relay.key, 'base64url'), salt: saltA });
check('phone joins and receives a channel', phoneA.channel >= 1, `channel=${phoneA.channel}`);
const response = await phoneA.request('/hello');
check('request round-trips through the tunnel', response.includes('hello from dsh: /hello'), response.split(CRLF)[0]);

// A second phone shares the same host tunnel on its own channel.
const saltB = randomBytes(16);
const phoneB = await openPhone({ room: store.data.relay.room, key: Buffer.from(store.data.relay.key, 'base64url'), salt: saltB });
check('second phone gets its own channel', phoneB.channel !== phoneA.channel, `${phoneA.channel} vs ${phoneB.channel}`);
const responseB = await phoneB.request('/second');
check('second phone round-trips', responseB.includes('hello from dsh: /second'));

// Wrong room is refused.
const refused = await openPhone({ room: 'f'.repeat(32), key: Buffer.alloc(16), salt: randomBytes(16) }).then(
  () => 'connected',
  (error) => error.message,
);
check('unknown room refused', refused === 'host-offline', refused);

// A tampered ciphertext is rejected. The host either resets that stream or,
// having lost counter integrity, closes the whole tunnel and redials.
const streamId = 424242;
await phoneA.send(streamId, FRAME.OPEN);
const garbageHeader = frameHeader(0, streamId, FRAME.DATA, 32);
await writeAsync(phoneA.socket, Buffer.concat([garbageHeader, randomBytes(32)]));
let rejected = false;
try {
  for (let i = 0; i < 6; i += 1) {
    const frame = await phoneA.readFrame();
    if (frame.type === FRAME.RST && frame.stream === streamId) {
      rejected = true;
      break;
    }
  }
} catch {
  rejected = true;
}
check('tampered frame is rejected', rejected);

let reconnected = false;
for (let i = 0; i < 80; i += 1) {
  if (tunnel.connected) {
    reconnected = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check('host tunnel reconnects afterwards', reconnected);

phoneA.close();
phoneB.close();
await tunnel.stop();
await new Promise((resolve) => upstreamServer.close(resolve));
relay.kill();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
