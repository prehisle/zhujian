// 设置面里的「备份」一节(412,backup-plan 笔①-a 的 UI 面)。
//
// ⛔ **这一层不做任何策略**:同一时刻只许一趟、封锁态、仪式有没有走完,全由 core 的
// `BackupCoordinator` 裁决(门开在壳/前端就等于没门——笔①-b 的自动备份不走命令层)。
// 前端只做三件事:①把当前态画出来;②把用户的动作递给命令;③**把失败原样摊开**。
//
// ⭐ 三条别改坏的:
// 1. **仪式是回输核对,不是勾选**(§5)。⛔ 不许加「我已抄下」复选框——勾选证明不了
//    抄了、抄全了、抄对了;而 Crockford 解析只查字符与长度,大部分单字符误抄仍是一把
//    合法的钥,只是解不开任何东西。比对在 core(与将来真恢复同一支编解码)。
// 2. ⛔ **不提供「复制备份码」按钮**(§3.4.1 第 11 格):一写剪贴板,剪贴板就成了新的
//    所有者,而系统剪贴板我们清不干净。要抄就手抄。
// 3. **失败要摊开**:成功几个、失败几个、每个为什么;有 fatal 时「剩下的根本没跑」
//    与「跑了但失败」必须显著区分(§6.3)。⛔ 别把它们收成一句「备份失败」。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import { copyButton } from "./clipboard";
import { errText } from "./err";
import { listSpaces, spaceLabel } from "./space";

/** 设置面板递进来的那一条出路:恢复回执上的「去看看」(W4 A16)—— 收掉设置、切到那个空间。 */
export type BackupNav = { gotoSpace(id: string, label: string): void };

type BackupStatus = {
  configured: boolean;
  dir: string;
  blocked: string | null;
  busy: "backup" | "cleanup" | "restore" | null;
  awaiting_ceremony: boolean;
  problem: string | null;
};

type AutoStatus = {
  enabled: boolean;
  every_minutes: number;
  keep: number;
  /** UTC RFC3339 —— 本地时间在这一层用 `Date` 转(后端取不到本地偏移)。 */
  last_success_at: string | null;
  last_result: string | null;
  problem: string | null;
  /** ⭐ 拉一次取走一次(设计审 H5):结论连盘都写不进去时,它是唯一还能到达用户的路。 */
  pending_notice: string | null;
  /** **已交还给你处置**的产物(⛔ 与上面那枚相反:读了不清)。 */
  released: { path: string; why: string }[];
  /** 上一趟删不掉、下轮再试的那几份。 */
  retry: { path: string; why: string }[];
};

type Made = { space_id: string; path: string; bytes: number };
type Failed = {
  space_id: string;
  message: string;
  leftover_kind: "unverified" | "invalid" | null;
  leftover_path: string | null;
};
/** 备份目录里的一份候选。⛔ **刻意没有「有效」这一格** —— core 那边的类型也没有,见 §3.3。 */
type Entry = { path: string; file_name: string; bytes: number; modified_ms: number | null };
/** 验过之后才有的那几格,全部来自 trailer。 */
type Verified = {
  space_id: string;
  space_name: string | null;
  created_at: string;
  app_version: string;
  plain_bytes: number;
};
/** 把一份备份的完整路径填进「从备份恢复」那张表(列表行 → 恢复节)。 */
type Prefill = (path: string) => void;

/** 一趟恢复的产出(lib.rs::RestoredSpaceDto 镜像)。⭐ **它是「一个未配置的新空间」**,
 *  ⛔ 不是"你的库回来了、原样在原处" —— 话术照 backup-plan §16.11 的六条诚实边界。 */
type Restored = {
  space_id: string;
  path: string;
  source_space_name: string | null;
  /** UTC RFC3339,本地时间在这一层用 `Date` 转。 */
  created_at: string;
  /** 已进空间表 = 现在就能切过去;false = 库在盘上但这趟没接进来(⛔ 不是失败)。 */
  integrated: boolean;
  warnings: string[];
};
type Report = {
  made: Made[];
  failed: Failed[];
  skipped: number;
  fatal: string | null;
  blocked: string | null;
};

/** 仪式进行中(码已显示、还没核对)。关面板时据此通知后端把那把钥丢掉。 */
let ceremonyOpen = false;

/**
 * 「说明 ▸」折叠(2026-08-31 用户拍板「收纳不删」):长段说明默认收起、点开全文。
 * ⛔ **收纳不是删**:backup-plan §9 那几段诚实边界一字不动地住在里面 —— 这只构件动的
 * 只是「默认显不显」,别拿它当「这段可以砍」的许可。原生 `<details>`:零状态、面板重建即回到收起。
 */
export function noteFold(...texts: string[]): HTMLDetailsElement {
  const d = document.createElement("details");
  d.className = "settings-notes";
  const s = document.createElement("summary");
  s.textContent = t("settings.notes");
  d.appendChild(s);
  for (const x of texts) d.appendChild(el("p", "settings-sub", x));
  return d;
}

/** 设置面板这一趟打开时递进来的出路(`buildBackupSection` 记下,恢复回执用)。 */
let nav: BackupNav | null = null;
/** 「自动备份真跑了一次」那条事件的退订(W4 A17;关面板时摘,见 `closeBackupSection`)。 */
let liveOff: (() => void) | null = null;

/** pane 顶那只「说明」折叠,等这一趟第一次读到状态时定它默认开不开(898 G4):**还没设置备份**就摊开 ——
 *  没设置过的人正需要读「备份是什么、钥匙归谁管」;设置过的照旧收起。⛔ 只定这一次(读完即清):之后人自己开合说了算,
 *  走完仪式那一发重画也不去动它。坏配置 / 封锁态不摊(那两态页上要读的是那句原话)。 */
let notesAwaitingStatus: HTMLDetailsElement | null = null;

/** 「备份」一节的整块。设置面板每次打开重建一只。
 *  ⚠ §9 那两段常驻边界(footSecrets / footUninstall)不在这儿了 —— 收进 settings.ts
 *  pane 顶的「说明」折叠(与 backup.sub 同一只;`notes` 就是它,见上面那条)。 */
export function buildBackupSection(navigate: BackupNav, notes: HTMLDetailsElement): HTMLElement {
  nav = navigate;
  notesAwaitingStatus = notes;
  const body = el("div", "bkup-body", t("common.loading"));
  void refresh(body);
  return body;
}

/**
 * 关面板 / 切走时调:仪式还开着就让后端丢掉那把**只在内存里**的钥。
 * ⭐ 盘上此刻什么都没写过 ⇒ 下次是干净的首次使用(⛔ 反过来「先落盘再让用户抄」会留下
 * 一把没人抄过的钥)。
 */
/** 设置浮层的 Esc 先问这里(902 E6:Esc 只退一层):备份码那一步开着时,Esc = 它自己那枚「取消」(回到备份页),
 *  返回 true 表示这一下已经用掉、别再关浮层。码框里的 Esc 照旧只清框(框上自己拦了,到不了这里)。 */
