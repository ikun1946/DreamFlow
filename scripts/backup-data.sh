#!/usr/bin/env bash
# ============================================================
# backup-data.sh —— 把「git 保不住的那部分」备份到项目目录之外
#
# 为什么需要这个脚本（git 结构上就替代不了）：
#   server/data/ 被 .gitignore 排除，远端仓库里没有它。而其中的
#     · db.json      分镜 / 素材 / 生成记录 —— 手工重建代价极大
#     · output/      真实生成的视频产物 —— 花过即梦积分，不可再生成
#     · assets/      真实素材图 —— DELETE /assets/{id} 会连磁盘文件一起删且不留痕
#   全部属于「丢了就没了」。所以运行数据的备份与 git 是两件独立的事。
#
# 用法：
#   bash scripts/backup-data.sh                       # 备份到默认位置
#   JC_BACKUP_ROOT=/d/backups bash scripts/backup-data.sh
#   JC_BACKUP_KEEP=5 bash scripts/backup-data.sh      # 只保留最近 5 份
#
# 默认位置：$HOME/jimeng-console-backups/<时间戳>/
# 每次运行产生一个独立快照目录，不覆盖历史；超出 KEEP 份数时删最旧的。
# ============================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/server/data"
SNAP_DIR="$PROJECT_ROOT/backup"

BACKUP_ROOT="${JC_BACKUP_ROOT:-$HOME/jimeng-console-backups}"
KEEP="${JC_BACKUP_KEEP:-10}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"

die() { echo "✗ $*" >&2; exit 1; }

# 路径归一化：把 Windows 形式（C:/x）与 POSIX 形式（/c/x）统一成同一种写法，
# 并折叠掉 .. 与 .。没有这一步，下面的「拒绝写进项目内部」防护会因为两种写法
# 字面不同而静默失效（2026-09-19 实测踩到：传 C:/… 时防护没拦住，备份被写进了项目里）。
norm() {
  local p="$1"
  command -v cygpath >/dev/null 2>&1 && p="$(cygpath -u "$p" 2>/dev/null || printf '%s' "$p")"
  command -v realpath >/dev/null 2>&1 && p="$(realpath -m "$p" 2>/dev/null || printf '%s' "$p")"
  printf '%s' "${p%/}"
}

# ── 前置检查 ──────────────────────────────────────────────
[ -d "$DATA_DIR" ] || die "找不到 $DATA_DIR（请在项目内运行）"
[ -n "$(find "$DATA_DIR" -type f -print -quit)" ] || die "$DATA_DIR 里没有任何文件，拒绝产出一份空备份"

