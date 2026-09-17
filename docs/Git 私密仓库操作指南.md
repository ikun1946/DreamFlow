# 即梦批量生成控制台 · Git 私密仓库操作指南

> 目标：把本项目放到**只有你本人能查看和操作**的私有仓库里。
> 本文同时说明：需要执行的步骤、所需的仓库权限配置、以及如何验证私密性确实生效。

---

## 0. 当前进度

| 步骤 | 状态 |
|---|---|
| 初始化本地 Git 仓库（分支 `main`） | ✅ 已完成，首次提交 `3fcfd9c` |
| 配置 `.gitignore`（内部状态、临时产物、密钥不入库） | ✅ 已完成 |
| 配置 `.gitattributes`（统一 LF，保证构建产物字节稳定） | ✅ 已完成 |
| 首次提交（11 个文件） | ✅ 已完成 |
| 创建远端私有仓库 | ⏳ **待执行**（需要 GitHub 令牌） |
| 推送 `main` 分支 | ⏳ 待执行 |
| 验证私密性 | ⏳ 待执行 |

---

## 1. 前置：准备一个有 `repo` 权限的令牌

1. 打开 <https://github.com/settings/tokens> → **Tokens (classic)** → **Generate new token**
2. 权限**只勾选 `repo`**（完整读写私有仓库）。不要勾 `admin:org`、`delete_repo` 等无关项——最小权限原则
3. 有效期建议设 90 天，到期前续
4. 生成后**只显示一次**，立刻复制

> **安全要求**
> - 令牌**不要**写进任何文件、**不要**贴进聊天记录或提交记录
> - 用环境变量传入，命令行前加空格可避免进入 shell 历史：`  export GITHUB_TOKEN=ghp_xxx`
> - 用完后可在 <https://github.com/settings/tokens> 随时吊销
> - 建议同时开启 GitHub 两步验证（2FA）。开启后 HTTPS 推送**只能用令牌**，不能用账号密码

---

## 2. 建仓并推送

### 方式 A：一条命令（推荐，脚本已封装全部校验）

```bash
cd jimeng-console
  export GITHUB_TOKEN=ghp_你的令牌      # 注意前面有空格
bash scripts/push-to-github.sh          # 可选加仓库名：bash scripts/push-to-github.sh my-repo
```

脚本会依次做：校验令牌 → 读取账号 → **创建私有仓库**（`private: true`）→ 推送 → **回查私密性** → 验证协作者列表为空。任一步失败即中止，不会留下半截状态。

### 方式 B：网页建仓 + 命令行推送

1. GitHub → **New repository**
2. 名称填 `jimeng-console`，**类型选 Private**
3. **不要勾选**任何初始化选项（README / .gitignore / license 都别勾，否则远端非空，第一次推送会被拒）
4. 建好后执行：

```bash
cd jimeng-console
git remote add origin https://github.com/<你的用户名>/jimeng-console.git
git branch -M main
git push -u origin main
```

HTTPS 推送时用户名填你的 GitHub 用户名，**密码栏填令牌**（不是账号密码）。

---

## 3. 权限配置：确保只有你本人能看

建仓只是第一步，下面这几项才是「只有我本人」的真正保障。**逐项确认**：

| 配置项 | 要求 | 检查位置 |
|---|---|---|
| 仓库可见性 | **Private**（不是 Public，也不是 Internal） | Settings → General → Danger Zone → Change visibility |
| 协作者 | **列表为空** | Settings → Collaborators and teams |
| Deploy keys | **不添加**（除非有 CI 需求） | Settings → Deploy keys |
| 令牌权限 | 仅有 `repo`，无多余 scope | <https://github.com/settings/tokens> |
| 两步验证 | 建议开启 | Settings → Password and authentication |
| 代码内密钥 | 不允许。`.gitignore` 已屏蔽 `.env` / `*.key` / `*.pem` / `*.p12` | — |
| Fork | 私有仓库被 fork 后仍为私有；不主动 fork 到公开位置 | Settings → General |

> **一个容易忽略的点**：私有仓库一旦转 Public，历史提交里的所有内容都会公开。
> 所以入库前必须确认没有敏感信息——本项目的 `.gitignore` 已屏蔽工作区内部状态与密钥文件。

---

## 4. 验证私密性是否真的生效

**不要只看页面上那个 Private 标签。** 建议四种方法全做一遍，前两项脚本会自动跑：

### ① API 回查（权威）

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
     https://api.github.com/repos/<你的用户名>/jimeng-console \
  | grep -o '"private":true'
```

期望输出 `"private":true`。同时确认 `"visibility":"private"`。

### ② 未登录访问应当 404（最关键）

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://github.com/<你的用户名>/jimeng-console
```

- 返回 **404** → 私密性生效（未授权者连仓库是否存在都看不到）
- 返回 **200** → 仓库是公开的，**立刻去 Change visibility 改回 Private**

### ③ 换身份实际点开

用另一个 GitHub 账号登录，或开一个无痕窗口，直接访问仓库地址：

- 显示 **404 Not Found** → 生效
- 能看到代码 → 未生效

### ④ 协作者列表为空

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
     https://api.github.com/repos/<你的用户名>/jimeng-console/collaborators
```

期望返回 `[]`（空数组）。

---

## 5. 常见问题

| 现象 | 原因与处理 |
|---|---|
| `401 Bad credentials` | 令牌错误或已过期，重新生成 |
| `403 ... Resource not accessible` | 令牌没勾 `repo` 权限，重建令牌 |
| `name already exists` | 该账号下已有同名仓库，换名字或先删除 |
| `rejected ... non-fast-forward` | 网页建仓时勾选了初始化选项，导致远端非空。清空远端仓库后重推，或改用方式 A |
| 提示输入密码 | HTTPS 推送时密码栏要填**令牌**，不是 GitHub 账号密码 |

---

## 6. 推送后：日常同步

```bash
git add -A
git commit -m "feat: 说明这次改了什么"
git push                    # 首次已 -u 绑定，之后直接 push 即可
```

改了 `app/` 里的代码后记得先 `node build.js` 重建发布版，再一并提交。
