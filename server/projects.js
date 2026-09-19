'use strict';
/* ============================================================
   projects.js —— Project / Workspace 数据层与**作用域解析的唯一出口**

   两条不可违反的规则（指令 §3.1 / §3.2 / §3.4 / §34）：
   1. **Project 是数据隔离边界**：不同项目之间的 Workspace / Storyboard / Asset /
      记录 / CLI 任务上下文互不可见。Asset 属于 Project，因此同一项目内的所有
      Workspace 天然共享它（§3.3）。
   2. **后端不存在"当前项目"全局变量**。作用域必须 request-scoped —— 每个请求
       显式携带 projectId / workspaceId，由 resolveScope() 校验后交给业务层。
       本文件**刻意不导出任何 setCurrent/current 之类的接口**，避免后来者引入全局态。

   Asset 的归属只有 projectId，**没有 workspaceId**（指令 §11）——
   加了会破坏"项目内资产共享"这个核心需求。

   删除策略：第一版一律**软删除**（deletedAt），不做级联物理销毁（指令 §44/§45）。
   软删的项目/工作区默认不出现在任何查询里，但底层数据完整保留，记录仍可回溯。
   ============================================================ */
const { ERR, ApiError, rid, nowIso } = require('./util');
const { LEGACY_PROJECT_ID, LEGACY_WORKSPACE_ID } = require('./schema');
const store = require('./store');

/* ⚠ 本文件**所有会改动 db 的函数都必须调用 store.save()**。
   漏掉的后果不是报错，而是"内存里改了、磁盘上没改" —— 接口读得到（同一进程读的是同一个对象），
   重启就全丢。2026-09-19 实测踩到：软删除项目后 db.json 里 deletedAt 仍是 null，
   而 /projects 列表却已经把它过滤掉了（因为过滤读的是内存）。
   ⚠ 现有单测**抓不到这一类问题**：隔离测试把 store.save 换成了空实现，
   所以"有没有请求落盘"必须单独断言（见 project-isolation.test.js 的落盘用例）。 */
const save = () => store.save();

const NAME_MAX = 60;

/* ---------------- 基础查询（一律排除软删） ---------------- */
const aliveProjects = (db) => (db.projects || []).filter((p) => p && !p.deletedAt);
const aliveWorkspaces = (db) => (db.workspaces || []).filter((w) => w && !w.deletedAt);

function projectOf(db, id) {
  if (!id) return null;
  return (db.projects || []).find((p) => p && p.id === id && !p.deletedAt) || null;
}
function workspaceOf(db, id) {
  if (!id) return null;
  return (db.workspaces || []).find((w) => w && w.id === id && !w.deletedAt) || null;
}

/* 工作区的权威项目归属（指令 §10.1：workspace.projectId 是权威来源） */
function projectOfWorkspace(db, workspaceId) {
  const ws = workspaceOf(db, workspaceId);
  return ws ? projectOf(db, ws.projectId) : null;
}
function workspaceOfStoryboard(db, sb) {
  if (!sb) return null;
  return workspaceOf(db, sb.workspaceId) || null;
}
function projectOfStoryboard(db, sb) {
  const ws = workspaceOfStoryboard(db, sb);
  return ws ? projectOf(db, ws.projectId) : null;
}

/* 项目的默认工作区（UI 上叫「分镜表」）：新建第一张时由 createWorkspace 补上；迁移时指向 ws_1。
   旧式扁平路由（不带 workspaceId 的 /storyboards/*）靠它落到一个确定的工作区。 */
function defaultWorkspaceOf(db, project) {
  if (!project) return null;
  const byId = workspaceOf(db, project.defaultWorkspaceId);
  if (byId) return byId;
  /* 兜底：默认工作区被删了，就取该项目下最早建的那个，保证扁平路由仍可用 */
  const list = aliveWorkspaces(db).filter((w) => w.projectId === project.id)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return list[0] || null;
}

