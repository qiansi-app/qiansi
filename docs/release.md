# 发布流程

发布物是 Windows 桌面应用：NSIS 安装包 + 单文件便携版，均从 GitHub Actions 的干净 Windows runner 产出。

## 1. 改版本号

版本只有一个来源：根 `package.json`。改完后同步 `apps/server/src/version.ts`，再跑：

```powershell
npm run version:check
```

它会比对根 `package.json`、`version.ts` 和五个 workspace manifest，不一致直接失败。MCP server 在运行时从根 `package.json` 读版本，不需要手改。

## 2. 本地验证

```powershell
npm run typecheck
npm run build
npm run desktop:portable
```

便携版输出到 `release/Qiansi-portable/Qiansi.exe`，属性页应显示 Qiansi / 0.1.0 / 牵丝 Qiansi。启动后确认：

- 窗口标题是「牵丝 Qiansi」，动态端口可访问 `/api/health`；
- 旧数据已迁移到 `~/.qiansi`，保险库里的 Key 仍能解密；
- 旧的 `x-agentweave-token` 请求头仍能通过。

## 3. 提交与打标签

```powershell
git add -A
git commit -m "release: v0.1.0"
git tag v0.1.0
git push origin main --tags
```

标签必须形如 `v0.1.0`。CI 只在标签构建时读取签名 secrets，并对标签创建 GitHub Release（默认草稿，需人工发布）。

## 4. CI 做什么

`.github/workflows/build.yml`：

1. `npm ci`（不是 `npm install`，锁文件必须同步）；
2. `npm run typecheck` + `npm run version:check`；
3. `npm run desktop:build` → NSIS + portable，`asarUnpack` 已覆盖内置服务端；
4. 对 `release/*.exe` 生成 `SHA256SUMS.txt`；
5. 上传 Actions artifact；
6. 标签构建时创建草稿 Release，附安装包、便携版、校验和。

NSIS 构建失败时会自动回退到 `desktop:portable` 并打 zip，保证仍有可下载产物。

## 5. 代码签名

### SignPath（开源免费路线）

先决条件：公开 GitHub 仓库、OSI 许可证、一个已发布的未签名 Release、README 里的 [Code signing policy](code-signing-policy.md)、全员 MFA，以及可验证的项目声誉。准备齐后到 <https://signpath.org/apply> 申请。

通过后的两段式签名（原因：SignPath 不能深签 NSIS，安装包内部的 exe 必须单独先签）：

1. `electron-builder --win --dir` 生成 `release/win-unpacked/`；
2. 只打包其中的 `Qiansi.exe` 上传 artifact，用 `.signpath/artifact-configurations/qiansi-inner.xml` 提交签名请求；
3. 下载已签名 exe，覆盖回 `win-unpacked/`；
4. `electron-builder --win nsis portable --prepackaged release/win-unpacked` 重打安装包；
5. 上传 `Qiansi-Setup-*.exe` 与 `Qiansi-*-portable.exe`，用 `qiansi-installer.xml` 再签一次；
6. 对签名产物重算 SHA256，再发 Release。

CI 需要的配置：

- secret `SIGNPATH_API_TOKEN`（CI user 的 token，裸值）；
- variable `SIGNPATH_ORGANIZATION_ID`（GUID）、`SIGNPATH_PROJECT_SLUG`、`SIGNPATH_SIGNING_POLICY_SLUG`；
- 工作流权限至少 `actions: read` + `contents: read`；
- `wait-for-completion-timeout-in-seconds` 建议 1800–3600，因为 release 签名需要人工批准，一个版本两次审批。

签名后发布者显示为 SignPath Foundation；这不影响 UAC 显示与防篡改，但 SmartScreen 仍按下载量积累声誉。

### 自有证书（PFX / 云签名）

`apps/desktop/electron-builder.yml` 已配置 `signtoolOptions.rfc3161TimeStampServer`。

- **PFX（旧式证书）**：base64 写入 secrets `CSC_LINK`，密码写入 `CSC_KEY_PASSWORD`，CI 只在标签构建时注入。
- **云签名 / 硬件令牌**：electron-builder 的内建 signtool 无法在 CI 使用 USB 设备；用云签名 CLI（自定义 `sign` hook）或自托管 runner。
- **证书 CN 必须与产品名一致**：当前 `productName` 是 `Qiansi`；改名会导致自动更新校验失败。

签名后验证：

```powershell
Get-AuthenticodeSignature .\release\Qiansi-Setup-0.1.0.exe | Format-List
```

## 6. 发布前人工检查

- [ ] 版本号三处一致（`version:check` 通过）
- [ ] 安装包与便携版都能在干净 Windows 上启动
- [ ] `SHA256SUMS.txt` 与产物同名同版本
- [ ] SmartScreen 表现符合预期（未签名会提示；OV/SignPath 证书需要声誉积累）
- [ ] CHANGELOG 已更新
- [ ] 草稿 Release 的说明与附件正确，再点发布

## 7. 名称与账号现状（2026-10-21 核查）

- GitHub 精确 handle `qiansi` 已被个人账号占用；`qiansi-app`、`qiansi-labs`、`qiansilabs` 可用。
- npm 包名 `qiansi` 未发布；`@qiansi` scope 需要登录 npm 后确认。
- `qiansi.com`、`qiansi.cn` 已注册；`qiansi.dev`、`qiansi.app` 未注册。
- 中文名「牵丝」未发现同类 AI 产品；存在同名软件公司（南京牵丝）与第 6 类、第 44 类在先商标；第 9/42 类未查到有效注册，但公开库有 3–6 个月盲期，正式商用前应在 CNIPA 做一次官方检索。

## 8. winget（可选，后续）

需要：稳定公开的 Release URL、已签名的 NSIS 安装包、`InstallerSha256`。清单提交到 `microsoft/winget-pkgs`，PackageIdentifier 建议 `Qiansi.Qiansi`。
