'use strict';
/* ============================================================
   image-key-store.js —— 图片生图服务商 API Key 的桌面端保管

   职责单一：把一枚密钥**加密后**存进 userData 下的
   `image-provider-key.json`，读时解密返回；删除时连文件一起清掉。

   ★ 为什么单独一个模块、且**不 require electron**
   与 updater-transport.js 同一条理由：`safeStorage` 由调用方（main.js）
   传进来，模块本身只依赖 fs / path。这样才能用**假的 safeStorage**
   在纯 Node 下写单测（见 test/13-image-key.test.js）——
   main.js 起不了 Electron 就测不到，而"密钥不外泄"恰恰是最需要回归的规则。

   ★ 三条安全约定（计划 §5.3）
   1. **系统加密不可用时不降级为明文**。safeStorage.isEncryptionAvailable()
      为 false 时返回 { ok:false, reason:'unavailable' }，绝不把明文写盘。
      这条比"功能可用"重要 —— 明文密钥等价于泄露。
   2. **接口只进不出**。status() 只回 hasKey / encryption 状态，**没有**
      任何返回原密钥的方法（连 internal 也不给）。main.js 的 IPC 层同样
      只回布尔值；真正的取用只发生在 createServer 注入的读取函数内。
   3. 文件权限尽力收紧（Windows 下 chmod 语义有限，属尽力而为，不作为
      安全依据；真正的保护来自 safeStorage 的加密）。

   存储形状（明文 JSON 外壳，密文在内）：
     { v: 1, enc: "base64...", createdAt: "...", updatedAt: "..." }
   ============================================================ */
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'image-provider-key.json';

/* 默认文件名（供 main.js 拼路径用；测试里可传自己的路径） */
function keyFilePath(userDataDir) {
  return path.join(userDataDir, FILE_NAME);
}

function makeImageKeyStore(opts) {
  const o = opts || {};
  const safeStorage = o.safeStorage || null;
  const filePath = o.filePath;
  const nowIso = o.nowIso || (() => new Date().toISOString());

  /* 加密是否可用。safeStorage 缺失（纯 Node 环境）→ 一律视为不可用：
     绝不在"没有加密能力"时悄悄退回明文。 */
  function encryptionAvailable() {
    try {
      return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
        && safeStorage.isEncryptionAvailable());
    } catch (e) { return false; }
  }

  function readFileRaw() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return obj;
    } catch (e) { return null; }   // 不存在 / 损坏，都当作"没配过"
  }

  /* 是否有已保存的密钥（**不解密**，只看密文在不在）。
     页面用的就是这个 —— 它连密文都拿不到。 */
  function hasKey() {
    const obj = readFileRaw();
    return !!(obj && typeof obj.enc === 'string' && obj.enc.length > 0);
  }

  /* 给页面看的配置状态。⚠ 只有布尔值与原因，没有任何密钥材料。 */
  function status() {
    return {
      hasKey: hasKey(),
      encryption: encryptionAvailable() ? 'available' : 'unavailable'
    };
  }

  /* 保存密钥。返回 { ok, reason? }。
     ⚠ 加密不可用 → 直接拒绝，**不写明文**。 */
  function setKey(plain) {
    const key = String(plain == null ? '' : plain).trim();
    if (!key) return { ok: false, reason: 'empty' };
    if (!encryptionAvailable()) return { ok: false, reason: 'unavailable' };
    let enc;
    try {
      enc = safeStorage.encryptString(key).toString('base64');
    } catch (e) {
      /* 加密本身抛错（比如系统密钥库被锁）→ 同样拒绝，不留明文 */
      return { ok: false, reason: 'encrypt_failed', message: (e && e.message) || String(e) };
    }
    const prev = readFileRaw();
    const payload = {
      v: 1,
      enc,
      createdAt: (prev && prev.createdAt) || nowIso(),
      updatedAt: nowIso()
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (e) {
      return { ok: false, reason: 'write_failed', message: (e && e.message) || String(e) };
    }
    return { ok: true };
  }

  /* 取明文密钥。**仅供 createServer 注入的读取函数内部调用**，
     不得经由任何 IPC / HTTP 出口返回。 */
  function getKey() {
    const obj = readFileRaw();
    if (!obj || typeof obj.enc !== 'string' || !obj.enc.length) return '';
    if (!encryptionAvailable()) return '';        // 解密能力没了 → 视为未配置，不猜
    try {
      return safeStorage.decryptString(Buffer.from(obj.enc, 'base64'));
    } catch (e) {
      /* 密文解不开（换了机器 / 系统凭据被重置）→ 当作未配置，让用户重填。
         不抛错是因为它会在每次请求里被调用，抛错会把整个接口打挂。 */
      return '';
    }
  }

  /* 删除密钥：连文件一起删（不留密文残骸）。 */
  function clearKey() {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'delete_failed', message: (e && e.message) || String(e) };
    }
  }

  return { status, hasKey, setKey, getKey, clearKey, encryptionAvailable, filePath };
}

module.exports = { makeImageKeyStore, keyFilePath, FILE_NAME };