# 拒绝把备份写进项目目录内部 —— 那样一次误删项目就把它一起带走了。
# 两端都先归一化再比较，否则 Windows / POSIX 两种写法会让这条防护失效。
ROOT_N="$(norm "$PROJECT_ROOT")"
DEST_N="$(norm "$DEST")"
case "$DEST_N/" in
  "$ROOT_N"/*) die "备份目标落在项目目录内部（$DEST_N）。请用 JC_BACKUP_ROOT 指到项目之外" ;;
esac

[ -e "$DEST" ] && die "目标已存在：$DEST（同一秒内重复运行？请稍后重试）"

# ── 复制 ──────────────────────────────────────────────────
echo "==> 备份根目录：$BACKUP_ROOT"
mkdir -p "$DEST"
echo "==> 快照目录：$DEST"

echo "    复制 server/data ..."
mkdir -p "$DEST/data"
cp -r "$DATA_DIR/." "$DEST/data/"

HAVE_SNAPSHOTS=0
if [ -d "$SNAP_DIR" ] && [ -n "$(find "$SNAP_DIR" -type f -print -quit)" ]; then
  echo "    复制 backup/（本地源码快照）..."
  mkdir -p "$DEST/source-snapshots"
  cp -r "$SNAP_DIR/." "$DEST/source-snapshots/"
  HAVE_SNAPSHOTS=1
fi

# ── 校验：逐类比对文件数，不一致即失败（宁可报错也不留一份残缺备份）──
count() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }

SRC_DATA_N="$(count "$DATA_DIR")"
DST_DATA_N="$(count "$DEST/data")"
SRC_SNAP_N=0
DST_SNAP_N=0
[ "$SRC_DATA_N" = "$DST_DATA_N" ] || die "server/data 文件数不一致：源 $SRC_DATA_N / 备份 $DST_DATA_N"

if [ "$HAVE_SNAPSHOTS" = "1" ]; then
  SRC_SNAP_N="$(count "$SNAP_DIR")"
  DST_SNAP_N="$(count "$DEST/source-snapshots")"
  [ "$SRC_SNAP_N" = "$DST_SNAP_N" ] || die "backup/ 文件数不一致：源 $SRC_SNAP_N / 备份 $DST_SNAP_N"
fi

# ── 清单：记下「这份数据对应哪一版代码」，否则日后无法判断能否配得上 ──
GIT_REF="$(cd "$PROJECT_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo '（非 git 仓库）')"
GIT_TAG="$(cd "$PROJECT_ROOT" && git describe --tags --exact-match HEAD 2>/dev/null || echo '（HEAD 无 tag）')"
GIT_DIRTY="$(cd "$PROJECT_ROOT" && { [ -z "$(git status --porcelain 2>/dev/null)" ] && echo '干净' || echo '有未提交改动'; } )"

{
  echo "即梦批量生成控制台 · 运行数据备份清单"
  echo "========================================"
  echo "备份时刻   : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "源目录     : $DATA_DIR"
  echo "对应代码   : $GIT_REF（tag: $GIT_TAG，工作区: $GIT_DIRTY）"
  echo
  echo "内容"
  echo "----"
  printf "  db.json 主库        : %s 个\n" "$(find "$DEST/data" -maxdepth 1 -name 'db.json' -type f | wc -l | tr -d ' ')"
  printf "  db.json 历史版本    : %s 个\n" "$(find "$DEST/data" -maxdepth 1 -name 'db.json.*' -type f | wc -l | tr -d ' ')"
  printf "  视频产物 (.mp4)     : %s 个\n" "$(find "$DEST/data/output" -type f -name '*.mp4' 2>/dev/null | wc -l | tr -d ' ')"
  printf "  产物封面 (.jpg)     : %s 个\n" "$(find "$DEST/data/output" -type f -name '*_cover.jpg' 2>/dev/null | wc -l | tr -d ' ')"
  printf "  素材图              : %s 个\n" "$(find "$DEST/data/assets" -type f 2>/dev/null | wc -l | tr -d ' ')"
  # 总数按「data + source-snapshots」算，不含本清单文件自身（否则每跑一次数字都差 1）
  printf "  文件总数 / 体积     : %s 个 / %s\n" "$((DST_DATA_N + DST_SNAP_N))" "$(du -shc "$DEST/data" ${HAVE_SNAPSHOTS:+$DEST/source-snapshots} 2>/dev/null | tail -1 | cut -f1)"
  if [ "$HAVE_SNAPSHOTS" = "1" ]; then
    printf "  本地源码快照        : %s 个（backup/）\n" "$DST_SNAP_N"
  fi
  echo
  echo "校验和（sha256）"
  echo "----------------"
  ( cd "$DEST" && find . -type f \( -name 'db.json' -o -name '*.mp4' \) | sort | xargs -r sha256sum 2>/dev/null )
  echo
  echo "恢复方式"
  echo "--------"
  echo "  1) 代码：git checkout $GIT_TAG   （或 git checkout $GIT_REF）"
  echo "  2) 数据：把本目录的 data/ 覆盖回 server/data/"
  echo "     ⚠ 覆盖前先停掉 node server/index.js，否则运行中的服务会把它写回覆盖"
} > "$DEST/MANIFEST.txt"

echo "==> 校验通过：server/data $SRC_DATA_N 个文件${HAVE_SNAPSHOTS:+，backup/ $SRC_SNAP_N 个文件}"

# ── 轮转：只保留最近 KEEP 份 ──────────────────────────────
mapfile -t OLD < <(ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}$' | sort -r | tail -n +$((KEEP + 1)))
if [ "${#OLD[@]}" -gt 0 ]; then
  for d in "${OLD[@]}"; do
    echo "    清理旧快照：$d"
    rm -rf "$BACKUP_ROOT/$d"
  done
fi

echo
echo "✓ 备份完成：$DEST"
echo "  清单：$DEST/MANIFEST.txt"
echo "  当前保留 $(ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -cE '^[0-9]{8}-[0-9]{6}$') / $KEEP 份"
