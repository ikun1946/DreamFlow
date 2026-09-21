'use strict';
/* ============================================================
   main.js —— Electron 主进程（桌面版入口）

   职责（按启动顺序）：
     1. 单实例锁 + AppUserModelId（托盘/任务栏归组要用）
     2. 解析目录布局（runtime-paths.js）→ 接管 console 落盘（logger.js）
     3. 定位外部工具（external-tools.js）
     4. 注入运行时配置 → 起内嵌服务（server/server.js，随机端口 + 一次性 Token）
     5. 开窗口、托盘、外部链接策略
     6. 关窗/退出时的任务保护与优雅停止

   三条硬约束（违反任何一条都会在真机上出问题）：
     · 数据目录必须是用户可写目录，绝不写安装目录（见 runtime-paths.js）
     · 退出必须走 server.stop()：落盘 + 收子进程，不能让 dreamina 变孤儿
     · 页面只允许访问本机这一个端口，外部链接一律交给系统浏览器
   ============================================================ */
const { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const logger = require('./logger');
const rpaths = require('./runtime-paths');
const toolsMod = require('./external-tools');
const legacyMod = require('./legacy-import');
const updaterMod = require('./updater');
const runtime = require('../server/runtime');

const APP_ID = 'com.ikun1946.jimengconsole';
const PRODUCT = '即梦批量生成控制台';
const SMOKE = process.env.JC_DESKTOP_SMOKE === '1' || process.argv.indexOf('--smoke') >= 0;
const SMOKE_OUT = process.env.JC_DESKTOP_SMOKE_OUT || path.join(app.getPath('temp'), 'jc-desktop-smoke.png');
/* 等待多久再截图。默认 1.5s 够页面首帧；排查"启动卡住"时用 JC_SMOKE_DELAY
   拉长到 10s 以上，就能区分"慢"和"永远出不来"。 */
const SMOKE_DELAY = Number(process.env.JC_SMOKE_DELAY || 1500);

let paths = null;          // runtime-paths.resolvePaths 的产物
let bridge = null;         // server/server.js 的 createServer 实例
let cfg = null;            // 生效配置（含随机端口与 Token）
let found = null;          // 外部工具定位结果
let win = null;
let tray = null;
let quitting = false;
let serverReady = false;

/* ---------------- 图标 ---------------- */
function assetPath(name) {
  /* 打包后优先用 resources 下的真实文件（见 electron-builder.yml 的 extraResources）：
     nativeImage 从 asar 里读图标在个别 Windows 环境下会拿到空图，托盘就没图标。 */
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, 'build', name);
    if (fs.existsSync(packed)) return packed;
  }
  const inApp = path.join(app.getAppPath(), 'build', name);
  if (fs.existsSync(inApp)) return inApp;
  const dev = path.join(__dirname, '..', 'build', name);
  if (fs.existsSync(dev)) return dev;
  return null;
}

function appIcon() {
  const p = assetPath('icon.png');
  return p ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

/* ---------------- 任务保护 ----------------
   关窗口 / 退出前要回答一个问题：现在有没有正在跑的任务？
   有的话不能让用户"以为关了其实还在计费"，也不能"直接杀掉导致 submit_id 丢失"。 */
function runningTasks() {
  try {
    const store = require('../server/store');
    const db = store.load();
    return (db.storyboards || []).filter((s) => s.status === 'queued' || s.status === 'generating').length;
  } catch (e) { return 0; }
}

function trayTitle() {
  const n = runningTasks();
  return n ? PRODUCT + '（' + n + ' 个任务运行中）' : PRODUCT;
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(trayTitle());
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  const n = runningTasks();
  return Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showWindow() },
    { type: 'separator' },
    { label: n ? ('运行中的任务：' + n + ' 个') : '当前没有运行中的任务', enabled: false },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(paths.dataDir) },
    { label: '打开日志目录', click: () => shell.openPath(paths.logsDir) },
    { label: '环境检测', click: () => showEnvironment() },
    { label: '从旧版导入数据…', click: () => runLegacyImport() },
    { label: '检查更新…', click: () => checkForUpdatesFromTray() },
    { type: 'separator' },
    { label: '退出', click: () => requestQuit() }
  ]);
}

function showEnvironment() {
  const lines = [
    '应用版本：' + app.getVersion(),
    '数据目录：' + paths.dataDir,
    '日志目录：' + paths.logsDir,
    '',
    toolsMod.summarize(found)
  ];
  dialog.showMessageBox(win || null, {
    type: 'info',
    title: '环境检测',
    message: '运行环境',
    detail: lines.join('\n'),
    buttons: ['好']
  });
}

