/**
 * 通过 Chrome DevTools Protocol 驱动真实浏览器做交互与布局断言。
 * 用法：node tests/browser-check.mjs [baseUrl]
 * 需要本机安装 Chrome；找不到时自动跳过并标记 SKIP。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  return CHROME_CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

async function waitFor(fn, timeoutMs = 15000, interval = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

async function openBrowser(port) {
  const chrome = findChrome();
  if (!chrome) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-site-chrome-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const ready = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return res.ok;
    } catch {
      return false;
    }
  });
  if (!ready) {
    proc.kill();
    return null;
  }

  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || '页面脚本异常');
    return result.value;
  };

  return {
    send,
    evaluate,
    close() {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      proc.kill('SIGKILL');
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

async function goto(browser, url, width = 1280, height = 900) {
  await browser.send('Page.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await browser.send('Page.navigate', { url });
  const ok = await waitFor(
    () =>
      browser
        .evaluate(`document.readyState === 'complete' && !!document.querySelector('#cards') && document.querySelectorAll('.card').length >= 0 && !!document.querySelector('#filter-summary').textContent`)
        .catch(() => false),
    15000,
  );
  await sleep(300);
  return ok;
}

const DEBUG_PORT = 9300 + Math.floor(Math.random() * 400);
const browser = await openBrowser(DEBUG_PORT);
if (!browser) {
  console.log('SKIP  未找到 Chrome/Chromium，跳过浏览器交互检查');
  process.exit(0);
}

try {
  // 1) 首页按系统自动识别 + 卡片渲染
  await goto(browser, `${BASE}/`);
  const initial = await browser.evaluate(`(() => ({
    cards: document.querySelectorAll('.card').length,
    summary: document.querySelector('#filter-summary').textContent.trim(),
    platform: [...document.querySelectorAll('.seg')].find(b => b.getAttribute('aria-selected') === 'true')?.dataset.platform,
    hint: document.querySelector('#detect-hint').textContent.trim(),
  }))()`);
  record('首页渲染出卡片', initial.cards > 0, `${initial.cards} 张卡片，${initial.summary}`);
  record('系统自动识别已生效或已提示手动选择', Boolean(initial.platform) && Boolean(initial.hint), initial.hint.slice(0, 60));

  // 2) 点击 Android 标签后筛选生效
  const android = await browser.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('.seg')].find(b => b.dataset.platform === 'android');
    btn.click();
    await new Promise(r => setTimeout(r, 120));
    return {
      summary: document.querySelector('#filter-summary').textContent.trim(),
      cards: [...document.querySelectorAll('.card')].length,
      platformsOk: [...document.querySelectorAll('.card')].every(card =>
        [...card.querySelectorAll('.chip')].some(chip => ['Windows', 'macOS', 'Android'].includes(chip.textContent.trim()) && chip.textContent.includes('Android'))),
      archDisabled: document.querySelector('#arch-select').disabled,
      archOptions: [...document.querySelector('#arch-select').options].map(o => o.value),
      url: location.search,
    };
  })()`);
  record('点击 Android 后只剩 Android 项目', android.cards > 0 && android.platformsOk, android.summary);
  record('架构下拉已按 Android 架构重建', android.archDisabled === false && android.archOptions.includes('arm64-v8a'), android.archOptions.join(','));
  record('筛选状态同步到 URL', android.url.includes('platform=android'), android.url);

  // 3) 选择 arm64-v8a 后，已同步项目的下载链接应指向本站且架构正确
  const archCheck = await browser.evaluate(`(async () => {
    const sel = document.querySelector('#arch-select');
    sel.value = 'arm64-v8a';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 150));
    const cards = [...document.querySelectorAll('.card')];
    const rows = cards.map(card => {
      const name = card.querySelector('h3 a')?.textContent.trim();
      const primary = card.querySelector('.dl-primary .primary-btn');
      const href = primary?.getAttribute('href') || '';
      return { name, href, isSite: href.startsWith('/download/') };
    });
    return { rows, summary: document.querySelector('#filter-summary').textContent.trim() };
  })()`);
  const siteRows = archCheck.rows.filter((r) => r.isSite);
  record('存在本站下载链接', siteRows.length > 0, siteRows.map((r) => r.name).join(','));
  record(
    '主下载按钮不指向 GitHub 网页',
    archCheck.rows.every((r) => !/^https:\/\/github\.com\//.test(r.href) || !r.href.includes('/releases/tag/')),
    archCheck.rows.map((r) => r.href.slice(0, 30)).join(' | ').slice(0, 120),
  );
  const archMatch = await browser.evaluate(`(() => {
    const blocks = [...document.querySelectorAll('.platform-block')];
    return blocks.map(b => b.querySelector('.dl-meta')?.textContent.trim()).filter(Boolean);
  })()`);
  record(
    '架构筛选展示对应架构',
    archMatch.some((t) => t.includes('arm64-v8a')),
    archMatch.slice(0, 3).join(' / '),
  );

  // 4) 搜索
  const search = await browser.evaluate(`(async () => {
    const input = document.querySelector('#search');
    input.value = 'FlClash';
    input.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 260));
    return {
      cards: document.querySelectorAll('.card').length,
      names: [...document.querySelectorAll('.card h3 a')].map(a => a.textContent.trim()),
    };
  })()`);
  record('按名称搜索生效', search.cards === 1 && search.names[0] === 'FlClash', search.names.join(','));

  // 5) 清空搜索 + 浅色主题切换
  const theme = await browser.evaluate(`(async () => {
    const input = document.querySelector('#search');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    document.querySelector('#theme-toggle').click();
    await new Promise(r => setTimeout(r, 100));
    const after = getComputedStyle(document.body).backgroundColor;
    document.querySelector('#theme-toggle').click();
    await new Promise(r => setTimeout(r, 100));
    const back = getComputedStyle(document.body).backgroundColor;
    return { after, back, theme: document.documentElement.dataset.theme };
  })()`);
  record('深浅色主题可切换', theme.after !== theme.back, `${theme.after} → ${theme.back}`);

  // 6) 复制的 SHA 行存在
  const sha = await browser.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.sha-row code')];
    return { count: rows.length, sample: rows[0]?.textContent.trim() || '' };
  })()`);
  record('可查看 SHA-256', sha.count > 0 && /^[0-9a-f]{64}$/.test(sha.sample), `${sha.count} 条`);

  // 6.5) 设计指标：字号层级、栅格、渐变、对比度、圆角
  const design = await browser.evaluate(`(() => {
    const lum = (c) => {
      const parts = c.match(/[0-9.]+/g).slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
    };
    const ratio = (a, b) => {
      const l1 = lum(a); const l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const card = document.querySelector('.card');
    const cardStyle = getComputedStyle(card);
    const desc = getComputedStyle(document.querySelector('.card-desc'));
    const btn = document.querySelector('.primary-btn');
    return {
      h1: parseFloat(getComputedStyle(document.querySelector('.hero h1')).fontSize),
      grid: getComputedStyle(document.querySelector('#cards')).gridTemplateColumns.split(' ').length,
      gradient: btn ? getComputedStyle(btn).backgroundImage.includes('linear-gradient') : false,
      contrast: Number(ratio(desc.color, cardStyle.backgroundColor).toFixed(2)),
      radius: parseFloat(cardStyle.borderRadius),
      osCards: document.querySelectorAll('.os-card').length,
    };
  })()`);
  record('标题达到大标题层级（≥30px）', design.h1 >= 30, `${design.h1}px`);
  record('桌面端卡片为多列栅格', design.grid >= 3, `${design.grid} 列`);
  record('主下载按钮使用品牌渐变', design.gradient === true);
  record('卡片正文对比度 ≥ 4.5:1（WCAG AA）', design.contrast >= 4.5, `${design.contrast}:1`);
  record('卡片圆角 ≥ 16px', design.radius >= 16, `${design.radius}px`);
  record('系统选择卡片已渲染', design.osCards === 3, `${design.osCards} 个`);

  // 6.8) 回归：任意 URL 形态都能加载数据（曾因相对路径解析失败而报“无法加载站点数据”）
  const urlShapes = [];
  for (const suffix of ['/index.html', '/foo', '/foo/']) {
    await goto(browser, `${BASE}${suffix}`);
    const probe = await browser.evaluate(`(() => ({
      error: !document.querySelector('#error-panel').hidden,
      cards: document.querySelectorAll('.card').length,
      url: location.pathname,
    }))()`);
    urlShapes.push({ suffix, ...probe });
  }
  record(
    '不同 URL 形态均能加载数据',
    urlShapes.every((r) => !r.error && r.cards > 0),
    urlShapes.map((r) => `${r.suffix}→${r.cards}卡`).join(' '),
  );
  record(
    '未知路径会被归一到根路径',
    urlShapes.filter((r) => r.suffix.startsWith('/foo')).every((r) => r.url === '/'),
    urlShapes.map((r) => r.url).join(','),
  );

  // 6.9) 纯静态托管（无本站文件服务）时不得报错，且必须提示下载服务未部署
  const staticPort = 8811 + Math.floor(Math.random() * 60);
  const staticProc = spawn(process.execPath, ['scripts/preview-static.js', `--port=${staticPort}`], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 900));
    await goto(browser, `http://127.0.0.1:${staticPort}/`);
    const staticHost = await browser.evaluate(`(() => ({
      error: !document.querySelector('#error-panel').hidden,
      cards: document.querySelectorAll('.card').length,
      warnings: [...document.querySelectorAll('.dl-note.info')].filter((n) => n.textContent.includes('纯静态部署')).length,
    }))()`);
    record('纯静态托管也能渲染页面', !staticHost.error && staticHost.cards > 0, `${staticHost.cards} 张卡片`);
    record(
      '静态托管时提示下载服务未部署',
      staticHost.warnings > 0,
      `${staticHost.warnings} 处提示`,
    );
  } finally {
    staticProc.kill('SIGKILL');
  }

  // 7) 手机宽度无横向溢出
  await goto(browser, `${BASE}/?platform=android`, 390, 900);
  const mobile = await browser.evaluate(`(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    cards: document.querySelectorAll('.card').length,
    tap: [...document.querySelectorAll('.primary-btn')].filter(b => b.offsetParent !== null).every(b => b.getBoundingClientRect().height >= 36),
  }))()`);
  record('手机宽度无横向溢出', mobile.overflow <= 1, `溢出 ${mobile.overflow}px`);
  record('手机布局正常渲染卡片', mobile.cards > 0, `${mobile.cards} 张卡片`);
  record('移动端按钮点击高度充足', mobile.tap === true);

  // 8) 键盘可聚焦：Tab 顺序能到达下载按钮
  const focusable = await browser.evaluate(`(() => {
    const els = [...document.querySelectorAll('a[href], button, input, select')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    return els.some(el => el.classList.contains('primary-btn') || el.classList.contains('secondary-btn'));
  })()`);
  record('下载与入口按钮可被键盘聚焦', focusable === true);

  // 9) 未同步项目必须给出明确不可用提示，不得假装可下载
  const unavailable = await browser.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    const target = cards.find(c => c.textContent.includes('本站下载暂不可用') || c.textContent.includes('本站不提供镜像'));
    return { found: Boolean(target), text: target ? target.querySelector('.dl-note')?.textContent.trim().slice(0, 60) : '' };
  })()`);
  record('未同步/未授权项目有明确提示', unavailable.found, unavailable.text || '（当前筛选下无此类项目）');

} catch (error) {
  console.error('浏览器检查异常：', error);
  results.push({ name: '浏览器检查执行', ok: false, detail: String(error?.message || error) });
} finally {
  browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n浏览器检查：${results.length - failed} 通过 / ${failed} 失败`);
process.exitCode = failed ? 1 : 0;
