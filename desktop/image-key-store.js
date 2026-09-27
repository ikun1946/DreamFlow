'use strict';
/* ============================================================
   image-key-store.js —— 多 provider API Key 的桌面端保管（0.42.0）

   职责单一：把每枚密钥**加密后**存进 userData 下的
   `image-provider-key-{providerId}.json`，读时解密返回；删除时连文件一起清掉。

   ★ 为什么单独一个模块、且**不 require electron**
   与 updater-transport.js 同一条理由：`safeStorage` 由调用方（main.js）
   传进来，模块本身只依赖 fs / path。这样才能用**假的 safeStorage**
   在纯 Node 下写单测（见 test/13-image-key.test.js）——
   main.js 起不了 Electron 就测不到，而"密钥不外泄"恰恰是最需要回归的规则。

   ★ 文件命名约定（0.42.0）：
     `image-provider-key-{providerId}.json`
     每个 provider 一份，互不影响（删 OpenAI 不会动 Work Fisher）。
   ★ 旧 v=1 单文件迁移（0.41.x）：
     启动时检测到 `image-provider-key.json`（旧路径 + 旧 v=1 内容），
     一次性把它迁到 `image-provider-key-work-fisher.json`，并删除旧文件。
     迁移失败时**保留**旧文件不动 + 日志告警，绝不删除未读懂的文件。

   ★ 三条安全约定（沿用 0.41.x）
   1. **系统加密不可用时不降级为明文**。safeStorage.isEncryptionAvailable()
      为 false 时返回 { ok:false, reason:'unavailable' }，绝不把明文写盘。
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

const LEGACY_FILE_NAME = 'image-provider-key.json';   /* 0.41.x 唯一文件名 */
const FILE_NAME_PREFIX = 'image-provider-key-';      /* 0.42.0 起按 provider 分文件 */

/* 默认文件名（供 main.js 拼路径用；测试里可传自己的路径）
   ⚠ 0.41.x 兼容：1-arg 调用视为 work-fisher 的**旧**文件名（旧测试就这样用）。 */
function keyFilePath(userDataDir, providerId) {
  if (arguments.length === 1) return path.join(userDataDir, LEGACY_FILE_NAME);
  return path.join(userDataDir, FILE_NAME_PREFIX + providerId + '.json');
}
function legacyKeyFilePath(userDataDir) {
  return path.join(userDataDir, LEGACY_FILE_NAME);
}

/* 已知 providerId 列表（0.42.0）：用于 statusList() 列出所有 provider 的状态，
   即使对应文件不存在（未配）。 */
function knownProviderIds() {
  /* 不 require image-registry（避免循环依赖 + 让该模块可独立单测）：
     这里手写一份与 server/image-registry.js 完全同步的列表。
     真要新加 provider，请**两处同步**。 */
  return ['work-fisher', 'openai', 'stability'];
}

