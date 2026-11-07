import {
  detectPlatform,
  pickPrimary,
  archLabel,
  formatLabel,
  variantLabel,
  formatBytes,
  isStale,
  PLATFORM_META,
  ARCH_ORDER,
  FORMAT_HINTS,
} from './shared.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  data: null,
  publicStatus: null,
  platform: 'all',
  arch: '',
  search: '',
  onlyMaintained: false,
  showPrerelease: false,
  detection: null,
  gpuRenderer: null,
};

const STATUS_BADGES = {
  ok: { text: '已同步', cls: 'ok' },
  partial: { text: '部分同步', cls: 'warn' },
  stale: { text: '最新版同步中', cls: 'warn' },
  syncing: { text: '正在同步', cls: 'warn' },
  pending: { text: '待检查', cls: '' },
  failed: { text: '同步失败', cls: 'danger' },
  'official-only': { text: '仅官方下载', cls: '' },
};

const MAINTENANCE_BADGES = {
  active: { text: '维护中', cls: 'ok' },
  slow: { text: '更新较慢', cls: 'warn' },
  archived: { text: '已归档', cls: 'danger' },
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function timeCell(iso) {
  if (!iso) return '<dd>—</dd>';
  return `<dd title="${escapeHtml(fmtDate(iso))}">${escapeHtml(fmtDate(iso))} <span class="muted">（${relTime(iso)}）</span></dd>`;
}

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('SHA-256 已复制');
  } catch {
    window.prompt('手动复制 SHA-256：', text);
  }
}

/* ---------------- 主题 ---------------- */

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  updateThemeIcon();
  $('#theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    updateThemeIcon();
  });
}

function updateThemeIcon() {
  const current = document.documentElement.dataset.theme
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  $('#theme-icon').textContent = current === 'dark' ? '☾' : '☀';
}

/* ---------------- 系统识别 ---------------- */

function gpuRenderer() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  } catch {
    return null;
  }
}

function detect() {
  const uaData = navigator.userAgentData;
  const base = detectPlatform({
    ua: navigator.userAgent,
    uaPlatform: uaData?.platform || navigator.platform,
    hasTouch: navigator.maxTouchPoints > 0,
  });

  if (base.platform === 'macos' && !base.arch) {
    const renderer = gpuRenderer();
    state.gpuRenderer = renderer;
    if (renderer && /apple\s*m\d/i.test(renderer)) {
      return {
        ...base,
        arch: 'arm64',
        confidence: 'low',
        reason: '根据显卡信息推断为 Apple Silicon（启发式，可能不准，可手动切换）',
      };
    }
    if (renderer && /intel|amd|radeon/i.test(renderer)) {
      return {
        ...base,
        arch: 'x64',
        confidence: 'low',
        reason: '根据显卡信息推断为 Intel 处理器（启发式，可能不准，可手动切换）',
      };
    }
  }
  return base;
}

function applyDetection() {
  const detection = detect();
  state.detection = detection;
  state.platform = detection.platform || 'all';
  state.arch = detection.arch || '';

  const hint = $('#detect-hint');
  if (detection.unsupported === 'ios') {
    hint.textContent = '检测到 iOS 设备：本站按要求不收录 iOS 客户端，已显示全部平台。';
  } else if (detection.platform) {
    const archText = detection.arch ? ` · ${archLabel(detection.platform, detection.arch)}` : '';
    hint.textContent = `已自动识别：${PLATFORM_META[detection.platform].label}${archText}（${detection.reason}）`;
  } else {
    hint.textContent = `${detection.reason}（当前显示全部平台）`;
  }
}

/* ---------------- 筛选控件 ---------------- */

function buildArchOptions() {
  const select = $('#arch-select');
  const platform = state.platform;
  select.innerHTML = '';
  if (platform === 'all') {
    select.append(new Option('先选择系统', ''));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.append(new Option('所有架构', ''));
  for (const arch of ARCH_ORDER[platform] || []) {
    select.append(new Option(archLabel(platform, arch), arch));
  }
  if (state.arch && [...select.options].some((o) => o.value === state.arch)) {
    select.value = state.arch;
  } else {
    state.arch = '';
    select.value = '';
  }
}

function initControls() {
  document.querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.platform = btn.dataset.platform;
      state.arch = '';
      syncTabs();
      buildArchOptions();
      render();
    });
  });

  $('#arch-select').addEventListener('change', (event) => {
    state.arch = event.target.value;
    render();
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = event.target.value.trim().toLowerCase();
      render();
    }, 120);
  });

  $('#only-maintained').addEventListener('change', (event) => {
    state.onlyMaintained = event.target.checked;
    render();
  });

  $('#show-prerelease').addEventListener('change', (event) => {
    state.showPrerelease = event.target.checked;
    render();
  });

  $('#reset-filters').addEventListener('click', () => {
    state.search = '';
    state.onlyMaintained = false;
    state.arch = '';
    state.platform = state.detection?.platform || 'all';
    $('#search').value = '';
    $('#only-maintained').checked = false;
    syncTabs();
    buildArchOptions();
    render();
  });

  $('#retry').addEventListener('click', () => loadData());
}

