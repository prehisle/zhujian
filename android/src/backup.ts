// 设置面「备份」一节的安卓半(backup-plan §17 笔③)。
//
// ⛔ **这一层不做任何策略**(与桌面 `src/backup.ts` 同一条纪律):准入、封锁、仪式全在 core
// 的 `BackupCoordinator`;搬运的 single-flight、在飞记录、启动收尸全在 Kotlin 那把锁上。
// 前端只做三件事:①把当前态画出来;②把用户的动作递下去;③**把失败原样摊开**。
//
// ⭐ 与桌面**不同**的三格,每一格都是判据:
// 1. **备份是两步**:core 把密文做进私有 outbox(幕③ 前半)→ 桥把它拷进用户挑的 SAF 目录
//    (幕③ 后半)。⇒ 「做好了」与「放进你的文件夹了」是**两句话**,⛔ 不许合成一句
//    ——「备份做好了但没能放进去」正是本案唯一的新失败形(§17.10)。
// 2. **列表来自 SAF,不来自 core**:core 那边的 `list_backups` 列的是中转区(正常是空的),
//    显示它等于骗人。列表 = Kotlin 列 tree 子项,⛔ 只有盘上事实,没有「有效」这一格。
// 3. ⛔ **没有恢复入口**:手机上出得了备份、还原要拿到桌面上(§17.2 的边界,必须进 UI)。
import { invoke } from "@tauri-apps/api/core";

import { listSpaces, spaceLabel, type SpaceInfo } from "./api";
import { t } from "./i18n";
import { HAS_SAF_BRIDGE } from "./platform";
import * as saf from "./saf";
import { $, showBar } from "./ui";
import { errText } from "./err";

type Status = {
  configured: boolean;
  blocked: string | null;
  busy: "backup" | "cleanup" | "restore" | null;
  awaiting_ceremony: boolean;
  problem: string | null;
};
/** ⭐ 只有**文件名**没有路径 —— 桥面两个方向都只收裸名(§17.5 的 H-1),前端手里
 *  因此从来就没有一条完整路径可传。 */
type Made = { space_id: string; file_name: string; bytes: number };
type Failed = {
  space_id: string;
  message: string;
  leftover_kind: "unverified" | "invalid" | null;
  leftover_name: string | null;
};
type Report = {
  made: Made[];
  failed: Failed[];
  skipped: number;
  fatal: string | null;
  blocked: string | null;
};
type Verified = {
  space_id: string;
  space_name: string | null;
  created_at: string;
  app_version: string;
  plain_bytes: number;
  /** 验完那份回拷没能删掉。⛔ **不是失败**(验证结论照旧成立),但也**不许静默**。 */
  cleanup_error: string | null;
};

/** 仪式进行中(码已显示、还没核对)。关面时据此让后端把那把**只在内存里**的钥丢掉。 */
let ceremonyOpen = false;
/** 「其他文件」那条恒显的路展开了没有(§17.9 末)。 */
let listAll = false;

/**
 * 这次开着 app 时验过的结论(161 / W4 A31,WM-23):点「全部列出」再切回、或点「刷新」,列表整个重画 ——
 * 此前刚验过「现在打得开」的那份当场又变回「还没验过」。⇒ 按「哪个文件 + 它现在的大小与时刻」记住结论,
 * 重画时照旧贴回去。⭐ 只记在内存里(进程没了就没了):「有效」只有验过才算(§3.3),跨进程留着的
 * 结论就成了「当初验过」—— 文件可能早被换掉了。大小或时刻一变就不认(同名文件被覆盖过)。
 * ⛔ 「不确定」那一种不记:那句本来就是叫人再验一次。
 */
const verdicts = new Map<string, { text: string; warn: boolean }>();
const verdictKey = (it: saf.SafItem): string => `${it.docId}|${it.bytes}|${it.ms}`;

/** 打开设置面时调。⛔ 每次都**重新问一遍**状态 —— 回调不是真相源(§17.5)。
 *  161 / W4(Q11 WM-29 后半 / A11):设置面回到上次读到的位置 ⇒ 已经画过的那一份先留着、新的到了原地换,
 *  ⛔ 别先换成一行「读取中…」:那一下整节变矮,还原滚动位时被钳到文档底,落点就偏了。 */
export function loadBackup(): void {
  const body = $("backup-body");
  if (body.childElementCount === 0) body.replaceChildren(el("p", "fine", t("backup.loading")));
  void refresh();
}

