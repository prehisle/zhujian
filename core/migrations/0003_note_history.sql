-- migration 0003: note edit history (append-only, DB-enforced).
--
-- Notes were content-immutable at the row level. The new invariant keeps the same
-- spirit but moves it from the row to the history: the user may edit a note's
-- content, but every superseded version is preserved — so the original and all
-- prior versions are never lost. Like the 0002 task guards, this is enforced at
-- the storage layer, not just in app code:
--   * any real change to notes.content auto-archives the prior version first, so
--     no code path can overwrite content without keeping history;
--   * archived revisions are write-once (a past version can never be rewritten).
-- `notes.content` is the current text; `note_revisions` is the append-only trail.
-- AI never edits content — editing is a user-only action.
--
-- Note on deletes: note_revisions cascades when its note is deleted (only an
-- inbox note with no derived links is ever deletable — see repo::delete_inbox_note
-- — so this just cleans up a discarded draft's history). No app path deletes an
-- individual revision; a BEFORE DELETE guard can't tell a cascade from a direct
-- delete, so we deliberately don't add one rather than break legitimate cleanup.

CREATE TABLE note_revisions (
    revision_id INTEGER PRIMARY KEY,  -- surrogate rowid; nothing references it
    note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,        -- the superseded text (what the note said before this edit)
    archived_at TEXT NOT NULL         -- when this version stopped being current (the edit time)
);

CREATE INDEX idx_note_revisions_note_id ON note_revisions (note_id, revision_id);

-- Auto-archive: any real change to notes.content first snapshots the old text.
-- This makes "history is append-only" impossible to bypass from any code path,
-- and lets the app simply UPDATE content (the archiving is the database's job).
CREATE TRIGGER trg_note_archive_on_edit
BEFORE UPDATE OF content ON notes
FOR EACH ROW
WHEN NEW.content <> OLD.content
BEGIN
    INSERT INTO note_revisions (note_id, content, archived_at)
    VALUES (OLD.id, OLD.content, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Revisions are write-once: a past version may never be rewritten (fail-fast).
CREATE TRIGGER trg_note_revision_immutable
BEFORE UPDATE ON note_revisions
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, '历史版本不可修改(note_revisions 只追加)');
END;
