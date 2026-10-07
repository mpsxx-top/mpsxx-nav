/**
 * 星轨 ORBIT · mpsxx.top —— Cloudflare Pages「高级模式」Worker
 * ============================================================
 * 路由：
 *   GET  /api/content          公开：返回「已发布」内容（前端运行时取数，只读）
 *   /api/admin/*               管理接口：Cloudflare Access 保护 + 本文件内再做 JWT 校验
 *   其它                        交给静态资源（env.ASSETS）
 *
 * 环境变量 / 绑定（Pages 项目 → Settings → Variables and Secrets）：
 *   DB                  D1 绑定，必须
 *   ACCESS_TEAM_DOMAIN  例如 yourteam.cloudflareaccess.com（不配置则管理接口拒绝服务）
 *   ACCESS_AUD          Access 应用的 Audience Tag
 *   ADMIN_EMAILS        可选，逗号分隔的邮箱白名单
 *   DEV_BYPASS          'true' 时跳过鉴权，仅限本地 wrangler pages dev
 *
 * 安全约定：
 *   * 管理接口一律 fail-closed：Access 未配置好就返回 503，而不是放行
 *   * 公开接口只读「已发布」内容，不暴露草稿 / 历史 / 探测明细
 * ============================================================
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const NO_STORE = { 'cache-control': 'no-store, must-revalidate', 'x-robots-tag': 'noindex' };

const PROBE_COOLDOWN_MS = 5 * 60 * 1000;   // 在线探测冷却：5 分钟
const PROBE_TIMEOUT_MS = 6000;

const LIMITS = {
  bodyBytes: 256 * 1024,
  sites: 60,
  retired: 60,
  tagsPerSite: 12,
  tagLen: 24,
  textLen: 2000,
  shortLen: 160,
  urlLen: 300,
  descLen: 600,
};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...NO_STORE, ...headers } });

const fail = (message, status = 400, extra = {}) => json({ error: message, ...extra }, status);

/** 参数 / 内容不合法：由入口统一映射成 400 */
const badInput = (message) => Object.assign(new Error(message), { status: 400 });

function b64urlToBytes(input) {
  const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToString = (input) => new TextDecoder().decode(b64urlToBytes(input));

const isStr = (v) => typeof v === 'string';

function cleanText(value, max, { required = false, field = 'field' } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${field} 不能为空`);
    return '';
  }
  if (!isStr(value)) value = String(value);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${field} 不能为空`);
  if (trimmed.length > max) throw new Error(`${field} 过长（上限 ${max} 字）`);
  return trimmed;
}