let ceremonyCancel: (() => void) | null = null;
export function escapeBackupCeremony(): boolean {
  if (!ceremonyOpen || ceremonyCancel === null) return false;
  ceremonyCancel();
  return true;
}

export function closeBackupSection(): void {
  liveOff?.();
  liveOff = null;
  nav = null;
  notesAwaitingStatus = null;
  if (!ceremonyOpen) return;
  ceremonyOpen = false;
  void invoke("backup_cancel_setup");
}

/** `justSetUp`:刚走完仪式(W4 A4)—— 「立即备份」那一行照实说「码已核对、还没有备份」。 */
async function refresh(body: HTMLElement, justSetUp = false): Promise<void> {
  try {
    render(body, await invoke<BackupStatus>("backup_status"), justSetUp);
  } catch (e) {
    body.replaceChildren(el("p", "hkset-msg err", errText(e)));
  }
}

function render(body: HTMLElement, st: BackupStatus, justSetUp = false): void {
  ceremonyOpen = false;
  body.replaceChildren();
  if (notesAwaitingStatus) {
    notesAwaitingStatus.open = !st.configured && !st.problem && !st.blocked;
    notesAwaitingStatus = null;
  }
  // ⭐ **恢复恒显,且与上面那半的状态无关**(§16.6):换了机器 / 重装系统之后这台
  // 根本没配过备份 —— 而那正是恢复的主场景。⛔ 别把它塞进 configured 分支里。
  // 先建它是为了拿到 prefill:列表行的「恢复这一份」要把路径填进这张表(123)。
  const restore = buildRestoreSection();
  body.append(backupHalf(body, st, restore.prefill, justSetUp), restore.wrap);
}

/** 备份那一半(配置 / 仪式 / 落点 / 立即备份 / 列表 / 自动)。 */
function backupHalf(body: HTMLElement, st: BackupStatus, prefill: Prefill, justSetUp: boolean): HTMLElement {
  const wrap = document.createElement("div");

  // ⛔ 配置坏了 / 上次写盘死在半路:显示原话 + 劝阻「重新设置一次」,**不给任何按钮**
  //(那会换一把新钥,已有备份从此永远打不开)。
  if (st.problem) {
    wrap.append(
      el("p", "hkset-msg err", t("backup.problemLead") + st.problem),
      el("p", "settings-foot", t("backup.problemHint")),
    );
    return wrap;
  }

  // 封锁态:暂存区里还躺着**明文**副本。唯一出路是重试清扫(⛔ 没有「忽略」)。
  if (st.blocked) {
    wrap.appendChild(retryRow(body, st.blocked));
    return wrap;
  }

  if (!st.configured) {
    const row = el("div", "hkset-row", "");
    const err = el("p", "hkset-msg err", "");
    const go = button(t("backup.setUp"), () => {
      go.disabled = true;
      err.textContent = "";
      void invoke<string>("backup_begin_setup", { dir: null })
        .then((code) => renderCeremony(body, code))
        .catch((e) => {
          go.disabled = false;
          err.textContent = errText(e);
        });
    });
    // ⛔ 623 试过摘掉这枚行名(「备份 / 备份」与组标题重复),**看图之后退回来了**:本节
    // 从来不是单行组 —— 它下面永远跟着「从备份恢复」那行,摘了就成「一行有名一行没名」;
    // 而且 `.hkset-desc` 是 order:2 独占一行,没了行名之后「还没设置」会掉到按钮**下面**、
    // 孤零零挂着。⇒ 按 settings.ts buildPane 那条判据(看这一组有几行),多行组照写行名。
    row.append(el("div", "hkset-name", t("backup.title")), el("div", "hkset-desc", t("backup.notSet")), go);
    wrap.append(row, err);
    return wrap;
  }

  // 三块互相通气(W4 A17 / A4):「立即备份」跑完、自动备份真跑了一次 ⇒ 列表当场重读;
  // 列表读出几份 ⇒ 「立即备份」那一行照实说「还没有备份」还是平常那句。
  const run = buildRunRow(body, justSetUp, () => list.reload());
  const list = buildListSection(prefill, (n) => run.setCount(n));
  // 换了「备份到」的文件夹,列表读的就是另一个文件夹了 ⇒ 当场重读(同 A17 那条:状态跟着变)。
  wrap.append(buildDirRow(st, () => list.reload()), run.wrap, list.wrap, buildAutoRow(() => list.reload()));
  return wrap;
}

/**
 * 「从备份恢复」一节(笔②,backup-plan §16)。
 *
 * ⭐ 三条别改坏的(全是 §16 的判据,不是措辞):
 * 1. **它产出的是一个新空间,不是"你的库回来了"** —— 成功那句话必须这么说(§16.11-4/5)。
 *    ⛔ 任何「恢复 = 覆盖回去」的暗示都是在描述另一个产品(v1 明确不做覆盖恢复)。
 * 2. **前置提示必须在按钮之前**:不能取消 / 没有进度 / 临时要 ≈3 倍库大小的盘(§16.9),
 *    ⛔ 别为了版面把它们挪到结果里 —— 那时用户已经等在那儿了。
 *    排法(902 F7,用户拍板):表单分三步 —— ① 备份文件 ② 备份码 ③ 开始前要知道。第 ③ 步里「不能取消 / 没进度 / 3 倍盘」
 *    (红字)与「绝不覆盖、新建一个空间」两句**常显**;「恢复出来的空间不同步…」「是备份那一刻的数据…」两句收进
 *    折叠「恢复之后会怎样」—— 四句仍都在「开始恢复」之前、一句没删,折叠的只是恢复**之后**才用得上的那两句。
 * 3. **失败与「库已经在盘上、只是没装配上」是两回事**(§16.8 幕⑦):后者⛔ 绝不许
 *    显示成「恢复失败」,那会诱导用户再恢复一次、于是多出第二个空间。
 */
function buildRestoreSection(): { wrap: HTMLElement; prefill: Prefill } {
  const wrap = document.createElement("div");
  const row = el("div", "hkset-row", "");
  // ⚠ `bkup-restore` 只是**给 e2e 一个准头**(这一节里有两个 `.bkup-out`),没有样式。
  const form = el("div", "bkup-out bkup-restore", "");
  let fields: RestoreFields | null = null;
  const toggle = button(t("backup.restoreOpen"), () => {
    const open = fields !== null;
    form.replaceChildren();
    fields = null;
    toggle.textContent = open ? t("backup.restoreOpen") : t("backup.restoreClose");
    if (!open) {
      fields = renderRestoreForm(form);
      fields.file.focus();
    }
  });
  // 列表行「恢复这一份」(123):表没开就开,路径填进去,光标落到备份码那格 —— 只是替用户
  // 抄路径,⛔ 不替他按「恢复」(第 ③ 步「开始前要知道」得先让他读到,见本节头注第 2 条)。
  const prefill: Prefill = (path) => {
    if (fields === null) toggle.click();
    if (fields === null) throw new Error("restore form did not open");
    fields.file.value = path;
    fields.code.focus();
    form.scrollIntoView({ block: "nearest" });
  };
  row.append(
    el("div", "hkset-name", t("backup.restoreName")),
    el("div", "hkset-desc", t("backup.restoreDesc")),
    toggle,
  );
  wrap.append(row, form);
  return { wrap, prefill };
}

