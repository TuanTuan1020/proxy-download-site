# 部署与运维说明

本文只给方案与步骤，**不会代替你购买服务、开通套餐、充值、修改 DNS 或公开部署**。凡是需要账号/付费/备案的动作，都标成“需要你确认”。

---

## 1. 推荐方案（维护成本最低）

| 部分 | 推荐 | 备选 | 说明 |
| --- | --- | --- | --- |
| 网页前端 | **Cloudflare Pages** | GitHub Pages | 免费、自带 CDN、支持自定义域；仓库里 `web/` 直接作为产物目录 |
| 定时任务 | **GitHub Actions**（`*/10`） | VPS 上的 cron / systemd timer | Actions 免费，但**会延迟**；要严格 5~8 分钟用 VPS |
| 安装包存储 | **Cloudflare R2** | 阿里云 OSS / 腾讯云 COS / B2 / 自建 | R2 免费额度 10 GB 存储、**出站流量免费**，最省心 |
| 下载域名 | `dl.example.com` → R2 自定义域 | `dl.example.com` → 国内 CDN 回源 OSS | 大陆节点需要 **ICP 备案** |
| 下载下发 | R2 公网域（对象带 `Content-Type`/`Content-Disposition`） | 本站 Node 服务 `/download` 路由 + CDN | 两种都在代码里支持 |

**为什么这样分工**：前端纯静态可以随便扩缩容；采集/同步跑在定时任务里，失败不影响站点展示；安装包放对象存储，不占服务器带宽；下载域名与前端分离，换 CDN 不动代码。

**中国大陆可用性提醒**：Cloudflare 免费版在大陆访问不稳定，R2 公网域也走境外。若主要用户在大陆，更合适的组合是「阿里云 OSS + 阿里云 CDN（备案域名）」或「香港/新加坡机房 + 备案域名 + CDN」。**这两者都需要费用与备案，需要你确认后再做。**

---

## 2. 部署步骤

### 2.0 你需要准备

- [ ] GitHub 账号（用于仓库、Actions、Pages）
- [ ] 对象存储账号 + 一个桶 + 访问密钥（R2 或 OSS/COS）
- [ ] 一个可用于下载的域名（可先不绑定，用存储默认域）
- [ ] `ADMIN_TOKEN`（自己生成：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`）
- [ ] GitHub Token（可选但强烈建议：只读 public 仓库即可）

### 2.1 推到 GitHub（**需要你的授权**）

当前环境 `gh` 未登录、也没有任何 GitHub 凭据，所以**我没有也无法替你创建仓库或推送**。你可以二选一：

```bash
# 方式 A：用 GitHub CLI 登录后自动创建并推送
cd proxy-download-site
gh auth login
gh repo create <你的用户名>/proxy-download-site --public --source=. --remote=origin --push

# 方式 B：先在网页上建空仓库，再本地推送
cd proxy-download-site
git init -b main
git add .
git commit -m "feat: 代理客户端下载站（前端 + 采集 + 同步 + 下载服务）"
git remote add origin https://github.com/<你的用户名>/proxy-download-site.git
git push -u origin main
```

若让我代做：把仓库地址给我、或在本会话里配置好 `gh auth login`/`GH_TOKEN`，我再执行推送与发布。

### 2.2 建桶（Cloudflare R2 示例）

1. R2 → Create bucket，名字如 `proxy-downloads`。
2. 创建 API Token（Object Read & Write），记下 `Access Key ID` / `Secret Access Key`，以及 S3 Endpoint（`https://<accountid>.r2.cloudflarestorage.com`）。
3. 给桶配**公开访问**：R2 → Settings → Public Access → 自定义域填 `dl.example.com`（或先用 `r2.dev` 测试域）。
4. CORS 一般不需要（下载是同源直链/302，不是 XHR）。

### 2.3 配置仓库变量与密钥

仓库 → Settings → Secrets and variables → Actions：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `S3_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` |
| Secret | `S3_BUCKET` | `proxy-downloads` |
| Secret | `S3_ACCESS_KEY_ID` | 你的 Access Key |
| Secret | `S3_SECRET_ACCESS_KEY` | 你的 Secret |
| Secret | `PAT_TOKEN`（可选） | 个人只读 Token；不填则用 `GITHUB_TOKEN` |
| Variable | `S3_REGION` | `auto` |
| Variable | `S3_PUBLIC_BASE_URL` | `https://dl.example.com` |
| Variable | `PUBLIC_DOWNLOAD_BASE` | `https://dl.example.com`（指向下载域） |

> `PUBLIC_DOWNLOAD_BASE` 写成完整 URL 时，前端按钮直接用绝对地址；写成 `/download` 时必须由 Node 服务处理下载。
>
> **只部署 GitHub Pages（纯静态）时**：一定要把 `PUBLIC_DOWNLOAD_BASE` 设为下载服务或 CDN 的完整地址（如 `https://dl.example.com`），否则页面会提示“当前为纯静态部署，本站下载需要独立的文件服务”。这是有意设计的降级提示，不会静默给出坏链接。

