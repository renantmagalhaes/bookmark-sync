/**
 * Generates bookmark-sync extension icons (16, 48, 128px PNG)
 * using only Node.js built-ins (no external dependencies).
 *
 * Run: node generate-icons.js
 */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// ─── CRC32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── PNG Builder ──────────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

function makePNG(size, pixels) {
  // pixels: Uint8Array of RGBA values, row-major
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // bytes 10-12: compression=0, filter=0, interlace=0

  // Raw image data: filter byte (0) + RGBA row
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    // row[0] = 0  (filter None, already 0)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      row.set(pixels.slice(i, i + 4), 1 + x * 4);
    }
    rows.push(row);
  }

  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── Icon Renderer ────────────────────────────────────────────────────────────

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Smooth anti-aliased coverage for a point vs a signed-distance. */
function coverage(dist, edgeWidth) {
  return Math.max(0, Math.min(1, 0.5 - dist / edgeWidth));
}

/**
 * Signed distance from point (px, py) to the inside of a rounded rectangle
 * at (0,0)→(w,h) with corner radius r.
 * Returns negative when inside, positive when outside.
 */
function sdfRoundedRect(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - w / 2 + r;
  const qy = Math.abs(py - h / 2) - h / 2 + r;
  return (
    Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) +
    Math.min(Math.max(qx, qy), 0) -
    r
  );
}

function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  // Design colors (matching browser-session-sync palette)
  const BG     = [0x11, 0x13, 0x18, 255]; // #111318
  const PURPLE = [0x8e, 0x6f, 0xf0, 255]; // #8E6FF0
  const LIGHT  = [0xa2, 0x87, 0xff, 255]; // #A287FF (highlight)

  const S = size;
  const cornerR = S * (28 / 128); // ~22% of size, matches browser-session-sync

  // Anti-alias edge width (in pixels)
  const AA = Math.max(0.8, S * 0.015);

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= S || y < 0 || y >= S) return;
    const i = (y * S + x) * 4;
    pixels[i]     = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }

  function blendOver(x, y, fr, fg, fb, fa) {
    if (x < 0 || x >= S || y < 0 || y >= S) return;
    const i = (y * S + x) * 4;
    const alpha = fa / 255;
    const invA = 1 - alpha;
    pixels[i]     = Math.round(fr * alpha + pixels[i]     * invA);
    pixels[i + 1] = Math.round(fg * alpha + pixels[i + 1] * invA);
    pixels[i + 2] = Math.round(fb * alpha + pixels[i + 2] * invA);
    pixels[i + 3] = Math.min(255, Math.round(pixels[i + 3] + fa * (1 - pixels[i + 3] / 255)));
  }

  // ── Step 1: Draw background rounded rectangle ─────────────────────────────
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dist = sdfRoundedRect(x + 0.5, y + 0.5, S, S, cornerR);
      const alpha = Math.round(coverage(dist, AA) * 255);
      if (alpha > 0) {
        setPixel(x, y, BG[0], BG[1], BG[2], alpha);
      }
    }
  }

  // ── Step 2: Draw bookmark ribbon ──────────────────────────────────────────
  // Dimensions relative to icon size
  const bmLeft  = S * 0.28;
  const bmRight = S * 0.72;
  const bmTop   = S * 0.14;
  const bmBot   = S * 0.84;
  const bmW     = bmRight - bmLeft;
  const bmH     = bmBot - bmTop;
  const midX    = (bmLeft + bmRight) / 2;

  // Notch: V-cut from bottom, notch depth = 22% of bookmark height
  const notchDepth    = bmH * 0.22;
  // Max half-width of notch at the top of the notch zone = 45% of half-width
  const notchHalfW    = bmW * 0.45;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      // Must be within bookmark bounding box
      if (cx < bmLeft || cx > bmRight || cy < bmTop || cy > bmBot) continue;

      // Check V-notch: only applies in the bottom notchDepth band
      const fromBot = bmBot - cy;
      if (fromBot < notchDepth) {
        // progress: 0 = very bottom, 1 = top of notch zone
        const progress = fromBot / notchDepth;
        // Notch half-width linearly shrinks from notchHalfW (at top of zone) to 0 (at bottom tip)
        const cutHW = notchHalfW * (1 - progress);
        if (Math.abs(cx - midX) < cutHW) continue; // inside the notch cut
      }

      // Slight gradient: lighter purple near top
      const gy = (cy - bmTop) / bmH; // 0=top, 1=bottom
      const r = Math.round(lerp(LIGHT[0], PURPLE[0], gy));
      const g = Math.round(lerp(LIGHT[1], PURPLE[1], gy));
      const b = Math.round(lerp(LIGHT[2], PURPLE[2], gy));

      blendOver(x, y, r, g, b, 255);
    }
  }

  // ── Step 3 (size≥48): subtle sheen line near top of bookmark ─────────────
  if (size >= 48) {
    const sheenY  = bmTop + bmH * 0.08;
    const sheenH  = bmH * 0.06;
    const shrink  = bmW * 0.06;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        if (cx < bmLeft + shrink || cx > bmRight - shrink) continue;
        if (cy < sheenY || cy > sheenY + sheenH) continue;
        const t = 1 - Math.abs((cy - sheenY) / sheenH - 0.5) * 2;
        const a = Math.round(t * 55);
        blendOver(x, y, 255, 255, 255, a);
      }
    }
  }

  return pixels;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const outDir = path.join(__dirname, "images");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

for (const size of [16, 48, 128]) {
  const pixels = drawIcon(size);
  const png    = makePNG(size, pixels);
  const file   = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`Written ${file} (${png.length} bytes)`);
}

console.log("Done.");
