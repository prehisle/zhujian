// 分片待 358 第①笔清扫填充;键前缀 = 来源 ts 文件名(全局唯一,跨分片不许撞)。
import { defineMessages } from "./entry";

export const board = defineMessages({
  // 首帧占位(load 之后换成这块看板的名字)。
  "board.title": { zh: "看板", en: "Board" },
  // 0043(用户 2026-11-11 拍):看板不一定管任务(书单 / 话术),顶栏那几句统一叫「卡片」。⛔ 键名不动(命名铁律)。
  // 多看板优化 R4(用户 2026-11-12 拍):这一份字典里把卡片叫「任务」的可见串一律换成「卡片」;写死的「已完成」凡指
  // 「这块看板的完成列」都改吃 `{col}`(该列的名字)。按钮名「转待办」(随记上的命令名)保留。
  "board.newTask": { zh: "新建卡片", en: "New card" },
  // R2:这块看板放不进卡(落点 ⊥ —— 只剩完成列,多半是别的设备上同时改出来的)时「+ 新建卡片」灰着的 title、点它 / 按 N 的回执、
  // 空看板那一句。
  "board.newTaskNoLanding": { zh: "这块看板现在没有能放新卡片的列:到「管理看板」里新建一列,或取消完成列", en: "This board has no column that can take new cards: add a column in “Manage board”, or unset the done column" },
  "board.sealTitle": { zh: "已归档的成就(可查、不可删)", en: "Archived achievements (viewable, not deletable)" },
  "board.sealLbl": { zh: "归档 ", en: "Archive " },
  "board.trashTitle": { zh: "回收站", en: "Trash" },
  "board.trashLbl": { zh: "回收站 ", en: "Trash " },
  "board.backToBoard": { zh: "← 看板 ", en: "← Board " },
  "board.composePlaceholder": { zh: "新卡片…", en: "New card…" },
  // 158 G2 / A16:提交型两端都叫「记下」(ui-guidelines §4.2;随记那枚早就是)。
  "board.composeAdd": { zh: "记下", en: "Note it" },
  // W4 A29(WD-32):这枚只是把新建那一行收起,此前叫「完成」,在看板上读成「标为完成」。
  "board.composeDone": { zh: "收起", en: "Close" },
  "board.filterPlaceholder": { zh: "过滤卡片…", en: "Filter cards…" },
  "board.gotIt": { zh: "知道了", en: "Got it" },
  "board.colTodo": { zh: "待办", en: "To do" },
  "board.colDoing": { zh: "进行中", en: "In progress" },
  "board.colConfirming": { zh: "待确认", en: "To confirm" },
  "board.colDone": { zh: "已完成", en: "Done" },
  // C14(用户 2026-11-12 拍):这一面管的早不只是列(看板名 / 新卡落点 / 完成列 / 删看板都在里面)⇒ 钮叫「管理看板」。
  "board.manageCols": { zh: "管理看板", en: "Manage board" },
  "board.manageColsTitle": { zh: "管理这块看板:列(新建 / 改名 / 排序 / 删除)、看板名、新卡片落在哪一列、完成列、删除看板", en: "Manage this board: columns (add / rename / reorder / delete), its name, where new cards land, the done column, deleting the board" },
  "cols.title": { zh: "管理看板", en: "Manage board" },
  // 158 G3 / Q13(WD-32):「挂着产品语义」看不懂 ⇒ 说它俩各管什么。
  // 0043:落点 / 完成列成了每块看板可换的角色(底下「这块看板」那一节),这句不再点名「待办」「已完成」两列。
  "cols.hint": { zh: "列可以新建、改名、拖动排序。完成列要先取消才能删;一块看板至少留一列放新卡。列会同步到你的其它设备。", en: "Columns can be added, renamed and dragged into order. A done column must be unset before it can be deleted, and every board keeps at least one column for new cards. Columns sync to your other devices." },
  "cols.count": { zh: "{n} 条", en: "{n} {n|card|cards}" },
  "cols.rename": { zh: "重命名", en: "Rename" },
  "cols.delete": { zh: "删除", en: "Delete" },
  "cols.deleteQ": { zh: "删除这一列?", en: "Delete this column?" },
  "cols.deleteYes": { zh: "删除", en: "Delete" },
  "cols.deleteBlocked": { zh: "先把这一列的 {n} 个条目移走", en: "Move this column’s {n} {n|card|cards} out first" },
  "cols.save": { zh: "保存", en: "Save" },
  "cols.cancel": { zh: "取消", en: "Cancel" },
  "cols.close": { zh: "关闭", en: "Close" },
  "cols.add": { zh: "新建", en: "Add" },
  "cols.newPlaceholder": { zh: "新列的名字…", en: "New column name…" },
  "cols.emptyName": { zh: "列名不能为空", en: "A column needs a name" },
  "cols.dragHint": { zh: "拖动调整列的顺序", en: "Drag to reorder" },
  "cols.loadFailed": { zh: "读取失败:{msg}", en: "Failed to load: {msg}" },
  // ⭐ 拍板②(2026-08-25)要补的那句人话:core 那句只说得出「要等全部设备都升级」,
  // 说不出「其实可能只差一次同时在线」。⛔ 它是**前端**加的一句,core 与闩一个字都没动。
  "cols.peersTip": { zh: "若各设备都已升级:让两端同时在线一次,再回来点一次。", en: "If every device is already up to date: bring them online at the same time once, then come back and try again." },
  "cols.shutUnknown": { zh: "现在不能改列", en: "Columns can’t be changed right now" },
  "board.partialImg": { zh: "卡片已建,但 {n} 张图未能附加", en: "Card created, but {n} {n|image|images} could not be attached" },
  "board.partialTag": { zh: "卡片已建,但 {n} 枚标签未能挂上", en: "Card created, but {n} {n|tag|tags} could not be attached" },
  "board.titleEmpty": { zh: "先写个卡片标题", en: "Write a card title first" },
  "board.titleBeforeImages": { zh: "先写个卡片标题,配图会随卡片一起保存", en: "Write a card title first, the images will be saved with it" },
  "board.restore": { zh: "还原", en: "Restore" },
  "board.deleteForever": { zh: "彻底删除", en: "Delete forever" },
  "board.unseal": { zh: "取消归档", en: "Unarchive" },
  "board.cancel": { zh: "取消", en: "Cancel" },
  "board.archiveQ": { zh: "移入回收站?可在回收站还原", en: "Move to Trash? You can restore it from there" },
  "board.dontAskAgain": { zh: "不再提示", en: "Don't ask again" },
  "board.delete": { zh: "删除", en: "Delete" },
  "board.undoDeleted": { zh: "已移入回收站", en: "Moved to Trash" },
  // 158 G3 / Q6(WD-18):勾着「不再提示」删的那一下,说清以后不问了、在哪改回。
  // 「删任务前确认」是设置里那一项的名字(settings.deleteConfirmTitle),原样引。
  "board.undoDeletedNoAsk": { zh: "已移入回收站。以后删卡片不再问,要改回:设置 → 通用 →「删卡片前确认」", en: "Moved to Trash. You won’t be asked again; to change that: Settings → General → “Confirm before deleting a card”" },
  // 158 G3 / Q1(WD-16):新建的卡落在视野外(列滚到底时建的,排在列首)才说这一句,配「去看看」。
  "board.created": { zh: "已记下", en: "Added" },
  "board.undoMoved": { zh: "已移到「{col}」", en: "Moved to “{col}”" },
  "board.undoSealed": { zh: "已归档", en: "Archived" },
  "board.undoSealedAll": { zh: "已归档 {n} 条", en: "Archived {n}" },
  "board.undoUnsealed": { zh: "已取消归档,回到「{col}」", en: "Unarchived, back in “{col}”" },
  "board.undoColored": { zh: "已换色", en: "Color changed" },
  // 165 / W5 Q5 ★①:列首 / 列尾、截止、优先级也给「已… 撤销」(此前一声不吭、也撤不回;换色有、截止没有,同一个面板两种待遇)。
  // 截止 / 优先级那四句两端同句(手机 cardpanel 那张操作面,M1 定词);{day} 写「11月8日」、跨年带年。
  "board.undoToTop": { zh: "已移到列首", en: "Moved to the top" },
  "board.undoToBottom": { zh: "已移到列尾", en: "Moved to the bottom" },
  "board.undoDue": { zh: "已设截止 {day}", en: "Due date set to {day}" },
  "board.undoDueCleared": { zh: "已清除截止", en: "Due date cleared" },
  "board.undoPriority": { zh: "已设优先级 {p}", en: "Priority set to {p}" },
  "board.undoPriorityCleared": { zh: "已清除优先级", en: "Priority cleared" },
  // 165 / W5 Q7 ★①:⋯ 菜单「完成」(不在「已完成」列时才有 = 移到已完成),回执用手机点圈那句(键名照手机 main.completed,两端同句)。
  "board.complete": { zh: "完成", en: "Mark done" },
  "main.completed": { zh: "已完成", en: "Completed" },
  "board.undoUntagged": { zh: "已去掉标签「{tag}」", en: "Removed tag “{tag}”" },
  "board.removeTag": { zh: "去掉这个标签", en: "Remove this tag" },
  "board.doneAt": { zh: "完成于 {day}", en: "Done · {day}" },
  "board.copied": { zh: "已复制", en: "Copied" },
  "board.copyFailed": { zh: "复制失败", en: "Copy failed" },
  "board.linkCopied": { zh: "已复制链接", en: "Link copied" },
  "board.partialHandled": { zh: "我已处理,解除", en: "Handled, dismiss" },
  "board.edit": { zh: "编辑", en: "Edit" },
  "board.zoomEdit": { zh: "放大编辑", en: "Expand editor" },
  // 158 G3 / Q12(WD-15):放大框底下那行小字。
  "board.zoomHint": { zh: "Ctrl+Enter 保存 · Esc 不要了", en: "Ctrl+Enter to save · Esc to discard" },
  "board.unfold": { zh: "展开", en: "Expand" },
  "board.fold": { zh: "收起", en: "Collapse" },
  "board.copy": { zh: "复制", en: "Copy" },
  "board.copyLink": { zh: "复制链接", en: "Copy link" },
  "board.tags": { zh: "标签", en: "Tags" },
  "board.due": { zh: "截止", en: "Due" },
  "board.priority": { zh: "优先级", en: "Priority" },
  "board.color": { zh: "颜色", en: "Color" },
  "board.colorNone": { zh: "无色", en: "None" },
  // 卡片色名(0040)。⛔ 刻意**不复用** tagColor.* —— 那八个名字绑的是 TAG_COLORS 的色值,
  // 而卡片色是另一组(理由见 card-color.ts 头注);借名会让名字对不上色。
  "cardColor.amber": { zh: "琥珀", en: "Amber" },
  "cardColor.straw": { zh: "缃色", en: "Straw" },
  "cardColor.bamboo": { zh: "竹青", en: "Bamboo" },
  "cardColor.celadon": { zh: "苍青", en: "Celadon" },
  "cardColor.azure": { zh: "霁蓝", en: "Azure" },
  "cardColor.violet": { zh: "青莲", en: "Violet" },
  "cardColor.mallow": { zh: "木槿", en: "Mallow" },
  "board.comments": { zh: "留言", en: "Comments" },
  "board.moveToCol": { zh: "移到「{col}」", en: "Move to “{col}”" },
  // 158 G3 / Q2(WD-17):⋯ 菜单里那一行(右边一枚 ▸,点开列出所有列);已完成卡上的直达「打回」。
  "board.moveToMenu": { zh: "移到", en: "Move to" },
  "board.backToCol": { zh: "打回「{col}」", en: "Back to “{col}”" },
  "board.dueSoonToday": { zh: "今天到期 {now}", en: "{now} due today" },
  "board.dueSoonLate": { zh: "逾期 {late} · 今天 {now}", en: "{late} overdue · {now} today" },
  // 「快到期」那一段(用户面 60-A)。158 G3 / Q10 起每日提醒通知也带这一段(与钮逐字一致;
  // 响不响仍只看逾期 + 今天,见 tasktime.dueSummaryFullLabel)。{days} 由
  // DUE_SOON_DAYS 注入,⛔ 别在这儿写死天数。
  "board.dueSoonNext": { zh: "{days} 天内 {n}", en: "{n} within {days}d" },
  "board.dueSoonNextOnly": { zh: "{days} 天内到期 {n}", en: "{n} due within {days}d" },
  "board.dueSoonTitle": { zh: "点击只看逾期、今天到期与 {days} 天内到期的卡片;再点一次回到全部", en: "Click to show only cards overdue, due today, or due within {days}d; click again for all" },
  "board.noDueMatch": { zh: "到期与快到期的卡片不在当前筛选里", en: "No due or upcoming card matches the current filter" },
  // W4 Q11 / WD-38:「顶栏那枚到期钮」换白话(与设置里截止提醒那段同一个说法)。
  "board.noDueMatchHint": { zh: "放宽标签 / 类型 / 时间 / 过滤词,或再点一次页头显示到期数的那枚按钮回到全部。", en: "Loosen the tag / kind / time / text filter, or click the button showing the due count in the header again for all." },
  "board.sortManual": { zh: "顺序:手动", en: "Order: manual" },
  "board.sortNewest": { zh: "顺序:最新在前", en: "Order: newest first" },
  "board.sortOldest": { zh: "顺序:最早在前", en: "Order: oldest first" },
  // 898 B1:页头窄档里「顺序」那枚只剩的一个词(此前是无字的 ↕;英文档默认窗宽就落在这一档)。
  "board.sortManualShort": { zh: "手动", en: "Manual" },
  "board.sortNewestShort": { zh: "最新", en: "Newest" },
  "board.sortOldestShort": { zh: "最早", en: "Oldest" },
  // 898 B1:页头那枚「⋯」的悬停提示与读屏名(里面就这两项)。
  "board.moreTitle": { zh: "更多:复制看板、管理看板", en: "More: copy board, manage board" },
  "board.sortTitle": { zh: "点击切换列内顺序(手动 / 最新在前 / 最早在前)", en: "Click to change order within columns (manual / newest first / oldest first)" },
  "board.sortTitleLocked": { zh: "按创建时间排序中,拖不了。切回「手动」就能拖。", en: "Sorted by creation time, so dragging is off. Switch back to Manual to drag." },
  // 158 G3 / Q13(WD-28):排序 / 只看到期时按住卡一拖,在指针边上说一句。
  "board.noDragSorted": { zh: "按创建时间排序时不能拖 —— 把「顺序」切回「手动」就能拖", en: "Can’t drag while sorted by creation time — switch Order back to Manual" },
  "board.noDragDue": { zh: "只看到期时不能拖 —— 再点一次页头显示到期数的那枚按钮就能拖", en: "Can’t drag while showing due cards only — click the button showing the due count in the header again" },
  "board.sortTitleLockedDue": { zh: "只看到期时按紧急度排,拖不了。再点一次「到期」就能拖。", en: "Showing due cards only, sorted by urgency, so dragging is off. Click Due again to drag." },
  "board.moveToTop": { zh: "移到列首", en: "Move to top" },
  "board.moveToBottom": { zh: "移到列尾", en: "Move to bottom" },
  "board.seal": { zh: "归档", en: "Archive" },
  "board.revertToIdea": { zh: "撤回为随记", en: "Send back to Notes" },
  "board.revertQ": { zh: "撤回为随记?", en: "Send back to Notes?" },
  "board.revertYes": { zh: "撤回", en: "Send back" },
  "board.revertQMeta": { zh: "撤回为随记?将清除截止和优先级", en: "Send back to Notes? Due date and priority will be cleared" },
  "board.reverted": { zh: "已撤回为随记", en: "Sent back to Notes" },
  // 165 / W5 A19(WD-21):换空间写全(此前「移动」与换列的「移到 ▸」上下只隔一项、只差一个字)。
  "board.move": { zh: "移到别的空间", en: "Move to another space" },
  "board.renameFailed": { zh: "「{title}」的标题改动未能保存:{err}(草稿:{draft})", en: "Could not save the title change for “{title}”: {err} (draft: {draft})" },
  "board.copyBoard": { zh: "复制看板", en: "Copy board" },
  "board.sealAll": { zh: "全部归档", en: "Archive all" },
  // 窄列(列宽 ≤185px:900px 最小窗口下的四列,或列多了以后的任何窗口)用的短标签 —— 同一枚
  // 钮,只是把「全部」让给列名。⛔ 别复用 board.seal:那是**单条**归档,两个概念各占一个键。
  "board.sealAllShort": { zh: "归档", en: "Archive" },
  // 短句是有意的:这句连同两枚钮要一起挤进列头那一行,窄列下每个字都在跟按钮抢宽度。
  // 上下文已经把「全部」说清了(点的就是「全部归档」),问句只需答「归档几条」。
  "board.sealAllQ": { zh: "归档 {n} 条?", en: "Archive {n}?" },
  "board.archiveZoneHint": { zh: "把「{col}」里的卡片拖到这里归档", en: "Drag a card from “{col}” here to archive it" },
  "board.trashEmpty": { zh: "回收站是空的", en: "Trash is empty" },
  // W3 159 / A20(WD-24):此前写「删除的任务和配图」,读着像随记的图也在这儿 —— 看板回收站只装任务(与任务里删掉的图)。
  "board.trashEmptyHint": { zh: "删掉的卡片会落到这里,可还原或彻底删除;卡片里删掉的配图也在这儿。做完的卡片请用「归档」。", en: "Deleted cards land here, along with images removed from cards. Restore them or delete them forever. Finished cards belong in Archive." },
  "board.trashCount": { zh: "{n} 张已删除的卡片", en: "{n} deleted {n|card|cards}" },
  "board.sealedEmpty": { zh: "还没有归档的卡片", en: "No archived cards yet" },
  // {col} = 眼前这块看板的完成列名;这块没有完成列时换 boards.sealedEmptyHintNoDone。
  "board.sealedEmptyHint": { zh: "在「{col}」列点「全部归档」,或把那一列的卡片拖到看板底部。归档的卡片可查、不可删。", en: "Click “Archive all” in the “{col}” column, or drag one of its cards to the bottom of the board. Archived cards can be viewed but not deleted." },
  // 158 G3 / Q13(WD-33):归档页的页头与卡上日期(老卡没有完成日时写入档那天)。
  "board.sealedTitle": { zh: "归档", en: "Archive" },
  "board.sealedAt": { zh: "归档于 {day}", en: "Archived · {day}" },
  "board.sealedStats": { zh: "本周完成 {week} · 累计 {total}", en: "Done this week {week} · total {total}" },
  // W3 159 / A21(WD-26):上面两个数含「已完成」列里还没归档的卡(158 G2 / A6 定的口径),下面只列册子里的 —— 交代一句。
  "board.sealedStatsOnBoard": { zh: "(含看板「{col}」列里还没归档的 {n} 张)", en: " (including {n} {n|card|cards} still in the “{col}” column, not archived yet)" },
  "board.empty": { zh: "还没有卡片", en: "No cards yet" },
  // 后半句点名的是真长相:随记卡片右上角那枚 ⋯,菜单里那一项的原话就是「转待办」
  // (inbox.actTask)。⛔ 换了那一项的可见中文,这句要同笔改。
  // ⚠ ⋯ 外面那对「」不是装饰:空态这行会折行,裸的 ⋯ 掉到行尾读起来像「话没说完」——
  // 而 CJK 折行规则不许行尾留开引号、不许行首起闭引号 ⇒ 括起来它就折不散了(实测两版图)。
  // R3:「转待办」落默认看板 ⇒ 这句只在默认看板上说;别的看板说 boards.emptyHintOther(「放进看板」)。
  "board.emptyHint": { zh: "点右上角「+ 新建卡片」;或在「随记」里点开卡片上的「⋯」菜单,选「转待办」。", en: "Click “+ New card” in the top right, or open a note’s ⋯ menu in Notes and pick “Make a task”." },
  // 898 G3:空看板再说一句能拖。{col} = 这块看板此刻的完成列名(角色由 core 解析,人能改指);没有完成列换 NoDone 那句。
  "board.emptyDrag": { zh: "卡片可以拖到别的列,拖进「{col}」列就是做完。", en: "Drag a card to another column; the “{col}” column means done." },
  "board.emptyDragNoDone": { zh: "卡片可以拖到别的列。", en: "Drag a card to another column." },
  // 同上后半:种子三列(名字没改过时)在空看板上各一句。
  "board.colHintDoing": { zh: "正在做的。", en: "What you’re working on." },
  "board.colHintConfirming": { zh: "做完了,等对方回音。", en: "Finished, waiting to hear back." },
  "board.colHintDone": { zh: "做完的放这儿。", en: "Finished cards go here." },
  // 165 / W5 Q15(WD-34 前半):看板空了、归档册里有 —— 说一句它在哪(手机那句不写「页头」,键 main.emptyTasksSealed)。
  // R3 起 {n} 只数这块看板的成就;这块没有完成列就不说这句。
  "board.emptySealed": { zh: "归档了 {n} 张,在页头「归档」里。", en: "{n} {n|card|cards} archived, under Archive in the header." },
  "board.noMatch": { zh: "没有匹配「{q}」的卡片", en: "No cards matching “{q}”" },
  "board.noMatchHint": { zh: "换个词,或清空过滤框(Esc)。", en: "Try another word, or clear the filter (Esc)." },
  "board.listSeparator": { zh: "、", en: ", " },
  "board.noTasksUnder": { zh: "「{label}」下没有卡片", en: "No cards under “{label}”" },
  "board.noTasksUnderHint": { zh: "切到「所有」看全部卡片,或在卡片上打个标签。", en: "Switch to All to see every card, or tag a card." },
  "board.noTasksInKind": { zh: "「{kind}」类型下没有卡片", en: "No cards of kind “{kind}”" },
  "board.noTasksInKindHint": { zh: "切到「全部类型」看全部卡片。", en: "Switch “Kind” to “All kinds” to see every card." },
  "board.noTasksInTime": { zh: "这段时间内没有卡片", en: "No cards in this time range" },
  "board.noTasksInTimeHint": { zh: "切到「记于」轴的「全部」看全部卡片。", en: "Switch “Created” to “All” to see every card." },
  "board.loadFailed": { zh: "读取失败", en: "Failed to load" },
  "board.retry": { zh: "重试", en: "Retry" },
  // 506:三档改用 P 记号显示(高→P0 / 中→P1 / 低→P2)。⛔ 键名与库里的 1/2/3 一个字没动,
  // 换的只是这三个可见词;两端同一套记号,故英文档也是 P0/P1/P2(不是 High/Medium/Low)。
  "tasktime.priLow": { zh: "P2", en: "P2" },
  "tasktime.priMid": { zh: "P1", en: "P1" },
  "tasktime.priHigh": { zh: "P0", en: "P0" },
  "tasktime.today": { zh: "今天", en: "Today" },
  "tasktime.yesterday": { zh: "昨天", en: "Yesterday" },
  "tasktime.dayBeforeYesterday": { zh: "前天", en: "2 days ago" },
  "tasktime.tomorrow": { zh: "明天", en: "Tomorrow" },
  "tasktime.monthDay": { zh: "{m}月{d}日", en: "{m}/{d}" },
  "tasktime.yearMonthDay": { zh: "{y}年{m}月{d}日", en: "{m}/{d}/{y}" },
  // 158 G3 / Q4:已完成卡上那枚灰章(不说逾期,只写那天)。
  "tasktime.dueOn": { zh: "截止 {day}", en: "Due {day}" },
  "tasktime.overdueDays": { zh: "逾期 {n} 天", en: "{n} {n|day|days} overdue" },
  "tasktime.inDays": { zh: "{n} 天后", en: "In {n} {n|day|days}" },
  "tasktime.priorityChip": { zh: "优先级·{p}", en: "Priority · {p}" },
  "tasktime.clear": { zh: "清除", en: "Clear" },
  "tasktime.dueChipTitle": { zh: "截止 {day} · 点一下改", en: "Due {day} · click to change" },
  // 165 / W5 A11(WD-10):截止框里有字、日期却没成(年那一格吃进了 6 位 / 只填了年 / 打了「-」不跳格)。回车 = 框旁这句、框留着;
  // 点别处 = 收起并在底部说没设上。⛔ 不猜用户想要哪天。
  "tasktime.dueUnfinished": { zh: "日期没填完整:年、月、日是三格,打完年份按 → 进月份;Esc 放弃", en: "The date isn’t complete: year, month and day are separate fields — after the year, press → for the month; Esc to cancel" },
  "tasktime.dueNotSet": { zh: "截止没设上:日期没填完整", en: "Due date not set: the date was incomplete" },
  // ---- 0043 多看板(multiboard-plan §6;boards.ts / board-nav.ts / board.ts / column-manager.ts) ----
  // 种子看板没改过名时的本端名(同种子列 §7.1d:canonical 串不出 core,各端各显自己那门语言)。
  "boards.seedName": { zh: "任务", en: "Tasks" },
  "boards.moveToBoardMenu": { zh: "挪到看板", en: "Move to board" },
  "boards.movedTo": { zh: "已挪到看板「{board}」", en: "Moved to board “{board}”" },
  "boards.restoredHeld": { zh: "已还原:它原来那一列已经删了,先放在「已删除的看板 / 列」那里", en: "Restored — its column was deleted, so it’s waiting under “Deleted boards / columns”" },
  "boards.unsealedHeld": { zh: "已取消归档:它原来那一列已经删了,先放在「已删除的看板 / 列」那里", en: "Unarchived — its column was deleted, so it’s waiting under “Deleted boards / columns”" },
  "boards.sealedAll": { zh: "全部看板", en: "All boards" },
  "boards.sealedStatsOnBoards": { zh: "(含各看板完成列里还没归档的 {n} 张)", en: " (including {n} {n|card|cards} still in boards’ done columns, not archived yet)" },
  "boards.sealedNoneHere": { zh: "这块看板还没有归档的卡片", en: "Nothing archived from this board yet" },
  "boards.sealedEmptyHintNoDone": { zh: "归档只在有完成列的看板上:在完成列点「全部归档」,或把完成列里的卡片拖到看板底部。归档的卡片可查、不可删。", en: "Archiving works on boards with a done column: click “Archive all” there, or drag a card from it to the bottom of the board. Archived cards can be viewed but not deleted." },
  // R3:非默认看板空着时的那句(「转待办」落默认看板,这里说「放进看板」;≥ 2 块看板时随记 ⋯ 里才有它,而非默认看板在场就 ≥ 2 块)。
  "boards.emptyHintOther": { zh: "点右上角「+ 新建卡片」;或在「随记」里点开卡片上的「⋯」菜单,选「放进看板」。", en: "Click “+ New card” in the top right, or open a note’s ⋯ menu in Notes and pick “Put on board”." },
  "boards.holdingTitle": { zh: "已删除的看板 / 列", en: "Deleted boards / columns" },
  "boards.holdingBar": { zh: "这些卡原来所在的看板或列已经删了。它们只能挪出去(⋯ → 挪到看板),挪完这里就空了。共 {n} 张", en: "These cards’ board or column was deleted. They can only be moved out (⋯ → Move to board); once moved, this page empties. {n} {n|card|cards}" },
  "boards.holdingFrom": { zh: "「{board}」· {col}", en: "“{board}” · {col}" },
  "boards.holdingBoardGone": { zh: "看板已删除", en: "board deleted" },
  "boards.holdingColGone": { zh: "列已删除", en: "column deleted" },
  "boards.holdingEmpty": { zh: "这里空了", en: "Nothing here" },
  "boards.holdingEmptyHint": { zh: "删掉的看板 / 列里已经没有卡了", en: "No cards are left in deleted boards or columns" },
  "bnav.add": { zh: "+ 新建看板", en: "+ New board" },
  "bnav.holding": { zh: "已删除的看板 / 列里还有 {n} 张卡", en: "{n} {n|card|cards} left in deleted boards / columns" },
  "bnav.defaultTitle": { zh: "「{name}」· 默认看板(在最上面;随记「转待办」落这里)· 拖动可排序 · 右键改名 / 管理", en: "“{name}” · default board (top of the list; Notes “Make a task” lands here) · drag to reorder · right-click to rename / manage" },
  "bnav.itemTitle": { zh: "「{name}」· 拖动可排序 · 右键改名 / 管理 / 删除", en: "“{name}” · drag to reorder · right-click to rename / manage / delete" },
  // C14:侧栏看板名的右键菜单。
  "bnav.menuRename": { zh: "改名", en: "Rename" },
  "bnav.menuManage": { zh: "管理看板", en: "Manage board" },
  "bnav.menuDelete": { zh: "删除这块看板", en: "Delete this board" },
  "bnav.deleteQ": { zh: "删除看板「{name}」?", en: "Delete board “{name}”?" },
  "bnav.deleteBody": { zh: "它上面已经没有卡片了。回收站和归档里来自它的卡片,以后还原时会先放进「已删除的看板 / 列」。", en: "It has no cards left. Cards from it in the Trash or the Archive will wait under “Deleted boards / columns” if you restore them later." },
  "bnav.deleted": { zh: "已删除看板「{name}」", en: "Deleted board “{name}”" },
  "bnav.newTitle": { zh: "新建看板", en: "New board" },
  "bnav.namePh": { zh: "看板名,比如「书单」「话术」", en: "Board name, e.g. “Reading list”" },
  "bnav.tplFlow": { zh: "待处理 / 进行中 / 已完成", en: "To do / In progress / Done" },
  "bnav.tplFlowSub": { zh: "三列;做完的放进「已完成」,能归档成成就", en: "Three columns; finished cards go to “Done” and can be archived" },
  "bnav.tplOne": { zh: "一列,只分类", en: "One column, just for sorting" },
  "bnav.tplOneSub": { zh: "没有「完成」—— 话术、链接、书单这类只收着、不用做完的", en: "No “done” — for things you keep rather than finish: snippets, links, reading lists" },
  "bnav.newHint": { zh: "建好以后可以在「管理看板」里加列、改名,也能换哪一列是新卡落点、哪一列是完成列。", en: "Afterwards you can add or rename columns in “Manage board”, and choose which column new cards land in and which one is “done”." },
  "bnav.create": { zh: "建好", en: "Create" },
  "bnav.colTodo": { zh: "待处理", en: "To do" },
  "bnav.colDoing": { zh: "进行中", en: "In progress" },
  "bnav.colDone": { zh: "已完成", en: "Done" },
  "bnav.colOne": { zh: "收着", en: "Kept" },
  "cols.titleFor": { zh: "管理看板 · {board}", en: "Manage board · {board}" },
  "cols.boardGone": { zh: "这块看板已经删了(可能是在别的设备上)。", en: "This board has been deleted (perhaps on another device)." },
  "cols.roleLanding": { zh: "新卡落点", en: "New cards" },
  "cols.roleDone": { zh: "完成列", en: "Done" },
  "cols.boardSection": { zh: "这块看板", en: "This board" },
  "cols.landingLabel": { zh: "新卡落在", en: "New cards in" },
  "cols.doneLabel": { zh: "完成列", en: "Done column" },
  "cols.doneNone": { zh: "不设", en: "None" },
  "cols.doneHint": { zh: "卡进了完成列才算做完:记下完成时刻、能归档成成就。换完成列前,新旧两列都要先清空。", en: "A card counts as finished once it’s in the done column: the time is recorded and it can be archived. Before changing it, empty both the old and the new column." },
  "cols.doneNoneHint": { zh: "没有完成列:这块看板只分类、不完成 —— 卡上没有「完成」,也没有归档。", en: "No done column: this board just sorts cards — there’s no “complete” and no archive." },
  "cols.boardName": { zh: "看板名", en: "Name" },
  "cols.emptyBoardName": { zh: "看板名不能为空", en: "The board name can’t be empty" },
  "cols.deleteBoard": { zh: "删除这块看板", en: "Delete this board" },
  "cols.deleteBoardQ": { zh: "删除这块看板?", en: "Delete this board?" },
  "cols.newBoard": { zh: "+ 新建一块看板", en: "+ New board" },
  "cols.deleteBoardBlocked": { zh: "先把这块看板上的 {n} 张卡挪走", en: "Move this board’s {n} {n|card|cards} out first" },
});
