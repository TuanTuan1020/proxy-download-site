/**
 * 自动化验证：安装包匹配、状态与版本标注、安全校验、下载服务。
 * 运行：node tests/verify.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSiteData } from '../scripts/lib/publish.js';
import { classifyRelease } from '../scripts/lib/classify.js';
import { checkMagic, assertAllowedUrl } from '../scripts/lib/http.js';
import { validateSources, loadSourcesConfig } from '../scripts/lib/config.js';
import { storageIdentity } from '../scripts/lib/env.js';
import { detectPlatform, pickPrimary, normalizeArch, MAGIC_SIGNATURES } from '../web/assets/shared.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const test = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`FAIL  ${name} — ${error.message}`);
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

/* ---------------- 1. 项目清单与规则 ---------------- */

test('项目清单配置无错误', () => {
  const errors = validateSources(loadSourcesConfig());
  assert(errors.length === 0, errors.join('；'));
  const config = loadSourcesConfig();
  return `${config.sources.length} 个项目`;
});

test('清单中不存在被归档项目（nekoray 已归档，改用 Throne）', () => {
  const config = loadSourcesConfig();
  assert(!config.sources.some((s) => s.repo === 'MatsuriDayo/nekoray'), '不应收录已归档的 nekoray');
  assert(config.sources.some((s) => s.id === 'throne'), '应包含 Throne 作为后继项目');
});

test('每个允许镜像的项目都标记了许可证与再分发结论', () => {
  const config = loadSourcesConfig();
  for (const source of config.sources) {
    assert(source.license?.label, `${source.id} 缺少许可证信息`);
    assert(
      ['allowed', 'official-only'].includes(source.license?.redistribution),
      `${source.id} 的再分发结论无效`,
    );
    if (source.mirror?.enabled) {
      assert(source.license.redistribution === 'allowed', `${source.id} 未获允许却开启了镜像`);
    }
  }
  return '已逐个声明';
});

/* ---------------- 2. 资产匹配 ---------------- */

const flclash = loadSourcesConfig().sources.find((s) => s.id === 'flclash');

test('源码包、签名、校验文件不会被当成安装包', () => {
  const release = {
    assets: [
      { name: 'Source code (zip)' },
      { name: 'FlClash-0.9.3-android-arm64-v8a.apk.sig' },
      { name: 'SHA256SUMS' },
      { name: 'output-metadata.json' },
    ],
  };
  const { matched } = classifyRelease(flclash, release);
  assert(matched.length === 0, `被误判为安装包：${matched.map((m) => m.name).join(',')}`);
});

test('Android 各架构 APK 匹配正确', () => {
  const release = {
    assets: [
      { name: 'FlClash-0.9.3-android-arm64-v8a.apk', size: 100 },
      { name: 'FlClash-0.9.3-android-armeabi-v7a.apk', size: 100 },
      { name: 'FlClash-0.9.3-android-x86_64.apk', size: 100 },
    ],
  };
  const { matched } = classifyRelease(flclash, release);
  const arches = matched.map((m) => m.arch).sort();
  assert(
    JSON.stringify(arches) === JSON.stringify(['arm64-v8a', 'armeabi-v7a', 'x86_64']),
    `实际：${arches.join(',')}`,
  );
});

test('Windows 安装版与便携版区分正确', () => {
  const release = {
    assets: [
      { name: 'FlClash-0.9.3-windows-amd64-setup.exe', size: 100 },
      { name: 'FlClash-0.9.3-windows-amd64.zip', size: 100 },
      { name: 'FlClash-0.9.3-windows-arm64-setup.exe', size: 100 },
    ],
  };
  const { matched } = classifyRelease(flclash, release);
  const x64 = matched.filter((m) => m.arch === 'x64');
  assert(x64.length === 2, 'x64 应有安装版与便携版两个文件');
  assert(x64.some((m) => m.format === 'exe' && m.variant === 'installer'), '缺少安装版');
  assert(x64.some((m) => m.format === 'zip' && m.variant === 'portable'), '缺少便携版');
  return '安装版=exe/installer，便携版=zip/portable';
});