/* ---------------- 窗口 ---------------- */
/* ---------------- 旧版数据导入 ----------------
   桌面版把数据根从"安装目录下的 server/data"改成了用户可写目录（见 runtime-paths.js）。
   不管旧库的话，用户装完桌面版打开就是**空库** —— 项目全"不见了"。
   所以首次启动自动检测一次；之后随时能从托盘菜单手动导入。 */
function targetHasData() {
  try {
    const db = JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'db.json'), 'utf8'));
    return ((db.projects || []).length + (db.workspaces || []).length) > 0;
  } catch (e) { return false; }
}

async function performImport(srcDir) {
  const res = legacyMod.importInto(srcDir, paths.dataDir, {});
  console.log('[desktop] 旧数据导入完成：复制 ' + res.copied.files + ' 个文件（跳过已存在 '
    + res.copied.skipped + ' 个），缺失引用 ' + res.report.missing.length + ' 处');
  if (res.report.missing.length) {
    res.report.missing.slice(0, 20).forEach((m) => console.warn('[desktop] 缺失：' + m.label + ' → ' + m.path));
  }
  /* 导入报告**落盘**（2026-09-21，清单 §11 的"导入报告保存到日志或数据目录"）。
     为什么必须落盘：导入是一次性动作，对话框关掉之后：
       · 控制台日志在桌面版里用户看不到（打包后没有终端）
       · 缺失引用清单可能很长，对话框里只显示前几条
     出问题时（"我的素材导入后少了几个"）需要一份可回查的档案。
     落到**数据目录下的 backup/**（而不是 logs/）：它属于"数据历史"，
     用户换盘 / 迁移数据时会跟着一起走；logs 是运行日志，容易被清。 */
  try {
    const reportPath = legacyMod.writeReport(paths.dataDir, res);
    if (reportPath) console.log('[desktop] 导入报告已写入：' + reportPath);
  } catch (e) {
    console.warn('[desktop] 导入报告写入失败（不影响导入结果）：' + ((e && e.message) || e));
  }
  await dialog.showMessageBox(win || null, {
    type: res.ok ? 'info' : 'warning',
    title: '导入完成',
    message: res.ok ? '旧数据已导入' : '导入完成，但有引用找不到文件',
    detail: legacyMod.summarize(res),
    buttons: ['好']
  });
  return res;
}

/* 首次启动的自动检测。只在"确实找到旧库 + 新库还是空的"时才打扰用户：
   两个条件缺一不可 —— 用户已经有数据时再弹"要不要导入"，只会让人担心被覆盖。 */
async function importLegacyOnce() {
  if (SMOKE) return;                                   // 冒烟测试不弹对话框
  if (paths.config && paths.config.legacyImportChecked) return;
  if (targetHasData()) return;
  const cands = legacyMod.detectCandidates({
    appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged
  });
  if (!cands.length) return;
  const src = cands[0];
  const info = legacyMod.inspect(src);
  if (!info.ok) return;
  const c = info.counts;
  if (c.projects + c.workspaces === 0) return;          // 空库，没什么可导的
  const pick = await dialog.showMessageBox(win || null, {
    type: 'question',
    title: '发现旧版数据',
    message: '要把旧版的数据导入到桌面版吗？',
    detail: '旧目录：' + src + '\n\n'
      + '项目 ' + c.projects + ' 个 · 分镜表 ' + c.workspaces + ' 张 · 分镜 ' + c.storyboards + ' 个\n'
      + '素材 ' + c.assets + ' 个 · 生成记录 ' + c.records + ' 条\n\n'
      + '导入是复制，不是搬家：旧目录会原样保留，不会删除任何东西。',
    /* ⚠ 按钮文案必须写清"以后还能再导"（2026-09-21，清单 §11）。
       原本文案只有「以后再说」，而选了之后 `legacyImportChecked: true` 会**永久**
       关掉自动询问 —— 用户以为"下次启动还会问"，实际不会，于是旧数据再也没被导入。
       这不是改行为（那个标记仍然写，避免每次启动都打扰），而是让文案与行为一致：
       把唯一的补救路径（托盘菜单）直接说给用户听。 */
    buttons: ['导入', '以后再说（可从托盘菜单重新导入）'],
    defaultId: 0, cancelId: 1
  });
  /* 无论选哪边都记一笔：不记的话每次启动都要问一遍。 */
  rpaths.saveConfig(paths, { legacyImportChecked: true });
  if (pick.response !== 0) return;
  await performImport(src);
}

/* 托盘菜单入口：让用户自己挑文件夹。
   打包后"旧库在哪"是不可猜的（可能在任意盘任意目录），所以这条人工路径是必需项。 */
