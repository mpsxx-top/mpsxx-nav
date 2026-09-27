/* ============================================================
 * 星轨 ORBIT · 三维场景
 * 恒星核心（噪声位移 + Fresnel）／六条倾斜轨道／六颗行星
 * 星尘粒子／UnrealBloom 后处理／相机 Rig（视差 + 飞行聚焦）
 * ============================================================ */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE = window.matchMedia('(pointer: coarse)').matches;

/* ---------- GLSL：Ashima 3D simplex noise ---------- */
const SNOISE = /* glsl */`
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0,0.5,1.0,2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0,i1.z,i2.z,1.0))
        + i.y + vec4(0.0,i1.y,i2.y,1.0)) + i.x + vec4(0.0,i1.x,i2.x,1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0*floor(p*ns.z*ns.z);
  vec4 x_ = floor(j*ns.z);
  vec4 y_ = floor(j - 7.0*x_);
  vec4 x = x_*ns.x + ns.yyyy;
  vec4 y = y_*ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
  m = m*m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

/* ---------- 软辉光贴图 ---------- */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.42)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createScene(container, sites, callbacks) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);

  renderer.setClearColor(0x05060a, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const glowMap = glowTexture();

  /* ---------- 天穹：极淡的纵深渐变 ---------- */
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(140, 32, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main(){ vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        void main(){
          vec3 top = vec3(0.024, 0.027, 0.043);
          vec3 bot = vec3(0.012, 0.014, 0.024);
          float t = smoothstep(-0.35, 0.75, vDir.y);
          gl_FragColor = vec4(mix(bot, top, t), 1.0); }`,
    })
  );
  scene.add(sky);

  /* ---------- 光照 ---------- */
  scene.add(new THREE.AmbientLight(0x232838, 1.6));
  const sun = new THREE.PointLight(0xffeecb, 320, 0, 2);
  scene.add(sun);

  /* ---------- 星系组 ---------- */
  const galaxy = new THREE.Group();
  scene.add(galaxy);

  /* ---------- 恒星核心 ---------- */
  const starUniforms = {
    uTime: { value: 0 },
    uColorB: { value: new THREE.Color('#e8c884') },
    uColorC: { value: new THREE.Color('#fff7df') },
  };
  const star = new THREE.Mesh(
    new THREE.SphereGeometry(1.55, 96, 96),
    new THREE.ShaderMaterial({
      uniforms: starUniforms,
      vertexShader: SNOISE + /* glsl */`
        uniform float uTime;
        varying vec3 vNormal; varying vec3 vPos; varying float vNoise;
        void main(){
          vec3 sp = normalize(position);
          float n = snoise(sp*2.3 + uTime*0.16) + snoise(sp*5.2 - uTime*0.11)*0.35;
          vec3 p = position + normal * n * 0.028;
          vNoise = n;
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vPos = mv.xyz;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColorB; uniform vec3 uColorC;
        varying vec3 vNormal; varying vec3 vPos; varying float vNoise;
        void main(){
          vec3 viewDir = normalize(-vPos);
          float fres = pow(1.0 - max(dot(viewDir, normalize(vNormal)), 0.0), 2.2);
          vec3 col = mix(uColorB, uColorC, clamp(0.32 + fres*0.95, 0.0, 1.0));
          col *= 1.0 - 0.15 * smoothstep(0.1, 0.9, vNoise);
          col += uColorB * fres * 0.55;
          col *= 1.45 + fres*1.35;
          gl_FragColor = vec4(col, 1.0); }`,
    })
  );
  galaxy.add(star);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowMap, color: new THREE.Color('#e4c88e'),
    transparent: true, opacity: 0.5, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(11);
  galaxy.add(halo);

  /* ---------- 轨道与行星 ---------- */
  const planets = [];   // { site, group, mesh, glow, hit, ring, ringMat, angle, ringBaseOpacity }
  const hitTargets = [star];

  sites.forEach((site) => {
    const incl = new THREE.Group();
    incl.rotation.x = THREE.MathUtils.degToRad(site.incl);
    incl.rotation.z = THREE.MathUtils.degToRad(site.incl * 0.45);
    galaxy.add(incl);

    // 轨道环
    const pts = new THREE.EllipseCurve(0, 0, site.orbit, site.orbit).getPoints(160);
    const ringGeo = new THREE.BufferGeometry().setFromPoints(
      pts.map(p => new THREE.Vector3(p.x, 0, p.y))
    );
    const ringMat = new THREE.LineBasicMaterial({
      color: 0xf2f0ea, transparent: true, opacity: 0.11,
    });
    const ring = new THREE.LineLoop(ringGeo, ringMat);
    incl.add(ring);

    // 行星组
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 48),
      new THREE.MeshStandardMaterial({
        color: 0x14161e, roughness: 0.62, metalness: 0.18,
        emissive: new THREE.Color(site.hue), emissiveIntensity: 0.5,
      })
    );
    mesh.scale.setScalar(site.size);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowMap, color: new THREE.Color(site.hue),
      transparent: true, opacity: 0.42, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    glow.scale.setScalar(site.size * 5.2);

    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 12),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
    );
    hit.scale.setScalar(Math.max(site.size * 2.3, 1.1));
    hit.userData.siteId = site.id;

    group.add(mesh, glow, hit);
    incl.add(group);

    const p = {
      site, group, mesh, glow, hit, ring, ringMat,
      ringBaseOpacity: ringMat.opacity,
      angle: site.phase,
      speedFactor: 1,
      baseEmissive: 0.5,
      baseGlow: 0.42,
    };
    planets.push(p);
    hitTargets.push(hit);
  });

  /* ---------- 星尘 ---------- */
  const DUST = COARSE ? 900 : 2200;
  const dustGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(DUST * 3);
    const size = new Float32Array(DUST);
    const seed = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      const r = 26 + Math.pow(Math.random(), 0.7) * 70;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.55;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      size[i] = 0.5 + Math.random() * 1.5;
      seed[i] = Math.random();
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  }
  const dustUniforms = { uTime: { value: 0 } };
  const dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({
    uniforms: dustUniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aSize; attribute float aSeed;
      uniform float uTime; varying float vTw;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (300.0 / -mv.z);
        vTw = 0.5 + 0.5 * sin(uTime * (0.5 + aSeed*1.6) + aSeed*43.0);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      varying float vTw;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.06, d) * (0.25 + 0.75*vTw);
        gl_FragColor = vec4(vec3(0.92, 0.9, 0.84), a * 0.85); }`,
  }));
  scene.add(dust);

  /* ---------- 后处理 ---------- */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.72, 0.85, 0.72);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ---------- 相机 Rig ---------- */
  const camBase = new THREE.Vector3(0, 6.2, 26);   // gsap 补间对象
  const lookTarget = new THREE.Vector3(0, 0, 0);
  const parallax = new THREE.Vector2(0, 0);
  const pointer = new THREE.Vector2(-10, -10);      // NDC
  let pointerClient = { x: 0, y: 0 };
  let parallaxAmp = COARSE ? 0 : 1;

  // 全景机位随宽高比后撤，窄屏不致恒星满屏
  const baseZ = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const a = w / h;
    return a < 0.7 ? 42 : a < 1.05 ? 34 : 28;
  };

  /* ---------- 拖拽与拾取状态 ---------- */
  let rotY = 0, rotTargetY = 0, rotVel = 0, rotTargetX = 0;
  let dragging = false, dragMoved = 0, lastX = 0, lastY = 0;
  let hoveredId = null;
  let focused = null;
  const raycaster = new THREE.Raycaster();

  const api = {};

  /* ---------- 悬停视觉 ---------- */
  function applyHover(p, on) {
    if (!window.gsap) return;
    if (p === 'star') {
      gsap.to(halo.material, { opacity: on ? 0.85 : 0.5, duration: 0.5, ease: 'power2.out' });
      gsap.to(star.scale, { x: on ? 1.06 : 1, y: on ? 1.06 : 1, z: on ? 1.06 : 1, duration: 0.5, ease: 'power2.out' });
      return;
    }
    gsap.to(p.group.scale, {
      x: on ? 1.32 : 1, y: on ? 1.32 : 1, z: on ? 1.32 : 1,
      duration: 0.55, ease: 'back.out(2)',
    });
    gsap.to(p.mesh.material, { emissiveIntensity: on ? 1.5 : (focused && focused !== p.site.id ? 0.16 : p.baseEmissive), duration: 0.45 });
    gsap.to(p.glow.material, { opacity: on ? 0.85 : (focused && focused !== p.site.id ? 0.1 : p.baseGlow), duration: 0.45 });
    gsap.to(p.ringMat, { opacity: on ? p.ringBaseOpacity * 2.4 : (focused && focused !== p.site.id ? p.ringBaseOpacity * 0.4 : p.ringBaseOpacity), duration: 0.45 });
  }

  function setHovered(id, client) {
    if (id === hoveredId) return;
    const prev = planets.find(p => p.site.id === hoveredId);
    if (prev) applyHover(prev, false);
    if (hoveredId === 'star') applyHover('star', false);
    hoveredId = id;
    if (id) {
      if (id === 'star') applyHover('star', true);
      else applyHover(planets.find(p => p.site.id === id), true);
    }
    document.body.classList.toggle('can-pick', !!id);
    callbacks.onHover(id, client ? client.x : 0, client ? client.y : 0);
  }

  /* ---------- Raycast ---------- */
  function raycast() {
    if (focused || pointer.x < -5) return;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(hitTargets, false)[0];
    if (hit) {
      const id = hit.object === star ? 'star' : hit.object.userData.siteId;
      setHovered(id, pointerClient);
    } else if (hoveredId) {
      setHovered(null);
    }
  }

  /* ---------- 聚焦 / 全景 ---------- */
  let followId = null;

  api.focusSite = (id) => {
    if (!window.gsap) return;
    const p = planets.find(p => p.site.id === id);
    if (!p) return;
    focused = id;
    followId = id;
    setHovered(null);
    gsap.killTweensOf(camBase);
    gsap.killTweensOf(lookTarget);

    // 冻结该行星的公转，其余压暗
    planets.forEach(q => {
      const dim = q.site.id !== id;
      gsap.to(q, { speedFactor: dim ? 1 : 0, duration: 0.6, ease: 'power2.out' });
      gsap.to(q.mesh.material, { emissiveIntensity: dim ? 0.16 : 0.85, duration: 0.7 });
      gsap.to(q.glow.material, { opacity: dim ? 0.1 : 0.62, duration: 0.7 });
      gsap.to(q.ringMat, { opacity: dim ? q.ringBaseOpacity * 0.38 : q.ringBaseOpacity * 1.6, duration: 0.7 });
    });
    gsap.to(halo.material, { opacity: 0.3, duration: 0.8 });
  };

  api.overview = () => {
    if (!window.gsap) return;
    focused = null;
    followId = null;
    gsap.killTweensOf(camBase);
    gsap.killTweensOf(lookTarget);
    planets.forEach(q => {
      gsap.to(q, { speedFactor: 1, duration: 1.0, ease: 'power2.inOut' });
      gsap.to(q.mesh.material, { emissiveIntensity: q.baseEmissive, duration: 0.8 });
      gsap.to(q.glow.material, { opacity: q.baseGlow, duration: 0.8 });
      gsap.to(q.ringMat, { opacity: q.ringBaseOpacity, duration: 0.8 });
    });
    gsap.to(halo.material, { opacity: 0.5, duration: 0.8 });
    gsap.to(camBase, { x: 0, y: 6.2, z: baseZ(), duration: 1.7, ease: 'power3.inOut' });
    gsap.to(lookTarget, { x: 0, y: 0, z: 0, duration: 1.7, ease: 'power3.inOut' });
  };

  /* ---------- 开场 ---------- */
  api.playIntro = () => new Promise((resolve) => {
    if (!window.gsap || REDUCED || window.__orbitFrozen) {
      camBase.set(0, 6.2, baseZ());
      resolve();
      return;
    }
    // 初始状态：远景、轨道收缩、行星未生、恒星未点燃
    camBase.set(0, 2.6, 62);
    galaxy.rotation.y = -0.55;
    halo.material.opacity = 0;
    planets.forEach(p => {
      p.group.scale.setScalar(0.001);
      p.ring.scale.setScalar(0.55);
      p.ringMat.opacity = 0;
      p.glow.material.opacity = 0;
      p.mesh.material.emissiveIntensity = 0;
    });

    const tl = gsap.timeline({ onComplete: resolve });
    tl.to(camBase, { x: 0, y: 6.2, z: baseZ(), duration: 3.0, ease: 'power2.inOut' }, 0)
      .to(galaxy.rotation, { y: 0, duration: 3.0, ease: 'power2.inOut' }, 0)
      .to(halo.material, { opacity: 0.5, duration: 1.6, ease: 'power2.in' }, 0.15)
      .to(starUniforms.uTime, { value: 2.2, duration: 2.2, ease: 'none' }, 0);
    planets.forEach((p, i) => {
      tl.to(p.ring.scale, { x: 1, y: 1, z: 1, duration: 1.3, ease: 'power3.out' }, 0.55 + i * 0.13)
        .to(p.ringMat, { opacity: p.ringBaseOpacity, duration: 1.0, ease: 'power2.out' }, 0.7 + i * 0.13)
        .to(p.group.scale, { x: 1, y: 1, z: 1, duration: 0.85, ease: 'back.out(1.6)' }, 0.95 + i * 0.13)
        .to(p.mesh.material, { emissiveIntensity: p.baseEmissive, duration: 0.9, ease: 'power2.out' }, 1.05 + i * 0.13)
        .to(p.glow.material, { opacity: p.baseGlow, duration: 0.9, ease: 'power2.out' }, 1.05 + i * 0.13);
    });

    // 保险丝：RAF 中途冻结导致时间线卡死时，直接落到终态
    setTimeout(() => { if (tl.progress() < 0.02) tl.progress(1); }, 5000);
  });

  /* ---------- 指针事件 ---------- */
  const el = renderer.domElement;
  el.addEventListener('pointermove', (e) => {
    pointerClient = { x: e.clientX, y: e.clientY };
    const r = el.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      dragMoved += Math.abs(dx) + Math.abs(dy);
      rotTargetY += dx * 0.0042;
      rotVel = dx * 0.0042;
      rotTargetX = THREE.MathUtils.clamp((rotTargetX || 0) + dy * 0.0012, -0.12, 0.12);
      lastX = e.clientX; lastY = e.clientY;
    }
  });

  el.addEventListener('pointerdown', (e) => {
    dragging = true; dragMoved = 0; lastX = e.clientX; lastY = e.clientY;
    container.classList.add('dragging');
  });
  window.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    container.classList.remove('dragging');
    if (dragMoved < 6 && !focused) {
      // 一次性拾取：兼容触屏（无 hover 预判）与鼠标
      const r = el.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(hitTargets, false)[0];
      if (hit) callbacks.onPick(hit.object === star ? 'star' : hit.object.userData.siteId);
    }
  });
  el.addEventListener('pointerleave', () => {
    pointer.set(-10, -10);
    if (hoveredId) setHovered(null);
  });

  /* ---------- 主循环 ---------- */
  const clock = new THREE.Clock();
  let time = 0;
  const tmpW = new THREE.Vector3();
  const tmpD = new THREE.Vector3();

  function tick() {
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    time += dt;

    starUniforms.uTime.value = time;
    dustUniforms.uTime.value = time;

    // 行星公转（内快外慢；聚焦行星被冻结）
    planets.forEach(p => {
      p.angle += p.site.speed * p.speedFactor * dt;
      p.group.position.set(Math.cos(p.angle) * p.site.orbit, 0, Math.sin(p.angle) * p.site.orbit);
    });

    // 星系自转 + 拖拽惯性
    if (!focused && !dragging && !REDUCED) rotTargetY += 0.018 * dt;
    if (!dragging) { rotTargetY += rotVel; rotVel *= 0.94; }
    rotY += (rotTargetY - rotY) * 0.07;
    galaxy.rotation.y = rotY;
    galaxy.rotation.x += ((rotTargetX) - galaxy.rotation.x) * 0.05;

    // 星尘慢漂
    dust.rotation.y += dt * 0.004;

    // 相机：聚焦时实时追逐目标行星（避免行星公转导致构图过时）
    if (followId) {
      const p = planets.find(q => q.site.id === followId);
      if (p) {
        p.group.getWorldPosition(tmpW);
        tmpD.copy(tmpW).normalize().multiplyScalar(6.2).add(tmpW);
        tmpD.y += 2.0;
        camBase.lerp(tmpD, 1 - Math.exp(-rawDt * 3.4));
        lookTarget.lerp(tmpW, 1 - Math.exp(-rawDt * 4.5));
      }
    }

    // 相机：基准位 + 视差
    parallax.x += ((pointer.x > -5 ? pointer.x : 0) * 1.1 - parallax.x) * 0.04 * parallaxAmp;
    parallax.y += ((pointer.y > -5 ? pointer.y : 0) * 0.55 - parallax.y) * 0.04 * parallaxAmp;
    camera.position.set(camBase.x + parallax.x, camBase.y + parallax.y, camBase.z);
    camera.lookAt(lookTarget);

    raycast();
    composer.render();
  }

  // RAF 冻结降级（被遮挡窗口 / 无头环境）：持续健康检查，冻结时用定时器补帧
  let usingFallback = false;
  let lastRafAt = performance.now();
  function loop() {
    requestAnimationFrame(loop);
    lastRafAt = performance.now();
    tick();
  }
  requestAnimationFrame(loop);
  setInterval(() => {
    if (!usingFallback && performance.now() - lastRafAt > 500) {
      usingFallback = true;
      window.__orbitFrozen = true;
    }
    if (usingFallback && performance.now() - lastRafAt > 150) tick();
  }, 120);

  /* ---------- 尺寸 ---------- */
  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.resolution.set(w, h);
    if (!focused) camBase.z = baseZ();
  }
  window.addEventListener('resize', resize);
  resize();

  // 索引悬停 → 3D 同步（tooltip 出现在索引列表附近）
  api.syncHover = (id) => {
    if (focused) return;
    setHovered(id, id ? { x: window.innerWidth - 110, y: window.innerHeight - 170 } : undefined);
  };

  api.isReduced = REDUCED;
  return api;
}
