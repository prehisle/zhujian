-- migration 0012: 想法↔待办 一对一(把 task_note 收成 1:1)。
--
-- 产品模型扶正:一条想法「转换」为一个待办是换身份、不是生副本;多条相关待办的归集靠
-- 主题(task.topic_id),而非把多个待办绑在同一条想法上。此前 task_note 是多对多
-- (PK(task_id,note_id),允许一条 note 多 task / 一个 task 多 note)。这里收成严格 1:1:
--   * task_id PRIMARY KEY —— 一个待办至多一条来源想法;
--   * note_id UNIQUE      —— 一条想法至多一个待办。
-- 命令层也有 1:1 守卫(promote_to_task 拒绝给已有待办的想法再转),本约束是存储层兜底,
-- 让后续代码不必到处防多对多(维护性)。
--
-- 数据迁移:绝不删 tasks/notes,只裁剪关系。真实库已是干净 1:1(已核:无 note 多 task、
-- 无 task 多 note),零裁剪。为稳健仍做确定性去重:只保留同时是其 note 与其 task 的最小
-- rowid 的链接;被裁掉的链接使对应 task 变成无来源的 standalone task(仍保留,note_count=0)。
--
-- 同 0010:PRAGMA foreign_keys=OFF 必须在 BEGIN 之前(事务内改该 pragma 是 no-op);
-- task_note 的 FK 按表名解析,DROP+RENAME 后仍有效。真实库迁移后须跑 foreign_key_check /
-- integrity_check 验证。DROP TABLE 连带删除旧表的索引(0001 的 idx_task_note_note_id),
-- 新表的 note_id UNIQUE 自带索引覆盖按 note 查询,无需重建。

PRAGMA foreign_keys = OFF;

BEGIN;

DROP TABLE IF EXISTS task_note_new;

CREATE TABLE task_note_new (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE
);

-- Keep only links that are the min-rowid for BOTH their note and their task, so the
-- result has no duplicate note_id and no duplicate task_id (a deterministic 1:1 subset).
-- On the already-1:1 real data every row qualifies.
INSERT INTO task_note_new (task_id, note_id)
SELECT task_id, note_id FROM task_note tn
WHERE tn.rowid = (SELECT MIN(rowid) FROM task_note WHERE note_id = tn.note_id)
  AND tn.rowid = (SELECT MIN(rowid) FROM task_note WHERE task_id = tn.task_id);

DROP TABLE IF EXISTS task_note;        -- drops old table + its index
ALTER TABLE task_note_new RENAME TO task_note;

COMMIT;

PRAGMA foreign_keys = ON;
