// src/backup.ts(设置面里的「备份」一节)的文案分片(412,backup-plan 笔①-a)。
//
// ⚠ 后端(Rust)的诊断串**刻意不翻**(i18n-plan 的边界),失败原因原话直接显示 ——
// 这一份只管界面自己那些话。⚠ §9 那几条诚实边界是**判据不是修辞**,改措辞前先读那一节:
// ⛔ 不许写成「丢了码谁也解不开」(钥还躺在 `.backup.json` 里时那句就是假的);
// ⛔ 不许暗示「有备份 = 不会丢」(那是耐久性承诺,sync-plan 那条红线不许越)。
import { defineMessages } from "./entry";

export const backup = defineMessages({
  "backup.title": { zh: "备份", en: "Backup" },
  "backup.sub": { zh: "把每个空间的完整数据加密成一个文件,存到你自己拿得到的地方(U 盘 / 网盘都行)。没有备份码,文件里的内容读不出来。⚠ 备份是把保管权交到你手上,不等于「不会丢」。", en: "Encrypts each space into a single file you keep yourself — a USB stick, a cloud drive, anywhere. Without the backup code its contents cannot be read. ⚠ A backup hands custody to you; it is not a promise that nothing can be lost." },
  "backup.notSet": { zh: "还没设置", en: "Not set up yet" },
  "backup.setUp": { zh: "设置备份", en: "Set up backup" },
  "backup.dirName": { zh: "备份到", en: "Back up to" },
  "backup.dirPh": { zh: "备份文件夹的完整路径", en: "Full path of the backup folder" },
  "backup.dirSaved": { zh: "已保存,下次备份就落这里", en: "Saved — the next backup lands here" },
  "backup.openDir": { zh: "打开文件夹", en: "Open folder" },
  "backup.runName": { zh: "手动备份", en: "Manual backup" },
  "backup.runDesc": { zh: "点一下,所有空间各备一份", en: "One click backs up every space" },
  "backup.runNow": { zh: "立即备份", en: "Back up now" },
  "backup.running": { zh: "备份中…(整库加密 + 全量校验,大库要等一会)", en: "Backing up… (encrypting and fully verifying — a large library takes a moment)" },
  "backup.retryCleanup": { zh: "重试清扫", en: "Retry cleanup" },
  "backup.cleaning": { zh: "清扫中…", en: "Cleaning…" },
  "backup.cleanNowOk": { zh: "暂存区已清干净,可以备份了", en: "The staging area is clean — backups are available again" },
  // 仪式(§5:显示 → 完整回输 → 对上了才落盘;⛔ 不许退化成勾「我已抄下」)。
  "backup.ceremonyIntro": { zh: "这是你的备份码。现在就抄下来——纸上、密码管理器都行,别只留在这台电脑上。", en: "This is your backup code. Write it down now — on paper or in a password manager, not only on this computer." },
  "backup.ceremonyWarn": { zh: "⚠ 备份码,以及所有还存着这把钥的设备,全都失去之后,已有的备份文件谁也解不开,包括我们。没有找回通道。", en: "⚠ Once the backup code and every device that still holds this key are gone, no one can open your existing backups — including us. There is no recovery channel." },
  "backup.ceremonyConfirmPh": { zh: "把上面的备份码抄回来", en: "Type the backup code back in" },
  "backup.ceremonyConfirm": { zh: "抄好了,核对", en: "I wrote it down — check it" },
  "backup.ceremonyCancel": { zh: "取消", en: "Cancel" },
  "backup.ceremonyDone": { zh: "备份已设置好", en: "Backup is set up" },
  // 结果(⭐ 部分成功必须摊开;有 fatal 时「剩下的根本没跑」要与「跑了但失败」显著区分)。
  "backup.reportMade": { zh: "备好 {n} 个空间", en: "Backed up {n} {n|space|spaces}" },
  "backup.reportNone": { zh: "这一趟一个空间都没备成", en: "Nothing was backed up this time" },
  "backup.reportFailed": { zh: "失败 {n} 个", en: "{n} failed" },
  "backup.reportSkipped": { zh: "⚠ 还有 {n} 个空间根本没跑(整批停下了)", en: "⚠ {n} further {n|space was|spaces were} not attempted at all — the batch stopped" },
  "backup.reportFatal": { zh: "⚠ 整批停下:", en: "⚠ The batch stopped: " },
  "backup.leftoverUnverified": { zh: "这个文件写出来了,但没来得及校验——先别把它当成一份可用的备份。", en: "This file was written but never verified — do not count it as a usable backup yet." },
  "backup.leftoverInvalid": { zh: "⛔ 这个文件校验不过、又删不掉,它不是一份备份。请手动删掉它。", en: "⛔ This file failed verification and could not be deleted — it is not a backup. Please delete it by hand." },
  // 坏配置:⛔ 绝不许在这里「重新设置一次」(那会换一把钥,已有备份从此打不开)。
  "backup.problemLead": { zh: "⛔ 备份设置有问题:", en: "⛔ Something is wrong with the backup settings: " },
  "backup.problemHint": { zh: "别重新设置一次——那会生成一把新的备份钥,已有的备份文件将永远打不开。先把那个文件修好或找回。", en: "Do not simply set it up again — that generates a new key and your existing backups would never open again. Repair or restore that file first." },
  // 常驻的两条诚实边界(§9;⛔ 不是修辞,别删)。
  "backup.footUninstall": { zh: "⚠ 卸载朱简不会删掉备份钥和数据目录。要彻底清干净得手动删——但删之前先确认备份码另有一份独立副本,否则你存在外面的备份可能永远解不开。", en: "⚠ Uninstalling Zhujian does not delete the backup key or the data folder. Clearing them is manual — but first make sure the backup code exists somewhere else, or the backups you keep elsewhere may never open again." },
  "backup.footSecrets": { zh: "⚠ 备份文件里含这台设备的同步身份与账户密钥(否则恢复出来的库同步不了)——拿到备份文件加备份码,就等于拿到这个账户的完整读写能力。", en: "⚠ A backup contains this device's sync identity and account key (otherwise a restored library could not sync) — a backup file plus the code is full read/write access to the account." },
});
