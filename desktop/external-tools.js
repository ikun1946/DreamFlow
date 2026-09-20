'use strict';
/* ============================================================
   external-tools.js —— 外部可执行文件定位（dreamina / ffmpeg / ffprobe）

   查找优先级（与 README「桌面化」一节一致）：
     1. 用户在桌面配置里手填的绝对路径（desktop-config.json 的 tools.*）
     2. 安装包内置：<resources>\bin\<name>.exe
     3. 系统 PATH
     4. 常见安装位置（WinGet Links、用户 bin、Program Files 下的 ffmpeg）

   为什么默认**不内置** dreamina / ffmpeg：
     · dreamina.exe 未签名、且是即梦的官方 CLI，未确认再分发授权前不该随包发出；
     · 本机 ffmpeg 是 GPL 构建、单个可执行文件 200 MB 量级，直接塞进安装包
       会让体积翻好几倍，还牵扯 GPL 合规。
   所以这一版先"检测 + 允许手填"，内置与否是发布决策，不是代码决策。

   ⚠ 只做定位，不校验签名、不执行任何东西 —— 真正跑起来由 server 侧负责。
   ============================================================ */
const fs = require('fs');
const path = require('path');

function exists(p) { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } }

function fromPath(name) {
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      if (exists(p)) return p;
    }
  }
  return null;
}

function commonLocations(name) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const local = process.env.LOCALAPPDATA || '';
  const out = [];
  if (home) out.push(path.join(home, 'bin', name + '.exe'));
  if (local) {
    out.push(path.join(local, 'Microsoft', 'WinGet', 'Links', name + '.exe'));
    /* WinGet 的 ffmpeg 装在带随机后缀的包目录里，深度不固定，这里只探一层常见形状 */
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pkgs)) {
        if (!/^Gyan\.FFmpeg|^ffmpeg/i.test(d)) continue;
        const base = path.join(pkgs, d);
        for (const sub of safeReaddir(base)) {
          out.push(path.join(base, sub, 'bin', name + '.exe'));
        }
      }
    } catch (e) { /* 没有 WinGet 目录就算了 */ }
  }
  out.push('C:\\ffmpeg\\bin\\' + name + '.exe');
  out.push('C:\\Program Files\\ffmpeg\\bin\\' + name + '.exe');
  return out;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

/* 定位单个工具。返回 { name, path, source } —— 找不到时 path 为 null。 */
function locate(name, opts) {
  const o = opts || {};
  const explicit = o.explicit;
  if (exists(explicit)) return { name, path: explicit, source: 'config' };
  const bundled = o.bundledDir ? path.join(o.bundledDir, name + '.exe') : null;
  if (exists(bundled)) return { name, path: bundled, source: 'bundled' };
  const onPath = fromPath(name);
  if (onPath) return { name, path: onPath, source: 'path' };
  for (const p of commonLocations(name)) {
    if (exists(p)) return { name, path: p, source: 'common' };
  }
  return { name, path: null, source: 'missing' };
}

/* 一次性定位三个工具。bundledDir 由 main.js 传 process.resourcesPath\bin。 */
function detect(cfg, bundledDir) {
  const tools = (cfg && cfg.tools) || {};
  return {
    dreamina: locate('dreamina', { explicit: tools.dreamina, bundledDir }),
    ffmpeg: locate('ffmpeg', { explicit: tools.ffmpeg, bundledDir }),
    ffprobe: locate('ffprobe', { explicit: tools.ffprobe, bundledDir })
  };
}

/* 给设置页/启动提示用的一句话摘要 */
function summarize(found) {
  const line = (t) => t.name + '：' + (t.path ? t.path + '（' + t.source + '）' : '未找到');
  return [line(found.dreamina), line(found.ffmpeg), line(found.ffprobe)].join('\n');
}

module.exports = { detect, locate, summarize, fromPath, exists };
