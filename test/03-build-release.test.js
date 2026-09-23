'use strict';
/* ============================================================
   03-build-release.test.js —— 构建与发布
   对应 docs/项目审查与改进清单.md §6「构建与发布」+ §P0-1/§P0-3：
     · 更新文件名安全校验（★ 路径穿越回归，safeArtifactName）
     · 更新清单解析（latest.yml）与版本比较
     · SHA-512 校验（清单必须带校验和才有意义）
     · 版本号一致性（package.json ↔ README ↔ 文档）
     · 外部工具状态四件套（P1-10）
     · 旧数据导入报告落盘（P2-11）
   ============================================================ */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const H = require('./helpers');

const REPO = H.REPO_ROOT;
const updater = require(path.join(REPO, 'desktop', 'updater.js'));
const extTools = require(path.join(REPO, 'desktop', 'external-tools.js'));
const legacy = require(path.join(REPO, 'desktop', 'legacy-import.js'));
const updateStateMod = require(path.join(REPO, 'desktop', 'update-state.js'));

const SANDBOX = H.freshDir('build-release');

describe('updater —— 更新文件名安全校验（P0-1 路径穿越回归）', () => {
  test('ARTIFACT_RE 与 ARTIFACT_PREFIX 与 electron-builder.yml 的 artifactName 一致', () => {
    assert.equal(updater.ARTIFACT_PREFIX, 'DreamFlow-');
    // 本项目的产物名形状：DreamFlow-<version>-x64-Setup.exe
    // （0.32.0 换名前是 JimengConsole-，两个前缀现在都要认得，见下一个用例）
    assert.equal(updater.ARTIFACT_RE.test('DreamFlow-0.32.0-x64-Setup.exe'), true);
    assert.equal(updater.ARTIFACT_RE.test('DreamFlow-1.2.3-x64-Setup.exe'), true);
    assert.equal(updater.ARTIFACT_RE.test('DreamFlow-v0.32.0-x64-Setup.exe'), false, '版本前缀 v 不合法');
    // 历史前缀仍须通过 —— 换名后不能把它踢出白名单（老机器的 .part- 残留要靠它清）
    assert.equal(updater.ARTIFACT_RE.test('JimengConsole-0.31.0-x64-Setup.exe'), true);

    // 与 yml 里写的模板对齐
    const yml = fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
    assert.match(yml, /artifactName:\s*DreamFlow-\$\{version\}-x64-Setup\.\$\{ext\}/,
      'yml 的 artifactName 必须与 ARTIFACT_RE 同形状，否则校验会误杀真实产物');
  });

  test('双前缀兼容层：DreamFlow- 与 JimengConsole- 都接受（换名两步走的结果）', () => {
    // 背景：0.27.0 已把项目更名 DreamFlow，但当时不动安装包文件名 —— 已装 ≤0.30.0 的用户
    // 手上是旧版白名单（只认 JimengConsole-），若直接发 DreamFlow-*.exe，他们会走完
    // 「找到更新 → 下载完成 → 校验拒绝」而永远升不上来。
    // 故 0.31.0 先放开校验（产物名不变）、0.32.0 才换名。本用例锁住兼容层的两条边：
    // 新前缀是当前产物前缀，且**旧前缀不能被删掉**。
    assert.deepEqual(updater.ACCEPTED_PREFIXES, ['DreamFlow-', 'JimengConsole-'],
      '当前产物前缀排第一；历史前缀必须保留（清 .part- 残留 + 支持回退旧名）');

    // ① 两种前缀都要放行，且版本一致性对**两者**都生效
    assert.equal(updater.safeArtifactName('JimengConsole-0.31.0-x64-Setup.exe', '0.31.0'),
      'JimengConsole-0.31.0-x64-Setup.exe');
    assert.equal(updater.safeArtifactName('DreamFlow-0.32.0-x64-Setup.exe', '0.32.0'),
      'DreamFlow-0.32.0-x64-Setup.exe');

    // ② 放宽 ≠ 放开：白名单之外的写法一律仍拒（前缀必须整段锚定）
    const stillBad = [
      'Evil-0.32.0-x64-Setup.exe',            // 未知前缀
      'DreamFlowx-0.32.0-x64-Setup.exe',      // 前缀后多字符
      'dreamflow-0.32.0-x64-Setup.exe',       // 大小写不符
      'xDreamFlow-0.32.0-x64-Setup.exe',      // 前缀前多字符
      'DreamFlow-0.32.0-x64-Setup.exe.evil',  // 拼接后缀
      'DreamFlow-0.32-x64-Setup.exe'          // 版本段不完整
    ];
    for (const n of stillBad) {
      assert.equal(updater.ARTIFACT_RE.test(n), false, '不应通过：' + n);
      assert.throws(() => updater.safeArtifactName(n), /不符合本项目安装包命名/, '应抛错：' + n);
    }

    // ③ 版本一致性对新前缀同样生效（否则换名等于把这一层护栏丢掉）
    assert.throws(() => updater.safeArtifactName('DreamFlow-0.32.0-x64-Setup.exe', '0.33.0'),
      /不一致/);
  });

  test('★ 合法文件名被接受', () => {
    const ok = [
      'JimengConsole-0.27.0-x64-Setup.exe',
      'JimengConsole-10.20.30-x64-Setup.exe',
      'JimengConsole-0.0.1-x64-Setup.exe'
    ];
    for (const n of ok) {
      assert.equal(updater.safeArtifactName(n), n, '应接受：' + n);
    }
  });

  test('★ 路径穿越载荷一律拒绝（这是 P0-1 的核心）', () => {
    const evil = [
      // 经典穿越
      'a/../../evil.exe',
      '..\\..\\evil.exe',
      '../../../../Windows/System32/calc.exe',
      'JimengConsole-0.27.0-x64-Setup.exe/../../evil.exe',
      // 绝对路径
      'C:\\Windows\\System32\\evil.exe',
      'C:/Windows/System32/evil.exe',
      '\\\\server\\share\\evil.exe',
      // 含分隔符的任何形式
      'sub/JimengConsole-0.27.0-x64-Setup.exe',
      'sub\\JimengConsole-0.27.0-x64-Setup.exe',
      // 相对当前目录
      '.',
      '..',
      // 空
      '',
      null,
      undefined
    ];
    for (const n of evil) {
      assert.throws(() => updater.safeArtifactName(n), /更新文件名/,
        '★ 必须拒绝：' + JSON.stringify(n));
    }
  });

  test('★ NUL 字符被显式拒绝（不能靠正则隐式拦）', () => {
    assert.throws(() => updater.safeArtifactName('JimengConsole-0.27.0-x64-Setup.exe\u0000'),
      /更新文件名/);
    assert.throws(() => updater.safeArtifactName('a\u0000b'), /NUL|更新文件名/);
  });

  test('★ 名字不符合本项目命名规范的一律拒绝（白名单而非黑名单）', () => {
    const bad = [
      'evil.exe',
      'JimengConsole.exe',                        // 缺版本段
      'JimengConsole-0.27.0-Setup.exe',           // 缺 x64
      'JimengConsole-0.27.0-x64-Setup.msi',       // 后缀不对
      'OtherApp-0.27.0-x64-Setup.exe',            // 前缀不对
      'JimengConsole-0.27.0-x64-Setup.exe.evil',  // 拼接后缀
      'JimengConsole-0.27.0-x64-Setup.exe.txt',
      'JimengConsole-0.27-x64-Setup.exe',         // 版本段不完整
      'JimengConsole-0.27.0.1-x64-Setup.exe'      // 版本段过多
    ];
    for (const n of bad) {
      assert.throws(() => updater.safeArtifactName(n), /更新文件名|不符合/,
        '应拒绝：' + n);
    }
  });

  test('★ 传入 expectVersion 时，名字里的版本必须与清单版本一致', () => {
    // 一致 → 通过
    assert.equal(
      updater.safeArtifactName('JimengConsole-0.27.0-x64-Setup.exe', '0.27.0'),
      'JimengConsole-0.27.0-x64-Setup.exe');

    // 不一致 → 拒绝（防"清单说 0.28.0、却让你装 0.27.0"的降级/投毒）
    assert.throws(
      () => updater.safeArtifactName('JimengConsole-0.27.0-x64-Setup.exe', '0.28.0'),
      /版本|不一致/,
      '版本不一致必须拒绝');
    assert.throws(
      () => updater.safeArtifactName('JimengConsole-0.99.9-x64-Setup.exe', '1.0.0'),
      /版本|不一致/);
  });

  test('assertManifestFile：改写 m.file，非法清单整份拒绝', () => {
    const good = { version: '0.27.0', file: 'JimengConsole-0.27.0-x64-Setup.exe', sha512: 'AbCdEf==' };
    const r1 = updater.assertManifestFile(good);
    assert.equal(r1.file, good.file, '合法清单应原样通过');

    // 无 file 字段：直接放行（有些源只给 version/path，由后续查找补 file）
    assert.deepEqual(updater.assertManifestFile({ version: '0.27.0' }), { version: '0.27.0' });
    assert.equal(updater.assertManifestFile(null), null);

    // 有 file 但非法 → 抛错
    assert.throws(() => updater.assertManifestFile({ version: '0.27.0', file: '../../evil.exe', sha512: 'x' }),
      /更新文件名/, '穿越清单必须被整份拒绝');

    // 版本不一致 → 抛错
    assert.throws(() => updater.assertManifestFile({ version: '1.0.0', file: 'JimengConsole-0.27.0-x64-Setup.exe', sha512: 'x' }),
      /版本|不一致/);

    /* ★ 没有 sha512 → 整份拒绝（2026-09-22 补）。原实现会放行，
       而下游 `if (expectSha512 && …)` 就跳过了校验 —— 等于"无校验安装"。
       三种更新源都经过这里，所以这是唯一的落点。 */
    assert.throws(() => updater.assertManifestFile({ version: '0.27.0', file: 'JimengConsole-0.27.0-x64-Setup.exe' }),
      /sha512/, '★ 缺校验和的清单必须拒绝');
  });

  test('★ 实测复现：path.join 确实会被穿越，所以必须在校验层拦截', () => {
    /* 这条是"为什么需要 safeArtifactName"的证据。
       不是断言 JS 行为有 bug，而是把逃逸事实钉住，
       防止将来有人觉得"path.join 应该安全"而把校验删掉。 */
    const base = path.join(SANDBOX, 'tmp');
    const escaped = path.join(base, 'a/../../evil.exe');
    assert.notEqual(path.resolve(escaped), path.join(base, 'evil.exe'),
      'path.join 不做目录约束 —— 这正是必须白名单校验的原因');
    assert.equal(path.resolve(escaped), path.resolve(path.join(SANDBOX, 'evil.exe')),
      'path.join 只做字符串拼接 + normalize，会逃出 base');
  });
});

