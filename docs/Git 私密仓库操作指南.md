# 推送到 Git 私密仓库 · 操作指南

> 状态：现行（操作指南；§0 的进度表是 2026-09-17 的历史快照）
> 权威范围：私有仓库的认证方式、令牌权限、私密性验证
> 最新流程见：`docs/项目全面审查与改进流程.md`

> 适用项目：`DreamFlow/`（即梦批量生成控制台）
> 目标：把项目推送到 GitHub 上的**私有仓库**，确保只有仓库所有者本人可查看与操作。

---

## 0. 当前进度

| 步骤 | 状态 | 说明 |
|---|---|---|
| ① 本地初始化仓库 | ✅ 已完成 | 仓库根 `DreamFlow/`，分支 `main`，首次提交 `3fcfd9c`，11 个文件 |
| ② 配置 `.gitignore` / `.gitattributes` | ✅ 已完成 | 工作区内部状态、临时产物、密钥不入库；统一 LF 保证构建产物字节稳定 |
| ③ 创建远端私有仓库 | ⏳ 待执行 | **需要 GitHub 凭据**，见第 2 节 |
| ④ 关联远端并推送 | ⏳ 待执行 | 同上 |
| ⑤ 验证私密性生效 | ⏳ 待执行 | 见第 4 节，全部为可复制执行的命令 |

**已完成的具体结果**：

```bash
cd DreamFlow
git init -b main
git add -A
git commit -m "feat: 初始化即梦批量生成控制台前端项目"
# → [main (root-commit) 3fcfd9c] 11 files changed
# → git status --porcelain  → 0 行（工作区干净）
```

入库的 11 个文件：

```
.gitattributes                 行尾规范化（统一 LF）
.gitignore                     忽略规则
README.md                      项目入口
build.js                       构建脚本
app/index.html                 开发版入口
app/styles.css                 样式与设计令牌
app/api.js                     接口层（23 个接口）
app/app.js                     状态与交互
dist/即梦批量生成控制台.html     单文件发布版
docs/前端页面与接口对接说明.md   主交付文档
legacy/jimeng-batch-studio.html 历史原型
```

> `dist/` 是**有意入库**的：它是要发给别人看的可分享产物，不是编译中间产物。
> `.workbuddy/` 未入库（它位于仓库根之外，且已在 `.gitignore` 里做了防御性忽略）。

---

## 1. 四种方式（选其一）

### 方式 0 · 一条命令脚本（有令牌时最快）

项目里已经封装好：`scripts/push-to-github.sh`。它会依次做
**校验令牌 → 读取账号 → 创建私有仓库（`private: true`）→ 推送 → 回查私密性 → 检查协作者为空**，
任一步失败即中止，不会留下半截状态。

```bash
cd DreamFlow
  export GITHUB_TOKEN=ghp_你的令牌      # 命令前带空格，可避免进入 shell 历史
bash scripts/push-to-github.sh          # 自定义仓库名：bash scripts/push-to-github.sh my-repo
```

令牌只出现在环境变量与**临时**远端 URL 中；推送完成后脚本立刻把远端地址重置为
`https://github.com/<user>/<repo>.git`，所以令牌**不会留在 `.git/config`**（满足 3.4 那条要求）。
脚本只用 git + curl，不依赖 `jq`。建仓与验证步骤等价于下面第 2、4 节的手工命令。

### 方式 A · SSH 公钥（推荐 —— 我全程不接触你的密钥）

你只需在 GitHub 网页上操作，密钥本身不经过我。

1. 复制公钥内容（在本机执行后自己粘贴到网页）：

   ```bash
   cat "C:/Users/24123/.ssh/id_ed25519.pub"
   ```

2. GitHub → **Settings → SSH and GPG keys → New SSH key**，粘贴保存。
3. GitHub → **New repository**，填 `DreamFlow`，**Private**，
   **不要**勾选 Add README / .gitignore / license（保持空仓库）。
4. 告诉我仓库地址，我执行：

   ```bash
   cd DreamFlow
   # 顺带修掉本机一条失效配置（指向了不存在的密钥路径）
   git config --global --unset core.sshcommand
   git remote add origin git@github.com:<你的用户名>/DreamFlow.git
   git push -u origin main
   ```

