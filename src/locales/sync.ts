// src/sync.ts(同步面板)+ src/identity.ts(设备署名)+ src/update.ts(客户端更新)的文案分片。
import { defineMessages } from "./entry";

export const sync = defineMessages({
  "sync.stateOff": { zh: "未启用", en: "Not set up" },
  "sync.stateConnecting": { zh: "连接中…", en: "Connecting…" },
  "sync.stateBooting": { zh: "初始同步中…", en: "Initial sync…" },
  "sync.stateOnline": { zh: "已连接", en: "Connected" },
  "sync.stateOffline": { zh: "离线,重连中…", en: "Offline, reconnecting…" },
  // 161 / W4 Q14 / Q12 / Q2 / Q13:两端逐字同(android/src/locales/sync.ts;登记在 check-i18n-drift 的 CROSS_END_KEYS)。⛔ 改一边就改两边。
  "sync.reconnectNow": { zh: "现在重连", en: "Reconnect now" },
  "sync.reconnected": { zh: "已重新连上", en: "Reconnected" },
  // Q14 ★①(WP-09):侧栏「同步」后面直接写出来,不用悬停(桌面独有;已不在账户里时写 main.tagUnsynced)。
  "sync.sideOffline": { zh: "离线", en: "Offline" },
  "sync.goneLeft": { zh: "你已退出这个账户", en: "You have left this account" },
  "sync.goneRevoked": { zh: "这台已不在这个账户里(被移出,或账户被停用)", en: "This device is no longer in this account (it was removed, or the account was suspended)" },
  "sync.goneKeep": { zh: "这台上的内容都还在,之后在这台记的只留在这台。", en: "Everything on this device is still here; what you note from now on stays only on this device." },
  // Q12 ★①:重新加入的指路用桌面自己的话(手机 sync.goneRejoin 只作参考:它的「⋯ →『重置』」在桌面是空间菜单那一行)。
  "sync.goneRejoinDesk": { zh: "想重新加入:先把只在这台上的那几条复制出来,再在空间菜单里点「重置当前空间…」,然后输码加入。", en: "To rejoin: first copy out the entries that exist only on this device, then choose “Reset current space…” in the space menu, and join again with a pairing code." },
  "sync.serverHintOfficial": { zh: "官方服务器,一般不用改;自建的填你自己的(那是另一套账户)。", en: "The official server; usually leave it as is. If you run your own, enter yours (that is a separate set of accounts)." },
  "sync.serverHintOther": { zh: "不是官方服务器:这台服务器上的账户是另一套,和官方的不互通(官方的是 {url})。", en: "Not the official server: accounts on it are a separate set, not shared with the official one (that is {url})." },
  "sync.joinedUnnamed": { zh: "已加入空间。对方那本没起过名,这里先叫「{name}」{warn}", en: "Joined the space. The other side never named it, so here it is called “{name}” for now{warn}" },
  "sync.joinedTwin": { zh: "已加入空间「{name}」,和这台原有的一本同名{warn}", en: "Joined space “{name}”, which has the same name as a notebook already on this device{warn}" },
  "sync.accountCreated": { zh: "账户已创建,同步已开启", en: "Account created, sync is on" },
  "sync.otherSpace": { zh: "另一空间", en: "Another space" },
  "sync.toastFromSpace": { zh: "「{space}」{msg}", en: "[{space}] {msg}" },
  "sync.entryTitle": { zh: "同步:{state}", en: "Sync: {state}" },
  // 未配置时这枚入口只写着「同步」两个字,悬停才有这一句 —— 所以它得说清**点进去得到什么**,
  // 不是重复一遍标题。⛔ 别在这儿提价格 / 席位(不预告收费)。
  "sync.entryTitleOff": { zh: "同步(未启用):让手机和另一台电脑看同一份", en: "Sync (not set up): see the same notes on your phone and another computer" },
  "sync.panelTitle": { zh: "同步", en: "Sync" },
  // 161 / W4 Q2 ★①(WD-21):第一屏先说同步是可选的、不开就只在这台、内容先在本机加密(指南原话搬过来)。
  "sync.homeIntro": { zh: "同步是可选的:不开,记的东西只存在这台电脑上。开了之后,内容先在这台上加密再发出去,服务器读不到。不想开同步,也可以在「设置 → 备份与恢复」里自己留一份。", en: "Sync is optional. Without it, your notes live only on this computer. With it, content is encrypted on this computer before it leaves, and the server cannot read it. If you’d rather not sync, you can keep your own copy under Settings → Backup & restore." },
  "sync.createAccount": { zh: "创建账户(第一台设备)", en: "Create account (first device)" },
  // 902 F6:第一屏「创建账户」是唯一的主钮,加入降成它下面一行淡字链接(整句可点)。别处文案里引的「用配对码加入」指的就是它。
  "sync.joinLink": { zh: "已有账户?用配对码加入", en: "Already have an account? Join with a pairing code" },
  // 创建屏:服务器地址默认收成这一行 +「更改…」(预填不是官方地址时不出这一行、直接摊开地址框)。
  "sync.serverOfficialLine": { zh: "服务器:官方({host})", en: "Server: official ({host})" },
  "sync.serverChange": { zh: "更改…", en: "Change…" },
  "sync.nonMainHint": { zh: "要把别处的账户带到这台电脑,用左上空间菜单里的「加入空间」。", en: "To bring an account from elsewhere onto this computer, use “Join space” in the space menu at the top left." },
  "sync.peersOnline": { zh: " · 另有 {n} 台设备在线", en: " · {n} other {n|device|devices} online" },
  "sync.skewWarn": { zh: "对端版本较新:请升级朱简后继续同步。", en: "The other device runs a newer version: update Zhujian to keep syncing." },
  "sync.clockSkewWarn": { zh: "另一台设备的系统时间明显偏快,可能让它的编辑总是「胜出」:请核对两台设备的时间。", en: "Another device's clock is noticeably ahead, which may make its edits always “win”: check the time on both devices." },
  "sync.frozenWarn": { zh: "检测到设备历史分叉,已冻结该设备的同步(需人工处理)。", en: "Device history fork detected; sync for that device is frozen (manual action needed)." },
  "sync.addDevice": { zh: "添加设备", en: "Add device" },
  "sync.pairRequesting": { zh: "正在向服务器申请配对码…", en: "Requesting a pairing code from the server…" },
  // 出码页三句(用户面 121)。⚠ 指的路按**手机真长相**写:「扫码连接电脑」= 手机 shell.syncScan、
  // 「空间」= 手机那一页的标题 shell.spacesTitle、「加入空间(扫电脑二维码)」= 手机 shell.joinScan。
  // 手机已有自己账户那条路此前一个字没提 —— 用户拿着它去「同步」页,那里只有创号一条路。
  // 161 / W4 Q15(WP-05):手输那条路两端一个叫法 —— 把那台接进同一本 =「用配对码加入」、另加一本 =「加入空间(输入配对码)」(手机 shell.syncAltPair / shell.joinAlt);Q16(WP-25):写几点失效,不加复制钮。
  "sync.pairInstructions": { zh: "用手机朱简「同步」里的「扫码连接电脑」直接扫;手机已经在用自己的账户时,改走它的「空间」→「加入空间(扫电脑二维码)」。不扫码也行:在新设备的「同步」里选「用配对码加入」(已经在用自己账户的,走「空间」→「加入空间(输入配对码)」),填服务器地址和这串码。配对码到 {until} 失效,只能用一次。", en: "On your phone, open Sync in Zhujian and use “Scan to connect a computer” to scan this code; if the phone already uses an account of its own, go to its Spaces page → “Join a space (scan the computer's QR code)” instead. Without scanning: on the new device, choose “Join with a pairing code” under Sync (if it already uses an account of its own, go to Spaces → “Join a space (enter a pairing code)”), and enter the server address and this code. The code expires at {until} and can be used once." },
  "sync.pairKeepOn": { zh: "对方加入后要从这台电脑拉取初始快照:期间请让这台电脑开着、别切换空间。", en: "After joining, the other device pulls its initial snapshot from this computer: keep this computer on and stay in this space meanwhile." },
  // 161 / W4 A43(WP-04 / X-03):别叫人等对面那个一闪就过 / 根本不出现的「初始同步中…」—— 指到手机上真会出现的两句(core 的引导完成提示 / 加入空间的回执);写出加入的是哪台;对面一连上就收(sync.ts)。
  "sync.pairDoneNote": { zh: "「{name}」已加入账户,正在从这台取回全部内容。那台上出现「初始同步完成」或「已加入空间…」就是取完了;在那之前请让这台电脑开着、别切换空间。它一连上,这一页就收起。", en: "“{name}” has joined the account and is fetching everything from this computer. It is done once that device shows “Initial sync complete” or “Joined space…”; until then keep this computer on and stay in this space. This page closes once it connects." },
  "sync.pairDoneOnline": { zh: "「{name}」已连上,正在从这台取回内容:那台出现「初始同步完成」或「已加入空间…」之前,请让这台开着。", en: "“{name}” is connected and fetching from this computer: keep this computer on until that device shows “Initial sync complete” or “Joined space…”." },
  // A43:配对回执里写加入的是哪台 —— 编号取 core「设备 X 已注册」那一拍;那一拍没收到时只能这么叫。
  "sync.newDevice": { zh: "新设备", en: "The new device" },
  "sync.pairAgain": { zh: "重新出码", en: "Issue a new code" },
  // 引导进度那一块(用户面 121;与安卓那三句同话)。
  "sync.bootWaiting": { zh: "正在等另一台设备发来初始快照…", en: "Waiting for another device to send the initial snapshot…" },
  "sync.snapshotProgress": { zh: "拉取快照 {received} / {total}({pct}%)", en: "Fetching snapshot {received} / {total} ({pct}%)" },
  "sync.snapshotDone": { zh: "快照 {total} 已收全,校验并导入中…", en: "Snapshot {total} received, verifying and importing…" },
  "sync.advanced": { zh: "高级…", en: "Advanced…" },
  "sync.serverKv": { zh: "服务器 {url}", en: "Server {url}" },
  "sync.accountKv": { zh: "账户号 {id}", en: "Account ID {id}" },
  "sync.copyAccount": { zh: "复制账户号", en: "Copy account ID" },
  "sync.changeServer": { zh: "修改服务器", en: "Change server" },
  // 909 E10:二级页左上那枚(sync.ts backTop),同卡片菜单子层的「‹ …」。
  "sync.back": { zh: "‹ 返回", en: "‹ Back" },
  "sync.createIntro": { zh: "把本机创建为账户的第一台设备,其他设备之后配对加入。", en: "Make this device the account's first device; other devices join later by pairing." },
  // Q2 ★①:创建账户表单上把「丢了回不来」说出来(指南「账户密钥只在你自己的设备上」那条)。
  "sync.createLoseNote": { zh: "账户的钥匙只在你的设备上,服务器没有:这台丢了又没有别的设备和备份,账户就回不来。", en: "The account key exists only on your devices, never on the server: if this computer is lost and you have no other device and no backup, the account cannot be recovered." },
  "sync.serverPlaceholder": { zh: "服务器地址(wss://… 或 ws://…)", en: "Server address (wss://… or ws://…)" },
  // Q2 / A27 / A50 同族:地址框与配对码框上方标签(此前只有灰字占位,框里一有字就看不出是什么)。值同手机 shell.serverLabel / shell.codeLabel。
  "sync.serverLabel": { zh: "服务器地址", en: "Server address" },
  "sync.codeLabel": { zh: "配对码", en: "Pairing code" },
  "sync.createGo": { zh: "创建", en: "Create" },
  // A8(WD-10):「创建」/「加入」那两秒里说在干什么(此前上一条红字先没了、钮无声变灰)。
  "sync.connecting": { zh: "正在连接…", en: "Connecting…" },
  "sync.joinIntro": { zh: "在老设备上点「添加设备」得到服务器地址和配对码,两项都填。本机已有的数据会保留并合并。", en: "On your existing device, click “Add device” to get the server address and pairing code, then fill in both. Data already on this device is kept and merged." },
  // A27(WD-30):输之前就看得出长什么样(值同手机 shell.codePh)。
  "sync.pairCodePh": { zh: "形如 123456789-XXXX-XXXX", en: "like 123456789-XXXX-XXXX" },
  "sync.joinGo": { zh: "加入", en: "Join" },
  "sync.joinedToast": { zh: "已连接,正在初始同步…", en: "Connected, initial sync in progress…" },
  "sync.close": { zh: "关闭", en: "Close" },
  // W4 Q11 / WD-25:补上指南那条警告(此前只有一句用途,想从官方换到自建的人会以为改个地址就过去了)。
  "sync.serverIntro": { zh: "运营者迁移服务器时改这里,保存后立即重连。", en: "Change this when the operator migrates the server; it reconnects right after saving." },
  "sync.serverWarn": { zh: "它只换地址、账户原样不动,是给同一台服务器搬家用的。想从官方服务器换到自建的,不是在这里改:改了会一直「服务器拒绝」、反复重试(改回原地址就好)。做法见用户指南「自建同步服务器 › 已经在用官方服务器,想换过来」。", en: "It only changes the address and keeps the same account; it is for moving the same server. Switching from the official server to your own is not done here: you would get “server refused” and endless retries (changing the address back fixes it). See “Self-hosting a sync server › Already on the official server” in the user guide." },
  "sync.save": { zh: "保存", en: "Save" },
  // 设备管理面(identity-plan §5.8/§5.9;src/devices.ts)。§5.9 那段话术**一句都不能省**:
  // 「踢掉 ≠ 数据收回」是团队场景下最危险的误解,三层边界必须逐条讲全。
  "devices.entry": { zh: "设备名单", en: "Devices" },
  "devices.loading": { zh: "正在读取设备名单…", en: "Loading the device list…" },
  "devices.unavailable": { zh: "尚未确认服务器支持,暂不可用。连上服务器后再打开这一页。", en: "Server support not confirmed yet, so this is unavailable for now. Open this page again once connected." },
  "devices.refresh": { zh: "刷新", en: "Refresh" },
  "devices.refreshing": { zh: "读取中…", en: "Loading…" },
  "devices.noAdmin": { zh: "本空间还没有设置管理设备:设备管理暂不可用,请联系服务器运营者指定一台。", en: "No admin device has been set for this space yet: device management is unavailable. Ask the server operator to designate one." },
  "devices.oneAdminHint": { zh: "建议再设一台管理设备,万一这台丢了。", en: "Consider setting a second admin device, in case this one is lost." },
  // 161 / W4 A7 = Q7 / Q16:两端逐字同(同上)。
  "devices.lastAdminNoLeave": { zh: "这是账户里唯一的管理设备,不能退出;要退,先把另一台设成管理设备。", en: "This is the account's only admin device, so it can't leave; to leave, first make another device an admin." },
  "devices.unnamedHint": { zh: "在那台的 设置 → 本机别名 起个名就好认了", en: "Give it a name under Settings → Device alias on that device to tell it apart" },
  "devices.unnamedHintSelf": { zh: "在 设置 → 本机别名 给这台起个名就好认了", en: "Give this device a name under Settings → Device alias to tell it apart" },
  // 权限差别此前只在**行上**表达(§5.8:没权限的按钮不显示也不显示灰的)—— 于是非管理设备
  // 看到的是一张什么都点不了的名单,不知道是自己没权限还是功能没做(用户面 121)。
  "devices.whoCanRemove": { zh: "只有带「管理」徽章的设备能移除别的设备;其余设备只能让自己退出。", en: "Only devices with the “Admin” badge can remove other devices; any other device can only leave on its own." },
  "devices.badgeThis": { zh: "本机", en: "This device" },
  "devices.badgeAdmin": { zh: "管理", en: "Admin" },
  "devices.idExpand": { zh: "点开看完整设备 ID", en: "Show the full device ID" },
  "devices.idCollapse": { zh: "收起", en: "Collapse" },
  "devices.copyId": { zh: "复制 ID", en: "Copy ID" },
  "devices.idCopied": { zh: "设备 ID 已复制", en: "Device ID copied" },
  "devices.remove": { zh: "移除", en: "Remove" },
  "devices.leave": { zh: "退出账户", en: "Leave account" },
  "devices.grantAdmin": { zh: "设为管理", en: "Make admin" },
  "devices.revokeAdmin": { zh: "取消管理", en: "Remove admin" },
  "devices.cancel": { zh: "取消", en: "Cancel" },
  "devices.ok": { zh: "确定", en: "Confirm" },
  "devices.removeQ": { zh: "移除「{name}」?", en: "Remove “{name}”?" },
  "devices.removeYes": { zh: "确认移除", en: "Remove it" },
  "devices.removeL1": { zh: "它将无法再经服务器同步这个空间。", en: "It will no longer be able to sync this space through the server." },
  "devices.removeL2": { zh: "它本机上已有的内容不会被删除。移除不是「清空它」。", en: "Content already on that device is not deleted. Removing is not wiping it." },
  // 161 / W4 A38(WP-02):指南写明「一句不省」的那条此前漏了 —— 丢了手机去移除的人会以为这就安全了。
  "devices.removeKeys": { zh: "配对时交给它的账户密钥和那份完整副本也拿不回来。", en: "The account key it received when pairing, and the complete copy it holds, cannot be taken back either." },
  "devices.removeL3": { zh: "如果和它在同一个 wifi 下:还在册的设备每台只要能从服务器取到最新名单,就会断开与它的局域网直连;通常是立刻,网络不好时可能要等几分钟;取不到名单的那台仍可能继续直连。", en: "If it is on the same wifi: every device still on the list drops its direct local-network link to it as soon as that device can fetch the current list from the server; usually at once, or a few minutes later on a poor connection; a device that cannot fetch the list may keep syncing with it directly." },
  "devices.removeL4": { zh: "若它还有没同步出来的内容,请先让它上线同步完再移除;重新加入需要清空它那边的数据,期间独有的内容找不回来。", en: "If it still holds unsynced content, let it come online and finish syncing first; rejoining requires wiping its data, and anything only it had will be lost." },
  // A38:「想彻底隔离,移除不够」要指到能做的事 —— 后面挂一枚「意见反馈」直达设置里那一节(指南「要走这条路请发邮件」)。
  "devices.removeIsolate": { zh: "想彻底隔离(设备丢了、有人要走干净),移除不够:密钥早就在它手里了,只能重置整个账户(全部设备重新配对、换一把账户密钥)。要走这条路,写信告诉我:", en: "To cut it off completely (a lost device, or someone leaving for good), removing is not enough: it already holds the key, so the whole account has to be reset (every device pairs again with a new account key). To do that, write to me:" },
  "devices.removeIsolateGo": { zh: "意见反馈", en: "Feedback" },
  "devices.leaveQ": { zh: "让本机退出这个账户?", en: "Remove this device from the account?" },
  "devices.leaveYes": { zh: "确认退出", en: "Leave" },
  "devices.leaveL1": { zh: "本机将无法再经服务器同步这个空间。", en: "This device will no longer be able to sync this space through the server." },
  "devices.leaveL2": { zh: "本机已有的内容不会被删除。退出不是「清空本机」。", en: "Content already on this device is not deleted. Leaving is not wiping it." },
  "devices.leaveL3": { zh: "若本机还有没同步出来的内容,请先同步完再退出;重新加入需要清空本机这个空间的数据,期间独有的内容找不回来。", en: "If this device still holds unsynced content, finish syncing first; rejoining requires wiping this space on this device, and anything only it had will be lost." },
  "devices.grantQ": { zh: "把「{name}」设为管理设备?", en: "Make “{name}” an admin device?" },
  "devices.grantL1": { zh: "该设备将可以移除其他设备,并修改管理设备名单。", en: "That device will be able to remove other devices and change the list of admin devices." },
  "devices.revokeQ": { zh: "取消「{name}」的管理设备身份?", en: "Remove admin rights from “{name}”?" },
  "devices.revokeL1": { zh: "它将不能再移除设备或修改管理设备名单;仍可正常同步。", en: "It will no longer be able to remove devices or change the admin list; it keeps syncing normally." },
  "devices.removedToast": { zh: "已移除「{name}」", en: "Removed “{name}”" },
  "devices.leftToast": { zh: "本机已退出这个账户", en: "This device has left the account" },
  "devices.grantedToast": { zh: "「{name}」已设为管理设备", en: "“{name}” is now an admin device" },
  "devices.revokedToast": { zh: "已取消「{name}」的管理设备身份", en: "“{name}” is no longer an admin device" },
  "devices.departedToast": { zh: "「{name}」已被移出本空间", en: "“{name}” has been removed from this space" },
  "identity.authorUnknown": { zh: "作者未知", en: "Author unknown" },
  "identity.notedOn": { zh: "记于「{name}」", en: "Noted on “{name}”" },
  "update.newVersion": { zh: "有新版 v{v}", en: "New version v{v}" },
  "update.go": { zh: "更新", en: "Update" },
  "update.later": { zh: "稍后", en: "Later" },
  "update.downloading": { zh: "下载中…", en: "Downloading…" },
  "update.downloadingPct": { zh: "下载中… {pct}%", en: "Downloading… {pct}%" },
  "update.downloadingKb": { zh: "下载中… {kb} KB", en: "Downloading… {kb} KB" },
  "update.installing": { zh: "安装中,即将重启…", en: "Installing, restarting soon…" },
  "update.failed": { zh: "更新失败:{err}", en: "Update failed: {err}" },
  "update.close": { zh: "关闭", en: "Close" },
  // W4 A26(WD-28):手动「检查更新」的三种回话都写在「关于」页那一行下面(此前右下角闪 4 秒半就没了)。
  "update.checking": { zh: "正在检查…", en: "Checking…" },
  "update.upToDate": { zh: "已是最新 v{v}", en: "Up to date, v{v}" },
  "update.newerHere": { zh: "有新版 v{v}:点右下角那张提示里的「更新」", en: "New version v{v}: click Update on the note at the bottom right" },
  "update.checkFailed": { zh: "检查更新失败:{err}", en: "Update check failed: {err}" },
});
