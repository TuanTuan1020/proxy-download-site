# 代理客户端下载站

面向国内用户的 Windows / macOS / Android 代理客户端下载站：**静态前端 + GitHub Releases 采集 + 安装包同步 + 下载服务 + 定时任务**。

> 本项目只做客户端获取与版本导航，不提供节点、订阅或账号交易。

---

## 0. 先说清楚边界（重要）

这套系统由 **5 个可以独立部署、职责不同的部分**组成。静态网页本身**不具备**持续抓取、文件同步或国内加速能力，它只是一个消费数据的界面：

| 层 | 职责 | 部署位置 | 不能做什么 |
| --- | --- | --- | --- |
| ① 网页前端 | 渲染卡片、系统/架构筛选、状态展示 | 静态托管（GitHub Pages / Cloudflare Pages / 任意 OSS） | 不能抓 GitHub、不能同步文件、不能加速下载 |
| ② GitHub 数据采集 | 定时查询官方 Releases，比较版本与资产 | Node 脚本（Actions / VPS / 容器） | 不能替上游发布，不能给别人的仓库装 Webhook |
| ③ 安装包同步与存储 | 流式下载 → 校验 → 上传 → 版本化存储 | Node 脚本 + 对象存储（R2/S3）或本机目录 | 不能镜像未授权/未确认许可的软件 |
| ④ 下载服务 | 返回安装包，支持 Range、正确头部 | 本站 Node 服务 / 对象存储公网域名 / CDN | 不能保证任何网络环境下都可达 |
| ⑤ 定时任务与更新状态 | 触发 ②③、记录检查/同步时间与错误 | Actions schedule / cron / systemd timer | 轮询 ≠ 实时；Actions 定时会延迟 |

首页显示的“站点数据更新时间”只是最近一次发布的快照时间，**每个项目卡片另有独立的检查时间与同步时间**，某个项目长期失败不会被整体时间掩盖。

---

## 1. 目录结构

```
proxy-download-site/
├── config/
│   ├── sources.json          # 唯一项目清单：仓库、平台、许可证、资产匹配规则
│   └── site.json             # 站点文案、检查间隔、保留策略、FAQ
├── web/                      # 静态前端（部署产物目录）
│   ├── index.html
│   ├── assets/{app.js,shared.js,styles.css}
│   └── data/site.json        # 由采集/发布流程生成，前端读取
├── scripts/
│   ├── collect.js            # 只采集元数据
│   ├── sync.js               # 只同步安装包（可 --source/--file）
│   ├── update.js             # 采集 + 同步 + 发布（推荐入口）
│   ├── cleanup.js            # 旧版本清理预览（默认只预览）
│   ├── server.js             # 静态站点 + 下载路由 + 后台接口 + 定时器
│   └── lib/                  # github / http / classify / checksums / store / state / lock / publish
├── tests/
│   ├── verify.mjs            # 26 项单元 + HTTP 集成验证
│   └── browser-check.mjs     # 16 项真实浏览器交互/布局验证（CDP）
├── .github/workflows/update.yml
├── docs/screenshots/         # 本地渲染截图
├── DEPLOY.md                 # 部署、成本、回滚、排错
└── .env.example              # 环境变量模板（不含真实密钥）
```

运行期目录（默认不入库）：`state/`（状态、日志、锁，其中 `state/state.json` 建议入库以便 Actions 复用）、`storage/`（本机安装包）、`tmp/`（临时下载）。

---

## 2. 本地运行

要求：**Node.js ≥ 20.11**（无第三方依赖，无需 npm install）。

```bash
cp .env.example .env          # 可留空：留空时用 HTML 回退采集，下载按钮显示“暂不可用”
node scripts/collect.js       # ① 采集官方 Release 元数据 → web/data/site.json
node scripts/sync.js          # ③ 下载 + 校验 + 存到本地 storage/（需本地存储，默认已开启）
node scripts/server.js        # ④ 启动站点：http://127.0.0.1:8787
```

一步完成采集 + 同步 + 发布（含定时器）：