/**
 * 关面 / 切走时调:仪式还开着就让后端丢掉那把钥。
 * ⭐ 盘上此刻什么都没写过 ⇒ 下次是干净的首次使用(⛔ 反过来「先落盘再让用户抄」会留下
 * 一把没人抄过的钥)。
 */
export function closeBackup(): void {
  if (!ceremonyOpen) return;
  ceremonyOpen = false;
  void invoke("backup_cancel_setup");
}

/**
 * 设置首页「备份」那一行右边的摘要(906):「还没设置」/「上次 11-13 10:02」;说不准就 null(那一行不写摘要,⛔ 不编)。
 * 「上次」= 用户那个文件夹里**认得出是 core 起名**的备份里最新那份的时刻(文件名里的 UTC 换成本地,同列表那一行的读法)——
 * 只是「文件夹里最新那份是几点的」,⛔ 不是「有效」(那只有点「验证」才算)。没有 SAF 的端、封锁 / 配置坏了、没挑文件夹、
 * 文件夹里一份都认不出:一律 null。只读:一次状态查询 + 一次列目录(与进那一页时做的同一趟),不起任何搬运。
 */
export async function backupSummary(): Promise<string | null> {
  if (!saf.hasBridge()) return null;
  const st = await invoke<Status>("backup_status");
  if (st.problem || st.blocked) return null;
  if (!st.configured) return t("settings.sumBackupUnset");
  const tree = saf.currentTree();
  if (!tree.configured || !tree.writable) return null;
  const list = await saf.listTree(false);
  if (list.error) return null;
  let last = 0;
  for (const it of list.items) {
    const m = CORE_NAME.exec(it.name);
    if (!m) continue;
    const [, , y, mo, d, h, mi, sec] = m;
    last = Math.max(last, Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)));
  }
  if (last === 0) return null;
  const at = new Date(last);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return t("settings.sumBackupLast", { when: `${p2(at.getMonth() + 1)}-${p2(at.getDate())} ${p2(at.getHours())}:${p2(at.getMinutes())}` });
}

async function refresh(): Promise<void> {
  const body = $("backup-body");
  try {
    // ⭐ **相等闸要在画出任何按钮之前 `await` 完**(实现审给前端点的那条):
    // Rust 算的 outbox 与 Kotlin 自己算的不等 ⇒ **一趟 transfer 都不许起**。
    // ⛔ 早先那版是 `void invoke(...).then(...)` —— 那是**竞态**:用户在 promise 落定之前
    // 点「备份」,壳侧 `preflight` 只会回一句「还没核对安装形态」,把一件确定的事说成含糊的。
    const outboxProblem = saf.hasBridge() ? saf.expectOutbox(await invoke<string>("backup_outbox_dir")) : "";
    const st = await invoke<Status>("backup_status");
    render(body, st, outboxProblem);
  } catch (e) {
    body.replaceChildren(el("p", "fine warn-ink", errText(e)));
  }
}

