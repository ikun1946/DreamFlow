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

/* ---------------- 稳定错误码与解决动作（2026-09-21） ----------------
   给"缺哪个工具"一个可编程的表达，而不是让上层靠 summary 的自由文本做判断。
   表格与 docs/项目审查与改进清单.md §10 的三个等级严格对应：
     dreamina 缺失 → 无法生成视频     → 阻止提交
     ffmpeg   缺失 → 无法生成封面     → 允许生成，但明确提示封面缺失
     ffprobe  缺失 → 无法读取音频时长 → 禁止绑定无法确认时长的音频
   action 是给界面用的**可执行解决动作**标识（前端据此决定显示"去安装"/"去登录"）。 */
const TOOL_SPEC = {
  dreamina: { code: 'CLI_NOT_FOUND', blocks: 'submit', action: 'install-cli' },
  ffmpeg: { code: 'FFMPEG_NOT_FOUND', blocks: null, action: 'install-ffmpeg' },
  ffprobe: { code: 'FFPROBE_NOT_FOUND', blocks: 'audio-bind', action: 'install-ffmpeg' }
};

/* 把 detect() 的结果转成"四件套"报告：后端响应 / 前端提示 / 日志文本 / 解决动作。
   ⚠ code 用**数字**（与 server/util.js 的 ERR 对齐），字符串名留在 name 里 ——
      字符串名给人看与写日志，数字码给程序判断，两者都需要。 */
const TOOL_CODES = {
  dreamina: { CLI_NOT_FOUND: 51101, CLI_NOT_LOGGED_IN: 51102, CLI_PERMISSION_DENIED: 51103 },
  ffmpeg: { FFMPEG_NOT_FOUND: 51104 },
  ffprobe: { FFPROBE_NOT_FOUND: 51105 }
};

function toolStatus(found) {
  const out = {};
  Object.keys(TOOL_SPEC).forEach((k) => {
    const t = (found && found[k]) || { path: null, source: 'missing' };
    const miss = !t.path;
    const spec = TOOL_SPEC[k];
    out[k] = {
      name: k,
      path: t.path || null,
      source: t.source || 'missing',
      ok: !miss,
      code: miss ? TOOL_CODES[k][spec.code] : 0,
      codeName: miss ? spec.code : null,
      blocks: miss ? spec.blocks : null,
      action: miss ? spec.action : null,
      message: miss ? missingMessage(k) : null
    };
  });
  return out;
}

function missingMessage(name) {
  if (name === 'dreamina') {
    return '未检测到创作 CLI（dreamina）：无法生成视频。请在设置页安装或指定路径，然后登录。';
  }
  if (name === 'ffmpeg') {
    return '未检测到 ffmpeg：视频可以正常生成，但**不会生成封面图**（列表缩略图与播放器 poster 会缺失）。';
  }
  return '未检测到 ffprobe：无法读取音频时长，绑定音频时会被拒绝。请安装 ffmpeg（ffprobe 随它一起分发）。';
}

/* 给设置页/启动提示用的一句话摘要。
   ⚠ 2026-09-21 起顺序固定为 dreamina → ffmpeg → ffprobe（与 TOOL_SPEC 同序），
      且缺失项带 `[缺失]` 前缀 —— 启动日志里 grep 得到。 */
function summarize(found) {
  const line = (t) => t.name + '：' + (t.path ? t.path + '（' + t.source + '）' : '**[缺失]**');
  return [line(found.dreamina), line(found.ffmpeg), line(found.ffprobe)].join('\n');
}

module.exports = {
  detect, locate, summarize, fromPath, exists,
  toolStatus, missingMessage, TOOL_SPEC, TOOL_CODES
};
