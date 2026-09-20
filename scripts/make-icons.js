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

/* ---------------- 合成原语 ----------------
   新图标有 6 层（底色 → 两张后置卡片 → 前卡片投影 → 前卡片 → 挖空三角），
   再像原来那样"逐层直接写像素"会互相覆盖、alpha 也算不清，所以先有合成。 */
function over(big, i, r, g, b, a) {
  const sa = clamp(a, 0, 1);
  if (sa <= 0) return;
  const da = big[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) { big[i + 3] = 0; return; }
  big[i] = Math.round((r * sa + big[i] * da * (1 - sa)) / oa);
  big[i + 1] = Math.round((g * sa + big[i + 1] * da * (1 - sa)) / oa);
  big[i + 2] = Math.round((b * sa + big[i + 2] * da * (1 - sa)) / oa);
  big[i + 3] = Math.round(oa * 255);
}

/* 圆角矩形填充。只遍历包围盒 —— 512×512 下每层全画布扫距离场会多算几十万次。 */
function fillRoundRect(big, n, cx, cy, hw, hh, r, col) {
  const cr = col[0], cg = col[1], cb = col[2], ca = col[3];
  const x0 = Math.max(0, Math.floor(cx - hw - 2)), x1 = Math.min(n, Math.ceil(cx + hw + 2));
  const y0 = Math.max(0, Math.floor(cy - hh - 2)), y1 = Math.min(n, Math.ceil(cy + hh + 2));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const sd = roundRectSD(x + 0.5, y + 0.5, cx, cy, hw, hh, r);
      const cov = clamp(0.5 - sd, 0, 1);
      if (cov > 0) over(big, (y * n + x) * 4, cr, cg, cb, ca * cov);
    }
  }
}

/* 底色渐变：蓝 → 靛 → 紫**三段** + 左上柔光。
   原来是两段线性渐变，整块颜色太平，就是"单调"的来源：两色在中间直接插值会发灰，
   补一个中间色标（靛）能让过渡保持饱和；柔光给一点体积感，不再是纯平色块。 */
const G1 = [47, 107, 255];     // #2F6BFF
const G2 = [86, 92, 255];      // #565CFF
const G3 = [124, 77, 255];     // #7C4DFF

function bgColor(u, v) {
  const t = clamp(u * 0.62 + v * 0.38, 0, 1);
  let r, g, b;
  if (t < 0.5) {
    const k = t / 0.5;
    r = mix(G1[0], G2[0], k); g = mix(G1[1], G2[1], k); b = mix(G1[2], G2[2], k);
  } else {
    const k = (t - 0.5) / 0.5;
    r = mix(G2[0], G3[0], k); g = mix(G2[1], G3[1], k); b = mix(G2[2], G3[2], k);
  }
  /* 左上柔光：中心 (0.28, 0.20)，平方衰减，最亮处提亮 30% */
  const dx = u - 0.28, dy = v - 0.20;
  const d = Math.sqrt(dx * dx + dy * dy);
  const glow = Math.pow(clamp(1 - d / 0.78, 0, 1), 2) * 0.30;
  return [mix(r, 255, glow), mix(g, 255, glow), mix(b, 255, glow)];
}

/* 画一张 size×size 的 RGBA 图。
   设计（2026-09-20 重做）：**三张层叠的分镜卡片 + 前卡片上挖空的播放三角**。
     · 层叠 = "一叠待处理的分镜"，这是"批量"最直白的视觉隐喻（原来的三条刻度太弱）
     · 后面两张半透明、越远越淡：做出纵深，同时让底色渐变透出来，不再是白块压平色
     · 三角是**挖空**（填底色）而不是叠白三角 —— 白三角压在白卡片上等于看不见
   小尺寸可读性优先：16×16 下能看清的只有"白色圆角块 + 两个错位影子 + 一个三角"，
   所以刻意不加细节，层次全靠错位和透明度做。 */