function render(body: HTMLElement, st: Status, outboxProblem: string): void {
  ceremonyOpen = false;
  // 上一次画好的那几行备份先留着,新名单到了原地换(161 / W4,WM-29 后半 / A11):此前每次开设置面,名单都先塌成一行
  // 「读取中…」再长回来 —— 正好在「回到上次读到的位置」那一下之后,内容整块挪一两百像素(V1986A 量过 213px)。
  const keepRows = [...(body.querySelector("#backup-list .bkup-out")?.childNodes ?? [])];
  body.replaceChildren();

  if (!saf.hasBridge()) {
    // ⭐ **同一个"桥不在",两种完全不同的事实**(471,用户面 33 第②格):
    //   · 这一端本来就没有 SAF(鸿蒙)⇒ 说「这一端还没有备份,去电脑版做」;
    //   · 声明有却没挂上(安卓)⇒ 那是构建坏了,照旧说「前端与壳版本不配」。
    // ⛔ 468 之前只有后一句 —— 它按「只有安卓一个端」写的,搬到鸿蒙上说法就错了
    //   (没骗人,但把一个平台边界说成了安装故障)。
    // ⚠ 两句**各自静态**地写出来(⛔ 别写成 `t(cond ? "a" : "b")`):`check-i18n-drift`
    // 静态核键,动态调用要另进 DYNAMIC_T 登记表 —— 为省一行让门禁少看一处不划算。
    // 165 / W5 A34(WM-34):「这一端本来就没有」是平台事实、不是出错 ⇒ 平常的说明字,⛔ 别用出错那种红(此前一整句常驻红字、
    // 却又不带出错的 ! 图标,像是坏了)。「该有却没挂上」才是真出错,照旧红。
    if (HAS_SAF_BRIDGE) body.appendChild(el("p", "fine warn-ink", t("backup.noBridge")));
    else body.appendChild(el("p", "fine", t("backup.notOnThisEnd")));
    return;
  }
  // ⛔ **不等就什么都不给点**(⛔ 不静默重试、⛔ 不回退到别的落点):这是**漂移**类风险
  // (tauri 改了 `getDataDir` / 我们换了 identifier),它的表现会是「备份说成功了、文件搬不过去」。
  if (outboxProblem) {
    body.appendChild(el("p", "fine warn-ink", t("backup.outboxMismatch") + outboxProblem));
    return;
  }

  // 启动那四步留下的两句话(⛔ 它们是 UI 的输入,不挡新的备份)。
  const boot = saf.startupState();
  if (boot.recordUnknown) body.appendChild(el("p", "fine warn-ink", t("backup.healthRecordUnknown")));
  if (boot.cleanupFailed) body.appendChild(el("p", "fine warn-ink", t("backup.healthCleanupFailed")));
  if (boot.last && boot.last.state === "failed") {
    // ⛔ 两种 `kind` 说**两句不同的话**(五弹 H:一刀切会把 `fetch` 的合法重建也撤掉)。
    body.appendChild(
      el(
        "p",
        "fine warn-ink",
        boot.last.kind === "put" ? t("backup.lastPutFailed") : t("backup.lastFetchFailed"),
      ),
    );
  }

  // ⛔ 配置坏了 / 上次写盘死在半路:显原话 + 劝阻,**不给任何按钮**(那会换一把新钥,
  // 已有备份从此永远打不开)。
  if (st.problem) {
    body.append(
      el("p", "fine warn-ink", t("backup.problemLead") + st.problem),
      el("p", "fine", t("backup.problemHint")),
    );
    return;
  }

  // 封锁态:暂存区里还躺着**明文**副本。唯一出路是重试清扫(⛔ 没有「忽略」)。
  if (st.blocked) {
    body.appendChild(blockedBlock(st.blocked));
    return;
  }

  if (!st.configured) {
    body.appendChild(el("p", "fine", t("backup.notSet")));
    const row = el("div", "row", "");
    row.appendChild(button(t("backup.setUp"), false, (b) => {
      b.disabled = true;
      void invoke<string>("backup_begin_setup")
        .then((code) => renderCeremony(body, code))
        .catch((e) => {
          b.disabled = false;
          body.appendChild(el("p", "fine warn-ink", errText(e)));
        });
    }));
    body.appendChild(row);
    return;
  }

  // ⛔ **没落点 / 落点失效时,只给「挑文件夹」这一件事**(实现审弹 2 M-2)——
  // §17.9 的状态③就是这么写的。⚠ 早先那版把「立即备份」照渲染:点下去会**先完整跑一趟
  // 昂贵的 core 备份**(整库 VACUUM + 全量加密 + 自验),产物落进**卸载即没**的私有 outbox,
  // 到 `putFile` 那步才因为没有 tree 而失败 —— 而那时连同进程重试都没有(transfer 压根没起)。
  // ⇒ 白加密一整个库、白留一份垃圾,还给了用户一个「我备份过了」的错觉。
  const tree = saf.currentTree();
  body.appendChild(dirBlock(tree));
  if (!tree.configured || !tree.writable) return;
  body.append(runBlock(), listBlock(keepRows));
}

// ---- 仪式 -------------------------------------------------------------------------

/**
 * 仪式:显示码 → 用户完整回输 → 对上了才落盘。
 *
 * ⛔ **不许退化成勾「我已抄下」**,在这一端更要紧:勾选证明不了抄了、抄全了、抄对了,
 * 而这台手机上那份钥**清一次数据就没了**(§17.7)——「输 52 个字符太烦」和「所有备份
 * 永远打不开」不是一个量级。⛔ 也没有「复制备份码」按钮(一写剪贴板,剪贴板就成了
 * 新的所有者,而系统剪贴板我们清不干净)。
 */
