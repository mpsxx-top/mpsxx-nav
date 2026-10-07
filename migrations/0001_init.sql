-- ============================================================
-- 星轨 ORBIT · mpsxx.top 内容库（Cloudflare D1）
-- 执行：wrangler d1 execute orbit-content --remote --file=migrations/0001_init.sql
-- 说明：
--   * sites.status 语义为 online | offline | auto
--     auto = 由 Worker 的在线探测结果自动决定（探测无数据时按 online 处理）
--   * 种子数据 = 迁移前 js/data.js 里的全部内容，保证上线瞬间页面与旧版一致
--   * 编号 no 由 Worker 在每次写入时按拖拽顺序重新生成，这里只是初始值
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- 表结构 ----------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id         TEXT PRIMARY KEY,
  sort_index INTEGER NOT NULL DEFAULT 0,
  no         TEXT,
  zh         TEXT NOT NULL,
  en         TEXT,
  kind       TEXT,
  domain     TEXT NOT NULL,
  alt        TEXT,
  url        TEXT NOT NULL,
  desc       TEXT,
  tags       TEXT NOT NULL DEFAULT '[]',
  status     TEXT NOT NULL DEFAULT 'auto',
  hue        TEXT,
  size       REAL,
  orbit      REAL,
  speed      REAL,
  incl       REAL,
  phase      REAL
);
CREATE INDEX IF NOT EXISTS idx_sites_sort ON sites (sort_index);

