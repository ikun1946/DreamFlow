/* ============================================================
   asset-lock.js —— 素材「图号」与提示词绑定的**唯一事实来源**
   ------------------------------------------------------------
   背景（2026-09-18）：
     `--image` 参数只负责把本地文件传上去，它本身不带语义；
     图片编号 = 上传顺序 = 该分镜「已绑定素材」的顺序。
     若提示词里不写 `@图片N`，模型只知道"有几张图"，
     不知道哪张是角色、哪张是场景 —— 只能按位置猜。
     实测分镜 st_a1637037 的提示词里 @图片 引用数为 **0**。

   本模块提供四件事，供所有组装提示词的地方共用（不得各自实现）：
     1) imageCatalog(sb, db)  —— 图号表；顺序与创作 CLI 的 `--image` **严格一致**
     2) lockBlock(images, sb) —— 「素材锁定」区块文本
     3) compose(prompt, block) —— 组装最终提示词（原文一字不改，只在开头追加）
     4) validate(prompt, images) —— 校验 @图片N 越界 / 裸 asset id / 未内联引用

   铁律：**只补不改**。正文（台词、镜序、秒数、人物、场景）一个字都不动，
   只在最前面追加区块；因此本模块永远不会返回被改写过的原文。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./paths');   // 素材文件的磁盘位置（按项目分区）

/* 素材类型 → 中文职责标签（与前端素材面板的 tab 命名保持一致） */
const ROLE_LABEL = {
  character: '角色', scene: '场景', prop: '道具',
  firstFrame: '首帧图', storyboard: '分镜图',     // 2026-09-20：各自独立的资产库，不再借用场景库
  audio: '音频'
};

/* 从提示词里抓角色的「实例特征」锚点：如 `奶团（奶白短毛、黑鼻头、垂耳）`
   只取第一个括号内的短描述（≤ 40 字且不含换行），抓不到就返回 null。 */
function instanceFeatures(prompt, name) {
  if (!name) return null;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(prompt || '').match(new RegExp(esc + '\\s*[（(]([^）)\\n]{2,40})[）)]'));
  return m ? m[1].trim() : null;
}

/* 文件存在性缓存：列表接口每次轮询都会对每条分镜的每个绑定做一次判断，
   直接 stat 太浪费；5s TTL 足够（素材增删是低频操作）。 */
const _exists = new Map();
const EXISTS_TTL = 5000;
function existsCached(file) {
  const now = Date.now();
  const hit = _exists.get(file);
  if (hit && now - hit.at < EXISTS_TTL) return hit.ok;
  let ok = false;
  try { ok = fs.existsSync(file); } catch (e) { ok = false; }
  if (_exists.size > 800) _exists.clear();
  _exists.set(file, { at: now, ok });
  return ok;
}

/* 单个素材「会不会占一个图号」—— 计入条件与 imageCatalog 完全同源
   （非音频 + 本地文件在）。供**配额计算**复用：不占号的绑定不该消耗名额，
   否则会出现"明明只发了 8 张，却说已到 9 张上限"。
   入参 role 可选（新绑定时 role 通常等于 asset.type，但 firstFrame/storyboard 槽位
   绑的是场景素材，此时按 role 判是否算音频更准）。 */
function countsAsImage(db, asset, role) {
  if (!asset) return false;
  if (asset.type === 'audio' || role === 'audio') return false;
  const file = P.assetFileOf(asset);
  return file ? existsCached(file) : false;
}

/**
 * 图号表。**这是图号的唯一定义处**——创作 CLI 的 `--image` 顺序必须取自这里，
 * 否则命令行里的第 N 张图与提示词里的「图片N」会错位。
 *
 * 计入图号的条件（与 `--image` 完全一致）：
 *   ① 分镜上确有该绑定；② 素材存在；③ 不是音频（音频走 --audio，不占图片号）；
 *   ④ 本地文件确实存在（发不出去的图不能占号，否则后面全部错位）。
 *
 * @returns {{images: Array, skipped: Array, audios: Array}}
 */