验证连通性（不用推就能测）：

```bash
ssh -T git@github.com      # 期望输出：Hi <用户名>! You've successfully authenticated...
```

### 方式 B · Fine-grained PAT（我能代为建库 + 推送，但你会把令牌交给我）

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. 按第 3.2 节的表勾选最小权限，生成后把令牌给我。
3. 我执行建库 + 推送，然后把令牌**从本机凭据中清除**。

> ⚠️ 令牌只在你提供的那一次会话中有效。用完后建议立刻到 GitHub 撤销（Revoke）。

### 方式 C · 你自己建库，只把推送权限给我

1. 你在网页建好**空的私有仓库**。
2. 把 SSH 公钥加上（方式 A 第 1–2 步），或把 PAT 给我。
3. 我只执行 `git remote add` + `git push`。

---

## 2. 创建远端私有仓库

### 2.1 关键参数

| 项 | 值 |
|---|---|
| Repository name | `DreamFlow` |
| **Visibility** | **Private** |
| Initialize with README / .gitignore / license | **全部不勾选**（留空，避免首次推送冲突） |
| Owner | 你自己的个人账号（**不要**选组织，除非明确知道组织权限模型） |

### 2.2 用命令行创建（有令牌时）

```bash
curl -X POST https://api.github.com/user/repos \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"name":"DreamFlow","private":true,"auto_init":false,"description":"即梦批量视频生成控制台 · 前端"}'
```

> 建库后**立即**用第 4.1 节的命令回读 `private` 字段确认——不要凭"我传了 private:true"就认为生效。

---

## 3. 所需的权限配置

### 3.1 仓库可见性（核心）

- `private: true` / `visibility: private` —— 这是"只有我能看"的唯一开关。
- 私有仓库的可见范围 = **仓库所有者 + 显式邀请的协作者**。除此之外所有人都拿到 404（不是 403，
  因为 403 会暴露"仓库存在"这一事实）。

### 3.2 令牌权限（最小权限原则）

Fine-grained PAT（推荐）：

| 权限项 | 取值 | 是否必需 | 说明 |
|---|---|---|---|
| Repository permissions → **Contents** | Read and write | ✅ 必需 | 读取文件、推送提交 |
| Repository permissions → **Metadata** | Read-only | ✅ 必需（自动附带） | 读仓库基础信息 |
| Repository permissions → **Administration** | Read and write | ⭕ 可选 | 仅当需要用 API 改可见性/设置时才给 |
| Account permissions → 其余全部 | **保持默认 No access** | — | 一律不开 |

Classic PAT（旧式，仅作备选）：只勾选 **`repo`**。
勾选 `workflow` 才能改 Actions；其余 `admin:*` / `delete_repo` 一律不要给。

### 3.3 必须关闭或确认的泄露面

私有仓库只挡住"查看代码"，下面这些是**独立于可见性**的单独开关，务必逐一确认：

| 项 | 要求 | 位置 |
|---|---|---|
| **Collaborators** | 列表里只有你自己 | Settings → Collaborators |
| **Teams**（组织仓库才有） | 无任何 team 被授予权限 | Settings → Collaborators and teams |
| **组织 base permissions** | 设为 **None** | 组织 Settings → Member privileges |
| **Forking** | 私有仓库建议**关闭 Allow forking** | Settings → General（最底部） |
| **GitHub Pages** | 不要开启；开了就是**公开站点** | Settings → Pages |
| **Actions secrets** | 确认没有把生产凭据塞进仓库 | Settings → Secrets and variables |
| **Deploy keys** | 无多余部署密钥；只读密钥也要清点 | Settings → Deploy keys |
| **Public packages** | 不要发布到公开 registry | 包发布设置 |

### 3.4 账号级加固

- **开启双因素认证（2FA）**：Settings → Password and authentication。
- **PAT 设过期时间**：Fine-grained 最长 1 年，建议设 90 天并定期轮换。
- **令牌绝不入库**：`.gitignore` 已屏蔽 `.env` / `*.key` / `*.pem` / `*.p12`；
  也不要把 token 写进 remote URL（`https://<token>@github.com/...`），它会明文留在 `.git/config`。
  用 Git Credential Manager 存：`git config --global credential.helper manager`。