### 2.4 启用 Pages

Settings → Pages → Source 选 **GitHub Actions**。之后每次 `update.yml` 跑完会自动部署 `web/`。

### 2.5 首次运行与验证

```bash
# 本地先确认一遍
cp .env.example .env     # 填 S3_* 与 PUBLIC_DOWNLOAD_BASE
node scripts/update.js   # 采集 + 同步 + 发布
node scripts/server.js   # 打开 http://127.0.0.1:8787 检查

# 推上去后在 Actions 里手动 Run workflow
```

验证清单：

1. `web/data/site.json` 里 `items[].downloads.*.options[].href` 指向你的下载域；
2. `curl -I https://dl.example.com/packages/...` 返回 `Content-Type`、`Content-Disposition: attachment`、`Accept-Ranges: bytes`；
3. `curl -r 0-1023 -o /dev/null -w '%{http_code}' <url>` 返回 `206`；
4. 下载后 `sha256sum` 与站点显示的 SHA-256 一致；
5. 页面首屏“站点数据更新时间”是最近 10 分钟内的。

### 2.6 更稳的定时（可选，需 VPS）

若你有一台 VPS，用 systemd timer 比 Actions 准时：

```ini
# /etc/systemd/system/proxy-site-update.service
[Unit]
Description=代理下载站数据更新
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/proxy-download-site
EnvironmentFile=/opt/proxy-download-site/.env
ExecStart=/usr/bin/node scripts/update.js --reason=systemd
```

```ini
# /etc/systemd/system/proxy-site-update.timer
[Unit]
Description=每 6 分钟更新一次

[Timer]
OnBootSec=2min
OnUnitActiveSec=6min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now proxy-site-update.timer
journalctl -u proxy-site-update.service -f
```

也可以用容器 + 外部 cron（如 `ofelia`）或云厂商函数计算定时触发器。

---

## 3. 环境变量对照表

| 变量 | 必填 | 默认 | 作用 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | 强烈建议 | 空 | 提高 API 配额（未认证 60 次/小时不够 11 个项目每 5~10 分钟跑） |
| `ALLOW_HTML_FALLBACK` | 否 | `true` | 限流时退回 github.com 页面采集（数据标记 html-fallback） |
| `CHECK_INTERVAL_MINUTES` | 否 | `8` | 内置定时器间隔 |
| `STALE_AFTER_MINUTES` | 否 | `30` | 超过多久提示“数据可能过期” |
| `MAX_ASSET_MB` | 否 | `400` | 单文件体积上限（超出跳过） |
| `MAX_PARALLEL_SYNC` | 否 | `2` | 项目级并发 |
| `RETRY_BACKOFF_MAX_SECONDS` | 否 | `900` | 采集失败退避上限 |
| `STORAGE_DRIVER` | 是 | `local` | `local` 或 `s3` |
| `LOCAL_STORAGE_DIR` | 否 | `./storage/files` | 本地驱动目录 |
| `S3_*` | s3 时必填 | — | 对象存储连接与凭据 |
| `S3_PUBLIC_BASE_URL` | 建议 | 空 | 桶的公网/CDN 前缀 |
| `PUBLIC_DOWNLOAD_BASE` | 建议 | `/download` | 下载链接前缀，可写完整 URL |
| `RETENTION_KEEP_VERSIONS` | 否 | `2` | 保留最近几个稳定版本 |
| `ADMIN_TOKEN` | 可选 | 空 | 打开后台接口；为空则全部禁用 |
| `PORT` / `HOST` | 否 | `8787` / `127.0.0.1` | 监听地址（生产用反向代理，前面挂 Nginx/Caddy） |

---

## 4. 费用与预算提醒

假设：11 个项目、每项目 3~8 个安装包、每版本约 400 MB、保留 2 个版本 → 存储约 **3~8 GB**；若有 1000 次下载/天、平均 60 MB → **约 1.8 TB/月**流量。

| 项目 | 免费额度 | 超出后参考价 | 备注 |
| --- | --- | --- | --- |
| Cloudflare R2 存储 | 10 GB / 月 | 约 $0.015/GB·月 | 出站流量 **0 元** |
| Cloudflare R2 请求 | 100 万 Class A + 1000 万 Class B/月 | 很低 | 下载主要算 Class B |
| Cloudflare Pages | 无限静态请求、500 次构建/月 | 免费 | 构建次数够用 |
| GitHub Actions | 公开仓库免费；私有 2000 分钟/月 | — | 每次更新 1~3 分钟 |
| 阿里云 OSS + CDN（大陆） | 新用户有试用 | OSS 约 ¥0.12/GB·月；CDN 流量约 ¥0.2~0.24/GB | 1.8 TB ≈ **¥360~430/月**，需备案 |
| 腾讯云 COS + CDN | 新用户有试用 | 与阿里云接近 | 需备案 |

