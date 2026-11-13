// 壳(android/index.html)的静态文案:markup 里保留中文原文防首帧闪(163 契约),
// 启动 applyStaticI18n 覆写;原文与这里 zh 值的逐字相等由 check-i18n-drift 核。
// ⚠ 壳里另有几处刻意**复用 TS 侧的键**(JS 随后会覆写同一个节点,两处说同一句话
// 就该是同一枚键):空间徽章 api.defaultSpace / 同步面标题 main.syncTitle /
// 捕获框 placeholder main.composeIdeaPh / 诊断两格 main.diagLoading·main.probeIdle /
// 加入与创号三钮 sync.join·sync.createAccount·sync.altCreateMain·sync.addDevice /
// 语言三档 settings.*。
import { defineMessages } from "./entry";

export const shell = defineMessages({
  "shell.appName": { zh: "朱简", en: "Zhujian" },
  "shell.navIdeas": { zh: "随记", en: "Notes" },
  "shell.navTasks": { zh: "看板", en: "Boards" },
  "shell.navTags": { zh: "标签", en: "Tags" },
  "shell.navSearch": { zh: "搜索", en: "Search" },
  "shell.navDocs": { zh: "长文", en: "Long-form" },
  "shell.navTrash": { zh: "回收站", en: "Trash" },
  "shell.navSealed": { zh: "归档", en: "Archive" },
  "shell.sync": { zh: "同步", en: "Sync" },
  "shell.settings": { zh: "设置", en: "Settings" },
  "shell.updateGo": { zh: "下载", en: "Download" },
  "shell.updateLater": { zh: "稍后", en: "Later" },
  "shell.spacesTitle": { zh: "空间", en: "Spaces" },
  "shell.newSpacePh": { zh: "新空间的名字(比如「家庭」)", en: "Name for the new space (e.g. “Family”)" },
  "shell.spaceCreate": { zh: "新建", en: "Create" },
  "shell.joinScan": { zh: "加入空间(扫电脑二维码)", en: "Join a space (scan the computer's QR code)" },
  // 161 / W4 Q15 / Q1:两端一个叫法 —— 另加一本 =「加入空间(输入配对码)」(= 桌面空间菜单那一项),把这台接进同一本 =「用配对码加入」。
  "shell.joinAlt": { zh: "加入空间(输入配对码)", en: "Join a space (enter a pairing code)" },
  // Q1 ★①(WM-01 / WM-15 / N-3):这一组是「另加一本」,说明第一句先说清(此前两组扫码 / 输码长得一样,选错的人以为同步没成、东西丢了)。
  // 165 / W5(O1 回报,与 A34 同一类):平板上也是这一句 ⇒ 不点名设备形,「这台设备」。
  "shell.joinNote": { zh: "加入空间 = 另成一本,这台设备上现在这本不会并进去;想和另一台设备看同一本,去「同步」。", en: "Joining a space adds a separate notebook; the one on this device now is not merged into it. To see the same notebook as another device, go to Sync." },
  "shell.serverPh": { zh: "服务器地址(wss://…)", en: "Server address (wss://…)" },
  // 161 / W4 Q2 / A50(WM-16 / WP-22):地址框与配对码框都有标签(此前只有灰字占位,框里一有字就看不出是什么)。
  "shell.serverLabel": { zh: "服务器地址", en: "Server address" },
  "shell.codeLabel": { zh: "配对码", en: "Pairing code" },
  // A27(WM-21):输之前就让人知道长什么样(此前要输错一次才知道,报错里还是「槽号」)。
  "shell.codePh": { zh: "形如 123456789-XXXX-XXXX", en: "like 123456789-XXXX-XXXX" },
  "shell.joinCancel": { zh: "取消加入", en: "Cancel joining" },
  // 161 / W4 A33 / Q11(WM-33):「逐空间追赶一次」改大白话;降成白钮(index.html)。
  "shell.syncAll": { zh: "全部同步(开了同步的每一本各连一次)", en: "Sync all (connects each synced notebook once)" },
  // 「并进当前空间 vs 另开一个空间」要讲清(用户面 121):旧句「要把别处的账户带到手机,用
  // 「加入空间」」把**全新手机**也往另开空间引 —— 它该走「同步」里的扫码,让主空间并进电脑的账户。
  "shell.spacesNote": { zh: "每个空间是一本独立的本子,记录落在当前空间。要让某一本在几台设备上同步,到那一本的「同步」里创建账户。", en: "Each space is a separate notebook; new entries land in the current space. To sync a notebook across devices, create an account under that notebook's Sync." },
  "shell.syncScan": { zh: "扫码连接电脑", en: "Scan to connect a computer" },
  "shell.syncAltPair": { zh: "用配对码加入", en: "Join with a pairing code" },
  "shell.syncManualNote": { zh: "在另一台设备朱简的「同步」里点「添加设备」,把服务器地址和配对码填到上面。", en: "On the other device, open Sync in Zhujian and tap Add device, then fill in the server address and pairing code above." },
  "shell.syncCreateNote": { zh: "把本机创建为账户的第一台设备。创建后请尽快让另一台设备加入;加入前唯一副本只在本机。", en: "Make this device the first one in a new account. Have another device join soon after; until it does, the only copy lives here." },
  "shell.copyPair": { zh: "复制服务器地址和配对码", en: "Copy server address and pairing code" },
  "shell.connInfo": { zh: "连接信息", en: "Connection info" },
  "shell.bgNote": { zh: "后台不保证实时,回到前台会继续追赶。", en: "Background sync is not guaranteed to be live; it catches up when you come back to the app." },
  "shell.spacesEntry": { zh: "空间…", en: "Spaces…" },
  "shell.searchPh": { zh: "搜索…", en: "Search…" },
  "shell.searchGo": { zh: "搜", en: "Go" },
  "shell.trashNote": { zh: "删掉的随记(含长文)、卡片和配图先到这里,随记与卡片分两段、各清各的;还原回到原来的位置(配图回到原编号);彻底删除后无法找回。", en: "Deleted notes (long-form included), cards and images land here first, in two sections that are emptied separately; restoring puts them back where they were (images keep their number); deleting forever cannot be undone." },
  "shell.sealedNote": { zh: "归档的卡片在这里,可查、不可删。", en: "Archived cards live here. You can look them up, not delete them." },
  // ⚠ 末句(点条数)刻意排在「都会同步」之后:那一条是**只读**的,不产生任何 op,
  //   混进前面那串会让人以为「看一眼」也会同步出去。
  "shell.topicsNote": { zh: "点名字改名、删除、设类型,点色点改颜色,点条数看标签下有什么;拖 ⠿ 调顺序。这些都会同步到别的设备。", en: "Tap a name to rename, delete or set its kind; tap the dot to change color; tap the count to see what’s under a tag; drag ⠿ to reorder. All of this syncs to your other devices." },
  "shell.addImage": { zh: "＋ 加图", en: "＋ Image" },
  "shell.takePhoto": { zh: "＋ 拍照", en: "＋ Photo" },
  "shell.insertTodo": { zh: "＋ 清单", en: "＋ Checklist" },
  "shell.composeDoc": { zh: "长文", en: "Long-form" },
  "shell.saveIt": { zh: "记下", en: "Note it" },
  "shell.captureAria": { zh: "记一笔", en: "Note something" },
  "shell.commentsTitle": { zh: "留言", en: "Comments" },
  "shell.close": { zh: "关闭", en: "Close" },
  "shell.loadMore": { zh: "加载更多", en: "Load more" },
  "shell.commentPh": { zh: "写句话…", en: "Say something…" },
  "shell.commentSend": { zh: "记下", en: "Post" },
  "shell.filterPh": { zh: "过滤…", en: "Filter…" },
  "shell.tagsExpand": { zh: "摊开全部标签", en: "Show all tags" },
  // 906:收起态那枚钮量不出「还藏着几枚」时不带数的那一形(带数的走 filter.more)。
  "shell.tagsMore": { zh: "更多", en: "More" },
  "shell.tagsCollapse": { zh: "收起标签行", en: "Collapse tag row" },
  "shell.appearance": { zh: "外观", en: "Appearance" },
  "shell.themeAuto": { zh: "自动", en: "Auto" },
  "shell.themeLight": { zh: "亮", en: "Light" },
  "shell.themeDark": { zh: "暗", en: "Dark" },
  "shell.appearanceNote": { zh: "「自动」跟随系统。只影响这台设备。", en: "Auto follows the system. This device only." },
  "shell.textSize": { zh: "界面字号", en: "Text size" },
  "shell.size90": { zh: "小", en: "Small" },
  "shell.size100": { zh: "标准", en: "Default" },
  "shell.size115": { zh: "大", en: "Large" },
  "shell.size130": { zh: "特大", en: "Largest" },
  "shell.textSizeNote": { zh: "在系统字号的基础上叠加。只影响这台设备。", en: "Applied on top of the system font size. This device only." },
  "shell.aliasTitle": { zh: "本机别名", en: "Device alias" },
  "shell.aliasUnnamed": { zh: "未命名", en: "Unnamed" },
  "shell.save": { zh: "保存", en: "Save" },
  // 901:第一句常显(aliasSub),其余收进节下那只「说明」折叠 —— 原来那一段从第一个句号处切开,一个字没动。
  "shell.aliasSub": { zh: "给这台设备起个名字(如「娟娟的手机」)。", en: "Name this device (e.g. “Juanjuan's phone”)." },
  "shell.aliasNotePre": { zh: "它会", en: "The name " },
  "shell.aliasNoteBold": { zh: "同步", en: "syncs" },
  // 161 / W4 Q11(WM-36 / WP-21):别名按空间分别起,加入一个新空间后框是空的,像之前白起了 ⇒ 说明补一句。
  "shell.aliasNotePost": { zh: "给这个空间里的其他设备,让他们看到条目是谁记的。每个空间分别起;留空 = 不起名。", en: " to the other devices in this space, so they can see who noted each item. Each space has its own; empty = unnamed." },
  "shell.aboutTitle": { zh: "关于", en: "About" },
  // 作者一句(用户 2026-09-25 拍板,两端逐字相同 —— 改措辞要两端一起改)。「意见反馈」是上面那一节的真名(feedback.title)。
  // 161 / W4 Q11(WM-32 前半):「意见反馈」做成跳到那一节的链接 ⇒ 拆成前 / 链 / 后三段(拼起来与原句逐字相同;
  // data-i18n 元素不许带子元素,只能拆键,同 shell.aliasNote* 那三段)。
  "shell.aboutAuthorPre": { zh: "朱简是我一个人做的。好用、不好用,都欢迎在", en: "I build Zhujian on my own. Whether it works for you or not, tell me through " },
  "shell.aboutAuthorLink": { zh: "「意见反馈」", en: "Feedback" },
  "shell.aboutAuthorPost": { zh: "里告诉我。", en: "." },
  // 161 / W4 A12(WM-11 / X-13):同意之后在「关于」里还能再看这三份(应用内看,同首启那页;鸿蒙交不出浏览器)。
  "shell.policyRights": { zh: "隐私权利", en: "Your rights" },
  "shell.policyTerms": { zh: "用户协议", en: "Terms" },
  // 161 / W4 Q10(WM-31):手机「关于」里的「检查更新」(只在有应用内更新的渠道上出现,见 channel.ts)。
  "shell.checkUpdate": { zh: "检查更新", en: "Check for updates" },
  "shell.diag": { zh: "诊断", en: "Diagnostics" },
  "shell.diagDbTitle": { zh: "本机库(建库 + 全部迁移)", en: "Local database (creation + all migrations)" },
  // 161 / W4 Q15:排障入口两端一个叫法 =「网络自检」(电脑那边一直这么叫)。进页就按当前账户的服务器跑一次(A10),这枚是「改了地址再测」。
  "shell.diagNetTitle": { zh: "网络自检", en: "Network check" },
  "shell.runProbe": { zh: "再测一次", en: "Run again" },
  "shell.diagCopy": { zh: "复制诊断信息", en: "Copy diagnostic info" },
  // 161 / W4 Q5:复制前一句说清带走了什么(这一端没有带用户名的路径;设备编号在「本机库」那段里)。
  "shell.diagCopyNote": { zh: "复制的是上面这两段:含这台设备的编号,不含你记的内容和密钥。", en: "Copies the two sections above: it includes this device's ID, but none of your notes and no keys." },
  "shell.cancel": { zh: "取消", en: "Cancel" },
  "shell.confirm": { zh: "确认", en: "Confirm" },
  // 首启隐私政策告知(651;华为 2026-09-04 上架审核驳回第 3 条)。⛔ 别在这几条里
  // 写破折号(649 刚把两端字典里 125 枚清零),也别写成条款腔:它是这个应用给用户的
  // 第一印象。
  "shell.privacyTitle": { zh: "隐私政策", en: "Privacy policy" },
  "shell.privacyIntro": { zh: "你写下的内容默认只存在这台设备上,不上传任何服务器。只有你自己开启「多设备同步」之后,才会有数据离开这台设备;而且离开之前已在本机加密,我们读不到。", en: "What you write stays on this device by default and is not uploaded anywhere. Data leaves this device only after you turn on multi-device sync yourself, and it is encrypted on your device first, so we cannot read it." },
  "shell.privacyNone": { zh: "应用里没有广告,没有第三方 SDK,也没有任何 AI。", en: "There are no ads, no third-party SDKs, and no AI anywhere in the app." },
  "shell.privacyLink": { zh: "阅读完整隐私政策", en: "Read the full privacy policy" },
  "shell.privacyFine": { zh: "开始使用前请读一遍完整的隐私政策。不同意就无法使用朱简。", en: "Please read the full privacy policy before you start. Without your agreement Zhujian cannot be used." },
  "shell.privacyCanonical": { zh: "最新版本发布在:", en: "The current version is published at:" },
  // 161 / W4 A34(WM-25):正文里那句「从官网下载还是从应用市场安装,各看各的那份」要人自己判断 ——
  // 而包里烤的就是这只包那个渠道的那一份(scripts/lib/policy-asset.mjs 按渠道取),这一点构建期就定了。
  "shell.policyThisBuild": { zh: "下面这份随应用一起装进来,就是适用于你手上这一只朱简的那一份。", en: "The copy below ships inside the app and is the one that applies to your copy of Zhujian." },
  "shell.privacyAgree": { zh: "同意并开始使用", en: "Agree and start" },
  // 161 / W4 Q11(WM-30):钮写真实行为 —— 点了 app 就退出。
  "shell.privacyDecline": { zh: "不同意并退出", en: "Decline and quit" },
  "shell.gateChecking": { zh: "正在检查本机空间…", en: "Checking local spaces…" },
  "shell.gateUpgradeTitle": { zh: "需要更新朱简", en: "Zhujian needs updating" },
  "shell.gateUpgradePre": { zh: "本机数据由更新版本的朱简创建,当前装的是旧版:请到官网", en: "This device's data was created by a newer Zhujian and the installed build is older. Get the latest from" },
  "shell.gateUpgradePost": { zh: "下载安装最新版,数据即可继续使用。", en: "and your data will work again." },
  "shell.gateUpgradeFine": { zh: "不要清除数据。清除会把这些较新的记录永久删掉。", en: "Do not clear the app data. That would permanently delete those newer records." },
  "shell.gateRetryTitle": { zh: "启动暂时失败", en: "Startup failed for now" },
  "shell.gateRetryBody": { zh: "这是环境问题(例如存储空间不足),记录数据本身无恙:请释放存储空间后,完全关闭朱简再重新打开。", en: "This is an environment problem (for example, low storage). Your records are fine: free up some space, close Zhujian completely, and open it again." },
  "shell.gateRetryFine": { zh: "不要清除数据。重试即可恢复。", en: "Do not clear the app data. Retrying is enough." },
  "shell.gateRepairTitle": { zh: "升级遇到问题", en: "The upgrade hit a problem" },
  "shell.gateRepairPre": { zh: "记录数据完好,是这一版朱简升级数据时出了问题:请到官网", en: "Your records are intact; this build of Zhujian ran into trouble upgrading them. Get the latest from" },
  "shell.gateRepairPost": { zh: "重新下载安装最新版再试。", en: "and try again." },
  "shell.gateRepairFine": { zh: "不要清除数据。问题在程序,不在你的记录。", en: "Do not clear the app data. The problem is in the program, not in your records." },
  "shell.gateResetTitle": { zh: "本机空间数据异常", en: "The local space data is damaged" },
  "shell.gateResetPre": { zh: "本版本不修复受损数据:请到 系统设置 → 应用 → 朱简 → 存储 →", en: "This build does not repair damaged data. Go to System settings → Apps → Zhujian → Storage →" },
  "shell.gateResetBold": { zh: "清除数据", en: "Clear data" },
  "shell.gateResetPost": { zh: ",再重新打开并配对。", en: ", then open the app again and pair it." },
  "shell.gateResetFine": { zh: "清除后,本机尚未被其他设备实际接收的记录将永久丢失;服务器不是完整备份。请先在另一台装有朱简的设备上确认数据完整、并保持它在线,再清除。", en: "After clearing, any records this device has not actually delivered to another device are lost for good; the server is not a full backup. Check on another device with Zhujian that your data is complete and keep it online before clearing." },
  // 434:四个封锁页共用这一句。⛔ 它下面那段是 core 原样吐的诊断串(中文 + 英文 SQLite
  // 原文混排、路径可能印两遍),刻意不翻也不美化 —— 它的受众是排查的人,不是用户。
  "shell.gateDetail": { zh: "技术详情(排查时抄给开发者)", en: "Technical details (copy these when reporting a problem)" },
  "shell.viewerAria": { zh: "图片查看", en: "Image viewer" },
  "shell.delete": { zh: "删除", en: "Delete" },
  "shell.scanHint": { zh: "对准电脑「添加设备」出示的二维码", en: "Point at the QR code shown by Add device on the computer" },
  "shell.scanCancel": { zh: "取消扫码", en: "Cancel scan" },
});
