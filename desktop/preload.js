'use strict';
/* ============================================================
   preload.js —— 渲染进程与主进程之间的最小桥

   原则：只暴露**具名、参数可控**的几个动作，不暴露 ipcRenderer 本身，
   更不暴露 Node / Electron 对象。渲染页面是普通网页（sandbox + contextIsolation），
   即使页面里被塞进恶意脚本，也只能调用这里列出的东西。

   ⚠ 所有路径类入参在主进程侧还会再校验一次（必须落在数据目录内），
   这里不做"信任前端"的假设。
   ============================================================ */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  isDesktop: true,
  platform: (process && process.platform) || 'win32',
  info: () => ipcRenderer.invoke('app:info'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  /* 选目录与重启（2026-09-23 新增，为设置里的"数据目录"服务）。
     ⚠ 这两个动作只在**主进程**执行，页面拿不到任意路径/句柄：
       chooseDirectory 只回传用户在系统对话框里**亲自选中**的那个路径；
       relaunch 不带任何参数，页面无法借它执行别的命令。 */
  chooseDirectory: (defaultPath) => ipcRenderer.invoke('app:chooseDirectory', defaultPath),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (u) => ipcRenderer.invoke('shell:openExternal', u),
  /* 应用自更新。同样是具名动作：页面不能借它做别的事。
     ⚠ 2026-09-23：`updateSetSource` 已随「更新源设置」功能一并移除 ——
       更新源不再由界面配置（固定读本机配置文件 `desktop-config.json`，缺省 github）。
       桥面上少一个"能改写配置"的入口，是这次移除最实在的收益。
     ⚠ onUpdateState 透出的只有主进程**主动推送的状态快照**（见 main.js
       broadcastUpdateState）。刻意不暴露任意 channel 的订阅 —— 那等于把
       ipcRenderer.on 交出去。回调只用第一个参数（主进程给的对象），
       不给 renderer 任何 event 句柄。 */
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, payload) => { try { cb(payload); } catch (e) { /* 页面回调异常不该影响主进程 */ } };
    ipcRenderer.on('update:state', h);
    return () => { try { ipcRenderer.removeListener('update:state', h); } catch (e) { /* 忽略 */ } };
  },
  /* 图片生图密钥（2026-09-25 阶段 3）。
     ★ 只有这三个动作，且**没有 getKey** —— 密钥存进去就拿不回来。
       keyStatus 只回 { hasKey, encryption } 布尔状态；
       setKey 收明文（单向），clearKey 只删除。
     这样即使页面被塞进恶意脚本，也只能"写入/删除"，读不到已存的密钥。 */
  imageKeyStatus: () => ipcRenderer.invoke('image:keyStatus'),
  imageSetKey: (plain) => ipcRenderer.invoke('image:setKey', plain),
  imageClearKey: () => ipcRenderer.invoke('image:clearKey')
};

contextBridge.exposeInMainWorld('JCDesktop', api);