> 结论：**R2 + Pages + Actions ≈ 0 元/月**（在免费额度内）；**大陆 CDN 方案是主要成本项，按流量计费，必须设预算提醒。**

预算提醒怎么设：

- **Cloudflare**：Dashboard → Billing → 设置用量通知；R2 建议直接绑定付费方式并开启低额度告警邮件。
- **阿里云**：费用中心 → 预算管理 → 新建预算（按月，例如 ¥200），设置 50%/80%/100% 邮件+短信告警；再开“可用额度预警”。
- **腾讯云**：费用中心 → 预算与告警。
- **兜底**：CDN 控制台配置「流量封顶」或「带宽封顶」，到阈值自动停服，避免被刷爆；同时给下载域加基础限速/防盗链（Referer 白名单）。
- 建议把 `MAX_ASSET_MB` 与保留版本数调小，控制存储与首次回源流量。

---

## 5. 更新、回滚与排错

### 日常更新

```bash
node scripts/update.js                 # 全量：采集 + 同步 + 发布
node scripts/update.js --source=flclash
node scripts/update.js --force         # 强制重同步（同版本资产被替换时）
```

站点数据是 `web/data/site.json` 单文件，**回滚 = 回到上一个版本的该文件**：

```bash
git log --oneline -- web/data/site.json
git checkout <上一个提交> -- web/data/site.json
git commit -m "revert: 回滚站点数据"
git push
```

安装包本身按 `packages/<id>/<tag>/` 版本化，旧版本文件在清理前一直存在，回滚数据即恢复旧下载链接。`state/state.json` 也一起提交，回滚它可让同步重新判断。

### 常见故障

| 现象 | 可能原因 | 定位与处理 |
| --- | --- | --- |
| 所有项目 `failed`，日志有 403 rate limit | 未配置 `GITHUB_TOKEN` | 配 Token；或保留 `ALLOW_HTML_FALLBACK=true` 让采集走网页回退 |
| 卡片显示“元数据来自网页回退” | API 限流触发了回退 | 正常降级；大小为近似值，下载仍按实际字节校验 |
| 项目长期 `syncing` | 安装包体积超过 `MAX_ASSET_MB`，或下载被墙 | 看 `npm run sync -- --source=<id>` 输出；必要时调大上限或用代理 |
| 下载 404 | 该文件未同步完成 / 已被清理 | 看 `/api/admin/status` 的 `syncedFiles`；旧版本可用时界面会标注 |
| 下载返回 HTML | 上游重定向到登录/错误页 | 同步阶段就会被 `Content-Type`/魔数拦截，不会入库；重试或检查仓库是否改私有 |
| 数据不更新 | 定时任务没在跑 / 锁未释放 | `ls state/locks`；确认 Actions 是否被禁用（60 天无提交会暂停） |
| 上传失败 403 | R2/S3 密钥权限不足或签名区域不对 | 确认 Access Key 有 Object Write；`S3_REGION=auto` |
| 站点数据过期提示 | 最后一次成功发布超过 `STALE_AFTER_MINUTES` | 查 Actions 运行记录与 `state/logs/*.log` |

日志位置：`state/logs/YYYY-MM-DD.log`（JSON 行，已脱敏）；也可通过 `/api/admin/logs` 读取。

---

## 6. 没有凭据时会怎样（当前本地状态）

- **不配置存储**：`update.js` 只发布元数据，所有下载按钮显示“本站下载暂不可用”，主行动为“官方下载（GitHub）”，并按 `mirror.enabled` 区分“本站不提供镜像”。
- **不配置 `GITHUB_TOKEN`**：走 HTML 回退，页面会标注“元数据来自网页回退”。
- **不配置 `ADMIN_TOKEN`**：后台接口返回 503，不影响前台。
- **不配置 `PUBLIC_DOWNLOAD_BASE`**：下载链接为相对路径 `/download/...`，需要 Node 服务提供下载。

这些降级行为都是**显式**的，不会把未完成的功能显示成“可用”。

---

## 7. 大陆访问与合规

1. 大陆节点（阿里云/腾讯云 CDN）需要 **域名 ICP 备案**；未备案只能用香港/新加坡/境外节点。
2. 备案与 CDN 都属于需要你本人实名与付费的操作，本仓库不代为办理。
3. 站点只做客户端导航，不涉及节点/订阅分发；请自行确认所在地区对相关工具的合规要求。
4. 建议在页脚保留“本站不承诺任何网络环境下都可下载”的说明（已内置）。
