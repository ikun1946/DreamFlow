'use strict';
/* ============================================================
   13-image-key.test.js —— 桌面端生图密钥保管（阶段 3）

   验证目标（对应计划 §5.3 与验收清单）：
   1. 保存后能取回（往返正确）；
   2. **落盘是密文** —— 磁盘上搜不到明文；
   3. **加密不可用时不降级为明文**，且明确报 unavailable；
   4. status() 只回布尔状态，**不含**密钥材料；
   5. 删除后取不回、文件也不在；
   6. 密文损坏 / 换机器解不开时**当作未配置**，不抛错（否则会打挂接口）。

   全程使用**假的 safeStorage**（异或 + base64），不依赖 Electron。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { makeImageKeyStore, keyFilePath, FILE_NAME } = require('../desktop/image-key-store');

/* 假 safeStorage：可开关、可注入"解密失败"。
   注意它**不是**真加密，只用于断言"程序把加解密委托出去了、且盘上不是明文"。 */
function fakeSafeStorage(opts) {
  const o = opts || {};
  let available = o.available !== false;
  const MAGIC = 'FENC:';
  return {
    isEncryptionAvailable: () => available,
    setAvailable(v) { available = !!v; },
    encryptString(s) {
      if (!available) throw new Error('encryption unavailable');
      // 简单的可逆变换（够用来证明"盘上不是原文"）
      const b = Buffer.from(String(s), 'utf8');
      for (let i = 0; i < b.length; i++) b[i] = b[i] ^ 0x5A;
      return Buffer.from(MAGIC + b.toString('base64'), 'utf8');
    },
    decryptString(buf) {
      if (o.decryptThrows) throw new Error('decrypt failed');
      const raw = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      if (!raw.startsWith(MAGIC)) throw new Error('bad ciphertext');
      const b = Buffer.from(raw.slice(MAGIC.length), 'base64');
      for (let i = 0; i < b.length; i++) b[i] = b[i] ^ 0x5A;
      return b.toString('utf8');
    }
  };
}

function tmpStore(safeStorage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-imgkey-'));
  const file = path.join(dir, FILE_NAME);
  return {
    dir, file,
    store: makeImageKeyStore({ safeStorage, filePath: file, nowIso: () => '2026-09-25T00:00:00.000Z' })
  };
}

