# 发布到 GitHub

仓库名建议 `qiansi-app/qiansi`（GitHub 的 `qiansi` 个人账号已被占用，组织名用 `qiansi-app` 或 `qiansi-labs`）。

## 已经准备好的

- 分支已改为 `main`，尚未提交。
- `.gitignore` 覆盖 `node_modules/`、`release/`、`dist/`、`server-dist/`、`.env.local`、运行数据。
- `package-lock.json` 的下载地址已从 npmmirror 统一为 `registry.npmjs.org`，GitHub Actions 可直接 `npm ci`。
- 已扫描源码，没有 API Key、Bearer token 或 `.env` 文件被纳入提交。
- MIT `LICENSE`、中英文 README、`CHANGELOG.md`、`docs/`、Code signing policy 均已就位。

## 第一步：在 GitHub 建仓库

网页方式：

1. 注册或登录 GitHub；
2. 新建组织 `qiansi-app`（如果用户名 `qiansi` 被占，用组织即可）；
3. 在该组织下新建仓库 `qiansi`，**Public**；
4. 不要勾选 README / .gitignore / license（本地已有）；
5. 记下仓库地址，例如 `https://github.com/qiansi-app/qiansi.git`。

如果安装了 GitHub CLI，也可以一条命令完成（需要先 `gh auth login`）：

```powershell
gh repo create qiansi-app/qiansi --public --source=. --remote=origin --push
```

## 第二步：本地首次提交并推送

```powershell
cd E:\AgentWeave
git add -A
git commit -m "feat: initial Qiansi multi-AI canvas"
git remote add origin https://github.com/qiansi-app/qiansi.git
git push -u origin main
```

首次推送如果要求认证：

- HTTPS：用 GitHub Personal Access Token（至少 `repo` 权限）作为密码；Windows 也可以让 Git Credential Manager 弹窗登录。
- SSH：先把公钥加到 GitHub，再把 remote 换成 `git@github.com:qiansi-app/qiansi.git`。

## 第三步：确认 CI

推送后打开仓库的 **Actions**：

- `build` 工作流应跑通 typecheck、版本检查、NSIS/便携版构建；
- 成功后下载 `qiansi-windows` artifact，里面是安装包、便携版和 `SHA256SUMS.txt`；
- 如果 NSIS 失败，工作流会自动回退到便携版 zip。

## 第四步：发第一个版本

```powershell
git tag v0.1.0
git push origin v0.1.0
```

标签构建会创建一个**草稿 Release**，附安装包、便携版和校验和。检查说明与附件后手动发布。

## 第五步：仓库设置

- **Settings → Actions → General**：允许工作流读写仓库内容（Release 需要）。
- **Settings → Secrets and variables → Actions**：以后加 `CSC_LINK` / `CSC_KEY_PASSWORD`，或 SignPath 的 `SIGNPATH_API_TOKEN` 与变量。
- **Settings → General**：Description 填「牵丝 Qiansi — 本地优先的多 AI 协作画布」，Topics 加 `ai-agents`、`multi-agent`、`electron`、`react-flow`、`orchestration`。
- **Branches**：给 `main` 开保护，要求 CI 通过后再合并。
- **Security**：开启 Dependabot alerts 与 secret scanning。

## 第六步：申请 SignPath（可选）

仓库公开、有一个已发布 Release 之后，到 <https://signpath.org/apply> 申请。主页的 `Code signing policy` 段落已在 README 里，细则见 [code-signing-policy.md](code-signing-policy.md) 和 [release.md](release.md)。

## 发布前检查清单

- [ ] `git status` 里没有 `.env.local`、`~/.qiansi`、密钥文件
- [ ] `npm run typecheck` 通过
- [ ] `npm run version:check` 通过
- [ ] README 的克隆与安装命令能跑通
- [ ] Actions 在 `main` 上是绿的
- [ ] Release 附件里有安装包、便携版、SHA256
- [ ] 仓库 Description、Topics、License 显示正确
