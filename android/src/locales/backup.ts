// 设置面「备份」那一节(backup-plan §17 笔③)。
//
// ⛔ **键空间与桌面独立、⛔ 不进 `CROSS_END_KEYS`**:那张表钉的是筛选 pill 那族「两端
// 必须一字不差」的文案,而这一节两端说的**不是同一件事** —— 桌面有落点路径框、自动备份、
// 恢复;这一端是 SAF 目录 + 「手机上出得了备份、恢复要到桌面上」。
//
// ⛔ 三条硬判据(§17.9,是判据不是措辞,改文案前先读):
// 1. 列表里每一份的默认状态是「**还没验过**」——文件名 / 扩展名 / 它在不在列表里,
//    **都不是**「这是一份有效备份」的判据(§3.3 收口那条义务)。
// 2. 落点要显示成**用户认得出的样子**,并且说清它在哪一类地方 ——「已经挑了个文件夹」
//    ⛔ 不等于「你安全了」:落点在手机本机上挡得住误删,**挡不住手机丢了**。
// 3. 仪式文案在这一端要**写强**(§17.7):清数据 / 卸载会连 `.backup.json` 一起抹掉,
//    抄下来那串码是**唯一的**那份 —— ⛔ 不许照抄桌面那份更温和的措辞。
import { defineMessages } from "./entry";