```bash
npm run dev        # = node scripts/server.js --update-on-start
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run collect` | 只更新元数据（不动安装包） |
| `npm run sync` | 只同步安装包（幂等，已同步且未变化会跳过） |
| `npm run update` | 采集 + 同步 + 原子发布站点数据（带全局锁） |
| `npm run server` | 启动站点、下载服务、内置定时器（默认 8 分钟） |
| `npm run cleanup` | 列出未被引用的文件（**只预览，不删除**） |
| `npm run cleanup:apply -- --yes` | 真正删除未被引用的文件 |
| `npm test` | 26 项单元 + HTTP 集成验证 |
| `npm run test:browser` | 16 项真实浏览器（Chrome）交互与布局验证 |

可选参数：`--source=flclash,throne`（限定项目）、`--force`（忽略“未变化”判断强制重同步）、`--file=<文件名>`（限定文件）。

---

## 3. 收录清单（2026-11-07 逐个核实官方仓库）

> 表中“最近版本”为核实当天官方 latest 标记版本；之后由自动任务更新。**没有逐一核实过的项目不会出现在清单里。**

| 软件 | 官方仓库 | 平台 | 许可证 | 本站镜像 | 维护状态 |
| --- | --- | --- | --- | --- | --- |
| Clash Verge Rev | `clash-verge-rev/clash-verge-rev` | Windows、macOS | GPL-3.0 | ✅ 允许 | 活跃 |
| Clash Party（原 Mihomo Party） | `mihomo-party-org/clash-party` | Windows、macOS | GPL-3.0 | ✅ 允许 | 活跃 |
| FlClash | `chen08209/FlClash` | Windows、macOS、Android | GPL-3.0 | ✅ 允许 | 活跃 |
| Clash Nyanpasu | `LibNyanpasu/clash-nyanpasu` | Windows、macOS | GPL-3.0 | ✅ 允许 | 活跃 |
| v2rayN | `2dust/v2rayN` | Windows、macOS | GPL-3.0 | ✅ 允许 | 活跃 |
| v2rayNG | `2dust/v2rayNG` | Android | GPL-3.0 | ✅ 允许 | 活跃 |
| Clash Meta for Android（CMFA） | `MetaCubeX/ClashMetaForAndroid` | Android | GPL-3.0 | ✅ 允许 | 活跃 |
| NekoBox for Android | `MatsuriDayo/NekoBoxForAndroid` | Android | GPL-3.0 | ✅ 允许 | ⚠️ 更新较慢（2026-02 之后无新版本） |
| sing-box（SFA/SFM/SFW 图形界面） | `SagerNet/sing-box` | Windows、macOS、Android | GPL-3.0 + 名称附加条款 | ✅ 允许（原样再分发） | 活跃 |
| Hiddify | `hiddify/hiddify-app` | Windows、macOS、Android | Hiddify Extended GPL-3.0 | ⛔ 仅官方入口 | 活跃 |
| Throne（NekoRay 后继） | `throneproj/Throne` | Windows、macOS | GPL-3.0 | ✅ 允许 | 活跃 |

核实要点（都已写进 `config/sources.json` 的注释性字段）：

- **不收录 iOS**：Hiddify 的 `.ipa`、sing-box 的 SFI 包都在排除规则里。
- **不把核心程序当客户端**：sing-box 的 `sing-box-*.tar.gz` 命令行核心从不进入列表，只收 SFA/SFM/SFW 图形界面。
- **已归档项目不收录**：NekoRay（`MatsuriDayo/nekoray`）已于 2025-03 归档，因此改用其后继项目 Throne，并在卡片注意事项中说明。
- **Hiddify 默认不镜像**：其许可证在 GPL-3.0 之上附加了额外条款，本站只提供 GitHub 官方资产入口，不擅自上传；如需镜像，请先自行确认条款再改 `mirror.enabled`。
- **仓库改名**：Mihomo Party 的仓库已更名为 `mihomo-party-org/clash-party`，配置使用新地址。
- **架构未标注就标“未标注”**：Throne 的 `windows-universal-installer.exe`、Hiddify 的 macOS 包文件名不含架构信息，界面显示“架构未标注”，不做猜测。

### 维护清单

只改 `config/sources.json`，重启/重新采集即可：

