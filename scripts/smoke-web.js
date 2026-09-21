#!/usr/bin/env node
/**
 * scripts/smoke-web.js —— 网页版 smoke test（P1-9）
 *
 * 与桌面版 smoke 分离：桌面版验的是「Electron 壳 + 内嵌服务 + DOM 渲染」，
 * 网页版只验「HTTP 服务本身能不能起来、接口通不通、关掉之后干不干净」。
 * 两者失败的原因几乎不重叠，混在一起看会互相干扰。
 *
 * 自动检查（对应清单 §9「网页版 smoke test」）：
 *   1. 服务能在 127.0.0.1:8787（或指定端口）监听
 *   2. `/` 返回 HTML（且是真实页面，不是错误页）
 *   3. `/api/v1/meta/options` 返回 code 0
 *   4. 带 Token 时未授权请求返回 40100
 *   5. 停止服务后端口释放（没有残留进程）
 *
 * 用法：
 *   node scripts/smoke-web.js
 *   node scripts/smoke-web.js --port 8899 --token secret
 *   node scripts/smoke-web.js --keep      # 不清理临时数据目录，便于排查
 *
 * 退出码：0 = 全通；1 = 有失败
 *
 * ⚠ 数据隔离铁律：本脚本**强制**把 JC_DATA_DIR 指到一个临时目录。
 *   绝不允许 smoke test 落到 server/data（AGENTS.md 红线）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ── 参数 ────────────────────────────────────────────────────────
function argVal(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = Number(argVal('port', 8787));
const TOKEN = argVal('token', '');
const KEEP = !!argVal('keep', false);

// ── 输出小工具 ──────────────────────────────────────────────────
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

let failed = 0;
const pass = (m) => console.log(C.g + '  OK    ' + C.x + m);
const fail = (m) => { failed++; console.log(C.r + '  FAIL  ' + C.x + m); };
const info = (m) => console.log(C.d + '         ' + m + C.x);
const head = (m) => console.log('\n' + C.b + m + C.x);

// ── HTTP 小工具 ─────────────────────────────────────────────────
function request(method, urlPath, headers, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers: headers || {}, timeout: timeoutMs || 8000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: e }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '', error: new Error('超时') }); });
    req.end();
  });
}

function parseEnvelope(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

/** 等端口可用（最多 waitMs）。 */
async function waitReady(waitMs) {
  const deadline = Date.now() + (waitMs || 30000);
  while (Date.now() < deadline) {
    const r = await request('GET', '/', {}, 2000);
    if (r.status && r.status > 0) return true;
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

/** 端口是否仍在监听（用于"停止后无残留"检查）。 */
function portOpen() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'GET', timeout: 1500 },
      (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── 主流程 ──────────────────────────────────────────────────────
(async function main() {
  console.log(C.b + '即梦批量生成控制台 —— 网页版 smoke test' + C.x);
  info('端口 ' + PORT + (TOKEN ? ' · Token 校验已启用' : ' · 无 Token（默认）'));

  // ★ 数据隔离：临时目录必须在仓库内（Git Bash 下 /tmp 会被解析成 C:\tmp）
  const dataDir = path.join(ROOT, '.test-tmp', 'smoke-web-' + Date.now());
  fs.mkdirSync(dataDir, { recursive: true });
  info('数据目录 ' + dataDir + '（隔离，用完即删）');

  let child = null;
  let stdout = '';
  let stderr = '';

  const cleanup = () => {
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch (e) { /* 忽略 */ }
    }
    if (!KEEP) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    } else {
      console.log(C.d + '         （--keep：保留 ' + dataDir + '）' + C.x);
    }
  };

  try {
    // ── 1. 起服务 ─────────────────────────────────────────────
    head('[1] 启动服务');

    child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        JC_DATA_DIR: dataDir,
        JC_PORT: String(PORT),
        JC_HOST: '127.0.0.1',
        JC_TOKEN: TOKEN || '',
        // smoke 不连真实 CLI：probe 也要跳过，否则每次跑都要等好几秒
        JC_DREAMINA_CLI_PATH: process.platform === 'win32' ? 'nonexistent-cli-for-smoke.exe' : 'nonexistent-cli-for-smoke'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (e) => { stderr += '\n[spawn error] ' + e.message; });

    const ready = await waitReady(30000);
    if (!ready) {
      fail('服务未能在 30 秒内监听 ' + PORT);
      info('子进程输出：\n' + (stdout || '(空)') + (stderr ? '\n[stderr]\n' + stderr : ''));
      return;
    }
    pass('服务已监听 127.0.0.1:' + PORT);
    if (/数据目录.*smoke-web/.test(stdout)) {
      pass('启动横幅确认数据目录已被 JC_DATA_DIR 重定向（附加项-1 回归）');
    } else {
      fail('启动横幅未显示被重定向的数据目录 —— JC_DATA_DIR 可能又失效了');
      info('实际输出片段：' + stdout.split('\n').filter((l) => /数据目录/.test(l)).join(' | '));
    }

    // ★ 绝不能落进 server/data
    if (fs.existsSync(path.join(ROOT, 'server', 'data'))) {
      fail('★ server/data 被创建了 —— smoke test 污染了真实数据目录');
    } else {
      pass('未污染 server/data');
    }

    // ── 2. `/` 返回 HTML ──────────────────────────────────────
    head('[2] 首页');
    const home = await request('GET', '/');
    if (home.status !== 200) {
      fail('GET / 状态码 ' + home.status + '（期望 200）');
    } else if (!/text\/html/i.test(home.headers['content-type'] || '')) {
      fail('GET / 的 Content-Type 不是 html：' + home.headers['content-type']);
    } else if (!/<html|<!DOCTYPE/i.test(home.body)) {
      fail('GET / 返回的不是 HTML 页面');
    } else if (home.body.length < 500) {
      fail('GET / 返回的 HTML 过短（' + home.body.length + ' 字节），可能是错误页');
    } else {
      pass('GET / 返回 HTML（' + home.body.length + ' 字节）');
    }

    // ── 3. 接口打通 ───────────────────────────────────────────
    head('[3] 接口');
    const H = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};

    /* 用 /auth/me 与 /system/adapter 作为"接口打通"的探针：
       它们**不需要作用域**，空库也能返回 code 0。
       ⚠ 不要用 /meta/options 当探针：它按项目作用域解析，空库时**正确地**
         返回 40400「当前没有任何项目」。那是设计行为，不是故障，
         拿它当 smoke 判据会产生假阳性（实测踩到）。 */
    const me = await request('GET', '/api/v1/auth/me', H);
    const meEnv = parseEnvelope(me.body);
    if (me.status !== 200) {
      fail('GET /api/v1/auth/me 状态码 ' + me.status + '（期望 200，业务码在信封里）');
    } else if (!meEnv) {
      fail('响应不是合法 JSON：' + me.body.slice(0, 120));
    } else if (meEnv.code !== 0) {
      fail('/auth/me 业务码非 0：code=' + meEnv.code + ' message=' + meEnv.message);
    } else if (!meEnv.traceId) {
      fail('信封缺少 traceId');
    } else {
      pass('/auth/me → code=0，信封含 traceId');
    }

    const ad = await request('GET', '/api/v1/system/adapter', H);
    const adEnv = parseEnvelope(ad.body);
    if (!adEnv || typeof adEnv.code !== 'number') {
      fail('/system/adapter 未返回合法信封');
    } else {
      // 这个接口不管有没有 CLI 都应该能答（缺 CLI 是 code=0 + toolError，不是 5xx）
      if (adEnv.code === 0) {
        pass('/system/adapter → code=0');
        if (adEnv.data && adEnv.data.mediaTools) {
          pass('已下发 mediaTools 状态（P1-10 工具错误码透出）');
        } else {
          info('data 键：' + Object.keys(adEnv.data || {}).join(', '));
        }
      } else {
        fail('/system/adapter 业务码非 0：code=' + adEnv.code + ' message=' + adEnv.message);
      }
    }

    // meta/options 的正确行为：空库时应明确报"没有项目"，而不是崩溃
    const opt = await request('GET', '/api/v1/meta/options', H);
    const env = parseEnvelope(opt.body);
    if (!env) {
      fail('/meta/options 未返回合法信封：' + opt.body.slice(0, 120));
    } else if (env.code === 0) {
      pass('/meta/options → code=0（库里有项目）');
    } else if (env.code === 40400 && /项目/.test(env.message || '')) {
      pass('/meta/options 空库时正确提示「先创建项目」（40400，设计行为）');
    } else {
      fail('/meta/options 异常：code=' + env.code + ' message=' + env.message);
    }

    // ── 4. 鉴权（仅在设了 Token 时） ──────────────────────────
    head('[4] 鉴权');
    if (!TOKEN) {
      info('未启用 Token，跳过鉴权检查（用 --token xxx 可开启）');
    } else {
      const noAuth = await request('GET', '/api/v1/auth/me', {});
      const ne = parseEnvelope(noAuth.body);
      if (!ne || ne.code !== 40100) {
        fail('未授权请求应返回 40100，实得 code=' + (ne && ne.code));
      } else {
        pass('未授权请求返回 40100');
      }
      // 错误的 token 也必须被拒
      const badAuth = await request('GET', '/api/v1/auth/me', { Authorization: 'Bearer wrong-token' });
      const be = parseEnvelope(badAuth.body);
      if (!be || be.code !== 40100) fail('错误 Token 应返回 40100，实得 code=' + (be && be.code));
      else pass('错误 Token 被拒（40100）');
      // 正确 token 通
      const goodAuth = await request('GET', '/api/v1/auth/me', H);
      const ge = parseEnvelope(goodAuth.body);
      if (!ge || ge.code !== 0) fail('正确 Token 应放行，实得 code=' + (ge && ge.code));
      else pass('正确 Token 放行');
    }

    // ── 5. 边界 ──────────────────────────────────────────────
    head('[5] 边界');
    /* ⚠ 路径必须 encodeURI —— 直接把中文丢进 http.request 会抛
       ERR_UNESCAPED_CHARACTERS（实测踩到）。 */
    const nf = await request('GET', '/api/v1/' + encodeURIComponent('根本不存在的路径'), H);
    const nfe = parseEnvelope(nf.body);
    if (nfe && nfe.code === 40400) pass('未知 API 路径返回 40400');
    else if (!nfe) info('未知路径返回非 JSON（HTTP ' + nf.status + '），可接受');
    else fail('未知路径的 code 异常：' + nfe.code);

    // 路径穿越必须被拒（返回 null → 404），绝不能吐源码
    const trav = await request('GET', '/files/..%2f..%2f..%2fserver%2fconfig.js', H);
    if (trav.status === 200 && /loadConfig|module\.exports/.test(trav.body)) {
      fail('★ 静态路由疑似泄漏源码（路径穿越成功了）');
    } else {
      pass('路径穿越请求被拒（HTTP ' + trav.status + '）');
    }

  } finally {
    // ── 6. 停止服务 ──────────────────────────────────────────
    head('[6] 停止与残留检查');
    if (child) {
      try { child.kill('SIGTERM'); } catch (e) { /* 忽略 */ }

      // 等进程退出（最多 8 秒）
      const exited = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 8000);
        child.on('exit', () => { clearTimeout(t); resolve(true); });
      });

      if (!exited) {
        fail('SIGTERM 后子进程未在 8 秒内退出');
        try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      } else {
        pass('子进程已退出（SIGTERM 优雅停止生效）');
      }

      // 端口必须释放
      let stillOpen = await portOpen();
      if (stillOpen) {
        // 给一点时间让 socket 完全关闭
        await new Promise((s) => setTimeout(s, 1200));
        stillOpen = await portOpen();
      }
      if (stillOpen) fail('★ 停止后端口 ' + PORT + ' 仍在监听（有残留进程）');
      else pass('端口 ' + PORT + ' 已释放，无残留');
    }
    cleanup();
  }

  // ── 汇总 ──────────────────────────────────────────────────
  console.log('');
  if (failed) {
    console.log(C.r + C.b + '结果：失败（' + failed + ' 项）' + C.x);
    if (stderr && /Error|error/.test(stderr)) {
      console.log(C.d + '子进程 stderr 片段：' + C.x);
      console.log(stderr.split('\n').slice(0, 10).join('\n'));
    }
    process.exit(1);
  }
  console.log(C.g + C.b + '结果：通过' + C.x);
  process.exit(0);
})().catch((e) => {
  console.error(C.r + 'smoke 脚本自身异常：' + ((e && e.stack) || e) + C.x);
  process.exit(1);
});