test('密钥往返：保存后能原样取回', () => {
  const ss = fakeSafeStorage();
  const { store, dir } = tmpStore(ss);
  const KEY = 'wf-abcdef1234567890';
  assert.strictEqual(store.hasKey(), false, '初始应无密钥');
  assert.deepStrictEqual(store.setKey(KEY), { ok: true });
  assert.strictEqual(store.hasKey(), true);
  assert.strictEqual(store.getKey(), KEY, '取回的必须是原文');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('落盘是密文：磁盘内容不含明文密钥', () => {
  const ss = fakeSafeStorage();
  const { store, file, dir } = tmpStore(ss);
  const KEY = 'SUPER-SECRET-KEY-should-not-appear-on-disk';
  store.setKey(KEY);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(KEY), 'db 文件里绝不能出现明文密钥');
  assert.ok(!Buffer.from(raw).includes(Buffer.from(KEY)), '二进制层面也不能出现');
  // 但内部确实存了东西（enc 字段非空）
  const obj = JSON.parse(raw);
  assert.strictEqual(obj.v, 1);
  assert.ok(typeof obj.enc === 'string' && obj.enc.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('加密不可用时：拒绝保存，且不落任何明文', () => {
  const ss = fakeSafeStorage({ available: false });
  const { store, file, dir } = tmpStore(ss);
  const r = store.setKey('some-key');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unavailable');
  assert.strictEqual(store.hasKey(), false);
  assert.strictEqual(fs.existsSync(file), false, '不可用时不得创建文件');
  assert.strictEqual(store.getKey(), '', '不可用时取回应为空');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('加密能力中途消失：已存的密钥视为未配置（不猜、不抛）', () => {
  const ss = fakeSafeStorage();
  const { store, dir } = tmpStore(ss);
  store.setKey('k1');
  assert.strictEqual(store.getKey(), 'k1');
  ss.setAvailable(false);
  assert.strictEqual(store.getKey(), '', '加密没了就不能解密，返回空而不是抛错');
  assert.strictEqual(store.hasKey(), true, '密文还在，所以 hasKey 仍为 true');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status() 只回布尔状态，不含任何密钥材料', () => {
  const ss = fakeSafeStorage();
  const { store, dir } = tmpStore(ss);
  store.setKey('my-secret-key');
  const st = store.status();
  assert.deepStrictEqual(Object.keys(st).sort(), ['encryption', 'hasKey']);
  assert.strictEqual(st.hasKey, true);
  assert.strictEqual(st.encryption, 'available');
  const serialized = JSON.stringify(st);
  assert.ok(!serialized.includes('my-secret-key'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('删除密钥：文件消失、取不回、状态归位', () => {
  const ss = fakeSafeStorage();
  const { store, file, dir } = tmpStore(ss);
  store.setKey('to-be-deleted');
  assert.strictEqual(fs.existsSync(file), true);
  assert.deepStrictEqual(store.clearKey(), { ok: true });
  assert.strictEqual(fs.existsSync(file), false, '删除后文件不应残留');
  assert.strictEqual(store.hasKey(), false);
  assert.strictEqual(store.getKey(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('空密钥被拒（不写空文件）', () => {
  const ss = fakeSafeStorage();
  const { store, file, dir } = tmpStore(ss);
  assert.strictEqual(store.setKey('').reason, 'empty');
  assert.strictEqual(store.setKey('   ').reason, 'empty', '纯空白也算空');
  assert.strictEqual(store.setKey(null).reason, 'empty');
  assert.strictEqual(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('密文损坏：getKey 返回空而不抛错（否则会打挂每次请求）', () => {
  const ss = fakeSafeStorage();
  const { store, file, dir } = tmpStore(ss);
  store.setKey('k');
  fs.writeFileSync(file, JSON.stringify({ v: 1, enc: 'not-valid-ciphertext' }));
  assert.doesNotThrow(() => store.getKey());
  assert.strictEqual(store.getKey(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件损坏 / 不存在：一律当作没配过，不抛错', () => {
  const ss = fakeSafeStorage();
  const { store, file, dir } = tmpStore(ss);
  assert.strictEqual(store.getKey(), '', '文件不存在时应返回空');
  assert.strictEqual(store.hasKey(), false);
  fs.writeFileSync(file, '{ 这不是 JSON');
  assert.strictEqual(store.hasKey(), false, '损坏文件应视为未配置');
  assert.strictEqual(store.getKey(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('无 safeStorage（纯 Node 环境）：视为加密不可用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-imgkey-'));
  const store = makeImageKeyStore({ safeStorage: null, filePath: path.join(dir, FILE_NAME) });
  assert.strictEqual(store.encryptionAvailable(), false);
  assert.strictEqual(store.setKey('k').reason, 'unavailable');
  assert.strictEqual(store.status().encryption, 'unavailable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('覆盖保存保留 createdAt、刷新 updatedAt', () => {
  const ss = fakeSafeStorage();
  let n = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-imgkey-'));
  const store = makeImageKeyStore({
    safeStorage: ss,
    filePath: path.join(dir, FILE_NAME),
    nowIso: () => new Date(Date.UTC(2026, 8, 25, 0, 0, n++)).toISOString()
  });
  store.setKey('first');
  const first = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
  store.setKey('second');
  const second = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
  /* 断言的是**关系**而不是具体值：nowIso 在一次 setKey 里可能被调用多次，
     写死下标会让测试变成"实现细节的复印件"（这个用例第一版就因此误报过）。 */
  assert.strictEqual(second.createdAt, first.createdAt, 'createdAt 应保留首次时间');
  assert.ok(second.updatedAt > first.updatedAt, 'updatedAt 应用新的时间');
  assert.strictEqual(store.getKey(), 'second');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keyFilePath 落在 userData 下（不是数据目录）', () => {
  const p = keyFilePath('C:\\Users\\x\\AppData\\Roaming\\即梦批量生成控制台');
  assert.ok(p.endsWith(FILE_NAME));
  assert.ok(p.includes('AppData'), '应位于 userData（Roaming）而非数据目录');
});
