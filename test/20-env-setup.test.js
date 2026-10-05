'use strict';
/* ============================================================
   首次启动「环境体检 + 一键配好」（0.48.0）· 回归测试

   测的是**决策逻辑与安全闸**，不联网、不碰用户的 %USERPROFILE%\bin：
   依赖（下载 / 解压 / 执行 / 探测 / 临时目录 / 落位目录）全部注入假的。

   重点盯这几种"改了看不出来、但会真出事"的地方：
     · 缺 PE / 试运行失败时**不能**动用户已有那份（placeTool 的备份与回滚）；
     · 上游返回 HTML 错误页时不能当成 ZIP 装出去（looksLikeZip）；
     · 缺 ffmpeg 时文案要说清"缺了会少什么"，不能让用户以为装不了；
     · 显式配置的 ffmpeg 路径不能被"我们装的那份"顶掉（resolvedTool 三级顺序）；
     · 代理判定：本机地址直连、NO_PROXY 生效、https 走 HTTPS_PROXY（net-proxy.js
       那个 `agent:false` 静默忽略 createConnection 的坑，见该文件注释）。
   ============================================================ */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const ENV = require('../server/env-setup');
const NP = require('../server/net-proxy');

/* 一个"最小可执行文件"：带 MZ 头（PE 检查只看这两个字节）。 */
function fakeExe(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 1)]));
  return file;
}
function fakeZip(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 2)]));
  return file;
}
function tmp(tag) {
  const d = path.join(REPO, '.test-tmp', 'env-' + tag + '-' + process.pid + '-' + Date.now());
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  made.push(d);
  return d;
}
/* 登记造出来的目录，用完统一删 —— 仓库纪律（同 test/helpers.js 的 cleanTmpRoot）：
   临时目录留在 .test-tmp 里会越攒越多，也会让别人误以为那是"运行态数据"。 */
const made = [];
after(() => { made.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ } }); });
/* 可执行 = ok 的假 runTool；用它把"试运行"这一关做成可控。 */
const runOk = () => Promise.resolve({ ok: true, stdout: 'ffmpeg version 7.1-full_build\nffprobe version 7.1-full_build\n' });
const runFail = (msg) => () => Promise.resolve({ ok: false, error: msg });

