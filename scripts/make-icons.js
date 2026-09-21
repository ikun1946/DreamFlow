#!/usr/bin/env node
'use strict';
/* ============================================================
   make-icons.js —— 由 build/icon-source.png 生成全套图标

   2026-09-21 重做：图标不再是"脚本画出来的"，而是**用户提供的一张设计图**
   （层叠的渐变星形，见 build/icon-source.png，1254×1254 RGBA）。
   脚本的职责随之从"画图"变成"读图 → 缩放 → 编码"。

   为什么仍然零依赖：这个仓库坚持零 npm 运行时依赖，而 PNG 解码 =
   解析块 + zlib.inflate + 逐行反过滤，用 Node 内置的 zlib 就能写完；
   为了这一步引入 sharp/canvas（要编译、要跟 Electron 对齐 ABI）不划算。

   产物（三处，缺一不可）：
     build/icon.png        512×512  —— 窗口图标 / 托盘 / electron-builder 兜底
     build/icon.ico        16/24/32/48/64/128/256 —— 安装包与 exe 图标（PNG-in-ICO）
     app/icon.png          128×128  —— **应用内**用：favicon + 顶栏品牌标

   圆角遮罩：源图是白底方图，直接当图标用会是个硬邦邦的白方块。
   这里按 22% 半径把四角切圆（透明），和旧图标的外形保持一致；
   想还原成原始方图，把 ROUND_RATIO 置 0 即可。

   用法：node scripts/make-icons.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-source.png');
const OUT_DIR = path.join(ROOT, 'build');
const APP_ICON = path.join(ROOT, 'app', 'icon.png');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 512;      // build/icon.png
const APP_SIZE = 128;      // app/icon.png（应用内展示只有 18px，128 足够且体积小）
const ROUND_RATIO = 0.22;  // 圆角半径占边长比例；0 = 不切圆角

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                      // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
/* ---------------- PNG 解码 ----------------
   只支持"真彩色、8 位、非隔行"（colorType 2 = RGB / 6 = RGBA）——
   这正是本仓库源图的形态；其它形态直接报错，不做半吊子兼容
   （静默解错色比报错更难查）。 */
function paeth(a, b, c) {
  const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

function unfilter(type, cur, prev, stride, bpp) {
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v = cur[i];
    if (type === 1) v = (v + a) & 255;
    else if (type === 2) v = (v + b) & 255;
    else if (type === 3) v = (v + ((a + b) >> 1)) & 255;
    else if (type === 4) v = (v + paeth(a, b, c)) & 255;
    else if (type !== 0) throw new Error('未知的 PNG 过滤器类型 ' + type);
    cur[i] = v;
  }
}

function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47 || buf.readUInt32BE(4) !== 0x0D0A1A0A) {
    throw new Error('不是合法的 PNG 文件');
  }
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8 位深的 PNG，当前 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行（Adam7）PNG');
  const ch = colorType === 6 ? 4 : (colorType === 2 ? 3 : 0);
  if (!ch) throw new Error('只支持 RGB / RGBA 真彩色（colorType 2 / 6），当前 ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const rgba = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    raw.copy(cur, 0, p, p + stride); p += stride;
    unfilter(f, cur, prev, stride, ch);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, i = x * ch;
      rgba[o] = cur[i]; rgba[o + 1] = cur[i + 1]; rgba[o + 2] = cur[i + 2];
      rgba[o + 3] = ch === 4 ? cur[i + 3] : 255;
    }
    cur.copy(prev);
  }
  return { width: w, height: h, rgba };
}

/* ---------------- 缩放（面积平均 / 盒式滤波） ----------------
   按**预乘 alpha** 加权平均：直接平均非预乘的 RGB，会让透明像素的黑色
   渗进边缘，形成一圈脏边（放大看最明显）。 */
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = y * sh / dh, y1 = (y + 1) * sh / dh;
    const sy0 = Math.floor(y0), sy1 = Math.min(sh, Math.ceil(y1));
    for (let x = 0; x < dw; x++) {
      const x0 = x * sw / dw, x1 = (x + 1) * sw / dw;
      const sx0 = Math.floor(x0), sx1 = Math.min(sw, Math.ceil(x1));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = sx0; sx < sx1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const i = (sy * sw + sx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al * wgt; g += src[i + 1] * al * wgt; b += src[i + 2] * al * wgt;
          a += al * wgt; wsum += wgt;
        }
      }
      const o = (y * dw + x) * 4;
      if (a <= 0 || wsum <= 0) { out[o + 3] = 0; continue; }
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / wsum * 255);
    }
  }
  return out;
}

/* ---------------- 圆角遮罩 ----------------
   圆角矩形的有符号距离场：负值在内部。用 0.5 - sd 当覆盖率，边缘自带 1px 抗锯齿。 */
function roundMask(rgba, size) {
  if (ROUND_RATIO <= 0) return rgba;
  const r = size * ROUND_RATIO;
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const qx = Math.abs(x + 0.5 - c) - (c - r);
      const qy = Math.abs(y + 0.5 - c) - (c - r);
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
      const sd = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
      const cov = Math.min(1, Math.max(0, 0.5 - sd));
      if (cov < 1) {
        const i = (y * size + x) * 4;
        rgba[i + 3] = Math.round(rgba[i + 3] * cov);
      }
    }
  }
  return rgba;
}

/* ---------------- ICO 封装 ----------------
   每个条目都是 PNG 编码（Windows Vista 起支持 PNG-in-ICO，NSIS 也认）。 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);              // 1 = ICO
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, idx) => {
    const o = idx * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;   // 256 记作 0
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4);           // 色彩平面
    dir.writeUInt16LE(32, o + 6);          // 位深
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir].concat(entries.map((e) => e.data)));
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('✗ 找不到源图：' + path.relative(ROOT, SRC));
    console.error('  图标由这张设计图生成，删了它就再也生成不出来了（见 AGENTS.md 红线）。');
    process.exit(1);
  }
  const src = decodePNG(fs.readFileSync(SRC));
  const kb = (b) => (b.length / 1024).toFixed(1) + ' KB';

  /* 每个尺寸都从**原始大图**缩放，而不是从 512 再缩 —— 多一次重采样就多一次糊。 */
  const mk = (size) => roundMask(resize(src.rgba, src.width, src.height, size, size), size);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png512 = encodePNG(PNG_SIZE, PNG_SIZE, mk(PNG_SIZE));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);

  const entries = ICO_SIZES.map((size) => ({ size, data: encodePNG(size, size, mk(size)) }));
  const ico = buildIco(entries);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

  const appPng = encodePNG(APP_SIZE, APP_SIZE, mk(APP_SIZE));
  fs.writeFileSync(APP_ICON, appPng);

  console.log('✓ 图标已生成（源图 ' + src.width + '×' + src.height + ' → ' + path.relative(ROOT, SRC) + '）');
  console.log('  build/icon.png   ' + PNG_SIZE + '×' + PNG_SIZE + '  ' + kb(png512));
  console.log('  build/icon.ico   ' + ICO_SIZES.join('/') + '  ' + kb(ico));
  console.log('  app/icon.png     ' + APP_SIZE + '×' + APP_SIZE + '  ' + kb(appPng));
}

main();