type RestoreFields = { file: HTMLInputElement; code: HTMLInputElement };

function renderRestoreForm(form: HTMLElement): RestoreFields {
  const file = document.createElement("input");
  file.type = "text";
  file.id = "bkup-restore-file"; // 给第 ① 步那枚 <label for> 认(表单同一时刻至多一张)
  file.className = "alias-input bkup-input";
  file.placeholder = t("backup.restoreFilePh");
  const code = document.createElement("input");
  code.type = "text";
  code.id = "bkup-restore-code";
  // 与设置时抄回码那只框同形(等宽、宽到放得下整串码,W4 A18)。
  code.className = "alias-input bkup-input bkup-code-input";
  code.placeholder = t("backup.restoreCodePh");
  code.spellcheck = false;
  const out = el("div", "bkup-out", "");
  // 161 / W4 Q11(WD-20,D2 留下的后半):「选文件…」—— U 盘、手机上拿来的那份不用再手抄完整路径。壳里弹系统的打开文件框、
  // 只列 .zjbak(`backup_pick_file`,异步、不卡主线程);选中就把完整路径填进框、光标落到备份码那格;取消 = 什么都不变。
  const pick = button(t("backup.restorePick"), () => {
    pick.disabled = true;
    void invoke<string | null>("backup_pick_file", { title: t("backup.pickTitle"), filterName: t("backup.pickFilter") })
      .then((path) => {
        if (path === null) return;
        file.value = path;
        code.focus();
      })
      .catch((e) => out.replaceChildren(el("p", "hkset-msg err", errText(e))))
      .finally(() => {
        pick.disabled = false;
      });
  });
  const fileRow = el("div", "alias-ctrls bkup-file-row", "");
  fileRow.append(file, pick);

  const go = button(t("backup.restoreGo"), () => {
    // 两格都要有:⛔ 空值递到后端只会换来一句更含糊的话。
    if (!file.value.trim()) {
      out.replaceChildren(el("p", "hkset-msg err", t("backup.restoreNeedFile")));
      return;
    }
    if (!code.value.trim()) {
      out.replaceChildren(el("p", "hkset-msg err", t("backup.restoreNeedCode")));
      return;
    }
    go.disabled = true;
    out.replaceChildren(el("p", "hkset-msg", t("backup.restoreRunning")));
    void invoke<Restored>("backup_restore", { file: file.value, code: code.value })
      .then((r) => renderRestored(out, r))
      // ⛔ 原样摊开后端那句:「这份备份不是这个备份码的」/「还有 N 张图没下载完」/
      // 「来自更新版本」各是一条能照做的路,糊成一句「恢复失败」等于什么都没说。
      // ⭐ W4 A18:码长得不像备份码时,原话下面**另起一行**指到哪一组(与设置时抄错那句同一个说法)。
      // ⛔ 不替换原话:后端在解码之前还有别的拒(封锁 / 落点),框里的码坏不坏说明不了它这次拒的是什么;
      // ⛔ 也不认后端的中文原话去分支(那是诊断串,不是接口)。判据只看框里的码。
      .catch((e) => {
        out.replaceChildren(el("p", "hkset-msg err", errText(e)));
        const shape = codeShapeProblem(code.value);
        if (shape) out.appendChild(el("p", "hkset-msg err bkup-code-hint", shape));
      })
      .finally(() => {
        go.disabled = false;
      });
  });

  const acts = el("div", "bkup-acts", "");
  acts.appendChild(go);
  // 步名:序号 + 名字。①② 是真 <label for>(读屏念得出这只框是什么;此前两只框只有灰字占位),③ 不对着框、是小标题。
  const step = (n: string, name: string, forId: string | null): HTMLElement => {
    const h = document.createElement(forId === null ? "p" : "label");
    h.className = "bkup-step";
    if (forId !== null) (h as HTMLLabelElement).htmlFor = forId;
    h.textContent = `${n} ${name}`;
    return h;
  };
  // 「恢复之后会怎样」折叠(同「说明」那只 noteFold 的形:原生 <details>、零状态,表单重开即回到收起)。
  const after = document.createElement("details");
  after.className = "settings-notes bkup-after";
  const afterSum = document.createElement("summary");
  afterSum.textContent = t("backup.restoreAfter");
  after.append(afterSum, el("p", "settings-sub", t("backup.restoreLead2")), el("p", "settings-sub", t("backup.restoreLead3")));
  form.append(
    // ① 路径从哪来(W4 Q11 / WD-20):列表里那几份点一下就填好;别处拿来的点「选文件…」或手填。
    step("①", t("backup.restoreStepFile"), file.id),
    fileRow,
    el("p", "settings-sub", t("backup.restoreFileHint")),
    step("②", t("backup.restoreCodePh"), code.id),
    code,
    el("p", "settings-sub", t("backup.restoreCodeHint", { perDevice: t("backup.perDeviceCode") })),
    // ③ ⭐ 四条前置提示都在按钮之前(§16.2 / §16.11 / §16.9),⛔ 一条都别删;哪两句常显、哪两句进折叠见本节头注第 2 条。
    step("③", t("backup.restoreStepBefore"), null),
    el("p", "hkset-msg err", t("backup.restoreLead4")),
    el("p", "settings-sub", t("backup.restoreLead1")),
    after,
    acts,
    out,
  );
  return { file, code };
}