describe('环境体检：逐项与文案', () => {
  const base = {
    cliStatus: () => Promise.resolve({ installed: false, path: 'C:\\Users\\x\\bin\\dreamina.exe', needsUpdate: false }),
    cliAuth: null,
    dataDir: os.tmpdir(),
    probe: false,
    runTool: () => Promise.resolve({ ok: false, error: 'ENOENT 系统找不到指定的文件' }),
    isWritable: () => true
  };

  test('全新机器：CLI 未装、未登录、ffmpeg/ffprobe 缺，且都标成可修', async () => {
    const r = await ENV.report({}, base);
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    assert.equal(by.cli.ok, false);
    assert.equal(by.cli.installable, '可一键安装');
    assert.equal(by.cliLogin.ok, false, '未登录要单列一条（缺的东西与"没装"完全不同）');
    assert.equal(by.cliLogin.fixable, false, '登录要浏览器授权，不能标成可自动修');
    assert.match(by.cliLogin.detail, /浏览器授权/, '要说清为什么不能自动做');
    assert.equal(by.ffmpeg.ok, false);
    assert.equal(by.ffprobe.ok, false);
    assert.equal(r.summary.problems >= 4, true);
    assert.equal(r.summary.fixable >= 2, true, '可自动修的项数要供界面决定按钮亮不亮');
  });

  test('缺 ffmpeg 的文案要说清"缺了会少什么"，而不是"装不了"', async () => {
    const r = await ENV.report({}, base);
    const ff = r.items.find((i) => i.id === 'ffmpeg');
    const fp = r.items.find((i) => i.id === 'ffprobe');
    assert.match(ff.detail, /封面/, 'ffmpeg 影响的是产物封面');
    assert.match(fp.detail, /时长/, 'ffprobe 影响的是音频时长');
    assert.match(fp.detail, /不允许绑定/, '要说清"时长未知"的连带后果');
  });

  test('账号是对象不是字符串：不得拼出「[object Object]」', async () => {
    /* 探测层给的 account 是 { userId, vipLevel }（dreamina-cli.js），
       直接字符串拼接会显示成「已登录：[object Object]」—— 2026-10-05 真实出现过。 */
    const obj = await ENV.report({}, Object.assign({}, base, {
      cliStatus: () => Promise.resolve({ installed: true, path: 'p' }),
      cliAuth: { available: true, account: { userId: 'u_12345', vipLevel: 'vip_3' } }
    }));
    const it = obj.items.find((i) => i.id === 'cliLogin');
    assert.doesNotMatch(it.detail, /\[object Object\]/, '对象不能直接拼进文案');
    assert.match(it.detail, /u_12345/);
    assert.match(it.detail, /vip_3/);

    /* 万一将来形状变了（变成字符串）也不能崩 */
    const str = await ENV.report({}, Object.assign({}, base, {
      cliStatus: () => Promise.resolve({ installed: true, path: 'p' }),
      cliAuth: { available: true, account: 'someone@example.com' }
    }));
    assert.match(str.items.find((i) => i.id === 'cliLogin').detail, /someone@example\.com/);

    /* 没有账号信息时也不该出现空的「已登录：」 */
    const none = await ENV.report({}, Object.assign({}, base, {
      cliStatus: () => Promise.resolve({ installed: true, path: 'p' }),
      cliAuth: { available: true, account: null }
    }));
    const d = none.items.find((i) => i.id === 'cliLogin').detail;
    assert.equal(/已登录：$/.test(d), false, '没有账号时别留个悬空的冒号：' + d);
  });

  test('probe=1 才查上游连通性；CLI 已装且已登录时不报问题', async () => {
    let probed = 0;
    const okDeps = Object.assign({}, base, {
      cliStatus: () => Promise.resolve({ installed: true, path: 'p', needsUpdate: false, mtime: '2026-10-05T00:00:00.000Z' }),
      cliAuth: { available: true, account: 'someone@example.com' },
      runTool: () => Promise.resolve({ ok: true, stdout: 'ffmpeg version 7.1\n' }),
      probe: true,
      probeNetwork: () => { probed++; return Promise.resolve({ ok: true, status: 200 }); }
    });
    const r = await ENV.report({}, okDeps);
    assert.equal(r.summary.problems, 0, '全齐时不该报问题：' + JSON.stringify(r.items.filter((i) => !i.ok)));
    assert.equal(r.items.some((i) => i.id === 'network'), true);
    assert.equal(probed, 1, 'probe=1 要真去连（启动那次才允许用缓存）');
    assert.match(r.items.find((i) => i.id === 'cli').detail, /已安装/);
    assert.match(r.items.find((i) => i.id === 'cliLogin').detail, /已登录/);
  });

  test('数据目录不可写要如实报出目录（用户要靠它去改设置）', async () => {
    const r = await ENV.report({}, Object.assign({}, base, { dataDir: 'D:\\readonly', isWritable: () => false }));
    const it = r.items.find((i) => i.id === 'dataDir');
    assert.equal(it.ok, false);
    assert.match(it.detail, /D:\\readonly/);
    assert.match(it.detail, /数据目录|可写/, '要说清去哪改');
  });
});

describe('可执行文件路径解析（装完立刻生效）', () => {
  test('三级顺序：显式配置 > 我们装在 bin 里的 > PATH 裸命令名', () => {
    /* ① 用户明确写了绝对路径 —— 不能被"我们装的那份"顶掉 */
    assert.equal(ENV.resolvedTool({ ffmpegPath: 'D:\\tools\\ffmpeg.exe' }, 'ffmpeg'), 'D:\\tools\\ffmpeg.exe');
    /* ② 裸名字 = "没指定"，此时若 bin 目录里有我们装的那份就用它 */
    assert.equal(ENV.resolvedTool({ ffmpegPath: 'ffmpeg' }, 'ffmpeg'), 'ffmpeg', '没装过就是裸名字');
    assert.equal(ENV.resolvedTool({}, 'ffprobe'), 'ffprobe');
    /* ③ 完全没有配置项 → 回落裸名字（用户自己装在 PATH 里的） */
    assert.equal(ENV.resolvedTool(undefined, 'ffmpeg'), 'ffmpeg');
  });
});

