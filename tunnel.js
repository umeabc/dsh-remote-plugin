/**
 * Client side of the relay tunnel.
 *
 * This is the mirror image of the phone app: it joins the same room as the
 * remote desktop's bridge and opens streams to that desktop's loopback web
 * server. Everything the local DSH does through it executes on the remote
 * machine — this side only forwards bytes.
 */

import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  ByteReader,
  FRAME,
  MAX_CHUNK,
  deriveKey,
  frameHeader,
  handshakeMessage,
  openSealed,
  seal,
  writeAsync,
  log,
  warn,
} from './core.js';

const HEARTBEAT_MS = 20_000;
const SILENCE_MS = 60_000;

export class ClientTunnel extends EventEmitter {
  constructor({ host, port, room, key }) {
    super();
    this.host = host;
    this.port = port;
    this.room = room;
    this.key = key;
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.streams = new Map();
    this.seq = 1;
    this.tx = 0;
    this.rx = 0;
    this.channel = 0;
    this.lastRxAt = 0;
    this.backoff = 2000;
    this.worker = null;
    this.writeLock = Promise.resolve();
  }

  get isConnected() {
    return this.connected;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.worker = this.loop();
  }

  async stop() {
    this.stopped = true;
    this.destroyAll();
    try {
      this.socket?.destroy();
    } catch {
      /* already gone */
    }
    await this.worker?.catch(() => {});
    this.worker = null;
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.backoff = 2000;
      } catch (error) {
        if (this.stopped) break;
        warn(`remote-pc: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, this.backoff));
        this.backoff = Math.min(this.backoff * 2, 15000);
      }
    }
  }

  async connectOnce() {
    const socket = connect(this.port, this.host);
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const salt = randomBytes(16);
    socket.write(handshakeMessage({ v: 1, role: 'client', room: this.room, salt: salt.toString('base64') }));
    const reader = new ByteReader(socket[Symbol.asyncIterator]());
    const length = (await reader.read(4)).readUInt32BE(0);
    if (length === 0 || length > 4096) throw new Error('bad relay reply');
    const reply = JSON.parse((await reader.read(length)).toString('utf8'));
    if (reply?.ok !== true) throw new Error(`relay refused: ${reply?.error ?? 'unknown'}`);
    this.channel = reply.channel;
    this.c2h = deriveKey(this.key, salt, 'dshm/c2h');
    this.h2c = deriveKey(this.key, salt, 'dshm/h2c');
    this.tx = 0;
    this.rx = 0;
    this.connected = true;
    this.lastRxAt = Date.now();
    this.emit('state', 'connected');
    log(`remote-pc: connected channel=${this.channel}`);

    const heartbeat = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastRxAt > SILENCE_MS) {
        socket.destroy();
        return;
      }
      // Channel 0 is rewritten by the relay; the host echoes it back, which
      // keeps lastRxAt fresh without any user traffic.
      void this.sendFrame(0, FRAME.PING).catch(() => {});
    }, HEARTBEAT_MS);

    try {
      await this.readFrames(reader);
    } finally {
      clearInterval(heartbeat);
      this.connected = false;
      this.destroyAll();
      this.socket = null;
      socket.destroy();
      this.emit('state', 'disconnected');
      log('remote-pc: disconnected');
    }
  }

  async readFrames(reader) {
    for (;;) {
      const header = await reader.read(8);
      this.lastRxAt = Date.now();
      const stream = header.readUInt32BE(1);
      const type = header[5];
      const length = header.readUInt16BE(6);
      const payload = length === 0 ? Buffer.alloc(0) : await reader.read(length);

      if (type === FRAME.DATA) {
        let plaintext;
        try {
          plaintext = openSealed(this.h2c, this.rx, header, payload);
          this.rx += 1;
        } catch (error) {
          // The channel key stream is unrecoverable; reconnect instead of
          // serving corrupted bytes.
          warn('remote-pc: authentication failed, redialing');
          throw error;
        }
        this.streams.get(stream)?.emit('data', plaintext);
        continue;
      }
      if (type === FRAME.FIN) {
        const target = this.streams.get(stream);
        this.streams.delete(stream);
        target?.emit('end');
        continue;
      }
      if (type === FRAME.RST) {
        const target = this.streams.get(stream);
        this.streams.delete(stream);
        target?.emit('close');
        continue;
      }
      if (type === FRAME.CHANNEL_CLOSED) this.destroyAll();
    }
  }

  sendFrame(stream, type) {
    return this.writeFrame(frameHeader(0, stream, type, 0));
  }

  sendData(stream, chunk) {
    const pieces = [];
    for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) {
      const piece = chunk.subarray(offset, Math.min(offset + MAX_CHUNK, chunk.length));
      const counter = this.tx;
      this.tx += 1;
      const header = frameHeader(0, stream, FRAME.DATA, piece.length + 16);
      pieces.push(Buffer.concat([header, seal(this.c2h, counter, header, piece)]));
    }
    return this.writeFrame(Buffer.concat(pieces));
  }

  writeFrame(buffer) {
    const target = this.socket;
    if (target === null || target.destroyed) return Promise.resolve(false);
    // Serialise writes so counters reach the host in the order they were
    // allocated; the session key stream depends on it.
    const next = this.writeLock.then(() => writeAsync(target, buffer));
    this.writeLock = next.then(() => {}, () => {});
    return next.catch(() => false);
  }

  openStream() {
    const id = this.seq++ & 0x7fffffff;
    const stream = new EventEmitter();
    stream.id = id;
    stream.write = (chunk) => {
      void this.sendData(id, Buffer.from(chunk));
      return true;
    };
    stream.end = () => {
      void this.sendFrame(id, FRAME.FIN);
    };
    stream.destroy = () => {
      this.streams.delete(id);
      void this.sendFrame(id, FRAME.RST);
    };
    this.streams.set(id, stream);
    void this.sendFrame(id, FRAME.OPEN);
    return stream;
  }

  destroyAll() {
    for (const [id, stream] of [...this.streams]) {
      this.streams.delete(id);
      stream.emit('close');
    }
  }
}