function renderRestored(out: HTMLElement, r: Restored): void {
  out.replaceChildren();
  // 装配失败的指路 / 暂存名没清掉,后端原话逐条摊开。
  const warnings = (): void => {
    for (const w of r.warnings) out.appendChild(el("div", "bkup-file", w));
  };
  if (!r.integrated) {
    // ⛔ 这不是失败:库已经落在盘上了(提交点在幕⑥,壳不许把它撤销)。
    out.appendChild(el("p", "hkset-msg err", t("backup.restoreOnDisk")));
    warnings();
    return;
  }
  // W4 A16(WD-09):此前回执写「已恢复成一个新空间:这个空间」—— 不说它在这台叫什么,空间菜单里
  // 多出来的「未命名空间 · NEG6」认不出是刚恢复的。⇒ 名字照这台空间表现读(自动起的就照实写),
  // 旁边一枚「去看看」直接切过去。⛔ 不从备份里读原名去改它(那是恢复路径的事,不是界面)。
  const takenAt = new Date(r.created_at).getTime();
  void listSpaces()
    .then((all) => {
      const s = all.find((x) => x.id === r.space_id);
      // 装配进来了却不在空间表里 = 不变量破了;照实写编号,不编一个名字。
      const label = s ? spaceLabel(s) : r.space_id;
      const line = el("p", "hkset-msg ok bkup-restored", t("backup.restoreDoneNamed", { name: label, when: when(takenAt) }));
      out.appendChild(line);
      if (r.source_space_name && r.source_space_name !== label) {
        out.appendChild(el("p", "hkset-msg", t("backup.restoreDoneWas", { name: r.source_space_name })));
      }
      const go = button(t("backup.restoreGoSee"), () => {
        if (!nav) throw new Error("备份那一节没接设置面板的出路(buildBackupSection 漏传 nav?)");
        nav.gotoSpace(r.space_id, label);
      });
      const acts = el("div", "bkup-acts", "");
      acts.appendChild(go);
      out.appendChild(acts);
      warnings();
    })
    .catch((e) => {
      // 恢复本身已经成了:读空间表失败只说读不到名字,⛔ 不许读成「恢复失败」。
      out.append(el("p", "hkset-msg ok", t("backup.restoreDoneNoName", { when: when(takenAt) })), el("p", "hkset-msg err", errText(e)));
      warnings();
    });
}

// ---- 备份码的形状(W4 A18)----
// ⚠ 镜像 core `sync::crypto` 的 Crockford 那一支(显示 = 13 组 × 4 位,共 52 位;回输容错:不分大小写、
// 跳过 `-` 与空格、O 读作 0、I / L 读作 1)。**只用来挑一句说清错在哪的话**,⛔ 不当判据:
// 码对不对永远是 core 说了算(设置时是 `backup_confirm_setup`,恢复时是 `backup_restore`),
// 这里只在它已经拒了之后才被问。⛔ 码格式一个字不改(清单备注:不加校验位)。
const CODE_GROUP = 4;
const CODE_GROUPS = 13;
const CODE_ALPHABET = /^[0-9A-HJKMNP-TV-Z]$/;

/** 一个字照 core 的容错读成码里那个字;读不成 = null。 */
function codeChar(raw: string): string | null {
  const c = raw.toUpperCase().replace("O", "0").replace(/[IL]/, "1");
  return CODE_ALPHABET.test(c) ? c : null;
}

/** 框里那串码的有效字(去掉分隔,按 core 的容错规整);认不出的字原样留着。 */
function codeChars(raw: string): string[] {
  return [...raw].filter((ch) => ch !== "-" && !/\s/.test(ch)).map((ch) => codeChar(ch) ?? ch);
}

/** 码长得不像备份码:哪一组里有不会出现的字 / 哪一组位数不对 / 总位数不对。像就回 null。 */
function codeShapeProblem(raw: string): string | null {
  const chars = [...raw].filter((ch) => ch !== "-" && !/\s/.test(ch));
  const bad = chars.findIndex((ch) => codeChar(ch) === null);
  if (bad >= 0) return t("backup.codeBadChar", { n: Math.floor(bad / CODE_GROUP) + 1, ch: chars[bad] });
  if (chars.length === CODE_GROUP * CODE_GROUPS) return null;
  // 人照着分组抄的(带 `-` 或空格):指出位数不对的那一组;一整串没分组的只能报总数。
  const groups = raw.trim().split(/[\s-]+/).filter(Boolean);
  const short = groups.length > 1 ? groups.findIndex((g) => g.length !== CODE_GROUP) : -1;
  if (short >= 0) return t("backup.codeGroupLen", { n: short + 1, len: groups[short].length, per: CODE_GROUP });
  return t("backup.codeLen", { len: chars.length, groups: CODE_GROUPS, total: CODE_GROUP * CODE_GROUPS });
}

/** 设置时抄回的码对不上:码就在手上,逐组比出第一处不一样的那组。比不出来(规整口径漂了)回 null。 */
function codeGroupDiff(shown: string, typed: string): string | null {
  const want = codeChars(shown);
  const got = codeChars(typed);
  const at = want.findIndex((c, i) => got[i] !== c);
  if (at < 0) return null; // 抄的比显示的多:形状那一句(总位数)已经说过了
  const g = Math.floor(at / CODE_GROUP);
  const slice = (xs: string[]) => xs.slice(g * CODE_GROUP, (g + 1) * CODE_GROUP).join("");
  return t("backup.codeGroupDiff", { n: g + 1, want: slice(want), got: slice(got) || "—" });
}

/**
 * 备份列表(§3.3 收口那条义务的产品落点)。
 *
 * ⛔ **每一行的默认状态是「还没验过」,不是「有效」** —— 那条义务原话:
 * 「**文件名 / 扩展名绝不能当『这是一份有效备份』的判据**」。413 真 SIGKILL 造出来的两份
 * 半截产物与成功产物**同目录、同名族、同扩展名**,其中一份还完全解得开 —— 名字什么都证明不了。
 * 唯一的判据是点「验证」真解一遍(与恢复同一条路)。
 *
 * ⛔ **没有删除按钮**:清理属于笔①-b 的轮转(账里那句「别把它单独做成第三个功能」)。
 * 要删走上面那个「打开所在文件夹」自己删。
 */
function buildListSection(
  prefill: Prefill,
  onCount: (n: number) => void,
): { wrap: HTMLElement; reload: () => void } {
  const wrap = document.createElement("div");
  const head = el("div", "hkset-row", "");
  // ⭐ 2026-08-31 用户拍板「整节默认折叠」:头行只剩 名字 + 一行汇总 + 「展开」,
  // 列表(与它的说明句、「刷新」)全住进折叠区。⛔ **列表照旧开面板就加载**(汇总要数),
  // 折叠只是 `hidden` —— DOM 恒建,e2e 与「点开就在」都靠这一点。
  // ⛔ 默认态**恒为收起、刻意不记住**(每次打开都收,这正是这刀的目的)。
  // ⚠ `bkup-list-sum` 只是给 e2e 与 loadList 一个准头(`.hkset-desc` 在这节里不唯一),没有样式。
  const summary = el("div", "hkset-desc bkup-list-sum", "");
  const zone = el("div", "bkup-out bkup-list", "");
  zone.hidden = true;
  const toggle = button(t("backup.listShow"), () => {
    zone.hidden = !zone.hidden;
    toggle.textContent = zone.hidden ? t("backup.listShow") : t("backup.listHide");
  });
  head.append(el("div", "hkset-name", t("backup.listName")), summary, toggle);

  const out = el("div", "", "");
  const tools = el("div", "bkup-list-tools", "");
  // 这一趟面板里验过的那几份(W4 A17):列表现在会自己重读(立即备份 / 自动备份跑完),重读不该把
  // 刚验过的又打回「还没验过」。键带上大小与改动时刻 —— 文件换了内容就不认旧结论。
  const verified: VerifyMemo = new Map();
  const load = (): void => void loadList(out, summary, prefill, onCount, verified);
  const reload = button(t("backup.listReload"), load);
  tools.append(el("p", "settings-sub bkup-list-hint", t("backup.listDesc")), reload);
  zone.append(tools, out);

  wrap.append(head, zone);
  load();
  return { wrap, reload: load };
}