function syncTabs() {
  document.querySelectorAll('.seg').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.platform === state.platform));
  });
}

/* ---------------- URL 状态（便于分享与自动化验证） ---------------- */

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const out = {};
  const platform = params.get('platform');
  if (platform && ['windows', 'macos', 'android', 'all'].includes(platform)) out.platform = platform;
  if (params.has('arch')) out.arch = params.get('arch') || '';
  if (params.has('q')) out.search = (params.get('q') || '').toLowerCase();
  if (params.get('maintained') === '1') out.onlyMaintained = true;
  if (params.get('prerelease') === '1') out.showPrerelease = true;
  return out;
}

function applyUrlState(urlState) {
  if (urlState.platform) state.platform = urlState.platform;
  if (urlState.arch !== undefined) state.arch = urlState.arch;
  if (urlState.search !== undefined) {
    state.search = urlState.search;
    $('#search').value = urlState.search;
  }
  if (urlState.onlyMaintained) {
    state.onlyMaintained = true;
    $('#only-maintained').checked = true;
  }
  if (urlState.showPrerelease) {
    state.showPrerelease = true;
    $('#show-prerelease').checked = true;
  }
}

function syncUrlState() {
  const params = new URLSearchParams();
  if (state.platform !== 'all') params.set('platform', state.platform);
  if (state.arch) params.set('arch', state.arch);
  if (state.search) params.set('q', state.search);
  if (state.onlyMaintained) params.set('maintained', '1');
  if (state.showPrerelease) params.set('prerelease', '1');
  const query = params.toString();
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
}

/* ---------------- 渲染 ---------------- */

function renderSiteMeta() {
  const { site, generatedAt, totals, warnings, dataSource } = state.data;
  document.title = `${site.name} · Windows / macOS / Android`;
  $('#site-name').textContent = site.name;
  $('#site-tagline').textContent = site.tagline;

  $('#site-updated').textContent = fmtDate(generatedAt);
  $('#site-updated-note').textContent = `${relTime(generatedAt)} · 各项目更新时间见卡片`;
  $('#site-total').textContent = String(totals.items);
  $('#site-total-note').textContent = `其中 ${totals.mirrored} 个项目允许本站镜像`;
  $('#site-ready').textContent = String(totals.withDownloads);
  $('#site-ready-note').textContent = '至少有一个已校验安装包';
  $('#site-interval').textContent = `约 ${site.checkIntervalMinutes} 分钟`;

  const banner = $('#global-banner');
  const messages = [];
  let level = 'info';

  if (isStale(generatedAt, site.staleAfterMinutes)) {
    messages.push(
      `站点数据已超过 ${site.staleAfterMinutes} 分钟未刷新（最后更新 ${fmtDate(generatedAt)}），定时任务可能失败，此时以官方发布页为准。`,
    );
    level = 'warn';
  }
  if (dataSource === 'html-fallback' || dataSource === 'mixed') {
    messages.push(
      '部分项目的元数据来自 github.com 网页回退（GitHub API 限流时触发），安装包大小为近似值；下载时仍会按实际字节校验。',
    );
  }
  if (state.publicStatus?.scheduler?.running) {
    messages.push('定时更新任务正在运行，数据可能稍后变化。');
  }
  if (state.publicStatus?.nextRunAt) {
    messages.push(`下次计划检查：${fmtDate(state.publicStatus.nextRunAt)}`);
  }
  for (const warning of warnings || []) messages.push(warning);

  if (messages.length) {
    banner.hidden = false;
    banner.className = `banner ${level}`;
    banner.innerHTML = messages.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
  } else {
    banner.hidden = true;
  }

  const footer = $('#footer-meta');
  footer.textContent = `收录 ${totals.items} 个项目 · 站点数据生成于 ${fmtDate(generatedAt)} · 数据来源：${dataSource === 'github-rest' ? 'GitHub REST API' : dataSource === 'html-fallback' ? 'GitHub 网页回退' : dataSource === 'mixed' ? 'REST API + 网页回退' : '暂无'} · 下载模式：${site.downloadMode}`;
}

