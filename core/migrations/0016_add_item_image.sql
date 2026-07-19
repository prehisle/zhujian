-- migration 0016: 给条目挂多张图片(item_image)+ 编号高水位(item_image_counter)。
--
-- 需求:灵感 / 任务的纯文字正文有时说不清(想贴张截图、示意图、参考图)。一条可配多图;
-- 图带编号「图N」,正文里可引用(如「见图2」)。
--
-- 设计(贴合单实体 + 删除主权分级 + 不可变铁律,codex 评审定稿):
--   * 图单独存一张 item_image,1:N 挂 items —— **不动 items 表**(content 仍是纯文本,
--     编辑历史触发器 / 删除守护一律不受影响);
--   * BLOB 入库,而非「存盘 + 路径」。理由是删除主权可**整套复用**,一行新的文件生命周期
--     管理都不必写:
--       - 软删进回收站:只盖 items.archived_at(并不真 DELETE items 行,FK action 不触发)
--         → 图随条目留存,restore 回原 stage 时图一并带回;
--       - 硬删 / 彻底删:真 DELETE items 行 → ON DELETE CASCADE 连带删掉它的图与计数行。
--     代价是库变大,个人量级可接受;真嫌大以后再换存盘模式(那才需要自管孤儿文件)。
--   * seq = 「图N」的 N,**每条目内从 1 起、单调、永不复用**。关键:编号是图的「身份证」不是
--     「排第几」,删掉「图2」后剩下显示「图1、图3」——**留洞、不重排**,正文「见图2」永远咬定
--     原来那张图,不静默改指别张。这是历史级不可变 / fail-fast 的延伸。
--       ‼ 永不复用**不能**靠命令层 MAX(seq)+1:删掉最高编号(图3)后再加图,MAX+1 又给 3,
--         会让一张新图冒用旧编号。故用 item_image_counter 存每条目的**历史最大编号**(高水位),
--         删图不回退;命令层在同一事务里 last_seq+1 取号再插 item_image。
--   * 图只增删、不改(换图 = 删旧加新)→ trg_item_image_immutable 禁 UPDATE(同 item_revisions
--     的 immutable 守);不进 item_revisions,与文字编辑历史正交。
--
-- 类型/取值在 schema 层钉死(沿用 items 用 typeof(...) 防 SQLite 弱类型的惯例):seq 整数 ≥1、
-- data 非空 blob、mime 限图片白名单(撞到白名单外 → 插入 ABORT,fail-fast,绝不静默收下)。
-- created_at 不单独加格式 CHECK —— 与 items.created_at 一致由 now_iso() 统一产出,不在此开先例。
--
-- 纯新增表,不改任何已应用迁移(见 memory migration-trap),真实库与 fresh DB 不分叉。FK 在连接
-- 层已开(db.rs open 时 enforce),故 CASCADE 在真 DELETE 时生效,本迁移无需动 foreign_keys pragma。
-- 真实库迁移后可核验:PRAGMA foreign_key_check; PRAGMA integrity_check;(此前数据零变动:加表而已。)

BEGIN;

-- 每条目「历史最大编号」高水位:删图不回退,保证 seq 永不复用。
CREATE TABLE item_image_counter (
    item_id   TEXT NOT NULL PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    last_seq  INTEGER NOT NULL CHECK (typeof(last_seq) = 'integer' AND last_seq >= 0)
);

CREATE TABLE item_image (
    id          TEXT NOT NULL PRIMARY KEY,               -- ULID
    item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 1),  -- 「图N」的 N
    data        BLOB NOT NULL CHECK (typeof(data) = 'blob' AND length(data) > 0),
    mime        TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
    created_at  TEXT NOT NULL,
    -- 同一条目内编号唯一(撞号 ABORT,不静默合并)。该 UNIQUE 自带 (item_id, seq) 索引,
    -- 直接服务「列出某条目的图、按 seq 升序」查询,无需额外索引。
    UNIQUE (item_id, seq)
);

-- 图只增删不改:旧字节不被覆盖而不留痕(同 item_revisions 的 immutable 守,fail-fast)。
CREATE TRIGGER trg_item_image_immutable
BEFORE UPDATE ON item_image
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'item_image 只追加 / 删除,不可修改(换图请删旧加新)');
END;

COMMIT;