async function loadList(
  out: HTMLElement,
  summary: HTMLElement,
  prefill: Prefill,
  onCount: (n: number) => void,
  verified: VerifyMemo,
): Promise<void> {
  // ⚠ 重读时**不先清成「加载中」**:「立即备份」/ 自动备份跑完都会来重读一次(W4 A17),先清会让
  // 展开着的列表闪一下、把下面的东西往上收再推回去(A19)。读到了一次换完。
  if (out.childElementCount === 0) out.replaceChildren(el("p", "hkset-msg", t("common.loading")));
  let list: Entry[];
  try {
    list = await invoke<Entry[]>("backup_list");
  } catch (e) {
    // 折叠着也要看得见出了事:汇总位显后端原话(展开区里同一句)。
    summary.textContent = errText(e);
    out.replaceChildren(el("p", "hkset-msg err", errText(e)));
    return;
  }
  out.replaceChildren();
  onCount(list.length);
  if (list.length === 0) {
    summary.textContent = t("backup.listEmpty");
    out.appendChild(el("p", "hkset-msg", t("backup.listEmpty")));
    return;
  }
  // 汇总 = 盘上事实(份数 + 最新改动时刻)。⛔ 与行里那两格同一条纪律:这不是「有 N 份好备份」。
  const newest = Math.max(0, ...list.map((e) => e.modified_ms ?? 0));
  summary.textContent =
    newest > 0
      ? t("backup.listSummary", { n: list.length, when: when(newest) })
      : t("backup.listSummaryBare", { n: list.length });
  for (const e of list) out.appendChild(listRow(e, prefill, verified));
}

/** 一份备份「这一趟验过的结论」:键 = 路径 + 大小 + 改动时刻(`memoKey`)。 */
type VerifyMemo = Map<string, { cls: string; text: string }>;
const memoKey = (e: Entry): string => `${e.path}|${e.bytes}|${e.modified_ms ?? ""}`;

function listRow(e: Entry, prefill: Prefill, verified: VerifyMemo): HTMLElement {
  const row = el("div", "bkup-item", "");
  // ⭐ 66 字符的文件名默认藏起(2026-08-31 同一刀):平时一行只显 大小·时刻·状态·验证,
  // 点行任意空白处摊开/收回文件名;hover 的 title 也给全名。⛔ `textContent` 恒在 ——
  // e2e 与 §3.3 那条「冒牌货也得在列」的义务都按 DOM 读,藏的只是版面。
  const name = el("span", "bkup-item-name", e.file_name);
  name.hidden = true;
  row.title = e.file_name;
  row.addEventListener("click", (ev) => {
    if (ev.target instanceof Element && ev.target.closest("button")) return;
    name.hidden = !name.hidden;
  });
  // 盘上事实那半:大小 + 改动时刻。⛔ 这两格**不是**「它是不是一份好备份」。
  const facts = el("span", "bkup-item-meta", `${size(e.bytes)}${e.modified_ms ? " · " + when(e.modified_ms) : ""}`);
  // ⭐ 默认就是这句「还没验过」,不是空白也不是「有效」。
  // ⭐ W4 A19:这一格**独占第二行**(.bkup-item-state 的 order / flex-basis,settings.css)——
  // 此前它与三枚钮同排,验完那句一长就把三枚钮挤到下一行、整张列表往下推。
  const state = el("span", "bkup-item-state", t("backup.listUnverified"));
  const memo = verified.get(memoKey(e));
  if (memo) {
    state.className = memo.cls;
    state.textContent = memo.text;
  }
  const settle = (cls: string, text: string): void => {
    state.className = cls;
    state.textContent = text;
    verified.set(memoKey(e), { cls, text });
  };

  const verify = button(t("backup.listVerify"), () => {
    verify.disabled = true;
    state.className = "bkup-item-state";
    state.textContent = t("backup.listVerifying");
    void invoke<Verified>("backup_verify", { path: e.path })
      .then((v) => {
        // 说的是「**当前**完整可读」——⛔ 不许追认「当初那趟备份成功了」(§3.3 那张表)。
        // W4 A15(WD-09 后半):空间写**显示名**(此前没起过名的主空间写成内部号「main」,屏上别处都叫
        // 「默认空间」),备份时刻写本地时间(trailer 里是 UTC)。⛔ 文件名一个字不动(列表 / 轮转按名认)。
        settle(
          "bkup-item-state ok",
          t("backup.listOk", {
            space: spaceLabel({ id: v.space_id, name: v.space_name }),
            when: when(new Date(v.created_at).getTime()),
            size: size(v.plain_bytes),
          }),
        );
      })
      // ⛔ 原样摊开后端那句:「不是当前备份码对应的」与「结构不对」是两回事,
      // 糊成一句会让用户把一份其实没坏的备份删掉。
      .catch((err) => settle("bkup-item-state err", errText(err)))
      .finally(() => {
        verify.disabled = false;
      });
  });

  // 123:恢复要的是完整路径,此前只能对着隐藏的文件名手打。⛔ 「恢复这一份」只填表不开跑
  // (prefill 头注);也不因为没验过就藏它 —— 恢复自己会解一遍,判据与「验证」同一条路。
  const restore = button(t("backup.listRestore"), () => prefill(e.path));
  const copy = copyButton(e.path, "hkset-change", t("backup.listCopyPath"));
  const acts = el("span", "bkup-item-acts", "");
  acts.append(verify, restore, copy);
  row.append(name, facts, state, acts);
  return row;
}

/**
 * 「自动备份」一节(笔①-b)。
 *
 * ⭐ 三条别改坏的:
 * 1. **频率与份数从状态里读,⛔ 不许写死**——那个文件可以手改,写死的文案改完就在说谎
 *    (设计审 H4)。
 * 2. ⛔ **别把那句话写成绝对承诺**:轮转与删除之间有一段收窄不掉的窗口,所以只能说
 *    「手动备份不进入自动清理账;一旦发现文件身份变了,自动清理就不再管它」(设计审三弹 M2)。
 * 3. 设置文件坏了 ⇒ 显原话 + 一颗「重置」按钮。⭐ **这里给按钮是安全的**,与上面那条
 *    「⛔ 坏配置绝不给按钮」正相反 —— 判据是**里面有没有不可再生的东西**:这份文件里
 *    没有备份钥,重置最坏 = 那些旧备份从此归你自己管。
 */
