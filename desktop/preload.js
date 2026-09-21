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
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (u) => ipcRenderer.invoke('shell:openExternal', u),
  /* 应用自更新。同样是具名动作：页面不能借它做别的事。
     ⚠ setUpdateSource 的入参在主进程侧走白名单，这里不做信任假设。
     ⚠ onUpdateState 透出的只有主进程**主动推送的状态快照**（见 main.js
       broadcastUpdateState）。刻意不暴露任意 channel 的订阅 —— 那等于把
       ipcRenderer.on 交出去。回调只用第一个参数（主进程给的对象），
       不给 renderer 任何 event 句柄。 */
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateSetSource: (patch) => ipcRenderer.invoke('update:setSource', patch),
  onUpdateState: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, payload) => { try { cb(payload); } catch (e) { /* 页面回调异常不该影响主进程 */ } };
    ipcRenderer.on('update:state', h);
    return () => { try { ipcRenderer.removeListener('update:state', h); } catch (e) { /* 忽略 */ } };
  }
};

contextBridge.exposeInMainWorld('JCDesktop', api);
