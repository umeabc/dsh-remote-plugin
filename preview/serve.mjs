// Preview server for the 手机访问 / 远程电脑 settings pages.
//
//   node preview/extract-theme.mjs        # once per DSH version
//   npm i --no-save react@18 react-dom@18 # UMD builds for the harness
//   node preview/serve.mjs [port]         # http://127.0.0.1:4599/?theme=dark&lang=zh
//
// Serves the real client.js from the repository root with the real theme tokens and
// fake /__mobile/* + /__pc/* endpoints, so the page can be styled and screenshotted
// without booting DSH.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrSvg } from '../qr.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4599);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const lanUrl = 'http://192.168.1.23:8320/';
const pairing = 'dshm://relay?url=relay.example.com:9443&room=9f2c41d8a7b34e05b6c1&key=Qm9vZ2llV29vZ2llS2V5MTI';

const status = {
  version: '0.1.1',
  lan: {
    enabled: true,
    running: true,
    port: 8320,
    url: lanUrl,
    code: '482913',
    expiresAt: Date.now() + 7 * 60 * 1000,
    devices: 2,
  },
  relay: {
    enabled: true,
    connected: true,
    url: 'relay.example.com:9443',
    room: '9f2c41d8a7b34e05b6c1',
    key: 'Qm9vZ2llV29vZ2llS2V5MTI',
    pairingText: pairing,
  },
  direct: { enabled: true, port: 8330, active: 1 },
  client: { link: null, connected: false, url: null },
};

const json = (response, value) => {
  response.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/__mobile/status') return json(response, status);
  if (url.pathname === '/__pc/status') return json(response, { client: null });
  if (url.pathname === '/__pc/link') return json(response, { ...status, error: 'preview: link is not wired' });

  if (url.pathname === '/__mobile/qr.svg') {
    const text = url.searchParams.get('kind') === 'relay' ? pairing : lanUrl;
    response.writeHead(200, { 'content-type': TYPES['.svg'], 'cache-control': 'no-store' });
    response.end(qrSvg(text, { scale: 6, margin: 3 }));
    return;
  }

  const UMD = {
    '/react.js': ['react', 'umd', 'react.development.js'],
    '/react-dom.js': ['react-dom', 'umd', 'react-dom.development.js'],
  };
  if (UMD[url.pathname] !== undefined) {
    try {
      const data = await readFile(join(root, 'node_modules', ...UMD[url.pathname]));
      response.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      response.end(data);
      return;
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('missing react UMD build: run `npm i --no-save react@18 react-dom@18`\n');
      return;
    }
  }

  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const candidates = [join(here, relative), join(root, relative)];

  for (const file of candidates) {
    try {
      const data = await readFile(file);
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(data);
      return;
    } catch {
      /* try the next root */
    }
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${PORT}/?theme=dark`);
});