function renderCeremony(body: HTMLElement, code: string): void {
  ceremonyOpen = true;
  body.replaceChildren();
  const input = document.createElement("input");
  input.id = "backup-code-input";
  input.type = "text";
  input.autocapitalize = "characters";
  input.spellcheck = false;
  input.placeholder = t("backup.ceremonyConfirmPh");
  const msg = el("p", "fine warn-ink", "");

  const row = el("div", "row", "");
  row.appendChild(input);
  const acts = el("div", "row", "");
  const confirm = button(t("backup.ceremonyConfirm"), false, (b) => {
    b.disabled = true;
    msg.textContent = "";
    void invoke("backup_confirm_setup", { code: input.value })
      .then(() => {
        ceremonyOpen = false;
        // 161 / W4 A32(WM-24):核对通过这一下要看得见 —— 此前那句排在主钮和一段长说明下面,像什么都没发生。
        void refresh().then(() => showBar(t("backup.ceremonyDone"), true));
      })
      .catch((e) => {
        b.disabled = false;
        msg.textContent = errText(e);
      });
  });
  const cancel = button(t("backup.ceremonyCancel"), true, () => {
    ceremonyOpen = false;
    void invoke("backup_cancel_setup").then(() => refresh());
  });
  acts.append(confirm, cancel);

  const codeBox = codeView(code);
  body.append(
    el("p", "fine", t("backup.ceremonyIntro")),
    codeBox,
    el("p", "fine warn-ink", t("backup.ceremonyWarn")),
    row,
    acts,
    msg,
  );
  fitCode(codeBox);
  input.focus();
}

/**
 * 备份码那一框(161 / W4 A18 + Q11 WM-35)。两件事:
 * ①**一组 4 位不许拆在两行**(此前 `word-break: break-all` 按字折,「P / H5C」照着抄就成了两组)。
 *   横杠后面那个位置**不总是**断行机会:UAX#14 LB25 不许在「-」与数字之间断,而组以数字打头很常见 ⇒
 *   每个横杠后面补一枚零宽空格(U+200B)当断点,组内一个都没有 ⇒ 只会在组与组之间折。
 * ②**长按「全选」只选中这串码**(此前选中整页 946 个字):只读 textarea —— 系统菜单的「全选」在框里只选框内。
 *   ⛔ 不加「复制」钮:剪贴板一写就成了码的新主人、这一端清不干净,上面那条否决照旧;想存进密码管理器的人自己选了复制。
 *   复制时把那几枚零宽空格剥掉(`copy` 事件里改写剪贴板)—— 不剥的话粘出来的码里夹着看不见的字。
 * ⛔ 码本身的形一个字不动:显示的仍是 core 给的「XXXX-XXXX-…」,零宽空格只活在这一框里。
 */
function codeView(code: string): HTMLTextAreaElement {
  const box = document.createElement("textarea");
  box.className = "bkup-code";
  box.readOnly = true;
  box.spellcheck = false;
  box.rows = 1;
  box.value = code.split("-").join(`-${ZWSP}`);
  box.addEventListener("copy", (e) => {
    if (!e.clipboardData) return; // 拿不到剪贴板数据 ⇒ 交给系统照常复制(不吞这一下)
    e.clipboardData.setData("text/plain", box.value.slice(box.selectionStart, box.selectionEnd).replaceAll(ZWSP, ""));
    e.preventDefault();
  });
  return box;
}

/** 零宽空格:码框里组与组之间的断点(见 `codeView`)。 */
const ZWSP = String.fromCharCode(0x200b);

/** 只读框没有「按内容长高」这回事(`field-sizing` 最老那台 WebView 不认)⇒ 量一次撑到正好;宽变了(转屏 / 字号)再量。 */
function fitCode(box: HTMLTextAreaElement): void {
  let lastW = -1;
  const fit = (): void => {
    if (box.clientWidth === lastW) return;
    lastW = box.clientWidth;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  };
  fit();
  new ResizeObserver(fit).observe(box);
}

// ---- 落点 -------------------------------------------------------------------------

/**
 * 落点那一段。⛔ **不显示 content URI 原文**(用户读不懂),显示 provider 回读的名字;
 * ⛔ 也**不显示 core 的 `status().dir`** —— 在这一端那是中转区,不是用户的落点
 *(Rust 的 DTO 里干脆没有那一格,§17.3)。
 */
function dirBlock(tree: saf.SafTree): HTMLElement {
  const wrap = document.createElement("div");
  const row = el("div", "row", "");

  if (!tree.configured) {
    wrap.appendChild(el("p", "fine", t("backup.dirNone")));
    row.appendChild(button(t("backup.dirPick"), false, (b) => void pick(b, wrap)));
  } else {
    wrap.appendChild(el("p", "fine", t("backup.dirAt", { name: tree.name ?? "?" })));
    if (!tree.writable) wrap.appendChild(el("p", "fine warn-ink", t("backup.dirGone")));
    row.appendChild(button(t("backup.dirChange"), true, (b) => void pick(b, wrap)));
  }
  wrap.prepend(el("h3", "bkup-h", t("backup.dirName")));
  wrap.append(row, el("p", "fine", t("backup.dirAdvice")));
  return wrap;
}