function imageCatalog(sb, db) {
  const images = [];
  const skipped = [];
  const audios = [];
  (sb && sb.assets ? sb.assets : []).forEach((ref) => {
    const a = (db && db.assets ? db.assets : []).find((x) => x.id === ref.assetId);
    if (!a) { skipped.push({ assetId: ref.assetId, name: ref.assetId, reason: '素材已不存在' }); return; }
    const file = P.assetFileOf(a);
    if (!file) {
      skipped.push({ assetId: a.id, name: a.name, type: a.type, reason: '素材没有可用的本地文件' });
      return;
    }
    const exists = existsCached(file);
    if (a.type === 'audio' || ref.role === 'audio') {
      /* durationSec 一并带出：派发前要核「音频总时长上限」（dreamina-cli 的兜底检查），
         它需要**真正会发出**的那几条的时长。null = 未知，调用方据此明确失败而不是当成 0。 */
      if (exists) audios.push({ assetId: a.id, name: a.name, file, durationSec: Number.isFinite(a.durationSec) ? a.durationSec : null });
      else skipped.push({ assetId: a.id, name: a.name, type: 'audio', reason: '音频文件已丢失' });
      return;
    }
    if (!exists) { skipped.push({ assetId: a.id, name: a.name, type: a.type, reason: '图片文件已丢失' }); return; }
    images.push({
      n: images.length + 1,                 // ← 图号在这里诞生，别在别处算
      assetId: a.id, name: a.name,
      type: a.type, role: ref.role || a.type,
      roleLabel: ROLE_LABEL[ref.role || a.type] || (ref.role || a.type),
      file,
      via: ref.via || null                  // 绑定来源：auto（自动匹配）/ null（手工）
    });
  });
  return { images, skipped, audios };
}

/**
 * 生成「素材锁定」区块。一图一职；角色只取外形、明确忽略参考图的静止姿势
 * （防模型直接把参考图的站姿/机位搬进片子），场景只取环境光线。
 */
function lockBlock(images, sb) {
  if (!images || !images.length) return '';
  const prompt = (sb && sb.prompt) || '';
  const lines = ['【素材锁定｜按本命令 --image 的上传顺序编号；本区块只作补充，不改动下方分镜文字】'];

  images.forEach((im) => {
    const head = '图片' + im.n + ' = ' + im.name + '（' + im.roleLabel + '）';
    if (im.role === 'character' || im.type === 'character') {
      const feat = instanceFeatures(prompt, im.name);
      lines.push(head + ' → 记为 <主体' + im.n + '>@图片' + im.n + (feat ? '，实例特征：' + feat + '。' : '。'));
      lines.push('   只取外形（毛色 / 头型 / 五官 / 体型比例），忽略参考图中的静止姿势与机位（这是最容易出错的地方）；片中该角色的一切动作、表情、朝向以分镜文字为准。');
    } else if (im.role === 'scene' || im.type === 'scene') {
      lines.push(head + ' → 场景来源参照 @图片' + im.n + '。');
      lines.push('   只取场地、环境、陈设、光线与色调；参考图中的人物 / 动物一律忽略，不得替换片中主体。');
    } else if (im.role === 'prop' || im.type === 'prop') {
      lines.push(head + ' → 道具来源参照 @图片' + im.n + '。');
      lines.push('   只取外形、材质与配色；忽略参考图中的持握方式与静止摆放，道具姿态随分镜动作变化。');
    } else {
      lines.push(head + ' → 参照来源 @图片' + im.n + '（仅取' + im.roleLabel + '相关特征）。');
    }
  });

  /* 建立「文字 ↔ 图号」的对应：不改正文，但告诉模型正文里的名字指哪张图 */
  const names = images.filter((i) => i.role !== 'audio').map((i) => '「' + i.name + '」= 图片' + i.n);
  if (names.length) lines.push('对上：分镜文字里出现的 ' + names.join('、') + '；同一主体在全片中保持同一外形，不得前后换脸 / 换犬种 / 换场地。');
  lines.push('禁止：不得用参考图的静止姿势代替分镜要求的动作；不得把参考图中的其他元素当作主体；不得参考图之间的特征互相串用。');

  return lines.join('\n');
}

/**
 * 组装最终提示词 = 锁定区块 + 原文。原文一字不改（含换行与标点）。
 * 区块放在最前面：视频模型对开头指令的权重更高。
 */
function compose(prompt, block) {
  const p = String(prompt == null ? '' : prompt);
  if (!block) return p;
  return block + '\n' + p;
}

