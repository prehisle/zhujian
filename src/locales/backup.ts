// src/backup.ts(设置面里的「备份」一节)的文案分片(412,backup-plan 笔①-a)。
//
// ⚠ 后端(Rust)的诊断串**刻意不翻**(i18n-plan 的边界),失败原因原话直接显示 ——
// 这一份只管界面自己那些话。⚠ §9 那几条诚实边界是**判据不是修辞**,改措辞前先读那一节:
// ⛔ 不许写成「丢了码谁也解不开」(钥还躺在 `.backup.json` 里时那句就是假的);
// ⛔ 不许暗示「有备份 = 不会丢」(那是耐久性承诺,sync-plan 那条红线不许越)。
//
// ⛔ **⚠ / ⛔ / ⭐ 这类记号,只许出现在「容器本身不带严重性」的文案里**(651 立):
// 它们是**内部文档的约定**,写进产品文案就是把仓里的行文习惯漏给用户看。判据是渲染点 ——
// `hkset-msg err` / `sync-err` / 安卓 `warn-ink` 的颜色都是 `--seal`(朱砂),**颜色已经把话说了**,
// 再加一个 ⚠ 是同一件事说两遍;而 `settings-sub`(折叠里的说明)与 `bkup-file`(`--ink-faint` 灰)
// **不带任何严重性**,那里的记号是唯一的信号,⛔ 别裸删。
// ⭐ 651 按这条清了一遍:朱砂容器里那 8 处记号全删,灰容器里的 4 处原样留着。
// ⛔ `restoreLead1` 上原本那个 **⭐** 是最不该有的一个 —— 它在仓里的意思是「意外发现」,
//    对用户毫无意义,而那句话本身是**安心话不是警告**,连替代视觉都不需要,直接删。
import { defineMessages } from "./entry";