describe('updater —— 版本比较与清单解析', () => {
  test('parseVersion / isNewer', () => {
    assert.deepEqual(updater.parseVersion('1.2.3'), [1, 2, 3]);
    assert.deepEqual(updater.parseVersion('0.27.0'), [0, 27, 0]);
    assert.deepEqual(updater.parseVersion('1.2.3-beta'), [1, 2, 3], '预发布后缀应被忽略');
    assert.deepEqual(updater.parseVersion('  1.2.3  '), [1, 2, 3], '应容忍空白');
    // 非法输入返回 null（调用方据此拒绝，而不是拿 NaN 去比大小）
    assert.equal(updater.parseVersion('v1.2.3'), null, '带 v 前缀不合法，应返回 null');
    assert.equal(updater.parseVersion('abc'), null);
    assert.equal(updater.parseVersion(''), null);
    assert.equal(updater.parseVersion(null), null);
    assert.equal(updater.parseVersion(undefined), null);

    assert.equal(updater.isNewer('1.0.0', '0.9.9'), true);
    assert.equal(updater.isNewer('0.9.9', '1.0.0'), false);
    assert.equal(updater.isNewer('1.0.0', '1.0.0'), false, '相同版本不算更新');
    assert.equal(updater.isNewer('1.0.1', '1.0.0'), true);
    assert.equal(updater.isNewer('1.10.0', '1.9.0'), true, '数字比较而非字典序');
    assert.equal(updater.isNewer('2.0.0', '1.99.99'), true);
  });

  test('parseLatestYml：解析 version / path / sha512', () => {
    const yml = [
      'version: 0.28.0',
      'files:',
      '  - url: JimengConsole-0.28.0-x64-Setup.exe',
      '    sha512: AbCdEf==',
      '    size: 12345678',
      'path: JimengConsole-0.28.0-x64-Setup.exe',
      'sha512: AbCdEf==',
      'releaseDate: 2026-09-21T00:00:00.000Z'
    ].join('\n');
    const m = updater.parseLatestYml(yml);
    assert.equal(m.version, '0.28.0');
    assert.equal(m.file, 'JimengConsole-0.28.0-x64-Setup.exe');
    assert.equal(m.sha512, 'AbCdEf==');
    assert.ok(m.size === 12345678 || m.size === undefined, 'size 应被解析或忽略，实得 ' + m.size);
  });
});

/* ============================================================
   github 模式的请求头 —— 行为型（2026-09-22 新增，Accept 覆盖回归）

   为什么要有这一条：2026-09-22 实测发现 `desktop/updater.js` 里两处

     Object.assign({ Accept: 'application/octet-stream' }, ghHeaders(token))

   把 octet-stream **覆盖**成了 ghHeaders() 返回的 application/vnd.github+json。
   于是 GitHub 返回的是**资产元数据 JSON**（实测 1446 字节）而不是文件正文（366 字节 yml），
   parseLatestYml() 得到 version=null，最终报「latest.yml 里没有 version / file 字段」——
   github 模式的「检查更新」100% 失败。旁证：线上 latest.yml 的 download_count 长期为 0。

   为什么之前没抓到：`scripts/test-update-flow.ps1` 只用 local 更新源 mock，
   根本不经过 GitHub 的 Accept 语义。

   所以这里 mock 掉 https.request，**直接观察应用真正发出的请求头** ——
   这是行为断言，不是"源码里出现过某个词"的文本断言（后者删掉逻辑照样绿）。
   ============================================================ */