function cleanNumber(value, { min = -1e6, max = 1e6, def = 0, field = 'field' } = {}) {
  if (value === null || value === undefined || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 必须是数字`);
  if (n < min || n > max) throw new Error(`${field} 应在 ${min} ~ ${max} 之间`);
  return Math.round(n * 10000) / 10000;
}

function cleanUrl(value, field) {
  const raw = cleanText(value, LIMITS.urlLen, { required: true, field });
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${field} 不是合法网址`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${field} 只支持 http/https`);
  return url.toString().replace(/\/$/, '');
}

function cleanDomain(value, field) {
  const raw = cleanText(value, LIMITS.shortLen, { required: true, field }).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) throw new Error(`${field} 不是合法域名`);
  return raw.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * 文档规范化 / 校验
 * ------------------------------------------------------------------ */

/** 校验/规范化：任何失败都按 400 抛给调用方 */
function normalizeDoc(input) {
  try {
    return normalizeDocInner(input);
  } catch (err) {
    if (!err.status) err.status = 400;
    throw err;
  }
}

function normalizeDocInner(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('内容格式不对');

  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (input.star !== undefined && !isPlainObject(input.star)) throw new Error('star 必须是对象');
  if (input.page !== undefined && !isPlainObject(input.page)) throw new Error('page 必须是对象');
  if (!Array.isArray(input.sites)) throw new Error('sites 必须是数组');
  if (input.retired !== undefined && !Array.isArray(input.retired)) throw new Error('retired 必须是数组');

  const starIn = input.star || {};
  const pageIn = input.page || {};

  const star = {
    domain: cleanDomain(starIn.domain || 'mpsxx.top', 'star.domain'),
    zh: cleanText(starIn.zh || '主星', LIMITS.shortLen, { field: 'star.zh' }),
    desc: cleanText(starIn.desc, LIMITS.descLen, { field: 'star.desc' }),
  };

  const page = {
    title: cleanText(pageIn.title || '', LIMITS.shortLen, { field: 'page.title' }),
    description: cleanText(pageIn.description || '', LIMITS.shortLen, { field: 'page.description' }),
    color: cleanText(pageIn.color || '#05060A', 32, { field: 'page.color' }),
  };

  const sitesIn = input.sites;
  if (sitesIn.length === 0) throw new Error('至少要保留一颗行星');
  if (sitesIn.length > LIMITS.sites) throw new Error(`行星数量上限 ${LIMITS.sites}`);

  const seen = new Set();
  const sites = sitesIn.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 个行星数据不对`);
    const id = cleanText(raw.id, 48, { required: true, field: `第 ${index + 1} 个行星的 id` }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`行星 id「${id}」只能用小写字母、数字、- 和 _`);
    if (seen.has(id)) throw new Error(`行星 id「${id}」重复`);
    seen.add(id);

    const tagsIn = Array.isArray(raw.tags) ? raw.tags : [];
    if (tagsIn.length > LIMITS.tagsPerSite) throw new Error(`「${id}」的标签最多 ${LIMITS.tagsPerSite} 个`);
    const tags = tagsIn
      .map((t) => cleanText(t, LIMITS.tagLen, { field: `${id} 的标签` }))
      .filter((t) => t.length > 0);

    const rawStatus = isStr(raw.status) ? raw.status : 'auto';
    const status = ['auto', 'online', 'offline'].includes(rawStatus) ? rawStatus : 'auto';

    const hueRaw = cleanText(raw.hue || '', 32, { field: `${id} 的颜色` });
    if (hueRaw && !/^#[0-9a-f]{6}$/i.test(hueRaw)) throw new Error(`「${id}」的颜色要写 #RRGGBB 形式`);

    const orbit = cleanNumber(raw.orbit, { min: 1, max: 200, def: 12, field: `${id} 的轨道半径` });
    const speed = cleanNumber(raw.speed, { min: 0, max: 2, def: 0.1, field: `${id} 的公转速度` });

    return {
      id,
      no: String(index + 1).padStart(2, '0'),
      sortIndex: index,
      zh: cleanText(raw.zh, LIMITS.shortLen, { required: true, field: `第 ${index + 1} 个行星的名称` }),
      en: cleanText(raw.en, LIMITS.shortLen, { field: `${id} 的英文名` }),
      kind: cleanText(raw.kind, LIMITS.shortLen, { field: `${id} 的类型` }),
      domain: cleanDomain(raw.domain, `${id} 的域名`),
      alt: raw.alt ? cleanDomain(raw.alt, `${id} 的备用域名`) : null,
      url: cleanUrl(raw.url, `${id} 的网址`),
      desc: cleanText(raw.desc, LIMITS.descLen, { field: `${id} 的描述` }),
      tags,
      status,
      hue: hueRaw || null,
      size: cleanNumber(raw.size, { min: 0.1, max: 2, def: 0.42, field: `${id} 的体积` }),
      orbit,
      speed,
      incl: cleanNumber(raw.incl, { min: -60, max: 60, def: 0, field: `${id} 的倾角` }),
      phase: cleanNumber(raw.phase, { min: -100, max: 100, def: 0, field: `${id} 的相位` }),
    };
  });

  const retiredIn = input.retired === undefined ? [] : input.retired;
  if (retiredIn.length > LIMITS.retired) throw new Error(`退役子域上限 ${LIMITS.retired}`);
  const retired = retiredIn
    .map((w) => cleanText(w, LIMITS.shortLen, { field: '退役子域' }).replace(/\.mpsxx\.top$/i, ''))
    .filter((w) => w.length > 0);

  return { star, page, sites, retired };
}

/* ------------------------------------------------------------------ *
 * D1 读写
 * ------------------------------------------------------------------ */

const SETTING = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function readDraft(env) {
  const [metaRes, siteRes, retiredRes] = await env.DB.batch([
    env.DB.prepare('SELECT key, value FROM meta'),
    env.DB.prepare('SELECT * FROM sites ORDER BY sort_index ASC'),
    env.DB.prepare('SELECT word FROM retired ORDER BY sort_index ASC'),
  ]);

  const metaMap = Object.fromEntries((metaRes.results || []).map((r) => [r.key, r.value]));
  const sites = (siteRes.results || []).map((row) => ({
    id: row.id,
    no: row.no,
    zh: row.zh,
    en: row.en || '',
    kind: row.kind || '',
    domain: row.domain,
    alt: row.alt || null,
    url: row.url,
    desc: row.desc || '',
    tags: JSON.parse(row.tags || '[]'),
    status: row.status || 'auto',
    hue: row.hue || null,
    size: row.size,
    orbit: row.orbit,
    speed: row.speed,
    incl: row.incl,
    phase: row.phase,
  }));

  return {
    star: {
      domain: metaMap.star_domain || 'mpsxx.top',
      zh: metaMap.star_zh || '主星',
      desc: metaMap.star_desc || '',
    },
    page: {
      title: metaMap.page_title || '',
      description: metaMap.page_desc || '',
      color: metaMap.page_color || '#05060A',
    },
    sites,
    retired: (retiredRes.results || []).map((r) => r.word),
  };
}

