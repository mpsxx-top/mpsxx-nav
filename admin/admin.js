/* ============================================================
 * ORBIT 控制台 · 管理面板
 * ------------------------------------------------------------
 * 数据流：GET /api/admin/draft 取草稿 → 本地编辑（防抖 700ms 自动 PUT 保存）
 *        → 右侧 iframe 加载 /?preview=1 预览草稿 → 点「发布」才对外生效
 * 鉴权：整站由 Cloudflare Access 保护，Worker 内还会再校验一次 JWT
 * ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  draft: null,
  baseUpdatedAt: 0,
  published: { revisionId: null, publishedAt: null },
  probes: {},
  selectedId: null,
  dirty: false,
  saving: false,
  saveTimer: null,
  previewTimer: null,
};

/* ------------------------------------------------------------------ *
 * 基础设施
 * ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 可能没有响应体 */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const escapeHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let toastTimer = null;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}

function banner(html) {
  const el = $('#banner');
  if (!html) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = html;
  el.hidden = false;
}

function showAuthProblem(err) {
  if (err.status === 401) {
    banner('未通过 Cloudflare Access 验证。<a href="/admin"><b>点此刷新</b></a>会跳转到登录页（邮箱验证码）。');
  } else if (err.status === 503) {
    banner('管理接口尚未配置 Cloudflare Access —— 请在 Pages 项目里补上 <code>ACCESS_TEAM_DOMAIN</code> 与 <code>ACCESS_AUD</code> 后重新部署。');
  } else {
    banner(`请求失败：${escapeHtml(err.message)}`);
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

function renumber() {
  state.draft.sites.forEach((s, i) => { s.no = pad2(i + 1); s.sortIndex = i; });
}

/** 与 _worker.js / js/content.js 同规则：auto 跟随探测，手动值优先 */
function effectiveStatus(site) {
  if (site.status === 'online' || site.status === 'offline') return site.status;
  const probe = state.probes[site.domain];
  if (!probe) return 'online';
  return probe.ok ? 'online' : 'offline';
}

function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return iso; }
}

/* ------------------------------------------------------------------ *
 * 状态条 / 保存
 * ------------------------------------------------------------------ */

function renderSyncState() {
  const pill = $('#sync-state');
  pill.className = 'pill';
  if (state.saving) { pill.classList.add('saving'); pill.textContent = '正在保存…'; }
  else if (state.dirty) { pill.classList.add('dirty'); pill.textContent = '有未发布改动'; }
  else { pill.classList.add('saved'); pill.textContent = '草稿已保存'; }

  const p = state.published || {};
  $('#published-at').textContent = p.publishedAt
    ? `线上版本 #${p.revisionId != null ? p.revisionId : '—'} · ${fmtTime(p.publishedAt)}`
    : '还没发布过：线上当前用的是首次内容';
}

function touch({ preview = true } = {}) {
  state.dirty = true;
  renderSyncState();

  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 700);

  if (preview && $('#auto-preview').checked) {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(reloadPreview, 1200);
  }
}

async function save() {
  if (!state.draft || state.saving) return;
  state.saving = true;
  renderSyncState();
  try {
    const res = await api('/api/admin/draft', {
      method: 'PUT',
      body: { draft: state.draft, baseUpdatedAt: state.baseUpdatedAt },
    });
    state.baseUpdatedAt = res.draftUpdatedAt;
    // 把服务端规范化后的编号回填进本地对象（保持对象引用，避免打断正在输入的表单）
    (res.draft.sites || []).forEach((s, i) => {
      const local = state.draft.sites[i];
      if (local && local.id === s.id) local.no = s.no;
    });
    state.dirty = false;
    renderList();
  } catch (err) {
    if (err.status === 409) {
      toast('内容已在别处被修改，正在重新载入…', 'warn');
      await reload();
    } else if (err.status === 401 || err.status === 503) {
      showAuthProblem(err);
    } else {
      toast(`保存失败：${err.message}`, 'error');
    }
  } finally {
    state.saving = false;
    renderSyncState();
  }
}