/* ---------------- 作用域解析（唯一出口） ----------------
   入参三种组合：
     { workspaceId }              只给工作区 → 项目由工作区推导
     { projectId }                只给项目   → 工作区取默认工作区
     { projectId, workspaceId }   都给       → 校验父子一致，不一致直接拒（指令 §31）
     都不给                        旧式扁平请求 → 落到旧项目/旧工作区（向后兼容）

   ⚠ 父子不一致必须**拒绝并返回 404**，不能"以某个为准"糊过去 ——
     否则 Project A + Workspace B 会读到 B 的数据，正是隔离要防的事。 */
function resolveScope(db, opts) {
  const o = opts || {};
  let project = null, workspace = null;

  if (o.workspaceId) {
    workspace = workspaceOf(db, o.workspaceId);
    if (!workspace) throw new ApiError(ERR.NOTFOUND, '工作区不存在或已删除：' + o.workspaceId);
    project = projectOf(db, workspace.projectId);
    if (!project) throw new ApiError(ERR.NOTFOUND, '该工作区所属的项目不存在或已删除（工作区 ' + workspace.id + '）');
    /* 两个都给了：必须一致。不一致时按"资源不存在"处理（不泄露对方是否存在） */
    if (o.projectId && o.projectId !== project.id) {
      throw new ApiError(ERR.NOTFOUND,
        '工作区 ' + workspace.id + ' 不属于项目 ' + o.projectId + '（父子关系不匹配）');
    }
  } else if (o.projectId) {
    project = projectOf(db, o.projectId);
    if (!project) throw new ApiError(ERR.NOTFOUND, '项目不存在或已删除：' + o.projectId);
    workspace = defaultWorkspaceOf(db, project);
    /* 项目没有可用工作区时 workspace 为 null：允许，因为项目级操作（资产/记录/设置）
       不需要工作区。只有真正要操作分镜的调用方才需要再判一次。 */
  } else {
    /* 旧式扁平请求：没有携带任何作用域。落到旧项目，保证升级前的接口调用方式继续可用。
       这是**兼容路径**，不是"全局当前项目"—— 它由数据（迁移创建的那个项目）决定，
       不来自任何可变全局变量。 */
    project = projectOf(db, LEGACY_PROJECT_ID);
    if (!project) {
      /* 库还没迁移过（或旧项目被删了）：退回第一个可用项目，再没有就报错 */
      project = aliveProjects(db).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0] || null;
    }
    if (!project) throw new ApiError(ERR.NOTFOUND, '当前没有任何项目，请先创建项目');
    workspace = defaultWorkspaceOf(db, project);
  }

  return {
    project, workspace,
    projectId: project ? project.id : null,
    workspaceId: workspace ? workspace.id : null
  };
}

/* 需要工作区的场景（分镜相关）：没有可用工作区就明确报错，而不是静默返回空列表 */
function requireWorkspaceScope(db, opts) {
  const scope = resolveScope(db, opts);
  if (!scope.workspace) {
    throw new ApiError(ERR.NOTFOUND, '项目「' + scope.project.name + '」下还没有分镜表，请先新建一张');
  }
  return scope;
}

/* ---------------- 活动任务判定（删除保护，指令 §48） ----------------
   "活动"= 排队中 / 生成中，或 CLI 任务停在 submitting（已派发但还没拿到终态）。
   有活动任务时禁止软删项目/工作区 —— 否则 Worker 会失去父对象。 */
const ACTIVE_STATUSES = ['queued', 'generating'];

function hasActiveTasks(db, opts) {
  const o = opts || {};
  const sbIds = new Set();
  (db.storyboards || []).forEach((s) => {
    if (!s || !ACTIVE_STATUSES.includes(s.status)) return;
    if (o.workspaceId) { if (s.workspaceId === o.workspaceId) sbIds.add(s.id); return; }
    if (o.projectId) {
      const ws = workspaceOf(db, s.workspaceId);
      if (ws && ws.projectId === o.projectId) sbIds.add(s.id);
    }
  });
  Object.keys(db.cliJobs || {}).forEach((id) => {
    const job = db.cliJobs[id];
    if (!job || job.state !== 'submitting') return;
    if (o.workspaceId) { if (job.workspaceId === o.workspaceId) sbIds.add(id); return; }
    if (o.projectId && job.projectId === o.projectId) sbIds.add(id);
  });
  return { active: sbIds.size > 0, count: sbIds.size, ids: [...sbIds] };
}