CREATE TABLE IF NOT EXISTS retired (
  word       TEXT PRIMARY KEY,
  sort_index INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  author     TEXT,
  note       TEXT,
  snapshot   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probes (
  domain      TEXT PRIMARY KEY,
  ok          INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  ms          INTEGER,
  checked_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- 种子数据：主星与页面级文案 ----------

INSERT INTO meta (key, value) VALUES
  ('star_domain',  'mpsxx.top'),
  ('star_zh',      '主星'),
  ('star_desc',    '这片星系的引力中心。主站尚在建设中 —— 你正在看的这页星图，就是它现在的样子。'),
  ('page_title',   '星轨 ORBIT · mpsxx.top 子域名星系'),
  ('page_desc',    '一个域名的私人星系 —— mpsxx.top 全部子域名的三维导航。'),
  ('page_color',   '#05060A')
ON CONFLICT(key) DO NOTHING;

-- ---------- 种子数据：七颗行星 ----------

INSERT INTO sites (id, sort_index, no, zh, en, kind, domain, alt, url, desc, tags, status, hue, size, orbit, speed, incl, phase) VALUES
  ('blog', 0, '01', '喵思录', 'MEOW ARCHIVE', '个人博客', 'blog.mpsxx.top', NULL, 'https://blog.mpsxx.top',
   '「喵」思录 —— 技术梳理、心得体会与轻食菜谱，附年终总结、工具箱，和一台常驻的音乐台。',
   '["写作","技术","轻食"]', 'auto', '#E8C87E', 0.46, 8.0, 0.16, 3.2, 0.4),

  ('blogs', 1, '02', '新博客', 'NEW BLOG', '个人博客 · 新站', 'blogs.mpsxx.top', NULL, 'https://blogs.mpsxx.top',
   '「喵」思录的下一站 —— 站长的新博客，正在持续写作中。',
   '["写作","新站"]', 'auto', '#C8E89E', 0.44, 10.1, 0.135, -4.4, 1.7),

  ('img', 2, '03', '随机图鉴', 'RANDOM IMAGERY', '图片 API', 'img.mpsxx.top', NULL, 'https://img.mpsxx.top',
   '随机图片接口 —— 访问 /api 即返回一张随机图片，支持 json / raw 两种输出，源码开源在 GitHub。',
   '["API","开源","图床"]', 'auto', '#8AB8E0', 0.38, 12.2, 0.115, 5.1, 2.9),

  ('food', 3, '04', '冰箱管家', 'FRIDGE AI', '食材管理', 'food.mpsxx.top', NULL, 'https://food.mpsxx.top',
   'FridgeAI 智能食材管家 —— 记录冰箱里的每一份食材，让新鲜被看见、被记住、被吃掉。',
   '["AI","生活","工具"]', 'auto', '#7ED8B8', 0.42, 14.3, 0.1, -3.6, 4.1),

  ('bot', 4, '05', '云端助理', 'CHAT PILOT', '机器人云管理', 'bot.mpsxx.top', NULL, 'https://bot.mpsxx.top',
   '「聊天助理 · 云管理」—— 管理多账号登录态、配置 LLM 接口、调度消息收发与长期记忆的云端控制台。',
   '["LLM","机器人","调度"]', 'auto', '#A88ED8', 0.5, 16.4, 0.088, 6.2, 5.2),

  ('markbook', 5, '06', '收藏星簿', 'MARKBOOK', '书签收藏', 'markbook.mpsxx.top', NULL, 'https://markbook.mpsxx.top',
   '一枚安静的书签收藏簿，整理散落各处的星图坐标。目前源站无响应，暂时离线维护中。',
   '["书签","收藏"]', 'auto', '#D88EA8', 0.36, 18.5, 0.078, -5.4, 0.9),

  ('cf', 6, '07', '边缘服务台', 'EDGE WORKS', 'Workers 服务', 'cf.mpsxx.top', 'api.cf.mpsxx.top', 'https://cf.mpsxx.top',
   '跑在 Cloudflare Workers 上的小服务集合，附 api.cf 开放接口。当前源站无响应，等待重新点火。',
   '["Workers","Edge","API"]', 'auto', '#E89E6E', 0.4, 20.6, 0.068, 4.0, 3.4)
ON CONFLICT(id) DO NOTHING;

-- ---------- 种子数据：已退役子域名 ----------

INSERT INTO retired (word, sort_index) VALUES
  ('memos', 0), ('twikoo', 1), ('umami', 2), ('meting', 3), ('roomgame', 4),
  ('tool', 5), ('tools-docx', 6), ('friend', 7), ('jx', 8), ('cc', 9)
ON CONFLICT(word) DO NOTHING;

-- ---------- 初始状态 ----------

INSERT INTO settings (key, value) VALUES
  ('draft_updated_at', '0'),
  ('probe_checked_at', '0'),
  ('published_revision_id', '')
ON CONFLICT(key) DO NOTHING;

-- ---------- 初始版本：把种子内容落成第 1 个「已发布」版本 ----------
-- 公开接口只读「已发布版本」，所以必须有这条 revision，否则公网取不到内容。
-- 这样草稿与线上彻底分离：任何时候改草稿都不会影响公网。

INSERT INTO revisions (created_at, author, note, snapshot)
SELECT
  datetime('now'),
  'migration',
  '初始内容（导入自 js/data.js）',
  json_object(
    'star', json_object(
      'domain', (SELECT value FROM meta WHERE key = 'star_domain'),
      'zh',     (SELECT value FROM meta WHERE key = 'star_zh'),
      'desc',   (SELECT value FROM meta WHERE key = 'star_desc')
    ),
    'page', json_object(
      'title',       (SELECT value FROM meta WHERE key = 'page_title'),
      'description', (SELECT value FROM meta WHERE key = 'page_desc'),
      'color',       (SELECT value FROM meta WHERE key = 'page_color')
    ),
    'sites', (
      SELECT json_group_array(json_object(
        'id', id, 'no', no, 'zh', zh, 'en', en, 'kind', kind, 'domain', domain, 'alt', alt,
        'url', url, 'desc', desc, 'tags', json(tags), 'status', status, 'hue', hue,
        'size', size, 'orbit', orbit, 'speed', speed, 'incl', incl, 'phase', phase
      ))
      FROM (SELECT * FROM sites ORDER BY sort_index ASC)
    ),
    'retired', (
      SELECT json_group_array(word) FROM (SELECT word FROM retired ORDER BY sort_index ASC)
    )
  )
WHERE NOT EXISTS (SELECT 1 FROM revisions);

UPDATE settings
SET value = COALESCE((SELECT CAST(id AS TEXT) FROM revisions WHERE id IS NOT NULL ORDER BY id ASC LIMIT 1), '')
WHERE key = 'published_revision_id';