export const backup = defineMessages({
  "backup.title": { zh: "备份", en: "Backup" },
  "backup.sub": { zh: "把每个空间的完整数据加密成一个文件,存到你自己拿得到的地方(U 盘 / 网盘都行)。没有备份码,文件里的内容读不出来。⚠ 备份是把保管权交到你手上,不等于「不会丢」。", en: "Encrypts each space into a single file you keep yourself: a USB stick, a cloud drive, anywhere. Without the backup code its contents cannot be read. ⚠ A backup hands custody to you; it is not a promise that nothing can be lost." },
  "backup.notSet": { zh: "还没设置", en: "Not set up yet" },
  "backup.setUp": { zh: "设置备份", en: "Set up backup" },
  "backup.dirName": { zh: "备份到", en: "Back up to" },
  "backup.dirPh": { zh: "备份文件夹的完整路径", en: "Full path of the backup folder" },
  "backup.dirSaved": { zh: "已保存,下次备份就落这里", en: "Saved, the next backup lands here" },
  "backup.openDir": { zh: "打开文件夹", en: "Open folder" },
  // W4 Q11 / WD-24:默认落点与主库同一块盘 —— 指南那句搬到「备份到」那一行下面(此前只在指南里)。
  "backup.dirNote": { zh: "默认在这台电脑的数据目录里,和主库同一块盘;想防硬盘坏,就换成 U 盘或网盘文件夹的完整路径。", en: "By default this is in the app’s data folder on this computer, on the same disk as your library; to guard against a disk failure, enter the full path of a USB stick or cloud-drive folder instead." },
  "backup.runName": { zh: "手动备份", en: "Manual backup" },
  "backup.runDesc": { zh: "点一下,所有空间各备一份", en: "One click backs up every space" },
  // W4 A4(WD-03):「立即备份」那一行的说明格照实说有没有备份 —— 此前核对通过后写「备份已设置好」,
  // 其实一份都没有、自动备份也没开。W4 A19:这一趟的结果也写在这一格里,不往下插一段推版面。
  "backup.noBackupYet": { zh: "还没有备份:点「立即备份」现在备一份,或打开下面的「自动备份」。", en: "No backup yet: click Back up now, or turn on Automatic backup below." },
  "backup.setUpNoBackup": { zh: "备份码已核对,但还没有备份:点「立即备份」现在备一份,或打开下面的「自动备份」。", en: "Backup code checked, but there is no backup yet: click Back up now, or turn on Automatic backup below." },
  "backup.setUpDone": { zh: "备份码已核对。点「立即备份」就用它备一份。", en: "Backup code checked. Click Back up now to make a backup with it." },
  "backup.ranOk": { zh: "{when} 备好 {n} 个空间:{spaces}", en: "{when}: backed up {n} {n|space|spaces}: {spaces}" },
  "backup.nameSep": { zh: "、", en: ", " },
  "backup.ranPartly": { zh: "这一趟没全备成,细节在下面", en: "This run didn’t fully succeed; details below" },
  "backup.runNow": { zh: "立即备份", en: "Back up now" },
  "backup.running": { zh: "备份中…(先加密,再从头核对一遍;内容多要等一会)", en: "Backing up… (encrypting, then checking everything once more; more content takes longer)" },
  "backup.retryCleanup": { zh: "重试清扫", en: "Retry cleanup" },
  "backup.cleaning": { zh: "清扫中…", en: "Cleaning…" },
  "backup.cleanNowOk": { zh: "暂存区已清干净,可以备份了", en: "The staging area is clean, backups are available again" },
  // 仪式(§5:显示 → 完整回输 → 对上了才落盘;⛔ 不许退化成勾「我已抄下」)。
  "backup.ceremonyIntro": { zh: "这是你的备份码。现在就抄下来。纸上、密码管理器都行,别只留在这台电脑上。{perDevice}", en: "This is your backup code. Write it down now: on paper or in a password manager, not only on this computer. {perDevice}" },
  "backup.ceremonyWarn": { zh: "备份码,以及所有还存着这把备份密钥的设备,全都失去之后,已有的备份文件谁也解不开,包括我。没有找回通道。", en: "Once the backup code and every device that still holds this backup key are gone, no one can open your existing backups, including me. There is no recovery channel." },
  "backup.ceremonyConfirmPh": { zh: "把上面的备份码抄回来", en: "Type the backup code back in" },
  "backup.ceremonyConfirm": { zh: "抄好了,核对", en: "I wrote it down; check it" },
  "backup.ceremonyCancel": { zh: "取消", en: "Cancel" },
  // W4 X-06:两端同一句(手机那边同键同值,CROSS_END_KEYS 登记)—— 每台设备的备份码是它自己的。
  "backup.perDeviceCode": { zh: "每台设备各一串;拿哪台的备份去恢复,就填哪台的码。", en: "Each device has its own code; to restore a backup, enter the code of the device that made it." },
  // W4 A18(WD-18):抄错时说出错在哪一组(设置时码就在手上,逐组比);恢复时码的形状不对也指到那一组,
  // 两处一个口径。⛔ 只是挑话:码对不对恒由 core 判(backup.ts `codeShapeProblem` 头注)。
  "backup.codeEmpty": { zh: "框里还是空的:照着上面那串码,一组一组打进来,再点「抄好了,核对」。", en: "The box is still empty: type in the code above, group by group, then click “I wrote it down; check it”." },
  "backup.codeGroupDiff": { zh: "第 {n} 组对不上:上面是「{want}」,框里是「{got}」。改好那一组再核对。", en: "Group {n} doesn’t match: the code above has “{want}”, the box has “{got}”. Fix that group and check again." },
  "backup.codeBadChar": { zh: "第 {n} 组里的「{ch}」不会出现在备份码里,核对那一组再试。", en: "Group {n} contains “{ch}”, which never appears in a backup code. Check that group and try again." },
  "backup.codeGroupLen": { zh: "第 {n} 组是 {len} 位,每组应为 {per} 位,核对那一组再试。", en: "Group {n} has {len} {len|character|characters}; each group has {per}. Check that group and try again." },
  "backup.codeLen": { zh: "备份码是 {groups} 组、共 {total} 位,这里是 {len} 位:看看是不是漏抄或多抄了一组。", en: "A backup code is {groups} groups, {total} characters in all; this has {len}. Check for a missing or extra group." },
  // 结果(⭐ 部分成功必须摊开;有 fatal 时「剩下的根本没跑」要与「跑了但失败」显著区分)。
  "backup.reportMade": { zh: "备好 {n} 个空间", en: "Backed up {n} {n|space|spaces}" },
  "backup.reportNone": { zh: "这一趟一个空间都没备成", en: "Nothing was backed up this time" },
  "backup.reportFailed": { zh: "失败 {n} 个", en: "{n} failed" },
  "backup.reportSkipped": { zh: "还有 {n} 个空间根本没跑(整批停下了)", en: "{n} further {n|space was|spaces were} not attempted at all; the batch stopped" },
  "backup.reportFatal": { zh: "整批停下:", en: "The batch stopped: " },
  "backup.leftoverUnverified": { zh: "这个文件写出来了,但没来得及校验。先别把它当成一份可用的备份。", en: "This file was written but never verified. Do not count it as a usable backup yet." },
  "backup.leftoverInvalid": { zh: "⛔ 这个文件校验不过、又删不掉,它不是一份备份。请手动删掉它。", en: "⛔ This file failed verification and could not be deleted; it is not a backup. Please delete it by hand." },
  // 备份列表(§3.3 那条义务的落点)。⛔ **默认那句是「还没验过」,不是「有效」** ——
  // 名字 / 扩展名 / 大小都证明不了一份备份能不能打开,只有真解一遍才算。
  "backup.listName": { zh: "已有备份", en: "Existing backups" },
  "backup.listDesc": { zh: "上面那个文件夹里的备份文件(.zjbak);能不能打开,要点「验证」才知道", en: "The backup files (.zjbak) in the folder above; only Verify can tell you whether one opens" },
  // 折叠态那行汇总(2026-08-31 用户拍板「整节默认折叠」)。⛔ 「最新」说的是**盘上改动时刻**,
  // 与「能不能打开」无关 —— 别把这行写成任何形式的「有 N 份好备份」。
  "backup.listSummary": { zh: "{n} 份 · 最新 {when}", en: "{n} {n|file|files} · latest {when}" },
  "backup.listSummaryBare": { zh: "{n} 份", en: "{n} {n|file|files}" },
  "backup.listShow": { zh: "展开", en: "Show" },
  "backup.listHide": { zh: "收起", en: "Hide" },
  "backup.listReload": { zh: "刷新", en: "Refresh" },
  "backup.listEmpty": { zh: "这个目录里还没有备份文件。", en: "No backup files in this folder yet." },
  "backup.listUnverified": { zh: "还没验过", en: "Not verified yet" },
  "backup.listVerify": { zh: "验证", en: "Verify" },
  "backup.listRestore": { zh: "恢复这一份", en: "Restore this one" },
  "backup.listCopyPath": { zh: "复制路径", en: "Copy path" },
  "backup.listVerifying": { zh: "正在整个解一遍…", en: "Decrypting the whole file…" },
  // ⛔ 说的是「**现在**打得开」,不许追认「当初那趟备份成功了」(§3.3 那张表的 Verified 那行)。
  "backup.listOk": { zh: "现在打得开:{space} · {when} 备的 · 原库 {size}", en: "Opens right now: {space} · backed up {when} · {size} of library data" },
  // 坏配置:⛔ 绝不许在这里「重新设置一次」(那会换一把钥,已有备份从此打不开)。
  "backup.problemLead": { zh: "备份设置有问题:", en: "Something is wrong with the backup settings: " },
  "backup.problemHint": { zh: "别重新设置一次。那会生成一把新的备份密钥,已有的备份文件将永远打不开。先把那个文件修好或找回。", en: "Do not simply set it up again. That generates a new backup key and your existing backups would never open again. Repair or restore that file first." },
  // 两条诚实边界(§9;⛔ 不是修辞,别删)。⚠ 2026-08-31 起不再**常驻**:与 backup.sub 一起
  // 收进 pane 顶「说明」折叠(用户当面拍板「收纳不删」)—— 动的只是默认显不显,措辞照旧受 §9 管。
  "backup.footUninstall": { zh: "⚠ 卸载朱简不会删掉备份密钥和数据目录。要彻底清干净得手动删,但删之前先确认备份码另有一份独立副本,否则你存在外面的备份可能永远解不开。", en: "⚠ Uninstalling Zhujian does not delete the backup key or the data folder. Clearing them is manual, but first make sure the backup code exists somewhere else, or the backups you keep elsewhere may never open again." },
  "backup.footSecrets": { zh: "⚠ 备份文件里有这台设备登录同步账户用的钥匙(不然恢复出来的库没法同步)。谁拿到备份文件加备份码,就能看、也能改这个账户里的全部内容 —— 两样都要像密码一样收好。", en: "⚠ A backup contains the keys this device uses to sign in to your sync account (otherwise a restored library could not sync). Anyone with the backup file plus the code can read and change everything in the account — keep both as safe as a password." },
  // 自动备份(笔①-b,§15.5)。⛔ 频率与份数是**变量**:那个文件可以手改,写死就会说谎。
  "backup.autoName": { zh: "自动备份", en: "Automatic backup" },
  "backup.autoOn": { zh: "开启", en: "Turn on" },
  "backup.autoOff": { zh: "关闭", en: "Turn off" },
  // W4 A17(WD-07):开着时那一行照实写隔多久、留几份(此前只写「已开启」,两个数藏在「说明」折叠里)。
  "backup.autoStateOnDetail": { zh: "已开启 · {every}一次,每个空间留最近 {keep} 份", en: "On · runs {every}, keeping the {keep} most recent per space" },
  "backup.autoStateOff": { zh: "未开启", en: "Off" },
  "backup.autoDesc": { zh: "{every}一次,每个空间保留最近 {keep} 份,更旧的自动清理。", en: "Runs {every}, keeping the {keep} most recent copies per space; older ones are cleaned up." },
  // ⛔ 措辞按 backup-plan §15.3 末那一句照抄 —— 别写成「手动备份永远不会被自动删除」
  // (轮转与删除之间有一段收窄不掉的窗口,那句绝对承诺不成立)。
  "backup.autoManualSafe": { zh: "手动备份不进入自动清理的账;一旦发现文件身份变了,自动清理就不再管这个文件。", en: "Manual backups are never entered into the automatic cleanup ledger; and once a file's identity no longer matches, automatic cleanup stops managing it." },
  "backup.autoLast": { zh: "上次自动备份:{when} · {what}", en: "Last automatic backup: {when} · {what}" },
  "backup.autoNotYet": { zh: "还没自动备过:开着朱简时,很快会备第一份。", en: "No automatic backup yet: while Zhujian is running, the first one comes shortly." },
  "backup.everyDays": { zh: "每 {n} 天", en: "every {n} {n|day|days}" },
  "backup.everyHours": { zh: "每 {n} 小时", en: "every {n} {n|hour|hours}" },
  "backup.everyMinutes": { zh: "每 {n} 分钟", en: "every {n} {n|minute|minutes}" },
  // ⭐ 420 补:这两条是「路径要列出来」那一格的落点 —— ⛔ 别退回只报数量。
  "backup.releasedLead": { zh: "这 {n} 份自动备份已经不再自动清理,归你自己处置:", en: "These {n} automatic backups are no longer cleaned up automatically; they are yours to handle:" },
  "backup.retryLead": { zh: "这 {n} 份旧备份这次没删掉,下次会再试:", en: "{n} older {n|backup|backups} could not be deleted this time; it will be retried:" },
  "backup.autoReset": { zh: "重置自动备份设置", en: "Reset automatic backup settings" },
  // ⭐ 与 problemHint 那条正相反:这份文件里没有备份钥,重置不会让任何备份变得打不开。
  "backup.autoResetHint": { zh: "这份设置里没有备份密钥,重置它不会让任何已有备份打不开;代价是:已经备出来的旧文件从此不再被自动清理,归你自己管。", en: "These settings hold no backup key. Resetting them cannot make any existing backup unreadable. The cost: older files already produced will no longer be cleaned up automatically; they become yours to manage." },
  "backup.autoBannerLead": { zh: "自动备份没跑顺", en: "Automatic backup had trouble" },
  "backup.autoBannerClose": { zh: "知道了", en: "Got it" },
  // 恢复(笔②,backup-plan §16;426)。⛔ **这几句是判据不是修辞**,改词前先读 §16.11:
  // ⛔ 不许写成「你的库回来了」(拿到的是**多出来的一个空间**);⛔ 不许暗示它覆盖了什么
  // 或接回了旧账户(恢复出来的空间**不同步**,直到你给它创建账户、把别的设备重新加进来)。
  "backup.restoreName": { zh: "从备份恢复", en: "Restore from a backup" },
  "backup.restoreDesc": { zh: "把一份 .zjbak 恢复成一个新空间", en: "Turns a .zjbak file into a new space" },
  "backup.restoreOpen": { zh: "恢复…", en: "Restore…" },
  "backup.restoreClose": { zh: "收起", en: "Close" },
  // 前置提示:§16.2 的形 + §16.11 的诚实边界 + §16.9 的两个数(⛔ 一条都别删)。
  "backup.restoreLead1": { zh: "恢复绝不覆盖任何现有数据:它新建一个空间,原来的空间原样在那儿,要不要删由你决定。", en: "Restoring never overwrites existing data: it creates a new space, and your current spaces stay exactly as they are; deleting them is your call." },
  "backup.restoreLead2": { zh: "恢复出来的空间不同步,直到你给它创建账户、把别的设备重新加进来;它也不会踢掉任何设备、不会让旧账户消失。", en: "The restored space does not sync until you create an account for it and pair your other devices again; it removes no device and makes no old account disappear." },
  "backup.restoreLead3": { zh: "恢复回来的是备份那一刻的数据;同一台机器上恢复会多出一个空间,恢复完会写出它在这台叫什么。", en: "You get the data as of the moment the backup was taken; restoring on the same machine leaves you with one extra space, and once it finishes you are told what it is called here." },
  "backup.restoreLead4": { zh: "跑起来之后不能取消、也没有进度;过程中临时需要大约 3 倍于库大小的磁盘空间。", en: "Once started it cannot be cancelled and shows no progress; it temporarily needs roughly three times the library's size in free disk space." },
  // W4 Q11 / WD-20:路径从哪来。
  "backup.restoreFileHint": { zh: "上面「已有备份」里的,点那一份的「恢复这一份」就填好了;U 盘、手机上拿来的,点「选文件…」去挑,或在下面填它的完整路径。", en: "For a file under Existing backups above, click its Restore this one and this is filled in; for one from a USB stick or a phone, click Choose file… or enter its full path below." },
  "backup.restoreFilePh": { zh: "备份文件(.zjbak)的完整路径", en: "Full path of the backup file (.zjbak)" },
  // 161 / W4 Q11(WD-20):系统打开文件框,只列 .zjbak;选中即填完整路径(src-tauri backup_pick_file)。
  "backup.restorePick": { zh: "选文件…", en: "Choose file…" },
  "backup.pickTitle": { zh: "选一份朱简备份(.zjbak)", en: "Choose a Zhujian backup (.zjbak)" },
  "backup.pickFilter": { zh: "朱简备份", en: "Zhujian backup" },
  "backup.restoreCodePh": { zh: "备份码", en: "Backup code" },
  // ⭐ 这一句是 §16.6 那条坑的产品面:恢复不读本机配置,也绝不把输进来的码存下来。
  "backup.restoreCodeHint": { zh: "{perDevice}这台电脑有没有设置过备份都不影响恢复,输进来的码也不会被存下来。", en: "{perDevice} It does not matter whether this computer has backup set up, and the code you type is never stored." },
  "backup.restoreGo": { zh: "开始恢复", en: "Start restoring" },
  "backup.restoreRunning": { zh: "恢复中…(先解密,再升到这一版的格式、从头核对一遍;不能取消)", en: "Restoring… (decrypting, updating to this version’s format and checking everything; cannot be cancelled)" },
  "backup.restoreNeedFile": { zh: "要恢复哪一份?先填备份文件的完整路径", en: "Which file? Enter the full path of the backup first" },
  "backup.restoreNeedCode": { zh: "还差备份码", en: "The backup code is still missing" },
  // 成功:⛔ 说的是「多了一个空间」,不是「你的库回来了、原样在原处」。
  // W4 A16(WD-09):写出新空间在这台叫什么(自动起的「未命名空间 · XXXX」也照实写),旁边一枚「去看看」。
  "backup.restoreDoneNamed": { zh: "已恢复成一个新空间「{name}」(备份取于 {when})。", en: "Restored as a new space, “{name}” (backed up {when})." },
  "backup.restoreDoneWas": { zh: "备份时它叫「{name}」。", en: "In the backup it was called “{name}”." },
  "backup.restoreDoneNoName": { zh: "已恢复成一个新空间(备份取于 {when}),只是这会儿读不出它在这台叫什么:", en: "Restored as a new space (backed up {when}); its name here couldn’t be read just now:" },
  "backup.restoreGoSee": { zh: "去看看", en: "Go there" },
  // 库已经在盘上、只是这一趟没装配上:⛔ 绝不许显示成「恢复失败」。
  "backup.restoreOnDisk": { zh: "库已经恢复到盘上了(没有覆盖任何东西),只是这一趟没接进空间列表:", en: "The library is already restored on disk (nothing was overwritten); it just was not attached to the space list this time:" },
});