describe('下载物校验与落位安全闸', () => {
  test('HTML 错误页不能被当成 ZIP 装出去', () => {
    const d = tmp('zip');
    const good = path.join(d, 'good.zip'); fakeZip(good);
    const html = path.join(d, 'error.html'); fs.writeFileSync(html, '<html>Not Found</html>');
    assert.equal(ENV.looksLikeZip(good), true);
    assert.equal(ENV.looksLikeZip(html), false, '上游返回错误页时必须拦下');
    assert.equal(ENV.looksLikeZip(path.join(d, 'nope.bin')), false, '文件不存在也不能算 ZIP');
  });

  test('不是 PE 的文件不得落位（哪怕名字对、就在 bin 目录里）', async () => {
    const d = tmp('pe');
    const bad = path.join(d, 'ffmpeg.exe'); fs.writeFileSync(bad, 'not a PE');
    const r = await ENV.placeTool(bad, path.join(d, 'bin', 'ffmpeg.exe'), runOk);
    assert.equal(r.ok, false);
    assert.match(r.error, /PE/);
    assert.equal(fs.existsSync(path.join(d, 'bin', 'ffmpeg.exe')), false, '目标位置不该留下任何文件');
  });

  test('试运行失败：保留旧文件、删掉新文件，绝不把坏文件顶上去', async () => {
    const d = tmp('run');
    const dest = path.join(d, 'bin', 'ffmpeg.exe');
    const old = fakeExe(dest); fs.writeFileSync(old, 'OLD-BUT-WORKING');
    const src = fakeExe(path.join(d, 'src', 'ffmpeg.exe'));
    const r = await ENV.placeTool(src, dest, runFail('被拒绝访问'));
    assert.equal(r.ok, false);
    assert.match(r.error, /保留原文件/);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'OLD-BUT-WORKING', '旧文件必须一字未动');
    const staged = fs.readdirSync(path.dirname(dest)).filter((f) => f.indexOf('.new-') >= 0);
    assert.deepEqual(staged, [], '暂存的新文件要清掉：' + staged.join(','));
  });

  test('装成功：旧版留备份，新文件到位并带上版本', async () => {
    const d = tmp('ok');
    const dest = path.join(d, 'bin', 'ffmpeg.exe');
    fakeExe(dest);
    const src = fakeExe(path.join(d, 'src', 'ffmpeg.exe'));
    const r = await ENV.placeTool(src, dest, runOk);
    assert.equal(r.ok, true);
    assert.equal(r.version, '7.1-full_build', '版本要从 -version 的输出里读出来');
    assert.ok(r.backup && fs.existsSync(r.backup), '旧文件要留备份');
    assert.equal(fs.existsSync(path.join(d, 'src', 'ffmpeg.exe')), true, '源文件（zip 解出来的）保留是对的');
  });
});

describe('在包结构里找 ffmpeg / ffprobe（上游层级不固定）', () => {
  test('多层子目录下的 bin/ 也要找得到；缺一个要能看出来', () => {
    const d = tmp('find');
    fakeExe(path.join(d, 'ffmpeg-master-latest-win64-gpl', 'bin', 'ffmpeg.exe'));
    fakeExe(path.join(d, 'ffmpeg-master-latest-win64-gpl', 'bin', 'ffprobe.exe'));
    const found = ENV.findTools(d);
    assert.ok(found.ffmpeg && found.ffprobe, '要能穿透多层目录');
    const empty = ENV.findTools(tmp('empty'));
    assert.equal(empty.ffmpeg, null);
    assert.equal(empty.ffprobe, null, '只有一半时也要能发现（安装时据此报错）');
  });
});

