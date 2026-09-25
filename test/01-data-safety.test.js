'use strict';
/* ============================================================
   01-data-safety.test.js —— 数据与安全
   对应 docs/项目审查与改进清单.md §6「数据与安全」：
     · 路径穿越防护
     · 项目隔离（目录分区）
     · 软删除与彻底删除
     · JSON 原子写入
     · schema 迁移与迁移失败回滚
     · 数据根重定向隔离（附加项-1 回归）
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const H = require('./helpers');

/* 数据根必须最先重定向：runtime/config/paths 都在 require 时读 env，
   所以要在 require 业务模块**之前**把它设好。 */
const SANDBOX = H.freshDir('data-safety');
process.env.JC_DATA_DIR = SANDBOX;

const runtime = require('../server/runtime');
const paths = require('../server/paths');
const store = require('../server/store');
const schema = require('../server/schema');

describe('paths —— 白名单与目录包含性（路径穿越防护）', () => {
  test('safeId 只接受 [A-Za-z0-9_-]{1,64}', () => {
    assert.equal(paths.safeId('pj_abc-123'), 'pj_abc-123');
    assert.equal(paths.safeId('a'.repeat(64)), 'a'.repeat(64));

    // 逐个钉住各类攻击载荷
    assert.equal(paths.safeId(''), null, '空串应拒绝');
    assert.equal(paths.safeId('a'.repeat(65)), null, '超长应拒绝');
    assert.equal(paths.safeId('..'), null, '父目录应拒绝');
    assert.equal(paths.safeId('../etc'), null, '相对穿越应拒绝');
    assert.equal(paths.safeId('a/b'), null, '路径分隔符应拒绝');
    assert.equal(paths.safeId('a\\b'), null, '反斜杠应拒绝');
    assert.equal(paths.safeId('C:evil'), null, '盘符应拒绝');
    assert.equal(paths.safeId('a b'), null, '空格应拒绝');
    assert.equal(paths.safeId('a\0b'), null, 'NUL 应拒绝');
    assert.equal(paths.safeId(123), null, '非字符串应拒绝');
    assert.equal(paths.safeId(null), null);
    assert.equal(paths.safeId(undefined), null);
  });

  test('safeFile 只接受 [A-Za-z0-9._-]{1,200} 且排除 . 与 ..', () => {
    assert.equal(paths.safeFile('a.mp4'), 'a.mp4');
    assert.equal(paths.safeFile('cover_01.png'), 'cover_01.png');
    assert.equal(paths.safeFile('a'.repeat(200) + '.x'.slice(0, 0)), 'a'.repeat(200));

    assert.equal(paths.safeFile('.'), null, '单点应拒绝');
    assert.equal(paths.safeFile('..'), null, '双点应拒绝');
    assert.equal(paths.safeFile('../../evil.exe'), null, '穿越应拒绝');
    assert.equal(paths.safeFile('a/b.mp4'), null, '分隔符应拒绝');
    assert.equal(paths.safeFile('a\\b.mp4'), null, '反斜杠应拒绝');
    assert.equal(paths.safeFile('a\0b.mp4'), null, 'NUL 应拒绝');
    assert.equal(paths.safeFile('a b.mp4'), null, '空格应拒绝');
    assert.equal(paths.safeFile('中文.mp4'), null, '非 ASCII 应拒绝');
    assert.equal(paths.safeFile(''), null);
    assert.equal(paths.safeFile(42), null);
  });

  test('contained：必须比较 `base + sep` 前缀，兄弟目录不算在内', () => {
    const base = path.join(SANDBOX, 'output');
    const okFile = path.join(base, 'a.mp4');
    assert.equal(paths.contained(base, okFile), path.resolve(okFile));

    // ★ 关键回归：旧实现用 startsWith(base)，会把 output-bak 误判为在 output 内
    assert.equal(paths.contained(base, path.join(SANDBOX, 'output-bak', 'a.mp4')), null,
      '兄弟目录（前缀相同）不得被判为包含');

    // 目录本身不是文件
    assert.equal(paths.contained(base, base), null, '目标是目录本身应返回 null');

    // 向上穿越
    assert.equal(paths.contained(base, path.join(SANDBOX, 'evil.exe')), null);
    assert.equal(paths.contained(base, path.join(base, '..', '..', 'evil.exe')), null);
  });

  test('resolveServePath：URL 路径 → 绝对路径，越界一律 null', () => {
    // 合法新形状
    const p1 = paths.resolveServePath('/media/assets/pj_1/a.png');
    assert.ok(p1 && p1.startsWith(path.resolve(paths.assetDir('pj_1'))), '合法素材路径应被解析');

    const p2 = paths.resolveServePath('/files/pj_1/ws_1/a.mp4');
    assert.ok(p2 && p2.startsWith(path.resolve(paths.sbOutputDir('pj_1', 'ws_1'))), '合法产物路径应被解析');

    // 穿越载荷
    assert.equal(paths.resolveServePath('/media/assets/..%2f..%2fevil.exe'), null, '编码斜杠穿越应拒绝');
    assert.equal(paths.resolveServePath('/media/assets/pj_1/..%2f..%2fevil.exe'), null, '单段穿越应拒绝');
    assert.equal(paths.resolveServePath('/files/pj_1/ws_1/../../../evil.exe'), null, '多段穿越应拒绝');
    assert.equal(paths.resolveServePath('/media/assets/pj_1/../../../../etc/passwd'), null);

    // 形状不合法
    assert.equal(paths.resolveServePath('/media/assets/'), null, '空段应拒绝');
    assert.equal(paths.resolveServePath('/media/assets/a/b/c'), null, '段数过多应拒绝');
    assert.equal(paths.resolveServePath('/etc/passwd'), null, '非白名单前缀应拒绝');
    assert.equal(paths.resolveServePath('/'), null);
  });

  test('resolveServePath 直击：`..` 作为整段被换成合法 id 后不得逃出根', () => {
    // 这是"逐段白名单"最核心的收益：即便路径里有 `..`，段校验会直接拒掉
    const evil = '/media/assets/' + encodeURIComponent('..') + '/' + encodeURIComponent('../evil.exe');
    assert.equal(paths.resolveServePath(evil), null);
  });
});

