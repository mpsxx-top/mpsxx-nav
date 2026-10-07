/* ============================================================
 * 星轨 ORBIT · 内容加载层
 * ------------------------------------------------------------
 * 运行时从 /api/content 取「已发布」内容（后台面板发布的结果）；
 * 接口不可用 / 内容不完整时，回退到内置的 js/data.js 默认值 —— 保证页面永不空白。
 *
 * 预览模式（?preview=1）：改从 /api/admin/draft 取「草稿」，
 * 供 /admin 管理面板的实时预览使用（需已通过 Cloudflare Access 登录）。
 * ============================================================ */

import { SITES as FALLBACK_SITES, STAR as FALLBACK_STAR, RETIRED as FALLBACK_RETIRED } from './data.js';

const PUBLIC_ENDPOINT = '/api/content';
const PREVIEW_ENDPOINT = '/api/admin/draft';
const PUBLIC_TIMEOUT_MS = 1500;
const PREVIEW_TIMEOUT_MS = 8000;

export const previewMode = (() => {
  try { return new URLSearchParams(location.search).get('preview') === '1'; }
  catch { return false; }
})();

/* ---------- 工具 ---------- */

const asString = (v, def = '') => (typeof v === 'string' && v.trim() ? v.trim() : def);
const asNumber = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
const HEX = /^#[0-9a-f]{6}$/i;

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 与 _worker.js 里 mergeStatuses 保持同一套规则：auto 跟随探测，手动值优先 */
function resolveStatus(mode, probes, domain) {
  const normalized = ['auto', 'online', 'offline'].includes(mode) ? mode : 'auto';
  if (normalized !== 'auto') return { status: normalized, probe: null };
  const probe = probes && probes[domain] ? probes[domain] : null;
  return { status: probe ? (probe.ok ? 'online' : 'offline') : 'online', probe };
}

function normalizeSite(raw, index, probes) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id).toLowerCase();
  const domain = asString(raw.domain).toLowerCase();
  const url = asString(raw.url);
  if (!id || !domain || !url) return null;

  const { status } = resolveStatus(raw.status, probes, domain);

  return {
    id,
    no: asString(raw.no, String(index + 1).padStart(2, '0')),
    zh: asString(raw.zh, domain),
    en: asString(raw.en),
    kind: asString(raw.kind),
    domain,
    alt: raw.alt ? asString(raw.alt) : null,
    url,
    desc: asString(raw.desc),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 12) : [],
    status,
    hue: HEX.test(asString(raw.hue)) ? asString(raw.hue) : '#E8C87E',
    size: asNumber(raw.size, 0.42),
    orbit: asNumber(raw.orbit, 10),
    speed: asNumber(raw.speed, 0.1),
    incl: asNumber(raw.incl, 0),
    phase: asNumber(raw.phase, 0),
  };
}

function buildContent(payload, probes) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.sites) || payload.sites.length === 0) return null;

  const sites = payload.sites.map((s, i) => normalizeSite(s, i, probes)).filter(Boolean);
  if (sites.length === 0) return null;

  const star = payload.star && typeof payload.star === 'object' ? payload.star : {};
  const page = payload.page && typeof payload.page === 'object' ? payload.page : {};

  return {
    star: {
      domain: asString(star.domain, 'mpsxx.top'),
      zh: asString(star.zh, '主星'),
      desc: asString(star.desc),
    },
    page: {
      title: asString(page.title),
      description: asString(page.description),
      color: asString(page.color, '#05060A'),
    },
    sites,
    retired: Array.isArray(payload.retired) ? payload.retired.filter((w) => typeof w === 'string' && w.trim()) : [],
    onlineCount: sites.filter((s) => s.status === 'online').length,
  };
}

function fallbackContent(reason) {
  const sites = FALLBACK_SITES.map((s) => ({ ...s, tags: [...(s.tags || [])] }));
  return {
    star: { ...FALLBACK_STAR },
    page: { title: '', description: '', color: '#05060A' },
    sites,
    retired: [...FALLBACK_RETIRED],
    onlineCount: sites.filter((s) => s.status === 'online').length,
    source: 'fallback',
    version: 'fallback',
    reason,
  };
}

/** 页面级文案：标题 / 描述 / 主题色 */
function applyPageMeta(page) {
  if (!page) return;
  if (page.title) document.title = page.title;
  if (page.description) {
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', page.description);
  }
  if (HEX.test(page.color)) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', page.color);
  }
}

/**
 * 加载内容。永远 resolve，绝不抛出：
 * 返回 { star, page, sites, retired, onlineCount, source, version }
 * source: 'api'（线上已发布）| 'draft'（面板预览草稿）| 'fallback'（内置默认值）
 */
export async function loadContent() {
  let content = null;
  let source = 'api';

  try {
    if (previewMode) {
      const data = await fetchJson(PREVIEW_ENDPOINT, PREVIEW_TIMEOUT_MS);
      content = buildContent(data && data.draft, data && data.probes);
      source = 'draft';
    } else {
      const data = await fetchJson(PUBLIC_ENDPOINT, PUBLIC_TIMEOUT_MS);
      content = buildContent(data, null);
      source = 'api';
    }
  } catch (err) {
    console.warn('[orbit] 内容接口不可用，使用内置默认内容：', (err && err.message) || err);
    return fallbackContent((err && err.message) || String(err));
  }

  if (!content) {
    console.warn('[orbit] 内容格式不完整，使用内置默认内容');
    return fallbackContent('内容格式不完整');
  }

  applyPageMeta(content.page);
  return { ...content, source, version: source === 'draft' ? 'preview' : 'live' };
}