test('macOS 架构别名（aarch64/amd64/Apple/Intel）规范化正确', () => {
  assert(normalizeArch('macos', 'aarch64') === 'arm64', 'aarch64 应映射为 arm64');
  assert(normalizeArch('macos', 'amd64') === 'x64', 'amd64 应映射为 x64');
  assert(normalizeArch('macos', 'Apple') === 'arm64', 'Apple 应映射为 arm64');
  assert(normalizeArch('macos', 'Intel') === 'x64', 'Intel 应映射为 x64');
  assert(normalizeArch('macos', 'Universal') === 'universal', 'Universal 应保留');
  assert(normalizeArch('macos', '64') === 'x64', '64 应映射为 x64');
});

test('无法识别的文件名不产生推荐（不猜测架构）', () => {
  const release = { assets: [{ name: 'mystery-build-final.exe', size: 10 }] };
  const { matched, ignored } = classifyRelease(flclash, release);
  assert(matched.length === 0, '不应匹配未知命名');
  assert(ignored.includes('mystery-build-final.exe'), '应记录为未识别');
});

test('sing-box 只收图形客户端，不把命令行核心当成客户端', () => {
  const singbox = loadSourcesConfig().sources.find((s) => s.id === 'sing-box');
  const release = {
    assets: [
      { name: 'sing-box-1.14.4-darwin-arm64.tar.gz', size: 10 },
      { name: 'sing-box-1.14.4-windows-amd64.zip', size: 10 },
      { name: 'SFW-1.14.4-x64.exe', size: 10 },
      { name: 'SFM-1.14.4-Apple.pkg', size: 10 },
      { name: 'SFA-1.14.4-arm64-v8a.apk', size: 10 },
    ],
  };
  const { matched } = classifyRelease(singbox, release);
  const names = matched.map((m) => m.name);
  assert(!names.some((n) => n.startsWith('sing-box-')), '包含了核心程序压缩包');
  assert(names.length === 3, `应匹配 3 个图形客户端，实际 ${names.length}`);
});

/* ---------------- 3. 状态与版本标注 ---------------- */

const demoSource = {
  id: 'demo',
  name: 'Demo',
  platforms: ['windows', 'macos'],
  mirror: { enabled: true, note: '' },
  license: { label: 'GPL-3.0', redistribution: 'allowed', note: '' },
  rules: [
    { match: '^App-[0-9.]+-setup\\.exe$', platform: 'windows', format: 'exe', variant: 'installer', arch: 'x64' },
    { match: '^App-[0-9.]+-portable\\.zip$', platform: 'windows', format: 'zip', variant: 'portable', arch: 'x64' },
    { match: '^App-[0-9.]+-arm64\\.dmg$', platform: 'macos', format: 'dmg', variant: 'installer', arch: 'arm64' },
  ],
  exclude: [],
};

const demoRelease = (tag) => ({
  tag,
  publishedAt: '2026-01-01T00:00:00Z',
  htmlUrl: `https://github.com/demo/app/releases/tag/${tag}`,
  assets: [
    {
      name: `App-${tag.replace('v', '')}-setup.exe`,
      size: 1000,
      sizeExact: true,
      url: 'https://github.com/demo/app/releases/download/x/setup.exe',
      digest: null,
      updatedAt: null,
    },
    {
      name: `App-${tag.replace('v', '')}-arm64.dmg`,
      size: 2000,
      sizeExact: true,
      url: 'https://github.com/demo/app/releases/download/x/arm64.dmg',
      digest: null,
      updatedAt: null,
    },
  ],
});

const syncedRecord = (tag, filename, role, sha, storageId = storageIdentity()) => ({
  filename,
  role,
  key: `packages/demo/${tag}/${filename}`,
  size: 1000,
  sha256: sha,
  verified: 'github-digest',
  syncedAt: '2026-01-02T00:00:00Z',
  storageId,
  contentType: 'application/vnd.microsoft.portable-executable',
});

function buildWith(versions, releaseTag = 'v2.0.0') {
  const state = {
    sources: {
      demo: {
        release: demoRelease(releaseTag),
        versions,
        lastCheckedAt: '2026-01-02T00:00:00Z',
        lastSyncedAt: '2026-01-02T00:00:00Z',
        dataSource: 'github-rest',
      },
    },
  };
  return buildSiteData({ sources: [demoSource], siteConfig: { name: 'T', tagline: '', faq: [] }, state });
}