describe('paths —— 静态路由（/app、/dist）路径安全（P1-1 回归）', () => {
  /* 2026-09-21：server.js 原先对 /app/ 与 /dist/ 各写一遍
     `p.startsWith(path.join(PROJECT_ROOT, 'app'))` —— 兄弟目录（app-old/、
     dist-backup/）会被误判为"在范围内"。现在统一走 paths.resolveStaticPath
     （静态根白名单 + contained() 包含性检查）。 */

  test('合法静态路径被解析到仓库内对应文件', () => {
    const p = paths.resolveStaticPath('/app/app.js');
    assert.ok(p, '合法路径应被解析');
    assert.equal(p, path.resolve(H.REPO_ROOT, 'app', 'app.js'));

    const d = paths.resolveStaticPath('/dist/x.html');
    assert.ok(d && d.startsWith(path.resolve(H.REPO_ROOT, 'dist') + path.sep), 'dist 产物应被解析');
  });

  test('★ 兄弟目录穿越必须被拒绝（前缀相同 ≠ 在范围内）', () => {
    // server.js 传给本函数的是**已解码**的 pathname（`..%2f` → `../`）
    assert.equal(paths.resolveStaticPath('/app/../app-old/secret.txt'), null,
      'app-old 是 app 的兄弟目录，不得被当作 app 内文件');
    assert.equal(paths.resolveStaticPath('/dist/../dist-backup/x.js'), null);
    assert.equal(paths.resolveStaticPath('/app/../../secret.txt'), null, '向上穿越应拒绝');
    /* 未解码的 `%2f` 形式：函数按"字面文件名"处理，不做二次解码（二次解码本身
       是反模式）——结果要么 null、要么仍在 app/ 内，绝不能逃出去。 */
    const raw = paths.resolveStaticPath('/app/..%2fapp-old/secret.txt');
    assert.ok(raw === null || raw.startsWith(path.resolve(H.REPO_ROOT, 'app') + path.sep),
      '编码形式不得逃出 app/');
  });

  test('白名单之外的根与形状一律拒绝', () => {
    assert.equal(paths.resolveStaticPath('/etc/passwd'), null);
    assert.equal(paths.resolveStaticPath('/server/config.js'), null, '静态根只有 app/dist');
    assert.equal(paths.resolveStaticPath('/app/'), null, '空段应拒绝');
    assert.equal(paths.resolveStaticPath('/app'), null, '无子路径应拒绝');
    assert.equal(paths.resolveStaticPath('/'), null);
    assert.deepEqual(paths.STATIC_ROOTS, ['app', 'dist'], '静态根白名单');
  });
});