/* ---------------- 项目级设置（指令 §15.3 兼容策略） ----------------
   分层而不是大拆：全局 db.settings 保留（系统级：queue / adapter），
   项目可覆盖 defaults / delimiter。读取时"项目覆盖 ⊕ 全局默认"。
   项目没设过的项自然回落到全局值，因此旧数据与旧调用方行为不变。 */
function resolveProjectSettings(db, projectId) {
  const g = (db.settings && db.settings.defaults) || {};
  const project = projectOf(db, projectId);
  const ov = (project && project.settings && project.settings.defaults) || {};
  const out = Object.assign({}, g);
  Object.keys(ov).forEach((k) => { if (ov[k] !== undefined) out[k] = ov[k]; });
  return out;
}
function resolveProjectDelimiter(db, projectId) {
  const g = (db.settings && db.settings.delimiter) || { type: 'custom', value: ';;' };
  const project = projectOf(db, projectId);
  const ov = (project && project.settings && project.settings.delimiter) || null;
  return ov ? Object.assign({}, g, ov) : Object.assign({}, g);
}

/* ---------------- 项目 CRUD ---------------- */

/* 项目卡片上的计数：工作区数 / 资产数 / 分镜数。列表接口用，避免前端逐个项目再请求。 */
function countsOf(db, projectId) {
  const wsList = aliveWorkspaces(db).filter((w) => w.projectId === projectId);
  const wsIds = new Set(wsList.map((w) => w.id));
  const storyboards = (db.storyboards || []).filter((s) => s && wsIds.has(s.workspaceId)).length;
  const assets = (db.assets || []).filter((a) => a && a.projectId === projectId).length;
  return { workspaces: wsList.length, storyboards, assets };
}

const viewProject = (db, p) => ({
  id: p.id, name: p.name, description: p.description || '',
  settings: Object.assign({}, p.settings || {}),
  defaultWorkspaceId: p.defaultWorkspaceId || null,
  createdAt: p.createdAt || null, updatedAt: p.updatedAt || null, lastOpenedAt: p.lastOpenedAt || null,
  counts: countsOf(db, p.id)
});

function listProjects(db) {
  const list = aliveProjects(db)
    .slice()
    /* 最近打开的在前，其次按创建时间倒序 —— 与"首页是一张项目卡片墙"的用法一致 */
    .sort((a, b) => String(b.lastOpenedAt || b.updatedAt || b.createdAt || '')
      .localeCompare(String(a.lastOpenedAt || a.updatedAt || a.createdAt || '')));
  return { list: list.map((p) => viewProject(db, p)), total: list.length };
}

function getProject(db, id) {
  const p = projectOf(db, id);
  if (!p) throw new ApiError(ERR.NOTFOUND, '项目不存在或已删除：' + id);
  return viewProject(db, p);
}

function cleanName(raw, what) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) throw new ApiError(ERR.PARAM, what + '名称不能为空');
  if (name.length > NAME_MAX) throw new ApiError(ERR.PARAM, what + '名称不能超过 ' + NAME_MAX + ' 字');
  return name;
}

/* 新建项目。**刻意不自动创建分镜表**（用户明确要求："项目内不要自动创建默认页面"）。
   代价是新建的项目是空的，要自己建一张分镜表才能开始做分镜 —— 这是有意的取舍，
   避免给用户留下一堆他没要过的空分镜表。
   defaultWorkspaceId 留 null；等建第一张分镜表时由 createWorkspace 补上。
   （早期版本会自动建一张「默认页面」，那个行为已按用户要求撤销。） */
