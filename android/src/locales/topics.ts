// android/src/topics.ts(标签面:排序拖手柄 + 类型编辑 + 改名 + 颜色 + 新建)的文案分片。
import { defineMessages } from "./entry";

export const topics = defineMessages({
  "topics.loading": { zh: "读取中…", en: "Loading…" },
  "topics.loadFailed": { zh: "标签读取失败:{error}", en: "Could not load tags: {error}" },
  "topics.empty": { zh: "还没有标签——点上方「+ 新建标签」直接建一个,或在卡片上打标签。", en: "No tags yet — tap “+ New tag” above to create one, or tag an item on its card." },
  "topics.kindPh": { zh: "类型(如 人名)", en: "Kind (e.g. Person)" },
  "topics.kindSave": { zh: "存", en: "Save" },
  "topics.kindClear": { zh: "清", en: "Clear" },
  "topics.kindAdd": { zh: "+ 类型", en: "+ Kind" },
  "topics.dragHint": { zh: "拖动排序", en: "Drag to reorder" },
  "topics.count": { zh: "{n} 项", en: "{n} {n|item|items}" },
  "topics.kindSet": { zh: "已设类型", en: "Kind set" },
  "topics.kindCleared": { zh: "已清类型", en: "Kind cleared" },
  // 改名(514):点名字进编辑态。⛔ 键空间与桌面独立(两份字典),别去和 src/locales 对齐。
  "topics.renameHint": { zh: "点一下改名", en: "Tap to rename" },
  "topics.renamePh": { zh: "标签名", en: "Tag name" },
  "topics.renameSave": { zh: "存", en: "Save" },
  "topics.renameCancel": { zh: "取消", en: "Cancel" },
  "topics.renamed": { zh: "已改名", en: "Renamed" },
  // 颜色(user-44 第二刀):点行内色点开调色板,点色块即写。
  "topics.colorHint": { zh: "改颜色", en: "Change color" },
  "topics.colorNone": { zh: "无", en: "None" },
  "topics.colorCancel": { zh: "取消", en: "Cancel" },
  "topics.colorSet": { zh: "已改颜色", en: "Color set" },
  "topics.colorCleared": { zh: "已清颜色", en: "Color cleared" },
  // 删除(user-44 第三刀):改名态里的第三枚钮 → 底部两拍确认条。话术要说清
  // core 的真语义 —— 只摘标签、条目内容不动(0 挂载用简版,「0 项」是句空话)。
  "topics.deleteBtn": { zh: "删除", en: "Delete" },
  "topics.deleteQ": { zh: "删除标签「{name}」?{n} 项只摘掉这枚标签,内容不动", en: "Delete tag “{name}”? It comes off {n} {n|item|items} — their content stays." },
  "topics.deleteQEmpty": { zh: "删除标签「{name}」?", en: "Delete tag “{name}”?" },
  "topics.deleteYes": { zh: "删除", en: "Delete" },
  "topics.deleted": { zh: "已删除标签", en: "Tag deleted" },
  // 合并(user-44 第四刀):一对一两击(第一击源、第二击目标)→ 底部两拍确认条。
  // 话术方向要钉死:先点的被并掉、后点的留下。
  "topics.mergeBtn": { zh: "合并", en: "Merge" },
  "topics.mergePickSource": { zh: "点要被并掉的标签", en: "Tap the tag to fold away" },
  "topics.mergePickTarget": { zh: "把「{name}」并入谁?点目标标签", en: "Fold “{name}” into which tag? Tap the target" },
  "topics.mergeCancel": { zh: "取消", en: "Cancel" },
  "topics.mergeQ": { zh: "把「{source}」并入「{target}」?{n} 项转挂「{target}」,「{source}」删除", en: "Fold “{source}” into “{target}”? {n} {n|item|items} will re-tag to “{target}”; “{source}” is deleted." },
  "topics.mergeQEmpty": { zh: "把「{source}」并入「{target}」?「{source}」删除", en: "Fold “{source}” into “{target}”? “{source}” is deleted." },
  "topics.mergeYes": { zh: "并入", en: "Merge" },
  "topics.merged": { zh: "已合并", en: "Merged" },
  // 新建标签(user-44 第二刀):面头按钮开一行输入框,与改名行同形。
  "topics.newBtn": { zh: "+ 新建标签", en: "+ New tag" },
  "topics.newPh": { zh: "标签名", en: "Tag name" },
  "topics.newSave": { zh: "建", en: "Create" },
  "topics.newCancel": { zh: "取消", en: "Cancel" },
  "topics.created": { zh: "已建标签", en: "Tag created" },
  // 展开看名下内容(user-44 第五刀):点计数 → 行下摊开随记 + 任务,纯只读。
  // 可见中文与桌面那份逐字同(「随记 N」/「任务 N」),⛔ 但键空间仍各自独立,别去对齐键名。
  "topics.expandHint": { zh: "点一下看名下的内容", en: "Tap to see what’s tagged" },
  "topics.bodyIdeas": { zh: "随记 {n}", en: "Notes {n}" },
  "topics.bodyTasks": { zh: "任务 {n}", en: "Tasks {n}" },
  "topics.bodyNoIdeas": { zh: "还没有随记打这个标签", en: "No notes with this tag yet" },
  "topics.bodyNoTasks": { zh: "还没有任务打这个标签", en: "No tasks with this tag yet" },
});