function buildAutoRow(onRan: () => void): HTMLElement {
  const wrap = document.createElement("div");
  // `pending_notice` 是「拉一次取走一次」的(设计审 H5):下面那条「真跑了一次就重读」会再拉,
  // 拉到过的那句留在这一趟面板里,⛔ 别让第二次拉(已经是 null)把它从屏上抹掉。
  let notice: string | null = null;
  const load = (): void => {
    void invoke<AutoStatus>("backup_auto_status")
      .then((a) => {
        notice = a.pending_notice ?? notice;
        renderAuto(wrap, a, notice);
      })
      .catch((e) => wrap.replaceChildren(el("p", "hkset-msg err", errText(e))));
  };
  load();
  // W4 A17(WD-06 / WD-07):自动备份在后台真跑了一次,此前开着的设置页上一点动静都没有(「上次自动备份」
  // 要点「关闭」才冒出来,「已有备份」的份数也不变)。壳每跑完一趟发一枚 `backup://auto-ran`(成没成
  // 都发;出岔子那句另走 `backup://auto` 的提示条),这里接住就把这一行与列表都重读一遍。
  // 退订挂在 `liveOff` 上,关面板时摘(`closeBackupSection`)。
  liveOff?.();
  let off: (() => void) | null = null;
  let dead = false;
  liveOff = () => {
    dead = true;
    off?.();
  };
  void listen("backup://auto-ran", () => {
    load();
    onRan();
  }).then((un) => {
    if (dead) un();
    else off = un;
  });
  return wrap;
}

function renderAuto(wrap: HTMLElement, a: AutoStatus, notice: string | null = a.pending_notice): void {
  wrap.replaceChildren();

  if (a.problem) {
    const row = el("div", "hkset-row", "");
    const reset = button(t("backup.autoReset"), () => {
      reset.disabled = true;
      void invoke<AutoStatus>("backup_reset_auto")
        .then((next) => renderAuto(wrap, next, notice))
        .catch((e) => {
          reset.disabled = false;
          wrap.appendChild(el("p", "hkset-msg err", errText(e)));
        });
    });
    row.append(el("div", "hkset-name", t("backup.autoName")), el("div", "hkset-desc", ""), reset);
    wrap.append(el("p", "hkset-msg err", a.problem), row, el("p", "settings-foot", t("backup.autoResetHint")));
    return;
  }

  // ⚠ **用按钮不用 checkbox**:这一面板每一行都是「名字 + 说明 + 按钮」,而且
  // `<input type=checkbox>` 是替换元素、**渲染不出 `::before`** ⇒ §2.3 那套热区扩展技法
  // 对它无效(热区闸当场抓到了第一版那只 16px 的框)。`.hkset-change` 本来就在扩展名单里。
  const row = el("div", "hkset-row", "");
  const msg = el("p", "hkset-msg", "");
  const toggle = button(a.enabled ? t("backup.autoOff") : t("backup.autoOn"), () => {
    toggle.disabled = true;
    void invoke<AutoStatus>("backup_set_auto", { enabled: !a.enabled })
      .then((next) => renderAuto(wrap, next, next.pending_notice ?? notice))
      .catch((e) => {
        toggle.disabled = false;
        setMsg(msg, errText(e), "err");
      });
  });
  toggle.dataset.on = a.enabled ? "1" : "0";
  // W4 A17(WD-07):开着时此前只写「已开启」—— 隔多久、留几份都收在「说明」折叠里(指南写的是
  // 「那一行会照实写出来」)。⛔ 两个数照旧从状态读(设计审 H4:那个文件可以手改,写死就会说谎)。
  row.append(
    el("div", "hkset-name", t("backup.autoName")),
    el(
      "div",
      "hkset-desc bkup-auto-state",
      a.enabled ? t("backup.autoStateOnDetail", { every: everyText(a.every_minutes), keep: a.keep }) : t("backup.autoStateOff"),
    ),
    toggle,
  );

  wrap.append(row, msg);
  // 「上次自动备份」是**状态**,常驻;下面两句是**规则解释**,收进「说明」折叠
  // (2026-08-31 用户拍板「收纳不删」)。⛔ 值仍从状态读、措辞仍按 §15.3 —— 收纳不动这两条。
  // 开着却还没跑过:说一句它什么时候会来(此前这一行空着,开了之后看不出它在不在干活)。
  if (a.last_success_at || a.last_result) {
    wrap.appendChild(
      el(
        "p",
        "settings-sub bkup-auto-last",
        t("backup.autoLast", {
          when: a.last_success_at ? when(new Date(a.last_success_at).getTime()) : "—",
          what: a.last_result ?? "",
        }),
      ),
    );
  } else if (a.enabled) {
    wrap.appendChild(el("p", "settings-sub bkup-auto-last", t("backup.autoNotYet")));
  }
  wrap.appendChild(
    noteFold(t("backup.autoDesc", { every: everyText(a.every_minutes), keep: a.keep }), t("backup.autoManualSafe")),
  );
  // ⭐ 那枚「结论没能记下来」的通知:它只活在进程内,拉到就得显(设计审 H5)。
  if (notice) wrap.appendChild(el("p", "hkset-msg err", notice));

  // ⭐⭐ **路径必须列出来,光给个数不算数**(420 补的真机验收撞出来的):
  // 「不再自动管」的意思就是**从此归你处置** —— 不告诉你是哪几份,你就无从处置。
  // ⛔ 别把这两块收成一句话,也别只显数量(那正是被这次验收抓到的那个形)。
  noteBlock(wrap, t("backup.releasedLead", { n: a.released.length }), a.released);
  noteBlock(wrap, t("backup.retryLead", { n: a.retry.length }), a.retry);
}

/** 一块「路径 + 原因」清单;空的就整块不显。 */
function noteBlock(wrap: HTMLElement, lead: string, notes: { path: string; why: string }[]): void {
  if (notes.length === 0) return;
  wrap.appendChild(el("p", "hkset-msg err", lead));
  for (const n of notes) {
    wrap.appendChild(el("div", "bkup-file", `${n.path} —— ${n.why}`));
  }
}

function everyText(minutes: number): string {
  if (minutes % 1440 === 0) return t("backup.everyDays", { n: minutes / 1440 });
  if (minutes % 60 === 0) return t("backup.everyHours", { n: minutes / 60 });
  return t("backup.everyMinutes", { n: minutes });
}

/**
 * 主窗右下角那张提示条:**只在自动备份出岔子时弹**。
 *
 * ⛔ **成功不弹**——天天弹 = 用户学会无视它,那就等于没有提示。
 * ⭐ **同一个原因每进程只弹一次**:60 秒一 tick,不去抖就是每分钟一张脸。
 * ⚠ `emit` 只是"及时"不是"可靠"(主窗没开就收不到)⇒ 启动时**主动拉一次**状态,
 *    把那枚 `pending_notice` 补显出来(设计审 H5)。
 */
const shownReasons = new Set<string>();