function reloadPreview() {
  const frame = $('#preview');
  try { frame.contentWindow.location.reload(); }
  catch { frame.src = '/?preview=1'; }
}

/* 横屏站点预览：默认 16:9，并提供常见视口比例检查 */
const PREVIEW_MODES = {
  desktop: { label: '1440 × 810 · 16:9' },
  laptop: { label: '1280 × 800 · 16:10' },
  tablet: { label: '1024 × 768 · 4:3' },
  phone: { label: '390 × 844 · 9:19.5' },
};

function setPreviewMode(mode) {
  if (!PREVIEW_MODES[mode]) mode = 'desktop';
  const stage = $('.preview-stage');
  stage.dataset.mode = mode;
  $('#preview-size-label').textContent = PREVIEW_MODES[mode].label;
  $$('.preview-mode').forEach((button) => {
    const active = button.dataset.previewMode === mode;
    button.classList.toggle('is-on', active);
    button.setAttribute('aria-pressed', String(active));
  });
  try { localStorage.setItem('orbit-preview-mode', mode); } catch { /* 隐私模式可能禁用 */ }
}

async function togglePreviewFullscreen() {
  const panel = $('#preview-panel');
  try {
    if (document.fullscreenElement === panel) await document.exitFullscreen();
    else await panel.requestFullscreen();
  } catch (err) {
    toast(`浏览器不支持全屏预览：${err.message}`, 'warn');
  }
}

function syncFullscreenButton() {
  $('#btn-fullscreen-preview').textContent = document.fullscreenElement === $('#preview-panel')
    ? '退出全屏'
    : '全屏预览';
}

/* ------------------------------------------------------------------ *
 * 字段构造（行星与页面文案共用一套）
 * ------------------------------------------------------------------ */

const SITE_FIELDS = [
  { key: 'zh', label: '名称（中文）', type: 'text' },
  { key: 'en', label: '英文名', type: 'text' },
  { key: 'kind', label: '类型', type: 'text', hint: '如「个人博客 · 新站」' },
  { key: 'domain', label: '域名', type: 'text' },
  { key: 'alt', label: '备用域名', type: 'text', hint: '可留空' },
  { key: 'url', label: '访问地址', type: 'text' },
  { key: 'desc', label: '描述', type: 'textarea', full: true },
  { key: 'tags', label: '标签', type: 'tags', hint: '逗号或顿号分隔，最多 12 个' },
  {
    key: 'status', label: '在线状态', type: 'select',
    options: [['auto', '自动探测'], ['online', '强制在线'], ['offline', '强制离线']],
  },
  { key: 'hue', label: '主色', type: 'color' },
  { key: 'size', label: '体积', type: 'range', min: 0.1, max: 1.2, step: 0.01 },
  { key: 'orbit', label: '轨道半径', type: 'range', min: 1, max: 40, step: 0.1 },
  { key: 'speed', label: '公转速度', type: 'range', min: 0.005, max: 0.6, step: 0.005 },
  { key: 'incl', label: '轨道倾角', type: 'range', min: -20, max: 20, step: 0.1 },
  { key: 'phase', label: '初始相位', type: 'range', min: -6.3, max: 6.3, step: 0.1 },
];

const numText = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : '0');