```jsonc
{
  "id": "flclash",
  "repo": "chen08209/FlClash",
  "platforms": ["windows", "macos", "android"],
  "license": { "label": "GPL-3.0", "redistribution": "allowed", "note": "…" },
  "mirror": { "enabled": true, "note": "" },
  "checksum": { "type": "sumfile", "file": "SHA256SUMS" },
  "exclude": ["^SHA256SUMS$", "linux-"],
  "rules": [
    {
      "match": "^FlClash-[0-9.]+-windows-(?<arch>amd64|arm64)-setup\\.exe$",
      "platform": "windows", "format": "exe", "variant": "installer", "arch": "$arch"
    }
  ]
}
```

规则按顺序匹配文件名，`arch` 支持 `$命名分组`；`exclude` 在规则之前生效（签名、源码、Linux 包等）。配置自检会检查重复 id、无效正则、`official-only` 却开启镜像等冲突。

---

## 4. 安装包匹配原则

1. **只认规则，不猜**：文件名匹配不到任何规则 → 归入“未识别”，界面只显示官方名称，绝不推荐。
2. **源码与签名文件永不当安装包**：`Source code (zip/tar.gz)`、`*.sig`、`*.asc`、`*.sha256`、`*.json`、`*.blockmap`、`*.dSYMs.zip`、`*.app.tar.gz`、`*.ipa` 全部排除。
3. **架构规范化**：`x64/x86_64/amd64/Intel` → `x64`；`arm64/aarch64/Apple` → `arm64`；`armeabi-v7a/armv7/arm7` → `armeabi-v7a`；`Universal` 保留。
4. **安装版/便携版分离**：`-setup.exe`=安装版；`-portable`/`-portable.zip`/无 setup 的 zip=便携版；`-desktop` 标注“需要 .NET 桌面运行时”。
5. **主推荐顺序**：先按用户选择的架构，再按“安装版 > 便携版”与“dmg > pkg > zip”。

---

## 5. 状态字段含义

项目级 `syncState`：

| 值 | 含义 |
| --- | --- |
| `ok` | 最新稳定版的所有匹配安装包都已同步并校验 |
| `partial` | 部分安装包已同步 |
| `syncing` | 最新版正在同步，尚无可用文件 |
| `stale` | 最新版未同步完成，但可下载已校验的旧版本（界面明确标注旧版本号） |
| `failed` | 采集/同步失败，保留上一次成功数据 |
| `official-only` | 按许可证/条款不提供本站镜像 |

文件级 `status`：

| 值 | 行为 |
| --- | --- |
| `ready` | 主按钮直连本站下载（`/download/...`），带准确版本、大小、SHA-256 |
| `stale` | 主按钮下载**旧版本**，按钮文字与提示都写明旧版本号，另附官方新版入口 |
| `unavailable` | 主按钮禁用并显示“本站下载暂不可用”，主行动改为“官方下载（GitHub）” |
| `official-only` | 显示“本站不提供镜像”，只给官方入口 |

哈希来源 `verified`：

- `official-checksums`：与上游发布的 `SHA256SUMS`/`.sha256` 核对一致 → 界面显示“已与官方校验值核对”
- `github-digest`：与 GitHub API 提供的资产摘要一致 → “与 GitHub 资产摘要一致”
- `self-only`：只有本站计算的哈希 → “本站计算的哈希（未获得官方校验值）”

**本站计算哈希不等于官方认证或安全保证**，界面文案也据此区分。

---

## 6. 自动追踪更新

1. **采集**：`GET /repos/{repo}/releases?per_page=N`，带 `ETag` 条件请求；304 时只更新“最近检查时间”。限流（403/429）或网络失败时可退回 `github.com` 的 Atom + `expanded_assets` 页面（数据标记 `html-fallback`，大小为近似值）。
2. **比较**：Release ID、tag、发布时间、资产 ID、文件名、大小、更新时间、SHA-256 摘要。同版本资产被替换（摘要/大小/更新时间变化）会重新同步。
3. **同步触发**：`update.js` 顺序执行采集 → 同步；同步本身幂等，未变化的文件直接跳过，不重复下载/上传。
4. **并发与锁**：全局 `state/locks/update.lock`（O_EXCL 原子创建，超时视为僵尸锁），保证定时任务与手动触发不会同时跑；`MAX_PARALLEL_SYNC` 控制项目级并发，项目内串行。
5. **原子发布**：每个文件校验通过后立即原子改写 `web/data/site.json`（写临时文件 + rename），下载指向永不指向未完成文件。
6. **失败隔离**：单个资产失败只记录 `assetErrors`，其它资产/项目继续；失败时**保留上一次成功版本**。
7. **重试与退避**：HTTP 层指数退避 + 抖动（5xx/429/网络错误，尊重 `Retry-After`）；采集失败按 `60s × 2ⁿ` 退避（上限 `RETRY_BACKOFF_MAX_SECONDS`），记录 `nextRetryAt`。
8. **时效**：默认 8 分钟一次（`CHECK_INTERVAL_MINUTES`）。**这是轮询，不是实时**；Actions 的 `*/10` 经常延迟数分钟到十几分钟。

