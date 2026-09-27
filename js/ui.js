/* ============================================================
 * 星轨 ORBIT · 界面交互与状态机
 * 加载序列 / 索引 / 档案卡 / 键盘导航 / 时钟 / tooltip
 * ============================================================ */

import { SITES, STAR, RETIRED, onlineCount } from './data.js';
import { createScene } from './scene.js';

const $ = (id) => document.getElementById(id);
const els = {
  loader: $('loader'), pct: $('loader-pct'), barFill: $('loader-bar-fill'), note: $('loader-note'),
  statusText: $('status-text'), clock: $('clock'),
  index: $('index'), retired: $('retired-list'),
  tooltip: $('tooltip'), ttText: $('tt-text'),
  dossier: $('dossier'), dGhost: $('d-ghost'), dClose: $('d-close'),
  dStatus: $('d-status'), dStatusText: $('d-status-text'),
  dName: $('d-name'), dEn: $('d-en'), dDomain: $('d-domain'),
  dDesc: $('d-desc'), dTags: $('d-tags'), dVisit: $('d-visit'), dBack: $('d-back'),
  stage: $('stage'),
};

const state = { current: null };
const byId = Object.fromEntries(SITES.map(s => [s.id, s]));

/* ---------- 顶栏静态信息 ---------- */
els.statusText.textContent = `${onlineCount} / ${SITES.length} 节点在线`;
els.retired.textContent = RETIRED.join(' · ');

setInterval(() => {
  const now = new Date();
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(now).replace(/\//g, '.');
  els.clock.textContent = `${f} CST`;
}, 1000);

/* ---------- 三维场景 ---------- */
const scene = createScene(els.stage, SITES, {
  onHover: (id, x, y) => {
    if (!id) { els.tooltip.classList.remove('on'); return; }
    const label = id === 'star'
      ? `主星 · ${STAR.domain}`
      : `${byId[id].no} ${byId[id].zh} · ${byId[id].domain}`;
    els.ttText.textContent = label;
    els.tooltip.style.left = Math.min(x, window.innerWidth - 260) + 'px';
    els.tooltip.style.top = y + 'px';
    els.tooltip.classList.add('on');
  },
  onPick: (id) => {
    if (id === 'star') deselect();
    else select(id);
  },
});
if (!scene) document.body.classList.add('no-webgl');

/* ---------- 索引列 ---------- */
SITES.forEach((s) => {
  const btn = document.createElement('button');
  btn.className = 'idx' + (s.status === 'offline' ? ' is-offline' : '');
  btn.dataset.id = s.id;
  btn.style.setProperty('--h', s.hue);
  btn.setAttribute('aria-label', `${s.zh} ${s.domain}${s.status === 'offline' ? '（暂时离线）' : ''}`);
  btn.innerHTML = `
    <span class="idx-no">${s.no}</span>
    <span class="idx-body">
      <span class="idx-name">${s.zh}<i class="idx-dot"></i>${s.status === 'offline' ? '<em class="idx-off">OFF</em>' : ''}</span>
      <span class="idx-domain">${s.domain}</span>
    </span>`;
  btn.addEventListener('mouseenter', () => scene && scene.syncHover(s.id));
  btn.addEventListener('mouseleave', () => scene && scene.syncHover(null));
  btn.addEventListener('click', () => select(s.id));
  els.index.appendChild(btn);
});

/* ---------- 档案卡 ---------- */
function populateDossier(s) {
  els.dossier.style.setProperty('--h', s.hue);
  els.dGhost.textContent = s.no;
  els.dName.textContent = s.zh;
  els.dEn.textContent = `${s.en} · ${s.kind}`;
  els.dDomain.innerHTML = `<span>${s.domain}</span>${s.alt ? `<em>alt · ${s.alt}</em>` : ''}`;
  els.dDesc.textContent = s.desc;
  els.dTags.innerHTML = s.tags.map(t => `<li>${t}</li>`).join('');

  const off = s.status === 'offline';
  els.dStatus.classList.toggle('off', off);
  els.dStatusText.textContent = off ? '暂时离线 · OFFLINE' : '在线 · ONLINE';
  // 离线站点保留跳转能力：状态仅作提示，不阻断访问
  els.dVisit.classList.remove('disabled');
  els.dVisit.href = s.url;
  els.dVisit.textContent = off ? '仍要访问 ↗' : '访问站点 ↗';
}

function select(id) {
  if (state.current === id) return;
  state.current = id;
  const s = byId[id];
  populateDossier(s);
  els.dossier.classList.add('open');
  els.dossier.setAttribute('aria-hidden', 'false');
  document.body.classList.add('is-focused');
  document.querySelectorAll('.idx').forEach(b =>
    b.classList.toggle('is-active', b.dataset.id === id));
  scene && scene.focusSite(id);
}

function deselect() {
  if (!state.current) return;
  state.current = null;
  els.dossier.classList.remove('open');
  els.dossier.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('is-focused');
  document.querySelectorAll('.idx').forEach(b => b.classList.remove('is-active'));
  scene && scene.overview();
}

els.dClose.addEventListener('click', deselect);
els.dBack.addEventListener('click', deselect);

/* ---------- 键盘 ---------- */
const order = SITES.map(s => s.id);
window.addEventListener('keydown', (e) => {
  const i = order.indexOf(state.current);
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    select(order[Math.min(i + 1, order.length - 1)]);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    select(order[Math.max(i - 1, 0)]);
  } else if (e.key === 'Enter' && state.current) {
    window.open(byId[state.current].url, '_blank', 'noopener');
  } else if (e.key === 'Escape') {
    deselect();
  }
});