function buildField(obj, cfg) {
  const wrap = document.createElement('div');
  wrap.className = 'field' + (cfg.full ? ' full' : '');

  const id = `f-${cfg.key}-${Math.random().toString(36).slice(2, 7)}`;
  const label = document.createElement('label');
  label.setAttribute('for', id);
  label.innerHTML = escapeHtml(cfg.label) + (cfg.hint ? ` <span class="sub">${escapeHtml(cfg.hint)}</span>` : '');
  wrap.appendChild(label);

  const commit = (value) => {
    obj[cfg.key] = value;
    if (cfg.key === 'status' || cfg.key === 'hue') renderList();
    touch();
  };

  const type = cfg.type;

  if (type === 'textarea') {
    const el = document.createElement('textarea');
    el.className = 'input';
    el.id = id;
    el.rows = 3;
    el.value = obj[cfg.key] || '';
    el.addEventListener('input', () => commit(el.value));
    wrap.appendChild(el);
    return wrap;
  }

  if (type === 'tags') {
    const el = document.createElement('input');
    el.className = 'input';
    el.id = id;
    el.type = 'text';
    el.value = Array.isArray(obj[cfg.key]) ? obj[cfg.key].join('、') : '';
    el.placeholder = '写作、技术、轻食';
    el.addEventListener('input', () => {
      commit(el.value.split(/[,，、]/).map((t) => t.trim()).filter(Boolean).slice(0, 12));
    });
    wrap.appendChild(el);
    return wrap;
  }

  if (type === 'select') {
    const el = document.createElement('select');
    el.className = 'input';
    el.id = id;
    for (const [value, text] of cfg.options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if ((obj[cfg.key] || 'auto') === value) opt.selected = true;
      el.appendChild(opt);
    }
    el.addEventListener('change', () => commit(el.value));
    wrap.appendChild(el);
    return wrap;
  }

  if (type === 'color') {
    const row = document.createElement('div');
    row.className = 'color-row';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.id = id;
    picker.value = /^#[0-9a-f]{6}$/i.test(obj[cfg.key] || '') ? obj[cfg.key] : '#E8C87E';
    const text = document.createElement('input');
    text.className = 'input mono';
    text.type = 'text';
    text.value = obj[cfg.key] || '';
    picker.addEventListener('input', () => { text.value = picker.value; commit(picker.value); });
    text.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value;
      commit(text.value);
    });
    row.append(picker, text);
    wrap.appendChild(row);
    return wrap;
  }

  if (type === 'range') {
    const row = document.createElement('div');
    row.className = 'range-row';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = id;
    slider.min = cfg.min; slider.max = cfg.max; slider.step = cfg.step;
    slider.value = Number.isFinite(Number(obj[cfg.key])) ? Number(obj[cfg.key]) : 0;
    const num = document.createElement('input');
    num.className = 'input num mono';
    num.type = 'number';
    num.step = cfg.step;
    num.value = numText(slider.value);
    slider.addEventListener('input', () => { num.value = numText(slider.value); commit(Number(slider.value)); });
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) { slider.value = v; commit(v); }
    });
    row.append(slider, num);
    wrap.appendChild(row);
    return wrap;
  }

  // 默认：单行文本
  const el = document.createElement('input');
  el.className = 'input';
  el.id = id;
  el.type = 'text';
  el.value = obj[cfg.key] == null ? '' : obj[cfg.key];
  if (cfg.readonly) el.readOnly = true;
  el.addEventListener('input', () => commit(el.value));
  wrap.appendChild(el);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * 渲染：行星列表 / 表单
 * ------------------------------------------------------------------ */

function renderList() {
  const ul = $('#planet-list');
  ul.innerHTML = '';
  for (const site of state.draft.sites) {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.id = site.id;
    if (site.id === state.selectedId) li.classList.add('is-on');

    const color = /^#[0-9a-f]{6}$/i.test(site.hue || '') ? site.hue : '#E8C87E';
    const offline = effectiveStatus(site) === 'offline';
    li.innerHTML = `
      <span class="swatch" style="background:${color};color:${color}"></span>
      <span class="no">${escapeHtml(site.no || '')}</span>
      <span class="name">${escapeHtml(site.zh || site.domain)}</span>
      ${offline ? '<span class="dot-off" title="当前判定为离线"></span>' : ''}`;
    li.addEventListener('click', () => {
      state.selectedId = site.id;
      renderList();
      renderForm();
    });
    ul.appendChild(li);
  }
}

