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

const SANDBOX = H.freshDir('build-release');

describe('updater —— 更新文件名安全校验（P0-1 路径穿越回归）', () => {
  test('ARTIFACT_RE 与 ARTIFACT_PREFIX 与 electron-builder.yml 的 artifactName 一致', () => {
    assert.equal(updater.ARTIFACT_PREFIX, 'JimengConsole-');
    // 本项目的产物名形状：JimengConsole-<version>-x64-Setup.exe
    assert.equal(updater.ARTIFACT_RE.test('JimengConsole-0.27.0-x64-Setup.exe'), true);
    assert.equal(updater.ARTIFACT_RE.test('JimengConsole-1.2.3-x64-Setup.exe'), true);
    assert.equal(updater.ARTIFACT_RE.test('JimengConsole-v0.27.0-x64-Setup.exe'), false, '版本前缀 v 不合法');

    // 与 yml 里写的模板对齐
    const yml = fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
    assert.match(yml, /artifactName:\s*JimengConsole-\$\{version\}-x64-Setup\.\$\{ext\}/,
      'yml 的 artifactName 必须与 ARTIFACT_RE 同形状，否则校验会误杀真实产物');
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
    const good = { version: '0.27.0', file: 'JimengConsole-0.27.0-x64-Setup.exe' };
    const r1 = updater.assertManifestFile(good);
    assert.equal(r1.file, good.file, '合法清单应原样通过');

    // 无 file 字段：直接放行（有些源只给 version/path，由后续查找补 file）
    assert.deepEqual(updater.assertManifestFile({ version: '0.27.0' }), { version: '0.27.0' });
    assert.equal(updater.assertManifestFile(null), null);

    // 有 file 但非法 → 抛错
    assert.throws(() => updater.assertManifestFile({ version: '0.27.0', file: '../../evil.exe' }),
      /更新文件名/, '穿越清单必须被整份拒绝');

    // 版本不一致 → 抛错
    assert.throws(() => updater.assertManifestFile({ version: '1.0.0', file: 'JimengConsole-0.27.0-x64-Setup.exe' }),
      /版本|不一致/);
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

  test('SHA-512 是发布的必要条件：清单里必须给出校验和', () => {
    const src = fs.readFileSync(path.join(REPO, 'desktop', 'updater.js'), 'utf8');
    assert.match(src, /sha512/i, '更新器必须处理 sha512');
    // 校验不通过时必须拒绝（不能"校验失败也装"）
    assert.match(src, /校验|sha512.*不|mismatch|不一致/i,
      '应有校验失败的处理分支');
  });

  test('默认更新源是 ikun1946/DreamFlow（不是旧仓库名）', () => {
    assert.equal(updater.DEFAULT_SOURCE.provider, 'github');
    assert.equal(updater.DEFAULT_SOURCE.owner, 'ikun1946');
    assert.equal(updater.DEFAULT_SOURCE.repo, 'DreamFlow', '★ 仓库名应是 DreamFlow，不是 jimeng-console');

    const src = fs.readFileSync(path.join(REPO, 'desktop', 'updater.js'), 'utf8');
    assert.ok(!/jimeng-console/.test(src),
      '★ updater.js 不得残留旧仓库名 jimeng-console');
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

  test('更新来源只认 github / url / local 三种，github 走 https', () => {
    const src = fs.readFileSync(path.join(REPO, 'desktop', 'updater.js'), 'utf8');
    assert.match(src, /'github'/);
    assert.match(src, /'url'/);
    assert.match(src, /'local'/);
    assert.match(src, /https:\/\/api\.github\.com|https:\/\/github\.com/,
      'github 源应走 https');
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

describe('main.js —— 更新互斥状态机（P0-3）', () => {
  const src = fs.readFileSync(path.join(REPO, 'desktop', 'main.js'), 'utf8');

  test('定义了五态状态机与 canStartUpdate', () => {
    assert.match(src, /UPDATE_STATES\s*=\s*\[[^\]]*'idle'[^\]]*'checking'[^\]]*'downloading'[^\]]*'ready'[^\]]*'installing'[^\]]*\]/,
      '应有 idle/checking/downloading/ready/installing 五态');
    assert.match(src, /function canStartUpdate/, '应有 canStartUpdate');
    assert.match(src, /function withUpdateLock/, '应有 withUpdateLock');
  });

  test('withUpdateLock 用 try/finally 释放，失败路径也解锁', () => {
    // 抓 withUpdateLock 函数体
    const i = src.indexOf('function withUpdateLock');
    assert.ok(i >= 0);
    const body = src.slice(i, i + 1400);
    assert.match(body, /try\s*\{/, '应有 try');
    assert.match(body, /finally\s*\{/, '★ 必须在 finally 里释放，否则异常会永久锁死更新流程');
  });

  test('三个更新动作都包进锁里', () => {
    assert.match(src, /withUpdateLock\('check'/, '检查应上锁');
    assert.match(src, /withUpdateLock\('download'/, '下载应上锁');
    assert.match(src, /withUpdateLock\('install'/, '安装应上锁');
  });

  test('busy 时不弹无谓的错误框', () => {
    assert.match(src, /r\s*&&\s*r\.busy/, '托盘检查应识别 busy 并静默返回');
  });

  test('安装期间保持 installing 态直到退出（防"退出流程中并发操作"）', () => {
    assert.match(src, /state\s*=\s*'installing'|state:\s*'installing'|installing/, '应有 installing 态');
    assert.match(src, /quitting\s*=\s*true/, '应置 quitting 标志');
  });

  test('boot 时清理过期更新临时文件', () => {
    assert.match(src, /cleanupStaleTemp/, '启动时应调用 cleanupStaleTemp');
    assert.match(src, /jimeng-update/, '应指向更新器使用的临时目录名');
  });

  test('preload 暴露 onUpdateState 且只订阅固定 channel', () => {
    const pre = fs.readFileSync(path.join(REPO, 'desktop', 'preload.js'), 'utf8');
    assert.match(pre, /onUpdateState/, '应暴露 onUpdateState');
    assert.match(pre, /'update:state'/, '应订阅固定 channel update:state');
    // 不得暴露任意 channel 的通用订阅（那等于把 IPC 面全开）
    assert.ok(!/ipcRenderer\.on\s*\(\s*channel/.test(pre),
      '★ 不得提供"传任意 channel"的通用订阅');
  });
});

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

describe('版本一致性（P0-4 / P2-14 相关）', () => {
  test('package.json 的版本号是合法 semver 且与 electron-builder 产物名模板相容', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
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

    const gi = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
    for (const pat of ['*.pem', '*.key', '*.p12']) {
      assert.ok(gi.includes(pat), '★ .gitignore 必须忽略 ' + pat);
    }
  });
});

describe('构建产物一致性（node build.js 相关）', () => {
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
