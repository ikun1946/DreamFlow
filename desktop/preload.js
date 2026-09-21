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
     ⚠ setUpdateSource 的入参在主进程侧走白名单，这里不做信任假设。 */
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateSetSource: (patch) => ipcRenderer.invoke('update:setSource', patch)
};

contextBridge.exposeInMainWorld('JCDesktop', api);