---

## 7. 安装包同步与下载服务

同步流程：`流式下载 → 临时文件 → 文件头魔数校验 → 大小校验 → SHA-256 → 官方校验值/摘要比对 → 上传存储 → 原子更新状态与站点数据`。

- **不整包进内存**：`Readable.fromWeb` + 写流 + 增量哈希。
- **不把错误页当安装包**：`Content-Type: text/html` 直接拒绝；文件头魔数不匹配（例如 APK 必须以 `PK\x03\x04` 开头）也拒绝。
- **不修改安装包**：原样保存，不重打包、不注入任何内容。
- **版本化存储**：`packages/<id>/<tag>/<filename>`，天然避免 CDN 缓存串版本。
- **保留策略**：默认保留最近 2 个成功同步的稳定版本；`npm run cleanup` 只预览，`--apply --yes` 才删除。
- **下载路由**：`/download/packages/<id>/<tag>/<filename>`
  - 正确 `Content-Type`（按扩展名）与 `Content-Disposition: attachment`（含 RFC 5987 的 `filename*`）
  - `Accept-Ranges: bytes`，支持 `Range` → `206 Partial Content`，非法范围 `416`
  - `ETag`（取 SHA-256 前缀）、`Last-Modified`、`Cache-Control: public, max-age=31536000, immutable`
  - 只返回**状态里登记过**的键，天然防目录穿越；未登记返回 404 JSON，不会伪造下载
  - S3 驱动时 302 到公网域名或预签名 URL，不经过 Node 内存

### 后台接口（需 `ADMIN_TOKEN`）

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'Content-Type: application/json' -d '{"sources":["flclash"]}' \
     http://127.0.0.1:8787/api/admin/update
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/api/admin/status
curl -H "Authorization: Bearer $ADMIN_TOKEN" 'http://127.0.0.1:8787/api/admin/logs?lines=100'
```

公开接口只有 `/api/health`、`/api/status`、`/data/site.json`。未配置 `ADMIN_TOKEN` 时后台接口整体返回 503，不会暴露任何管理能力。

---

## 8. 前端功能

- 系统筛选（Windows / macOS / Android / 全部）、架构筛选、名称搜索、仅显示仍在维护、显示预发布信息
- 打开页面自动识别系统；**架构识别不可靠时不猜**（macOS 浏览器无法区分 Apple Silicon / Intel，会明确要求手动选择；Android 浏览器不暴露 CPU 架构）
- 每张卡片：图标、中文简介、支持系统、仓库、维护状态、最新官方版本、本站可下载版本、发布时间、最近检查、最近同步、同步状态、格式/架构/大小、主下载按钮、官方下载、仓库、发布说明、SHA-256 复制
- 深浅色主题（跟随系统，可手动切换并记忆）、手机/桌面布局、键盘可聚焦、`aria-live` 筛选结果播报、跳过导航链接
- 明确提示：数据过期、网页回退数据、下载不可用、旧版本兜底、GitHub 直链国内可能不稳定
- 筛选状态写入 URL（`?platform=android&arch=arm64-v8a&q=flclash`），便于分享与自动化验证

---

## 9. 安全与合规

- 下载源**白名单**：仅 `github.com`、`api.github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`codeload.github.com`、`raw.githubusercontent.com`，且必须 `https`；每次重定向都重新校验（防 SSRF / 任意 URL 代理）。
- 令牌只在服务端环境变量里，前端与 `web/data/site.json` 不含任何密钥；日志统一脱敏（token、`Bearer` 头一律替换为 `***`）。
- 项目清单与同步接口不对普通访问者开放；后台接口需要 Bearer 令牌且使用定时安全比较。
- 依据许可证决定是否镜像：GPL-3.0 允许原样再分发（保留版权与源码链接）；许可不明或附加条款复杂的（Hiddify）默认只给官方入口。
- 不伪造下载量、评分、用户数、安全认证；不使用来源不明的公共 GitHub 加速站作为默认通道。

