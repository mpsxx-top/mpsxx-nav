-- 行星级「在线探测」开关：probe = 1 参与在线探测，0 不探测（例如已卸载/废弃的子域名）。
-- 说明：
--   * 已有部署（0001 已执行过）执行本迁移即可补列并关闭 bot 的探测；
--   * 全新部署按 0001 -> 0002 顺序执行即可。
ALTER TABLE sites ADD COLUMN probe INTEGER NOT NULL DEFAULT 1;

-- bot.mpsxx.top 已卸载，关闭其在线探测
UPDATE sites SET probe = 0 WHERE id = 'bot';