export function initAutoBackupBanner(): void {
  void listen<{ reason: string; text: string }>("backup://auto", (ev) => {
    if (shownReasons.has(ev.payload.reason)) return;
    shownReasons.add(ev.payload.reason);
    showAutoBanner(ev.payload.text);
  });
  void invoke<AutoStatus>("backup_auto_status")
    .then((a) => {
      if (a.pending_notice && !shownReasons.has(a.pending_notice)) {
        shownReasons.add(a.pending_notice);
        showAutoBanner(a.pending_notice);
      }
    })
    .catch(() => {
      /* 拉不到状态不该打扰用户:设置面里还看得见 */
    });
}

function showAutoBanner(text: string): void {
  document.querySelector(".auto-backup-banner")?.remove();
  const banner = el("div", "update-banner auto-backup-banner", "");
  const acts = el("div", "update-acts", "");
  const close = button(t("backup.autoBannerClose"), () => banner.remove());
  close.className = "hbtn";
  acts.appendChild(close);
  banner.append(
    el("div", "update-msg", t("backup.autoBannerLead")),
    el("div", "update-notes", text),
    acts,
  );
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add("show"));
}

/** 仪式:显示码 → 用户完整回输 → 对上了才落盘。 */
function renderCeremony(body: HTMLElement, code: string): void {
  ceremonyOpen = true;
  body.replaceChildren();
  const err = el("p", "hkset-msg err", "");
  const input = document.createElement("input");
  input.type = "text";
  // `bkup-code-input`:等宽、宽到放得下整串码(W4 A18:此前框比码短,点开别处后正好藏住最后一个字,
  // 抄错的偏偏常是那一位)。
  input.className = "alias-input bkup-input bkup-code-input";
  input.placeholder = t("backup.ceremonyConfirmPh");
  input.spellcheck = false;

  const confirm = button(t("backup.ceremonyConfirm"), () => {
    // 空框另说一句(W4 A18):此前空框也报「和显示的备份码对不上」。
    if (!input.value.trim()) {
      err.textContent = t("backup.codeEmpty");
      input.focus();
      return;
    }
    confirm.disabled = true;
    err.textContent = "";
    void invoke("backup_confirm_setup", { code: input.value })
      .then(() => {
        ceremonyOpen = false;
        // W4 A4(WD-03):此前这里追加一句「备份已设置好」—— 其实一份备份都没有、自动备份也没开,
        // 关掉设置再开这句也没了。⇒ 不另起一句,由「立即备份」那一行照实说「码已核对,还没有备份」
        // (重进这一节时,列表空着它照样说「还没有备份」)。
        void refresh(body, true);
      })
      .catch((e) => {
        confirm.disabled = false;
        // 码就在手上(W4 A18):core 拒了之后逐组比一遍,说出错在哪一组;⛔ 判对错的仍是 core。
        err.textContent = codeShapeProblem(input.value) ?? codeGroupDiff(code, input.value) ?? errText(e);
        input.focus();
      });
  });
  const doCancel = (): void => {
    ceremonyOpen = false;
    void invoke("backup_cancel_setup").then(() => refresh(body));
  };
  const cancel = button(t("backup.ceremonyCancel"), doCancel);
  ceremonyCancel = doCancel;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirm.click();
    }
    // Esc 在这里只清输入、不关面板(面板级 Esc 监听在 document 上,先吞掉)。
    if (e.key === "Escape") {
      e.stopPropagation();
      input.value = "";
    }
  });

  const acts = el("div", "bkup-acts", "");
  acts.append(confirm, cancel);
  body.append(
    el("p", "settings-sub", t("backup.ceremonyIntro", { perDevice: t("backup.perDeviceCode") })),
    // ⛔ 码只显示、只能手抄:没有「复制」按钮(见文件头注 2)。
    el("div", "bkup-code", code),
    el("p", "hkset-msg err", t("backup.ceremonyWarn")),
    input,
    acts,
    err,
  );
  input.focus();
}

/**
 * 封锁态的唯一出路:一句原因 + 「重试清扫」。⛔ 没有「忽略」按钮 —— 封锁的意思是
 * 盘上真躺着明文整库副本,点掉它不会让那份文件消失。
 *
 * 两处共用一份:①开面板时就已封锁;②这一趟备份自己把它变成封锁的。
 */
function retryRow(body: HTMLElement, reason: string): HTMLElement {
  const wrap = document.createElement("div");
  const msg = el("p", "hkset-msg err", reason);
  const row = el("div", "hkset-row", "");
  const retry = button(t("backup.retryCleanup"), () => {
    retry.disabled = true;
    retry.textContent = t("backup.cleaning");
    void invoke<BackupStatus>("backup_retry_cleanup")
      .then((next) => {
        render(body, next);
        if (!next.blocked) body.appendChild(el("p", "hkset-msg ok", t("backup.cleanNowOk")));
      })
      .catch((e) => {
        retry.disabled = false;
        retry.textContent = t("backup.retryCleanup");
        msg.textContent = errText(e);
      });
  });
  row.append(el("div", "hkset-name", t("backup.title")), el("div", "hkset-desc", ""), retry);
  wrap.append(msg, row);
  return wrap;
}

/** 落点目录:可粘贴的路径 + 保存 + 打开文件夹(§5.2:v1 没有原生目录选择器)。 */
function buildDirRow(st: BackupStatus, onSaved: () => void): HTMLElement {
  const wrap = document.createElement("div");
  const row = el("div", "hkset-row", "");
  const msg = el("p", "hkset-msg", "");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "alias-input bkup-input";
  input.placeholder = t("backup.dirPh");
  input.value = st.dir;
  input.title = st.dir; // 再长的路径悬停也看得全(框本身占满一整行,W4 Q11 / WD-24)
  input.spellcheck = false;

  const save = button(t("common.save"), () => {
    save.disabled = true;
    void invoke<BackupStatus>("backup_set_dir", { dir: input.value })
      .then((next) => {
        input.value = next.dir;
        input.title = next.dir;
        setMsg(msg, t("backup.dirSaved"), "ok");
        onSaved();
      })
      // 后端拒了(路径不存在 / 不是目录 / 写不进):回显旧值 + 后端原话。
      .catch((e) => {
        input.value = st.dir;
        setMsg(msg, errText(e), "err");
      })
      .finally(() => {
        save.disabled = false;
      });
  });
  const open = button(t("backup.openDir"), () => {
    void invoke("backup_open_dir").catch((e) => setMsg(msg, errText(e), "err"));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save.click();
    }
  });

  // `bkup-dir`:路径框独占一整行、两枚钮折到下一行靠右(W4 Q11 / WD-24:此前三样并排,框里的
  // 默认路径显示不全 —— 偏偏默认那个是普通人在资源管理器里看不见的数据目录)。
  const ctrls = el("div", "alias-ctrls bkup-dir", "");
  ctrls.append(input, save, open);
  row.append(el("div", "hkset-name", t("backup.dirName")), ctrls);
  // 默认落点与主库同一块盘(指南那句搬到做决定的这一行下面;此前只在指南里)。
  wrap.append(row, el("p", "settings-sub bkup-dir-note", t("backup.dirNote")), msg);
  return wrap;
}