async function writeDraft(env, doc, nowMs) {
  const stmts = [env.DB.prepare('DELETE FROM meta'), env.DB.prepare('DELETE FROM sites'), env.DB.prepare('DELETE FROM retired')];

  const metaPairs = [
    ['star_domain', doc.star.domain],
    ['star_zh', doc.star.zh],
    ['star_desc', doc.star.desc],
    ['page_title', doc.page.title],
    ['page_desc', doc.page.description],
    ['page_color', doc.page.color],
  ];
  for (const [k, v] of metaPairs) {
    stmts.push(env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').bind(k, v));
  }

  const insertSite = env.DB.prepare(
    `INSERT INTO sites (id, sort_index, no, zh, en, kind, domain, alt, url, desc, tags, status, hue, size, orbit, speed, incl, phase)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const s of doc.sites) {
    stmts.push(
      insertSite.bind(
        s.id, s.sortIndex, s.no, s.zh, s.en, s.kind, s.domain, s.alt, s.url, s.desc,
        JSON.stringify(s.tags), s.status, s.hue, s.size, s.orbit, s.speed, s.incl, s.phase
      )
    );
  }

  doc.retired.forEach((word, i) => {
    stmts.push(env.DB.prepare('INSERT INTO retired (word, sort_index) VALUES (?, ?)').bind(word, i));
  });

  stmts.push(SETTING(env, 'draft_updated_at', nowMs));

  await env.DB.batch(stmts);   // D1 batch 为隐式事务：全部成功或全部回滚
  return nowMs;
}

/* ------------------------------------------------------------------ *
 * 在线探测
 * ------------------------------------------------------------------ */

async function probeAll(env) {
  const { results } = await env.DB.prepare('SELECT domain FROM sites ORDER BY sort_index ASC').all();
  const checkedAt = new Date().toISOString();
  const rows = [];

  await Promise.all(
    (results || []).map(async ({ domain }) => {
      const started = Date.now();
      let alive = 0;
      let httpStatus = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const res = await fetch(`https://${domain}/`, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'user-agent': 'orbit-probe/1.0 (+https://mpsxx.top)' },
        });
        clearTimeout(timer);
        httpStatus = res.status;
        alive = res.status < 500 ? 1 : 0;   // 只要源站有响应（含 401/403/404）就算在线
        try { await res.body?.cancel(); } catch { /* 忽略 */ }
      } catch {
        alive = 0;                          // 超时 / DNS 失败 / 同区 Worker 限制等
      }
      rows.push({ domain, ok: alive, http_status: httpStatus, ms: Date.now() - started, checked_at: checkedAt });
    })
  );

  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO probes (domain, ok, http_status, ms, checked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET ok = excluded.ok, http_status = excluded.http_status, ms = excluded.ms, checked_at = excluded.checked_at`
    ).bind(r.domain, r.ok, r.http_status, r.ms, r.checked_at)
  );
  stmts.push(SETTING(env, 'probe_checked_at', Date.now()));

  await env.DB.batch(stmts);
  return rows;
}

async function probeMap(env) {
  const { results } = await env.DB.prepare('SELECT domain, ok, http_status, ms, checked_at FROM probes').all();
  return new Map((results || []).map((r) => [r.domain, r]));
}

/** 把探测结果合并进内容：status=auto 的行星跟随探测，手动值则覆盖探测 */
function mergeStatuses(sites, probes) {
  const merged = sites.map((s) => {
    const probe = probes.get(s.domain) || null;
    let status = s.status;
    if (s.status === 'auto') status = probe ? (probe.ok ? 'online' : 'offline') : 'online';
    return {
      ...s,
      status,
      statusMode: s.status,
      probe: probe ? { ok: !!probe.ok, httpStatus: probe.http_status, ms: probe.ms, checkedAt: probe.checked_at } : null,
    };
  });
  return { sites: merged, onlineCount: merged.filter((s) => s.status === 'online').length };
}

async function publicContent(env) {
  const publishedId = await getSetting(env, 'published_revision_id');
  let doc = null;

  if (publishedId) {
    const row = await env.DB.prepare('SELECT snapshot, created_at FROM revisions WHERE id = ?').bind(publishedId).first();
    if (row) doc = JSON.parse(row.snapshot);
  }
  if (!doc) {
    // 从未发布过任何版本：返回空内容，前端 js/content.js 会自动回退到内置默认值。
    // 这里绝不回退到草稿 —— 否则未发布的改动会直接泄露到公网。
    doc = {
      star: { domain: 'mpsxx.top', zh: '主星', desc: '' },
      page: { title: '', description: '', color: '#05060A' },
      sites: [],
      retired: [],
    };
  }

  const { sites, onlineCount } = mergeStatuses(doc.sites, await probeMap(env));
  return {
    star: doc.star,
    page: doc.page,
    sites,
    retired: doc.retired,
    onlineCount,
    version: publishedId ? `r${publishedId}` : 'draft',
  };
}

/* ------------------------------------------------------------------ *
 * Cloudflare Access 身份校验（RS256 JWT，本地自校验，不信任任何前缀头）
 * ------------------------------------------------------------------ */

let certsCache = { at: 0, keys: [] };

async function accessKeys(teamDomain) {
  if (certsCache.keys.length && Date.now() - certsCache.at < 3600_000) return certsCache.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`取 Access 公钥失败：HTTP ${res.status}`);
  const body = await res.json();

  const keys = [];
  for (const jwk of body.keys || []) {
    try {
      keys.push(await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    } catch { /* 跳过无法导入的密钥 */ }
  }
  certsCache = { at: Date.now(), keys };
  return keys;
}

async function currentUser(request, env) {
  if (String(env.DEV_BYPASS) === 'true') return { email: 'dev@localhost', name: '本地开发' };

  const teamDomain = String(env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!teamDomain || !aud) return { error: 'unconfigured' };

  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return null;

  try {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return null;

    const payload = JSON.parse(b64urlToString(p));
    if (payload.exp && Date.now() / 1000 > payload.exp + 60) return null;

    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;

    const keys = await accessKeys(teamDomain);
    const signature = b64urlToBytes(s);
    const data = new TextEncoder().encode(`${h}.${p}`);
    let valid = false;
    for (const key of keys) {
      if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data)) { valid = true; break; }
    }
    if (!valid) return null;

    const email = String(payload.email || '').toLowerCase();
    const allow = String(env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(email)) return null;

    return { email, name: payload.name || email };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 管理接口
 * ------------------------------------------------------------------ */

async function readJsonBody(request) {
  const raw = await request.text();
  if (raw.length > LIMITS.bodyBytes) throw badInput('提交内容过大');
  try { return JSON.parse(raw || '{}'); } catch { throw badInput('请求体不是合法 JSON'); }
}

async function handleAdmin(request, env, ctx, pathname) {
  const user = await currentUser(request, env);
  if (user && user.error === 'unconfigured') {
    return fail('管理接口尚未配置 Cloudflare Access（缺少 ACCESS_TEAM_DOMAIN / ACCESS_AUD）', 503);
  }
  if (!user) return fail('未通过 Cloudflare Access 验证', 401);

  const route = pathname.replace(/^\/api\/admin\/?/, '');
  const method = request.method.toUpperCase();

  if (route === 'me' && method === 'GET') {
    return json({ email: user.email, name: user.name });
  }

  if (route === 'draft' && method === 'GET') {
    const [draft, probes, publishedId, publishedAt, draftUpdatedAt] = await Promise.all([
      readDraft(env),
      probeMap(env),
      getSetting(env, 'published_revision_id'),
      getSetting(env, 'published_at'),
      getSetting(env, 'draft_updated_at'),
    ]);
    return json({
      draft,
      probes: Object.fromEntries([...probes].map(([d, p]) => [d, { ok: !!p.ok, httpStatus: p.http_status, ms: p.ms, checkedAt: p.checked_at }])),
      published: { revisionId: publishedId ? Number(publishedId) : null, publishedAt: publishedAt || null },
      draftUpdatedAt: Number(draftUpdatedAt || 0),
      dirty: true,
    });
  }

  if (route === 'draft' && (method === 'PUT' || method === 'POST')) {
    const body = await readJsonBody(request);
    const base = Number(body.baseUpdatedAt || 0);
    const current = Number((await getSetting(env, 'draft_updated_at')) || 0);
    if (base && current && base !== current) {
      return fail('内容已在别处被修改，请刷新后重试', 409, { currentUpdatedAt: current });
    }
    const doc = normalizeDoc(body.draft || body);
    const updatedAt = await writeDraft(env, doc, Date.now());
    const fresh = await readDraft(env);
    return json({ draft: fresh, draftUpdatedAt: updatedAt });
  }

  if (route === 'publish' && method === 'POST') {
    const body = await readJsonBody(request);
    const doc = await readDraft(env);
    const snapshot = JSON.stringify({ star: doc.star, page: doc.page, sites: doc.sites, retired: doc.retired });
    const nowIso = new Date().toISOString();
    let note = '';
    try {
      note = cleanText(body.note, LIMITS.shortLen, { field: '发布说明' });
    } catch (err) {
      throw badInput(err.message);
    }

    const res = await env.DB.prepare(
      'INSERT INTO revisions (created_at, author, note, snapshot) VALUES (?, ?, ?, ?) RETURNING id'
    ).bind(nowIso, user.email, note, snapshot).first();

    await env.DB.batch([SETTING(env, 'published_revision_id', res.id), SETTING(env, 'published_at', nowIso)]);
    return json({ ok: true, revisionId: res.id, publishedAt: nowIso });
  }

  if (route === 'revisions' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, created_at, author, note, length(snapshot) AS bytes FROM revisions ORDER BY id DESC LIMIT 100'
    ).all();
    return json({ revisions: results || [] });
  }

  const revMatch = route.match(/^revisions\/(\d+)$/);
  if (revMatch && method === 'GET') {
    const row = await env.DB.prepare('SELECT id, created_at, author, note, snapshot FROM revisions WHERE id = ?').bind(Number(revMatch[1])).first();
    if (!row) return fail('版本不存在', 404);
    return json({ revision: { ...row, snapshot: JSON.parse(row.snapshot) } });
  }

  if (route === 'rollback' && method === 'POST') {
    const body = await readJsonBody(request);
    const id = Number(body.revisionId || 0);
    const row = await env.DB.prepare('SELECT snapshot FROM revisions WHERE id = ?').bind(id).first();
    if (!row) return fail('版本不存在', 404);
    const doc = normalizeDoc(JSON.parse(row.snapshot));
    const updatedAt = await writeDraft(env, doc, Date.now());
    return json({ ok: true, draft: await readDraft(env), draftUpdatedAt: updatedAt, note: '已回滚到该版本（还需点发布才会对外生效）' });
  }

  if (route === 'probe' && method === 'POST') {
    const rows = await probeAll(env);
    return json({ ok: true, probes: rows });
  }

  if (route === 'export' && method === 'GET') {
    const doc = await readDraft(env);
    return new Response(JSON.stringify(doc, null, 2), {
      headers: {
        ...JSON_HEADERS,
        ...NO_STORE,
        'content-disposition': `attachment; filename="orbit-content-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  }

  if (route === 'import' && method === 'POST') {
    const body = await readJsonBody(request);
    const doc = normalizeDoc(body.draft || body);
    const updatedAt = await writeDraft(env, doc, Date.now());
    return json({ ok: true, draft: await readDraft(env), draftUpdatedAt: updatedAt, note: '已导入为草稿（还需点发布才会对外生效）' });
  }

  return fail(`未知的管理接口：${route}`, 404);
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

async function handlePublicContent(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('只支持 GET', 405);

  let content;
  try {
    content = await publicContent(env);
  } catch (err) {
    return fail(`内容库读取失败：${err.message}`, 500);
  }

  // 探测是有成本的，放在响应之后后台跑，并遵守冷却时间
  const lastProbe = Number((await getSetting(env, 'probe_checked_at')) || 0);
  if (Date.now() - lastProbe > PROBE_COOLDOWN_MS) {
    ctx.waitUntil(probeAll(env).catch(() => {}));
  }

  return json(content);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // 1) www 子域统一 301 到主域。放在代码里实现，就不需要 Zone → Rules 权限。
      if (url.hostname.startsWith('www.')) {
        url.hostname = url.hostname.slice(4);
        url.protocol = 'https:';
        return Response.redirect(url.toString(), 301);
      }

      // 2) 管理面板静态资源：Access 配置完成前不对外提供，避免 /admin 裸奔在公网。
      //    配置了 ACCESS_AUD 之后，边缘由 Cloudflare Access 拦人，这里只做兜底闸门。
      if ((pathname === '/admin' || pathname.startsWith('/admin/')) && !env.ACCESS_AUD) {
        return fail('管理面板尚未启用：Cloudflare Access 未配置', 503);
      }

      if (pathname === '/api/content') return await handlePublicContent(request, env, ctx);
      if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) return await handleAdmin(request, env, ctx, pathname);
      if (pathname.startsWith('/api/')) return fail('接口不存在', 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const prefix = status === 500 ? '服务异常：' : '';
      return fail(`${prefix}${err && err.message ? err.message : err}`, status);
    }
  },
};
