// src/settings.ts(设置面板)的文案分片。
import { defineMessages } from "./entry";

export const settings = defineMessages({
  "settings.title": { zh: "设置", en: "Settings" },
  // W4 Q6 ★①:「通用」最上面那一节「空间」(同手机 W3 Q7 那一行;钮名用 shell.spacesEntry「空间…」)。
  "settings.spacesTitle": { zh: "空间", en: "Spaces" },
  "settings.spacesSub": { zh: "每个空间是一本独立的本子。新建、切换、改名、加入别处的空间,都在这里。", en: "Each space is a separate notebook. Create, switch, rename, or join one from elsewhere here." },
  // 左栏分类(445)。⭐ 445 定只分 3 类(4 个小节里有 3 个只有一两行,分细了是另一种难看);
  // 第四类「关于」(settings.catAbout,在本文件末尾)是盈利准备 C7 / C10 加的。
  // 「快捷键」一词两处共用(左栏那枚按钮 + 右栏那一节的标题),刻意同一个键 —— 两处说的
  // 就是同一件事,分成两个键迟早会漂。
  "settings.catGeneral": { zh: "通用", en: "General" },
  "settings.catBackup": { zh: "备份与恢复", en: "Backup & restore" },
  // 标题行的 ✕(2026-08-31 用户点名「只能点面板外关」——Esc 与点外面一直能关,缺的是看得见的入口)。
  "settings.closeTitle": { zh: "关闭", en: "Close" },
  // 「说明 ▸」折叠(2026-08-31 用户拍板「收纳不删」):长段说明默认收起、点开全文。
  "settings.notes": { zh: "说明", en: "Details" },
  "settings.hotkeysTitle": { zh: "快捷键", en: "Shortcuts" },
  "settings.hotkeysIntro": { zh: "在任何程序里都能唤起朱简。和别的软件撞了,就在这里换一个。", en: "Summon Zhujian from inside any program. If a shortcut clashes with another app, change it here." },
  // W4 Q11 / WD-38:内部说法换白话(用户拍定的词表):「捕获窗」→「随手记小窗」、「修饰键」→ 点名是哪几个键。
  "settings.captureWin": { zh: "随手记小窗", en: "Quick-note window" },
  "settings.captureWinDesc": { zh: "从任何地方弹出快速记录窗", en: "Pop up the quick capture slip from anywhere" },
  "settings.notebookWin": { zh: "主窗", en: "Main window" },
  "settings.notebookWinDesc": { zh: "从任何地方唤起朱简主窗口", en: "Bring up the Zhujian main window from anywhere" },
  "settings.recordHintMac": { zh: "点「更改」后,先按住 Cmd、Ctrl 或 Option,再按一个字母或数字;Esc 取消。", en: "After clicking Change, hold Cmd, Ctrl or Option, then press a letter or digit; Esc cancels." },
  "settings.recordHint": { zh: "点「更改」后,先按住 Ctrl、Alt 或 Shift,再按一个字母或数字;Esc 取消。", en: "After clicking Change, hold Ctrl, Alt or Shift, then press a letter or digit; Esc cancels." },
  "settings.appearance": { zh: "外观", en: "Appearance" },
  // W4 Q11 / X-10:外观 / 语言 / 字号各写一句只影响这台电脑(手机每项都写着)。
  "settings.appearanceSub": { zh: "「自动」跟随系统。只影响这台电脑,不会同步。", en: "Auto follows the system. This computer only; it doesn’t sync." },
  "settings.themeAuto": { zh: "自动", en: "Auto" },
  "settings.themeLight": { zh: "亮", en: "Light" },
  "settings.themeDark": { zh: "暗", en: "Dark" },
  "settings.langTitle": { zh: "语言", en: "Language" },
  // 898 B2:这一句常显,其余几句一字不动地住进 settings.langMore(行下那只「说明」折叠)。
  "settings.langSub": { zh: "界面语言。「自动」跟随系统;改档后窗口会重新加载,回来还停在这一行。", en: "Interface language. Auto follows the system; windows reload after switching and you land back on this row." },
  "settings.langMore": { zh: "只影响这台电脑,不会同步。", en: "This computer only; it doesn’t sync." },
  "settings.langAuto": { zh: "自动", en: "Auto" },
  "settings.langZh": { zh: "中文", en: "中文" },
  "settings.langEn": { zh: "English", en: "English" },
  "settings.textSize": { zh: "界面字号", en: "Text size" },
  "settings.textSizeSub": { zh: "也可用 Ctrl + / Ctrl - 调节,Ctrl 0 复位。只影响这台电脑,不会同步。", en: "Ctrl + / Ctrl - also adjust; Ctrl 0 resets. This computer only; it doesn’t sync." },
  "settings.zoomReset": { zh: "复位", en: "Reset" },
  // W4 A21(WD-12 / WD-29):那一行下面常在一句 —— 平时写范围,到头写「已到最大 / 最小」(两头一样),钮同时变灰。
  "settings.zoomRange": { zh: "可调 {min}% 到 {max}%", en: "From {min}% to {max}%" },
  "settings.zoomAtMax": { zh: "已到最大({p}%)", en: "At the largest ({p}%)" },
  "settings.zoomAtMin": { zh: "已到最小({p}%)", en: "At the smallest ({p}%)" },
  "settings.zoomIn": { zh: "放大", en: "Larger" },
  "settings.zoomOut": { zh: "缩小", en: "Smaller" },
  "settings.compressTitle": { zh: "压缩大图", en: "Compress large images" },
  // 898 B2:这一句常显,其余几句一字不动地住进 settings.compressMore(行下那只「说明」折叠)。
  "settings.compressSub": { zh: "默认关:按原图保存,截图里的字清清楚楚。", en: "Off by default: images are saved as-is, so text in screenshots stays sharp." },
  "settings.compressMore": { zh: "打开后,存图前会把大照片缩小并转成 JPEG,省同步流量和空间,但画质有损、原图找不回来;长截图不会被压成窄条。已存的图不受影响。只影响这台设备。", en: "When on, large photos are shrunk and re-saved as JPEG first—less sync traffic and storage, but lossy, and the original can’t be recovered; long screenshots are never squeezed into a thin strip. Images already saved aren’t affected. This device only." },
  "settings.compressOn": { zh: "开", en: "On" },
  "settings.compressOff": { zh: "关", en: "Off" },
  // 158 G3 / Q6(WD-18):看板删除确认里勾过「不再提示」后,在这里改回来。
  "settings.deleteConfirmTitle": { zh: "删卡片前确认", en: "Confirm before deleting a card" },
  // 898 B2:这一句常显,其余几句一字不动地住进 settings.deleteConfirmMore(行下那只「说明」折叠)。
  "settings.deleteConfirmSub": { zh: "开着时,在看板上删一张卡片会先问一句(删了也只是进回收站)。", en: "When on, deleting a card on the board asks first (deleted cards go to the Trash either way)." },
  "settings.deleteConfirmMore": { zh: "在那句确认里勾过「不再提示」,这里就是关;想再被问,点「开」。只影响这台设备。", en: "Ticking “Don’t ask again” in that question turns this off; click On to be asked again. This device only." },
  "settings.deleteConfirmOn": { zh: "开", en: "On" },
  "settings.deleteConfirmOff": { zh: "关", en: "Off" },
  "settings.deleteConfirmSaveFailed": { zh: "没存上(这台设备的本地存储写不进去),下次照旧", en: "Couldn’t save (this device’s local storage refused the write); nothing changed" },
  "settings.aliasTitle": { zh: "本机别名", en: "Device alias" },
  // 161 / W4 Q11(WD-35 后半 / WP-21):说清是按空间分别起的(加入一个新空间后别名框是空的,像之前白起了)。同手机 shell.aliasNotePost。
  // 898 B2:这一句常显,其余几句一字不动地住进 settings.aliasMore(行下那只「说明」折叠)。
  "settings.aliasSub": { zh: "给这台设备起个名字,比如「书房台式机」,别的设备上就能看出每条是哪台记的。", en: "Name this device, e.g. “Study desktop”, so your other devices can tell which one wrote each entry." },
  "settings.aliasMore": { zh: "名字会同步给这个空间里的其他设备;每个空间分别起。", en: "The name syncs to the other devices in this space; each space has its own." },
  "settings.aliasUnnamed": { zh: "未命名", en: "Unnamed" },
  "settings.thisDevice": { zh: "本机 · {id}", en: "This device · {id}" },
  // A14(WD-35 前半):存好别名后框下那行跟着换(此前仍只写编号)。
  "settings.thisDeviceNamed": { zh: "本机 · {name} · {id}", en: "This device · {name} · {id}" },
  // 意见反馈(国内上架 17)。手机那半的键名叫 `feedback.*`(它在静态壳里自成一节),
  // 这边跟着通用页那一族叫 `settings.feedback*` —— 两端说同一件事、措辞按各自承载走,
  // ⛔ 别去 CROSS_END_KEYS 登记(那张表只列真该逐字相同的筛选 pill)。
  // ⚠ 邮箱地址是 src/settings.ts 里的 FEEDBACK_MAIL,**不是文案**:它不随语言变。
  "settings.feedbackTitle": { zh: "意见反馈", en: "Feedback" },
  "settings.feedbackSub": { zh: "用着有问题、有建议,或者想注销同步账户,发邮件到下面这个地址。作者本人看信。", en: "Found a problem, have a suggestion, or want to close your sync account? Email the address below. The author reads it personally." },
  // W4 Q11 / WD-33:地址做成链接,点了拉起写信(mailto:,走壳的打开外链那条路);拉不起照实说。
  "settings.feedbackMailTitle": { zh: "点了用默认的邮件程序写信", en: "Opens your default email app" },
  "settings.feedbackMailFailed": { zh: "没能打开写信:{error}。地址可以复制下来,在你自己的邮箱里发。", en: "Couldn’t open an email app: {error}. Copy the address and send from your own mailbox." },
  "settings.aliasCleared": { zh: "已清除别名", en: "Alias cleared" },
  "settings.aliasSaved": { zh: "已保存,会同步到其他设备", en: "Saved, will sync to your other devices" },
  "settings.change": { zh: "更改", en: "Change" },
  "settings.pressNewHotkey": { zh: "按下新快捷键…", en: "Press the new shortcut…" },
  "settings.needModifier": { zh: "要先按住 Ctrl、Alt 或 Shift 中的一个", en: "Hold Ctrl, Alt or Shift first" },
  "settings.keyUnsupported": { zh: "这个键不支持,换一个", en: "That key is not supported, try another" },
  "settings.keysTitle": { zh: "应用里的单键", en: "Keys inside the app" },
  // W5 A7:焦点停在卡上(Tab 到它的 ⋯)也算选中这张 —— 此前表头只说悬停 / ↑ ↓,焦点在 ⋯ 上按键作用到的是别的卡。
  "settings.keysIntro": { zh: "鼠标悬停在卡片上、用 ↑ ↓ 选中,或 Tab 到卡上的 ⋯,直接按一个键就行,不用同时按住 Ctrl 或 Alt。", en: "Hover over a card, pick one with ↑ ↓, or Tab to its ⋯, then press a single key — no Ctrl or Alt needed." },
  "settings.keysGroupPick": { zh: "选卡", en: "Picking a card" },
  "settings.keysGroupIdea": { zh: "随记卡片", en: "Note cards" },
  "settings.keysGroupBoard": { zh: "看板卡片", en: "Board cards" },
  "settings.keysGroupDoc": { zh: "长文", en: "Long-form" },
  "settings.keysGroupTrash": { zh: "回收站里的卡(随记、看板两个回收站一样)", en: "Cards in the trash (same in both trashes)" },
  "settings.keysGroupView": { zh: "不用选卡", en: "No card needed" },
  "settings.keysGroupEdit": { zh: "编辑正文时", en: "While editing text" },
  "settings.keysArrows": { zh: "上一张 / 下一张", en: "Previous / next card" },
  // W5 Q10:看板 ← → 换列(选中跳到隔壁列最上面那张)。
  "settings.keysLanes": { zh: "看板:跳到左边 / 右边一列最上面那张", en: "Board: jump to the top card of the column on the left / right" },
  // W5 A13:H / V 只在改过的卡上有(此前表里没写,没改过的按了一声不吭)。
  "settings.keysHistoryRevised": { zh: "历史(改过的卡才有)", en: "History (only on edited cards)" },
  "settings.keysSlash": { zh: "打开这张卡的菜单(忘了键就看这里)", en: "Open this card’s menu (lists its keys)" },
  "settings.keysDblclickKey": { zh: "双击", en: "Double-click" },
  "settings.keysToTask": { zh: "转待办", en: "Make a task" },
  "settings.keysMoveSpace": { zh: "移到别的空间", en: "Move to another space" },
  "settings.keysNextCol": { zh: "移到右边一列", en: "Move to the next column" },
  "settings.keysPrevCol": { zh: "移到左边一列", en: "Move to the previous column" },
  "settings.keysSeal": { zh: "归档(已完成的卡)", en: "Archive (done cards)" },
  "settings.keysRevert": { zh: "撤回为随记(待办列的卡)", en: "Send back to Notes (to-do cards)" },
  // 165 / W5 Q7:同一根轴上的一进一出(同 A 归档 / 取消归档):不在「已完成」的卡 = 完成,已完成的卡 = 打回第一列。
  "settings.keysComplete": { zh: "完成(已完成的卡:打回「待办」)", en: "Mark done (on a done card: back to To do)" },
  "settings.keysColorDigits": { zh: "卡片颜色;0 清除", en: "Card color; 0 clears it" },
  "settings.keysIdeaCompose": { zh: "随记页:跳到输入框", en: "Notes: jump to the input box" },
  "settings.keysBoardCompose": { zh: "看板:新建卡片", en: "Board: new card" },
  "settings.keysBoardTrash": { zh: "看板:打开 / 收起回收站(指针停在回收站的卡上时,R 是还原那张)", en: "Board: show / hide the trash (with the pointer on a card in the trash, R restores it)" },
  "settings.keysBoardSealed": { zh: "看板:打开 / 收起归档", en: "Board: show / hide the archive" },
  "settings.keysTopicCreate": { zh: "标签页:新建标签", en: "Tags: new tag" },
  "settings.keysTopicMerge": { zh: "标签页:合并标签", en: "Tags: merge tags" },
  "settings.keysDocCompose": { zh: "长文页:新建长文", en: "Long-form: new long-form note" },
  "settings.keysViews": { zh: "切换视图(依侧栏顺序:随记 / 看板 / 长文 / 标签 / 搜索)", en: "Switch view (in sidebar order: Notes / Boards / Long-form / Tags / Search)" },
  "settings.keysSearch": { zh: "打开搜索(光标进搜索框)", en: "Open search (cursor in the search box)" },
  // W5 A1 / Q15:全局那几枚(notebook.ts 的文档级监听)。
  "settings.keysUndo": { zh: "撤销刚才那一下(屏幕下方回执还在、带「撤销」时)", en: "Undo the last action (while its notice with “Undo” is still showing)" },
  "settings.keysSettings": { zh: "打开设置", en: "Open settings" },
  "settings.keysSidebar": { zh: "收起 / 展开侧栏", en: "Collapse / expand the sidebar" },
  "settings.keysEnter": { zh: "保存", en: "Save" },
  // W5 Q15(WD-33):光标停在待办行上时回车是续一行,想直接记下 / 保存按这枚(此前表里没列)。
  "settings.keysCtrlEnter": { zh: "记下 / 保存(光标在待办行上也一样)", en: "Note it / save (even on a checklist line)" },
  "settings.keysShiftEnter": { zh: "换行(在待办行里接着起一行)", en: "New line (continues a checklist)" },
  "settings.keysEsc": { zh: "放弃这次修改", en: "Discard the edit" },
  "settings.keysChecklist": { zh: "把这一行变成待办 / 变回来", en: "Turn the line into a checklist item and back" },
  "settings.keysIndent": { zh: "待办行缩进 / 退回", en: "Indent / outdent checklist items" },
  "settings.keysPaste": { zh: "贴图(剪贴板里的图片直接成配图)", en: "Paste an image from the clipboard" },
  "settings.keysFoot": { zh: "归档里的卡片键不一样:选中后按 / 看它自己能按哪些。", en: "Cards in the archive have their own keys: pick one and press / to see them." },
  // W4 Q11 / WD-34:搜索页那几枚(search.ts 的监听里,不在 keymap 的单键表上)。
  "settings.keysGroupSearch": { zh: "搜索页", en: "Search" },
  "settings.keysSearchArrows": { zh: "在搜索框和结果之间上下走", en: "Move between the search box and the results" },
  "settings.keysSearchEnter": { zh: "跳到这一条", en: "Go to this result" },
  "settings.keysSearchEsc": { zh: "在结果上:回到搜索框;在搜索框里:清空", en: "On a result: back to the search box; in the box: clear it" },
  // W5 Q11:点进一条结果之后,在落点那页按 Esc 回搜索。
  "settings.keysSearchBack": { zh: "跳过去之后:回到搜索(词和结果都在)", en: "After jumping to a result: back to search (query and results kept)" },
  "settings.autostartTitle": { zh: "开机自动启动", en: "Start at login" },
  "settings.autostartSub": { zh: "开机后朱简悄悄待在托盘里,热键和截止提醒一开机就能用。", en: "Zhujian waits quietly in the tray after you log in, so the shortcuts and due reminders work right away." },
  "settings.autostartOn": { zh: "开", en: "On" },
  "settings.autostartOff": { zh: "关", en: "Off" },
  "settings.hotkeyUpdated": { zh: "已更新,立即生效", en: "Updated, effective immediately" },
  // W4 A6 / Q8 ①:被别的程序占着、按了没反应的那枚键帽旁。
  "settings.hotkeyTakenTag": { zh: "没生效:被占用", en: "Not working: taken" },
  // W4 A2:改键失败只可能是**新按的这一枚**注册不上了(另一枚不再连带重注册),说清是哪一枚、为什么。
  "settings.hotkeyTaken": { zh: "「{name}」没换成:{key} 被别的程序占着(也可能是系统保留的组合),换一个再试。", en: "“{name}” wasn’t changed: {key} is taken by another program (or reserved by the system). Try another one." },
  // 「关于」一类(盈利准备 C7 + C10,src/about.ts)。版本那一行此前住同步面板(`sync.checkUpdate` 等),
  // 搬家时换了键名前缀,措辞一字没动。链接的词与官网页脚逐字一致(site/index.html 的 foot.* / nav.source),更新日志的英文除外(见该键)。
  "settings.catAbout": { zh: "关于", en: "About" },
  "settings.aboutSub": { zh: "这台电脑上装的是哪一版。有新版时启动会自动提示,也可以在这里手动查。", en: "Which version is installed on this computer. Zhujian tells you about new versions at startup; you can also check here." },
  // 作者一句(2026-09-25 用户拍板「更像真人」)。「意见反馈」= settings.feedbackTitle 的真名,那边改名这里跟着改。
  // W4 Q11 / WD-33:「意见反馈」几个字做成链接、点了跳到通用页那一节 ⇒ 拆成三段(同手机 shell.aboutAuthorPre / Link / Post,逐字同)。
  "settings.aboutAuthorPre": { zh: "朱简是我一个人做的。好用、不好用,都欢迎在", en: "I build Zhujian on my own. Whether it works for you or not, tell me through " },
  "settings.aboutAuthorLink": { zh: "「意见反馈」", en: "Feedback" },
  "settings.aboutAuthorPost": { zh: "里告诉我。", en: "." },
  "settings.checkUpdate": { zh: "检查更新", en: "Check for updates" },
  // 构建身份戳(701)。⚠ 两枚键而不是「主串 + 拼一个后缀」:拼接过的译文在别的语言里
  // 语序未必还成立,而这两句各自是一句完整的话。
  "settings.buildStamp": { zh: "构建 {commit} · {at}", en: "Build {commit} · {at}" },
  "settings.buildDirty": { zh: "构建 {commit} · {at} · 含未提交改动", en: "Build {commit} · {at} · uncommitted changes" },
  "settings.linksTitle": { zh: "链接", en: "Links" },
  "settings.linksSub": { zh: "都在浏览器里打开。", en: "These open in your browser." },
  "settings.linkSite": { zh: "官网", en: "Website" },
  "settings.linkSource": { zh: "源码", en: "Source" },
  // 更新日志页只有中文;官网页脚写的是 "Changelog (Chinese)",这里照派活原文取 "Changelog"。
  "settings.linkChangelog": { zh: "更新日志", en: "Changelog" },
  "settings.linkGuide": { zh: "用户指南", en: "User guide" },
  "settings.linkTerms": { zh: "用户协议", en: "Terms" },
  "settings.linkPrivacy": { zh: "隐私政策", en: "Privacy" },
  "settings.linkRights": { zh: "隐私权利", en: "Your rights" },
  "settings.diagTitle": { zh: "诊断", en: "Diagnostics" },
  "settings.diagSub": { zh: "出了问题时用。最下面那一行会把这一页的版本、本机库和网络自检结果抄成一段文字,贴进反馈邮件就行。", en: "For when something goes wrong. The last row copies the version, local database and network check on this page as one block of text — paste it into your feedback email." },
  "settings.diagDb": { zh: "本机库(当前空间)", en: "Local database (current space)" },
  "settings.diagMigration": { zh: "迁移版本", en: "Schema version" },
  "settings.diagItems": { zh: "条目数", en: "Entries" },
  "settings.diagPath": { zh: "路径", en: "Path" },
  "settings.diagDbFailed": { zh: "读不出本机库:{error}", en: "Couldn't read the local database: {error}" },
  "settings.probeTitle": { zh: "网络自检", en: "Network check" },
  "settings.probeDesc": { zh: "逐项跑一遍同步用的加密与连接,看卡在哪一步。", en: "Runs each step of the encryption and connection that sync uses, to see where it gets stuck." },
  "settings.probeRun": { zh: "开始", en: "Run" },
  "settings.probeRunning": { zh: "正在检查…", en: "Checking…" },
  "settings.probeFailed": { zh: "自检没跑成:{error}", en: "The check didn't run: {error}" },
  "settings.probeNotRun": { zh: "没跑过", en: "Not run" },
  "settings.logTitle": { zh: "日志文件夹", en: "Log folder" },
  "settings.logDesc": { zh: "程序的运行记录,最多两份、每份 2 MB。反馈问题时可以把里面的文件一起附上。", en: "The app's running log: at most two files of 2 MB each. Attach them when you report a problem." },
  "settings.logOpen": { zh: "打开", en: "Open" },
  "settings.copyDiagTitle": { zh: "诊断信息", en: "Diagnostic info" },
  // W4 Q5 ★①(WD-39):复制出来带完整设备编号和含电脑用户名的路径,复制前说清。
  "settings.copyDiagDesc": { zh: "版本、构建、本机库和最近一次网络自检,抄成一段文字。含设备编号和本机文件路径(带电脑用户名),不含内容和密钥。", en: "Version, build, local database and the latest network check, as one block of text. It includes the device ID and local file paths (with your computer user name), but none of your content or keys." },
  // 网络自检的人话结论(W4 Q5 ★①):六行术语上面那一句,只看「连没连上」那一项。
  // ⚠ 两枚**两端逐字同**(手机诊断页用同一对键、同一句),改一端必须改另一端。
  "probe.verdictOk": { zh: "能连上 {url}。", en: "Reached {url}." },
  "probe.verdictFail": { zh: "连不上 {url}:看看地址对不对、服务器开没开、网络通不通。", en: "Couldn't reach {url}: check the address, whether the server is running, and your network." },
});