async function runLegacyImport() {
  if (runningTasks() > 0) {
    await dialog.showMessageBox(win || null, {
      type: 'warning', title: '暂时不能导入',
      message: '还有任务在运行中',
      detail: '导入会换掉整个数据库，运行中的任务会丢失跟踪。请等任务结束后再导入。',
      buttons: ['好']
    });
    return;
  }
  const r = await dialog.showOpenDialog(win || null, {
    title: '选择旧版数据目录（里面有 db.json 的那个）',
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths.length) return;
  const src = r.filePaths[0];
  if (!legacyMod.looksLikeLegacy(src)) {
    await dialog.showMessageBox(win || null, {
      type: 'warning', title: '这个目录不能导入',
      message: '没有找到可用的 db.json',
      detail: '请选择旧版项目里的 server\\data 目录（里面应当有 db.json）。\n\n你选的是：' + src,
      buttons: ['好']
    });
    return;
  }
  try {
    await performImport(src);
    /* 换库之后必须让内存副本跟着换，否则界面刷新了也还是旧数据。
       ⚠ 顺序：先 reload（丢弃内存）再刷新页面 —— 反过来会读到旧的。 */
    require('../server/store').reload();
    if (win && !win.isDestroyed()) win.webContents.reload();
  } catch (e) {
    await dialog.showMessageBox(win || null, {
      type: 'error', title: '导入失败', message: '导入没有完成',
      detail: String((e && e.message) || e) + '\n\n旧目录未被改动，可以重试。',
      buttons: ['好']
    });
  }
}

function defaultBounds() {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1500, Math.max(1000, wa.width - 120));
  const height = Math.min(950, Math.max(640, wa.height - 100));
  return { width, height };
}

/* 恢复上次的窗口位置。⚠ 必须先确认那块屏幕还在 ——
   外接屏拔掉后，历史坐标会落在不存在的区域，窗口"打开了但看不见"。 */
function restoreBounds() {
  const saved = rpaths.readState(paths);
  const b = saved.bounds;
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return defaultBounds();
  try {
    const { screen } = require('electron');
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    if (!visible) return defaultBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  } catch (e) { return defaultBounds(); }
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
  rpaths.saveState(paths, { bounds: b });
}

