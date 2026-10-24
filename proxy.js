/**
 * Loopback proxy in front of the tunnel.
 *
 * Anything that speaks HTTP to http://127.0.0.1:<port>/ (a browser, curl, or
 * the local DSH tools) is forwarded to the remote desktop's web server. The
 * remote bridge injects its own session cookie, so no credentials are stored
 * here.
 */

import { createServer } from 'node:net';
import { log, warn } from './core.js';

export class LocalProxy {
  constructor(tunnel, port) {
    this.tunnel = tunnel;
    this.port = port;
    this.server = null;
  }

  get url() {
    return `http://127.0.0.1:${this.port}/`;
  }

  async start() {
    if (this.server !== null) return this.port;
    const server = createServer((client) => this.handle(client));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', resolve);
    });
    this.server = server;
    log(`remote-pc: proxy on ${this.url}`);
    return this.port;
  }

  handle(client) {
    client.on('error', () => client.destroy());
    if (!this.tunnel.isConnected) {
      warn('remote-pc: proxy request while disconnected');
      client.destroy();
      return;
    }
    const stream = this.tunnel.openStream();
    client.on('data', (chunk) => stream.write(chunk));
    stream.on('data', (chunk) => {
      if (!client.destroyed) client.write(chunk);
    });
    stream.on('end', () => client.end());
    stream.on('close', () => client.destroy());
    client.on('close', () => stream.destroy());
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }
}
