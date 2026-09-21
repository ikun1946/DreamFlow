#!/usr/bin/env bash
#
# 【一次性脚本】在 GitHub 创建私有仓库，并把当前项目推上去。
#
#   export GITHUB_TOKEN=ghp_xxxxxxxxxxxx      # 命令前加空格，避免进入 shell 历史
#   bash scripts/push-to-github.sh            # 自定义仓库名：bash scripts/push-to-github.sh my-repo
#
# 依次执行：校验令牌 → 读取账号 → 创建私有仓库(private:true) → 推送 → 回查私密性。
# 任一步失败即中止，不会留下半截状态。
#
# 安全设计：推送时令牌只临时出现在远端 URL 里，推送完立刻重置为不含令牌的地址，
#           所以令牌不会被写进 .git/config。令牌本身只在环境变量里，不落盘。
#
set -euo pipefail

REPO_NAME="${1:-DreamFlow}"
REPO_DESC="即梦批量视频生成控制台 · 前端应用（文档 / 开发版 / 发布版 / 归档）"

# ── 定位仓库根：脚本所在目录的上一级 ────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
echo "==> 仓库根：$REPO_ROOT"

# ── 小工具：不用 jq，靠 grep/sed 取值 ───────────────────────────
json_get() {   # json_get <json> <key>  → 取 "key":"value"
  printf '%s' "$1" \
    | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed 's/.*:[[:space:]]*"//; s/"$//'
}
json_true() {  # json_true <json> <key> → 该字段是否为 true
  printf '%s' "$1" | grep -q "\"$2\"[[:space:]]*:[[:space:]]*true"
}

# ── 1. 令牌 ────────────────────────────────────────────────────
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo ""
  echo "✗ 未检测到环境变量 GITHUB_TOKEN。"
  echo "  请先执行（命令前带空格，避免进入 shell 历史）："
  echo "     export GITHUB_TOKEN=ghp_你的令牌"
  echo "  令牌需具备 repo 权限：https://github.com/settings/tokens"
  exit 1
fi

# ── 2. 确认本地是 Git 仓库 ─────────────────────────────────────
git rev-parse --git-dir >/dev/null 2>&1 || { echo "✗ 当前目录不是 Git 仓库：$REPO_ROOT"; exit 1; }

AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json")

# ── 3. 读取账号，顺便校验令牌 ──────────────────────────────────
ME="$(curl -sS "${AUTH[@]}" https://api.github.com/user || true)"
LOGIN="$(json_get "$ME" login)"
if [[ -z "$LOGIN" ]]; then
  echo "✗ 令牌校验失败（拿不到账号信息）。检查令牌是否有效、是否勾选了 repo 权限。"
  exit 1
fi
echo "==> 已认证账号：$LOGIN"

# ── 4. 创建私有仓库 ────────────────────────────────────────────
echo "==> 创建私有仓库 $LOGIN/$REPO_NAME ..."
PAYLOAD="$(printf '{"name":"%s","description":"%s","private":true,"auto_init":false,"has_issues":true,"has_projects":false,"has_wiki":false}' "$REPO_NAME" "$REPO_DESC")"
RESP="$(curl -sS -w '\n%{http_code}' -X POST "${AUTH[@]}" https://api.github.com/user/repos -d "$PAYLOAD" || true)"
HTTP_CODE="$(printf '%s' "$RESP" | tail -1 | tr -d '[:space:]')"
BODY="$(printf '%s\n' "$RESP" | sed '$d')"

if [[ "$HTTP_CODE" != "201" ]]; then
  echo "✗ 建仓失败（HTTP $HTTP_CODE）"
  printf '%s\n' "$BODY" | grep -o '"message":"[^"]*"' || true
  echo "  常见原因：令牌无 repo 权限 / 该账号下已有同名仓库。"
  exit 1
fi

json_true "$BODY" private || { echo "✗ 建仓返回的 private 不是 true，已中止。"; exit 1; }
FULL_NAME="$(json_get "$BODY" full_name)"
echo "==> 已创建：$FULL_NAME（private = true）"

# ── 5. 推送 ────────────────────────────────────────────────────
REMOTE_CLEAN="https://github.com/$LOGIN/$REPO_NAME.git"

# 安全兜底：无论脚本从哪里退出（包括 set -e 触发的中途退出），
# 都把远端地址重置回不含令牌的形式，令牌绝不留在 .git/config。
# 没有这段的话，git push 一旦失败，脚本会在重置 URL 之前就退出，令牌就留下了。
restore_remote() {
  if [[ -n "${REMOTE_CLEAN:-}" ]]; then
    git remote set-url origin "$REMOTE_CLEAN" 2>/dev/null || true
  fi
}
trap restore_remote EXIT

git remote remove origin 2>/dev/null || true
git remote add origin "https://$LOGIN:${GITHUB_TOKEN}@github.com/$LOGIN/$REPO_NAME.git"
git branch -M main
echo "==> 推送 main 分支 ..."
git push -u origin main
# 立刻把远端地址换回不含令牌的形式（EXIT 兜底之外的正常路径）
git remote set-url origin "$REMOTE_CLEAN"
echo "==> 推送完成，远端地址已重置为：$REMOTE_CLEAN"

# ── 6. 验证私密性 ──────────────────────────────────────────────
echo ""
echo "==> 验证私密性"
REPO_JSON="$(curl -sS "${AUTH[@]}" "https://api.github.com/repos/$LOGIN/$REPO_NAME" || true)"

if json_true "$REPO_JSON" private; then
  echo "  ① API 回查：private = true   ✓"
else
  echo "  ① API 回查：private 不是 true   ✗ 请立即到 Settings → General → Change visibility 改为 Private"
fi

CODE="$(curl -sS -o /dev/null -w '%{http_code}' "https://github.com/$LOGIN/$REPO_NAME" || true)"
if [[ "$CODE" == "404" ]]; then
  echo "  ② 未登录访问：HTTP 404（看不到即私密生效）   ✓"
else
  echo "  ② 未登录访问：HTTP $CODE   ✗ 期望 404。若为 200 说明仓库是公开的，请立即改为 Private"
fi

COLLAB="$(curl -sS "${AUTH[@]}" "https://api.github.com/repos/$LOGIN/$REPO_NAME/collaborators" || true)"
CCOUNT="$(printf '%s' "$COLLAB" | grep -o '"login"' | wc -l | tr -d '[:space:]')"
if [[ "${CCOUNT:-0}" == "0" ]]; then
  echo "  ③ 协作者列表：为空   ✓"
else
  echo "  ③ 协作者列表：$CCOUNT 人   ⚠ 请到 Settings → Collaborators 移除不需要的人"
fi

echo ""
echo "==> 仓库地址：https://github.com/$LOGIN/$REPO_NAME"
echo "==> 补充验证：用另一个账号或无痕窗口打开上面的地址，应显示 404。"
echo "==> 令牌留在环境变量里即可，用完可到 https://github.com/settings/tokens 吊销。"