describe('paths —— 项目磁盘隔离（目录分区）', () => {
  test('项目目录位于 <数据根>/projects/<id>/ 之下', () => {
    const a = path.resolve(paths.assetDir('pj_iso1'));
    const o = path.resolve(paths.outputDir('pj_iso1'));
    const root = path.resolve(SANDBOX, 'projects', 'pj_iso1');
    assert.equal(a, path.join(root, 'assets'));
    assert.equal(o, path.join(root, 'output'));
  });

  test('不同项目的目录互不重叠（真隔离，不是命名约定）', () => {
    const a1 = path.resolve(paths.assetDir('pj_iso1'));
    const a2 = path.resolve(paths.assetDir('pj_iso2'));
    assert.notEqual(a1, a2);
    assert.ok(!a1.startsWith(a2 + path.sep) && !a2.startsWith(a1 + path.sep),
      '两个项目目录不得互为父子');
  });

  test('项目 id 不合法时目录函数一律返回 null（不返回可疑路径）', () => {
    /* 现状（有意为之）：assetDir / outputDir 是**纯拼接**函数，不做校验；
       校验统一发生在 `safeId()` 与 `resolveServePath()` 这两道关卡上 ——
       前者是写路径的唯一入口，后者是读路径的唯一入口。
       因此这里钉住的是"关卡拒绝"，而不是"拼接函数抛错"：
       任何调用方想拿到可写路径，都必须先过 safeId。 */
    for (const bad of ['../evil', 'a/b', 'a\\b', '..', '', 'C:evil']) {
      assert.equal(paths.safeId(bad), null, 'safeId 应拒绝：' + JSON.stringify(bad));
      // 关卡拒绝后不得有人能拼出目录
      assert.equal(paths.sbOutputDirOf(bad, 'ws_1'), null);
      assert.equal(paths.sbOutputDirOf('pj_1', bad), null);
    }
    // ensureProjectDirs 是"写"入口，必须硬拦
    assert.throws(() => paths.ensureProjectDirs('../evil'), /id/);
  });

  test('ensureProjectDirs 建出 assets 与 output', () => {
    paths.ensureProjectDirs('pj_iso1');
    assert.ok(fs.existsSync(paths.assetDir('pj_iso1')));
    assert.ok(fs.existsSync(paths.outputDir('pj_iso1')));
  });

  test('资源 URL 可自描述（带项目段），且能反解回同一路径', () => {
    const url = paths.assetUrl('pj_iso1', 'a.png');
    assert.equal(url, '/media/assets/pj_iso1/a.png');
    const back = paths.parseAssetUrl(url);
    assert.equal(back.projectId, 'pj_iso1');
    assert.equal(back.filename, 'a.png');
    assert.equal(path.resolve(paths.assetFileOf({ url }, 'pj_iso1')),
      path.join(path.resolve(paths.assetDir('pj_iso1')), 'a.png'));

    const vurl = paths.outputUrl('pj_iso1', 'ws_1', 'a.mp4');
    assert.equal(vurl, '/files/pj_iso1/ws_1/a.mp4');
    const vback = paths.parseOutputUrl(vurl);
    assert.equal(vback.projectId, 'pj_iso1');
    assert.equal(vback.storyboardId, 'ws_1');
    assert.equal(vback.filename, 'a.mp4');
  });
});

describe('store —— 数据根重定向与隔离（附加项-1 回归）', () => {
  test('JC_DATA_DIR 生效：数据根指向沙箱，而非仓库 server/data', () => {
    const realDefault = path.resolve(__dirname, '..', 'server', 'data');
    const actual = path.resolve(runtime.getDataDir());
    assert.equal(actual, path.resolve(SANDBOX), '数据根应等于 JC_DATA_DIR');
    assert.notEqual(actual, realDefault, '★ 数据根绝不能是仓库内的 server/data');
    assert.equal(runtime.dataDirFromEnv(), true, '应标记为来自环境变量');
  });

  test('load() 不会在仓库 server/data 下建目录', () => {
    const realDefault = path.resolve(__dirname, '..', 'server', 'data');
    assert.ok(!fs.existsSync(realDefault),
      '★ 测试期间 server/data 不应被创建（JC_DATA_DIR 修复前会创建）');
  });
});