async function pick(b: HTMLButtonElement, wrap: HTMLElement): Promise<void> {
  b.disabled = true;
  const r = await saf.pickTree();
  b.disabled = false;
  // ⛔ 用户取消不当错误弹(§17.10 第 1 行):什么都不改。
  if (!r.ok && r.cancelled) {
    wrap.appendChild(el("p", "fine", t("backup.dirCancelled")));
    return;
  }
  if (!r.ok) {
    wrap.appendChild(el("p", "fine warn-ink", r.error ?? ""));
    return;
  }
  void refresh();
}

// ---- 立即备份(两步:core 做密文 → 桥搬进 SAF)-------------------------------------

function runBlock(): HTMLElement {
  const wrap = document.createElement("div");
  const out = el("div", "bkup-out", "");
  const row = el("div", "row", "");
  row.appendChild(button(t("backup.run"), false, (b) => {
    b.disabled = true;
    out.replaceChildren(el("p", "fine", t("backup.running")));
    void invoke<Report>("backup_run")
      .then((r) => runMoves(out, r))
      .catch((e) => out.replaceChildren(el("p", "fine warn-ink", errText(e))))
      .finally(() => {
        b.disabled = false;
      });
  }));
  wrap.append(el("h3", "bkup-h", t("backup.runName")), row, out);
  return wrap;
}

/** ⭐ 把这一趟摊开:做成几份、每份有没有真到用户的文件夹、失败各为什么。 */
async function runMoves(out: HTMLElement, r: Report): Promise<void> {
  // 161 / W4 A15(WM-09):做好的那几份按**空间的名字**说(主空间 =「默认空间」),⛔ 不再把长文件名在这儿念一遍 ——
  // 它就在下面「文件夹里的备份」那一行。名单取不到就照实写空间编号(⛔ 不为了一行字挡住后面搬进文件夹那一步)。
  const spaces = await listSpaces().catch(() => null);
  const spaceName = (id: string): string => {
    if (spaces === null) return id;
    return spaceLabel(spaces.find((x) => x.id === id) ?? { id, name: null });
  };
  out.replaceChildren();
  out.appendChild(
    el(
      "p",
      r.made.length > 0 ? "fine" : "fine warn-ink",
      r.made.length > 0 ? t("backup.made", { n: r.made.length }) : t("backup.madeNone"),
    ),
  );
  // 失败那半先摊开(⛔ 「跑了但失败」与「整批停下」显著区分)。
  for (const f of r.failed) {
    out.appendChild(el("div", "bkup-file warn-ink", `${f.space_id} —— ${f.message}`));
    if (f.leftover_kind === "unverified") out.appendChild(el("div", "bkup-file", t("backup.leftoverUnverified")));
    else if (f.leftover_kind === "invalid") out.appendChild(el("div", "bkup-file", t("backup.leftoverInvalid")));
  }
  if (r.failed.length > 0) out.appendChild(el("p", "fine warn-ink", t("backup.reportFailed", { n: r.failed.length })));
  if (r.fatal) out.appendChild(el("p", "fine warn-ink", t("backup.reportFatal") + r.fatal));
  if (r.skipped > 0) out.appendChild(el("p", "fine warn-ink", t("backup.reportSkipped", { n: r.skipped })));
  // 明文删不掉那一支:就地补一枚「重试清理」(⛔ 别重画整节,那会把刚摊开的报告冲掉)。
  if (r.blocked) out.appendChild(blockedBlock(r.blocked));

  // 第二步:逐份搬进用户的文件夹。⛔ 与「做好了」分开说。
  for (const m of r.made) {
    const line = el("div", "bkup-file", `${spaceName(m.space_id)} · ${size(m.bytes)}`);
    const state = el("div", "bkup-file", t("backup.moving"));
    out.append(line, state);
    await moveOne(state, m.file_name);
  }
  if (r.made.length > 0) void reloadList();
}