function makeImageKeyStore(opts) {
  const o = opts || {};
  const safeStorage = o.safeStorage || null;
  /* 兼容 0.41.x 旧调用：传 filePath 视为 work-fisher 的具体文件路径。
     新调用：传 userDataDir + 后续调用都带 providerId。 */
  let userDataDir = o.userDataDir;
  let legacyFilePath = null;        /* 0.41.x 兼容：旧单文件路径 */
  if (!userDataDir && o.filePath) {
    legacyFilePath = o.filePath;
    /* 不重构 userDataDir —— legacyFilePath 直接被当作 work-fisher provider 的文件 */
    userDataDir = path.dirname(o.filePath);
  }
  const defaultProviderId = o.defaultProviderId || 'work-fisher';
  const nowIso = o.nowIso || (() => new Date().toISOString());

  /* 加密是否可用。safeStorage 缺失（纯 Node 环境）→ 一律视为不可用：
     绝不在"没有加密能力"时悄悄退回明文。 */
  function encryptionAvailable() {
    try {
      return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
        && safeStorage.isEncryptionAvailable());
    } catch (e) { return false; }
  }

  function readFileRaw(p) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return obj;
    } catch (e) { return null; }   // 不存在 / 损坏，都当作"没配过"
  }

  function resolveFile(providerId) {
    /* 0.41.x 兼容：legacyFilePath → work-fisher 专用 */
    if (legacyFilePath && (providerId || defaultProviderId) === 'work-fisher') return legacyFilePath;
    return keyFilePath(userDataDir, providerId || defaultProviderId);
  }

  /* 是否有已保存的密钥（**不解密**，只看密文在不在）。
     页面用的就是这个 —— 它连密文都拿不到。 */
  function hasKey(providerId) {
    providerId = providerId || defaultProviderId;
    const p = resolveFile(providerId);
    const obj = readFileRaw(p);
    return !!(obj && typeof obj.enc === 'string' && obj.enc.length > 0);
  }

  /* 给页面看的配置状态。⚠ 只有布尔值与原因，没有任何密钥材料。 */
  function status(providerId) {
    providerId = providerId || defaultProviderId;
    return {
      hasKey: hasKey(providerId),
      encryption: encryptionAvailable() ? 'available' : 'unavailable'
    };
  }

  /* 列出所有已知 provider 的状态 —— 给设置页用 */
  function statusList() {
    return knownProviderIds().map((id) => Object.assign({ providerId: id }, status(id)));
  }

  /* 保存密钥。返回 { ok, reason? }。
     ⚠ 加密不可用 → 直接拒绝，**不写明文**。 */
  function setKey(providerId, plain) {
    /* 0.41.x 兼容：1-arg 调用 → 把第一参当 plain，第二参当 undefined */
    if (arguments.length === 1) { plain = providerId; providerId = defaultProviderId; }
    providerId = providerId || defaultProviderId;
    if (!providerId) return { ok: false, reason: 'missing_provider' };
    const key = String(plain == null ? '' : plain).trim();
    if (!key) return { ok: false, reason: 'empty' };
    if (!encryptionAvailable()) return { ok: false, reason: 'unavailable' };
    let enc;
    try {
      enc = safeStorage.encryptString(key).toString('base64');
    } catch (e) {
      return { ok: false, reason: 'encrypt_failed', message: (e && e.message) || String(e) };
    }
    const fp = resolveFile(providerId);
    const prev = readFileRaw(fp);
    const payload = {
      v: 1,
      enc,
      createdAt: (prev && prev.createdAt) || nowIso(),
      updatedAt: nowIso()
    };
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, fp);
    } catch (e) {
      return { ok: false, reason: 'write_failed', message: (e && e.message) || String(e) };
    }
    return { ok: true };
  }

  /* 取明文密钥。**仅供 createServer 注入的读取函数内部调用**，
     不得经由任何 IPC / HTTP 出口返回。 */
  function getKey(providerId) { providerId = providerId || defaultProviderId;
    const fp = resolveFile(providerId);
    const obj = readFileRaw(fp);
    if (!obj || typeof obj.enc !== 'string' || !obj.enc.length) return '';
    if (!encryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(obj.enc, 'base64'));
    } catch (e) {
      return '';
    }
  }

  /* 删除密钥：连文件一起删（不留密文残骸）。 */
  function clearKey(providerId) {
    /* 0.41.x 兼容：0-arg 调用 → 用默认 provider */
    providerId = providerId || defaultProviderId;
    if (!providerId) return { ok: false, reason: 'missing_provider' };
    const fp = resolveFile(providerId);
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'delete_failed', message: (e && e.message) || String(e) };
    }
  }

  /* ⚠ 0.41.x → 0.42.0 一次性迁移：把旧的单文件 image-provider-key.json 移到
     image-provider-key-work-fisher.json。条件：
       ① 旧文件存在；
       ② 新文件不存在（避免重复迁移）；
       ③ 旧文件能解密（"明文或可解密的密文"）。
     失败时保留旧文件 + 返回 { migrated:false, reason }；**绝不**删除未读懂的文件。 */
  function migrateLegacy() {
    const legacy = legacyKeyFilePath(userDataDir);
    if (!fs.existsSync(legacy)) return { migrated: false, reason: 'no_legacy' };
    const target = keyFilePath(userDataDir, 'work-fisher');
    if (fs.existsSync(target)) {
      /* 目标已存在 —— 不要擅自删除；让用户/测试自己处理。
         但旧文件仍属于"孤儿"（无引用），安全做法是把它改名（不删内容）到 .migrated。 */
      try {
        fs.renameSync(legacy, legacy + '.migrated-skip-' + Date.now());
        return { migrated: false, reason: 'target_exists_legacy_archived' };
      } catch (e) {
        return { migrated: false, reason: 'target_exists', message: (e && e.message) || String(e) };
      }
    }
    /* 读旧文件、解密、落到新路径 */
    const obj = readFileRaw(legacy);
    if (!obj || typeof obj.enc !== 'string') return { migrated: false, reason: 'legacy_unreadable' };
    if (!encryptionAvailable()) return { migrated: false, reason: 'unavailable' };
    let plain = '';
    try { plain = safeStorage.decryptString(Buffer.from(obj.enc, 'base64')); }
    catch (e) { return { migrated: false, reason: 'legacy_decrypt_failed' }; }
    if (!plain) return { migrated: false, reason: 'legacy_empty_after_decrypt' };
    const r = setKey('work-fisher', plain);
    if (!r || !r.ok) return { migrated: false, reason: r ? r.reason : 'set_failed' };
    /* 旧文件成功迁移后删除 —— 此时我们刚把密钥重新加密写到新文件，旧文件已无引用。 */
    try { fs.unlinkSync(legacy); }
    catch (e) { /* 删不掉旧文件也不影响功能；下次启动 migrateLegacy 会再次尝试 */
      return { migrated: true, reason: 'ok_unlink_failed', message: (e && e.message) || String(e) };
    }
    return { migrated: true };
  }

  return {
    status, statusList, hasKey, setKey, getKey, clearKey, migrateLegacy,
    encryptionAvailable,
    filePath: (providerId) => keyFilePath(userDataDir, providerId),
    legacyFilePath: () => legacyKeyFilePath(userDataDir)
  };
}

module.exports = {
  makeImageKeyStore,
  keyFilePath, legacyKeyFilePath, FILE_NAME_PREFIX, LEGACY_FILE_NAME,
  knownProviderIds,
  /* 0.41.x 别名：旧测试用 FILE_NAME = image-provider-key.json */
  FILE_NAME: LEGACY_FILE_NAME
};