/**
 * 指纹：提示词 + 图号表 + 生成参数。
 * 干跑记录落盘时带上它，读取时比对即可判断「这条干跑记录是否已过期」
 * （提示词被改、绑定被增删、参数被改之后，旧记录里的命令就不再代表实际会执行的命令）。
 */
function signature(sb, db) {
  const cat = imageCatalog(sb, db);
  const raw = [
    String(sb.prompt || ''),
    cat.images.map((x) => x.n + ':' + x.assetId + ':' + x.name).join(','),
    cat.audios.map((x) => x.assetId).join(','),
    String(sb.model || ''), String(sb.durationSec), String(sb.ratio || ''), String(sb.resolution || '')
  ].join('|');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = (((h * 33) >>> 0) ^ raw.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + raw.length;
}

/**
 * 校验提示词里的引用是否自洽。
 * @returns {Array<{level:'warn'|'info', code:string, message:string}>}
 */
function validate(prompt, images, opts) {
  const text = String(prompt == null ? '' : prompt);
  const issues = [];
  const max = (images || []).length;
  const o = opts || {};

  // ① @图片N / @视频N / @音频N 的越界检查（图片维度是本次重点）
  const refs = [];
  const re = /@(图片|视频|音频)\s*(\d+)/g;
  let m;
  while ((m = re.exec(text))) refs.push({ kind: m[1], n: Number(m[2]) });
  const imgRefs = refs.filter((r) => r.kind === '图片');
  const outOfRange = imgRefs.filter((r) => !(r.n >= 1 && r.n <= max));
  outOfRange.forEach((r) => issues.push({
    level: 'warn', code: 'REF_OUT_OF_RANGE',
    message: '提示词里引用了 @图片' + r.n + '，但本次实际只会发出 ' + max + ' 张图 —— 该引用越界（多半是绑定被增删后图号漂移了），模型会把它当无效指令。'
  }));
  const dup = {};
  imgRefs.forEach((r) => { dup[r.n] = (dup[r.n] || 0) + 1; });

  // ② 裸素材 id：模型无法关联无语义 id
  const bare = text.match(/\bas_[0-9a-zA-Z]{6,}\b/g);
  if (bare) issues.push({
    level: 'warn', code: 'BARE_ASSET_ID',
    message: '提示词里出现了裸素材 id（' + [...new Set(bare)].join('、') + '）——底层模型无法关联无语义 id，请改用 @图片N 桥接。'
  });

  // ③ 完全没有内联引用：不算错，但要说清"靠自动追加的锁定区块兜底"
  if (max && !imgRefs.length) issues.push({
    level: 'info', code: 'NO_INLINE_REF',
    message: '提示词没有内联引用任何 @图片N —— 本次由图号表自动追加「素材锁定」区块建立对应关系（图片1 = ' +
      (images[0] ? images[0].name : '—') + ' …）。想要更强绑定，可在文字里直接写 @图片N。'
  });

  // ④ 被截断 / 未计入图号的绑定
  if (o.truncated) issues.push({
    level: 'warn', code: 'IMAGE_TRUNCATED',
    message: '绑定的图片数超出该模型上限，只有前 ' + max + ' 张会发出（图号也只算这 ' + max + ' 张）。'
  });
  (o.skipped || []).forEach((s) => issues.push({
    level: 'warn', code: 'ASSET_SKIPPED',
    message: '素材「' + s.name + '」未计入图号：' + s.reason + '。'
  }));

  // ⑤ 有图，但文字里既没有 @图片N、也没出现任何素材名
  //    → 无法在上文建立「名字 ↔ 图号」的对应，只能靠锁定区块的编号
  const nameHit = max && images.some((im) => im.name && text.includes(im.name));
  if (max && imgRefs.length === 0 && !nameHit) issues.push({
    level: 'info', code: 'NO_NAME_HINT',
    message: '提示词里既没有 @图片N 引用、也没有出现任何素材名 —— 模型只能靠锁定区块的编号对应，建议在文字中提到主体名。'
  });

  return issues;
}

module.exports = { ROLE_LABEL, instanceFeatures, countsAsImage, imageCatalog, lockBlock, compose, validate, signature };