async function moveOne(state: HTMLElement, name: string): Promise<void> {
  const done = await saf.putFile(name);
  if (done.ok) {
    state.className = "bkup-file";
    state.textContent = t("backup.movedOk");
    return;
  }
  if ("unknown" in done) {
    // ⭐ 终态「不知道」:⛔ 绝不兑现成成功或失败,叫用户去看事实。
    state.className = "bkup-file warn-ink";
    state.textContent = t("backup.moveUnknown");
    return;
  }
  state.className = "bkup-file warn-ink";
  state.textContent = t("backup.movedFail", { why: done.error });
  if (done.canRetry) {
    // ⭐ 重试 = **同一个 docId 覆盖写、新的 transferId**(壳侧定,前端只是再按一次)。
    const retry = button(t("backup.moveRetry"), true, (b) => {
      b.disabled = true;
      state.textContent = t("backup.moving");
      void moveOne(state, name);
    });
    state.appendChild(retry);
  }
}

// ---- 列表与验证 --------------------------------------------------------------------

/**
 * ⛔ **每一行的默认状态是「还没验过」,不是「有效」**(§3.3 那条义务在这一端的落点):
 * 文件名 / 扩展名 / 它在不在列表里,都不是「这是一份有效备份」的判据 —— 唯一的判据是
 * 点「验证」**整个解一遍**(与恢复同一条路)。
 *
 * ⛔ **默认视图可以只列像备份的,但界面永远不许让用户以为"这就是全部"**:底下那行
 * 「还有 N 个其他文件」是**恒显**的(codex 二弹 M 的反例:被 provider 改过名的那份,
 * 在产出账消失之后既不在扩展名那一支、也不在账那一支)。
 */
