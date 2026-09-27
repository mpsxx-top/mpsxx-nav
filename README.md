# 星轨 ORBIT · mpsxx.top 子域名星系导航页

以 Three.js 构建的单页导航：主站是恒星，七个子域名是绕行公转的行星。
纯静态、零构建，可直接部署到 GitHub Pages / Vercel / Cloudflare Pages。

## 本地预览

```bash
cd mpsxx-nav
python -m http.server 8000
# 打开 http://localhost:8000
```

> 需要通过 HTTP 访问（ES Module 不支持 file:// 直开）。

## 修改文案 / 增删行星

所有内容集中在 `js/data.js`：站名、域名、描述、标签、在线状态、
专属色相、轨道半径与公转速度。改这一个文件即可，场景自动适配。

- `status: 'online' | 'offline'` —— 控制档案卡与索引的离线态提示；
  离线站点依旧可以点击跳转（按钮文案变为「仍要访问 ↗」），不会阻断访问
- `orbit` 越小越靠近恒星，`speed` 单位为弧度/秒

## 目录结构

```
mpsxx-nav/
├── index.html        结构 / 字体 / importmap / CDN 看门狗
├── css/style.css     设计系统（色彩、字体、覆盖层 UI、响应式）
└── js/
    ├── data.js       全部内容数据（唯一需要日常改动的文件）
    ├── scene.js      Three.js 场景：恒星 shader、轨道、行星、星尘、bloom、相机 Rig
    └── ui.js         加载序列、索引、档案卡、键盘导航、时钟
```

## 交互

| 操作 | 效果 |
|---|---|
| 悬停行星 / 索引 | 双向联动高亮 + tooltip |
| 点击行星 / 索引 | 相机飞行聚焦，滑出玻璃档案卡 |
| 拖动画布 | 旋转星系（带惯性） |
| ← / → | 切换上一颗 / 下一颗行星 |
| ENTER | 访问当前聚焦站点 |
| ESC | 返回全景 |

## 技术说明

- 依赖经 jsDelivr CDN 引入：`three@0.170`（importmap）+ `gsap 3`。
  国内若加载缓慢，可把 `index.html` 中两处 CDN 换成镜像，或将依赖下载到
  `vendor/` 后改写 importmap 指向本地。
- Google Fonts 加载失败会自动回退系统字体，不破版；
  国内可把字体链接换为 `fonts.loli.net` 镜像。
- 性能：DPR 上限 2、触屏设备星尘减半并关闭视差、
  `prefers-reduced-motion` 跳过开场动画、无 WebGL 时 2D 索引仍完整可用。
- 健壮性：内置 RAF 冻结自愈 —— 当页面处于被遮挡窗口 / 无头环境导致
  requestAnimationFrame 停摆时，自动切换定时器补帧，并把动画时间线直接落到终态，
  保证任何环境下页面都可达最终可读状态。