function renderFaq() {
  const faq = state.data.site.faq || [];
  const holder = $('#faq-body');
  holder.innerHTML = faq
    .map(
      (entry) => `<details><summary>${escapeHtml(entry.q)}</summary><p>${escapeHtml(entry.a)}</p></details>`,
    )
    .join('');
}

function matchesFilters(item) {
  if (state.onlyMaintained && item.status !== 'active') return false;
  if (state.platform !== 'all' && !item.platforms.includes(state.platform)) return false;
  if (state.search) {
    const haystack = [item.name, item.nameZh, item.repo, item.summary].join(' ').toLowerCase();
    if (!haystack.includes(state.search)) return false;
  }
  return true;
}

function primaryFor(item, platform) {
  const group = item.downloads?.[platform];
  if (!group || !group.options?.length) return null;
  return pickPrimary(group.options, { arch: state.arch || null });
}

function readyVersions(item) {
  const versions = new Set();
  for (const group of Object.values(item.downloads || {})) {
    for (const option of group.options || []) {
      if (option.status === 'ready') versions.add(option.version);
      if (option.status === 'stale') versions.add(`${option.version}（旧）`);
    }
  }
  return [...versions];
}

function badge(text, cls = '') {
  return `<span class="chip ${cls}">${escapeHtml(text)}</span>`;
}

function renderDownloadButtons(item, platform, option) {
  const officialLink = option.officialUrl
    ? `<a class="secondary-btn" href="${escapeHtml(option.officialUrl)}" target="_blank" rel="noopener noreferrer" title="GitHub 官方资产直链，国内访问可能不稳定">官方下载<span class="muted">（GitHub）</span></a>`
    : '';

  if (option.status === 'ready') {
    return `
      <a class="primary-btn" href="${escapeHtml(option.href)}" download="${escapeHtml(option.filename)}">
        下载安装包
        <span class="muted" style="color:rgba(255,255,255,.82)">${escapeHtml(option.version)}</span>
      </a>
      ${officialLink}`;
  }

  if (option.status === 'stale') {
    return `
      <a class="primary-btn" href="${escapeHtml(option.href)}" download="${escapeHtml(option.filename)}">
        下载安装包 ${escapeHtml(option.version)}
      </a>
      ${officialLink}`;
  }

  if (option.status === 'official-only') {
    return `${option.officialUrl ? `<a class="primary-btn" href="${escapeHtml(option.officialUrl)}" target="_blank" rel="noopener noreferrer">官方下载（GitHub）</a>` : ''}
      <button type="button" class="secondary-btn" disabled>本站不提供镜像</button>`;
  }

  return `${option.officialUrl ? `<a class="primary-btn" href="${escapeHtml(option.officialUrl)}" target="_blank" rel="noopener noreferrer">官方下载（GitHub）</a>` : ''}
    <button type="button" class="secondary-btn" disabled>本站下载暂不可用</button>`;
}