---

## 4. 如何验证私密性已生效

> 下面全部假设 `OWNER=<你的用户名>`、`REPO=DreamFlow`。

### 4.1 API 直接读可见性字段（最权威）

```bash
curl -s https://api.github.com/repos/$OWNER/$REPO \
  -H "Authorization: Bearer $GITHUB_TOKEN" | grep -E '"(private|visibility|name)"'
```

**期望**：`"private": true`，`"visibility": "private"`。
出现 `"private": false` 说明建库时参数没生效，立刻改：

```bash
curl -X PATCH https://api.github.com/repos/$OWNER/$REPO \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d '{"private":true}'
```

### 4.2 协作者名单只有自己

```bash
curl -s https://api.github.com/repos/$OWNER/$REPO/collaborators \
  -H "Authorization: Bearer $GITHUB_TOKEN" | grep '"login"'
```

**期望**：只有你自己的 login，没有第二条。

### 4.3 匿名访问必须是 404（最贴近真实攻击者视角）

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/$OWNER/$REPO
curl -s -o /dev/null -w "%{http_code}\n" https://github.com/$OWNER/$REPO
```

**期望**：两条都返回 **`404`**。
- 返回 `200` → 仓库是公开的，私密性未生效。
- 返回 `403` → 通常是限流或别的限制，需要换网络/换时间重测，不能当作"安全"。

### 4.4 用另一个账号 / 无痕窗口实测

浏览器开**无痕窗口**访问 `https://github.com/$OWNER/$REPO`：
**期望**看到 404 页面，而不是登录提示后进入仓库。
有第二个 GitHub 账号的话，用它登录再访问，同样是 404 才算通过。

### 4.5 匿名克隆必须失败

```bash
cd /tmp && rm -rf probe && git clone https://github.com/$OWNER/$REPO.git probe
```

**期望**：提示认证失败（`Authentication failed` / `repository not found`），且 `/tmp/probe` 未生成。

### 4.6 确认 fork 已关闭

```bash
curl -s https://api.github.com/repos/$OWNER/$REPO \
  -H "Authorization: Bearer $GITHUB_TOKEN" | grep -E '"(allow_forking|fork)"'
```

**期望**：`"allow_forking": false`（该项只能在网页 Settings 底部关闭）。

### 4.7 长期：看审计日志

Settings → **Audit log**（组织仓库）或账号 Security log，定期检查有没有你之外的访问记录。

---

## 5. 推送后的常规操作

```bash
cd DreamFlow

git status                       # 看改动
git add -A
git commit -m "描述改动"
git push                         # 已 -u 过，之后直接 push

git log --oneline                # 看提交历史
git remote -v                    # 确认远端地址（注意别是 https://<token>@ 形式）
```

**每次改动 `app/` 后记得重建发布版再提交**：

```bash
node build.js                    # 重新生成 dist/即梦批量生成控制台.html
```

---

## 6. 本机环境诊断（2026-09-17 实测）

| 认证路径 | 实测结果 |
|---|---|
| GitHub 连接器 | 状态为「已绑定 + 已启用」，托管令牌已加密存储；但工具未注册进本次会话，无法调用 |
| SSH | 本机有 `~/.ssh/id_ed25519`，**未授权到 GitHub** → `git@github.com: Permission denied (publickey)` |
| 全局 `core.sshcommand` | 指向 `C:\Users\王靖意\.ssh\id_ed25519`，**该路径不存在**（应为 `C:\Users\24123\.ssh\id_ed25519`） |
| HTTPS 凭据 | 凭据管理器无 GitHub 条目，`git credential fill` 解析不出账号 |
| `gh` CLI | 未安装 |
| git 身份 | `nick9715043082 <2051962964@qq.com>`（已配置，可直接提交） |
| `credential.helper` | `manager`（Git Credential Manager，推荐保留） |

**因此第 3、4 步必须由你提供一次凭据**（方式 A 最安全：只需要在网页加公钥，密钥不经过任何人）。
