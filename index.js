/**
 * dsh-mobile-bridge — open the local DeepSeek Harness desktop to a phone.
 *
 * Two transports share one loopback proxy:
 *   - LAN: a paired HTTP listener on this network, gated by a six-digit code.
 *   - Relay: an outbound AES-128-GCM tunnel to a relay server, for networks
 *     where the desktop cannot accept inbound connections.
 *
 * Settings → 手机访问 renders the QR codes and pairing state; this module owns
 * the listeners, the routes that feed that page, and the optional agent tool.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  Store,
  Upstream,
  homeDirectory,
  log,
  warn,
} from './core.js';
import { LanBridge } from './lan.js';
import { RelayTunnel } from './relay.js';
import { DirectServer, directCandidates } from './direct.js';
import { qrSvg } from './qr.js';

export const name = 'dsh-mobile-bridge';
export const inject = ['webServer', 'connection'];

const VERSION = '0.1.0';

const DEFAULTS = {
  lan: { enabled: true, host: '0.0.0.0', port: 8320, publicHost: '', sessionDays: 30 },
  relay: { enabled: true, url: '' },
  direct: { enabled: true, port: 8330, publicHost: '' },
};

function mergeConfig(config) {
  const raw = config ?? {};
  return {
    lan: { ...DEFAULTS.lan, ...(raw.lan ?? {}) },
    relay: { ...DEFAULTS.relay, ...(raw.relay ?? {}) },
    direct: { ...DEFAULTS.direct, ...(raw.direct ?? {}) },
  };
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  });
  response.end(body);
}

function sendText(response, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': String(body.length),
  });
  response.end(body);
}

export async function apply(ctx, config) {
  const settings = mergeConfig(config);
  const store = await new Store(join(homeDirectory(), 'mobile-bridge.json')).load();
  const assets = fileURLToPath(new URL('./assets/', import.meta.url));

  const upstream = new Upstream(ctx);
  let lan = null;
  let relay = null;
  let direct = null;

  const status = () => ({
    version: VERSION,
    lan: lan?.status() ?? { enabled: settings.lan.enabled !== false, running: false },
    relay: relay?.status() ?? { enabled: false, connected: false },
    direct: direct?.status() ?? { enabled: false, port: 0, active: 0 },
  });

  const authorized = (request) => {
    try {
      const admission = ctx.connection.admit({ headers: request.headers });
      return !('rejection' in admission);
    } catch {
      return false;
    }
  };

  const routes = [];
  const route = (kind, path, handler) => {
    routes.push(ctx.webServer.register({ kind, path, handler }));
  };

  const asset = (name, type) => async (_request, response) => {
    try {
      const data = await readFile(join(assets, name));
      response.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-cache',
        'content-length': String(data.length),
      });
      response.end(data);
    } catch {
      sendText(response, 404, 'not found');
    }
  };

  route('exact', '/__mobile/mobile.css', asset('mobile.css', 'text/css; charset=utf-8'));
  route('exact', '/__mobile/mobile.js', asset('mobile.js', 'text/javascript; charset=utf-8'));

  route('exact', '/__mobile/direct.json', (request, response) => {
    if (!authorized(request)) return sendText(response, 401, 'unauthorized');
    sendJson(response, 200, {
      enabled: direct !== null && direct.port > 0,
      port: direct?.port ?? 0,
      candidates: direct === null ? [] : directCandidates(settings.direct),
    });
  });

  route('exact', '/__mobile/status', (request, response) => {
    if (!authorized(request)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    sendJson(response, 200, status());
  });

  route('prefix', '/__mobile/qr.svg', (request, response) => {
    if (!authorized(request)) {
      sendText(response, 401, 'unauthorized');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const kind = url.searchParams.get('kind') ?? 'lan';
    const text = kind === 'relay' ? relay?.pairingText : lan?.urls?.[0] ?? null;
    if (typeof text !== 'string' || text === '') {
      sendText(response, 404, 'no address available');
      return;
    }
    const svg = qrSvg(text, { scale: 6, margin: 3 });
    response.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(svg);
  });

  route('exact', '/__mobile/pair/rotate', (request, response) => {
    if (!authorized(request)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    lan?.rotateCode();
    sendJson(response, 200, status());
  });

  route('exact', '/__mobile/devices/clear', (request, response) => {
    if (!authorized(request)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    lan?.revokeAll();
    sendJson(response, 200, status());
  });

  route('exact', '/__mobile/relay/config', (request, response) => {
    if (!authorized(request)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let value = '';
      try {
        value = String(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.url ?? '').trim();
      } catch {
        sendJson(response, 400, { error: 'invalid json' });
        return;
      }
      store.data.relay = { ...store.data.relay, url: value };
      void store.save();
      void relay?.stop().then(() => relay?.start());
      sendJson(response, 200, status());
    });
  });

  route('exact', '/__mobile/relay/reset', (request, response) => {
    if (!authorized(request)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    store.data.relay = {
      room: randomBytes(16).toString('hex'),
      key: randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    };
    void store.save();
    void relay?.stop().then(() => relay?.start());
    sendJson(response, 200, status());
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await direct?.stop().catch(() => {});
    await relay?.stop().catch(() => {});
    await lan?.stop().catch(() => {});
    await upstream.stop().catch(() => {});
    for (const dispose of routes.splice(0)) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
  };

  ctx.effect(() => () => {
    void shutdown();
  });

  try {
    await upstream.start();
    lan = new LanBridge({ ctx, upstream, store, config: settings.lan, assets });
    await lan.start().catch((error) => {
      warn(`LAN bridge failed to start: ${error.message}`);
    });
    relay = new RelayTunnel({ store, upstream, config: settings.relay });
    if (relay.enabled) relay.start();
    else if (settings.relay.enabled !== false) log('relay: no address configured, tunnel idle');
    relay.directInfo = () => (direct === null
      ? null
      : {
          enabled: direct.port > 0,
          port: direct.port,
          candidates: directCandidates(settings.direct),
        });
    if (settings.direct.enabled !== false && relay.enabled) {
      direct = new DirectServer({ tunnel: relay, config: settings.direct });
      await direct.start().catch((error) => {
        direct = null;
        warn(`direct: listener unavailable: ${error.message}`);
      });
    }
  } catch (error) {
    warn(`mobile bridge failed to start: ${error.message}`);
  }

  const tools = ctx.get('tools');
  if (tools !== undefined) {
    ctx.effect(() => tools.register({
      name: 'mobile_access',
      description:
        'Inspect or control phone access to this DeepSeek Harness desktop. '
        + 'action=status returns the LAN pairing URL/code and relay state; '
        + 'action=pair returns the same pairing details; action=revoke forgets every paired phone; '
        + 'action=relay-reset rotates the relay room credentials.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'pair', 'revoke', 'relay-reset'] },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            version: { type: 'string' },
            lan: { type: 'object', additionalProperties: true },
            relay: { type: 'object', additionalProperties: true },
          },
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => {
        const action = args?.action ?? 'status';
        if (action === 'revoke') lan?.revokeAll();
        if (action === 'relay-reset') {
          store.data.relay = {
            room: randomBytes(16).toString('hex'),
            key: randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
          };
          await store.save();
          await relay?.stop().catch(() => {});
          relay?.start();
        }
        return status();
      },
    }));
  }

  log(`ready (v${VERSION})`);
}