function createProject(db, b) {
  const body = b || {};
  const name = cleanName(body.name, '项目');
  const now = nowIso();
  const proj = {
    id: rid('pj_'), name,
    description: String(body.description || '').trim(),
    settings: {},                 // 留空 = 全部回落到全局默认（§15.3）
    defaultWorkspaceId: null,
    createdAt: now, updatedAt: now, lastOpenedAt: now, deletedAt: null
  };
  db.projects.push(proj);
  save();
  return { project: viewProject(db, proj), workspace: null };
}

function patchProject(db, id, b) {
  const p = projectOf(db, id);
  if (!p) throw new ApiError(ERR.NOTFOUND, '项目不存在或已删除：' + id);
  const body = b || {};
  if (body.name !== undefined) p.name = cleanName(body.name, '项目');
  if (body.description !== undefined) p.description = String(body.description || '').trim();
  /* 项目级创作默认参数（部分覆盖即可，未给的项继续回落全局） */
  if (body.settings && typeof body.settings === 'object') {
    p.settings = Object.assign({}, p.settings || {});
    if (body.settings.defaults && typeof body.settings.defaults === 'object') {
      p.settings.defaults = Object.assign({}, p.settings.defaults || {}, body.settings.defaults);
    }
    if (body.settings.delimiter && typeof body.settings.delimiter === 'object') {
      p.settings.delimiter = Object.assign({}, p.settings.delimiter || {}, body.settings.delimiter);
    }
  }
  p.updatedAt = nowIso();
  save();
  return viewProject(db, p);
}

/* 软删除项目（指令 §45：第一版不做级联物理销毁）。
   ⚠ 不删工作区、不删分镜、不删素材、不删记录 —— 只标记 deletedAt。
     记录仍要能显示"当时属于哪个项目"，靠的是记录里的名称快照（§47）。 */
function deleteProject(db, id) {
  const p = projectOf(db, id);
  if (!p) throw new ApiError(ERR.NOTFOUND, '项目不存在或已删除：' + id);
  const act = hasActiveTasks(db, { projectId: p.id });
  if (act.active) {
    throw new ApiError(ERR.CONFLICT,
      '当前仍有生成任务（' + act.count + ' 个），请先等待任务完成或取消任务', { ids: act.ids });
  }
  const now = nowIso();
  p.deletedAt = now;
  p.updatedAt = now;
  save();
  return { deleted: p.id, softDeleted: true, note: '项目及其工作区/分镜/素材/记录均未被物理删除，仅标记为已删除' };
}

/* ---------------- 工作区 CRUD ---------------- */

const viewWorkspace = (w) => ({
  id: w.id, projectId: w.projectId, name: w.name, description: w.description || '',
  createdAt: w.createdAt || null, updatedAt: w.updatedAt || null, lastOpenedAt: w.lastOpenedAt || null
});

function listWorkspaces(db, projectId) {
  const p = projectOf(db, projectId);
  if (!p) throw new ApiError(ERR.NOTFOUND, '项目不存在或已删除：' + projectId);
  const list = aliveWorkspaces(db).filter((w) => w.projectId === p.id)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  /* 每张分镜表的分镜数：项目主页的卡片要显示，避免前端逐个再请求 */
  return {
    project: viewProject(db, p),
    list: list.map((w) => Object.assign(viewWorkspace(w), {
      storyboardCount: (db.storyboards || []).filter((s) => s && s.workspaceId === w.id).length,
      isDefault: w.id === p.defaultWorkspaceId
    })),
    total: list.length
  };
}

function getWorkspace(db, id) {
  const w = workspaceOf(db, id);
  if (!w) throw new ApiError(ERR.NOTFOUND, '工作区不存在或已删除：' + id);
  const p = projectOf(db, w.projectId);
  return Object.assign(viewWorkspace(w), {
    project: p ? { id: p.id, name: p.name } : null,
    storyboardCount: (db.storyboards || []).filter((s) => s && s.workspaceId === w.id).length
  });
}