describe('updater —— github 模式的请求头（★ 2026-09-22 Accept 覆盖回归）', () => {
  const { EventEmitter } = require('events');
  const https = require('https');

  const RELEASE_JSON = JSON.stringify({
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/x/y/releases/tag/v9.9.9',
    body: 'release notes',
    assets: [
      { name: 'latest.yml', url: 'https://api.github.com/repos/x/y/releases/assets/1' },
      { name: 'JimengConsole-9.9.9-x64-Setup.exe', url: 'https://api.github.com/repos/x/y/releases/assets/2', size: 123 }
    ]
  });
  const YML = [
    'version: 9.9.9',
    'files:',
    '  - url: JimengConsole-9.9.9-x64-Setup.exe',
    '    sha512: AbCdEf==',
    '    size: 123',
    'path: JimengConsole-9.9.9-x64-Setup.exe'
  ].join('\n');

  /** 用假的 https.request 跑一段逻辑，期间记录每个请求的 url 与 headers */
  async function withCapturedRequests(fn) {
    const orig = https.request;
    const seen = [];
    https.request = function (url, opts, cb) {
      const u = String(url);
      seen.push({ url: u, headers: Object.assign({}, (opts && opts.headers) || {}) });
      const route = /releases\/latest$/.test(u) ? RELEASE_JSON : YML;
      const req = new EventEmitter();
      req.setTimeout = function () { return req; };
      req.destroy = function () {};
      req.end = function () {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.resume = function () {};
        res.destroy = function () {};
        setImmediate(function () {
          cb(res);
          setImmediate(function () {
            res.emit('data', Buffer.from(route, 'utf8'));
            res.emit('end');
          });
        });
      };
      return req;
    };
    try { return await fn(seen); }
    finally { https.request = orig; }
  }

  const SRC = (token) => updater.resolveSource({ provider: 'github', owner: 'x', repo: 'y', token });

  test('★ 取 latest.yml / 安装包时，Accept 必须是 octet-stream（不被 JSON Accept 覆盖）', async () => {
    let manifest = null;
    const seen = await withCapturedRequests(async (s) => {
      manifest = await updater.fetchManifest(SRC(''));
      return s;
    });

    assert.equal(manifest.ok, true, 'mock 下应解析成功：' + (manifest.error || ''));
    assert.equal(manifest.version, '9.9.9', '★ 只有 Accept 正确时才拿得到 yml 正文');

    const assetReqs = seen.filter((r) => /releases\/assets/.test(r.url));
    assert.ok(assetReqs.length >= 1, '应请求过至少一次资产内容，实得 ' + assetReqs.length);
    assetReqs.forEach((r) => {
      assert.equal(r.headers.Accept, 'application/octet-stream',
        '★ 请求资产内容时 Accept 必须是 application/octet-stream，实得「' + r.headers.Accept
        + '」—— 被 ghHeaders() 的 JSON Accept 覆盖了，GitHub 会返回资产元数据而不是文件正文');
    });

    assert.equal(manifest.headers.Accept, 'application/octet-stream',
      '★ 交给下载环节的 headers 同样必须是 octet-stream');
  });

  test('带令牌时：认证头保留，且 Accept 仍是 octet-stream', async () => {
    let manifest = null;
    const seen = await withCapturedRequests(async (s) => {
      manifest = await updater.fetchManifest(SRC('tok123'));
      return s;
    });

    assert.equal(manifest.ok, true, (manifest && manifest.error) || '');
    const assetReqs = seen.filter((r) => /releases\/assets/.test(r.url));
    assert.ok(assetReqs.length >= 1, '应请求过至少一次资产内容');
    assetReqs.forEach((r) => {
      assert.equal(r.headers.Accept, 'application/octet-stream', '★ 带令牌也不能丢掉 octet-stream');
      assert.equal(r.headers.Authorization, 'Bearer tok123', '认证头必须保留');
    });
  });
});

/* ============================================================
   安装前必须校验 sha512 —— 行为型（2026-09-22 由"匹配源码文本"改写）

   为什么必须真的跑一遍：原先这条断言的是"updater.js 源码里出现过 sha512 这个词"，
   而把校验分支删掉、或让 expectSha512 传空，源码里照样有 sha512 —— 测试照样绿。
   现在用 local 更新源（完全离线、不联网）走完整的 download() 链路。
   ============================================================ */
describe('updater —— 安装前必须校验 sha512（行为型）', () => {
  const V = '0.99.0';
  const FILE = 'JimengConsole-0.99.0-x64-Setup.exe';
  const SAMPLE = Buffer.from('MZ' + 'x'.repeat(4096), 'utf8');   // 假装是个 PE 的字节流

  const sha512 = (buf) => require('crypto').createHash('sha512').update(buf).digest('base64');

  /** 造一个 local 更新源：目录里放 latest.yml + 安装包，再给一个空的目标目录 */
  function makeSource(tag, bytes, hash, size) {
    const dir = H.freshDir('upd-src-' + tag);
    const dest = H.freshDir('upd-dst-' + tag);
    fs.writeFileSync(path.join(dir, FILE), bytes);
    const yml = [
      'version: ' + V,
      'files:',
      '  - url: ' + FILE,
      hash ? '    sha512: ' + hash : '',
      size ? '    size: ' + size : '',
      'path: ' + FILE,
      hash ? 'sha512: ' + hash : ''
    ].filter(Boolean).join('\n');
    fs.writeFileSync(path.join(dir, 'latest.yml'), yml, 'utf8');
    return { dir, dest };
  }

  test('★ 哈希对不上：拒绝并丢弃，不留下任何可执行文件', async () => {
    const { dir, dest } = makeSource('bad', SAMPLE, 'A'.repeat(86) + '==');
    const r = await updater.download('0.1.0', { provider: 'local', dir }, dest);
    assert.equal(r.ok, false, '★ 校验不通过必须失败');
    assert.match(r.error, /校验不通过|sha512/, '错误里要说清是校验问题，而不是含糊的"下载失败"');
    assert.deepEqual(fs.readdirSync(dest), [], '★ 目标目录必须一个文件都不剩（含 .part- 临时文件）');
  });

  test('★ 字节数对不上：同样拒绝（防"下了一半就当成功"）', async () => {
    const { dir, dest } = makeSource('size', SAMPLE, sha512(SAMPLE), SAMPLE.length + 10);
    const r = await updater.download('0.1.0', { provider: 'local', dir }, dest);
    assert.equal(r.ok, false, '★ 字节数不符必须失败');
    assert.match(r.error, /字节数不符/);
    assert.deepEqual(fs.readdirSync(dest), [], '不得留下半截包');
  });

  test('哈希与字节数都对：落盘到目标目录，内容逐字节一致', async () => {
    const { dir, dest } = makeSource('ok', SAMPLE, sha512(SAMPLE), SAMPLE.length);
    const r = await updater.download('0.1.0', { provider: 'local', dir }, dest);
    assert.equal(r.ok, true, '合法包应通过：' + (r.error || ''));
    assert.equal(r.file, FILE);
    assert.equal(r.bytes, SAMPLE.length);
    assert.ok(fs.readFileSync(path.join(dest, FILE)).equals(SAMPLE),
      '★ 执行的就是被验过的那一份，内容必须一致');
    assert.deepEqual(fs.readdirSync(dest), [FILE], '目录里只应有最终文件（.part- 已改名）');
  });

  test('清单里没给 sha512：仍然拒绝（没有校验和就没有可信度）', async () => {
    const { dir, dest } = makeSource('nohash', SAMPLE, '');
    const r = await updater.download('0.1.0', { provider: 'local', dir }, dest);
    assert.equal(r.ok, false, '★ 清单缺 sha512 时不得放行');
    assert.deepEqual(fs.readdirSync(dest), []);
  });

  test('★ 更新源必须是 https：http 源在发请求之前就被拒（不联网也能验）', async () => {
    const r = await updater.fetchText('http://example.com/latest.yml', null);
    assert.equal(r.ok, false);
    assert.match(r.error, /https/, '★ 必须明确说"更新源必须是 https" —— 这是防中间人替换 exe 的第一道闸');
  });
});