function isLocalUrl(u) {
  try {
    const url = new URL(u);
    const base = new URL(bridge.url);
    return url.host === base.host && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch (e) { return false; }
}

function openExternalSafely(u) {
  let url;
  try { url = new URL(u); } catch (e) { return; }
  /* 只放行 https：即梦授权页是 https，其它协议（file: / ms-*: / 自定义协议）
     一律不交给系统 —— 那等于把"任意协议启动"这个能力开放给页面。 */
  if (url.protocol !== 'https:') {
    console.warn('[desktop] 拒绝打开非 https 链接：' + url.protocol);
    return;
  }
  shell.openExternal(u).catch((e) => console.warn('[desktop] 打开外部链接失败：' + e.message));
}

function errorPage(err) {
  const msg = String((err && err.message) || err || '未知错误');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = '<!doctype html><meta charset="utf-8"><title>启动失败</title>'
    + '<style>body{font:14px/1.7 "Segoe UI",system-ui,sans-serif;padding:48px;color:#1D1D1F;background:#F5F5F7}'
    + 'h1{font-size:20px;margin:0 0 12px}code{background:#fff;border:1px solid #E5E5EA;border-radius:6px;padding:2px 6px;font-size:12.5px}'
    + '.box{max-width:760px;margin:0 auto;background:#fff;border:1px solid #E5E5EA;border-radius:14px;padding:28px 32px}'
    + 'ul{padding-left:20px}li{margin:6px 0}</style>'
    + '<div class="box"><h1>本地服务启动失败</h1>'
    + '<p>应用无法启动内嵌服务，因此界面没有加载。错误信息：</p>'
    + '<p><code>' + esc(msg) + '</code></p>'
    + '<p>可以依次排查：</p><ul>'
    + '<li>数据目录是否可写：<code>' + esc(paths.dataDir) + '</code></li>'
    + '<li>是否有安全软件拦截本机回环端口的监听</li>'
    + '<li>日志文件：<code>' + esc(logger.file() || '(未启用)') + '</code></li>'
    + '</ul><p>修复后重新启动应用即可。</p></div>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow() {
  const b = restoreBounds();
  win = new BrowserWindow(Object.assign({}, b, {
    minWidth: 420,
    minHeight: 480,
    show: false,
    backgroundColor: '#F5F5F7',
    title: PRODUCT,
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  }));

  /* 冒烟模式也要显示：隐藏窗口在部分 Windows 配置下 capturePage 会截到空白，
     那样"截图自检"就失去意义了。 */
  win.once('ready-to-show', () => { win.show(); });

  /* 外部链接与新窗口：
     · 本地地址（同一个端口）放行，用于产物视频"在新窗口打开"
     · https 交给系统浏览器（即梦授权页走这条）
     · 其它一律拒绝 —— 不给页面开任意窗口/任意协议的口子 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) return { action: 'allow' };
    openExternalSafely(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (isLocalUrl(url)) return;
    e.preventDefault();
    openExternalSafely(url);
  });

  /* F12 / Ctrl+Shift+I 开 DevTools：打包版默认禁用 devTools，
     这里给一个"排障时能开"的入口（打包版需要显式允许）。 */
  win.webContents.on('before-input-event', (e, input) => {
    const devKeys = (input.key === 'F12') || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (devKeys && input.type === 'keyDown' && !app.isPackaged) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  win.on('close', (e) => {
    saveBounds();
    if (quitting) return;
    /* 有任务在跑：默认收进托盘，别让一次误点关窗就掐断本地跟踪。
       真正的"退出"由托盘菜单或应用菜单触发，走 requestQuit()。 */
    if (runningTasks() > 0) {
      e.preventDefault();
      win.hide();
      if (tray && tray.displayBalloon) {
        try { tray.displayBalloon({ title: PRODUCT, content: '仍有任务运行中，已最小化到托盘。右键托盘图标可退出。' }); }
        catch (err) { /* 某些系统不支持气泡，忽略 */ }
      }
      refreshTray();
    }
  });

  win.on('closed', () => { win = null; });

  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[desktop] 页面加载失败 ' + code + ' ' + desc + ' ' + url);
  });

  /* 渲染进程的报错默认只进 DevTools 控制台，打包版用户看不到 —— 一旦页面
     JS 抛异常，表现出来就是"窗口打开了但一片空白"，而且没有任何线索。
     所以把 error 级消息转进主进程日志；冒烟模式下连 log/warn 一起收，
     方便脚本定位"为什么没渲染出来"。 */
  /* ⚠ 只接一个参数：Electron 44 的 console-message 已经把 level/message/line/source
     合并进事件对象，位置参数形式会打印 "arguments are deprecated" 警告。
     取字段时对两种形状都兼容，但**签名里不再声明**那些位置参数。 */
  win.webContents.on('console-message', (e, ...rest) => {
    const lv = (e && e.level !== undefined) ? e.level : rest[0];
    const message = (e && e.message !== undefined) ? e.message : rest[1];
    const line = (e && e.lineNumber !== undefined) ? e.lineNumber : rest[2];
    const source = (e && e.sourceId) || rest[3] || '';
    const isErr = lv === 3 || lv === 'error';
    if (!SMOKE && !isErr) return;
    const tag = isErr ? '错误' : (lv === 2 || lv === 'warning' ? '警告' : '日志');
    console.log('[renderer/' + tag + '] ' + message + (source ? '  @' + source + ':' + line : ''));
  });
  win.webContents.on('preload-error', (e, p, err) => {
    console.error('[desktop] preload 执行失败：' + p + ' —— ' + ((err && err.message) || err));
  });

  win.webContents.on('render-process-gone', (e, details) => {
    console.error('[desktop] 渲染进程退出：' + JSON.stringify(details));
  });

  const target = (serverReady && bridge) ? bridge.url : errorPage(new Error('本地服务尚未就绪'));
  win.loadURL(target);

  if (SMOKE) runSmoke();
  return win;
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------------- 冒烟自检（自动化验收用，不影响正常启动） ----------------
   JC_DESKTOP_SMOKE=1 electron .
   加载完成后截一张图、打印关键状态，然后自己退出 —— 这样"打包好的应用能不能
   真正把界面渲染出来"是可以被脚本验证的，而不是只能靠人眼看。 */
function runSmoke() {
  const done = async () => {
    try {
      /* 截图前先抢焦点：capturePage 走的是合成器，窗口被别的窗口压住时
         在部分 Windows 配置下会截到纯背景色。冒烟测试的价值全在"看得见"，所以
         这里宁可把窗口顶到前面。 */
      try { win.show(); win.focus(); win.moveTop(); } catch (e) { /* 忽略 */ }
      await new Promise((r) => setTimeout(r, 600));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SMOKE_OUT, img.toPNG());
      console.log('[smoke] 截图：' + SMOKE_OUT);
      /* 自检：故意报一条错，确认 console-message 转发链路是通的。
         如果日志里看不到这行，那"没有报错"就不能当作"没有出错"。 */
      await win.webContents.executeJavaScript('console.error("SMOKE-SELFTEST-ERROR")', true);
      await new Promise((r) => setTimeout(r, 200));
      /* 同时落一份 DOM 快照：截图只能看出"白屏"，看不出白屏时 DOM 到底长什么样。
         排障时这份文件比截图有用得多。 */
      try {
        const dump = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
        fs.writeFileSync(SMOKE_OUT + '.html', dump);
        console.log('[smoke] DOM 快照：' + SMOKE_OUT + '.html');
      } catch (e) { console.warn('[smoke] DOM 快照失败：' + e.message); }
      const title = await win.webContents.executeJavaScript('document.title', true);
      /* 光看"元素存在"是不够的：页面结构在、但样式没生效或内容空白时，
         querySelector 一样返回 true。所以这里连**渲染出来的文本长度和几何**一起报，
         让"界面真的画出来了"这件事可以被脚本判定。 */
      const views = await win.webContents.executeJavaScript(`(() => {
        const q = (s) => document.querySelector(s);
        const box = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
        return JSON.stringify({
          home: !!q('#homeView'), table: !!q('#app'), api: typeof Api !== 'undefined',
          textLen: (document.body.innerText || '').trim().length,
          text: (document.body.innerText || '').trim().slice(0, 160),
          htmlLen: document.documentElement.outerHTML.length,
          ready: document.readyState,
          res: performance.getEntriesByType('resource').map(r => (r.name.split('/').pop() || r.name) + '=' + (r.responseStatus || '?') + ':' + Math.round(r.duration)).join(' '),
          views: Array.from(document.querySelectorAll('[id]')).filter(e => /View$/.test(e.id)).map(e => e.id + (e.hidden ? ':hidden' : ':' + Math.round(e.getBoundingClientRect().height))).join(','),
          body: box('body'), homeBox: box('#homeView'),
          bg: getComputedStyle(document.body).backgroundColor,
          title: (q('h1') && q('h1').textContent || '').trim().slice(0, 40)
        });
      })()`, true);
      console.log('[smoke] title=' + title + ' dom=' + views);
      console.log('[smoke] url=' + win.webContents.getURL());
      console.log('[smoke] 数据目录=' + paths.dataDir);
      console.log('[smoke] 工具：' + toolsMod.summarize(found).replace(/\n/g, ' | '));
      console.log('[smoke] OK');
    } catch (e) {
      console.error('[smoke] 失败：' + ((e && e.message) || e));
      process.exitCode = 1;
    }
    quitting = true;
    try { await shutdown(); } catch (e) { /* 已记录 */ }
    app.exit(process.exitCode || 0);
  };
  win.webContents.once('did-finish-load', () => setTimeout(done, SMOKE_DELAY));
  win.webContents.once('did-fail-load', () => setTimeout(done, 300));
}

/* ---------------- 退出 ---------------- */
async function confirmQuit() {
  const n = runningTasks();
  if (!n) return true;
  const r = await dialog.showMessageBox(win || null, {
    type: 'warning',
    title: '仍有任务在运行',
    message: '当前有 ' + n + ' 个任务处于排队或生成中。',
    detail: '退出后本地不再跟踪这些任务。即梦侧的任务**可能仍在继续生成并消耗积分**，'
      + '下次启动会依据已保存的 submit_id 续查结果，不会自动重新提交。',
    buttons: ['继续运行（最小化到托盘）', '仍然退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return r.response === 1;
}

async function requestQuit() {
  if (quitting) return;
  if (!(await confirmQuit())) { showWindow(); return; }
  quitting = true;
  await shutdown();
  app.quit();
}

async function shutdown() {
  try { if (bridge) await bridge.stop(); }
  catch (e) { console.error('[desktop] 停止内嵌服务失败：' + ((e && e.message) || e)); }
  bridge = null;
}

/* ---------------- 启动 ---------------- */
async function boot() {
  paths = rpaths.resolvePaths(app);
  logger.install(paths.logsDir);
  console.log('[desktop] ' + PRODUCT + ' v' + app.getVersion() + ' 启动');
  console.log('[desktop] userData=' + paths.userData);
  console.log('[desktop] dataDir=' + paths.dataDir + (paths.usedFallback ? '（原定目录不可写，已回退）' : ''));
  if (paths.usedFallback) {
    console.warn('[desktop] ⚠ 配置的数据目录不可写，已回退到 ' + paths.dataDir + '。原目录里的项目不会出现在这里。');
  }

  const bundledDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'bin');
  found = toolsMod.detect(paths.config, bundledDir);
  console.log('[desktop] 外部工具：' + toolsMod.summarize(found).replace(/\n/g, ' | '));

  /* 旧数据导入必须赶在服务启动**之前**：store 是"读一次就缓存"的，
     等它把空库读进内存再导，界面看到的还是空库。 */
  try {
    await importLegacyOnce();
  } catch (e) {
    /* 导入失败不能挡住启动：应用照常起来，用户可以稍后从托盘重试。 */
    console.error('[desktop] 旧数据导入检查失败（不影响启动）：' + ((e && e.message) || e));
  }

  /* 注入运行时环境 → 再取配置。顺序不能反：数据根参与配置推导。 */
  runtime.configure({
    mode: 'desktop',
    dataDir: paths.dataDir,
    logsDir: paths.logsDir,
    configPath: paths.configPath
  });

  /* 更新临时目录的过期残骸清理（2026-09-21）。
     下载中断留下的 `*-Setup.exe.part-<pid>` 每个可能 100+ MB，被强杀时
     cleanup() 没机会跑。放在这里是因为此刻还没有任何下载可能在进行，
     删起来最安全；只删 24h 以上、且名字符合安装包前缀的文件。 */
  try {
    const upTmp = path.join(app.getPath('temp'), 'jimeng-update');
    const cl = updaterMod.cleanupStaleTemp(upTmp);
    if (cl.removed && cl.removed.length) {
      console.log('[desktop] 清理过期更新临时文件 ' + cl.removed.length + ' 个：' + cl.removed.join(', '));
    }
  } catch (e) {
    console.warn('[desktop] 清理更新临时文件失败（不影响启动）：' + ((e && e.message) || e));
  }

  const { loadConfig } = require('../server/config');
  const { createServer } = require('../server/server');
  cfg = loadConfig({
    /* port 0 = 让系统分配空闲端口：不再和别的程序抢 8787，也不再因为
       "端口被占"而整个应用起不来。 */
    port: 0,
    host: '127.0.0.1',
    /* 一次性 Token：每次启动重新生成，只在本进程内存里。
       它挡的是"本机其它网页偷偷调用生成接口"（那些接口会真扣积分）。 */
    token: crypto.randomBytes(32).toString('hex'),
    /* 桌面版页面由内嵌服务自己托管，不需要给 file:// 开口子 */
    allowFileOrigin: false,
    dreaminaCliPath: found.dreamina.path || 'dreamina',
    ffmpegPath: found.ffmpeg.path || 'ffmpeg',
    ffprobePath: found.ffprobe.path || 'ffprobe'
  });
  console.log('[desktop] 服务端口 ' + (cfg.port === 0 ? '(随机)' : cfg.port) + '，Token 已生成（长度 ' + cfg.token.length + '）');

  bridge = createServer({ config: cfg });
  try {
    await bridge.start();
    serverReady = true;
    console.log('[desktop] 内嵌服务已就绪：' + bridge.url);
  } catch (e) {
    serverReady = false;
    console.error('[desktop] 内嵌服务启动失败：' + ((e && e.message) || e));
  }

  createWindow();
  createTray();
}

function createTray() {
  const img = appIcon();
  if (img.isEmpty()) { console.warn('[desktop] 没有图标，跳过托盘'); return; }
  try {
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip(trayTitle());
    tray.setContextMenu(buildTrayMenu());
    tray.on('double-click', () => showWindow());
    tray.on('click', () => showWindow());
  } catch (e) {
    console.warn('[desktop] 托盘创建失败：' + e.message);
  }
}

/* ---------------- 应用自更新 ----------------
   实现全在 updater.js（取元数据 → 下载 → 校验 → 调安装器）；这里只负责
   "拿配置、把结果接到界面和托盘"。

   ⚠ 2026-09-21 补：**互斥状态机**。
   更新有两个入口 —— 设置页（IPC `update:*`）和托盘菜单（checkForUpdatesFromTray）。
   修复前两条路都能随时开跑，后果：
     · 连点两次"检查更新" → 两次并发请求，结果互相覆盖（lastCheck 是单变量）
     · 检查/下载期间又点安装 → 拿到半截文件或没校验完的路径
     · 重复下载 → 两个流程写同一个 `*-Setup.exe.part-<pid>`
   状态只有 5 个，但**每个都必须拦**。所有更新入口统一走 withUpdateLock()，
   拿不到锁的直接返回 { ok:false, busy:true }，由界面提示"请等当前操作完成"。 */
const UPDATE_STATES = ['idle', 'checking', 'downloading', 'ready', 'installing'];
let updateState = 'idle';

/* 哪些状态下允许发起什么 —— 这是互斥规则**唯一**的落点，改规则只改这里。
   允许的转移：
     idle        → checking | downloading        （常规入口）
     ready       → downloading（重下）/ installing（安装已下好的包）
     checking/downloading/installing → 一律拒绝（有流程在跑） */
function canStartUpdate(action) {
  if (updateState === 'idle') return true;
  if (updateState === 'ready' && (action === 'download' || action === 'install')) return true;
  return false;
}

/* 状态机 + 异常兜底。为什么用 try/finally 而不是靠各分支自己复位：
   fetchManifest/download 里任何一处抛未捕获异常，状态会永久卡在 downloading，
   之后**再也无法更新**（要重启应用）—— 这类"卡死型"故障比原 bug 更难排查。 */
async function withUpdateLock(action, fn) {
  if (!canStartUpdate(action)) {
    const msg = updateState === 'installing'
      ? '正在安装更新，请等待应用自动重启'
      : '已有更新操作正在进行中（' + updateState + '），请稍候';
    console.warn('[desktop] 更新互斥：拒绝 ' + action + '（当前 ' + updateState + '）');
    return { ok: false, busy: true, state: updateState, error: msg };
  }
  const prev = updateState;
  updateState = (action === 'check') ? 'checking' : (action === 'download' ? 'downloading' : 'installing');
  broadcastUpdateState();
  try {
    return await fn();
  } finally {
    /* installing 成功时进程即将退出，不需要复位（复位反而会给"并发安装"留窗口） */
    if (updateState !== 'idle') {
      if (updateState === 'installing' && prev !== 'installing') {
        /* 安装失败 → 退回 ready（安装包还在，用户可以重试）；成功则进程已退出 */
        updateState = pendingInstaller ? 'ready' : 'idle';
      } else {
        updateState = 'idle';
      }
      broadcastUpdateState();
    }
  }
}

/* 状态变化主动推给界面：渲染进程平时靠轮询，但"被拒绝"这件事需要立刻可见 */
function broadcastUpdateState() {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('update:state', updateStatusPayload());
  } catch (e) { /* 窗口还没建好/已销毁：忽略，界面下次轮询会拿到 */ }
}

function updateStatusPayload() {
  return {
    version: app.getVersion(),
    source: publicSource(),
    progress: updaterMod.progressOf(),
    lastCheck,
    state: updateState,
    busy: updateState !== 'idle' && updateState !== 'ready',
    hasPendingInstaller: !!pendingInstaller
  };
}

async function doCheckUpdates() {
  return withUpdateLock('check', async () => {
    lastCheck = await updaterMod.check(app.getVersion(), updateSource());
    console.log('[desktop] 检查更新：' + JSON.stringify({
      ok: lastCheck.ok, latest: lastCheck.latestVersion, hasUpdate: lastCheck.hasUpdate, error: lastCheck.error
    }));
    /* 有新版本且还没下载过 → 进入 ready，让"安装"入口可用 */
    if (lastCheck.ok && lastCheck.hasUpdate && pendingInstaller) updateState = 'ready';
    return lastCheck;
  });
}

async function doDownloadUpdate() {
  return withUpdateLock('download', async () => {
    const dir = path.join(app.getPath('temp'), 'jimeng-update');
    const r = await updaterMod.download(app.getVersion(), updateSource(), dir);
    if (r.ok) { pendingInstaller = r.path; updateState = 'ready'; }
    console.log('[desktop] 下载更新：' + JSON.stringify({ ok: r.ok, path: r.path, error: r.error }));
    return r;
  });
}

async function doInstallUpdate() {
  return withUpdateLock('install', async () => {
    if (!pendingInstaller) return { ok: false, error: '还没有下载好更新包' };
    const r = await updaterMod.install(pendingInstaller);
    if (!r.ok) return r;
    /* ⚠ 安装器是 detached 拉起的，立刻 app.quit() 有时会让它还没站稳就被回收。
       留 800ms 让它起来，再退出 —— 安装器会等本进程退出后替换文件。
       这段时间保持 state='installing'，任何并发更新请求都会被拒（见 canStartUpdate）。 */
    setTimeout(() => { quitting = true; app.quit(); }, 800);
    return { ok: true, path: pendingInstaller };
  });
}

/* 托盘入口：检查完用对话框把结果说清楚，并支持"下载并安装"。
   ⚠ 被互斥拒掉时**不弹错误对话框** —— 那是用户自己重复点击造成的，
   弹一个"失败"只会让人以为真出了问题。改为静默跳过（状态已在托盘/界面体现）。 */
async function checkForUpdatesFromTray() {
  const r = await doCheckUpdates();
  if (r && r.busy) return;
  if (!r.ok) {
    await dialog.showMessageBox(win || null, {
      type: 'warning', title: '检查更新失败', message: '没能取到更新信息',
      detail: r.error + (r.needsToken
        ? '\n\n提示：本仓库已公开、正常无需令牌。若读取失败，请检查更新源设置；私有库需填只读访问令牌，也可改用本地目录或自定义 URL 更新源。'
        : ''),
      buttons: ['好']
    });
    return;
  }
  if (!r.hasUpdate) {
    await dialog.showMessageBox(win || null, {
      type: 'info', title: '已是最新版', message: '当前版本 ' + r.currentVersion + ' 已是最新。', buttons: ['好']
    });
    return;
  }
  const pick = await dialog.showMessageBox(win || null, {
    type: 'question', title: '发现新版本',
    message: '有新版本可用：' + r.latestVersion,
    detail: '当前 ' + r.currentVersion + ' → 新版本 ' + r.latestVersion + '\n\n'
      + '点「下载并安装」后自动完成：下载 → 校验 → 静默安装 → 重启应用。\n'
      + '你的数据（项目、素材、视频）都在安装目录之外，不受影响。',
    buttons: ['下载并安装', '以后再说'], defaultId: 0, cancelId: 1
  });
  if (pick.response !== 0) return;

  const d = await doDownloadUpdate();
  if (d && d.busy) return;
  if (!d.ok) {
    await dialog.showMessageBox(win || null, {
      type: 'error', title: '下载失败', message: '没能下载更新包', detail: d.error, buttons: ['好']
    });
    return;
  }
  const ins = await doInstallUpdate();
  /* 安装本身失败必须让用户知道（否则窗口关了、什么都没发生；这正是 P0-2 的表现） */
  if (ins && !ins.ok && !ins.busy) {
    await dialog.showMessageBox(win || null, {
      type: 'error', title: '安装失败',
      message: '没能启动安装器，当前应用将继续运行（未做任何改动）',
      detail: (ins.error || '未知原因') + '\n\n安装包已下载好，可从设置页重试。',
      buttons: ['好']
    });
  }
}

/* ---------------- IPC（preload 暴露的最小面） ---------------- */
function insideDataDir(p) {
  try {
    const target = path.resolve(String(p));
    const base = path.resolve(paths.dataDir);
    return target === base || target.startsWith(base + path.sep);
  } catch (e) { return false; }
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  product: PRODUCT,
  dataDir: paths ? paths.dataDir : null,
  logsDir: paths ? paths.logsDir : null,
  port: cfg ? cfg.port : null,
  tools: found ? {
    dreamina: found.dreamina.path, ffmpeg: found.ffmpeg.path, ffprobe: found.ffprobe.path
  } : null
}));
ipcMain.handle('app:openDataDir', () => (paths ? shell.openPath(paths.dataDir) : null));
ipcMain.handle('app:openLogs', () => (paths ? shell.openPath(paths.logsDir) : null));
ipcMain.handle('shell:showItem', (e, p) => {
  /* 只允许"在文件夹中显示"数据目录里的文件：渲染进程传来的路径一律不信任 */
  if (!insideDataDir(p)) { console.warn('[desktop] 拒绝显示数据目录之外的路径'); return false; }
  shell.showItemInFolder(path.resolve(String(p)));
  return true;
});
ipcMain.handle('shell:openExternal', (e, u) => { openExternalSafely(u); return true; });

