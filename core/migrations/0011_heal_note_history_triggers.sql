-- migration 0011: 治愈真实库上缺失的 0003 笔记历史触发器(神圣保证补齐)。
--
-- 背景(踩坑史的又一例,见 [[ys-notebook-migration-trap]]):0003 的两个历史保全触发器
-- `trg_note_archive_on_edit` / `trg_note_revision_immutable` 在新建库(测试/e2e)上存在,
-- 但在用户真实库上**缺失**——0003 文件应是在真实库已越过 version 3 之后才追加这两个
-- 触发器的,迁移每版只跑一次,改已应用文件不会回填。后果:真实库上 note_revisions 表在、
-- 触发器不在,编辑想法时旧版本不会被归档,「不可变性是历史级」这条本应是仅存的硬保证
-- 在真机上一直失效。fresh-DB 测试照不出(它们有触发器)。
--
-- 产品重定位为「纯人工」后,note 历史(0003)是我们刻意保留的唯一存储层硬保证,因此必须
-- 在所有库上都真实生效。这里用 CREATE TRIGGER IF NOT EXISTS 幂等补齐:
--   * 真实库(缺失)-> 创建,恢复历史保全;
--   * 新建库(已存在)-> no-op,绝不重复或冲突。
-- 触发器体与 0003 逐字一致(单一真相:若将来改历史语义,两处都要改——但 0003 不会再改)。

-- 编辑前自动归档旧版本:任何对 notes.content 的真实改动先快照旧文。
CREATE TRIGGER IF NOT EXISTS trg_note_archive_on_edit
BEFORE UPDATE OF content ON notes
FOR EACH ROW
WHEN NEW.content <> OLD.content
BEGIN
    INSERT INTO note_revisions (note_id, content, archived_at)
    VALUES (OLD.id, OLD.content, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- 历史版本写一次不可改写(fail-fast)。
CREATE TRIGGER IF NOT EXISTS trg_note_revision_immutable
BEFORE UPDATE ON note_revisions
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, '历史版本不可修改(note_revisions 只追加)');
END;
