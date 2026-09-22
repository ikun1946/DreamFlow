'use strict';
/* ============================================================
   update-state.js —— 应用自更新的互斥状态机（2026-09-22 从 main.js 抽出）

   为什么抽出来：这段规则是"并发更新"事故的**唯一**防线，但它原先埋在 main.js 里，
   想验证它只能**匹配源码文本** —— 于是两头失真：
     · 改实现（把 withLock 改名、finally 换成别的写法）会误报；
     · 行为退化（复位的时机不对）却可能照样绿。
   抽成不依赖 electron 的纯模块后，可以直接调用它做行为测试
   （并发拒绝 / 异常释放锁 / 安装期状态保持），见 test/03-build-release.test.js。

   ⚠ 本模块**不 require electron**：状态变化通过 onChange 回调外发给调用方，
     广播（win.webContents.send）是 main.js 的事。

   五态：
     idle        没有更新流程在跑
     checking    正在取清单
     downloading 正在下载安装包
     ready       安装包已就绪（可以重下，也可以直接装）
     installing  安装器已拉起，进程即将退出

   允许的转移（互斥规则的**唯一**落点，改规则只改 canStart）：
     idle        → 任意动作
     ready       → 任意动作（重下 / 直接安装 / 再检查一次）
     checking / downloading / installing → 一律拒绝（有流程在跑）
   ============================================================ */

const STATES = ['idle', 'checking', 'downloading', 'ready', 'installing'];

/* 动作 → 进入的状态 */
const ACTION_STATE = { check: 'checking', download: 'downloading', install: 'installing' };

/* 动作结束后由锁**自动**回落到哪一态（仅当调用方没有自己改过状态时，见 withLock 的 finally）。
   ⚠ install 刻意回落成它自己（= 不复位），这是 2026-09-22 修掉的一个真缺陷：
     main.js 的安装成功路径会 setTimeout(800ms) 再 app.quit()，让 detached 拉起的安装器站稳。
     原实现在 fn 返回后**立刻**把 installing 复位成 ready —— 于是这 800ms 里
     canStart('install') 是放行的，用户再点一次"安装"就会拉起第二个安装器，
     两个进程同时替换程序文件是"装坏"的最短路径（而原测试因为只匹配源码文本，完全没发现）。
     安装**失败**的降级由调用方显式 set()（见 main.js 的 doInstallUpdate）。 */
const FALLBACK = { check: 'idle', download: 'idle', install: 'installing' };

function makeUpdateState(opts) {
  const o = opts || {};
  const onChange = typeof o.onChange === 'function' ? o.onChange : function () {};
  /* 被互斥拒掉时的留痕。刻意做成注入的回调而不是在这里 console.warn：
     纯模块不该往 stdout 写东西（测试跑起来会被这类日志刷屏），
     日志是 main.js 的事（它注入一个 console.warn）。 */
  const onReject = typeof o.onReject === 'function' ? o.onReject : function () {};
  let state = 'idle';

  /* 哪些状态下允许发起什么 */
  function canStart(action) {
    if (state === 'idle') return true;
    if (state === 'ready') return true;
    return false;
  }

  /* 状态写入的唯一入口。同值写入不触发 onChange（避免重复广播），
     未知状态直接抛 —— 拼错的状态名会让互斥静默失效，宁可响亮地失败。 */
  function set(next) {
    if (!STATES.includes(next)) throw new Error('未知更新状态：' + String(next));
    if (next === state) return state;
    state = next;
    onChange(state);
    return state;
  }

  const get = () => state;
  const isBusy = () => state !== 'idle' && state !== 'ready';
  const snapshot = () => ({ state: state, busy: isBusy() });

  /* 状态机 + 异常兜底。为什么用 try/finally 而不是靠各分支自己复位：
     fetchManifest / download 里任何一处抛未捕获异常，状态会永久卡在 downloading，
     之后**再也无法更新**（要重启应用）—— 这类"卡死型"故障比原 bug 更难排查。 */
  async function withLock(action, fn) {
    if (!canStart(action)) {
      const msg = state === 'installing'
        ? '正在安装更新，请等待应用自动重启'
        : '已有更新操作正在进行中（' + state + '），请稍候';
      onReject(action, state);
      return { ok: false, busy: true, state: state, error: msg };
    }
    const mine = ACTION_STATE[action] || 'checking';
    set(mine);
    try {
      return await fn();
    } finally {
      /* 只在"状态仍是我设的那个"时才自动回落：调用方在 fn 里显式改过状态
         （例如下载成功后置 ready）说明它比锁更清楚接下来该处于哪一态，锁不能覆盖它。 */
      if (state === mine) set(FALLBACK[action] || 'idle');
    }
  }

  return { STATES: STATES, ACTION_STATE: ACTION_STATE, canStart: canStart, withLock: withLock, get: get, set: set, isBusy: isBusy, snapshot: snapshot };
}

module.exports = { makeUpdateState, STATES, ACTION_STATE, FALLBACK };