/** `keep` = 上一次画好的那几行(见 render 头上),新名单到之前先摆着;没有就照旧先说「读取中…」。 */
function listBlock(keep: Node[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.id = "backup-list";
  const head = el("div", "row", "");
  head.appendChild(button(t("backup.listReload"), true, () => void reloadList()));
  const out = el("div", "bkup-out", "");
  out.append(...keep);
  wrap.append(el("h3", "bkup-h", t("backup.listName")), head, out);
  void reloadList(wrap, keep.length > 0);
  return wrap;
}

/** `quiet` = 屏上已经摆着上一次的名单,别先塌成「读取中…」(只给 render 那一路;点「刷新」/「全部列出」照旧先说一声)。 */
async function reloadList(scope?: HTMLElement, quiet = false): Promise<void> {
  const wrap = scope ?? document.getElementById("backup-list");
  const out = wrap?.querySelector(".bkup-out");
  if (!out) return;
  if (!quiet) out.replaceChildren(el("p", "fine", t("backup.loading")));
  let list: saf.SafList;
  let spaces: SpaceInfo[];
  try {
    [list, spaces] = await Promise.all([saf.listTree(listAll), listSpaces()]);
  } catch (e) {
    out.replaceChildren(el("p", "fine warn-ink", errText(e)));
    return;
  }
  out.replaceChildren();
  if (list.error) {
    out.appendChild(el("p", "fine warn-ink", list.error));
    return;
  }
  // ⛔ **空态也要认 `scanTruncated`**(实现审弹 2 二复核的 M):「这个文件夹里还没有备份」
  // 是一句**关于整个文件夹**的确定断言 —— 而这次可能只看了前 2000 个文件,第 2001 个恰好是
  // 备份。⭐ 后面再补一句「不一定是全部」**撤销不了**前面那句确定的话。
  if (list.items.length === 0) {
    out.appendChild(
      list.scanTruncated
        ? el("p", "fine warn-ink", t("backup.listEmptyScanned", { n: list.scanned }))
        : el("p", "fine", t("backup.listEmpty")),
    );
  }
  for (const it of list.items) out.appendChild(listRow(it, spaces));
  // ⛔ 别静默截断(那会读成「你只有这些备份」)。⚠ **两种截断要分开说**:
  // ①候选超过 200 ⇒ 「只显示最近 200 个」(那句话现在有排序保证了);
  // ②**这个文件夹太大、这次只看了前 N 个条目** ⇒ 那时连「最近」都不敢担保。
  // ⛔⛔ **两种截断不是互斥的,要各说各的**(实现审弹 2 三复核的 M):
  // 前 2000 项全是候选、而目录还不止 2000 项时,两者**必然同时为真** —— 只报前一句的话,
  // 用户会把下面那 200 行读成「这次检查到的全部候选」,而实际上已检查范围里可能还有 1800 个没显示。
  if (list.scanTruncated) {
    out.appendChild(el("p", "fine warn-ink", t("backup.listScanTruncated", { n: list.scanned })));
  }
  if (list.truncated) {
    out.appendChild(
      el(
        "p",
        "fine",
        list.scanTruncated ? t("backup.listTruncatedScanned", { n: 200 }) : t("backup.listTruncated", { n: 200 }),
      ),
    );
  }
  const others = el("p", "fine bkup-others", "");
  // ⛔ 截断时那个 N **只是已检查前缀里的数**,不是整个文件夹的数;而「全部列出」在那时
  // 也做不到(点开仍然只扫 2000 行)⇒ 两种口径分开说,⛔ 别让精确的说法冒充全量。
  others.textContent = listAll
    ? t("backup.othersBack")
    : list.scanTruncated
      ? list.otherSaturated
        ? t("backup.othersLeadManyScanned", { scanned: list.scanned })
        : t("backup.othersLeadScanned", { scanned: list.scanned, n: list.otherCount })
      : list.otherSaturated
        ? t("backup.othersLeadMany")
        : t("backup.othersLead", { n: list.otherCount });
  others.addEventListener("click", () => {
    listAll = !listAll;
    void reloadList();
  });
  // 161 / W4 A32(WM-24):文件夹里**一个别的文件都没有**(而且这次是整个看完的)⇒ 「全部列出」列出来的就是上面这几行,
  // 那句「还有 0 个其他文件…点这里全部列出」只是噪音。⚠ 恒显那条义务(上面头注)防的是「被改过名的备份藏在其他文件里」
  // —— 其他文件是 0 个时没有地方可藏,义务不受影响;只看了一部分(scanTruncated)或数饱和了的照旧显。
  const nothingElse = !listAll && !list.scanTruncated && !list.otherSaturated && list.otherCount === 0;
  if (!nothingElse) out.appendChild(others);
}

/**
 * 一份备份一行(161 / W4 A15,WM-09):先说**哪个空间、几点备的**(本地时间),文件名退到下面一行小字 ——
 * 文件名里的时刻是 UTC(core `file_name_for` 刻意的:进程里取本地偏移会失败,而一个可能错 8 小时的本地时间更坏),
 * 凌晨备的连日期都早一天,当主标题读就像日期错了。⛔ 文件名一个字不动(列表与轮转按名认),这里只**读**它。
 * 认不出的名字(被 provider 改过名,或不是 core 起的)⇒ 照旧整名当标题、旁边写文件改动时刻,不编一个空间出来。
 */
function listRow(it: saf.SafItem, spaces: SpaceInfo[]): HTMLElement {
  // 906(用户拍「设置页太复杂了」):一条只写「空间名 · 时间」+ 下面一行小字「大小 · 验没验过」,右边一枚「验证」;
  // 那串长文件名收起来 —— 点这一条的字才露(再点收回),`title` 里也有。⛔ 文件名一个字不动,只是平时不念。
  const row = el("div", "bkup-item", "");
  const main = el("div", "bkup-item-main", "");
  const sub = el("div", "bkup-item-sub", "");
  const label = nameLabel(it.name, spaces);
  let file: HTMLElement | null = null;
  if (label !== null) {
    main.append(el("span", "bkup-item-name", label));
    sub.append(el("span", "bkup-item-meta", size(it.bytes)));
    file = el("span", "bkup-item-file", it.name);
    file.hidden = true;
    row.title = it.name;
    main.setAttribute("role", "button");
    main.setAttribute("aria-expanded", "false");
    main.addEventListener("click", () => {
      file!.hidden = !file!.hidden;
      main.setAttribute("aria-expanded", String(!file!.hidden));
    });
  } else {
    main.append(el("span", "bkup-item-name", it.name));
    sub.append(el("span", "bkup-item-meta", `${size(it.bytes)}${it.ms ? " · " + when(it.ms) : ""}`));
  }
  main.append(sub);
  row.append(main);
  // ⭐ 默认就是这句「还没验过」,不是空白也不是「有效」。这次开着 app 时验过的,贴回当时的结论(A31)。
  const state = el("span", "bkup-item-state", t("backup.listUnverified"));
  const seen = verdicts.get(verdictKey(it));
  if (seen) {
    state.textContent = seen.text;
    state.classList.toggle("warn-ink", seen.warn);
  }
  const verify = button(t("backup.listVerify"), true, (b) => {
    b.disabled = true;
    state.className = "bkup-item-state";
    state.textContent = t("backup.listVerifying");
    void verifyOne(it, state).finally(() => {
      b.disabled = false;
    });
  });
  sub.append(state);
  row.append(verify);
  if (file) row.append(file);
  return row;
}

/** core 起的名字:`zhujian-<空间编号前 8>-<UTC 年月日T时分秒Z>-<26 位 ULID>.zjbak`(`core/src/backup/engine.rs::file_name_for`)。 */
const CORE_NAME = /^zhujian-([^-]+)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9A-Z]{26}\.zjbak$/;

