#!/usr/bin/env node
'use strict';
/* ============================================================
   make-icons.js —— 生成 build/icon.png 与 build/icon.ico

   为什么自己画而不引入图形库：这个仓库坚持零 npm 运行时依赖，
   图标又是"生成一次、之后基本不动"的资产。手写 PNG 编码器只有几十行，
   比引入 sharp/canvas 之类的原生模块（要编译、要跟 Electron 对齐 ABI）划算得多。

   产物：
     build/icon.png   512×512，用于窗口图标 / 托盘 / electron-builder 兜底转换
     build/icon.ico   16/24/32/48/64/128/256 七个尺寸，每个条目都是 PNG 编码
                      （Windows Vista 起支持 PNG-in-ICO，NSIS 也认）

   用法：node scripts/make-icons.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');

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
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 画图 ---------------- */
const SS = 4;   // 超采样倍数：先画大图再盒式降采样，边缘才不会有锯齿

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;

/* 圆角矩形的有符号距离场：负值在内部，可用于 1px 抗锯齿 */
function roundRectSD(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/* 三角形内部判定（重心符号一致法） */
function inTriangle(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

/* 画一张 size×size 的 RGBA 图：圆角渐变底 + 白色播放三角 + 底部三条分镜刻度 */
function render(size) {
  const n = size * SS;
  const big = Buffer.alloc(n * n * 4);
  const pad = n * 0.055;
  const hw = (n - pad * 2) / 2;
  const r = n * 0.225;

  const C1 = [47, 107, 255];     // #2F6BFF
  const C2 = [124, 77, 255];     // #7C4DFF

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const px = x + 0.5, py = y + 0.5;
      const sd = roundRectSD(px, py, n / 2, n / 2, hw, hw, r);
      const cov = clamp(0.5 - sd, 0, 1);
      if (cov <= 0) { big[i + 3] = 0; continue; }
      const t = clamp((px / n) * 0.65 + (py / n) * 0.35, 0, 1);
      big[i] = Math.round(mix(C1[0], C2[0], t));
      big[i + 1] = Math.round(mix(C1[1], C2[1], t));
      big[i + 2] = Math.round(mix(C1[2], C2[2], t));
      big[i + 3] = Math.round(cov * 255);
    }
  }

  /* 播放三角：偏左上一点，给右下角留出刻度条 */
  const tri = [
    [n * 0.365, n * 0.285],
    [n * 0.365, n * 0.665],
    [n * 0.665, n * 0.475]
  ];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      if (!big[i + 3]) continue;
      if (!inTriangle(x + 0.5, y + 0.5, tri[0], tri[1], tri[2])) continue;
      big[i] = 255; big[i + 1] = 255; big[i + 2] = 255; big[i + 3] = 255;
    }
  }

  /* 三条分镜刻度：右下角，暗示"分镜表" */
  const bars = [
    [0.705, 0.60, 0.085],
    [0.705, 0.685, 0.085],
    [0.705, 0.77, 0.085]
  ];
  for (const [bx, by, bw] of bars) {
    const cx = n * (bx + bw / 2), cy = n * by;
    const hwid = n * bw / 2, hh2 = n * 0.022;
    const rad = hh2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 4;
        if (!big[i + 3]) continue;
        if (roundRectSD(x + 0.5, y + 0.5, cx, cy, hwid, hh2, rad) > 0) continue;
        big[i] = 255; big[i + 1] = 255; big[i + 2] = 255; big[i + 3] = 255;
      }
    }
  }

  /* 盒式降采样：SS×SS 取平均，顺便把边缘抗锯齿算出来 */
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, rr = 0, gg = 0, bb = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * n + (x * SS + sx)) * 4;
          const al = big[i + 3] / 255;
          a += al;
          rr += big[i] * al; gg += big[i + 1] * al; bb += big[i + 2] * al;
        }
      }
      const cnt = SS * SS;
      const o = (y * size + x) * 4;
      if (a <= 0) { out[o + 3] = 0; continue; }
      out[o] = Math.round(rr / a);
      out[o + 1] = Math.round(gg / a);
      out[o + 2] = Math.round(bb / a);
      out[o + 3] = Math.round((a / cnt) * 255);
    }
  }
  return out;
}

/* ---------------- ICO 封装 ---------------- */
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
    dir[o + 2] = 0;                        // 调色板数
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);           // 色彩平面
    dir.writeUInt16LE(32, o + 6);          // 位深
    dir.writeUInt32BE(0, o + 8);           // 占位，稍后填
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir].concat(entries.map((e) => e.data)));
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = sizes.map((size) => ({ size, data: encodePNG(size, size, render(size)) }));

  const png512 = encodePNG(512, 512, render(512));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(entries));

  const kb = (b) => (b.length / 1024).toFixed(1) + ' KB';
  console.log('✓ 图标已生成');
  console.log('  build/icon.png   512×512  ' + kb(png512));
  console.log('  build/icon.ico   ' + sizes.join('/') + '  ' + kb(fs.readFileSync(path.join(OUT_DIR, 'icon.ico'))));
}

main();