function renderPlatformBlock(item, platform) {
  const group = item.downloads?.[platform];
  if (!group || !group.options.length) {
    return `
      <div class="platform-block">
        <div class="platform-head">
          <span class="platform-name">${escapeHtml(PLATFORM_META[platform].label)}</span>
          ${badge('暂无匹配安装包', '')}
        </div>
        <p class="dl-meta">该项目的这个系统没有可自动识别的安装包格式，请直接查看官方发布页。</p>
      </div>`;
  }

  const option = primaryFor(item, platform) || group.options[0];
  const status = STATUS_BADGES[item.syncState] || STATUS_BADGES.pending;
  const archText = state.arch && state.arch === option.arch ? '' : '';

  const metaParts = [
    archLabel(platform, option.arch),
    option.formatLabel,
    option.variantLabel,
    formatBytes(option.size),
  ].filter(Boolean);

  const noteText =
    option.status === 'stale'
      ? option.note
      : option.status === 'unavailable'
        ? '本站安装包正在同步，尚未完成校验；请先使用官方下载。'
        : option.status === 'official-only'
          ? item.mirrorNote || '按许可证/发布条款，本站不提供该项目的镜像下载。'
          : '';

  const noteClass = option.status === 'unavailable' ? 'danger' : option.status === 'stale' ? '' : 'info';

  const shaRow =
    option.sha256 && option.status !== 'official-only'
      ? `<div class="sha-row">
           <span>SHA-256</span>
           <code title="${escapeHtml(option.sha256)}">${escapeHtml(option.sha256)}</code>
           <button type="button" class="secondary-btn" data-sha="${escapeHtml(option.sha256)}" style="padding:3px 8px;font-size:11.5px">复制</button>
           <span class="muted">${escapeHtml(option.verifiedLabel || '')}</span>
         </div>`
      : '';

  const others = group.options.filter((o) => o !== option);
  const othersList = others.length
    ? `<details class="options">
         <summary>其他可选文件（${others.length}）</summary>
         <div class="options-list">
           ${others
             .map(
               (other) => `
             <div class="option-row">
               <div class="opt-label">
                 <span>${escapeHtml(archLabel(platform, other.arch))} · ${escapeHtml(other.formatLabel)}${other.variantLabel ? ` · ${escapeHtml(other.variantLabel)}` : ''} · ${formatBytes(other.size)}</span>
                 <span class="opt-name">${escapeHtml(other.filename)}</span>
               </div>
               <div class="dl-primary">
                 ${
                   other.href
                     ? `<a class="secondary-btn" href="${escapeHtml(other.href)}" download="${escapeHtml(other.filename)}">下载 ${escapeHtml(other.version)}</a>`
                     : '<span class="chip">本站暂不可用</span>'
                 }
                 ${other.officialUrl ? `<a class="secondary-btn" href="${escapeHtml(other.officialUrl)}" target="_blank" rel="noopener noreferrer">官方</a>` : ''}
               </div>
             </div>`,
             )
             .join('')}
         </div>
       </details>`
    : '';

  const formatHint = FORMAT_HINTS[option.format] ? `<span class="muted">· ${escapeHtml(FORMAT_HINTS[option.format])}</span>` : '';

  return `
    <div class="platform-block">
      <div class="platform-head">
        <span class="platform-name">${escapeHtml(PLATFORM_META[platform].label)}</span>
        ${badge(status.text, status.cls)}
      </div>
      <div class="dl-primary">${renderDownloadButtons(item, platform, option)}</div>
      <div class="dl-meta">
        ${metaParts.map((p) => `<span>${escapeHtml(p)}</span>`).join('<span>·</span>')}
        ${formatHint}
      </div>
      ${state.arch && option.arch !== state.arch ? `<p class="dl-note">当前筛选的架构为「${escapeHtml(archLabel(platform, state.arch))}」，该项目没有对应安装包，以上为最接近的选项。</p>` : ''}
      ${noteText ? `<p class="dl-note ${noteClass}">${escapeHtml(noteText)}</p>` : ''}
      ${shaRow}
      ${othersList}
    </div>`;
}