describe('store —— 原子写入与损坏恢复', () => {
  before(() => { store.load(); });

  test('saveNow 写出可解析的 JSON，且不留 .tmp 残渣', () => {
    const db = store.load();
    db.projects.push({
      id: 'pj_atomic', name: '原子写测试', description: '', settings: {},
      defaultWorkspaceId: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), lastOpenedAt: null, deletedAt: null
    });
    store.saveNow();

    const dbFile = path.join(SANDBOX, 'db.json');
    assert.ok(fs.existsSync(dbFile), 'db.json 应存在');
    const parsed = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.ok(Array.isArray(parsed.projects));
    assert.ok(parsed.projects.some((p) => p.id === 'pj_atomic'), '刚写入的项目应在磁盘上');

    // 原子写的核心：临时文件必须已被 rename 掉
    assert.ok(!fs.existsSync(dbFile + '.tmp'), '.tmp 必须已被 rename（否则说明写入中断）');
  });

  test('saveNow 在库未加载时拒绝写盘（防"空值覆盖真实数据"事故）', () => {
    /* 那场事故（2026-09-18）：一个只 require 了 services 的脚本触发了 store.save()，
       模块内 db 仍是 null → JSON.stringify(null) 写出 "null" → 真实 db.json 被覆盖。
       ⚠ 本机 Node 22 + Windows 上 `spawnSync` 直接跑 node 会报 EBUSY，
         所以走 H.nodeRun（父 shell 里跑子 node，见 helpers 说明）。 */
    const dbFile = path.join(SANDBOX, 'db.json');
    const before = fs.readFileSync(dbFile, 'utf8');

    const script = `
      const store = require('../server/store');
      store.saveNow();   // 故意不 load()：修复前会把 "null" 写到 db.json
      console.log('GUARD-RAN');
    `;
    const out = H.nodeRun(script, SANDBOX);
    assert.match(out, /GUARD-RAN/, '子进程应正常执行完');

    const after = fs.readFileSync(dbFile, 'utf8');
    assert.equal(after, before, '★ 未 load 就写盘必须被拒绝，磁盘内容不得改变');
    assert.ok(!after.startsWith('null'), '磁盘上绝不应出现 "null"');
  });

  test('主库损坏 → 从备份恢复（且写入日志、隔离原文件）', () => {
    const dir = H.freshDir('recover');
    H.writeJson(path.join(dir, 'db.json'), H.sampleDb());
    // 第一份"有效备份"：含真实数据
    H.writeJson(path.join(dir, 'db.json.bak-first-2026-01-01T00-00-00-000Z'),
      H.sampleDb({ projects: [{ id: 'pj_r1', name: '备份里的项目', deletedAt: null }] }));

    // 破坏主库
    fs.writeFileSync(path.join(dir, 'db.json'), '{ 这不是合法 JSON', 'utf8');

    const script = `
      const path = require('path');
      const store = require('../server/store');
      const db = store.load();
      const info = store.recoveryInfo();
      console.log('__RESULT__' + JSON.stringify({
        projects: db.projects.map((p) => p.name),
        recovered: !!info,
        fromName: info ? info.fromName : null,
        hasCorruptBak: require('fs').readdirSync(path.dirname(path.join(process.env.JC_DATA_DIR, 'db.json')))
          .some((f) => f.includes('.corrupt-'))
      }));
    `;
    const out = H.nodeJson(script, dir);

    assert.deepEqual(out.projects, ['备份里的项目'], '★ 应从备份恢复出真实数据，而不是空库');
    assert.equal(out.recovered, true, '应记录恢复信息');
    assert.match(out.fromName, /^db\.json\.bak-first-/, '恢复来源应是那份备份');
    assert.equal(out.hasCorruptBak, true, '损坏的原文件必须被隔离保留（不得覆盖销毁证据）');
  });

  test('备份也是空壳时不得"假成功"—— 继续找更旧的，全无则空库启动', () => {
    const dir = H.freshDir('recover-empty');
    H.writeJson(path.join(dir, 'db.json'), H.sampleDb());
    // 只有一份空壳备份（模拟"首次写入后立刻损坏"）
    H.writeJson(path.join(dir, 'db.json.bak-first-2026-01-01T00-00-00-000Z'),
      H.sampleDb({ projects: [], workspaces: [], storyboards: [], assets: [], records: [] }));
    fs.writeFileSync(path.join(dir, 'db.json'), 'not json at all', 'utf8');

    const script = `
      const path = require('path');
      const store = require('../server/store');
      const db = store.load();
      const info = store.recoveryInfo();
      console.log('__RESULT__' + JSON.stringify({
        projectCount: db.projects.length,
        recovered: !!info
      }));
    `;
    const out = H.nodeJson(script, dir);

    assert.equal(out.projectCount, 0, '空壳备份不得被当作有效恢复目标');
    assert.equal(out.recovered, false, '★ 不得声称"恢复成功"（假成功比报错更糟）');
  });

  test('listBackups 不把 .corrupt-* 当成可用备份', () => {
    const dir = H.freshDir('backup-filter');
    H.writeJson(path.join(dir, 'db.json'), H.sampleDb());
    H.writeJson(path.join(dir, 'db.json.bak-2026-01-01T00-00-00-000Z'), H.sampleDb());
    // 污染一份"看起来像备份"的隔离文件
    fs.writeFileSync(path.join(dir, 'db.json.corrupt-2026-01-02T00-00-00-000Z.bak-2026-01-02T00-00-00-000Z'), '{}');
    fs.writeFileSync(path.join(dir, 'db.json.bak-2026-01-03T00-00-00-000Z.corrupt-x'), '{}');

    const script = `
      const path = require('path');
      const store = require('../server/store');
      console.log('__RESULT__' + JSON.stringify(store.listBackups().map((f) => path.basename(f))));
    `;
    const list = H.nodeJson(script, dir);
    assert.ok(list.length >= 1, '至少应列出那份正常备份');
    assert.ok(list.every((n) => !n.includes('.corrupt-')), '★ 隔离文件不得出现在备份候选里');
  });
});

