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

type BackupStatus = {
  configured: boolean;
  dir: string;
  blocked: string | null;
  busy: "backup" | "cleanup" | null;
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
type Report = {
  made: Made[];
  failed: Failed[];
  skipped: number;
  fatal: string | null;
  blocked: string | null;
};

/** 仪式进行中(码已显示、还没核对)。关面板时据此通知后端把那把钥丢掉。 */
let ceremonyOpen = false;

/** 「备份」一节的整块。设置面板每次打开重建一只。 */
export function buildBackupSection(): HTMLElement {
  const wrap = document.createElement("div");
  const body = el("div", "bkup-body", t("common.loading"));
  wrap.append(body, el("p", "settings-foot", t("backup.footSecrets")), el("p", "settings-foot", t("backup.footUninstall")));
  void refresh(body);
  return wrap;
}

/**
 * 关面板 / 切走时调:仪式还开着就让后端丢掉那把**只在内存里**的钥。
 * ⭐ 盘上此刻什么都没写过 ⇒ 下次是干净的首次使用(⛔ 反过来「先落盘再让用户抄」会留下
 * 一把没人抄过的钥)。
 */
export function closeBackupSection(): void {
  if (!ceremonyOpen) return;
  ceremonyOpen = false;
  void invoke("backup_cancel_setup");
}

async function refresh(body: HTMLElement): Promise<void> {
  try {
    render(body, await invoke<BackupStatus>("backup_status"));
  } catch (e) {
    body.replaceChildren(el("p", "hkset-msg err", String(e)));
  }
}

function render(body: HTMLElement, st: BackupStatus): void {
  ceremonyOpen = false;
  body.replaceChildren();

  // ⛔ 配置坏了 / 上次写盘死在半路:显示原话 + 劝阻「重新设置一次」,**不给任何按钮**
  //(那会换一把新钥,已有备份从此永远打不开)。
  if (st.problem) {
    body.append(
      el("p", "hkset-msg err", t("backup.problemLead") + st.problem),
      el("p", "settings-foot", t("backup.problemHint")),
    );
    return;
  }

  // 封锁态:暂存区里还躺着**明文**副本。唯一出路是重试清扫(⛔ 没有「忽略」)。
  if (st.blocked) {
    body.appendChild(retryRow(body, st.blocked));
    return;
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
          err.textContent = String(e);
        });
    });
    row.append(el("div", "hkset-name", t("backup.title")), el("div", "hkset-desc", t("backup.notSet")), go);
    body.append(row, err);
    return;
  }

  body.append(buildDirRow(st), buildRunRow(body), buildListSection(), buildAutoRow());
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
function buildListSection(): HTMLElement {
  const wrap = document.createElement("div");
  const head = el("div", "hkset-row", "");
  const out = el("div", "bkup-out", "");
  const reload = button(t("backup.listReload"), () => void loadList(out));
  head.append(
    el("div", "hkset-name", t("backup.listName")),
    el("div", "hkset-desc", t("backup.listDesc")),
    reload,
  );
  wrap.append(head, out);
  void loadList(out);
  return wrap;
}

async function loadList(out: HTMLElement): Promise<void> {
  out.replaceChildren(el("p", "hkset-msg", t("common.loading")));
  let list: Entry[];
  try {
    list = await invoke<Entry[]>("backup_list");
  } catch (e) {
    out.replaceChildren(el("p", "hkset-msg err", String(e)));
    return;
  }
  out.replaceChildren();
  if (list.length === 0) {
    out.appendChild(el("p", "hkset-msg", t("backup.listEmpty")));
    return;
  }
  for (const e of list) out.appendChild(listRow(e));
}