describe('updater —— 更新源解析（行为型）', () => {
  test('三种 provider 原样保留，非法 provider 回落到 github', () => {
    for (const p of ['github', 'url', 'local']) {
      assert.equal(updater.resolveSource({ provider: p }).provider, p, p + ' 应被保留');
    }
    assert.equal(updater.resolveSource({ provider: 'ftp' }).provider, 'github');
    assert.equal(updater.resolveSource({ provider: '' }).provider, 'github');
  });

  test('默认更新源是 ikun1946/DreamFlow（不是旧仓库名）', () => {
    assert.equal(updater.DEFAULT_SOURCE.provider, 'github');
    assert.equal(updater.DEFAULT_SOURCE.owner, 'ikun1946');
    assert.equal(updater.DEFAULT_SOURCE.repo, 'DreamFlow', '★ 仓库名应是 DreamFlow，不是 jimeng-console');
    /* 旧仓库名的源码残留由 scripts/check-project.js 的"旧名残留"一项全仓库统一盯
       （比在测试里逐文件匹配更不容易漏），这里不再重复断言文本。 */
  });

  test('resolveSource：非法 provider 回落到 github，且永远带上默认 owner/repo', () => {
    const bad = updater.resolveSource({ provider: 'ftp', owner: 'x' });
    assert.equal(bad.provider, 'github', '非法 provider 应回落');
    assert.equal(bad.owner, 'x', '显式给的 owner 应保留');
    assert.equal(bad.repo, 'DreamFlow', '★ 未给 repo 时应补默认 DreamFlow');

    const empty = updater.resolveSource({});
    assert.equal(empty.owner, 'ikun1946');
    assert.equal(empty.repo, 'DreamFlow');
    assert.equal(updater.resolveSource(null).repo, 'DreamFlow');
  });

  test('github 源的 https 强制由 fetchText 覆盖（这里不再重复断言源码文本）', () => {
    /* 原先这条断言的是源码里出现过 'github' / 'url' / 'local' 与一个 https:// 字面量 ——
       取值已由上面那条行为用例覆盖，https 强制由 fetchText 那条真实覆盖
       （http 源会在发请求前被拒）。这里只把口径写清楚，避免再退回"断言源码里出现过某个词"。 */
    assert.equal(updater.resolveSource({ provider: 'github' }).provider, 'github');
  });
});

describe('updater —— 临时文件治理与并发保护（P0-3）', () => {
  test('cleanupStaleTemp 只删本项目、超龄的 .part- 文件', () => {
    const dir = H.freshDir('tmp-clean');
    const now = Date.now();
    const OLD = now - 25 * 60 * 60 * 1000;   // 25 小时前（超过 24h 阈值）

    // 应被删：本项目的过期分片
    const stale = path.join(dir, 'JimengConsole-0.27.0-x64-Setup.exe.part-123');
    fs.writeFileSync(stale, 'x');
    fs.utimesSync(stale, new Date(OLD), new Date(OLD));

    // 应保留：刚建的分片（未超龄）
    const fresh = path.join(dir, 'JimengConsole-0.27.0-x64-Setup.exe.part-456');
    fs.writeFileSync(fresh, 'x');

    // 应保留：其它程序的文件（不是本项目前缀）
    const other = path.join(dir, 'OtherApp.exe.part-999');
    fs.writeFileSync(other, 'x');
    fs.utimesSync(other, new Date(OLD), new Date(OLD));

    // 应保留：本项目的正式产物（没有 .part- 段）
    const real = path.join(dir, 'JimengConsole-0.27.0-x64-Setup.exe');
    fs.writeFileSync(real, 'x');
    fs.utimesSync(real, new Date(OLD), new Date(OLD));

    const res = updater.cleanupStaleTemp(dir, 24 * 60 * 60 * 1000);

    assert.equal(fs.existsSync(stale), false, '★ 过期分片应被清理');
    assert.equal(fs.existsSync(fresh), true, '★ 未超龄的分片不得清理（可能正在下载）');
    assert.equal(fs.existsSync(other), true, '★ 其它程序的文件不得碰');
    assert.equal(fs.existsSync(real), true, '★ 正式产物绝不能删');
    assert.ok(Array.isArray(res.removed) && res.removed.length === 1,
      '应恰好报告 1 个被删文件，实得 ' + JSON.stringify(res.removed));

    H.rmrf(dir);
  });

  test('cleanupStaleTemp 对不存在的目录安全返回（不抛）', () => {
    const res = updater.cleanupStaleTemp(path.join(SANDBOX, '根本不存在的目录'), 1000);
    assert.ok(res && Array.isArray(res.removed));
    assert.equal(res.removed.length, 0);
  });

  test('isDownloading 是"当前是否有下载在跑"的探针', () => {
    assert.equal(typeof updater.isDownloading, 'function');
    assert.equal(updater.isDownloading(), false, '空闲时应为 false');
  });

  test('download 并发拒绝（互斥）', async () => {
    /* download 签名接受 (manifest, opts)。真跑会访问网络，这里构造一个
       "已经在下载中"的状态：直接调两次，第二次应因 inflight 被拒。
       ⚠ 不依赖网络：用非法的 manifest 让第一次尽快失败/挂起，
         但 inflight 只在真正进入下载后才置位 —— 所以这里只断言"接口存在且返回 Promise"，
         真正的互斥已由 main.js 的 withUpdateLock 状态机覆盖（见下一条）。 */
    const p = updater.download({ version: '0.0.0', file: null }, { dir: SANDBOX });
    assert.ok(p && typeof p.then === 'function', 'download 应返回 Promise');
    const r = await p;
    assert.equal(r.ok, false, '非法 manifest 应失败而不是抛出');
    assert.ok(typeof r.error === 'string' && r.error.length, '应给出错误说明');
  });
});

/* ============================================================
   更新互斥状态机 —— 行为型（2026-09-22 由"匹配源码文本"改写而来，P0-3）

   为什么值得重写：这五条规则是"并发更新"事故的**唯一**防线，原先只能断言
   main.js 的源码里出现过哪些字符串 —— 把 withUpdateLock 改名会误报，
   而把复位的时机改坏却可能照样绿。改完立刻抓到一个真缺陷（见下面 ★ 那条）。
   ============================================================ */