function renderForm() {
  const host = $('#form');
  if (!state.draft.sites.length) {
    host.innerHTML = '<p class="empty">还没有行星，点左上角「+ 新增」。</p>';
    return;
  }
  const site = state.draft.sites.find((s) => s.id === state.selectedId) || state.draft.sites[0];
  state.selectedId = site.id;

  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'form-head';
  head.innerHTML = `<h2>${escapeHtml(site.zh || site.domain)} <span class="muted mono">${escapeHtml(site.id)}</span></h2>`;
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn small danger';
  del.textContent = '删除';
  del.addEventListener('click', () => removeSite(site.id));
  head.appendChild(del);
  host.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'form-grid';
  grid.appendChild(buildField(site, { key: 'id', label: 'id', type: 'text', readonly: true, hint: '发布后不建议修改' }));
  for (const cfg of SITE_FIELDS) grid.appendChild(buildField(site, cfg));

  const probe = state.probes[site.domain];
  const info = document.createElement('div');
  info.className = 'field full';
  info.innerHTML = `<label>在线探测</label><div class="muted">${probe
    ? `${probe.ok ? '可达' : '不可达'} · HTTP ${probe.httpStatus == null ? '—' : probe.httpStatus} · ${probe.ms == null ? '—' : probe.ms} ms · ${fmtTime(probe.checkedAt)}`
    : '还没有这颗行星的探测记录'}</div>`;
  grid.appendChild(info);

  host.appendChild(grid);
}

function addSite() {
  const raw = window.prompt('新行星的 id（小写字母 / 数字 / - / _）', `site${state.draft.sites.length + 1}`);
  if (!raw) return;
  const id = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) { toast('id 只能用小写字母、数字、- 和 _', 'error'); return; }
  if (state.draft.sites.some((s) => s.id === id)) { toast('这个 id 已经存在', 'error'); return; }

  const last = state.draft.sites[state.draft.sites.length - 1];
  state.draft.sites.push({
    id,
    no: pad2(state.draft.sites.length + 1),
    zh: '新站点',
    en: 'NEW SITE',
    kind: '',
    domain: `${id}.mpsxx.top`,
    alt: null,
    url: `https://${id}.mpsxx.top`,
    desc: '',
    tags: [],
    status: 'auto',
    hue: '#E8C87E',
    size: 0.42,
    orbit: last ? Math.min(40, Number(last.orbit || 12) + 2.1) : 8,
    speed: last ? Math.max(0.02, Number(last.speed || 0.1) - 0.015) : 0.15,
    incl: 0,
    phase: 0,
  });
  state.selectedId = id;
  renumber();
  renderList();
  renderForm();
  touch();
}

function removeSite(id) {
  const site = state.draft.sites.find((s) => s.id === id);
  if (!site) return;
  if (!window.confirm(`确定删除「${site.zh || site.domain}」吗？删除后点「发布」才会真正从公网消失。`)) return;
  state.draft.sites = state.draft.sites.filter((s) => s.id !== id);
  state.selectedId = state.draft.sites[0] ? state.draft.sites[0].id : null;
  renumber();
  renderList();
  renderForm();
  touch();
}

/* ------------------------------------------------------------------ *
 * 拖拽排序
 * ------------------------------------------------------------------ */

function bindDragAndDrop() {
  const list = $('#planet-list');
  let dragging = null;

  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    dragging = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.id);
  });

  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('li[data-id]');
    if (!over || over === dragging) return;
    const rect = over.getBoundingClientRect();
    const after = e.clientY - rect.top > rect.height / 2;
    list.insertBefore(dragging, after ? over.nextSibling : over);
  });

  const commitOrder = () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    const ids = $$('#planet-list li[data-id]').map((li) => li.dataset.id);
    state.draft.sites.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    renumber();
    renderList();
    renderForm();
    touch();
  };

  list.addEventListener('drop', (e) => { e.preventDefault(); commitOrder(); });
  list.addEventListener('dragend', commitOrder);
}

/* ------------------------------------------------------------------ *
 * 其它面板
 * ------------------------------------------------------------------ */

