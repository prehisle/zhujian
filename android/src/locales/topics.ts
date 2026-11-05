// android/src/topics.ts(标签面:排序拖手柄 + 类型编辑 + 改名 + 颜色 + 新建)的文案分片。
import { defineMessages } from "./entry";

export const topics = defineMessages({
  "topics.loading": { zh: "读取中…", en: "Loading…" },
  "topics.loadFailed": { zh: "标签读取失败:{error}", en: "Could not load tags: {error}" },
  "topics.empty": { zh: "还没有标签。点上方「+ 新建标签」直接建一个,或在卡片上打标签。", en: "No tags yet. Tap “+ New tag” above to create one, or tag an item on its card." },
  "topics.kindPh": { zh: "类型(如 人名)", en: "Kind (e.g. Person)" },
  "topics.kindSave": { zh: "存", en: "Save" },
  "topics.kindClear": { zh: "清", en: "Clear" },
  "topics.kindAdd": { zh: "+ 类型", en: "+ Kind" },
  // 159(W3 Q12,WM-30):类型框下一行小字说它是干什么的。
  "topics.kindHint": { zh: "类型是给标签归一类(比如「人名」),随记页和看板的筛选条上就能按类型筛;不填就是没有类型。", en: "A kind groups tags (e.g. Person); the filter bars on Notes and the board can then filter by kind. Leave it empty for none." },
  "topics.dragHint": { zh: "拖动排序", en: "Drag to reorder" },
  // 行上的计数(159 / W3 Q12,WM-27 / X-11):照桌面分开写,可见中文与桌面那两句同(键空间各自独立)。
  "topics.counts": { zh: "{ideas} 条随记 · {tasks} 个任务", en: "{ideas} {ideas|note|notes} · {tasks} {tasks|task|tasks}" },
  "topics.countsDocs": { zh: "{ideas} 条随记 · {docs} 篇长文 · {tasks} 个任务", en: "{ideas} {ideas|note|notes} · {docs} long-form · {tasks} {tasks|task|tasks}" },
  "topics.kindSet": { zh: "已设类型", en: "Kind set" },
  "topics.kindCleared": { zh: "已清类型", en: "Kind cleared" },
  // 改名(514):点名字进编辑态。⛔ 键空间与桌面独立(两份字典),别去和 src/locales 对齐。
  "topics.renameHint": { zh: "点一下改名", en: "Tap to rename" },
  "topics.renamePh": { zh: "标签名", en: "Tag name" },
  "topics.renameSave": { zh: "存", en: "Save" },
  "topics.renameCancel": { zh: "取消", en: "Cancel" },
  "topics.renamed": { zh: "已改名", en: "Renamed" },
  // 159(W3 A13):新建 / 改名空着点「建」「存」,框下红字说一声(同桌面那句)。
  "topics.nameRequired": { zh: "标签名不能为空", en: "Tag name cannot be empty" },
  // 颜色(user-44 第二刀):点行内色点开调色板,点色块即写。
  "topics.colorHint": { zh: "改颜色", en: "Change color" },
  "topics.colorNone": { zh: "无", en: "None" },
  "topics.colorCancel": { zh: "取消", en: "Cancel" },
  "topics.colorSet": { zh: "已改颜色", en: "Color set" },
  "topics.colorCleared": { zh: "已清颜色", en: "Color cleared" },
  // 删除(user-44 第三刀):改名态里的第三枚钮 → 底部两拍确认条。话术要说清
  // core 的真语义 —— 只摘标签、条目内容不动(0 挂载用简版,「0 项」是句空话)。
  "topics.deleteBtn": { zh: "删除", en: "Delete" },
  "topics.deleteQ": { zh: "删除标签「{name}」?{n} 项只摘掉这枚标签,内容不动", en: "Delete tag “{name}”? It comes off {n} {n|item|items}; their content stays." },
  "topics.deleteQEmpty": { zh: "删除标签「{name}」?", en: "Delete tag “{name}”?" },
  "topics.deleteYes": { zh: "删除", en: "Delete" },
  "topics.deleted": { zh: "已删除标签", en: "Tag deleted" },
  // 合并(user-44 第四刀):一对一两击 → 底部两拍确认条。159(W3 Q5)起方向与桌面一致、钉死:
  // **先点的留下、后点的并进来**(此前手机先点的是被并掉的,与桌面正好相反)。
  "topics.mergeBtn": { zh: "合并", en: "Merge" },
  "topics.mergePickKeep": { zh: "先点要留下的标签", en: "First tap the tag to keep" },
  "topics.mergePickInto": { zh: "把谁并进「{name}」?点要并进来的标签", en: "Fold which tag into “{name}”? Tap it" },
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
  "topics.bodyDocs": { zh: "长文 {n}", en: "Long-form {n}" },
  "topics.bodyNoTasks": { zh: "还没有任务打这个标签", en: "No tasks with this tag yet" },
  // 父子层级(user-44 第六刀):父行右侧那枚箭头的读屏名。屏上只有 ▾/▸ 一个字符,
  // 说清「几个」全靠这一句 —— 可见中文与桌面标签视图那两句同(那边是 title 悬停)。
  "topics.kidsExpand": { zh: "展开 {n} 个子标签", en: "Show {n} child {n|tag|tags}" },
  "topics.kidsCollapse": { zh: "收起 {n} 个子标签", en: "Hide {n} child {n|tag|tags}" },
});