function createWorkspace(db, projectId, b) {
  const p = projectOf(db, projectId);
  if (!p) throw new ApiError(ERR.NOTFOUND, '项目不存在或已删除：' + projectId);
  const body = b || {};
  const name = cleanName(body.name, '分镜表');
  const now = nowIso();
  const w = {
    id: rid('ws_'), projectId: p.id, name,
    description: String(body.description || '').trim(),
    createdAt: now, updatedAt: now, lastOpenedAt: now, deletedAt: null
  };
  db.workspaces.push(w);
  if (!p.defaultWorkspaceId) p.defaultWorkspaceId = w.id;
  p.updatedAt = now;
  save();
  return viewWorkspace(w);
}

function patchWorkspace(db, id, b) {
  const w = workspaceOf(db, id);
  if (!w) throw new ApiError(ERR.NOTFOUND, '工作区不存在或已删除：' + id);
  const body = b || {};
  if (body.name !== undefined) w.name = cleanName(body.name, '分镜表');
  if (body.description !== undefined) w.description = String(body.description || '').trim();
  w.updatedAt = nowIso();
  save();
  /* 改名后旧记录仍显示生成时的名字 —— 靠记录里的 workspaceName 快照，这里不做任何回填 */
  return viewWorkspace(w);
}

/* 软删除工作区（UI 上叫「分镜表」）。**不得删除项目资产**（指令 §46）—— 资产属于项目，与工作区无关。 */
function deleteWorkspace(db, id) {
  const w = workspaceOf(db, id);
  if (!w) throw new ApiError(ERR.NOTFOUND, '分镜表不存在或已删除：' + id);
  const act = hasActiveTasks(db, { workspaceId: w.id });
  if (act.active) {
    throw new ApiError(ERR.CONFLICT,
      '该分镜表下仍有生成任务（' + act.count + ' 个），请先等待任务完成或取消任务', { ids: act.ids });
  }
  /* ⚠ 曾经这里有一条"不允许删掉项目最后一个工作区"的守卫，理由是"否则项目会进入
     没有页面可用的死角"。但按用户要求改成"新建项目不自动建分镜表"之后，
     **空项目本身就是合法状态**，再禁止删到 0 就自相矛盾了。故移除该守卫：
     删掉最后一张分镜表只是把项目变回"空"，随时可以再建。 */
  const p = projectOf(db, w.projectId);
  const others = aliveWorkspaces(db).filter((x) => x.projectId === w.projectId && x.id !== w.id);
  const now = nowIso();
  w.deletedAt = now;
  w.updatedAt = now;
  if (p && p.defaultWorkspaceId === w.id) p.defaultWorkspaceId = others.length ? others[0].id : null;
  save();
  return { deleted: w.id, softDeleted: true, note: '分镜表内的分镜与项目资产均未被物理删除，仅标记为已删除' };
}

/* 打开项目/工作区时刷新 lastOpenedAt（首页按最近打开排序要用） */
function touchProject(db, projectId) {
  const p = projectOf(db, projectId);
  if (!p) return null;
  p.lastOpenedAt = nowIso();
  save();
  return p;
}
function touchWorkspace(db, workspaceId) {
  const w = workspaceOf(db, workspaceId);
  if (!w) return null;
  w.lastOpenedAt = nowIso();
  save();
  return w;
}

module.exports = {
  NAME_MAX, ACTIVE_STATUSES,
  aliveProjects, aliveWorkspaces,
  projectOf, workspaceOf, projectOfWorkspace, workspaceOfStoryboard, projectOfStoryboard,
  defaultWorkspaceOf,
  resolveScope, requireWorkspaceScope, hasActiveTasks,
  resolveProjectSettings, resolveProjectDelimiter, countsOf,
  listProjects, getProject, createProject, patchProject, deleteProject,
  listWorkspaces, getWorkspace, createWorkspace, patchWorkspace, deleteWorkspace,
  touchProject, touchWorkspace,
  viewProject, viewWorkspace
};
