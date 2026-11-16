# 牵丝 DSH 插件市场索引

DSH 没有中心化的官方商店：**一个插件市场就是一份自托管的 JSON 索引**（格式 1），用户在「插件 → 发现 → 添加索引源」里填 URL 即可浏览与安装。这里的 `index.json` 就是牵丝自建的市场索引。

## 使用

在 DSH 里添加索引源：

```
https://raw.githubusercontent.com/qiansi-app/qiansi/main/dsh/marketplace/index.json
```

指向仓库的 GitHub Raw 地址即可；也可以把整个目录发到任意 https 静态托管（GitHub Pages、对象存储）。图标是内联 SVG data URI，不依赖额外的图标文件。

## 内容

| 文件 | 作用 |
|---|---|
| `index.json` | 市场索引（format 1），目前列出 `qiansi-dsh@0.2.0` |
| `qiansi-icon.svg` / `icon.b64` | 图标源文件与内联 base64（索引里用的是 base64） |
| `validate.mjs` | 校验脚本：优先调用本机 DSH 的官方校验器，没有 DSH 时做结构检查 |

## 发新版本

1. `dsh/qiansi/package.json` 的 `version` 递增，并 `npm publish`（或 `npm pack` 给出 tarball）。
2. 更新 `index.json`：
   - `versions[0].version` 改成新版本；
   - `versions[0].publishTimestamp` 改成发布时的 Unix 秒；
   - 如需保留旧版本，往 `versions` 里追加并按 SemVer 降序排列。
3. 校验：`node dsh/marketplace/validate.mjs`（期望输出 `MARKET INDEX OK`）。
4. 提交推送后，DSH 用户在「发现」里刷新即可看到。

## 索引格式（来自 DSH 官方实现）

顶层：`format: 1`、`title`（`{en, zh…}`）、可选 `description`、`metadata.categories/labels/sortKeys`、`plugins[]`。

每个 plugin：`name`（npm 包名）、`title`/`description`（本地化，必须有 `en`）、`icon`（`data:` 或绝对 URL）、`author`、`homepage`、`repository {url, directory}`、`metadata {category, keywords, labels, sortKeys}`、`versions[]`。

每个 version：精确 SemVer `version`、`publishTimestamp`（Unix 秒）、`source`（`{type:'npm', registry?}` 或 `{type:'git', url, commit(40 位小写 sha), path?}`）、`engines {dsh}`。

安装时 DSH 会把条目转换成 `name@version`（npm）或固定 commit 的 `git+https`（git）。牵丝用 npm 源，`qiansi-dsh@0.2.0` 已于 2026-11-16 发布到公共注册表；无法联网时可用 tarball 或 `link:` 方式安装。
