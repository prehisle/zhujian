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

import { t } from "./i18n";
import * as saf from "./saf";
import { $ } from "./ui";

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

/** 打开设置面时调。⛔ 每次都**重新问一遍**状态 —— 回调不是真相源(§17.5)。 */
export function loadBackup(): void {
  const body = $("backup-body");
  body.replaceChildren(el("p", "fine", t("backup.loading")));
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
    body.replaceChildren(el("p", "fine warn-ink", String(e)));
  }
}

function render(body: HTMLElement, st: Status, outboxProblem: string): void {
  ceremonyOpen = false;
  body.replaceChildren();

  if (!saf.hasBridge()) {
    body.appendChild(el("p", "fine warn-ink", t("backup.noBridge")));
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
          body.appendChild(el("p", "fine warn-ink", String(e)));
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
  body.append(runBlock(), listBlock());
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
        void refresh().then(() => $("backup-body").appendChild(el("p", "fine", t("backup.ceremonyDone"))));
      })
      .catch((e) => {
        b.disabled = false;
        msg.textContent = String(e);
      });
  });
  const cancel = button(t("backup.ceremonyCancel"), true, () => {
    ceremonyOpen = false;
    void invoke("backup_cancel_setup").then(() => refresh());
  });
  acts.append(confirm, cancel);

  body.append(
    el("p", "fine", t("backup.ceremonyIntro")),
    el("div", "bkup-code", code),
    el("p", "fine warn-ink", t("backup.ceremonyWarn")),
    row,
    acts,
    msg,
  );
  input.focus();
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
      .catch((e) => out.replaceChildren(el("p", "fine warn-ink", String(e))))
      .finally(() => {
        b.disabled = false;
      });
  }));
  wrap.append(el("h3", "bkup-h", t("backup.runName")), row, out);
  return wrap;
}

/** ⭐ 把这一趟摊开:做成几份、每份有没有真到用户的文件夹、失败各为什么。 */
async function runMoves(out: HTMLElement, r: Report): Promise<void> {
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
    const line = el("div", "bkup-file", `${m.file_name} · ${size(m.bytes)}`);
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
    state.textContent = t("backup.movedOk", { name: done.displayName ?? name });
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
function listBlock(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.id = "backup-list";
  const head = el("div", "row", "");
  head.appendChild(button(t("backup.listReload"), true, () => void reloadList()));
  wrap.append(el("h3", "bkup-h", t("backup.listName")), head, el("div", "bkup-out", ""));
  void reloadList(wrap);
  return wrap;
}

async function reloadList(scope?: HTMLElement): Promise<void> {
  const wrap = scope ?? document.getElementById("backup-list");
  const out = wrap?.querySelector(".bkup-out");
  if (!out) return;
  out.replaceChildren(el("p", "fine", t("backup.loading")));
  const list = await saf.listTree(listAll);
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
  for (const it of list.items) out.appendChild(listRow(it));
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
  out.appendChild(others);
}

function listRow(it: saf.SafItem): HTMLElement {
  const row = el("div", "bkup-item", "");
  row.append(
    el("span", "bkup-item-name", it.name),
    el("span", "bkup-item-meta", `${size(it.bytes)}${it.ms ? " · " + when(it.ms) : ""}`),
  );
  // ⭐ 默认就是这句「还没验过」,不是空白也不是「有效」。
  const state = el("span", "bkup-item-state", t("backup.listUnverified"));
  const verify = button(t("backup.listVerify"), true, (b) => {
    b.disabled = true;
    state.className = "bkup-item-state";
    state.textContent = t("backup.listVerifying");
    void verifyOne(it.docId, state).finally(() => {
      b.disabled = false;
    });
  });
  row.append(state, verify);
  return row;
}

/**
 * 验一份:桥把它**回拷**进 outbox(尺 4 的名字由壳自己造)→ core 整个解一遍。
 *
 * ⚠ 「无论成败都删掉那份回拷」由 **Rust 那条命令**在 `finally` 位置做 —— 它与消费者同一处,
 * 于是桥上不必再开第六个入口(也就没有「删任意 outbox 文件」这个能力面)。
 */
async function verifyOne(docId: string, state: HTMLElement): Promise<void> {
  const got = await saf.fetchFile(docId);
  if (!got.ok) {
    state.className = "bkup-item-state warn-ink";
    // ⛔ 验证的 unknown **不能复用搬运那句**(实现审弹 2 L-1):那句让人「去文件夹里看看
    // 有没有它」—— 可这条路上文件本来就在文件夹里,不确定的是**这次验证做完没有**。
    state.textContent = "unknown" in got ? t("backup.verifyUnknown") : got.error;
    return;
  }
  try {
    const v = await invoke<Verified>("backup_verify", { name: got.localName });
    state.className = "bkup-item-state";
    // 说的是「**现在**打得开」——⛔ 不许追认「当初那趟备份成功了」。
    state.textContent = t("backup.listOk", {
      space: v.space_name ?? v.space_id,
      size: size(v.plain_bytes),
    });
    // ⛔ 「验完就删」这条义务没兑现的话要说出来 —— 它不是失败(验证结论照旧成立),
    // 但静默就等于假装做到了(实现审一弹 M-4)。
    if (v.cleanup_error) state.parentElement?.appendChild(el("div", "bkup-file warn-ink", v.cleanup_error));
  } catch (e) {
    // ⛔ 原样摊开后端那句:「不是这个备份码对应的」与「结构不对」是两回事,
    // 糊成一句会让用户把一份其实没坏的备份删掉。
    state.className = "bkup-item-state warn-ink";
    state.textContent = String(e);
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
        wrap.appendChild(el("p", "fine warn-ink", String(e)));
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
