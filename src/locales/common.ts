// 跨视图通用文案。⚠ 清扫 agent 不动这份(避免并行冲突):各文件的文案进各自分片,
// 值重复无妨、键不许撞。
import { defineMessages } from "./entry";

export const common = defineMessages({
  "common.appName": { zh: "朱简", en: "Zhujian" },
  "common.save": { zh: "保存", en: "Save" },
  "common.loading": { zh: "读取中…", en: "Loading…" },
  "common.undo": { zh: "撤销", en: "Undo" },
  "common.undoFailed": { zh: "撤销失败:{err}", en: "Undo failed: {err}" },
  // 165 / W5 Q6:点了【撤销】、撤成了之后说一声(条一收、卡回原处,回到的地方常不在眼前;误点中撤销也只有这一句能让人发现)。
  // 两端同句(手机 android/src/locales/misc.ts,M1 定词)。⛔ 撤销失败不说这句(走 common.undoFailed)。
  "common.undone": { zh: "已撤销", en: "Undone" },
  // 165 / W5 Q14:时间两端一个写法 —— 今天的「今天 15:18」、今年别的天「11月5日 15:18」、跨年带年(tasktime.ts::when)。
  // 两端同句(手机 ui.ts::fmtWhen)。⛔ 例外只有随记时间轴的卡(组头已写哪天,只写时刻)与截止胶囊(窄,短写法)。
  "ui.whenToday": { zh: "今天 {hm}", en: "Today {hm}" },
  "ui.whenThisYear": { zh: "{m}月{d}日 {hm}", en: "{m}/{d} {hm}" },
  "ui.whenOtherYear": { zh: "{y}年{m}月{d}日 {hm}", en: "{m}/{d}/{y} {hm}" },
  // 错误文案人话前置(C8,src/err.ts):认得出的几类换一句人话,原话跟在括号里;认不出的加前缀。
  "err.raw": { zh: "(原文:{raw})", en: " (details: {raw})" },
  "err.unknown": { zh: "出错:{raw}", en: "Error: {raw}" },
  // 161 / W4 A8 / A42 / A27 / A41:连不上那一族按原话拆开、配对码与重新加入那几句 —— **与手机逐字同**(android/src/locales/misc.ts;
  // 登记在 check-i18n-drift 的 CROSS_END_KEYS)。⛔ 改一边就改两边。
  "err.net": { zh: "连不上服务器:看看地址对不对、服务器开没开、网络通不通。", en: "Couldn't connect to the server: check the address, whether the server is running, and whether the network works." },
  "err.netDns": { zh: "找不到这个服务器地址:看看是不是打错了,或者这台没联网。", en: "Can't find this server address: check it for typos, or whether this device is online." },
  "err.netRefused": { zh: "连不上服务器:服务器可能没开,或者地址、端口不对。", en: "Couldn't connect to the server: it may not be running, or the address or port is wrong." },
  "err.netUnreachable": { zh: "连不上服务器:这台的网络不通。", en: "Couldn't reach the server: this device's network is down." },
  "err.netTimeout": { zh: "连接服务器超时:网络可能不通,或者服务器没响应。", en: "Connecting to the server timed out: the network may be down, or the server isn't responding." },
  "err.netDropped": { zh: "和服务器的连接断了。", en: "The connection to the server dropped." },
  "err.offlineNow": { zh: "现在没连上服务器(正在重连),连上之后再试。", en: "Not connected to the server right now (reconnecting); try again once it's connected." },
  "err.revoked": { zh: "这台已不在这个账户里(被移出,或账户被停用)。", en: "This device is no longer in this account (it was removed, or the account was suspended)." },
  "err.pairAborted": { zh: "配对码不对(或者对方关掉了出码页)。在出码的那台上点「重新出码」,再输新码。", en: "The pairing code is wrong (or the other device closed its code page). On the device that showed the code, choose “Issue a new code”, then enter the new one." },
  "err.pairBadCode": { zh: "配对码不对或已失效(每个码只能用一次)。在出码的那台上点「重新出码」,再输新码;也核对一下服务器地址是不是对方那台。", en: "The pairing code is wrong or no longer valid (each code works once). On the device that showed the code, choose “Issue a new code”, then enter the new one; also check that the server address is the other device's server." },
  "err.pairCodeShape": { zh: "配对码的样子不对:应是 9 位数字、4 位、4 位,用短横连起来,形如 123456789-XXXX-XXXX。", en: "That doesn't look like a pairing code: it should be 9 digits, 4 characters and 4 characters joined by dashes, like 123456789-XXXX-XXXX." },
  "err.pairCodeChar": { zh: "配对码里有不该有的字「{c}」:应是 9 位数字、4 位、4 位,用短横连起来,形如 123456789-XXXX-XXXX。", en: "The pairing code contains a character it can't have (“{c}”): it should be 9 digits, 4 characters and 4 characters joined by dashes, like 123456789-XXXX-XXXX." },
  "err.accountInUse": { zh: "这台上已经有这个账户的一本了(「{name}」)。若那一本已被移出账户,想重新加入:先把只在那一本里的几条复制出来,再到「空间」里把它「重置」,然后输码加入。", en: "This device already has a notebook on this account (“{name}”). If that one was removed from the account and you want to rejoin: copy out the entries that exist only there, reset it under Spaces, then join with the code." },
  // A42 / A41 出码那台(桌面独有;手机做出码方时的话在它自己那份):对方输错 / 对方没加入就走了 / 码过期,下一步都是「重新出码」。
  // ⚠「对方离开」不说成「码不对」:被移出后没重置就来加入的那台,在它那边被拦下才走的 —— 原因看对方屏上。
  "err.pairMismatch": { zh: "对方输的配对码不对,这串码已作废。点「重新出码」,让对方输新码。", en: "The other device entered the wrong pairing code, so this code is now void. Choose “Issue a new code” and have them enter the new one." },
  "err.pairPeerLeft": { zh: "对方没加入就离开了:可能关掉了输码那一页,也可能在它那边被拦下了(比如那台已经有这个账户的一本)—— 看对方屏上怎么说。点「重新出码」,让对方输新码。", en: "The other device left without joining: it may have closed its code page, or been stopped on its side (for example, it already has a notebook on this account) — check what its screen says. Choose “Issue a new code” and have them enter the new one." },
  "err.pairExpired": { zh: "这串配对码已过期(10 分钟内有效)。点「重新出码」,让对方输新码。", en: "This pairing code has expired (it is valid for 10 minutes). Choose “Issue a new code” and have them enter the new one." },
  "err.conflict": { zh: "这次改动和已有的数据对不上,没有存。", en: "This change conflicts with existing data and wasn't saved." },
  "err.gone": { zh: "要改的那一条已经不在了(可能在另一台设备上删掉或移走了)。", en: "That entry is no longer there (it may have been deleted or moved on another device)." },
  "err.probeNext": { zh: "网络自检", en: "Network check" },
  // 两个回收站共用的话(W3 159:A7 / A9 / A19 —— 清空确认长成一个样、彻底删除写明无法恢复与连带、做完都说一声)。
  "trash.emptyTrash": { zh: "清空回收站", en: "Empty trash" },
  "trash.cancel": { zh: "取消", en: "Cancel" },
  "trash.purgeAllYes": { zh: "彻底删除全部", en: "Delete all forever" },
  "trash.purgeAllQ": { zh: "彻底删除回收站里全部 {n} 条?无法恢复。", en: "Delete all {n} {n|item|items} in the trash forever? This cannot be undone." },
  "trash.purgeAllMixedQ": { zh: "彻底删除回收站里全部 {n} 条和 {m} 张配图?无法恢复。", en: "Delete all {n} {n|item|items} and {m} {m|image|images} in the trash forever? This cannot be undone." },
  "trash.purgeAllImagesQ": { zh: "彻底删除回收站里全部 {m} 张配图?无法恢复。", en: "Delete all {m} {m|image|images} in the trash forever? This cannot be undone." },
  "trash.emptied": { zh: "回收站已清空", en: "Trash emptied" },
  // 165 / W5 Q14:清空确认句写明只清这一只(随记 / 长文与看板是两只回收站,此前两只同一句,看不出另一只动不动)。接在问句后面。
  "trash.scopeNotes": { zh: "只清这只(随记与长文);看板的回收站不动。", en: " Only this trash (notes and long-form); the board’s trash is left alone." },
  "trash.scopeTasks": { zh: "只清这只(看板的任务);随记的回收站不动。", en: " Only this trash (board tasks); the notes trash is left alone." },
  "trash.purgeOneQ": { zh: "彻底删除这条?无法恢复", en: "Delete this forever? This cannot be undone" },
  "trash.purgeOneImagesQ": { zh: "彻底删除这条和它的 {m} 张配图?无法恢复", en: "Delete this and its {m} {m|image|images} forever? This cannot be undone" },
  "trash.purged": { zh: "已彻底删除", en: "Deleted forever" },
  // 165 / W5 Q15:找不回的那一下写出删的是哪一条(tasktime.ts::itemSnippet 那一截;整条没字照旧上面那句)。两端同句。
  "trash.purgedNamed": { zh: "已彻底删除「{name}」", en: "Deleted “{name}” forever" },
  "trash.restoredNote": { zh: "已还原到随记", en: "Restored to Notes" },
  "trash.restoredDoc": { zh: "已还原到「长文」", en: "Restored to Long-form" },
  "trash.restoredTask": { zh: "已还原到看板「{col}」列", en: "Restored to the “{col}” column" },
  "trash.restoredBoard": { zh: "已还原到看板", en: "Restored to the board" },
  // W3 159 / WD-37:两个回收站的卡写删除时刻(照手机「删于 …」)。
  "trash.deletedAt": { zh: "删于 {when}", en: "Deleted {when}" },
});
