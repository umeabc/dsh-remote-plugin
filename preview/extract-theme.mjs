// Extract the DSH theme CSS (light + dark token blocks) from the installed app.asar,
// so a local preview renders the 手机访问 page with the real design tokens.
//
//   node preview/extract-theme.mjs "D:/dsh/resources/app.asar"
//
// Writes preview/theme.css next to this file.
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const archive = process.argv[2] ?? 'D:/dsh/resources/app.asar';
const here = dirname(fileURLToPath(import.meta.url));
const TARGET = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js';

const buffer = fs.readFileSync(archive);
const headerSize = buffer.readUInt32LE(4);
const jsonSize = buffer.readUInt32LE(12);
const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8').replace(/\0+$/, ''));
const dataBase = 8 + headerSize;

const find = (node, prefix = '') => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (full === TARGET && !entry.files) return entry;
    if (entry.files) {
      const hit = find(entry, full);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
};

const entry = find(header);
if (entry === undefined) throw new Error(`not found in archive: ${TARGET}`);
const source = buffer
  .subarray(dataBase + Number(entry.offset), dataBase + Number(entry.offset) + Number(entry.size))
  .toString('utf8');

// The theme ships its CSS as `var name = "<css>"` string literals; keep the ones that
// carry rules, unescaping only the few sequences used there.
const parts = [];
const marker = /var ([A-Za-z_$][A-Za-z0-9_$]*) = "/g;
let hit;
while ((hit = marker.exec(source))) {
  let end = marker.lastIndex;
  while (end < source.length) {
    if (source[end] === '\\') { end += 2; continue; }
    if (source[end] === '"') break;
    end += 1;
  }
  const raw = source.slice(marker.lastIndex, end);
  if (raw.length < 200 || !raw.includes('{')) continue;
  const ESC = String.fromCharCode(92);
  parts.push(raw.split(ESC + ESC).join(ESC).split(ESC + 'n').join('\n').split(ESC + '"').join('"'));
}

const css = parts.join('\n');
const out = join(here, 'theme.css');
fs.writeFileSync(out, css);
console.log(`wrote ${out} (${css.length} bytes, ${parts.length} blocks)`);
