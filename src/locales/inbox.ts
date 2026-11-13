// 分片待 358 第①笔清扫填充;键前缀 = 来源 ts 文件名(全局唯一,跨分片不许撞)。
import { defineMessages } from "./entry";

export const inbox = defineMessages({
  "inbox.title": { zh: "随记", en: "Notes" },
  "inbox.copyIdeas": { zh: "复制随记", en: "Copy notes" },
  "inbox.tabTrash": { zh: "回收站", en: "Trash" },
  "inbox.backToIdeas": { zh: "← 随记", en: "← Notes" },
  "inbox.imagesTrashed": { zh: "删了 {n} 张图,在回收站能找回", en: "Deleted {n} image(s) — you can get them back from Trash" },
  "inbox.filterPlaceholder": { zh: "过滤随记…", en: "Filter notes…" },
  // W4 Q11 / WD-38:「本周捕获 · 转待办」换白话(用户拍定的词表)。
  "inbox.weekStatsNoRatio": { zh: "本周记了 {n} 条", en: "Noted {n} this week" },
  "inbox.composePlaceholder": { zh: "随手记一笔…", en: "Jot something down…" },
  // W3 159 / Q6(WD-17):有多个空间时灰字写上会记进哪个空间(只有一个空间时照旧)。
  "inbox.composePlaceholderSpace": { zh: "随手记一笔,记进「{space}」…", en: "Jot something down — goes into “{space}”…" },
  "inbox.composeAdd": { zh: "记下", en: "Note it" },
  "inbox.savedTagFailed": { zh: "随记已保存,但 {n} 枚标签未能挂上(切到「所有」可见)", en: "Note saved, but {n} {n|tag|tags} could not be attached (switch to “All” to see it)" },
  "inbox.savedImagesFailed": { zh: "随记已保存,但 {n} 张图未能附加", en: "Note saved, but {n} {n|image|images} failed to attach" },
  "inbox.loadFailed": { zh: "读取失败", en: "Failed to load" },
  "inbox.retry": { zh: "重试", en: "Retry" },
  // 898 G1:空态从「还没有…」换成「这儿是干嘛的」—— 先记在这儿、要做的之后转成待办;热键那句说它在**别的程序里**也能用。
  "inbox.emptyIdeasTitle": { zh: "想到什么,先记在这儿", en: "Whatever comes to mind, note it here first" },
  // W4 A6 / Q8 ①:{key} 是此刻真生效的那枚捕获键(改过键照着变);它被别的程序占着、按了没反应时
  // 换下面那句(只剩第一句),不提快捷键。
  "inbox.emptyIdeasHint": { zh: "要做的事,之后转成待办放进看板。在别的程序里按 {key} 也能随手记,不用切回来。", en: "Things to do can be turned into tasks on the board later. Press {key} in any other app to jot something down without switching back." },
  "inbox.emptyIdeasHintNoKey": { zh: "要做的事,之后转成待办放进看板。", en: "Things to do can be turned into tasks on the board later." },
  // 898 G2:教学期(记过随记、还没转过一次待办 = `.hk-teach` 那个条件)列表下方一行灰字,条件不成立下一发 refresh 自己消失。
  "inbox.teachHint": { zh: "点卡片右上角的 ⋯,可以打标签,或转成待办放进看板。", en: "Click ⋯ at a card’s top right to tag it, or turn it into a task on the board." },
  "inbox.emptyTrashTitle": { zh: "回收站是空的", en: "Trash is empty" },
  "inbox.emptyTrashHint": { zh: "删掉的随记、长文和配图会先来这里,可还原或彻底删除。", en: "Deleted notes, long-form and images land here first. Restore them or delete them forever." },
  "inbox.removeTagTitle": { zh: "去掉这个标签", en: "Remove this tag" },
  "inbox.movePartialDone": { zh: "我已处理,解除", en: "Handled, dismiss" },
  "inbox.editedAt": { zh: "于 {time} 改", en: "Edited {time}" },
  "inbox.historyToggle": { zh: "历史 {n} 版", en: "History · {n} {n|version|versions}" },
  "inbox.histChars": { zh: "{n} 字", en: "{n} {n|char|chars}" },
  "inbox.historyMore": { zh: "更早的版本", en: "Earlier versions" },
  "inbox.cancel": { zh: "取消", en: "Cancel" },
  "inbox.deleteForever": { zh: "彻底删除", en: "Delete forever" },
  "inbox.copied": { zh: "已复制", en: "Copied" },
  "inbox.copiedLink": { zh: "已复制链接", en: "Link copied" },
  "inbox.actRestore": { zh: "还原", en: "Restore" },
  "inbox.actCopy": { zh: "复制", en: "Copy" },
  "inbox.actCopyLink": { zh: "复制链接", en: "Copy link" },
  "inbox.actEdit": { zh: "编辑", en: "Edit" },
  // 165 / W5 Q14:「转待办」一个叫法(手机钮与两端回执早就是这个词;此前菜单「待办」、快捷键表「转成任务」)。
  "inbox.actTask": { zh: "转待办", en: "Make a task" },
  "inbox.actTag": { zh: "标签", en: "Tags" },
  "inbox.actComments": { zh: "留言", en: "Comments" },
  // 165 / W5 A19(WD-21):换空间那一项写全「移到别的空间」(同快捷键表与面板标题);此前叫「移动」,在看板上与换列的「移到 ▸」只差一个字。
  "inbox.actMove": { zh: "移到别的空间", en: "Move to another space" },
  // 898 W1:「展开成长文」→「转成长文」(与「转待办」同一个动词)。⛔ 键名不动(命名铁律)。
  "inbox.actExpand": { zh: "转成长文", en: "Turn into long-form" },
  "inbox.undoExpanded": { zh: "已转成长文", en: "Turned into long-form" },
  "inbox.expandRefsFailed": { zh: "已转成长文,但没能把图的「图N」补进正文:{err}", en: "Turned into long-form, but couldn’t add the image mentions to the text: {err}" },
  "inbox.docBadge": { zh: "长文", en: "Long-form" },
  "inbox.actDelete": { zh: "删除", en: "Delete" },
  "inbox.undoDeleted": { zh: "已移入回收站", en: "Moved to Trash" },
  "inbox.undoPromoted": { zh: "已转为卡片", en: "Turned into a card" },
  // 0043 随记「更多…」里的「放进看板 ▸」(multiboard-plan §0 ⑤):≥ 2 块看板才出现。
  "inbox.actIntoBoard": { zh: "放进看板", en: "Put on board" },
  "inbox.promotedTo": { zh: "已放进看板「{board}」", en: "Put on board “{board}”" },
  // W5:「转待办」落的默认看板此刻放不进卡(落点 ⊥)—— 事前灰着时说的那句(口径同 board.newTaskNoLanding)。
  "inbox.promoteNoLanding": { zh: "默认看板「{board}」现在没有能放新卡片的列:到「管理看板」里新建一列,或取消完成列", en: "The default board “{board}” has no column that can take new cards: add a column in “Manage board”, or unset the done column" },
  "inbox.trashNote": { zh: "删掉的随记、长文和配图会一直留在这,直到你彻底删除", en: "Deleted notes, long-form and images stay here until you delete them forever" },
  "inbox.filterNoMatch": { zh: "没有匹配「{q}」的随记", en: "No notes match “{q}”" },
  "inbox.goSee": { zh: "去看看", en: "Show me" },
  // 编辑态框下那行淡字(902 F1;随记编辑态与看板卡片就地编辑态共用,同 discardHint 的共用法)。
  "inbox.editHint": { zh: "回车或点别处保存 · Esc 不要了", en: "Enter or click elsewhere to save · Esc to discard" },
  "inbox.discardHint": { zh: "改过了 —— 再按一次 Esc 丢掉这次的修改;回车或点别处保存。", en: "You have changes — press Esc again to discard them; Enter or click elsewhere to save." },
  "inbox.actHistory": { zh: "历史", en: "History" },
  // 165 / W5 A45:没改过的卡按 H(看板 V)此前一声不吭;菜单里照旧只有改过的才列「历史」。
  "inbox.noHistory": { zh: "这张还没改过,没有历史", en: "Not edited yet, so there’s no history" },
  // W5 A9:卡片 ⋯ 菜单 / 单键 I —— 只用键盘也打得开大图(两个视图共用这一句)。
  "inbox.actImages": { zh: "看图", en: "View images" },
  "inbox.editedMark": { zh: "改过", en: "edited" },
  // 158 G4-A8:看板卡的历史读框(history-panel openHistoryDialog)。
  "inbox.histClose": { zh: "关闭", en: "Close" },
  "inbox.histNone": { zh: "这一条现在没有旧版本可看。", en: "There are no earlier versions of this one now." },
  "inbox.histVsNow": { zh: "这一版 → 现在:删掉的标红,加上的标绿", en: "This version → now: removed in red, added in green" },
  "inbox.addImage": { zh: "＋加图", en: "+ Image" },
  "inbox.filterNoMatchHint": { zh: "换个词,或清空过滤框(Esc)。", en: "Try another word, or clear the filter (Esc)." },
  "inbox.filterEmptyTag": { zh: "「{tag}」下没有随记", en: "No notes under “{tag}”" },
  "inbox.filterEmptyTagHint": { zh: "切到「所有」看全部随记。", en: "Switch to “All” to see every note." },
  "inbox.filterEmptyKind": { zh: "「{kind}」类型下没有随记", en: "No notes of kind “{kind}”" },
  "inbox.filterEmptyKindHint": { zh: "切到「全部类型」看全部随记。", en: "Switch “Kind” to “All kinds” to see every note." },
  "inbox.filterEmptyTime": { zh: "这段时间内没有随记", en: "No notes in this time range" },
  "inbox.filterEmptyTimeHint": { zh: "切到「时间」轴的「全部」看全部随记。", en: "Switch “Time” to “All” to see every note." },
});