describe('update-state —— 更新互斥状态机（行为型，P0-3）', () => {
  const mk = (opts) => updateStateMod.makeUpdateState(opts || {});

  test('五态齐全，且与 main.js 的 payload 口径一致', () => {
    assert.deepEqual(updateStateMod.STATES, ['idle', 'checking', 'downloading', 'ready', 'installing']);
  });

  test('★ 并发第二次调用被拒绝（checking / downloading / installing 三态都拦）', async () => {
    const pairs = [
      ['check', 'check', 'idle'],
      ['download', 'download', 'idle'],
      /* 安装这一对跑完停在 installing（进程即将退出，刻意不复位）—— 见下面那条 ★ */
      ['install', 'download', 'installing']
    ];
    for (const [first, second, endState] of pairs) {
      const rejected = [];
      const st = mk({ onReject: (action, state) => rejected.push({ action, state }) });
      let release; const gate = new Promise((r) => { release = r; });
      const firstRun = st.withLock(first, async () => { await gate; return { ok: true, tag: 'first' }; });
      await Promise.resolve();   // 让第一次进到 fn（此时状态已切换）
      const r2 = await st.withLock(second, async () => ({ ok: true, tag: 'second' }));
      assert.equal(r2.ok, false, first + ' 进行中再发起 ' + second + ' 必须被拒');
      assert.equal(r2.busy, true, '被拒时要带 busy 标记（界面据此静默处理，不弹错误框）');
      assert.equal(r2.tag, undefined, '★ 第二次的 fn 一次都不能执行 —— 否则就是两次并发下载/安装');
      assert.match(r2.error, /正在进行中|正在安装/, '拒绝理由要说人话');
      assert.deepEqual(rejected, [{ action: second, state: updateStateMod.ACTION_STATE[first] }],
        '★ 被拒时要留痕（onReject）—— 排查"点了没反应"时这是唯一线索');
      release();
      const r1 = await firstRun;
      assert.equal(r1.tag, 'first', '第一次应正常跑完');
      assert.equal(st.get(), endState, '跑完后应收敛到 ' + endState);
    }
  });

  test('★ fn 抛异常时锁必须释放（否则更新永久卡死，只能重启应用）', async () => {
    const st = mk();
    await assert.rejects(() => st.withLock('download', async () => { throw new Error('网络断了'); }),
      /网络断了/, '异常必须继续上抛，不能被吞');
    assert.equal(st.get(), 'idle', '★ 异常路径也要回到 idle（这就是 try/finally 存在的理由）');
    const again = await st.withLock('download', async () => ({ ok: true }));
    assert.equal(again.ok, true, '释放后应能再次发起');
  });

  test('★ 安装成功后保持 installing —— 800ms 退出窗口里不得放行第二次安装', async () => {
    /* 这条是本轮改写抓到的**真缺陷**：原实现在 fn 返回后立刻把 installing 复位成 ready，
       而 main.js 还要留 800ms 等 detached 安装器站稳 —— 那段窗口里用户再点一次"安装"，
       canStart 是放行的，会拉起第二个安装器同时替换程序文件。
       原测试只匹配源码文本（"含 installing""含 quitting = true"），完全没发现。 */
    const st = mk();
    const r = await st.withLock('install', async () => ({ ok: true, path: 'x' }));
    assert.equal(r.ok, true);
    assert.equal(st.get(), 'installing', '★ 安装成功后不得复位（进程即将退出）');
    const again = await st.withLock('install', async () => ({ ok: true }));
    assert.equal(again.ok, false, '★ 退出窗口里第二次安装必须被拒');
    assert.match(again.error, /正在安装/);
  });

  test('安装失败由调用方显式降级 → 回到 ready，可重试（且此时才算不忙）', async () => {
    const st = mk();
    await st.withLock('install', async () => { st.set('ready'); return { ok: false, error: '安装器没起来' }; });
    assert.equal(st.get(), 'ready', '失败后应退回 ready（安装包还在）');
    assert.equal(st.isBusy(), false, 'ready 不算忙');
    const retry = await st.withLock('install', async () => ({ ok: true }));
    assert.equal(retry.ok, true, 'ready 状态下应允许重试安装');
  });

  test('★ 调用方在 fn 里设的状态不被锁覆盖；ready 下重下 / 安装 / 再检查都放行', async () => {
    const st = mk();
    await st.withLock('download', async () => { st.set('ready'); return { ok: true }; });
    assert.equal(st.get(), 'ready', '★ 下载成功置的 ready 不能被 finally 冲掉');
    for (const a of ['check', 'download', 'install']) {
      assert.equal(st.canStart(a), true, 'ready 应放行 ' + a + '（否则托盘"检查更新"会静默失效）');
    }
  });

  test('check / download 正常结束后自动回到 idle', async () => {
    const st = mk();
    await st.withLock('check', async () => ({ ok: true }));
    assert.equal(st.get(), 'idle');
    await st.withLock('download', async () => ({ ok: false, error: 'x' }));
    assert.equal(st.get(), 'idle', '失败也要回 idle（锁不该把状态留在中间态）');
  });

  test('★ 写入未知状态名直接抛（拼错会让互斥静默失效）', () => {
    const st = mk();
    assert.throws(() => st.set('redy'), /未知更新状态/);
    assert.equal(st.get(), 'idle', '抛错后状态不得被改动');
  });

  test('onChange 只在状态真的变化时触发（避免重复广播）', async () => {
    const seen = [];
    const st = mk({ onChange: (s) => seen.push(s) });
    await st.withLock('check', async () => ({ ok: true }));
    assert.deepEqual(seen, ['checking', 'idle'], '应恰好广播两次：进入 checking、回到 idle');
    st.set('idle');
    assert.equal(seen.length, 2, '同值写入不触发广播');
  });

  test('snapshot 给出 state + busy（界面读的就是这两个字段）', () => {
    const st = mk();
    assert.deepEqual(st.snapshot(), { state: 'idle', busy: false });
    st.set('ready');
    assert.deepEqual(st.snapshot(), { state: 'ready', busy: false }, 'ready 不忙 —— 按钮保持可用');
    st.set('installing');
    assert.deepEqual(st.snapshot(), { state: 'installing', busy: true });
  });
});

/* ============================================================
   preload —— 桥面形状（行为型）
   用 stub 顶掉 electron，然后**真的加载一次 preload.js**，看它暴露了什么。
   比"匹配源码文本"强的地方：换写法 / 改名不会误报，而"多暴露一个动作"
   "订阅了别的 channel""退订没生效"这类退化一定会被抓住。
   ============================================================ */