export const backup = defineMessages({
  "backup.title": { zh: "备份", en: "Backup" },
  "backup.loading": { zh: "读取中…", en: "Loading…" },

  // ---- ① 还没设置 ----
  "backup.notSet": { zh: "还没设置。备份文件是加密的,要先生成一串「备份码」。", en: "Not set up yet. Backups are encrypted, so you need a backup code first." },
  "backup.setUp": { zh: "设置备份", en: "Set up" },

  // ---- ② 仪式 ----
  // 161 / W4 Q11(X-06):两端一个说法 ——「每台设备各一串;拿哪台的备份去恢复,就填哪台的码」(此前这里说「唯一钥匙」,
  // 读成全账户只有一串)。
  "backup.ceremonyIntro": { zh: "把下面这串码抄在纸上(或存进密码管理器),然后原样输一遍。每台设备各一串;拿哪台的备份去恢复,就填哪台的码。", en: "Copy the code below onto paper (or into a password manager), then type it back exactly. Each device has its own code; to restore a backup, use the code of the device that made it." },
  "backup.ceremonyWarn": { zh: "这串码只存在这台手机上。卸载 app 或在系统设置里「清除数据」,它就没了;到那时,这台手机做的备份没抄下码就永远打不开(文件夹里的备份文件本身还在)。", en: "This code is stored only on this phone. Uninstalling the app or clearing its data erases it; after that, backups made on this phone can never be opened unless you wrote the code down (the backup files in your folder stay where they are)." },
  "backup.ceremonyConfirmPh": { zh: "把上面那串码输在这里", en: "Type the code here" },
  "backup.ceremonyConfirm": { zh: "我抄好了,核对", en: "Check what I typed" },
  "backup.ceremonyCancel": { zh: "取消", en: "Cancel" },
  "backup.ceremonyDone": { zh: "备份码已保存。接下来挑一个放备份的文件夹。", en: "Backup code saved. Next, pick a folder to keep backups in." },

  // ---- ③ 落点 ----
  "backup.dirName": { zh: "备份放哪儿", en: "Backup folder" },
  "backup.dirNone": { zh: "还没挑文件夹。", en: "No folder picked yet." },
  "backup.dirPick": { zh: "挑一个文件夹", en: "Pick a folder" },
  "backup.dirChange": { zh: "换一个", en: "Change" },
  "backup.dirAt": { zh: "在「{name}」", en: "In “{name}”" },
  "backup.dirGone": { zh: "落点没了(授权被撤销、文件夹被删,或 U 盘 / SD 卡拔了)。请重新挑一个文件夹。", en: "The folder is gone (permission revoked, folder deleted, or the drive was removed). Please pick one again." },
  "backup.dirCancelled": { zh: "没有挑文件夹。", en: "No folder was picked." },
  "backup.dirAdvice": { zh: "挑网盘的同步文件夹或 U 盘最好。放在手机自己身上的文件夹挡得住误删,但手机丢了 / 坏了,备份跟着一起没。", en: "A cloud-sync folder or a USB drive is best. A folder on the phone itself protects against accidental deletion, but not against losing or breaking the phone." },

  // ---- ④ 立即备份 ----
  "backup.runName": { zh: "立即备份", en: "Back up now" },
  "backup.run": { zh: "备份", en: "Back up" },
  "backup.running": { zh: "正在备份…(加密整个库,别退出这一页)", en: "Backing up… (encrypting the whole library; stay on this page)" },
  "backup.moving": { zh: "正在放进你的文件夹…", en: "Copying into your folder…" },
  "backup.madeNone": { zh: "这一趟一份也没做成。", en: "Nothing was backed up this time." },
  "backup.made": { zh: "做好了 {n} 份。", en: "Made {n} {n|backup|backups}." },
  // 161 / W4 A15(WM-09):文件名不在这一句里重说一遍 —— 下面「文件夹里的备份」那一行就是它(此前同一个长名字一屏三遍)。
  "backup.movedOk": { zh: "已放进你的文件夹", en: "Saved into your folder" },
  "backup.movedFail": { zh: "备份做好了,但没能放进你选的文件夹:{why}", en: "The backup was made, but could not be put into your folder: {why}" },
  "backup.moveRetry": { zh: "再试一次", en: "Try again" },
  "backup.moveUnknown": { zh: "这一趟的结果不好说了。请下拉重开这一页看看文件夹里有没有它。", en: "The outcome of that attempt is unknown. Reopen this page and check your folder." },
  "backup.reportFailed": { zh: "有 {n} 个空间失败了:", en: "{n} {n|space|spaces} failed:" },
  "backup.reportFatal": { zh: "整批停下了:", en: "The whole run stopped: " },
  "backup.reportSkipped": { zh: "还有 {n} 个空间根本没跑。", en: "{n} {n|space was|spaces were} not attempted at all." },
  "backup.leftoverUnverified": { zh: "(盘上留下一个写完但没验过的文件;它不算一份备份)", en: "(A file was left on disk but never verified; it does not count as a backup)" },
  "backup.leftoverInvalid": { zh: "(盘上留下一个验不过又删不掉的文件;它不算一份备份)", en: "(A file was left on disk that fails verification and could not be deleted; it does not count as a backup)" },

  // ---- ⑤ 列表与验证 ----
  "backup.listName": { zh: "文件夹里的备份", en: "Backups in that folder" },
  "backup.listReload": { zh: "刷新", en: "Refresh" },
  "backup.listEmpty": { zh: "这个文件夹里还没有备份。", en: "No backups in this folder yet." },
  "backup.listUnverified": { zh: "还没验过", en: "Not verified yet" },
  "backup.listVerify": { zh: "验证", en: "Verify" },
  "backup.listVerifying": { zh: "正在验…", en: "Verifying…" },
  "backup.listOk": { zh: "现在打得开:{space} · {size}", en: "Opens now: {space} · {size}" },
  "backup.listTruncated": { zh: "只显示最近 {n} 个。", en: "Showing the most recent {n} only." },
  "backup.othersLead": { zh: "这个文件夹里还有 {n} 个其他文件;备份可能被系统改过名字,点这里全部列出", en: "This folder holds {n} other files; a backup may have been renamed by the system, tap to list them all" },
  "backup.othersLeadMany": { zh: "这个文件夹里还有 200+ 个其他文件;备份可能被系统改过名字,点这里全部列出", en: "This folder holds 200+ other files; a backup may have been renamed by the system, tap to list them all" },
  "backup.othersBack": { zh: "只看像备份的", en: "Show likely backups only" },
  "backup.listEmptyScanned": { zh: "在这次检查的 {n} 个文件里没有发现备份;这个文件夹的其余部分还没查。", en: "No backups were found among the {n} files examined; the rest of this folder has not been checked." },
  "backup.othersLeadScanned": { zh: "在已检查的 {scanned} 个文件里另有 {n} 个其他文件;备份可能被系统改过名字,点这里看这次检查到的(最多显示 200 个)", en: "Among the {scanned} files examined there are {n} others; a backup may have been renamed by the system, tap to view those examined (up to 200 shown)" },
  "backup.othersLeadManyScanned": { zh: "在已检查的 {scanned} 个文件里至少还有 200+ 个其他文件;备份可能被系统改过名字,点这里看这次检查到的(最多显示 200 个)", en: "Among the {scanned} files examined there are at least 200+ others; a backup may have been renamed by the system, tap to view those examined (up to 200 shown)" },
  "backup.listTruncatedScanned": { zh: "而且这次检查到的候选里,也只显示最近 {n} 个。", en: "And among the candidates found in this pass, only the {n} most recent are shown." },
  "backup.listScanTruncated": { zh: "这个文件夹太大;这次只看了其中 {n} 个文件,下面不一定是你全部的备份。把备份放进一个单独的文件夹会好找得多。", en: "This folder is very large; only {n} files were examined, so this may not be all your backups. Keeping backups in a folder of their own works much better." },
  "backup.verifyUnknown": { zh: "这次验证的结果不确定。重开这一页再验一次。", en: "The outcome of this verification is unknown. Reopen this page and verify again." },

  // ---- 封锁 / 配置坏了 ----
  "backup.blockedLead": { zh: "备份被暂停了:", en: "Backups are paused: " },
  "backup.retryCleanup": { zh: "重试清理", en: "Retry cleanup" },
  "backup.cleaning": { zh: "正在清理…", en: "Cleaning up…" },
  "backup.cleanOk": { zh: "清理干净了,可以继续备份。", en: "Cleaned up. You can back up again." },
  "backup.problemLead": { zh: "备份设置有问题:", en: "There is a problem with the backup settings: " },
  "backup.problemHint": { zh: "⛔ 别重新设置一次。那会换一把新钥匙,已经做好的备份从此永远打不开。请到桌面端处理,或先把已有备份保管好。", en: "⛔ Do not set it up again. That would create a new key and your existing backups could never be opened. Handle it on the desktop, or keep your existing backups safe first." },

  // ---- 启动收尸留下的话 ----
  "backup.lastPutFailed": { zh: "上次那趟没跑完,那份没能放进你的文件夹。请重新备份一次。", en: "The last attempt did not finish and never reached your folder. Please back up again." },
  "backup.lastFetchFailed": { zh: "上次验证没做完,可以再验一次。", en: "The last verification did not finish. You can verify again." },
  "backup.healthRecordUnknown": { zh: "上次那趟的状态读不出来。", en: "The status of the last attempt could not be read." },
  "backup.healthCleanupFailed": { zh: "上次的中转文件没清干净(不影响再备份,下次启动会接着清)。", en: "Some staging files were not cleaned up (harmless; the app will keep trying at startup)." },
  "backup.outboxMismatch": { zh: "装的形与预期不符,备份暂时不能用:", en: "The install layout is not what was expected, so backup is unavailable: " },
  "backup.noBridge": { zh: "这个版本的壳没有备份落点桥(前端与壳版本不配)。", en: "This shell build has no backup-folder bridge (front end and shell versions do not match)." },
  // ⭐ 与上一句**刻意分成两句**(471):上一句说的是「该有却没有」= 装的形不对;
  // 这一句说的是「这一端就没有这条路」= 平台边界(鸿蒙没有 SAF 那样的文件夹授权入口)。
  "backup.notOnThisEnd": { zh: "这一端还没有备份。挑文件夹存放的那条系统入口在这个系统上还没接。要备份请用电脑版的朱简。", en: "Backup is not available on this build. The system “pick a folder” entry point is not wired up on this platform yet. Use Zhujian on a computer to back up." },
  "backup.replyUnreadable": { zh: "壳的应答读不懂(前端与壳版本不配?)。", en: "The shell reply could not be read (front end and shell versions may not match)." },
  "backup.notStarted": { zh: "这一趟没能开始。", en: "That attempt could not be started." },
  "backup.notDone": { zh: "这一趟没跑成。", en: "That attempt did not complete." },

  // ---- 诚实边界(⛔ 原样进 UI,别在文案里软化,§17.12)----
  "backup.footRestore": { zh: "手机上能做备份,但不能从备份还原。真出事时把 .zjbak 文件拿到电脑上的朱简里恢复。", en: "You can create backups on the phone but cannot restore from them here; if something goes wrong, restore the .zjbak file in Zhujian on a computer." },
  // 161 / W4 Q11(WM-34):卸载后没的只是手机上存的那份码,文件夹里的备份文件还在(复核实测 pm clear 前后都在)。
  "backup.footCode": { zh: "备份码保存在这台手机上(明文),卸载或清除数据会把它抹掉,抄下来的那份就是唯一的了;已经放进文件夹的备份文件不会跟着没。", en: "The backup code is stored on this phone in plain text and is erased if you uninstall or clear app data, leaving your written copy as the only one; backup files already in your folder are not deleted." },
  // 161 / W4 Q11(WM-34 / X-12):点一次备的是哪些空间、手机上没有自动备份、备份文件加码等于什么。
  "backup.footScope": { zh: "点「备份」会把这台手机上的每个空间各备一份。手机上没有自动备份:想备份就回这里点一次。", en: "Back up makes one backup of every space on this phone. There is no automatic backup on the phone: come back here and tap it whenever you want one." },
  "backup.footSecret": { zh: "备份文件加上备份码,就能打开里面的全部内容;开过同步的空间,还能拿它读写这个账户。两样都当秘密保管。", en: "A backup file plus its code opens everything in it; for a space with sync turned on, it also gives read and write access to that account. Keep both secret." },
  "backup.footValid": { zh: "「有效」只有验过才算。文件名和扩展名证明不了任何事。", en: "“Valid” only means verified. A file name or extension proves nothing." },
});