function listRow(e: Entry): HTMLElement {
  const row = el("div", "bkup-item", "");
  const name = el("span", "bkup-item-name", e.file_name);
  // 盘上事实那半:大小 + 改动时刻。⛔ 这两格**不是**「它是不是一份好备份」。
  const facts = el("span", "bkup-item-meta", `${size(e.bytes)}${e.modified_ms ? " · " + when(e.modified_ms) : ""}`);
  // ⭐ 默认就是这句「还没验过」,不是空白也不是「有效」。
  const state = el("span", "bkup-item-state", t("backup.listUnverified"));

  const verify = button(t("backup.listVerify"), () => {
    verify.disabled = true;
    state.className = "bkup-item-state";
    state.textContent = t("backup.listVerifying");
    void invoke<Verified>("backup_verify", { path: e.path })
      .then((v) => {
        state.className = "bkup-item-state ok";
        // 说的是「**当前**完整可读」——⛔ 不许追认「当初那趟备份成功了」(§3.3 那张表)。
        state.textContent = t("backup.listOk", {
          space: v.space_name || v.space_id,
          size: size(v.plain_bytes),
        });
      })
      // ⛔ 原样摊开后端那句:「不是当前备份码对应的」与「结构不对」是两回事,
      // 糊成一句会让用户把一份其实没坏的备份删掉。
      .catch((err) => {
        state.className = "bkup-item-state err";
        state.textContent = String(err);
      })
      .finally(() => {
        verify.disabled = false;
      });
  });

  row.append(name, facts, state, verify);
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
function buildAutoRow(): HTMLElement {
  const wrap = document.createElement("div");
  void invoke<AutoStatus>("backup_auto_status")
    .then((a) => renderAuto(wrap, a))
    .catch((e) => wrap.replaceChildren(el("p", "hkset-msg err", String(e))));
  return wrap;
}

function renderAuto(wrap: HTMLElement, a: AutoStatus): void {
  wrap.replaceChildren();

  if (a.problem) {
    const row = el("div", "hkset-row", "");
    const reset = button(t("backup.autoReset"), () => {
      reset.disabled = true;
      void invoke<AutoStatus>("backup_reset_auto")
        .then((next) => renderAuto(wrap, next))
        .catch((e) => {
          reset.disabled = false;
          wrap.appendChild(el("p", "hkset-msg err", String(e)));
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
      .then((next) => renderAuto(wrap, next))
      .catch((e) => {
        toggle.disabled = false;
        setMsg(msg, String(e), "err");
      });
  });
  toggle.dataset.on = a.enabled ? "1" : "0";
  row.append(
    el("div", "hkset-name", t("backup.autoName")),
    el("div", "hkset-desc", a.enabled ? t("backup.autoStateOn") : t("backup.autoStateOff")),
    toggle,
  );

  wrap.append(
    row,
    // ⭐ 值从状态读(⛔ 别写死),⛔ 那句承诺按 §15.3 末的措辞写。
    el("p", "settings-sub", t("backup.autoDesc", { every: everyText(a.every_minutes), keep: a.keep })),
    el("p", "settings-sub", t("backup.autoManualSafe")),
    msg,
  );
  if (a.last_success_at || a.last_result) {
    wrap.appendChild(
      el(
        "p",
        "settings-sub",
        t("backup.autoLast", {
          when: a.last_success_at ? new Date(a.last_success_at).toLocaleString() : "—",
          what: a.last_result ?? "",
        }),
      ),
    );
  }
  // ⭐ 那枚「结论没能记下来」的通知:它只活在进程内,拉到就得显(设计审 H5)。
  if (a.pending_notice) wrap.appendChild(el("p", "hkset-msg err", a.pending_notice));
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
  input.className = "alias-input bkup-input";
  input.placeholder = t("backup.ceremonyConfirmPh");

  const confirm = button(t("backup.ceremonyConfirm"), () => {
    confirm.disabled = true;
    err.textContent = "";
    void invoke("backup_confirm_setup", { code: input.value })
      .then(() => {
        ceremonyOpen = false;
        void refresh(body).then(() => body.appendChild(el("p", "hkset-msg ok", t("backup.ceremonyDone"))));
      })
      .catch((e) => {
        confirm.disabled = false;
        err.textContent = String(e);
      });
  });
  const cancel = button(t("backup.ceremonyCancel"), () => {
    ceremonyOpen = false;
    void invoke("backup_cancel_setup").then(() => refresh(body));
  });
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
    el("p", "settings-sub", t("backup.ceremonyIntro")),
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
        msg.textContent = String(e);
      });
  });
  row.append(el("div", "hkset-name", t("backup.title")), el("div", "hkset-desc", ""), retry);
  wrap.append(msg, row);
  return wrap;
}

