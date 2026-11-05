// android/src/panes.ts(回收站 / 归档册 / 搜索三面)的文案分片。
import { defineMessages } from "./entry";

export const panes = defineMessages({
  "panes.loading": { zh: "读取中…", en: "Loading…" },
  "panes.kindIdea": { zh: "随记", en: "Note" },
  "panes.kindDoc": { zh: "长文", en: "Long-form" },
  // 159 / W3 Q12(WM-29):回收站里任务的小章叫「任务」(此前印列名「待办」,同一张在搜索里叫「任务」)。
  "panes.kindTask": { zh: "任务", en: "Task" },
  "panes.deletedAt": { zh: "删于 {when}", en: "Deleted {when}" },
  "panes.restore": { zh: "还原", en: "Restore" },
  "panes.purge": { zh: "彻底删除", en: "Delete forever" },
  "panes.trashLoadFailed": { zh: "回收站读取失败:{error}", en: "Could not load Trash: {error}" },
  "panes.trashEmpty": { zh: "回收站是空的。", en: "Trash is empty." },
  // 回收站里的「已删配图」一节(用户面 149)。
  "panes.imagesTitle": { zh: "已删配图", en: "Deleted images" },
  "panes.imageRow": { zh: "图{n} · 删于 {when}", en: "Image {n} · deleted {when}" },
  "panes.imageNoText": { zh: "(没有文字)", en: "(no text)" },
  "panes.purgeImageQ": { zh: "彻底删除这张图?无法恢复", en: "Delete this image forever? It cannot be recovered" },
  "panes.restoredImage": { zh: "已还原到原编号", en: "Restored to its original number" },
  "panes.emptyTrashYes": { zh: "清空", en: "Empty" },
  // 159(W3 走查 Q1):回收站一页分「随记」「任务」两段,各数各的、各自清空;确认句说清清的是哪一段、几条、几张配图。
  "panes.secIdeas": { zh: "随记", en: "Notes" },
  "panes.secTasks": { zh: "任务", en: "Tasks" },
  "panes.secIdeasEmpty": { zh: "没有删掉的随记。", en: "No deleted notes." },
  "panes.secTasksEmpty": { zh: "没有删掉的任务。", en: "No deleted tasks." },
  "panes.emptyIdeas": { zh: "清空随记回收站", en: "Empty notes trash" },
  "panes.emptyTasks": { zh: "清空任务回收站", en: "Empty tasks trash" },
  "panes.whatNotes": { zh: "{n} 条", en: "{n} {n|item|items}" },
  "panes.whatTasks": { zh: "{n} 个任务", en: "{n} {n|task|tasks}" },
  "panes.whatImages": { zh: "{m} 张配图", en: "{m} {m|image|images}" },
  "panes.whatBoth": { zh: "{items}和 {images}", en: "{items} and {images}" },
  "panes.emptyIdeasQ": { zh: "清空随记回收站?这一段的 {what}将彻底删除、无法恢复(任务那段不动)", en: "Empty the notes trash? {what} here will be deleted forever (the tasks section stays)" },
  "panes.emptyTasksQ": { zh: "清空任务回收站?这一段的 {what}将彻底删除、无法恢复(随记那段不动)", en: "Empty the tasks trash? {what} here will be deleted forever (the notes section stays)" },
  "panes.ideasEmptied": { zh: "随记回收站已清空", en: "Notes trash emptied" },
  "panes.tasksEmptied": { zh: "任务回收站已清空", en: "Tasks trash emptied" },
  // A7(WM-04):彻底删除做完要说话(此前还原、清空都有回执,唯独它一声不吭)。
  "panes.purged": { zh: "已彻底删除", en: "Deleted forever" },
  "panes.purgedImage": { zh: "这张图已彻底删除", en: "Image deleted forever" },
  "panes.restoredTask": { zh: "已还原,在底栏「任务」里", en: "Restored, find it under Tasks" },
  "panes.restoredDoc": { zh: "已还原,在底栏「长文」里", en: "Restored, find it under Long-form" },
  "panes.restoredIdea": { zh: "已还原,在底栏「随记」里", en: "Restored, find it under Notes" },
  // 159(对齐桌面 trash.purgeOneQ / trash.purgeOneImagesQ):写「无法恢复」,带图时说清连带几张。
  "panes.purgeOneQ": { zh: "彻底删除这条?无法恢复", en: "Delete this forever? This cannot be undone" },
  "panes.purgeOneImagesQ": { zh: "彻底删除这条和它的 {m} 张配图?无法恢复", en: "Delete this and its {m} {m|image|images} forever? This cannot be undone" },
  "panes.doneAt": { zh: "完成于 {when}", en: "Done {when}" },
  "panes.sealedAt": { zh: "归档于 {when}", en: "Archived {when}" },
  "panes.unseal": { zh: "取消归档(回到「已完成」)", en: "Unarchive (back to Done)" },
  "panes.unsealed": { zh: "已取消归档,回到「已完成」", en: "Unarchived, back in Done" },
  "panes.sealedEmpty": { zh: "还没有归档的任务。", en: "No archived tasks yet." },
  "panes.sealedLoadFailed": { zh: "归档读取失败:{error}", en: "Could not load Archive: {error}" },
  "panes.hitInbox": { zh: "随记", en: "Note" },
  "panes.hitProcessed": { zh: "随记", en: "Note" },
  "panes.hitDoc": { zh: "长文", en: "Long-form" },
  "panes.hitTask": { zh: "任务", en: "Task" },
  "panes.hitArchived": { zh: "回收站", en: "Trash" },
  "panes.hitSealed": { zh: "归档", en: "Archive" },
  // 159 / W3 Q12:回收站里的命中说清原来是什么(同桌面 search.statusTrashKind)。
  "panes.hitTrashKind": { zh: "回收站 · {kind}", en: "Trash · {kind}" },
  // 159 / W3 A4(WM-06):只在改过的旧版本里命中(同桌面 search.oldVersionHit)。
  "panes.oldVersionHit": { zh: "命中改过的旧版本", en: "Matched an earlier version" },
  // 159 / W3 Q8(WM-15):结果头上写条数(同桌面 search.matchCount)。
  "panes.searchCount": { zh: "{n} 条匹配", en: "{n} {n|match|matches}" },
  // 159 / W3 A20:范围补上长文与任务(同桌面 search.idleHint)。有结果时也挂在条数后面(A4)。
  "panes.searchPrompt": { zh: "随记、长文、任务、归档、回收站和改过的旧版本都一起搜。", en: "Notes, long-form, tasks, the archive, the trash and past versions are all searched." },
  // 159 / W3 A14:从搜索点进回收站 / 归档,那一条在读的这一会儿不在了。
  "panes.locateGone": { zh: "那一条已经不在这里了(可能刚被还原、取消归档或彻底删除)", en: "That item is no longer here (it may have just been restored, unarchived or deleted forever)" },
  "panes.searching": { zh: "搜索中…", en: "Searching…" },
  "panes.searchNoHit": { zh: "没有找到「{q}」。", en: "Nothing found for “{q}”." },
  "panes.searchFailed": { zh: "搜索失败:{error}", en: "Search failed: {error}" },
});