/* 应用自更新。⚠ 令牌**只进不出**：update:setSource 接受它，
   但 update:status / setSource 的返回值都只给 hasToken 布尔值，
   不把已存的令牌回传给页面。 */
ipcMain.handle('update:status', () => updateStatusPayload());
ipcMain.handle('update:check', () => doCheckUpdates());
ipcMain.handle('update:download', () => doDownloadUpdate());
ipcMain.handle('update:install', () => doInstallUpdate());
ipcMain.handle('update:setSource', (e, patch) => {
  /* 白名单：渲染进程只能改这几个键，避免往配置文件里塞任意内容 */
  const allow = {};
  ['provider', 'owner', 'repo', 'token', 'url', 'dir'].forEach((k) => {
    if (patch && patch[k] !== undefined) allow[k] = String(patch[k]);
  });
  const next = setUpdateSource(allow);
  return next ? publicSource() : null;
});

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.on('second-instance', () => { showWindow(); });

  app.whenReady().then(boot).catch((e) => {
    console.error('[desktop] 启动失败：' + ((e && e.stack) || e));
    dialog.showErrorBox(PRODUCT + ' 启动失败', String((e && e.message) || e));
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    /* Windows 上关掉窗口就退出；但托盘驻留期间窗口只是 hide，不会走到这里。 */
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    requestQuit();
  });

  process.on('uncaughtException', (e) => {
    console.error('[desktop] 未捕获异常：' + ((e && e.stack) || e));
  });
  process.on('unhandledRejection', (e) => {
    console.error('[desktop] 未处理的 Promise 拒绝：' + ((e && e.stack) || e));
  });
}