/** 「默认空间 · 2026-11-06 05:02」(本地时间);空间认不出(不在这台上 / 前 8 位撞了不止一个)就只说时刻。认不出名字 = null。 */
function nameLabel(name: string, spaces: SpaceInfo[]): string | null {
  const m = CORE_NAME.exec(name);
  if (!m) return null;
  const [, short, y, mo, d, h, mi, s] = m;
  const at = when(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  const hits = spaces.filter((x) => x.id.slice(0, 8) === short);
  return hits.length === 1 ? `${spaceLabel(hits[0])} · ${at}` : at;
}

/**
 * 验一份:桥把它**回拷**进 outbox(尺 4 的名字由壳自己造)→ core 整个解一遍。
 *
 * ⚠ 「无论成败都删掉那份回拷」由 **Rust 那条命令**在 `finally` 位置做 —— 它与消费者同一处,
 * 于是桥上不必再开第六个入口(也就没有「删任意 outbox 文件」这个能力面)。
 */
async function verifyOne(it: saf.SafItem, state: HTMLElement): Promise<void> {
  const settle = (text: string, warn: boolean): void => {
    state.className = warn ? "bkup-item-state warn-ink" : "bkup-item-state";
    state.textContent = text;
    verdicts.set(verdictKey(it), { text, warn });
  };
  const got = await saf.fetchFile(it.docId);
  if (!got.ok) {
    // ⛔ 验证的 unknown **不能复用搬运那句**(实现审弹 2 L-1):那句让人「去文件夹里看看
    // 有没有它」—— 可这条路上文件本来就在文件夹里,不确定的是**这次验证做完没有**。
    if ("unknown" in got) {
      verdicts.delete(verdictKey(it)); // 「不确定」不记(见 verdicts 头注),之前记过的那句也作废
      state.className = "bkup-item-state warn-ink";
      state.textContent = t("backup.verifyUnknown");
      return;
    }
    settle(got.error, true);
    return;
  }
  try {
    const v = await invoke<Verified>("backup_verify", { name: got.localName });
    // 说的是「**现在**打得开」——⛔ 不许追认「当初那趟备份成功了」。
    // 161 / W4 A15(WM-09):空间按屏上别处的叫法说(主空间 =「默认空间」),⛔ 不再露内部编号「main」。
    settle(t("backup.listOk", { space: spaceLabel({ id: v.space_id, name: v.space_name }), size: size(v.plain_bytes) }), false);
    // ⛔ 「验完就删」这条义务没兑现的话要说出来 —— 它不是失败(验证结论照旧成立),
    // 但静默就等于假装做到了(实现审一弹 M-4)。
    if (v.cleanup_error) state.closest(".bkup-item")?.appendChild(el("div", "bkup-file warn-ink", v.cleanup_error));
  } catch (e) {
    // ⛔ 原样摊开后端那句:「不是这个备份码对应的」与「结构不对」是两回事,
    // 糊成一句会让用户把一份其实没坏的备份删掉。
    settle(errText(e), true);
  }
}

// ---- 封锁 -------------------------------------------------------------------------

function blockedBlock(reason: string): HTMLElement {
  const wrap = document.createElement("div");
  const row = el("div", "row", "");
  row.appendChild(button(t("backup.retryCleanup"), false, (b) => {
    b.disabled = true;
    b.textContent = t("backup.cleaning");
    void invoke<Status>("backup_retry_cleanup")
      .then((next) => {
        render($("backup-body"), next, "");
        if (!next.blocked) $("backup-body").appendChild(el("p", "fine", t("backup.cleanOk")));
      })
      .catch((e) => {
        b.disabled = false;
        b.textContent = t("backup.retryCleanup");
        wrap.appendChild(el("p", "fine warn-ink", errText(e)));
      });
  }));
  wrap.append(el("p", "fine warn-ink", t("backup.blockedLead") + reason), row);
  return wrap;
}

// ---- 小工具 -----------------------------------------------------------------------

function el(tag: string, cls: string, text: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}

function button(
  label: string,
  ghost: boolean,
  onClick: (b: HTMLButtonElement) => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  if (ghost) b.className = "ghost";
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 文件改动时刻,本地时区到分钟。⛔ 取不到时刻(0)就不显,不编一个。 */
function when(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