function renderMeta() {
  const host = $('#meta-form');
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'form-head';
  head.innerHTML = '<h2>主星与页面文案</h2>';
  host.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'form-grid';
  grid.appendChild(buildField(state.draft.star, { key: 'zh', label: '主星名称', type: 'text' }));
  grid.appendChild(buildField(state.draft.star, { key: 'domain', label: '主星域名', type: 'text' }));
  grid.appendChild(buildField(state.draft.star, { key: 'desc', label: '主星描述', type: 'textarea', full: true }));
  grid.appendChild(buildField(state.draft.page, { key: 'title', label: '页面标题 <title>', type: 'text', full: true }));
  grid.appendChild(buildField(state.draft.page, { key: 'description', label: '页面 description', type: 'text', full: true }));
  grid.appendChild(buildField(state.draft.page, { key: 'color', label: '主题色 theme-color', type: 'color' }));
  host.appendChild(grid);
}

function renderRetired() {
  $('#retired-input').value = (state.draft.retired || []).join('\n');
}

function renderProbes() {
  const host = $('#probe-table');
  const rows = Object.entries(state.probes || {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (!rows.length) {
    host.innerHTML = '<p class="muted">还没有探测记录 —— 点上面的「立即探测在线状态」跑一次。</p>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'grid';
  table.innerHTML = '<thead><tr><th>域名</th><th>结果</th><th>HTTP</th><th>耗时</th><th>探测时间</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const [domain, p] of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mono">${escapeHtml(domain)}</td>
      <td class="${p.ok ? 'ok-text' : 'off-text'}">${p.ok ? '可达' : '不可达'}</td>
      <td class="mono">${p.httpStatus == null ? '—' : p.httpStatus}</td>
      <td class="mono">${p.ms == null ? '—' : p.ms + ' ms'}</td>
      <td class="muted">${escapeHtml(fmtTime(p.checkedAt))}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.innerHTML = '';
  host.appendChild(table);
}

async function loadRevisions() {
  const host = $('#revisions');
  host.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { revisions } = await api('/api/admin/revisions');
    if (!revisions || !revisions.length) {
      host.innerHTML = '<p class="muted">还没有发布过任何版本。</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'grid';
    table.innerHTML = '<thead><tr><th>#</th><th>发布时间</th><th>作者</th><th>说明</th><th>大小</th><th></th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const r of revisions) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="mono">${r.id}</td>
        <td>${escapeHtml(fmtTime(r.created_at))}</td>
        <td class="mono">${escapeHtml(r.author || '—')}</td>
        <td>${escapeHtml(r.note || '')}</td>
        <td class="mono">${(Number(r.bytes || 0) / 1024).toFixed(1)} KB</td>`;
      const td = document.createElement('td');
      const view = document.createElement('button');
      view.type = 'button'; view.className = 'btn small ghost'; view.textContent = '查看';
      view.addEventListener('click', () => viewRevision(r.id));
      const roll = document.createElement('button');
      roll.type = 'button'; roll.className = 'btn small'; roll.textContent = '回滚';
      roll.addEventListener('click', () => rollback(r.id));
      td.append(view, roll);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.innerHTML = '';
    host.appendChild(table);
  } catch (err) {
    host.innerHTML = `<p class="muted">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

async function viewRevision(id) {
  const pre = $('#revision-preview');
  try {
    const { revision } = await api(`/api/admin/revisions/${id}`);
    pre.textContent = JSON.stringify(revision.snapshot, null, 2);
    pre.hidden = false;
    pre.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(`读取版本失败：${err.message}`, 'error');
  }
}

async function rollback(id) {
  if (!window.confirm(`把草稿回滚到版本 #${id}？回滚后还需要点「发布」才会对外生效。`)) return;
  try {
    const res = await api('/api/admin/rollback', { method: 'POST', body: { revisionId: id } });
    state.draft = res.draft;
    state.baseUpdatedAt = res.draftUpdatedAt;
    state.selectedId = state.draft.sites[0] ? state.draft.sites[0].id : null;
    state.dirty = true;
    renderAll();
    reloadPreview();
    toast(`已回滚到 #${id}（记得点发布）`, 'warn');
  } catch (err) {
    toast(`回滚失败：${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function renderAll() {
  renderSyncState();
  renderList();
  renderForm();
  renderMeta();
  renderRetired();
  renderProbes();
}

async function reload() {
  const data = await api('/api/admin/draft');
  state.draft = data.draft;
  state.baseUpdatedAt = data.draftUpdatedAt || 0;
  state.published = data.published || { revisionId: null, publishedAt: null };
  state.probes = data.probes || {};
  if (!state.draft.sites.some((s) => s.id === state.selectedId)) {
    state.selectedId = state.draft.sites[0] ? state.draft.sites[0].id : null;
  }
  state.dirty = false;
  renderAll();
}

async function publish() {
  const note = $('#publish-note').value.trim();
  if (!window.confirm('把当前草稿发布到公网？发布后页面刷新即生效。')) return;
  const btn = $('#btn-publish');
  btn.disabled = true;
  try {
    clearTimeout(state.saveTimer);
    await save();                                   // 先确保草稿落库
    const res = await api('/api/admin/publish', { method: 'POST', body: { note } });
    state.published = { revisionId: res.revisionId, publishedAt: res.publishedAt };
    state.dirty = false;
    $('#publish-note').value = '';
    renderSyncState();
    reloadPreview();
    loadRevisions();
    toast(`已发布 #${res.revisionId}`, 'ok');
  } catch (err) {
    if (err.status === 401 || err.status === 503) showAuthProblem(err);
    else toast(`发布失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function probeNow() {
  const btn = $('#btn-probe');
  btn.disabled = true;
  btn.textContent = '探测中…';
  try {
    const res = await api('/api/admin/probe', { method: 'POST' });
    state.probes = {};
    for (const row of res.probes || []) {
      state.probes[row.domain] = { ok: !!row.ok, httpStatus: row.http_status, ms: row.ms, checkedAt: row.checked_at };
    }
    renderProbes();
    renderList();
    renderForm();
    toast('探测完成', 'ok');
  } catch (err) {
    toast(`探测失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '立即探测在线状态';
  }
}

async function importJson(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const res = await api('/api/admin/import', { method: 'POST', body: { draft: parsed } });
    state.draft = res.draft;
    state.baseUpdatedAt = res.draftUpdatedAt;
    state.selectedId = state.draft.sites[0] ? state.draft.sites[0].id : null;
    state.dirty = true;
    renderAll();
    reloadPreview();
    toast('已导入为草稿（记得点发布）', 'warn');
  } catch (err) {
    toast(`导入失败：${err.message}`, 'error');
  }
}

function bindStatic() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-on', t === tab));
    $$('.tabpanel').forEach((p) => p.classList.toggle('is-on', p.dataset.panel === tab.dataset.tab));
    if (tab.dataset.tab === 'history') loadRevisions();
    if (tab.dataset.tab === 'data') renderProbes();
  }));

  $('#btn-add').addEventListener('click', addSite);
  $('#btn-publish').addEventListener('click', publish);
  $('#btn-probe').addEventListener('click', probeNow);
  $('#btn-reload-revisions').addEventListener('click', loadRevisions);
  $('#btn-reload-preview').addEventListener('click', reloadPreview);
  $('#btn-fullscreen-preview').addEventListener('click', togglePreviewFullscreen);
  $$('.preview-mode').forEach((button) => {
    button.addEventListener('click', () => setPreviewMode(button.dataset.previewMode));
  });
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  let initialPreviewMode = 'desktop';
  try { initialPreviewMode = localStorage.getItem('orbit-preview-mode') || 'desktop'; } catch { /* 忽略 */ }
  setPreviewMode(initialPreviewMode);

  $('#retired-input').addEventListener('input', (e) => {
    state.draft.retired = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean);
    touch();
  });

  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importJson(file);
    e.target.value = '';
  });

  bindDragAndDrop();
}

(async function boot() {
  bindStatic();
  banner('');
  try {
    const me = await api('/api/admin/me');
    $('#who').textContent = me.email || '';
  } catch (err) {
    showAuthProblem(err);
    return;
  }
  try {
    await reload();
  } catch (err) {
    if (err.status === 401 || err.status === 503) showAuthProblem(err);
    else banner(`读取内容失败：${escapeHtml(err.message)}`);
    return;
  }
  loadRevisions();
})();