function renderCard(item) {
  const maintenance = MAINTENANCE_BADGES[item.status] || MAINTENANCE_BADGES.active;
  const platforms =
    state.platform === 'all' ? item.platforms : item.platforms.filter((p) => p === state.platform);
  const versions = readyVersions(item);

  const prereleaseBlock =
    state.showPrerelease && item.prereleases?.length
      ? `<details class="options">
           <summary>预发布版本（${item.prereleases.length}）· 仅提供官方入口，未做镜像</summary>
           <ul class="prerelease-list">
             ${item.prereleases
               .map(
                 (p) =>
                   `<li><a href="${escapeHtml(p.htmlUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.tag)}</a> · ${fmtDate(p.publishedAt)}${p.heuristic ? ' · 版本号由网页回退识别' : ''}</li>`,
               )
               .join('')}
           </ul>
         </details>`
      : '';

  const caveats = item.caveats?.length
    ? `<details class="options">
         <summary>使用说明与注意事项</summary>
         <ul class="prerelease-list">
           ${item.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
         </ul>
         <ul class="prerelease-list">
           <li>许可证：${escapeHtml(item.license?.label || '未知')}${item.license?.note ? ` · ${escapeHtml(item.license.note)}` : ''}</li>
         </ul>
       </details>`
    : `<p class="dl-meta" style="margin:0">许可证：${escapeHtml(item.license?.label || '未知')}</p>`;

  return `
    <article class="card" aria-labelledby="card-${item.id}">
      <div class="card-head">
        <div class="avatar" aria-hidden="true">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</div>
        <div class="card-title">
          <h3 id="card-${item.id}">
            <a href="${escapeHtml(item.repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name)}</a>
          </h3>
          <div class="sub">${escapeHtml(item.nameZh !== item.name ? item.nameZh : item.kindLabel)} · ${escapeHtml(item.repo)}</div>
        </div>
        <div class="chips" style="justify-content:flex-end">
          ${badge(maintenance.text, maintenance.cls)}
        </div>
      </div>

      <p class="card-desc">${escapeHtml(item.summary)}</p>

      <div class="chips">
        ${item.platforms.map((p) => badge(PLATFORM_META[p].label, 'accent')).join('')}
        ${item.dataSourceNote ? badge('元数据来自网页回退', 'warn') : ''}
        ${item.mirrorEnabled ? badge('本站镜像', 'ok') : badge('仅官方入口', '')}
      </div>

      <dl class="meta-grid">
        <div><dt>最新官方版本</dt>${item.latest ? `<dd>${escapeHtml(item.latest.tag)}</dd>` : '<dd>未知</dd>'}</div>
        <div><dt>官方发布时间</dt>${timeCell(item.latest?.publishedAt)}</div>
        <div><dt>本站可下载版本</dt><dd>${versions.length ? escapeHtml(versions.join('、')) : '暂无可下载文件'}</dd></div>
        <div><dt>最近检查</dt>${timeCell(item.checkedAt)}</div>
        <div><dt>最近同步</dt>${timeCell(item.syncedAt)}</div>
        <div><dt>同步状态</dt><dd>${escapeHtml(item.syncMessage)}</dd></div>
      </dl>

      ${item.checkError ? `<p class="dl-note danger">采集错误：${escapeHtml(item.checkError)}</p>` : ''}
      ${item.statusNote ? `<p class="dl-note info">${escapeHtml(item.statusNote)}</p>` : ''}

      ${platforms.map((p) => renderPlatformBlock(item, p)).join('')}
      ${prereleaseBlock}
      ${caveats}

      <div class="card-actions">
        <a class="secondary-btn" href="${escapeHtml(item.repoUrl)}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a>
        ${item.latest?.htmlUrl ? `<a class="secondary-btn" href="${escapeHtml(item.latest.htmlUrl)}" target="_blank" rel="noopener noreferrer">发布说明</a>` : ''}
        ${item.homepage && item.homepage !== item.repoUrl ? `<a class="secondary-btn" href="${escapeHtml(item.homepage)}" target="_blank" rel="noopener noreferrer">项目主页</a>` : ''}
      </div>
    </article>`;
}

function render() {
  if (!state.data) return;
  const items = state.data.items.filter(matchesFilters);
  const cards = $('#cards');
  cards.innerHTML = items.map(renderCard).join('');

  $('#empty').hidden = items.length !== 0;
  const platformLabel = state.platform === 'all' ? '全部平台' : PLATFORM_META[state.platform].label;
  const archSuffix = state.arch ? ` · ${archLabel(state.platform, state.arch)}` : '';
  $('#filter-summary').textContent = `当前筛选：${platformLabel}${archSuffix} · 共 ${items.length} 个客户端`;
  syncUrlState();

  cards.querySelectorAll('[data-sha]').forEach((btn) => {
    btn.addEventListener('click', () => copyText(btn.dataset.sha));
  });
}

/* ---------------- 加载 ---------------- */

async function loadPublicStatus() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (res.ok) state.publicStatus = await res.json();
  } catch {
    state.publicStatus = null;
  }
}

async function loadData() {
  const loadingEl = $('#loading');
  if (loadingEl) loadingEl.hidden = false;
  $('#error-panel').hidden = true;
  try {
    const res = await fetch('./data/site.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    renderSiteMeta();
    renderFaq();
    render();
    $('#loading')?.remove();
  } catch (error) {
    $('#loading')?.remove();
    $('#error-panel').hidden = false;
    $('#error-message').textContent =
      `无法读取站点数据（${error.message}）。请确认已运行采集任务生成本地数据，或检查网络与部署。`;
  }
}

async function main() {
  initTheme();
  applyDetection();
  const urlState = readUrlState();
  if (Object.keys(urlState).length) applyUrlState(urlState);
  syncTabs();
  buildArchOptions();
  initControls();
  await Promise.all([loadPublicStatus(), loadData()]);
  if (state.data) render();
}

main();
