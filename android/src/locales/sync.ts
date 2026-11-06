// android/src/sync.ts(同步面:状态 / 扫码与输码加入 / 创号仪式 / 出码添加设备)的分片。
import { defineMessages } from "./entry";

export const sync = defineMessages({
  "sync.stateOff": { zh: "未开启", en: "Off" },
  "sync.stateConnecting": { zh: "连接中…", en: "Connecting…" },
  "sync.stateBooting": { zh: "初始同步中…", en: "Initial sync…" },
  // 161 / W4 Q15(WP-16 / X-08):在线 / 离线取电脑现有的叫法,两端逐字同;在线时后面接 sync.peersOnline。
  "sync.stateOnline": { zh: "已连接", en: "Connected" },
  "sync.stateOffline": { zh: "离线,重连中…", en: "Offline, reconnecting…" },
  "sync.peersOnline": { zh: " · 另有 {n} 台设备在线", en: " · {n} other {n|device|devices} online" },
  // 161 / W4 Q14(A45):离线时把重连提前一次;断开过又连上时说一声(⚠ 状态里没有待发条数,「断开时记的已发出」证不了,不说)。
  "sync.reconnectNow": { zh: "现在重连", en: "Reconnect now" },
  "sync.reconnected": { zh: "已重新连上", en: "Reconnected" },
  // 161 / W4 Q12 ★①(A37 / A39 / A40):这台已不在这个账户里。两种来路分开说(自己退出 = 本机知道;被拒 = 服务器只说
  // 「封禁,或未注册 / 已吊销」,分不出移除还是封禁,两样一起写)。同一处写清两件事:内容都还在、之后记的只留在这台;怎么重新加入。
  "sync.goneLeft": { zh: "你已退出这个账户", en: "You have left this account" },
  "sync.goneRevoked": { zh: "这台已不在这个账户里(被移出,或账户被停用)", en: "This device is no longer in this account (it was removed, or the account was suspended)" },
  "sync.goneKeep": { zh: "这台上的内容都还在,之后在这台记的只留在这台。", en: "Everything on this device is still here; what you note from now on stays only on this device." },
  "sync.goneRejoin": { zh: "想重新加入:先把只在这台上的那几条复制出来,再到「空间」里给这一本点「⋯」→「重置」,然后输码加入。", en: "To rejoin: first copy out the entries that exist only on this device, then in Spaces tap “⋯” on this notebook → Reset, and join again with a pairing code." },
  // 161 / W4 Q2(WM-14 / WM-17):没开同步时第一屏那几句(指南原话搬过来)。
  "sync.introOff": { zh: "同步是可选的:不开,记的东西只存在这台手机上,卸载就没了(想留一份,去 设置 → 备份)。开了之后,内容先在这台上加密再发出去,服务器读不到。", en: "Sync is optional. Without it, your notes live only on this phone and are gone if you uninstall (to keep a copy, use Settings → Backup). With it, content is encrypted on this device before it leaves, and the server can't read it." },
  // Q2 / Q3:地址框下那一行,跟着框里的值说(预填的是这台最近一次连上的那台,从没连过才是官方那台)。
  "sync.serverHintOfficial": { zh: "官方服务器,一般不用改;自建的填你自己的(那是另一套账户)。", en: "The official server; usually leave it as is. If you run your own, enter yours (that is a separate set of accounts)." },
  "sync.serverHintOther": { zh: "不是官方服务器:这台服务器上的账户是另一套,和官方的不互通(官方的是 {url})。", en: "Not the official server: accounts on it are a separate set, not shared with the official one (that is {url})." },
  "sync.listSep": { zh: "、", en: ", " },
  "sync.warnSep": { zh: ";", en: "; " },
  "sync.frozen": { zh: "已冻结设备:{list}(需人工处理)", en: "Frozen devices: {list} (needs manual attention)" },
  "sync.altCreateMain": { zh: "没有其他设备?创建新账户", en: "No other device? Create an account" },
  "sync.altCreateOther": { zh: "开启多端同步(创建账户)", en: "Turn on multi-device sync (create an account)" },
  "sync.infoAccount": { zh: "账户号", en: "Account ID" },
  "sync.copyAccount": { zh: "复制账户号", en: "Copy account ID" },
  "sync.accountCopied": { zh: "账户号已复制", en: "Account ID copied" },
  "sync.infoServer": { zh: "服务器", en: "Server" },
  // Q15(WM-22):「同伴」改「设备」。
  "sync.infoPeers": { zh: "在线的其他设备", en: "Other devices online" },
  "sync.needServer": { zh: "先填服务器地址", en: "Enter the server address first" },
  "sync.needCode": { zh: "先填配对码", en: "Enter the pairing code first" },
  "sync.joining": { zh: "加入中…", en: "Joining…" },
  "sync.join": { zh: "加入", en: "Join" },
  "sync.connectedNameHint": { zh: "已连接,正在初始同步…(可在「空间」面板给本空间起个名字)", en: "Connected, initial sync running… (you can name this space in the Spaces panel)" },
  "sync.connected": { zh: "已连接,正在初始同步…", en: "Connected, initial sync running…" },
  "sync.noCamera": { zh: "没有相机权限,无法扫码;可以手动输入配对码,或到系统设置里给朱简开相机。", en: "No camera permission, so scanning is unavailable. Enter the pairing code by hand, or grant Zhujian camera access in system settings." },
  "sync.phasePreparing": { zh: "准备中…", en: "Preparing…" },
  "sync.phasePairing": { zh: "正在配对…", en: "Pairing…" },
  "sync.phaseBooting": { zh: "正在拉取账户数据…", en: "Fetching account data…" },
  "sync.phasePublishing": { zh: "正在落成空间…", en: "Setting up the space…" },
  "sync.phaseIntegrating": { zh: "正在装入空间列表…", en: "Adding to the space list…" },
  "sync.joinInFlight": { zh: "已有一次「加入空间」在进行中", en: "A “Join a space” is already running" },
  "sync.joinWarn": { zh: "(注意:{list})", en: " (note: {list})" },
  "sync.joined": { zh: "已加入空间「{name}」{warn}", en: "Joined space “{name}”{warn}" },
  // 161 / W4 Q13 ★①(A44):回执写明这一本在这台叫什么(名字怎么来的不动,space-entry-plan §3.6);旁边一枚「改名」。
  "sync.joinedUnnamed": { zh: "已加入空间。对方那本没起过名,这里先叫「{name}」{warn}", en: "Joined the space. The other side never named it, so here it is called “{name}” for now{warn}" },
  "sync.joinedTwin": { zh: "已加入空间「{name}」,和这台原有的一本同名{warn}", en: "Joined space “{name}”, which has the same name as a notebook already on this device{warn}" },
  "sync.joinedStay": { zh: "已加入空间「{name}」,保存当前编辑后可到「空间」列表切换过去{warn}", en: "Joined space “{name}”; save what you are editing, then switch over from the Spaces list{warn}" },
  "sync.creating": { zh: "创建中…", en: "Creating…" },
  "sync.createAccount": { zh: "创建新账户", en: "Create an account" },
  "sync.requestingCode": { zh: "申请配对码…", en: "Requesting a code…" },
  "sync.pairServer": { zh: "服务器", en: "Server" },
  "sync.pairCode": { zh: "配对码", en: "Pairing code" },
  "sync.pairCopyText": { zh: "服务器地址:{server}\n配对码:{code}", en: "Server: {server}\nPairing code: {code}" },
  // ⚠ 这句给的是**电脑端**的路,措辞与桌面可见文案逐字对齐(「同步」= 侧栏那枚钮、
  // 「用配对码加入」= sync.joinWithCode、「空间…」= shell.spacesEntry、「加入空间」=
  // notebook.joinSpace)。⛔ 别写成「点左上角的「空间」」—— 那枚徽章**只有一个空间时
  // 整个藏起**(notebook.ts::refreshSpaceEntry),而那正是收到配对码那台电脑的常态。
  // ⚠ 这句给的是**另一台**的路,措辞与桌面可见文案逐字对齐(「同步」= 侧栏 / 顶栏那枚钮、
  // 「用配对码加入」= 桌面 sync.joinWithCode 与本端 shell.syncAltPair、「加入空间(输入配对码)」= 桌面 notebook.joinSpace 与本端
  // shell.joinAlt)。161 / W4(WM-15 / N-3):此前只写电脑那条路,对方是另一部手机时对不上;Q16:写几点失效。
  "sync.pairNote": { zh: "在另一台设备上打开朱简的「同步」:那台没开过同步,就选「用配对码加入」;已经在用自己账户的,改走它的「空间」→「加入空间(输入配对码)」。服务器地址和配对码两项都要填。出码和对方初始同步期间,不要切换空间、不要运行「全部同步」,并保持本机亮屏在前台。配对码到 {until} 失效、只能用一次。", en: "On the other device, open Sync in Zhujian: if it has never set up sync, choose “Join with a pairing code”; if it already has its own account, go to its Spaces → “Join a space (enter a pairing code)” instead. Both the server address and the pairing code are required. While the code is out and the other side is doing its initial sync, do not switch spaces or run Sync all, and keep this phone awake in the foreground. The code expires at {until} and can be used once." },
  "sync.pairAgain": { zh: "重新出码", en: "Issue a new code" },
  "sync.addDevice": { zh: "添加设备", en: "Add device" },
  "sync.bootProgress": { zh: "正在拉取账户数据 {received} / {total}", en: "Fetching account data {received} / {total}" },
  // Q2(WM-14):只有一个空间时同步面不写空间名 ⇒ 回执说是哪一本的账户。
  "sync.accountCreatedFor": { zh: "「{name}」的账户已创建,同步已开启", en: "Account created for “{name}”, sync is on" },
  "sync.copied": { zh: "已复制,到另一台设备上粘贴", en: "Copied; paste it on the other device" },
  "sync.copyFailed": { zh: "复制失败,请长按选中文字手动复制", en: "Copy failed; long-press to select the text and copy it by hand" },
  "sync.bootWaiting": { zh: "正在等另一台设备发来初始快照…", en: "Waiting for another device to send the initial snapshot…" },
  "sync.snapshotDone": { zh: "快照 {total} 已收全,校验并导入中…", en: "Snapshot {total} received, verifying and importing…" },
  "sync.snapshotProgress": { zh: "拉取快照 {received} / {total}({pct}%)", en: "Fetching snapshot {received} / {total} ({pct}%)" },
  "sync.pairDone": { zh: "新设备已加入账户。它接着要取回全部内容,本机看不到那一头的进度:等那台的同步状态不再是「初始同步中…」,就可以离开本页了。", en: "The new device has joined the account and is now fetching everything; this phone can't see its progress. Once its sync status no longer says “Initial sync…”, you can leave this page." },
  "sync.pairFailed": { zh: "配对失败:{detail}(可重新出码)", en: "Pairing failed: {detail} (you can issue a new code)" },
  // 设备管理面(identity-plan §5.8/§5.9;android/src/devices.ts)。⚠ 两端各一份独立字典、
  // 键空间独立;这一族与桌面同名的键**刻意不进** CROSS_END_KEYS —— 端间措辞可以各自随
  // 形态走(手机把「设为管理」的说明并进确认条问句,桌面单列一行)。
  // §5.9 那段话术**一句都不能省**:「踢掉 ≠ 数据收回」是团队场景下最危险的误解。
  "devices.entry": { zh: "设备名单", en: "Devices" },
  "devices.loading": { zh: "正在读取设备名单…", en: "Loading the device list…" },
  "devices.unavailable": { zh: "尚未确认服务器支持,暂不可用。连上服务器后再打开这一页。", en: "Server support not confirmed yet, so this is unavailable for now. Open this page again once connected." },
  "devices.refresh": { zh: "刷新", en: "Refresh" },
  "devices.refreshing": { zh: "读取中…", en: "Loading…" },
  "devices.noAdmin": { zh: "本空间还没有设置管理设备:设备管理暂不可用,请联系服务器运营者指定一台。", en: "No admin device has been set for this space yet: device management is unavailable. Ask the server operator to designate one." },
  "devices.oneAdminHint": { zh: "建议再设一台管理设备,万一这台丢了。", en: "Consider setting a second admin device, in case this one is lost." },
  // 161 / W4 A7 = Q7 ★①(WM-08 / WP-20):只剩本机这一台管理设备时,「退出账户」那枚钮换成这一行灰字(只按名单里的「管理」徽章在本机判;
  // 服务器那条「至少留一台」照旧,这里只是不让人下了决心再被拒)。
  "devices.lastAdminNoLeave": { zh: "这是账户里唯一的管理设备,不能退出;要退,先把另一台设成管理设备。", en: "This is the account's only admin device, so it can't leave; to leave, first make another device an admin." },
  // 161 / W4 Q16(WP-15 后半):没起名的设备只有一串编号,认不出哪台是哪台 ⇒ 那一行下面说一句去哪儿起名。
  "devices.unnamedHint": { zh: "在那台的 设置 → 本机别名 起个名就好认了", en: "Give it a name under Settings → Device alias on that device to tell it apart" },
  "devices.unnamedHintSelf": { zh: "在 设置 → 本机别名 给这台起个名就好认了", en: "Give this device a name under Settings → Device alias to tell it apart" },
  // 权限差别此前只在行上表达(没权限的按钮不显示)—— 非管理设备看到的是一张什么都点不了
  // 的名单,不知道是自己没权限还是功能没做(用户面 121;与桌面同句)。
  "devices.whoCanRemove": { zh: "只有带「管理」徽章的设备能移除别的设备;其余设备只能让自己退出。", en: "Only devices with the “Admin” badge can remove other devices; any other device can only leave on its own." },
  "devices.badgeThis": { zh: "本机", en: "This device" },
  "devices.badgeAdmin": { zh: "管理", en: "Admin" },
  // 161 / W4 A30(WM-22):照指南叫「完整编号」。
  "devices.copyId": { zh: "复制完整编号", en: "Copy full ID" },
  "devices.idCopied": { zh: "设备编号已复制", en: "Device ID copied" },
  "devices.copyFailed": { zh: "复制失败,请长按选中文字手动复制", en: "Copy failed; long-press to select the text and copy it by hand" },
  "devices.remove": { zh: "移除", en: "Remove" },
  "devices.leave": { zh: "退出账户", en: "Leave account" },
  "devices.grantAdmin": { zh: "设为管理", en: "Make admin" },
  "devices.revokeAdmin": { zh: "取消管理", en: "Remove admin" },
  "devices.ok": { zh: "确定", en: "Confirm" },
  "devices.removeQ": { zh: "移除「{name}」?", en: "Remove “{name}”?" },
  "devices.removeYes": { zh: "移除", en: "Remove" },
  "devices.removeL1": { zh: "它将无法再经服务器同步这个空间。", en: "It will no longer be able to sync this space through the server." },
  "devices.removeL2": { zh: "它本机上已有的内容不会被删除。移除不是「清空它」。", en: "Content already on that device is not deleted. Removing is not wiping it." },
  // 161 / W4 A38(WP-02):移除确认照指南一句不省 —— 与桌面同键同句(CROSS_END_KEYS);此前两端都漏了第三条与「移除不够」。
  "devices.removeKeys": { zh: "配对时交给它的账户密钥和那份完整副本也拿不回来。", en: "The account key it received when pairing, and the complete copy it holds, cannot be taken back either." },
  "devices.removeL3": { zh: "如果和它在同一个 wifi 下:还在册的设备每台只要能从服务器取到最新名单,就会断开与它的局域网直连;通常是立刻,网络不好时可能要等几分钟;取不到名单的那台仍可能继续直连。", en: "If it is on the same wifi: every device still on the list drops its direct local-network link to it as soon as that device can fetch the current list from the server; usually at once, or a few minutes later on a poor connection; a device that cannot fetch the list may keep syncing with it directly." },
  "devices.removeL4": { zh: "若它还有没同步出来的内容,请先让它上线同步完再移除;重新加入需要清空它那边的数据,期间独有的内容找不回来。", en: "If it still holds unsynced content, let it come online and finish syncing first; rejoining requires wiping its data, and anything only it had will be lost." },
  "devices.removeIsolate": { zh: "想彻底隔离(设备丢了、有人要走干净),移除不够:密钥早就在它手里了,只能重置整个账户(全部设备重新配对、换一把账户密钥)。要走这条路,写信告诉我:", en: "To cut it off completely (a lost device, or someone leaving for good), removing is not enough: it already holds the key, so the whole account has to be reset (every device pairs again with a new account key). To do that, write to me:" },
  "devices.removeIsolateGo": { zh: "意见反馈", en: "Feedback" },
  "devices.leaveQ": { zh: "让本机退出这个账户?", en: "Remove this device from the account?" },
  "devices.leaveYes": { zh: "退出", en: "Leave" },
  "devices.leaveL1": { zh: "本机将无法再经服务器同步这个空间。", en: "This device will no longer be able to sync this space through the server." },
  "devices.leaveL2": { zh: "本机已有的内容不会被删除。退出不是「清空本机」。", en: "Content already on this device is not deleted. Leaving is not wiping it." },
  "devices.leaveL3": { zh: "若本机还有没同步出来的内容,请先同步完再退出;重新加入需要清空本机这个空间的数据,期间独有的内容找不回来。", en: "If this device still holds unsynced content, finish syncing first; rejoining requires wiping this space on this device, and anything only it had will be lost." },
  "devices.grantQ": { zh: "把「{name}」设为管理设备?", en: "Make “{name}” an admin device? " },
  "devices.grantL1": { zh: "该设备将可以移除其他设备,并修改管理设备名单。", en: "That device will be able to remove other devices and change the list of admin devices." },
  "devices.revokeQ": { zh: "取消「{name}」的管理设备身份?", en: "Remove admin rights from “{name}”? " },
  "devices.revokeL1": { zh: "它将不能再移除设备或修改管理设备名单;仍可正常同步。", en: "It will no longer be able to remove devices or change the admin list; it keeps syncing normally." },
  "devices.removedToast": { zh: "已移除「{name}」", en: "Removed “{name}”" },
  "devices.leftToast": { zh: "本机已退出这个账户", en: "This device has left the account" },
  "devices.grantedToast": { zh: "「{name}」已设为管理设备", en: "“{name}” is now an admin device" },
  "devices.revokedToast": { zh: "已取消「{name}」的管理设备身份", en: "“{name}” is no longer an admin device" },
  "devices.departedToast": { zh: "「{name}」已被移出本空间", en: "“{name}” has been removed from this space" },
});
