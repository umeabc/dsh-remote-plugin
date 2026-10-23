/**
 * Outbound relay tunnel.
 *
 * The desktop keeps one encrypted TCP connection to a relay server; phones join
 * the same room and the relay forwards framed streams between them. Payloads
 * are sealed with AES-128-GCM under a key derived from the room key, so the
 * relay only ever routes ciphertext.
 */

import { connect } from 'node:net';
import {
  ByteReader,
  FRAME,
  MAX_CHUNK,
  delay,
  deriveKey,
  encodeFrame,
  frameHeader,
  handshakeMessage,
  log,
  openSealed,
  seal,
  warn,
  writeAsync,
} from './core.js';

/** Destroy a socket without letting a teardown error escape. */
function closeQuietly(socket) {
  try {
    socket?.destroy();
  } catch {
    /* already gone */
  }
}

function parseRelayUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim().replace(/^tcp:\/\//i, '');
  const at = trimmed.lastIndexOf(':');
  if (at <= 0) return { host: trimmed, port: 9443 };
  const host = trimmed.slice(0, at);
  const port = Number(trimmed.slice(at + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

export class RelayTunnel {
  constructor({ store, upstream, config }) {
    this.store = store;
    this.upstream = upstream;
    this.config = config;
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.lastError = null;
    this.channels = new Map();
    this.loop = null;
    this.lastRxAt = 0;
    this.backoff = 3000;
  }

  get address() {
    const stored = this.store.data.relay?.url;
    if (typeof stored === 'string' && stored.trim() !== '') return stored;
    return this.config.url;
  }

  get enabled() {
    return this.config.enabled !== false && parseRelayUrl(this.address) !== null;
  }

  get endpoint() {
    return parseRelayUrl(this.address);
  }

  get room() {
    return this.store.data.relay.room;
  }

  get key() {
    return Buffer.from(this.store.data.relay.key, 'base64url');
  }

  get pairingText() {
    const endpoint = this.endpoint;
    if (endpoint === null) return null;
    return `dshm://relay?url=${encodeURIComponent(`${endpoint.host}:${endpoint.port}`)}&room=${this.room}&key=${this.store.data.relay.key}`;
  }

  status() {
    const endpoint = this.endpoint;
    return {
      enabled: this.enabled,
      connected: this.connected,
      url: endpoint === null ? null : `${endpoint.host}:${endpoint.port}`,
      room: this.room,
      key: this.store.data.relay.key,
      pairingText: this.pairingText,
      error: this.lastError,
    };
  }

  start() {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop() {
    this.stopped = true;
    this.lastError = null;
    this.wake?.();
    this.destroyAll();
    if (this.socket !== null) {
      this.socket.destroy();
      this.socket = null;
    }
    await this.loop?.catch(() => {});
    this.loop = null;
    this.lastRxAt = 0;
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.backoff = 3000;
      } catch (error) {
        if (!this.stopped) this.lastError = error.message;
        if (!this.stopped) {
          warn(`relay: ${error.message}; retrying in ${Math.round(this.backoff / 1000)}s`);
          await this.sleep(this.backoff);
          this.backoff = Math.min(this.backoff * 2, 30000);
        }
      }
    }
  }

  /** Sleep that ends early when the tunnel is stopped. */
  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  async connectOnce() {
    const endpoint = this.endpoint;
    if (endpoint === null) throw new Error('no relay address configured');
    const socket = connect(endpoint.port, endpoint.host);
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    socket.write(handshakeMessage({ v: 1, role: 'host', room: this.room }));
    const reader = new ByteReader(socket[Symbol.asyncIterator]());
    const lengthBuffer = await reader.read(4);
    const length = lengthBuffer.readUInt32BE(0);
    if (length === 0 || length > 4096) throw new Error('bad relay reply');
    const reply = JSON.parse((await reader.read(length)).toString('utf8'));
    if (reply?.ok !== true) throw new Error(`relay refused: ${reply?.error ?? 'unknown'}`);

    this.connected = true;
    this.lastError = null;
    log(`relay: connected to ${endpoint.host}:${endpoint.port} room=${this.room.slice(0, 8)}`);

    // Application-level heartbeat: the host must notice a half-open socket
    // (sleep, Wi-Fi change) that TCP keepalive misses while traffic flows.
    this.lastRxAt = Date.now();
    const heartbeat = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastRxAt > 60_000) {
        warn('relay: heartbeat timeout, redialing');
        socket.destroy();
        return;
      }
      void this.send(0, 0, FRAME.PING).catch(() => {});
    }, 20_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      await this.readFrames(reader);
    } finally {
      clearInterval(heartbeat);
      this.connected = false;
      this.destroyAll();
      this.socket = null;
      socket.destroy();
      if (!this.stopped) log('relay: disconnected');
    }
  }

  async readFrames(reader) {
    for (;;) {
      const header = await reader.read(8);
      this.lastRxAt = Date.now();
      const channel = header[0];
      const stream = header.readUInt32BE(1);
      const type = header[5];
      const length = header.readUInt16BE(6);
      const payload = length === 0 ? Buffer.alloc(0) : await reader.read(length);

      if (type === FRAME.HELLO) {
        this.openChannel(channel, payload);
        continue;
      }
      if (type === FRAME.CHANNEL_CLOSED) {
        this.closeChannel(channel);
        continue;
      }
      if (type === FRAME.PING) {
        // Phone heartbeats are echoed back to that phone. Our own heartbeat
        // echo arrives on channel 0: just having it updates lastRxAt, and
        // echoing it again would ping-pong forever.
        if (channel !== 0) await this.send(channel, 0, FRAME.PING);
        continue;
      }

      const state = this.channels.get(channel);
      if (state === undefined) continue;

      if (type === FRAME.OPEN) {
        this.openStream(state, channel, stream);
        continue;
      }
      if (type === FRAME.DATA) {
        // The channel counter advances for every DATA frame in wire order,
        // whether or not its stream still exists; skipping a frame before
        // decrypting would desynchronise every later tag on this channel.
        let plaintext;
        try {
          plaintext = openSealed(state.rxKey, state.rxCounter, header, payload);
          state.rxCounter += 1;
        } catch (error) {
          warn('relay: channel authentication failed, reconnecting:', error.message);
          this.closeChannel(channel);
          closeQuietly(this.socket);
          continue;
        }
        const socket = state.streams.get(stream);
        if (socket === undefined) continue;
        if (!socket.destroyed && !socket.write(plaintext)) {
          await new Promise((resolve) => {
            socket.once('drain', resolve);
            socket.once('close', resolve);
          });
        }
        continue;
      }
      if (type === FRAME.FIN) {
        // A half-closed request side does not end the exchange: HTTP requests are
        // self-delimiting, and the Node upstream drops the connection when the
        // socket is ended before it answers. Keep the local socket readable and
        // let its own close send FIN back to the phone.
        continue;
      }
      if (type === FRAME.RST) {
        const socket = state.streams.get(stream);
        if (socket !== undefined) {
          state.streams.delete(stream);
          socket.destroy();
        }
      }
    }
  }

  openChannel(channel, salt) {
    const master = this.key;
    this.channels.set(channel, {
      salt,
      rxKey: deriveKey(master, salt, 'dshm/c2h'),
      txKey: deriveKey(master, salt, 'dshm/h2c'),
      rxCounter: 0,
      txCounter: 0,
      streams: new Map(),
    });
  }

  closeChannel(channel) {
    const state = this.channels.get(channel);
    if (state === undefined) return;
    for (const socket of state.streams.values()) socket.destroy();
    this.channels.delete(channel);
  }

  destroyAll() {
    for (const state of this.channels.values()) {
      for (const socket of state.streams.values()) socket.destroy();
    }
    this.channels.clear();
  }

  openStream(state, channel, stream) {
    if (state.streams.has(stream)) return;
    const socket = connect(this.upstream.port, '127.0.0.1');
    state.streams.set(stream, socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    socket.on('connect', () => socket.setNoDelay(true));
    socket.on('data', (chunk) => {
      if (this.socket === null) return;
      for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) {
        const piece = chunk.subarray(offset, Math.min(offset + MAX_CHUNK, chunk.length));
        const counter = state.txCounter;
        state.txCounter += 1;
        const header = frameHeader(channel, stream, FRAME.DATA, piece.length + 16);
        const sealed = seal(state.txKey, counter, header, piece);
        void writeAsync(this.socket, Buffer.concat([header, sealed])).catch(() => {});
      }
    });
    socket.on('close', () => {
      if (state.streams.get(stream) !== socket) return;
      state.streams.delete(stream);
      void this.send(channel, stream, FRAME.FIN);
    });
    socket.on('error', () => {
      if (state.streams.get(stream) !== socket) return;
      state.streams.delete(stream);
      void this.send(channel, stream, FRAME.RST);
    });
  }

  send(channel, stream, type) {
    if (this.socket === null || this.socket.destroyed) return Promise.resolve(false);
    return writeAsync(this.socket, encodeFrame(channel, stream, type)).catch(() => false);
  }
}