/**
 * 「立即备份」那一行。⭐ W4 A19(WD-19):结果**写在这一行自己的说明格里**,不再往行下插一段把
 * 「已有备份」「自动备份」整排往下推(此前推 37px,手要跟着找)。说明格平时是「点一下,所有空间各备一份」,
 * 跑着时「备份中…」,跑完「HH:MM 备好 1 个空间:默认空间」—— 一格换字,版面不动。
 * ⚠ 只有**出了岔子**才往行下摊开细节(失败几个各为什么、剩下几个没跑、明文没删掉):
 * 那是「失败要摊开」(文件头注 3),宁可推一下版面也不许收成一句。
 * ⭐ W4 A4:列表空着时这一格照实说「还没有备份」(刚走完仪式时多半一句「码已核对」),
 * 别让人以为设置好了就是备好了。
 */
function buildRunRow(
  body: HTMLElement,
  justSetUp: boolean,
  reloadList: () => void,
): { wrap: HTMLElement; setCount: (n: number) => void } {
  const wrap = document.createElement("div");
  const row = el("div", "hkset-row", "");
  const desc = el("div", "hkset-desc bkup-run-desc", t("backup.runDesc"));
  const out = el("div", "bkup-out bkup-run-out", ""); // bkup-run-out:只给 e2e 一个准头(同 bkup-restore)
  let count: number | null = null; // 列表还没读回来 = 不知道,先说平常那句
  let running = false;
  let last: { text: string; err: boolean } | null = null;

  const paint = (): void => {
    let text = t("backup.runDesc");
    let cls = "";
    if (running) text = t("backup.running");
    else if (last) {
      text = last.text;
      cls = last.err ? "err" : "ok";
    } else if (count === 0) {
      text = justSetUp ? t("backup.setUpNoBackup") : t("backup.noBackupYet");
      cls = "err";
    } else if (justSetUp) text = t("backup.setUpDone");
    desc.textContent = text;
    desc.className = "hkset-desc bkup-run-desc" + (cls ? ` ${cls}` : "");
  };

  const run = button(t("backup.runNow"), () => {
    run.disabled = true;
    running = true;
    last = null;
    out.replaceChildren();
    paint();
    void invoke<Report>("backup_run")
      .then(async (r) => {
        // 名字只是给人认的:空间表读不到时照写空间号(真值,不编名字),⛔ 别让它把这一趟的报告吞掉。
        const names = await spaceNames().catch(() => new Map<string, string>());
        const clean = r.made.length > 0 && r.failed.length === 0 && !r.fatal && r.skipped === 0 && !r.blocked;
        if (clean) {
          last = {
            text: t("backup.ranOk", {
              when: when(Date.now()),
              n: r.made.length,
              spaces: r.made.map((m) => names.get(m.space_id) ?? m.space_id).join(t("backup.nameSep")),
            }),
            err: false,
          };
        } else {
          last = { text: r.made.length > 0 ? t("backup.ranPartly") : t("backup.reportNone"), err: true };
          renderReport(out, r, names);
          // 明文删不掉那一支:就地补一枚「重试清扫」。
          // ⛔ **别在这里重画整节** —— 那会把刚摊开的报告冲掉,而这恰恰是细节最要紧的一支
          //(哪个空间留下了明文、哪份产物写完但没验)。
          if (r.blocked) out.appendChild(retryRow(body, r.blocked));
        }
        // W4 A17(WD-06):此前紧下一行「已有备份」照旧写「这个目录里还没有备份文件」,要点「刷新」才变。
        if (r.made.length > 0) reloadList();
      })
      .catch((e) => {
        last = { text: errText(e), err: true };
      })
      .finally(() => {
        running = false;
        run.disabled = false;
        paint();
      });
  });
  row.append(el("div", "hkset-name", t("backup.runName")), desc, run);
  wrap.append(row, out);
  paint();
  return {
    wrap,
    setCount: (n) => {
      count = n;
      paint();
    },
  };
}

/** 空间号 → 这台上的显示名(主空间没起过名 =「默认空间」,同空间菜单)。 */
async function spaceNames(): Promise<Map<string, string>> {
  return new Map((await listSpaces()).map((s) => [s.id, spaceLabel(s)] as const));
}

/** ⭐ 把这一趟摊开:成功几个、失败几个各为什么、剩下几个根本没跑。 */
function renderReport(out: HTMLElement, r: Report, names: Map<string, string>): void {
  out.replaceChildren();
  const label = (id: string): string => names.get(id) ?? id;
  out.appendChild(
    el(
      "p",
      r.made.length > 0 ? "hkset-msg ok" : "hkset-msg err",
      r.made.length > 0 ? t("backup.reportMade", { n: r.made.length }) : t("backup.reportNone"),
    ),
  );
  // 一行一份:空间名 · 大小(悬停看文件全名)。⛔ 文件名本身一个字不动(W4 A15),只是不再满屏摆。
  for (const m of r.made) {
    const line = el("div", "bkup-file", `${label(m.space_id)} · ${size(m.bytes)}`);
    line.title = baseName(m.path);
    out.appendChild(line);
  }

  if (r.failed.length > 0) {
    out.appendChild(el("p", "hkset-msg err", t("backup.reportFailed", { n: r.failed.length })));
    for (const f of r.failed) {
      out.appendChild(el("div", "bkup-file", `${label(f.space_id)} —— ${f.message}`));
      // ⛔ 盘上留下的那个文件**不得**被读成一份备份:两种态各有各的话。
      if (f.leftover_kind === "unverified") {
        out.appendChild(el("div", "bkup-file", t("backup.leftoverUnverified")));
      } else if (f.leftover_kind === "invalid") {
        out.appendChild(el("div", "bkup-file", t("backup.leftoverInvalid")));
      }
    }
  }
  // 「整批停下」与「跑了但失败」显著区分:fatal 一句 + 没跑的个数单独一行。
  if (r.fatal) out.appendChild(el("p", "hkset-msg err", t("backup.reportFatal") + r.fatal));
  if (r.skipped > 0) out.appendChild(el("p", "hkset-msg err", t("backup.reportSkipped", { n: r.skipped })));
}

// ---- 小工具 ----

function baseName(p: string): string {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut >= 0 ? p.slice(cut + 1) : p;
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 文件改动时刻,按本地时区显示到分钟。⛔ core 那边取不到时刻就给 `null`,这里不编一个。 */
function when(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function el(tag: string, cls: string, text: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "hkset-change";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function setMsg(msg: HTMLElement, text: string, kind: "ok" | "err" | ""): void {
  msg.textContent = text;
  msg.className = "hkset-msg" + (kind ? " " + kind : "");
}
