// notebook 壳(窗控/侧栏/空间菜单/加入与重置/深链接)+ space.ts + hotkey-menu + zoom 的文案分片。
import { defineMessages } from "./entry";

export const chrome = defineMessages({
  "notebook.maximize": { zh: "最大化", en: "Maximize" },
  // W4 Q11 / WD-38:「捕获窗」换白话「随手记小窗」(用户拍定的词表)。
  "notebook.capturedIdea": { zh: "小窗里记下了一条随记", en: "Saved a note from the quick-note window" },
  "notebook.capturedTask": { zh: "小窗里记下了一张卡片", en: "Saved a card from the quick-note window" },
  "notebook.restoreDown": { zh: "向下还原", en: "Restore down" },
  "notebook.expandSidebar": { zh: "展开侧栏 (Ctrl+B)", en: "Expand sidebar (Ctrl+B)" },
  "notebook.collapseSidebar": { zh: "折叠侧栏 (Ctrl+B)", en: "Collapse sidebar (Ctrl+B)" },
  "notebook.spaceNotOnDevice": { zh: "这条所在的空间不在这台设备上", en: "The space this item belongs to is not on this device" },
  "notebook.openFailed": { zh: "打开失败:{error}", en: "Could not open: {error}" },
  "notebook.itemNotFound": { zh: "找不到这条(可能已删除)", en: "Item not found (it may have been deleted)" },
  "notebook.clipboardLink": { zh: "剪贴板里有一条朱简链接", en: "There is a Zhujian link in the clipboard" },
  "notebook.open": { zh: "打开", en: "Open" },
  "notebook.close": { zh: "关闭", en: "Close" },
  // 全局快捷键被别的程序占着(W4 A6 / Q8 ★①):随记页顶上那条,点了直达设置「快捷键」页。与捕获窗那条同一句。
  "notebook.hotkeyBanner": { zh: "快捷键 {keys} 被别的程序占用,点此改键", en: "Shortcut {keys} is taken by another program — click here to change it" },
  // 第一次点 ✕(W4 A5,tray-hint.ts):✕ 实为藏进托盘,第一次先说清。托盘菜单的「退出」今天只有中文,
  // 故两种语言都说「最下面那一项」,不点它的名字。Windows 托盘左键单击不开窗(留给双击),故写「双击」。
  "notebook.trayHintTitle": { zh: "关掉窗口,朱简还开着", en: "Closing the window keeps Zhujian running" },
  "notebook.trayHintBody": { zh: "点 ✕ 只是把窗口收进屏幕右下角的托盘,朱简还在后台开着 —— 快捷键和截止提醒都要靠它。双击托盘里的朱简图标(可能收在 ^ 里)就能回来;要真退出,在那个图标上点右键,选最下面那一项「退出」。", en: "✕ only tucks the window into the tray at the bottom-right of the screen; Zhujian keeps running in the background — the shortcuts and due reminders need it. Double-click the Zhujian icon in the tray (it may be under ^) to bring it back; to really quit, right-click that icon and pick the last item in its menu." },
  "notebook.trayHintOk": { zh: "知道了,收进托盘", en: "Got it, hide to tray" },
  "notebook.joinPreparing": { zh: "准备中…", en: "Preparing…" },
  "notebook.joinPairing": { zh: "正在配对…", en: "Pairing…" },
  "notebook.joinBooting": { zh: "正在拉取账户数据…", en: "Fetching account data…" },
  "notebook.joinPublishing": { zh: "正在落成空间…", en: "Setting up the space…" },
  "notebook.joinIntegrating": { zh: "正在装入空间列表…", en: "Adding to the space list…" },
  "notebook.joinBootingProgress": { zh: "正在拉取账户数据 {received} / {total} MB", en: "Fetching account data {received} / {total} MB" },
  "notebook.joinWarnSuffix": { zh: "(注意:{warnings})", en: " (note: {warnings})" },
  "notebook.joinedStay": { zh: "已加入空间「{name}」{warn},保存或清空正在编辑的内容后,从空间菜单切换过去", en: "Joined space “{name}”{warn}; save or clear what you are editing, then switch over from the space menu" },
  "notebook.joined": { zh: "已加入空间「{name}」{warn}", en: "Joined space “{name}”{warn}" },
  // 161 / W4 Q13 ★①:加入回执旁那枚「改名」(没起过名 / 和这台某本同名时),直达空间菜单的改名那一行。
  "notebook.renameGo": { zh: "改名", en: "Rename" },
  "notebook.joinSpace": { zh: "加入空间(输入配对码)…", en: "Join a space (enter a pairing code)…" },
  "notebook.joinHint": { zh: "这会把对方账户里的本子作为一个新空间加到这台电脑,当前空间不受影响。想让现在这一本和对方合成同一本(两边内容合并),改用侧栏「同步」里的「用配对码加入」。", en: "This adds the other account's notebook to this computer as a new space; the current space is not affected. To merge the notebook you are in now with that account (contents from both sides combined), use “Join with a pairing code” under Sync in the sidebar instead." },
  // W4 A22(WD-13):「用配对码加入」那枚钮只在主空间、还没开同步时才有 —— 别的时候不再叫人去找它。
  "notebook.joinHintNoMerge": { zh: "这会把对方账户里的本子作为一个新空间加到这台电脑,当前空间不受影响,两本各是各的、不合并。", en: "This adds the other account's notebook to this computer as a new space; the current space is not affected, and the two stay separate." },
  "notebook.join": { zh: "加入", en: "Join" },
  "notebook.cancel": { zh: "取消", en: "Cancel" },
  "notebook.resetSpace": { zh: "重置当前空间…", en: "Reset current space…" },
  // 161 / W4 Q12(A40 / WP-13 的桌面对应):「旧设备身份请告知运营者吊销」是内部说法 ⇒ 换成用户自己做得到的那条路(值同手机 main.resetWarnSynced)。
  "notebook.resetWarnSynced": { zh: "将删除本机此空间的全部数据,不可恢复。确认另一台设备有在线完整副本后再继续;重置后可用「加入空间」重新加入,之后到一台管理设备的「设备名单」里把这台的旧身份移除。", en: "This deletes all data of this space on this device, irreversibly. Make sure another device has a complete copy online before continuing; afterwards you can rejoin via “Join a space”, then remove this device's old identity from Devices on an admin device." },
  // Q12:这一本已不在账户里(被移出 / 自己退出)时,点出之后记的那几条只在这里(值同手机 main.resetWarnGone)。
  "notebook.resetWarnGone": { zh: "将删除本机此空间的全部数据,不可恢复。这台不在账户里之后记的那几条只在这里、别处没有:先把它们复制出来再重置。重置后可以输码重新加入。", en: "This deletes all data of this space on this device, irreversibly. Anything noted here after this device left the account exists only here: copy it out before resetting. Afterwards you can rejoin with a pairing code." },
  "notebook.resetWarnLocalOnly": { zh: "此空间未开启同步,本机就是唯一副本。重置=永久删除这个本子的全部内容,没有任何地方可以找回。", en: "Sync is not enabled for this space; this device holds the only copy. Resetting permanently deletes everything in this notebook, with no way to get it back." },
  "notebook.resetConfirm": { zh: "确认重置", en: "Confirm reset" },
  "notebook.spaceNotLoaded": { zh: "此空间未装载", en: "This space is not loaded" },
  "notebook.newSpace": { zh: "＋ 新建空间", en: "+ New space" },
  "notebook.newSpacePh": { zh: "空间名(比如「家庭」)", en: "Space name (e.g. “Family”)" },
  "notebook.spaceCreated": { zh: "空间已创建,现在就能记录。想多端同步,到「同步」里创建账户。", en: "Space created. You can start noting right away. To sync across devices, create an account under Sync." },
  "notebook.renameSpace": { zh: "重命名当前空间", en: "Rename current space" },
  "notebook.renameSpacePh": { zh: "新名字", en: "New name" },
  // W3 159 / Q6(WD-17):切空间、改空间名做完都说一声(此前只有新建空间说话)。
  "notebook.switchedTo": { zh: "已切到「{name}」", en: "Switched to “{name}”" },
  "notebook.spaceRenamed": { zh: "空间已改名为「{name}」", en: "Space renamed to “{name}”" },
  "space.moved": { zh: "已移到「{name}」", en: "Moved to “{name}”" },
  // W3 159 / A12(WD-09):任务的列不随迁,一律落对方落点列的最上面 —— 回执说清落在哪、原来在哪。
  "space.movedTask": { zh: "已移到「{name}」,在「{col}」最上面", en: "Moved to “{name}”, at the top of “{col}”" },
  "space.movedTaskFrom": { zh: "已移到「{name}」,在「{col}」最上面(原来在「{from}」)", en: "Moved to “{name}”, at the top of “{col}” (it was in “{from}”)" },
  // W3 159 / Q4(WD-16 / WD-38):三处共用的移动面板(move-space.ts),照手机先说后果、选了空间再确认一拍。
  "space.moveTitle": { zh: "移到别的空间", en: "Move to another space" },
  "space.moveWarnPre": { zh: "移到别的空间 = 那边新生一条、这边不留;", en: "Moving to another space creates a new one there and keeps nothing here; " },
  "space.moveWarnBold": { zh: "编辑历史会随移动永久删除,不迁入目标空间", en: "the edit history is permanently deleted and does not come along" },
  "space.moveWarnPost": { zh: "。", en: "." },
  // ⚠ 这句不写列名:列能改名,落点列叫什么要读**对方**空间(选了空间后问句里点名,move-space.ts::pick)。
  "space.moveColNote": { zh: "列不随迁:卡片到了那边一律落在新卡片进的那一列,排最上面。", en: "Columns don’t come along: over there a card always lands at the top of the column new cards go into." },
  // 165 / W5 A19(WD-21):这一行此前只写「移到」—— 看板菜单里换列那项也叫「移到」,换空间的面板里写全是哪种「移到」。
  "space.moveTo": { zh: "移到空间", en: "Move to space" },
  "space.moveQ": { zh: "移到「{name}」?", en: "Move to “{name}”?" },
  "space.moveQTask": { zh: "移到「{name}」?会落在那边「{col}」的最上面。", en: "Move to “{name}”? It lands at the top of “{col}” there." },
  "space.moveQTaskFrom": { zh: "移到「{name}」?会落在那边「{col}」的最上面,原来在「{from}」。", en: "Move to “{name}”? It lands at the top of “{col}” there; it is in “{from}” now." },
  "space.moveYes": { zh: "确认移动", en: "Move it" },
  "space.moveCancel": { zh: "取消", en: "Cancel" },
  "space.moveGotIt": { zh: "知道了(刷新)", en: "Got it (refresh)" },
  "space.copiedSourceKept": { zh: "已复制到目标空间,但原条目删除未执行:{reason}。两边各有一份,确认后可手动删除本条", en: "Copied to the target space, but the original was not deleted: {reason}. Both sides now have a copy; verify, then delete this one manually" },
  "space.copiedSourceUnconfirmed": { zh: "已复制到目标空间,但删除原条目时出错(原条目状态未知):{error}。请核对两边,勿重复移动", en: "Copied to the target space, but deleting the original failed (its state is unknown): {error}. Check both sides; do not move it again" },
  "space.imagesPending": { zh: "有 {count} 张配图的字节还没同步到齐,稍后再移", en: "{count} attached {count|image|images} {count|has|have} not fully synced yet, try moving later" },
  "space.imageRef": { zh: "图{n}", en: "Image {n}" },
  "space.listSep": { zh: "、", en: ", " },
  // W3 159 / A2(WD-01):说清为什么挪不动、怎么办 —— 那张图已彻底删掉,而正文(含标题那行)里随手写的「图N」也算引用。
  "space.danglingRefs": { zh: "挪不动:正文里写着「{refs}」,可那张图已经彻底删掉了 —— 正文或标题里随手写的「图N」也算引用。把正文里的「{refs}」改个写法,再移动。", en: "Can’t move this: the text mentions {refs}, but that image has been deleted for good — any image mention written in the text or title counts as a reference. Reword {refs} in the text, then move it." },
  "space.mainSuffix": { zh: "(默认空间)", en: " (default space)" },
  "space.defaultName": { zh: "默认空间", en: "Default space" },
  "space.unnamedName": { zh: "未命名空间 · {id}", en: "Unnamed space · {id}" },
  // 161 / W4 Q12 ★①:已不在账户里的那一本,空间菜单那一行与侧栏「同步」后面标这一句(键名与值同手机,登记 CROSS_END_KEYS)。
  "main.tagUnsynced": { zh: "已不再同步", en: "No longer syncing" },
  // 161 / W4 Q13 ★① = A44(WP-07 / X-01):主空间从没起过名时屏上叫「默认空间」,可这个名字不跟着走 —— 别的设备加入后叫「未命名空间 · XXXX」。空间菜单里标出来;⛔ 不落名字(space-entry-plan §3.6)。
  "notebook.unnamedMark": { zh: "(未起名)", en: " (no name yet)" },
  "notebook.unnamedMarkTitle": { zh: "这一本从没起过名:「默认空间」只是这台上的叫法,别的设备加入后它叫「未命名空间 · 四位码」。想到哪儿都叫同一个名,点「重命名当前空间」起一个。", en: "This notebook has never been named: “Default space” is only what this computer calls it; on a device that joins it, it shows as “Unnamed space · code”. To have one name everywhere, use “Rename current space”." },
  "hotkeyMenu.actionsTitle": { zh: "操作(点开,或悬停卡片按 / 键)", en: "Actions (click to open, or hover the card and press /)" },
  "zoom.badge": { zh: "界面字号 {percent}%{limit}", en: "Text size {percent}%{limit}" },
  // 621:半角括号是本仓家风(zh 值里紧贴汉字的括号 171 处半角、全角只有这两条),收齐。
  "zoom.atMax": { zh: "(已到最大)", en: " (at maximum)" },
  "zoom.atMin": { zh: "(已到最小)", en: " (at minimum)" },
});