function render(size) {
  const n = size * SS;
  const big = Buffer.alloc(n * n * 4);
  const pad = n * 0.055;
  const hw = (n - pad * 2) / 2;
  const r = n * 0.225;

  /* ① 底色：圆角方形 + 三段渐变 + 左上柔光 */
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const px = x + 0.5, py = y + 0.5;
      const sd = roundRectSD(px, py, n / 2, n / 2, hw, hw, r);
      const cov = clamp(0.5 - sd, 0, 1);
      if (cov <= 0) { big[i + 3] = 0; continue; }
      const c = bgColor(px / n, py / n);
      big[i] = Math.round(c[0]);
      big[i + 1] = Math.round(c[1]);
      big[i + 2] = Math.round(c[2]);
      big[i + 3] = Math.round(cov * 255);
    }
  }

  /* ② 三张层叠卡片：从后往前画，每张往右上错开一格。
        整体中心刻意压到 (0.53, 0.50) 附近 —— 卡片是往右上堆的，
        如果前卡片正好摆正中，视觉重心会明显偏右上。 */
  /* 尺寸是照着 16×16 调出来的（见 §"小尺寸优先"）：卡片不能太瘦，
     错位不能太小，后两层不能太淡 —— 这三样任何一样不到位，16×16 下
     "层叠"就退化成"一个白块"，批量感直接丢掉。 */
  const cw = n * 0.21;            // 卡片半宽
  const ch = n * 0.24;            // 卡片半高（比宽略高，保持"分镜卡"的竖版感）
  const cr2 = n * 0.075;          // 卡片圆角
  const OFF = n * 0.082;          // 层与层的错位量（层叠感全靠它）
  const fx = n * 0.445;           // 前卡片中心
  const fy = n * 0.565;

  /* 后两张半透明、越远越淡：做出纵深，也让底色渐变透出来。
     透明度是从 0.20/0.38 提上来的 —— 原来那组在 16×16 下几乎看不见，
     等于白画了两层。 */
  fillRoundRect(big, n, fx + OFF * 2, fy - OFF * 2, cw, ch, cr2, [255, 255, 255, 0.30]);
  fillRoundRect(big, n, fx + OFF, fy - OFF, cw, ch, cr2, [255, 255, 255, 0.52]);

  /* ③ 前卡片的投影：往右下偏一点、边缘柔化，把卡片从底色上"抬"起来。
        用距离场衰减当模糊就够 —— 为这点阴影引入卷积不划算。
        卡片内部不画（反正会被盖住），省掉一半像素。 */
  const SH = n * 0.020;
  const sx = fx + n * 0.010, sy = fy + n * 0.018;
  const shx0 = Math.max(0, Math.floor(sx - cw - SH * 3)), shx1 = Math.min(n, Math.ceil(sx + cw + SH * 3));
  const shy0 = Math.max(0, Math.floor(sy - ch - SH * 3)), shy1 = Math.min(n, Math.ceil(sy + ch + SH * 3));
  for (let y = shy0; y < shy1; y++) {
    for (let x = shx0; x < shx1; x++) {
      const sd = roundRectSD(x + 0.5, y + 0.5, sx, sy, cw, ch, cr2);
      if (sd <= 0) continue;
      const k = clamp(1 - sd / (SH * 3), 0, 1);
      if (k > 0) over(big, (y * n + x) * 4, 12, 14, 48, 0.30 * k * k);
    }
  }

  /* ④ 前卡片：实心白 */
  fillRoundRect(big, n, fx, fy, cw, ch, cr2, [255, 255, 255, 1]);

  /* ⑤ 播放三角：**挖空**（填底色渐变）而不是再叠一层白。
        三角整体右移一点点做视觉居中 —— 等宽等高的三角形按几何居中会显偏左。 */
  const tri = [
    [fx - n * 0.078, fy - n * 0.125],
    [fx - n * 0.078, fy + n * 0.125],
    [fx + n * 0.117, fy]
  ];
  const tx0 = Math.max(0, Math.floor(Math.min(tri[0][0], tri[1][0], tri[2][0]) - 2));
  const tx1 = Math.min(n, Math.ceil(Math.max(tri[0][0], tri[1][0], tri[2][0]) + 2));
  const ty0 = Math.max(0, Math.floor(Math.min(tri[0][1], tri[1][1], tri[2][1]) - 2));
  const ty1 = Math.min(n, Math.ceil(Math.max(tri[0][1], tri[1][1], tri[2][1]) + 2));
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (!inTriangle(x + 0.5, y + 0.5, tri[0], tri[1], tri[2])) continue;
      const c = bgColor((x + 0.5) / n, (y + 0.5) / n);
      over(big, (y * n + x) * 4, c[0], c[1], c[2], 1);
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