describe('一键配好：整条链（假下载 / 假解压）', () => {
  test('下载→校验→解压→落位，两个 exe 一起装好', async () => {
    const d = tmp('chain');
    const dest = path.join(d, 'bin');
    /* 假解压：按**传进来的** to 落文件（不能自己另挑目录 —— 那样测的是假象不是实现） */
    const extract = (zip, to) => {
      fakeExe(path.join(to, 'ffmpeg-master-latest-win64-gpl', 'bin', 'ffmpeg.exe'));
      fakeExe(path.join(to, 'ffmpeg-master-latest-win64-gpl', 'bin', 'ffprobe.exe'));
      return Promise.resolve({ ok: true });
    };
    const r = await ENV.installFfmpeg({}, {
      installDir: dest,
      deps: {
        tmpDir: path.join(d, 'tmp'),
        /* 假下载：造一个带 PK 头的文件（真实走 net-proxy.js 的隧道） */
        fetchTo: (url, destPath) => {
          fakeZip(destPath + '.part-1');
          return Promise.resolve({ ok: true, tmp: destPath + '.part-1', bytes: 1024 });
        },
        extract: extract,
        runTool: runOk
      }
    });
    assert.equal(r.ok, true, '失败原因：' + r.error);
    assert.deepEqual(r.versions, ['7.1-full_build', '7.1-full_build'], 'ffmpeg 与 ffprobe 都要装、都要报版本');
    assert.equal(fs.existsSync(path.join(dest, 'ffmpeg.exe')), true);
    assert.equal(fs.existsSync(path.join(dest, 'ffprobe.exe')), true);
  });

  test('上游给了错误页：整条链停在校验这一步，不落任何文件', async () => {
    const d = tmp('badzip');
    const dest = path.join(d, 'bin');
    const r = await ENV.installFfmpeg({}, {
      installDir: dest,
      deps: {
        tmpDir: path.join(d, 'tmp'),
        fetchTo: (url, destPath) => {
          fs.writeFileSync(destPath + '.part-1', '<html>rate limited</html>');
          return Promise.resolve({ ok: true, tmp: destPath + '.part-1', bytes: 22 });
        },
        extract: () => { throw new Error('不该走到解压'); },
        runTool: runOk
      }
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /不是 ZIP/);
    assert.equal(fs.existsSync(path.join(dest, 'ffmpeg.exe')), false, '不能落位');
  });

  test('包结构变了（找不到 exe）：报错要指出是上游结构变了，不是让用户看不懂的 ENOENT', async () => {
    const d = tmp('nostruct');
    const r = await ENV.installFfmpeg({}, {
      installDir: path.join(d, 'bin'),
      deps: {
        tmpDir: path.join(d, 'tmp'),
        fetchTo: (url, destPath) => { fakeZip(destPath + '.part-1'); return Promise.resolve({ ok: true, tmp: destPath + '.part-1' }); },
        extract: (zip, to) => { fs.mkdirSync(to, { recursive: true }); return Promise.resolve({ ok: true }); },
        runTool: runOk
      }
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /没有找到/, '要说清是包里没这两个文件：' + r.error);
  });

  test('安装进度要能被轮询到（前端要靠它显示百分比）', async () => {
    const d = tmp('prog');
    const seen = [];
    const r = await ENV.installComponent({}, 'ffmpeg', {
      installDir: path.join(d, 'bin'),
      /* onStep 在 opts 顶层（与 deps 平级）—— deps 只装"可注入的外部依赖" */
      onStep: (m) => seen.push(m),
      deps: {
        tmpDir: path.join(d, 'tmp'),
        fetchTo: (url, destPath, onProgress) => {
          fakeZip(destPath + '.part-1');
          if (onProgress) { onProgress(50, 100); onProgress(100, 100); }
          return Promise.resolve({ ok: true, tmp: destPath + '.part-1' });
        },
        extract: (zip, to) => {
          fakeExe(path.join(to, 'bin', 'ffmpeg.exe'));
          fakeExe(path.join(to, 'bin', 'ffprobe.exe'));
          return Promise.resolve({ ok: true });
        },
        runTool: runOk
      }
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(seen.length >= 3, true, '步骤要能逐步上报：' + JSON.stringify(seen));
    assert.match(seen.join(' | '), /下载完成/);
    assert.match(seen.join(' | '), /完成/);
    /* 结束后 active 必须清掉 —— 否则界面永远停在"正在安装" */
    const p = ENV.progressOf();
    assert.equal(!p || p.active === false, true, '装完要清 active');
  });
});

describe('环境体检：服务层能真的跑起来（0.48.1 回归）', () => {
  test('S.envReport 不许抛 —— 缺一个 require 就够首启向导报「服务内部错误」', async () => {
    /* 2026-10-05 真实故障：envReport 里写了 `runtime.getDataDir()`，而 services.js
       **漏了** runtime 模块的 require（写成字面量会被 lint §4 的正则当成真 require 扫，
       所以这里不写出来）→ ReferenceError → 500「检测失败：服务内部错误」。
       为什么没被别的测试挡住：本仓库**业务失败也返回 HTTP 200**，错误码在响应信封的
       `code` 里 —— 冒烟日志那条 `env?probe=1=200` 是假绿；而单测此前只测了
       env-setup.js 本身，**没让 services 这层真的调一次**。
       所以这条用例的价值就在于：把整条调用真跑一遍。 */
    const os2 = require('node:os');
    const prev = process.env.JC_DATA_DIR;
    process.env.JC_DATA_DIR = os2.tmpdir();
    let S;
    try { S = require('../server/services'); }
    finally { if (prev === undefined) delete process.env.JC_DATA_DIR; else process.env.JC_DATA_DIR = prev; }
    const r = await S.envReport(null, false);
    assert.equal(Array.isArray(r.items), true, '要真的返回体检结果');
    assert.equal(r.items.length >= 5, true, '五项体检一个都不能少');
    const dataDir = r.items.find((i) => i.id === 'dataDir');
    assert.ok(dataDir, '数据目录那项必须在（它就是踩到缺 require 的那处）');
    assert.equal(dataDir.ok, true, '临时目录应当可写：' + dataDir.detail);
    assert.equal(typeof r.summary.fixable, 'number');
  });
});

describe('代理判定（长下载必须能走系统代理）', () => {
  const withEnv = (env, fn) => {
    const keys = Object.keys(env);
    const old = {};
    keys.forEach((k) => { old[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; });
    try { return fn(); } finally { keys.forEach((k) => { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }); }
  };

  test('https 目标走 HTTPS_PROXY；本机地址直连；NO_PROXY 生效', () => {
    withEnv({ HTTPS_PROXY: 'http://127.0.0.1:11304', HTTP_PROXY: 'http://127.0.0.1:11304', NO_PROXY: 'localhost,127.0.0.1,::1' }, () => {
      const p = NP.proxyFor('https://github.com/x/y.zip');
      assert.ok(p, 'GitHub 这种外网目标必须走代理（直连会被掐断）');
      assert.equal(p.host, '127.0.0.1');
      assert.equal(p.port, 11304);
      assert.equal(NP.proxyFor('http://127.0.0.1:8788/api/v1'), null, '本机直连');
      assert.equal(NP.proxyFor('https://localhost:8787/'), null);
    });
    withEnv({ HTTPS_PROXY: 'http://127.0.0.1:11304', NO_PROXY: 'example.com' }, () => {
      assert.equal(NP.proxyFor('https://api.example.com/v1'), null, 'NO_PROXY 要生效');
      assert.ok(NP.proxyFor('https://github.com/x'), '不在 NO_PROXY 里的照走代理');
    });
    withEnv({ HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '' }, () => {
      assert.equal(NP.proxyFor('https://github.com/x'), null, '没有代理就直连（不能瞎猜）');
    });
  });

  test('代理 URL 里带 user:pass 时生成 Basic 认证头', () => {
    withEnv({ HTTPS_PROXY: 'http://u:p@127.0.0.1:8080' }, () => {
      const p = NP.proxyFor('https://github.com/x');
      assert.equal(p.auth, 'u:p');
    });
  });
});