test('新版本同步完成后标记为可下载', () => {
  const data = buildWith({
    'v2.0.0': {
      syncedAt: '2026-01-02T00:00:00Z',
      files: {
        'App-2.0.0-setup.exe': syncedRecord('v2.0.0', 'App-2.0.0-setup.exe', 'windows|x64|exe|installer', 'a'.repeat(64)),
      },
    },
  });
  const item = data.items[0];
  const option = item.downloads.windows.options[0];
  assert(option.status === 'ready', `应为 ready，实际 ${option.status}`);
  assert(option.version === 'v2.0.0', '版本应为 v2.0.0');
  assert(option.href.startsWith('/download/'), '应指向本站下载');
  assert(item.syncState === 'partial', `仅同步 1/2 应为 partial，实际 ${item.syncState}`);
});

test('新版未同步完成时保留旧版并准确标注旧版本号', () => {
  const data = buildWith({
    'v1.9.0': {
      syncedAt: '2025-12-01T00:00:00Z',
      files: {
        'App-1.9.0-setup.exe': syncedRecord('v1.9.0', 'App-1.9.0-setup.exe', 'windows|x64|exe|installer', 'b'.repeat(64)),
      },
    },
  });
  const item = data.items[0];
  const option = item.downloads.windows.options[0];
  assert(option.status === 'stale', `应为 stale，实际 ${option.status}`);
  assert(option.version === 'v1.9.0', `下载版本应为 v1.9.0，实际 ${option.version}`);
  assert(option.filename.includes('1.9.0'), '文件名必须是旧版本文件名');
  assert(/v2\.0\.0/.test(option.note), '提示中应说明官方最新版本');
  assert(item.syncState === 'stale', `站点状态应为 stale，实际 ${item.syncState}`);
  return '旧版可下载，且明确标注 v1.9.0';
});

test('完全没有同步记录时不给下载按钮，只给官方入口', () => {
  const data = buildWith({});
  const option = data.items[0].downloads.windows.options[0];
  assert(option.status === 'unavailable', `应为 unavailable，实际 ${option.status}`);
  assert(option.href === null, '不应生成本站下载地址');
  assert(option.officialUrl.includes('github.com'), '应保留官方地址');
});

test('未授权镜像的项目只提供官方入口', () => {
  const blocked = { ...demoSource, mirror: { enabled: false, note: '许可证不允许镜像' } };
  const state = {
    sources: {
      demo: { release: demoRelease('v2.0.0'), versions: {}, lastCheckedAt: '2026-01-02T00:00:00Z' },
    },
  };
  const data = buildSiteData({
    sources: [blocked],
    siteConfig: { name: 'T', tagline: '', faq: [] },
    state,
  });
  const option = data.items[0].downloads.windows.options[0];
  assert(option.status === 'official-only', `应为 official-only，实际 ${option.status}`);
  assert(option.href === null, '不应生成本站下载地址');
  assert(data.items[0].syncState === 'official-only', '项目状态应为 official-only');
});

test('记录来自其他存储时不得标记为可下载（防止状态说已同步、链接却 404）', () => {
  const data = buildWith({
    'v2.0.0': {
      syncedAt: '2026-01-02T00:00:00Z',
      files: {
        'App-2.0.0-setup.exe': syncedRecord(
          'v2.0.0',
          'App-2.0.0-setup.exe',
          'windows|x64|exe|installer',
          'c'.repeat(64),
          's3:other-bucket@https://other.example.com',
        ),
      },
    },
  });
  const option = data.items[0].downloads.windows.options[0];
  assert(option.status === 'unavailable', `跨存储记录应为 unavailable，实际 ${option.status}`);
  assert(option.href === null, '不应生成指向其他存储的下载地址');
});

test('站点数据包含每个项目的检查时间与同步时间（不被整体时间掩盖）', () => {
  const data = buildWith({});
  const item = data.items[0];
  assert(item.checkedAt, '缺少最近检查时间');
  assert('syncedAt' in item, '缺少最近同步时间字段');
  assert(item.syncMessage, '缺少状态说明');
});