describe('schema —— 版本读取与迁移回滚', () => {
  test('readVersion：缺字段/非法值一律按 v1 处理', () => {
    assert.equal(schema.readVersion({}), 1);
    assert.equal(schema.readVersion({ schemaVersion: 3 }), 3);
    assert.equal(schema.readVersion({ schemaVersion: 0 }), 1);
    assert.equal(schema.readVersion({ schemaVersion: -5 }), 1);
    assert.equal(schema.readVersion({ schemaVersion: 'abc' }), 1);
    assert.equal(schema.readVersion({ schemaVersion: 2.9 }), 2, '小数应向下取整');
    assert.equal(schema.readVersion(null), 1);
  });

  test('迁移在克隆体上跑：校验不过时原库一个字节都不动', () => {
    // 造一个"必须校验失败"的库：v1 且分镜数量会在迁移中被破坏 → 用缺 workspaceId 的方式
    // 更可控的做法：直接让 MIGRATIONS 临时缺一个键，逼它抛 "缺少迁移函数"
    const db = H.sampleDb({ schemaVersion: 1, projects: [], workspaces: [] });
    const snapshot = JSON.stringify(db);

    const saved = schema.MIGRATIONS[1];
    delete schema.MIGRATIONS[1];
    try {
      assert.throws(() => schema.runMigrations(db), /缺少 v1 → v2 的迁移函数/,
        '缺迁移函数时必须抛错，不得静默跳过');
      assert.equal(JSON.stringify(db), snapshot, '★ 抛错后原库必须逐字节不变');
    } finally {
      schema.MIGRATIONS[1] = saved;
    }
  });

  test('迁移幂等：同一输入 + 同一时刻 → 逐字节一致；已迁移库再跑不改动', () => {
    /* 幂等的定义要精确：**同一份输入、同一时刻**跑两次得到同一份输出。
       ⚠ 时间必须注入：migrateV1ToV2 用 `ctx.now()` 给新项目/工作区打 createdAt。
         不注入的话两次运行时间差 1ms，逐字节比较必然失败 ——
         那是**时钟不固定**，不是幂等性缺陷（实测：注入固定时间后逐字节一致）。 */
    const seed = {
      schemaVersion: 1, projects: [], workspaces: [],
      storyboards: [{ id: 'sb_1', projectId: 'pj_1' }],
      assets: [{ id: 'as_1', url: '/media/assets/a.png', projectId: 'pj_1' }],
      records: [], settings: {}, cliJobs: {}
    };
    const FROZEN = '2026-01-01T00:00:00.000Z';
    const now = () => FROZEN;

    const a = JSON.parse(JSON.stringify(seed));
    const r1 = schema.runMigrations(a, { now });
    assert.deepEqual(r1.ran, ['v1→v2', 'v2→v3'], '应从 v1 跑到 v3');

    const b = JSON.parse(JSON.stringify(seed));
    const r2 = schema.runMigrations(b, { now });
    assert.deepEqual(r2.ran, ['v1→v2', 'v2→v3']);

    assert.equal(JSON.stringify(a), JSON.stringify(b), '★ 同一输入 + 同一时刻必须逐字节一致');

    // 第二层幂等：已经是 v3 的库再跑，必须逐字节不动
    const snapshot = JSON.stringify(a);
    const r3 = schema.runMigrations(a, { now });
    assert.equal(r3.skipped, true, '已是当前版本应跳过');
    assert.equal(JSON.stringify(a), snapshot, '★ 已迁移的库再跑不得有任何改动');

    // 不重复建项目/工作区
    assert.equal(a.projects.filter((p) => p.id === 'pj_1').length, 1, '旧项目只能建一次');
    assert.equal(a.workspaces.filter((w) => w.id === 'ws_1').length, 1, '旧工作区只能建一次');
    assert.equal(a.storyboards[0].workspaceId, 'ws_1', '分镜应补上 workspaceId');
    // 地址已迁到新形状
    assert.equal(a.assets[0].url, '/media/assets/pj_1/a.png');
  });

  test('不注入时间时两次运行的时间戳不同（说明时间来自注入，不是硬编码）', () => {
    const seed = { schemaVersion: 1, projects: [], workspaces: [], storyboards: [{ id: 'sb_1' }], assets: [], records: [], settings: {}, cliJobs: {} };
    const a = JSON.parse(JSON.stringify(seed)); schema.runMigrations(a);
    const b = JSON.parse(JSON.stringify(seed)); schema.runMigrations(b);
    // 除了时间戳字段，其余结构应一致
    const strip = (x) => JSON.stringify(x, (k, v) => (k === 'createdAt' || k === 'updatedAt' || k === 'lastOpenedAt' ? '<ts>' : v));
    assert.equal(strip(a), strip(b), '除时间戳外，两次迁移结果应完全一致');
  });

  test('已是当前版本 → skipped，不产生任何变更', () => {
    const db = H.sampleDb();
    const res = schema.runMigrations(db);
    assert.equal(res.skipped, true);
    assert.deepEqual(res.ran, []);
  });
});