/* ---------- 加载序列 → 开场 ---------- */
const LOG_LINES = [
  [0,  '正在点燃恒星 · IGNITING STAR'],
  [20, '铺设轨道环 · TRACING ORBITS'],
  [45, '播撒星尘 · SEEDING STARDUST'],
  [72, '校准引力参数 · CALIBRATING GRAVITY'],
  [94, '就绪 · READY'],
];
const progress = { p: 0 };

function setProgress(v) {
  progress.p = v;
  els.pct.textContent = String(Math.round(v)).padStart(2, '0');
  els.barFill.style.transform = `scaleX(${v / 100})`;
  const line = [...LOG_LINES].reverse().find(([t]) => v >= t);
  if (line) els.note.textContent = line[1];
}

const fontsReady = Promise.race([
  document.fonts ? document.fonts.ready : Promise.resolve(),
  new Promise(r => setTimeout(r, 2600)),
]);

/* RAF 冻结探测（被遮挡窗口 / 无头环境）—— 冻结时跳过时间线动画直接就绪 */
const detectFrozen = () => new Promise((resolve) => {
  if (window.__orbitFrozen) return resolve(true);
  let n = 0;
  const loop = () => { n++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setTimeout(() => resolve(n < 2), 450);
});

detectFrozen().then((frozen) => {
  if (frozen) {
    window.__orbitFrozen = true;
    setProgress(100);
    setTimeout(boot, 300);
    return;
  }
  const loadTween = window.gsap
    ? gsap.to(progress, {
        p: 100, duration: 2.1, ease: 'power1.inOut',
        onUpdate: () => setProgress(progress.p),
      })
    : (setProgress(100), Promise.resolve());
  Promise.all([fontsReady, loadTween]).then(boot);
});

function boot() {
  window.__orbitReady = true;
  els.loader.classList.add('done');

  const intro = scene ? scene.playIntro() : Promise.resolve();

  // 覆盖层 UI 显现（与场景开场并行；冻结环境直接显示默认态）
  if (window.gsap && !window.__orbitFrozen) {
    const tl = gsap.timeline({ delay: scene ? 1.15 : 0.2 });
    tl.fromTo('.title', { opacity: 0, letterSpacing: '0.42em', y: 26 },
        { opacity: 1, letterSpacing: '0.14em', y: 0, duration: 1.5, ease: 'power3.out' }, 0)
      .fromTo('.kicker', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.9, ease: 'power2.out' }, 0.25)
      .fromTo('.lede', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.9, ease: 'power2.out' }, 0.4)
      .fromTo('.topbar', { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.9, ease: 'power2.out' }, 0.55)
      .fromTo('.idx', { opacity: 0, x: 26 }, { opacity: 1, x: 0, duration: 0.7, stagger: 0.07, ease: 'power2.out' }, 0.65)
      .fromTo('.hints, .corner', { opacity: 0 }, { opacity: 1, duration: 1.1, ease: 'power2.out' }, 0.9)
      .fromTo('.grain', { opacity: 0 }, { opacity: 0.05, duration: 1.2 }, 0.9);
    // 保险丝：RAF 中途冻结导致时间线卡死时，直接落到终态
    setTimeout(() => { if (tl.progress() < 0.02) tl.progress(1); }, 6000);
  }
  return intro;
}