/* ---------------- 4. 安全与完整性 ---------------- */

test('下载源白名单拒绝非 GitHub 域名（防 SSRF/任意代理）', () => {
  for (const bad of [
    'https://evil.example.com/file.apk',
    'http://github.com/file.apk',
    'https://github.com.evil.example/file.apk',
  ]) {
    let rejected = false;
    try {
      assertAllowedUrl(bad);
    } catch {
      rejected = true;
    }
    assert(rejected, `应拒绝 ${bad}`);
  }
  assertAllowedUrl('https://release-assets.githubusercontent.com/x/y?token=1');
  return '仅允许 GitHub 官方域名 + https';
});

test('HTML 错误页不会被当成安装包', () => {
  const htmlSample = Buffer.from('<!DOCTYPE html><html><body>404</body></html>').toString('hex');
  const result = checkMagic('apk', htmlSample, MAGIC_SIGNATURES);
  assert(result.ok === false, 'HTML 内容应被拒绝');
  const apkSample = '504b030414000000';
  assert(checkMagic('apk', apkSample, MAGIC_SIGNATURES).ok === true, '正常 APK 应通过');
  const exeSample = '4d5a90000300';
  assert(checkMagic('exe', exeSample, MAGIC_SIGNATURES).ok === true, '正常 EXE 应通过');
  assert(checkMagic('exe', apkSample, MAGIC_SIGNATURES).ok === false, 'APK 头不应被当成 EXE');
});

test('前端与站点数据中不包含任何密钥', () => {
  const files = ['web/index.html', 'web/assets/app.js', 'web/assets/shared.js', 'web/data/site.json'];
  const patterns = [/gh[pousr]_[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/, /ADMIN_TOKEN\s*[:=]\s*\S+/];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const pattern of patterns) {
      assert(!pattern.test(text), `${rel} 疑似泄露密钥（${pattern}）`);
    }
  }
  return '已扫描 4 个对外文件';
});

/* ---------------- 5. 系统识别 ---------------- */

