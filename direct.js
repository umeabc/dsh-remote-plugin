/**
 * Direct (non-relay) listener.
 *
 * After a phone reaches us through the relay it asks for candidate addresses;
 * if one of them is reachable (same Wi-Fi, or global IPv6 between both ends)
 * the phone re-attaches to this listener and the relay is no longer in the
 * data path. The protocol is identical: the same handshake and the same
 * encrypted frames, just on a different socket.
 */

import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { log, warn } from './core.js';

const MAX_CONNECTIONS = 8;

export class DirectServer {
  constructor({ tunnel, config }) {
    this.tunnel = tunnel;
    this.config = config;
    this.server = null;
    this.active = 0;
  }

  get room() {
    return this.tunnel?.room ?? '';
  }

  get port() {
    const address = this.server?.address();
    return address !== null && typeof address === 'object' ? address.port : 0;
  }

  async start() {
    if (this.server !== null) return;
    if (!this.room) throw new Error('no room yet');
    const server = createServer((socket) => {
      if (this.active >= MAX_CONNECTIONS) {
        socket.destroy();
        return;
      }
      this.active += 1;
      socket.on('close', () => {
        this.active = Math.max(0, this.active - 1);
      });
      socket.on('error', () => socket.destroy());
      void this.tunnel.attachDirect(socket, this.room).catch((error) => {
        warn(`direct: handshake failed: ${error.message}`);
        socket.destroy();
      });
    });
    server.on('error', (error) => warn(`direct: ${error.message}`));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // '::' accepts both IPv6 and IPv4-mapped on Windows and Linux.
      server.listen(this.config.port, '::', () => resolve());
    });
    this.server = server;
    log(`direct: listening on [::]:${this.port}`);
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  status() {
    return { enabled: this.server !== null, port: this.port, active: this.active };
  }
}

/** Addresses a phone could use to reach this machine directly. */
export function directCandidates(config) {
  const found = [];
  if (config?.publicHost) found.push(String(config.publicHost).trim());
  const seen = new Set(found);
  let v6count = 0;
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.internal) continue;
      const family = net.family === 'IPv6' || net.family === 6 ? 'IPv6' : 'IPv4';
      const raw = String(net.address).split('%')[0];
      if (seen.has(raw)) continue;
      if (family === 'IPv4') {
        // Only private ranges: a public IPv4 here is a NAT address anyway.
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(raw)) {
          found.push(raw);
          seen.add(raw);
        }
        continue;
      }
      if (v6count >= 2) continue;
      // Global unicast only (2xxx/3xxx); skip ULA (fd00::/8) and link-local.
      if (!/^[23][0-9a-f]{3}:/i.test(raw)) continue;
      if (/^f[cd]/i.test(raw)) continue;
      found.push(raw);
      seen.add(raw);
      v6count += 1;
    }
  }
  return found;
}