/* ============================================================
   HTTP 级回归（P1-1）：真的起一个服务，验证 /app/ 的越界请求拿不到仓库内其它文件。
   单元测试只测 resolveStaticPath；这一条测的是 **server.js 的接线** ——
   有人把接线改回裸 startsWith 时，它会红（这正是 P1-1 的验收要求）。
   ============================================================ */
describe('server 静态路由 —— HTTP 级越界回归（P1-1）', () => {
  test('★ /app/..%2fapp-old/... 必须 404，且正例 /app/api.js 仍 200', async () => {
    /* 触发条件：仓库根下必须真的存在一个 app 的兄弟目录（app-old/）。
       造它、放一份标记文件，测完在 finally 里删掉。 */
    const sibling = path.join(H.REPO_ROOT, 'app-old');
    const marker = 'TOP-SECRET-MARKER-' + Date.now();
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'secret.txt'), marker, 'utf8');

    const { createServer } = require('../server/server');
    const srv = createServer({ configOverrides: { port: 0, token: '' } });
    try {
      const { port } = await srv.start();
      const base = 'http://127.0.0.1:' + port;

      const evil = await fetch(base + '/app/..%2fapp-old/secret.txt');
      const evilBody = await evil.text();
      assert.equal(evil.status, 404, '越界请求必须 404');
      assert.ok(!evilBody.includes(marker), '★ 不得泄露兄弟目录内容');

      const okRes = await fetch(base + '/app/api.js');
      const okBody = await okRes.text();
      assert.equal(okRes.status, 200, '正常静态资源必须保住 200');
      assert.ok(okBody.length > 100, '返回的是真实脚本内容');
    } finally {
      await srv.stop();
      H.rmrf(sibling);
      /* ⚠ start() 里有两个**未被 stop() 跟踪**的启动期定时器（CLI 预热 300ms、
         封面补齐 1200ms）。不等它们落地就结束用例的话，它们会在沙箱删除之后
         才碰 store —— 留下重新生成的空目录（测试残留）。这里等一下，
         让它们在沙箱还在的时候跑完。 */
      await new Promise((r) => setTimeout(r, 1400));
    }
  });
});

after(() => { H.rmrf(SANDBOX); });