test('系统识别：Android / Windows / macOS / iOS / Linux', () => {
  const android = detectPlatform({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' });
  assert(android.platform === 'android', 'Android 未识别');
  assert(android.arch === null, 'Android 架构不应被猜测');

  const win = detectPlatform({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  assert(win.platform === 'windows', 'Windows 未识别');

  const mac = detectPlatform({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  assert(mac.platform === 'macos', 'macOS 未识别');
  assert(mac.arch === null, 'macOS 架构不应被猜测（需用户选择）');

  const ios = detectPlatform({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
  assert(ios.unsupported === 'ios', 'iOS 应明确标记为不收录');

  const linux = detectPlatform({ ua: 'Mozilla/5.0 (X11; Linux x86_64)' });
  assert(linux.platform === null, 'Linux 应要求手动选择');
});

test('主推荐安装包按架构与变体优先级选择', () => {
  const options = [
    { arch: 'arm64', format: 'exe', variant: 'installer', platform: 'windows' },
    { arch: 'x64', format: 'exe', variant: 'installer', platform: 'windows' },
    { arch: 'x64', format: 'zip', variant: 'portable', platform: 'windows' },
  ];
  assert(pickPrimary(options, { arch: 'x64' }).variant === 'installer', 'x64 应优先安装版');
  assert(pickPrimary(options, { arch: 'arm64' }).arch === 'arm64', '应优先匹配当前架构');
  assert(pickPrimary(options, {}).variant === 'installer', '无架构偏好时仍应优先安装版');
});

/* ---------------- 6. 下载服务（HTTP 集成） ---------------- */

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [path.join(ROOT, 'scripts/server.js'), `--port=${PORT}`, '--host=127.0.0.1'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
  cwd: ROOT,
});

const waitForServer = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 继续等待 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

let readyOk = false;
try {
  readyOk = await waitForServer();
} catch {
  readyOk = false;
}

if (!readyOk) {
  console.log('FAIL  下载服务启动失败');
  results.push({ name: '下载服务启动', ok: false, detail: '无法访问 /api/health' });
} else {
  const site = await fetch(`${BASE}/data/site.json`).then((r) => r.json());
  const ready = [];
  for (const item of site.items) {
    for (const group of Object.values(item.downloads || {})) {
      for (const option of group.options || []) {
        if (option.status === 'ready' && option.href) ready.push({ item, option });
      }
    }
  }

  console.log(`PASS  下载服务已启动，站点含 ${ready.length} 个已同步安装包`);
  results.push({ name: '下载服务启动', ok: true, detail: `${ready.length} 个已同步文件` });

  if (ready.length) {
    const { option } = ready[0];
    const url = option.href.startsWith('http') ? option.href : `${BASE}${option.href}`;

    const head = await fetch(url, { method: 'HEAD' });
    const headers = head.headers;
    const contentOk = /attachment/.test(headers.get('content-disposition') || '');
    const rangesOk = headers.get('accept-ranges') === 'bytes';
    const typeOk = (headers.get('content-type') || '').length > 0;
    const lenOk = Number(headers.get('content-length')) === option.size;
    console.log(
      `${contentOk && rangesOk && typeOk && lenOk ? 'PASS' : 'FAIL'}  HEAD 头部：Content-Type/Disposition/长度`,
    );
    results.push({
      name: 'HEAD 头部正确',
      ok: contentOk && rangesOk && typeOk && lenOk,
      detail: `${headers.get('content-type')} · ${headers.get('content-length')} bytes · ${headers.get('content-disposition')}`,
    });

    const rangeRes = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    const rangeOk =
      rangeRes.status === 206 &&
      rangeBuf.length === 1024 &&
      /^bytes 0-1023\//.test(rangeRes.headers.get('content-range') || '');
    console.log(`${rangeOk ? 'PASS' : 'FAIL'}  Range 请求返回 206 且长度正确`);
    results.push({ name: 'Range 断点续传', ok: rangeOk, detail: `${rangeRes.status} ${rangeRes.headers.get('content-range')}` });

    const fullRes = await fetch(url);
    const fullBuf = Buffer.from(await fullRes.arrayBuffer());
    const sha = crypto.createHash('sha256').update(fullBuf).digest('hex');
    const hashOk = sha === option.sha256;
    const sizeOk = fullBuf.length === option.size;
    const notHtml = !fullBuf.subarray(0, 32).toString('utf8').toLowerCase().includes('<html');
    console.log(`${hashOk && sizeOk && notHtml ? 'PASS' : 'FAIL'}  下载内容完整（大小 + SHA-256 + 非 HTML）`);
    results.push({
      name: '下载内容校验',
      ok: hashOk && sizeOk && notHtml,
      detail: `${fullBuf.length} bytes, sha=${sha.slice(0, 12)}…`,
    });

    const missing = await fetch(`${BASE}/download/packages/nekobox/1.4.2/does-not-exist.apk`);
    const missingJson = await missing.json().catch(() => ({}));
    const missingOk = missing.status === 404 && Boolean(missingJson.error);
    console.log(`${missingOk ? 'PASS' : 'FAIL'}  未同步文件返回 404 而不是伪造下载`);
    results.push({ name: '未同步文件 404', ok: missingOk, detail: missingJson.error || '' });

    const traversal = await fetch(`${BASE}/download/packages/..%2F..%2Fetc%2Fpasswd`);
    const traversalOk = traversal.status === 400 || traversal.status === 404;
    console.log(`${traversalOk ? 'PASS' : 'FAIL'}  路径穿越被拒绝`);
    results.push({ name: '路径穿越防护', ok: traversalOk, detail: `HTTP ${traversal.status}` });
  } else {
    console.log('SKIP  当前没有已同步文件，跳过下载内容校验（先运行 npm run sync）');
  }

  const adminNoToken = await fetch(`${BASE}/api/admin/status`);
  const adminOk = adminNoToken.status === 401 || adminNoToken.status === 503;
  console.log(`${adminOk ? 'PASS' : 'FAIL'}  后台接口未授权时拒绝访问`);
  results.push({ name: '后台接口鉴权', ok: adminOk, detail: `HTTP ${adminNoToken.status}` });
}

child.kill('SIGTERM');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n单元与集成验证：${results.length - failed} 通过 / ${failed} 失败`);
process.exitCode = failed ? 1 : 0;
