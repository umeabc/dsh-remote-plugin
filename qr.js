/**
 * Minimal QR Code encoder: byte mode, error-correction level M, versions 1-10.
 *
 * Written for the mobile bridge so the plugin needs no third-party dependency.
 * The algorithm follows ISO/IEC 18004 (function patterns, Reed-Solomon ECC over
 * GF(256), format/version BCH codes, mask evaluation).
 */

const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** Error-correction level M: EC codewords per block, and data codewords per block. */
const EC_M = [
  null,
  { ec: 10, blocks: [16] },
  { ec: 16, blocks: [28] },
  { ec: 26, blocks: [44] },
  { ec: 18, blocks: [32, 32] },
  { ec: 24, blocks: [43, 43] },
  { ec: 16, blocks: [27, 27, 27, 27] },
  { ec: 18, blocks: [31, 31, 31, 31] },
  { ec: 22, blocks: [38, 38, 39, 39] },
  { ec: 22, blocks: [36, 36, 36, 37, 37] },
  { ec: 26, blocks: [43, 43, 43, 43, 44] },
];

const ALIGNMENT = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const MAX_VERSION = 10;

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildGaloisTables() {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial of the given degree, highest coefficient last. */
function rsGenerator(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data, generator) {
  const result = new Uint8Array(generator.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) result[i] ^= gfMul(generator[i], factor);
  }
  return result;
}

function dataCapacity(version) {
  return EC_M[version].blocks.reduce((sum, n) => sum + n, 0);
}

function encodePayload(text) {
  const bytes = new TextEncoder().encode(text);
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const countBits = version < 10 ? 8 : 16;
    const capacityBits = dataCapacity(version) * 8;
    if (bytes.length >= 2 ** countBits) continue;
    if (4 + countBits + bytes.length * 8 > capacityBits) continue;
    return { version, bytes, countBits };
  }
  throw new Error(`qr: payload of ${bytes.length} bytes exceeds version ${MAX_VERSION}-M capacity`);
}

function buildDataBits({ version, bytes, countBits }) {
  const capacityBits = dataCapacity(version) * 8;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  let pad = 0xec;
  while (codewords.length < dataCapacity(version)) {
    codewords.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return codewords;
}

function buildCodewords(version, dataCodewords) {
  const { ec, blocks } = EC_M[version];
  const generator = rsGenerator(ec);
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const size of blocks) {
    const block = dataCodewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, generator));
  }
  const result = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ec; i += 1) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

function maskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: throw new Error(`qr: invalid mask ${mask}`);
  }
}

/** EC level M indicator bits (L=1, M=0, Q=3, H=2). */
const EC_BITS_M = 0;

function drawFormatBits(modules, isFunction, size, mask) {
  const data = (EC_BITS_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (index) => ((bits >>> index) & 1) !== 0;
  const set = (row, col, value) => {
    modules[row][col] = value;
    isFunction[row][col] = true;
  };
  for (let i = 0; i <= 5; i += 1) set(i, 8, bit(i));
  set(7, 8, bit(6));
  set(8, 8, bit(7));
  set(8, 7, bit(8));
  for (let i = 9; i < 15; i += 1) set(8, 14 - i, bit(i));
  for (let i = 0; i < 8; i += 1) set(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i += 1) set(size - 15 + i, 8, bit(i));
  set(size - 8, 8, true);
}

function drawVersionBits(modules, isFunction, size, version) {
  if (version < 7) return;
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const bits = (version << 12) | remainder;
  for (let i = 0; i < 18; i += 1) {
    const value = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = value;
    isFunction[b][a] = true;
    modules[a][b] = value;
    isFunction[a][b] = true;
  }
}

function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunction = (row, col, value) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = value;
    isFunction[row][col] = true;
  };

  // Timing patterns first; finder patterns overwrite their ends.
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  const drawFinder = (row, col) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(row + dy, col + dx, distance !== 2 && distance !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(3, size - 4);
  drawFinder(size - 4, 3);

  const centers = ALIGNMENT[version];
  for (const row of centers) {
    for (const col of centers) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  drawFormatBits(modules, isFunction, size, mask);
  drawVersionBits(modules, isFunction, size, version);

  const bits = [];
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push(((codeword >>> i) & 1) !== 0);
  }

  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vertical : vertical;
        if (isFunction[row][col]) continue;
        modules[row][col] = index < bits.length ? bits[index] : false;
        index += 1;
      }
    }
  }

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!isFunction[row][col] && maskBit(mask, row, col)) modules[row][col] = !modules[row][col];
    }
  }

  return modules;
}

function penaltyScore(modules) {
  const size = modules.length;
  let score = 0;

  const runScore = (getter) => {
    for (let a = 0; a < size; a += 1) {
      let runColor = getter(a, 0);
      let runLength = 1;
      for (let b = 1; b < size; b += 1) {
        const color = getter(a, b);
        if (color === runColor) {
          runLength += 1;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          runColor = color;
          runLength = 1;
        }
      }
    }
  };
  runScore((row, col) => modules[row][col]);
  runScore((col, row) => modules[row][col]);

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const color = modules[row][col];
      if (color === modules[row][col + 1] && color === modules[row + 1][col] && color === modules[row + 1][col + 1]) {
        score += 3;
      }
    }
  }

  const finderLike = (cells) => {
    for (let i = 0; i + 11 <= cells.length; i += 1) {
      const window = cells.slice(i, i + 11);
      const a = window.map((value) => (value ? 1 : 0)).join('');
      if (a === '10111010000' || a === '00001011101') score += 40;
    }
  };
  for (let row = 0; row < size; row += 1) {
    finderLike(modules[row]);
    finderLike(modules.map((line) => line[row]));
  }

  let dark = 0;
  for (const line of modules) for (const cell of line) if (cell) dark += 1;
  const total = size * size;
  const ratio = Math.abs(dark * 20 - total * 10) / total;
  score += Math.floor(ratio) * 10;

  return score;
}

/**
 * Encode text into a QR module matrix.
 * @param {string} text - payload, encoded as UTF-8 bytes.
 * @returns {{ version: number, size: number, mask: number, modules: boolean[][] }}
 */
export function encode(text) {
  const payload = encodePayload(text);
  const dataCodewords = buildDataBits(payload);
  const codewords = buildCodewords(payload.version, dataCodewords);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = buildMatrix(payload.version, codewords, mask);
    const score = penaltyScore(modules);
    if (best === null || score < best.score) best = { mask, modules, score };
  }
  return { version: payload.version, size: best.modules.length, mask: best.mask, modules: best.modules };
}

/**
 * Render a QR code as a standalone SVG string.
 * @param {string} text - payload to encode.
 * @param {{ scale?: number, margin?: number, dark?: string, light?: string }} [options]
 * @returns {string} SVG markup with a viewBox in module units.
 */
export function qrSvg(text, options = {}) {
  const scale = options.scale ?? 8;
  const margin = options.margin ?? 4;
  const dark = options.dark ?? '#0b0f14';
  const light = options.light ?? '#ffffff';
  const { size, modules } = encode(text);
  const extent = size + margin * 2;
  const parts = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue;
      parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${extent * scale}" height="${extent * scale}" viewBox="0 0 ${extent} ${extent}" role="img" aria-label="QR code">`,
    `<rect width="${extent}" height="${extent}" fill="${light}"/>`,
    `<path d="${parts.join('')}" fill="${dark}"/>`,
    '</svg>',
  ].join('');
}
