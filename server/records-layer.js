'use strict';
/* ============================================================
   records-layer.js —— 生成记录的服务层（阶段 2.6 拆分自 services.js）

   为什么单独抽出来（2026-09-22 阶段 2.6）：
     · 原有 services.js 2334 行，跨"作用域 / 提交 / 素材 / 选项 / 适配器 /
       记录"五个域，单文件已超过 P2-5 的 ≤2500 行门禁。
     · 记录域是**自包含**的一组 —— 只用 `REC.*` 与一个内部工具 `findSb`、
       `plannedEngineFor`，不依赖其他业务逻辑。
     · 抽出来之后 services.js 约 2280 行（已过 2500 的边界），后续再按需拆分。

   ⚠ 这是 services.js 的 **拆分**，不是行为变更：
     · 公共 API 完全相同 —— routes.js 仍然 require('./services').<name> 拿到；
     · 私有工具（plannedEngineFor / findSb）走 require('./services') 拉回来；
     · 测试（test/02-task-logic.test.js）继续走同一个入口，行为不变。

   ⚠ 与 records.js（数据层）的区别：
     · server/records.js —— 快照生成 / 列表 / 清理 / 导出，是数据落地层；
     · server/records-layer.js —— 项目作用域校验 / 跨项目读记录拒掉 / 详情补齐，
       是 services 的"业务规则"层。
   ============================================================ */
const REC = require('./records');
const { ApiError, ERR } = require('./util');
const services = require('./services');   // 复用 plannedEngineFor / findSb

/* ---------------- 生成记录（项目作用域） ----------------
   记录属于**项目**（指令 §7/§13）。作用域由后端注入查询条件，绝不依赖前端过滤（§29）。
   ⚠ 记录里的 projectName / workspaceName 是**生成时刻的快照**，不是现查 ——
     项目改名或软删后，旧记录仍显示当时的名字（§47）。 */
function listRecords(db, q, scope) {
  return REC.listRecords(db, Object.assign({}, q, { projectId: scope.projectId }));
}

function getRecordDetail(db, id, scope) {
  const r = REC.getRecord(db, id);
  if (!r) throw new ApiError(ERR.NOTFOUND, '生成记录不存在（可能已被清理）');
  /* 跨项目读记录必须拒绝：记录里含完整提示词、命令与产物地址 */
  if (r.projectId && r.projectId !== scope.projectId) {
    throw new ApiError(ERR.NOTFOUND, '生成记录不属于当前项目：' + id);
  }
  const sb = services.findSb(db, r.storyboardId);
  return Object.assign({}, r, {
    // 中文标签：列表走 records.lite() 会带，详情直接返回原记录，这里补齐
    actionLabel: REC.ACTION_LABEL[r.action] || r.action,
    outcomeLabel: REC.OUTCOME_LABEL[r.outcome] || r.outcome,
    // 分镜是否还在：只影响"能否跳回分镜"，不影响记录本身的完整性
    storyboardExists: !!sb,
    storyboardStatus: sb ? sb.status : null,
    storyboardCurrentModel: sb ? sb.model : null,
    // 若现在重跑，会走哪条链路（记录里的 engine 是当时的真实事实，两者不同属正常）
    currentEngine: sb ? services.plannedEngineFor(db, sb).engine : null
  });
}

function deleteRecord(db, id, scope) {
  const r = REC.getRecord(db, id);
  if (!r) throw new ApiError(ERR.NOTFOUND, '生成记录不存在（可能已被清理）');
  if (r.projectId && r.projectId !== scope.projectId) {
    throw new ApiError(ERR.NOTFOUND, '生成记录不属于当前项目：' + id);
  }
  const out = REC.deleteRecord(db, id);
  if (!out.removed) throw new ApiError(ERR.NOTFOUND, '生成记录不存在（可能已被清理）');
  return out;
}

/* 清空记录。⚠ 原实现的 {all:true} 会清掉**所有项目**的历史，多项目之后这是数据事故：
   现在只在本项目内清理。口径仍然要求显式给出（ids / before / action / all）。 */
function clearRecords(db, body, scope) {
  const b = Object.assign({}, body || {});
  const all = Array.isArray(db.records) ? db.records : [];
  const mine = all.filter((r) => r && (!r.projectId || r.projectId === scope.projectId));
  const foreignCount = all.length - mine.length;

  if (Array.isArray(b.ids) && b.ids.length) {
    /* 只允许删本项目的记录 */
    const allowed = new Set(mine.filter((r) => b.ids.includes(r.id)).map((r) => r.id));
    if (allowed.size !== b.ids.length) {
      throw new ApiError(ERR.NOTFOUND, '有 ' + (b.ids.length - allowed.size) + ' 条记录不属于当前项目，未做任何改动');
    }
  }
  const out = REC.clearRecords(db, Object.assign({}, b, { projectId: scope.projectId }));
  if (!out.removed && out.message) throw new ApiError(ERR.PARAM, out.message);
  if (foreignCount) out.note = '仅清理当前项目的记录；另有 ' + foreignCount + ' 条属于其它项目，未受影响';
  return out;
}

function exportRecords(db, q, format, scope) {
  return REC.exportRecords(db, Object.assign({}, q, { projectId: scope.projectId }), format);
}

module.exports = { listRecords, getRecordDetail, deleteRecord, clearRecords, exportRecords };