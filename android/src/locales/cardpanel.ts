// android/src/cardpanel.ts(卡片操作面板:动作行 / 状态·截止·优先级 / 标签面 /
// 移动 picker / 编辑面)的文案分片。stage 四态取 ui.* 那份单一真相源,不在这里另抄。
import { defineMessages } from "./entry";

export const cardpanel = defineMessages({
  "cardpanel.prioNone": { zh: "无", en: "None" },
  // 506:三档改用 P 记号(高→P0 / 中→P1 / 低→P2),同桌面 tasktime.pri*。⛔ 库里仍是 1/2/3。
  "cardpanel.prioLow": { zh: "P2", en: "P2" },
  "cardpanel.prioMid": { zh: "P1", en: "P1" },
  "cardpanel.prioHigh": { zh: "P0", en: "P0" },
  "cardpanel.draftDropped": { zh: "未保存的编辑已丢弃", en: "Unsaved changes were discarded" },
  "cardpanel.moveAck": { zh: "我已处理", en: "Handled" },
  "cardpanel.actEdit": { zh: "编辑", en: "Edit" },
  "cardpanel.actTags": { zh: "标签", en: "Tags" },
  "cardpanel.actHistory": { zh: "历史", en: "History" },
  "cardpanel.histEmpty": { zh: "还没有改过", en: "Not edited yet" },
  "cardpanel.histEditedAt": { zh: "于 {time} 改", en: "Edited {time}" },
  "cardpanel.histChars": { zh: "{n} 字", en: "{n} {n|char|chars}" },
  "cardpanel.histMore": { zh: "更早的版本", en: "Earlier versions" },
  // 706:加图 / 拍照 / 清单三枚随编辑表单搬进了屏底的编辑层,那三处文案在静态壳里
  // 走 `shell.addImage` / `shell.takePhoto` / `shell.insertTodo`(与「记一笔」同一份)
  // ⇒ 这边同名的三个键连同重复的中文一起销掉,⛔ 别再抄第二份回来。
  "cardpanel.actComment": { zh: "留言", en: "Comments" },
  "cardpanel.actPromote": { zh: "转待办", en: "Make a task" },
  "cardpanel.actRevert": { zh: "撤回为随记", en: "Send back to Notes" },
  "cardpanel.actSeal": { zh: "归档", en: "Archive" },
  "cardpanel.actMove": { zh: "移动", en: "Move" },
  "cardpanel.actDelete": { zh: "删除", en: "Delete" },
  // 706:动作行四枚封顶,低频那几件收在这枚后面。省略号是「还有一层」的记号(同顶栏
  // 「过滤…」「空间…」),⛔ 别改成「更多」两个字——那读起来像一个动作。
  "cardpanel.actMore": { zh: "更多…", en: "More…" },
  // 值 chip 上「截止」还没设时的占位。⛔ 别写成空:一枚什么也不说的 chip 点不点得开看不出来。
  "cardpanel.dueNone": { zh: "未设", en: "Not set" },
  // 158 G3 / Q5:手机也叫「列」(同桌面看板);键名不动(命名铁律)。
  "cardpanel.laneStatus": { zh: "列", en: "Column" },
  "cardpanel.colsOnDesktop": { zh: "列在电脑上管理", en: "Manage columns on your computer" },
  "cardpanel.laneDue": { zh: "截止", en: "Due" },
  "cardpanel.lanePriority": { zh: "优先级", en: "Priority" },
  "cardpanel.dueClear": { zh: "清除", en: "Clear" },
  // 159 / W3 Q4(WM-19 / WM-34):「这边删除」读着像进了回收站 ⇒「这边不留」;随记卡 / 任务卡 / 长文三处共用这一套(同桌面 space.moveWarn*)。
  "cardpanel.moveWarnPre": { zh: "移到别的空间 = 那边新生一条、这边不留;", en: "Moving to another space creates a new one there and keeps nothing here; " },
  "cardpanel.moveWarnBold": { zh: "编辑历史会随移动永久删除,不迁入目标空间", en: "the edit history is permanently deleted and does not come along" },
  "cardpanel.moveWarnPost": { zh: "。", en: "." },
  "cardpanel.noOtherSpace": { zh: "没有其他空间", en: "No other space" },
  "cardpanel.back": { zh: "返回", en: "Back" },
  "cardpanel.save": { zh: "保存", en: "Save" },
  "cardpanel.cancel": { zh: "取消", en: "Cancel" },
  "cardpanel.noTags": { zh: "还没有标签", en: "No tags yet" },
  "cardpanel.newTagPh": { zh: "新标签名", en: "New tag name" },
  "cardpanel.createAndTag": { zh: "新建并打上", en: "Create and add" },
  "cardpanel.moveKept": { zh: "已复制到「{name}」,原条目已保留:{reason}", en: "Copied to “{name}”, the original was kept: {reason}" },
  "cardpanel.moveUnconfirmedNote": { zh: "已复制到「{name}」,但原条目删除未确认({error});请检查后手动删除,勿再移动", en: "Copied to “{name}”, but deleting the original was not confirmed ({error}); check and delete it by hand, do not move it again" },
  "cardpanel.moveQ": { zh: "移到「{name}」?编辑历史会永久删除", en: "Move to “{name}”? The edit history will be permanently deleted" },
  "cardpanel.moveYes": { zh: "确认移动", en: "Move it" },
  "cardpanel.moved": { zh: "已移到「{name}」", en: "Moved to “{name}”" },
  "cardpanel.movedKept": { zh: "已复制到「{name}」,原条目保留", en: "Copied to “{name}”; the original was kept" },
  "cardpanel.movedUnconfirmed": { zh: "已复制到「{name}」,但原条目删除未确认,请核对两边", en: "Copied to “{name}”, but deleting the original was not confirmed; check both sides" },
  "cardpanel.imagesPending": { zh: "有 {n} 张配图还没同步到齐,等完成再移", en: "{n} attached {n|image|images} {n|has|have} not fully synced yet, move it once they finish" },
  "cardpanel.danglingRefs": { zh: "正文引用了已删除的配图,暂不支持跨空间移动", en: "The text references deleted images; moving across spaces is not supported yet" },
  "cardpanel.topicsRefreshFailed": { zh: "标签列表刷新失败(下次打开自动重读)", en: "Could not refresh the tag list (it will reload next time)" },
  "cardpanel.emptyContent": { zh: "内容不能为空", en: "Content cannot be empty" },
  "cardpanel.imageReadFailed": { zh: "读取图片失败,请重试", en: "Could not read the image, try again" },
  "cardpanel.imageAdded": { zh: "已加图", en: "Image added" },
  "cardpanel.imagesAdded": { zh: "已加 {n} 张图", en: "{n} images added" },
  "cardpanel.imagesPartial": { zh: "{ok} 张已加,{failed} 张没加上:", en: "{ok} added, {failed} failed:" },
  "cardpanel.histVsNow": { zh: "这一版 → 现在:删掉的标红,加上的标绿", en: "This version → now: removed in red, added in green" },
  "cardpanel.histDegraded": { zh: "改动太多,算不出逐行差异,两份原文都在下面", en: "Too many changes to diff line by line; both texts are below" },
  "cardpanel.editedMark": { zh: "改过", en: "edited" },
  "cardpanel.discardQ": { zh: "丢掉这次的修改?", en: "Discard your changes?" },
  "cardpanel.discardYes": { zh: "丢掉", en: "Discard" },
  "cardpanel.discardNo": { zh: "接着改", en: "Keep editing" },
  "cardpanel.finishDraftFirst": { zh: "先保存或取消正在编辑的内容", en: "Save or cancel what you are editing first" },
  "cardpanel.actExpand": { zh: "展开成长文", en: "Expand to long-form" },
  "cardpanel.actCopy": { zh: "复制", en: "Copy" },
  "cardpanel.textCopied": { zh: "已复制这张卡的文字", en: "Card text copied" },
  "cardpanel.actCopyLink": { zh: "复制链接", en: "Copy link" },
  "cardpanel.linkCopied": { zh: "已复制链接", en: "Link copied" },
  "cardpanel.copyLinkFailed": { zh: "复制失败:{error}", en: "Copy failed: {error}" },
  "cardpanel.expandRefsFailed": { zh: "已展开成长文,但没能把图的「图N」补进正文:{error}", en: "Now long-form, but couldn’t add the image mentions to the text: {error}" },
  // 165 / W5:回执不写「在底栏「长文」里」(平板 / 横放没有底栏);去向交给「去看看」(Q14:跳过去看的钮一律叫「去看看」,此前叫「打开」)。
  "cardpanel.expanded": { zh: "已展开成长文", en: "Expanded to long-form" },
  // mbopt 第二波(用户 2026-11-12 拍):回执「已转为卡片」两端逐字同(桌面 inbox.undoPromoted);按钮名「转待办」不改(那是命令名)。
  "cardpanel.promotedShort": { zh: "已转为卡片", en: "Turned into a card" },
  // mbopt R2(第一波小账):「转待办」落默认看板,那块的落点 ⊥(只剩完成列 / 一列都没有)⇒ 钮事前灰、点了说这句;手机不建列 ⇒ 指到电脑上。
  "cardpanel.promoteNoLanding": { zh: "「转待办」会放进「{board}」,可它里面没有能放新卡片的列;在电脑上给它加一列再来", en: "“Make a task” puts it on “{board}”, which has no column that takes new cards. Add one on a computer first" },
  "cardpanel.goSee": { zh: "去看看", en: "Show me" },
  "cardpanel.tagNameRequired": { zh: "标签名不能为空", en: "Tag name cannot be empty" },
  "cardpanel.deleteQ": { zh: "删除?将移入回收站(可还原)", en: "Delete? It moves to Trash and can be restored" },
  "cardpanel.deleteYes": { zh: "删除", en: "Delete" },
  "cardpanel.deleted": { zh: "已移入回收站", en: "Moved to Trash" },
  "cardpanel.revertQMeta": { zh: "撤回为随记?将清除截止和优先级", en: "Send back to Notes? Due date and priority will be cleared" },
  "cardpanel.revertQ": { zh: "撤回为随记?", en: "Send back to Notes?" },
  "cardpanel.revertYes": { zh: "撤回", en: "Send back" },
  // 165 / W5:同 expanded,不写「底栏」,配「去看看」。
  "cardpanel.reverted": { zh: "已撤回为随记", en: "Sent back to Notes" },
  "cardpanel.sealed": { zh: "已归档", en: "Archived" },
  // 165 / W5 Q5 ★①:改截止 / 优先级做完说一声、带【撤销】(此前什么都不说、也撤不回)。键名用桌面看板那一族(board.undo*),两端同句。
  "board.undoDue": { zh: "已设截止 {day}", en: "Due date set to {day}" },
  "board.undoDueCleared": { zh: "已清除截止", en: "Due date cleared" },
  "board.undoPriority": { zh: "已设优先级 {p}", en: "Priority set to {p}" },
  "board.undoPriorityCleared": { zh: "已清除优先级", en: "Priority cleared" },
  // 0043 多看板第 4 段:卡片「更多…」里的「挪到看板」/ 随记的「放进看板」(活看板 ≥ 2 块才出,渐进式披露同桌面)。
  "cardpanel.actMoveBoard": { zh: "挪到看板", en: "Move to board" },
  "cardpanel.actPromoteTo": { zh: "放进看板", en: "Add to board" },
  "cardpanel.movedToBoard": { zh: "已挪到看板「{board}」", en: "Moved to board “{board}”" },
  "cardpanel.promotedTo": { zh: "已放进看板「{board}」", en: "Added to board “{board}”" },
});