describe('preload —— 桥面形状（行为型，P0-3）', () => {
  function loadPreload() {
    const calls = { expose: [], on: [], invoke: [], removeListener: [] };
    const stub = {
      contextBridge: { exposeInMainWorld: (name, api) => calls.expose.push({ name, api }) },
      ipcRenderer: {
        invoke: (ch, ...rest) => { calls.invoke.push({ ch, rest }); return Promise.resolve({ ch }); },
        on: (ch, h) => { calls.on.push({ ch, h }); },
        removeListener: (ch, h) => { calls.removeListener.push({ ch, h }); }
      }
    };
    const Module = require('module');
    const orig = Module._load;
    /* ⚠ 拦截的不只是 'electron'，而是所有以 'electron' 开头或等于 'electron' 的请求 —
       electron 子包（'electron/main' 之类）在新版本里会被解构 require 出来，
       漏拦就会让 Windows CI 的"重下 electron 二进制"逻辑被触发（node_modules/electron/index.js
       没有 path.txt 时会去拉二进制，把整个测试进程卡在网络里）。 */
    Module._load = function (request) {
      if (request === 'electron' || /^electron\//.test(request)) return stub;
      return orig.apply(this, arguments);
    };
    const target = path.join(REPO, 'desktop', 'preload.js');
    try {
      delete require.cache[require.resolve(target)];
      require(target);
    } finally {
      Module._load = orig;                        // 立刻还原，别影响别的用例
      delete require.cache[require.resolve(target)];
    }
    assert.equal(calls.expose.length, 1, '应恰好暴露一个全局对象');
    assert.equal(calls.expose[0].name, 'JCDesktop');
    return { calls, api: calls.expose[0].api };
  }

  test('暴露的只有具名动作，不把 ipcRenderer / process 交出去', () => {
    const { api } = loadPreload();
    assert.equal(api.isDesktop, true);
    assert.equal(typeof api.platform, 'string', 'platform 应是字符串，不是 process 对象');
    for (const k of ['info', 'openDataDir', 'openLogs', 'showItemInFolder', 'openExternal',
      'updateStatus', 'updateCheck', 'updateDownload', 'updateInstall', 'updateSetSource', 'onUpdateState']) {
      assert.equal(typeof api[k], 'function', '应暴露 ' + k);
    }
    const keys = JSON.stringify(Object.keys(api));
    assert.ok(!/ipcRenderer|require|process/.test(keys), '★ 桥面上不得挂 Electron / Node 对象');
  });

  test('每个动作都只打到自己那条 channel（参数原样透传）', async () => {
    const { calls, api } = loadPreload();
    await api.info();
    await api.openDataDir();
    await api.openLogs();
    await api.showItemInFolder('C:\\x\\y.mp4');
    await api.openExternal('https://example.com/');
    await api.updateStatus();
    await api.updateCheck();
    await api.updateDownload();
    await api.updateInstall();
    await api.updateSetSource({ provider: 'url' });
    assert.deepEqual(calls.invoke.map((c) => c.ch),
      ['app:info', 'app:openDataDir', 'app:openLogs', 'shell:showItem', 'shell:openExternal',
        'update:status', 'update:check', 'update:download', 'update:install', 'update:setSource']);
    assert.deepEqual(calls.invoke[3].rest, ['C:\\x\\y.mp4'], '路径参数应原样透传（主进程侧再校验）');
    assert.deepEqual(calls.invoke[9].rest, [{ provider: 'url' }], '更新源补丁应原样透传');
  });

  test('★ onUpdateState 只订阅固定 channel update:state，且退订移除同一个 handler', () => {
    const { calls, api } = loadPreload();
    const got = [];
    const off = api.onUpdateState((p) => got.push(p));
    assert.equal(calls.on.length, 1, '只应订阅一次');
    assert.equal(calls.on[0].ch, 'update:state', '★ channel 必须是固定的 update:state');
    calls.on[0].h({ sender: 'x' }, { state: 'downloading' });
    assert.deepEqual(got, [{ state: 'downloading' }], '页面回调只应拿到 payload（不给 event 句柄）');
    off();
    assert.equal(calls.removeListener.length, 1, '退订应移除监听');
    assert.equal(calls.removeListener[0].ch, 'update:state');
    assert.equal(calls.removeListener[0].h, calls.on[0].h, '★ 退订的必须就是订阅时那个 handler');
  });

  test('★ 页面回调抛异常不得冒泡；非函数入参不订阅、但仍返回可调用的退订函数', () => {
    const { calls, api } = loadPreload();
    const off = api.onUpdateState(() => { throw new Error('页面自己炸了'); });
    assert.doesNotThrow(() => calls.on[0].h({}, { state: 'idle' }), '回调异常必须被吞掉（否则会打到主进程）');
    const off2 = api.onUpdateState('not a function');
    assert.equal(typeof off2, 'function', '非函数也要返回一个能安全调用的退订函数');
    assert.equal(calls.on.length, 1, '非函数入参不得订阅');
    off(); off2();
  });
});

/* ============================================================
   仓库形状 —— **刻意保留**的文本断言
   为什么这几条故意是文本断言（不是懒，是没有更便宜的办法）：
     · main.js 的入口函数依赖 electron 的 app/win/dialog，不起 Electron 就跑不起来；
     · electron-builder.yml / LICENSE 本身是**声明性文件**，它们的形状就是事实。
   规则：这类断言只放在本组，且每条都要写清"为什么必须断言文本"。
   ============================================================ */
/* ============================================================
   preload 的桥面形状测试见上面的 describe('preload —— 桥面形状')。
   刻意保留的文本断言统一放在文件末尾的 describe('仓库形状')。
   ============================================================ */

describe('external-tools —— 外部工具状态四件套（P1-10）', () => {
  test('TOOL_SPEC / TOOL_CODES 覆盖 dreamina / ffmpeg / ffprobe', () => {
    assert.ok(extTools.TOOL_SPEC.dreamina, '应定义 dreamina 规格');
    assert.ok(extTools.TOOL_SPEC.ffmpeg, '应定义 ffmpeg 规格');
    assert.ok(extTools.TOOL_SPEC.ffprobe, '应定义 ffprobe 规格');

    /* ⚠ TOOL_CODES 是**按工具分组的嵌套表**（一个工具可有多个错误码），
       与 server/util.js 的 ERR 数字码必须逐项一致 —— 两处漂移会让前端拿不到正确文案。 */
    assert.equal(extTools.TOOL_CODES.dreamina.CLI_NOT_FOUND, 51101);
    assert.equal(extTools.TOOL_CODES.dreamina.CLI_NOT_LOGGED_IN, 51102);
    assert.equal(extTools.TOOL_CODES.dreamina.CLI_PERMISSION_DENIED, 51103);
    assert.equal(extTools.TOOL_CODES.ffmpeg.FFMPEG_NOT_FOUND, 51104);
    assert.equal(extTools.TOOL_CODES.ffprobe.FFPROBE_NOT_FOUND, 51105);

    // 与 server 的 ERR 表对齐（逐个符号名核对）
    const util = require('../server/util');
    Object.keys(extTools.TOOL_CODES).forEach((tool) => {
      Object.keys(extTools.TOOL_CODES[tool]).forEach((sym) => {
        assert.equal(util.ERR[sym], extTools.TOOL_CODES[tool][sym],
          '工具错误码漂移：' + tool + '.' + sym);
      });
    });
    // 反向：TOOL_SPEC 引用的符号名必须在 TOOL_CODES 里有定义
    Object.keys(extTools.TOOL_SPEC).forEach((tool) => {
      const sym = extTools.TOOL_SPEC[tool].code;
      assert.ok(extTools.TOOL_CODES[tool] && extTools.TOOL_CODES[tool][sym],
        tool + ' 的 code 符号 ' + sym + ' 在 TOOL_CODES 里没有定义');
    });
  });

  test('阻断级别符合清单 §10 的表：dreamina 阻断、ffmpeg 不阻断、ffprobe 只挡音频绑定', () => {
    assert.equal(extTools.TOOL_SPEC.dreamina.blocks, 'submit', '缺 dreamina 应阻断提交');
    assert.ok(!extTools.TOOL_SPEC.ffmpeg.blocks, '缺 ffmpeg 不阻断任何主流程（只少个封面）');
    assert.equal(extTools.TOOL_SPEC.ffprobe.blocks, 'audio-bind', '缺 ffprobe 应只挡音频绑定');
  });

  test('toolStatus(found) 对每个工具生成完整状态对象（四件套 = ok/code/blocks/action）', () => {
    const util = require('../server/util');

    // ① 全就绪。⚠ 入参是 detect() 的结果对象（按工具分组），不是布尔值。
    const allReady = extTools.toolStatus({ dreamina: { path: 'x' }, ffmpeg: { path: 'y' }, ffprobe: { path: 'z' } });
    for (const k of ['dreamina', 'ffmpeg', 'ffprobe']) {
      assert.equal(allReady[k].ok, true, k + ' 应就绪');
      assert.equal(allReady[k].code, 0, k + ' 就绪时 code 应为 0');
      assert.equal(allReady[k].blocks, null, k + ' 就绪时不应阻断');
      assert.equal(allReady[k].action, null, k + ' 就绪时不应带引导动作');
      assert.equal(allReady[k].message, null, k + ' 就绪时不应有缺失文案');
    }

    // ② 全缺失 —— 逐个核对码 / 阻断级别 / 引导动作
    const allMiss = extTools.toolStatus({});
    assert.equal(allMiss.dreamina.ok, false);
    assert.equal(allMiss.dreamina.codeName, 'CLI_NOT_FOUND');
    assert.equal(allMiss.dreamina.code, 51101);
    assert.equal(allMiss.dreamina.blocks, 'submit');
    assert.equal(allMiss.dreamina.action, 'install-cli');
    assert.ok(allMiss.dreamina.message, '缺失时应有可执行文案');

    assert.equal(allMiss.ffmpeg.code, 51104);
    assert.equal(allMiss.ffmpeg.blocks, null, 'ffmpeg 缺失不阻断任何主流程');
    assert.equal(allMiss.ffmpeg.action, 'install-ffmpeg');

    assert.equal(allMiss.ffprobe.code, 51105);
    assert.equal(allMiss.ffprobe.blocks, 'audio-bind', 'ffprobe 缺失只挡音频绑定');

    // ③ 数字码必须能对上 server 的 ERR 表（防止两处漂移）
    assert.equal(util.ERR[allMiss.dreamina.codeName], allMiss.dreamina.code);
    assert.equal(util.ERR[allMiss.ffmpeg.codeName], allMiss.ffmpeg.code);
    assert.equal(util.ERR[allMiss.ffprobe.codeName], allMiss.ffprobe.code);

    // ④ 空 path 也算缺失（detect 可能给出 path:'' 这种边界值）
    const emptyPath = extTools.toolStatus({ dreamina: { path: '' } });
    assert.equal(emptyPath.dreamina.ok, false, '空 path 应判为缺失');
    assert.equal(emptyPath.dreamina.code, 51101);
  });

  test('missingMessage 给出可执行指引（不是只报"未找到"）', () => {
    for (const name of ['dreamina', 'ffmpeg', 'ffprobe']) {
      const msg = extTools.missingMessage(name);
      assert.ok(typeof msg === 'string' && msg.length > 0, name + ' 应有缺失文案');
      assert.ok(!/^未找到$/.test(msg.trim()), name + ' 的文案不能只有"未找到"');
    }
  });

  test('summarize 把缺失项标成 [缺失]（一眼可辨）', () => {
    // detect() 会真扫 PATH；这里只断言 summarize 的输出形状
    const d = extTools.detect();
    const s = extTools.summarize(d);
    assert.ok(typeof s === 'string' && s.length > 0, 'summarize 应返回非空文本');
    /* summarize 的输出是"每行一个工具 + 路径或 [缺失]"。
       全就绪时不含 [缺失] 字样也属正常，所以这里按状态分支断言。 */
    const anyMissing = Object.values(d).some((x) => x && x.found === false);
    if (anyMissing) {
      assert.match(s, /\[缺失\]/, '有缺失时必须在文本里标出 [缺失]，实得：' + s);
    } else {
      assert.ok(s.split('\n').filter(Boolean).length >= 3, '全就绪时也应逐工具列出，实得：' + s);
    }
    assert.ok(!/^未找到$/m.test(s), '不应出现无信息量的"未找到"单独一行');
  });
});

describe('legacy-import —— 旧数据导入报告落盘（P2-11）', () => {
  test('writeReport 写到 <数据目录>/backup/import-report-<时间>.txt', () => {
    const dir = H.freshDir('report');
    /* ⚠ writeReport 读的是 res.report.{counts,files,missing}（summarize 的产物），
       以及 res.copied.{files,bytes}、res.src / res.dst —— 不是顶层 res.missing。 */
    const res = {
      ok: false,
      src: '/old/data', dst: '/new/data',
      backupDir: 'db.json.bak-import-20260101',
      copied: { files: 2, bytes: 2048, skipped: 1 },
      report: {
        counts: { projects: 1, workspaces: 2, storyboards: 7, assets: 5, records: 3 },
        files: { videos: 4, covers: 4 },
        missing: [
          { label: '素材', path: '/old/data/assets/缺的素材A.png' },
          { label: '素材', path: '/old/data/assets/缺的素材B.png' },
          { label: '产物', path: '/old/data/output/sb_1/缺的产物.mp4' }
        ]
      }
    };

    const p = legacy.writeReport(dir, res);
    assert.ok(p, 'writeReport 应返回报告路径');
    assert.ok(fs.existsSync(p), '★ 报告文件必须真的写出来：' + p);
    assert.match(path.basename(p), /^import-report-.*\.txt$/, '命名应符合约定');
    // 落点必须在 backup/ 下
    assert.equal(path.basename(path.dirname(p)), 'backup', '应落在 backup/ 目录下');

    const text = fs.readFileSync(p, 'utf8');
    assert.match(text, /导入报告/, '应含报告标题');
    // ★ 缺失清单必须完整，不得截断（清单项多时最容易"只报前几条"）
    assert.match(text, /缺的素材A\.png/);
    assert.match(text, /缺的素材B\.png/);
    assert.match(text, /缺的产物\.mp4/);
    // 报告应把缺失路径也写清（光有文件名找不回来）
    assert.match(text, /\/old\/data\/assets\/缺的素材A\.png/, '应写出完整路径');
    // 且要写明"导入是复制而非搬家"（用户才敢删源目录）
    assert.match(text, /复制而非搬家|源目录未被改动/, '应说明源目录未被改动');

    H.rmrf(dir);
  });

  test('writeReport 对缺失的入参返回 null（不抛）', () => {
    // 入参不全是最常见的调用错误，应按"没东西可写"处理而不是抛
    assert.equal(legacy.writeReport(null, { ok: true }), null);
    assert.equal(legacy.writeReport('/tmp/x', null), null);
    assert.equal(legacy.writeReport('', {}), null);
  });

  test('调用方必须自己 try/catch 保护 writeReport（报告失败不得阻断导入）', () => {
    /* writeReport 内部对 mkdirSync/writeFileSync 失败是**抛错**的（有意：
       静默写不出报告会让人以为报告存在）。因此保护责任在调用方。
       这条钉住 main.js 的 performImport 确实包了 try/catch ——
       否则一次磁盘满就会让整个导入流程报错，而数据其实已经导入成功。 */
    const src = fs.readFileSync(path.join(REPO, 'desktop', 'main.js'), 'utf8');
    const i = src.indexOf('writeReport');
    assert.ok(i >= 0, 'main.js 应调用 writeReport');
    const around = src.slice(Math.max(0, i - 400), i + 300);
    assert.match(around, /try\s*\{/, '★ 调用 writeReport 必须包在 try 里');
    assert.match(around, /catch\s*\(/, '★ 必须有 catch 兜底');
  });

  test('BACKUP_PREFIX / looksLikeLegacy / detectCandidates 接口齐备', () => {
    assert.ok(legacy.BACKUP_PREFIX, '应有备份前缀常量');
    assert.equal(typeof legacy.looksLikeLegacy, 'function');
    assert.equal(typeof legacy.detectCandidates, 'function');
    assert.equal(typeof legacy.inspect, 'function');
    assert.equal(typeof legacy.importInto, 'function');
    assert.equal(typeof legacy.summarize, 'function');
  });
});

/* ============================================================
   仓库形状 —— **刻意保留**的文本断言（阶段 2.3 的收口）

   为什么这些断言故意是文本断言（不是懒，是没有更便宜的办法）：
     · electron-builder.yml / LICENSE / THIRD-PARTY-NOTICES / package.json 是**声明性文件**，
       它们的形状就是事实，没有"行为"可调；
     · main.js 的入口函数依赖 electron 的 app / win / dialog，不起 Electron 就跑不起来。

   规则（改动本组前先读）：
     1. 这类断言**只放在本组**，别散回各个行为型 describe 里；
     2. 每条都要写清"为什么必须断言文本"；
     3. 改打包配置 / 许可 / 主进程入口时必须同步这里。
   ============================================================ */
describe('仓库形状（刻意保留的文本断言）', () => {
  const mainSrc = fs.readFileSync(path.join(REPO, 'desktop', 'main.js'), 'utf8');

  test('main.js：三个更新动作都包进 withLock（入口依赖 electron，无法直接调用）', () => {
    assert.match(mainSrc, /updateStates\.withLock\('check'/, '检查应上锁');
    assert.match(mainSrc, /updateStates\.withLock\('download'/, '下载应上锁');
    assert.match(mainSrc, /updateStates\.withLock\('install'/, '安装应上锁');
    assert.doesNotMatch(mainSrc, /function\s+withUpdateLock/, '锁本体只应在 update-state.js 里（单一事实来源）');
  });

  test('main.js：安装成功路径留 800ms 再退出（文本侧兜住接线）', () => {
    assert.match(mainSrc, /setTimeout\(\(\)\s*=>\s*\{\s*quitting\s*=\s*true;\s*app\.quit\(\);\s*\},\s*800\)/,
      '★ 必须留时间让 detached 安装器站稳，再退出');
  });

  test('main.js：托盘入口在 busy 时静默返回（不弹无谓的错误框）', () => {
    assert.match(mainSrc, /if \(r && r\.busy\) return;/, '被互斥拒掉时应静默返回');
  });

  test('main.js：boot 时清理过期更新临时文件', () => {
    assert.match(mainSrc, /cleanupStaleTemp/, '启动时应调用 cleanupStaleTemp');
    assert.match(mainSrc, /jimeng-update/, '应指向更新器使用的临时目录名');
  });

  test('★ payload 的 installing 字段与界面读取的字段对齐（跨文件契约）', () => {
    const appSrc = fs.readFileSync(path.join(REPO, 'app', 'app.js'), 'utf8');
    assert.match(mainSrc, /installing:\s*updateStates\.get\(\)\s*===\s*'installing'/,
      '★ payload 必须给出 installing —— 界面按这个字段显示"正在安装"卡片');
    assert.match(appSrc, /u\.installing/, '界面确实读的是 installing');
  });

  test('ARTIFACT_RE / ARTIFACT_PREFIX 与 electron-builder.yml 的 artifactName 一致', () => {
    /* 跨文件契约：更新器靠这个正则识别"是不是我们的安装包"，而名字由打包配置生成。
       两边漂移的后果是**更新器拒绝所有合法安装包**。这里只核对"声明与实现同形状"，
       正则本身的逐条行为在 P0-1 那组里测。 */
    const yml = fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
    assert.ok(yml.includes('artifactName: ' + updater.ARTIFACT_PREFIX + '${version}'),
      'yml 的 artifactName 应使用 ' + updater.ARTIFACT_PREFIX + '${version} 前缀');
  });

  test('package.json 的版本号是合法 semver 且与 electron-builder 产物名模板相容', () => {    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本号应是 x.y.z，实得 ' + pkg.version);
    assert.equal(pkg.license, 'SEE LICENSE IN LICENSE', 'P0-4：license 字段应指向 LICENSE 文件');
    assert.ok(fs.existsSync(path.join(REPO, 'LICENSE')), '★ LICENSE 文件必须存在');
  });

  test('license 字段不再是无信息量的 UNLICENSED', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.notEqual(pkg.license, 'UNLICENSED',
      '★ UNLICENSED 无法说明"项目自身许可 / 第三方边界"，应指向 LICENSE');
  });

  test('LICENSE 明确写出"未经许可不得复制分发"', () => {
    const text = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
    assert.match(text, /不得/);
    assert.match(text, /复制|分发|发布/);
  });

  test('THIRD-PARTY-NOTICES 覆盖 dreamina / FFmpeg / Electron 三块边界', () => {
    const p = path.join(REPO, 'THIRD-PARTY-NOTICES.md');
    assert.ok(fs.existsSync(p), '★ THIRD-PARTY-NOTICES.md 必须存在');
    const text = fs.readFileSync(p, 'utf8');

    assert.match(text, /dreamina/i, '应说明 dreamina 的边界');
    assert.match(text, /FFmpeg/i, '应说明 FFmpeg');
    assert.match(text, /GPL/i, '应说明 FFmpeg 的 GPL 分发边界');
    assert.match(text, /Electron/i, '应说明 Electron');
    assert.match(text, /不随安装包分发|不打包|不分发/, '应明确哪些不随包分发');

    // 第三方许可不得继承项目自身许可
    assert.match(text, /不[会能]?自动继承|不会继承|各自适用/, '应写明第三方许可证不随本项目继承');
  });

  test('第三方组件确实不被打进安装包（files 白名单核对）', () => {
    const yml = fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
    // files 里不得出现 ffmpeg / ffprobe / dreamina 二进制
    assert.ok(!/files:[\s\S]*?ffmpeg/i.test(yml.split('extraResources')[0]),
      '★ files 白名单不得包含 ffmpeg');
    assert.ok(!/files:[\s\S]*?dreamina/i.test(yml.split('extraResources')[0]),
      '★ files 白名单不得包含 dreamina');
  });

  test('签名配置：凭据只走环境变量，证书不入库（P0-5）', () => {
    const yml = fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
    assert.match(yml, /CSC_LINK/, '应说明 CSC_LINK 用法');
    assert.match(yml, /CSC_KEY_PASSWORD/, '应说明 CSC_KEY_PASSWORD 用法');
    assert.match(yml, /timeStampServer|rfc3161TimeStampServer/, '应配置时间戳服务（证书过期后签名仍有效）');

    /* ⚠ 2026-09-22 回归：签名配置必须**缩进在 win: 之下**。
       electron-builder 26 的 schema 只认 win.signAndEditExecutable / win.signtoolOptions，
       写在顶层会直接中止构建（报 "configuration has an unknown property ..."）——
       CI 首次跑红就是这个。这是"文件形状"断言：改打包配置时必须同步这里。 */
    assert.match(yml, /^ {2}signAndEditExecutable:\s*true\s*$/m,
      '★ signAndEditExecutable 必须缩进在 win: 之下');
    assert.match(yml, /^ {2}signtoolOptions:\s*$/m,
      '★ signtoolOptions 必须缩进在 win: 之下');
    assert.doesNotMatch(yml, /^signAndEditExecutable:/m,
      '★ 不得写在顶层 —— electron-builder 26 会拒绝构建');
    assert.doesNotMatch(yml, /^signtoolOptions:/m,
      '★ 不得写在顶层 —— electron-builder 26 会拒绝构建');

    const gi = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
    for (const pat of ['*.pem', '*.key', '*.p12']) {
      assert.ok(gi.includes(pat), '★ .gitignore 必须忽略 ' + pat);
    }
  });

  /* ---------------- 构建产物一致性（node build.js 相关） ----------------
     同属"仓库形状"：这里问的是"文件在不在、能不能过语法检查"，
     不是"行为对不对" —— 打包/图标出问题的表现是"装出来没有图标"，属于形状问题。 */

  test('build.js 存在且可被 node --check 通过', () => {
    const p = path.join(REPO, 'build.js');
    assert.ok(fs.existsSync(p), 'build.js 必须存在');
    const { execSync } = require('child_process');
    execSync('node --check ' + JSON.stringify(p), { stdio: 'ignore' });
  });

  test('图标资源齐备（icon-source.png / icon.png / icon.ico）', () => {
    for (const f of ['icon-source.png', 'icon.png', 'icon.ico']) {
      assert.ok(fs.existsSync(path.join(REPO, 'build', f)), 'build/' + f + ' 必须存在（打包要用）');
    }
  });

  test('electron-builder.yml 引用的图标确实存在', () => {
    const yml = fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
    const refs = [...yml.matchAll(/(?:icon|from):\s*(build\/[A-Za-z0-9._-]+)/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, 'yml 里应至少引用一个图标');
    for (const r of refs) {
      assert.ok(fs.existsSync(path.join(REPO, r)), 'yml 引用的图标必须存在：' + r);
    }
  });
});

after(() => { H.rmrf(SANDBOX); });