/** 落点目录:可粘贴的路径 + 保存 + 打开文件夹(§5.2:v1 没有原生目录选择器)。 */
function buildDirRow(st: BackupStatus): HTMLElement {
  const wrap = document.createElement("div");
  const row = el("div", "hkset-row", "");
  const msg = el("p", "hkset-msg", "");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "alias-input bkup-input";
  input.placeholder = t("backup.dirPh");
  input.value = st.dir;

  const save = button(t("common.save"), () => {
    save.disabled = true;
    void invoke<BackupStatus>("backup_set_dir", { dir: input.value })
      .then((next) => {
        input.value = next.dir;
        setMsg(msg, t("backup.dirSaved"), "ok");
      })
      // 后端拒了(路径不存在 / 不是目录 / 写不进):回显旧值 + 后端原话。
      .catch((e) => {
        input.value = st.dir;
        setMsg(msg, String(e), "err");
      })
      .finally(() => {
        save.disabled = false;
      });
  });
  const open = button(t("backup.openDir"), () => {
    void invoke("backup_open_dir").catch((e) => setMsg(msg, String(e), "err"));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save.click();
    }
  });

  const ctrls = el("div", "alias-ctrls", "");
  ctrls.append(input, save, open);
  row.append(el("div", "hkset-name", t("backup.dirName")), ctrls);
  wrap.append(row, msg);
  return wrap;
}

function buildRunRow(body: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  const row = el("div", "hkset-row", "");
  const out = el("div", "bkup-out", "");

  const run = button(t("backup.runNow"), () => {
    run.disabled = true;
    out.replaceChildren(el("p", "hkset-msg", t("backup.running")));
    void invoke<Report>("backup_run")
      .then((r) => {
        renderReport(out, r);
        // 明文删不掉那一支:就地补一枚「重试清扫」。
        // ⛔ **别在这里重画整节** —— 那会把刚摊开的报告冲掉,而这恰恰是细节最要紧的一支
        //(哪个空间留下了明文、哪份产物写完但没验)。
        if (r.blocked) out.appendChild(retryRow(body, r.blocked));
      })
      .catch((e) => out.replaceChildren(el("p", "hkset-msg err", String(e))))
      .finally(() => {
        run.disabled = false;
      });
  });
  row.append(
    el("div", "hkset-name", t("backup.runName")),
    el("div", "hkset-desc", t("backup.runDesc")),
    run,
  );
  wrap.append(row, out);
  return wrap;
}

/** ⭐ 把这一趟摊开:成功几个、失败几个各为什么、剩下几个根本没跑。 */
function renderReport(out: HTMLElement, r: Report): void {
  out.replaceChildren();
  out.appendChild(
    el(
      "p",
      r.made.length > 0 ? "hkset-msg ok" : "hkset-msg err",
      r.made.length > 0 ? t("backup.reportMade", { n: r.made.length }) : t("backup.reportNone"),
    ),
  );
  for (const m of r.made) out.appendChild(el("div", "bkup-file", `${baseName(m.path)} · ${size(m.bytes)}`));

  if (r.failed.length > 0) {
    out.appendChild(el("p", "hkset-msg err", t("backup.reportFailed", { n: r.failed.length })));
    for (const f of r.failed) {
      out.appendChild(el("div", "bkup-file", `${f.space_id} —— ${f.message}`));
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
