// 小件合收的分片(键前缀 = 来源 ts 文件名,全局唯一、跨分片不许撞):
// api.ts(空间展示名)/ identity.ts(署名)/ images.ts + thumbs.ts(配图)/
// swipe.ts(滑动改状态回执)/ carddrag.ts(长按拖卡)/ ui.ts(stage 印文 + 时间格式 + actionBar 配套的
// 通用「撤销」——操作型回执(§3.1)的钮词只此一份,滑动/勾完成/删除/归档共用)/ err.ts(错误文案人话前置)。
import { defineMessages } from "./entry";

export const misc = defineMessages({
  "api.defaultSpace": { zh: "默认空间", en: "Default space" },
  "api.unnamedSpace": { zh: "未命名空间 · {id}", en: "Unnamed space · {id}" },
  "api.mainSuffix": { zh: "(默认空间)", en: " (default space)" },
  "identity.authorUnknown": { zh: "作者未知", en: "Author unknown" },
  "images.removeThis": { zh: "移除这张图", en: "Remove this image" },
  "images.processing": { zh: "正在处理这张图…", en: "Processing this image…" },
  "images.imageN": { zh: "图{n}", en: "Image {n}" },
  "images.tooMany": { zh: "一次最多 {max} 张,这次选了 {n} 张;分几次加吧", en: "At most {max} at a time; you picked {n}. Add them in a few batches." },
  // 165 / W5 Q14:挪列回执两端一句「已移到「…」」(此前手机「已改为」、电脑「已移到」);键名照桌面 board.undoMoved,两端逐字同。
  // 状态菜单换列、横滑、勾回待办、长按拖跨列四条路共用(taskmove.ts moveReceipt)。
  "board.undoMoved": { zh: "已移到「{col}」", en: "Moved to “{col}”" },
  // swipe.ts:端点方向(首列往左、末列往右)滑过了阈值,卡弹回去时说一句(165 / W5 A49)。
  "swipe.atFirst": { zh: "「{col}」已是第一列", en: "“{col}” is already the first column" },
  "swipe.atLast": { zh: "「{col}」已是最后一列", en: "“{col}” is already the last column" },
  // carddrag.ts(长按拖卡,158 G3 / Q7;165 / W5 A37 起看板上也拖)
  "carddrag.reordered": { zh: "已挪到这里", en: "Moved here" },
  "carddrag.dueSorted": { zh: "只看到期时按截止日排,不能拖;先点掉那枚到期钮", en: "Sorted by due date while showing due tasks only, so cards can't be dragged. Turn that filter off first" },
  "ui.undo": { zh: "撤销", en: "Undo" },
  // 165 / W5 Q6:点了【撤销】、撤成了以后说一声(两端同句,ui.ts::showUndone)。
  "common.undone": { zh: "已撤销", en: "Undone" },
  "ui.confirmExpired": { zh: "没确认,已作罢", en: "Not confirmed — nothing was done" },
  // 错误文案人话前置(err.ts,用户面 126):值与桌面 common.ts 的 err.* 逐字同形。「下一步」那枚
  // 161 / W4 Q15 起两端一个叫法「网络自检」(手机的网络自检住设置里的「诊断」面)。
  "err.raw": { zh: "(原文:{raw})", en: " (details: {raw})" },
  "err.unknown": { zh: "出错:{raw}", en: "Error: {raw}" },
  // 161 / W4 A8:「连不上」按原话分五种说(err.ts NET_KINDS);`err.net` 只剩「拨号失败、原因认不出」那一种。两端逐字同。
  "err.net": { zh: "连不上服务器:看看地址对不对、服务器开没开、网络通不通。", en: "Couldn't connect to the server: check the address, whether the server is running, and whether the network works." },
  "err.netDns": { zh: "找不到这个服务器地址:看看是不是打错了,或者这台没联网。", en: "Can't find this server address: check it for typos, or whether this device is online." },
  "err.netRefused": { zh: "连不上服务器:服务器可能没开,或者地址、端口不对。", en: "Couldn't connect to the server: it may not be running, or the address or port is wrong." },
  "err.netUnreachable": { zh: "连不上服务器:这台的网络不通。", en: "Couldn't reach the server: this device's network is down." },
  "err.netTimeout": { zh: "连接服务器超时:网络可能不通,或者服务器没响应。", en: "Connecting to the server timed out: the network may be down, or the server isn't responding." },
  "err.netDropped": { zh: "和服务器的连接断了。", en: "The connection to the server dropped." },
  "err.offlineNow": { zh: "现在没连上服务器(正在重连),连上之后再试。", en: "Not connected to the server right now (reconnecting); try again once it's connected." },
  // 161 / W4 Q12:与同步面那行状态(sync.goneRevoked)同一句话。
  "err.revoked": { zh: "这台已不在这个账户里(被移出,或账户被停用)。", en: "This device is no longer in this account (it was removed, or the account was suspended)." },
  // 161 / W4 A42 / Q3 / A27 / A41:配对码与重新加入那几句(两端逐字同)。
  "err.pairAborted": { zh: "配对码不对(或者对方关掉了出码页)。在出码的那台上点「重新出码」,再输新码。", en: "The pairing code is wrong (or the other device closed its code page). On the device that showed the code, choose “Issue a new code”, then enter the new one." },
  "err.pairBadCode": { zh: "配对码不对或已失效(每个码只能用一次)。在出码的那台上点「重新出码」,再输新码;也核对一下服务器地址是不是对方那台。", en: "The pairing code is wrong or no longer valid (each code works once). On the device that showed the code, choose “Issue a new code”, then enter the new one; also check that the server address is the other device's server." },
  "err.pairCodeShape": { zh: "配对码的样子不对:应是 9 位数字、4 位、4 位,用短横连起来,形如 123456789-XXXX-XXXX。", en: "That doesn't look like a pairing code: it should be 9 digits, 4 characters and 4 characters joined by dashes, like 123456789-XXXX-XXXX." },
  "err.pairCodeChar": { zh: "配对码里有不该有的字「{c}」:应是 9 位数字、4 位、4 位,用短横连起来,形如 123456789-XXXX-XXXX。", en: "The pairing code contains a character it can't have (“{c}”): it should be 9 digits, 4 characters and 4 characters joined by dashes, like 123456789-XXXX-XXXX." },
  "err.accountInUse": { zh: "这台上已经有这个账户的一本了(「{name}」)。若那一本已被移出账户,想重新加入:先把只在那一本里的几条复制出来,再到「空间」里把它「重置」,然后输码加入。", en: "This device already has a notebook on this account (“{name}”). If that one was removed from the account and you want to rejoin: copy out the entries that exist only there, reset it under Spaces, then join with the code." },
  "err.conflict": { zh: "这次改动和已有的数据对不上,没有存。", en: "This change conflicts with existing data and wasn't saved." },
  "err.gone": { zh: "要改的那一条已经不在了(可能在另一台设备上删掉或移走了)。", en: "That entry is no longer there (it may have been deleted or moved on another device)." },
  "err.probeNext": { zh: "网络自检", en: "Network check" },
  "ui.stageTodo": { zh: "待办", en: "To do" },
  "ui.stageDoing": { zh: "进行中", en: "In progress" },
  "ui.stageConfirming": { zh: "待确认", en: "To confirm" },
  "ui.stageDone": { zh: "已完成", en: "Done" },
  // 165 / W5 Q14:时间两端一个写法 —— 今天的「今天 15:18」,别的天「11月5日 15:18」,跨年带年(ui.ts::fmtWhen)。
  "ui.whenToday": { zh: "今天 {hm}", en: "Today {hm}" },
  "ui.whenThisYear": { zh: "{m}月{d}日 {hm}", en: "{m}/{d} {hm}" },
  "ui.whenOtherYear": { zh: "{y}年{m}月{d}日 {hm}", en: "{m}/{d}/{y} {hm}" },
  // 随记时间轴的日期节头(dayLabel)。值与桌面 tasktime.today / yesterday /
  // dayBeforeYesterday / monthDay / yearMonthDay **逐字同形**,键名按本端 ui.* 前缀
  // (两份字典键空间独立)。⛔ 别拿 main.dueToday 顶——那枚是
  // 截止角标的字,同形不同物,哪天截止改说「今日到期」这儿会跟着坏(一物一名)。
  "ui.dayToday": { zh: "今天", en: "Today" },
  "ui.dayYesterday": { zh: "昨天", en: "Yesterday" },
  "ui.dayBeforeYesterday": { zh: "前天", en: "2 days ago" },
  "ui.dayMonthDay": { zh: "{m}月{d}日", en: "{m}/{d}" },
  "ui.dayYearMonthDay": { zh: "{y}年{m}月{d}日", en: "{m}/{d}/{y}" },
});