---

## 10. 本次实际验证结果

环境：macOS + Node v24.22.1，Chrome 无头浏览器，2026-11-07。

**单元 + HTTP 集成（`npm test`）：26 项全部通过**

- 配置自检、收录规则（含 nekoray 归档排除）、许可证与镜像一致性
- 源码包/签名/校验文件不会被当成安装包
- Android 三种架构、Windows 安装版/便携版、macOS 架构别名规范化
- 未知命名不产生推荐；sing-box 不把 CLI 核心当客户端
- 新版本同步完成=可下载；**新版未同步完成=标注旧版本号**；无记录=只给官方入口；未授权=仅官方
- SSRF 白名单、HTML 错误页拒绝、前端/数据无密钥
- 系统识别（Android/Windows/macOS/iOS/Linux）
- 下载服务：HEAD 头部正确、`Range` 206、整包 SHA-256 与登记值一致、未登记文件 404、路径穿越被拒、后台接口鉴权

**真实浏览器（`npm run test:browser`，Chrome DevTools Protocol）：16 项全部通过**

- 首页渲染、自动识别提示、点击 Android 后只剩 Android 项目、架构下拉重建、URL 同步
- 主下载按钮指向 `/download/...` 而不是 GitHub 网页
- 搜索、主题切换、SHA-256 展示、未同步项目有明确提示
- 390px 手机宽度无横向溢出、按钮点击高度、键盘可聚焦

**真实同步演示（非伪造数据）**

- 采集：11 个项目全部通过 `github.com` 页面回退采集到真实版本（本地 IP 的 GitHub API 配额当时已耗尽，回退路径因此被真实触发）
- 同步：NekoBox 4 个 APK + Throne Windows/macOS 各 1 个包，共 6 个文件（约 180 MB），全部通过 GitHub 资产摘要校验
- 下载：`curl` 实测整包 SHA-256 与登记一致、`Range` 返回 206、未登记文件返回 404

---

## 11. 未验证 / 已知限制

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| GitHub REST API 主路径（ETag 304） | 本次未实跑 | 本机共享 IP 的未认证配额耗尽（60 次/小时），已用 HTML 回退验证；填 `GITHUB_TOKEN` 后走 API 主路径 |
| S3 / R2 上传与预签名 | 未实跑 | 没有存储账号与凭据；代码已实现 SigV4 签名，需真实桶验证 |
| 国内下载速度 / CDN 命中 | 未验证 | 需要真实域名 + 备案 + CDN，部署后实测 |
| GitHub Actions 定时延迟 | 未验证 | 需要仓库跑起来才能观测，已知 schedule 会延迟 |
| 自动清理删除 | 未执行 | 按要求部署初期只做预览，不自动删除已有文件 |
| 升级/回滚演练 | 未验证 | 需要真实部署环境 |
| 视觉细节（截图核对） | 有限 | 已用无头浏览器做 DOM/布局断言与截图，但未逐像素人工核对 |

---

## 12. 上线还缺什么

代码、配置模板、部署文档已就绪，**以下需要你确认/提供后我才能继续**：

1. **GitHub 账号授权**：本环境 `gh` 未登录、无凭据，无法推送仓库（详见 `DEPLOY.md` 第 2 节）。
2. **对象存储**：Cloudflare R2 / 阿里云 OSS / 腾讯云 COS 任一账号 + 桶 + 访问密钥。
3. **下载域名**：如 `dl.example.com`（大陆节点需 ICP 备案）。
4. **管理令牌**：`ADMIN_TOKEN` 自行生成（命令见 `.env.example`）。
5. **GitHub Token**（强烈建议）：只读公开仓库权限即可，用于把采集频率从 60 次/小时提到 5000 次/小时。

没有这些也能继续本地演示；但**不能说“已经上线可用”**。

---

## 13. 相关文档

- [DEPLOY.md](DEPLOY.md)：推荐部署方案、费用与预算提醒、更新回滚、排错
- `docs/screenshots/`：桌面、手机、深色主题截图
- `.env.example`：全部环境变量与含义
