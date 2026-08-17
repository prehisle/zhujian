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
import { t } from "./i18n";

type BackupStatus = {
  configured: boolean;
  dir: string;
  blocked: string | null;
  busy: "backup" | "cleanup" | null;
  awaiting_ceremony: boolean;
  problem: string | null;
};

type Made = { space_id: string; path: string; bytes: number };
type Failed = {
  space_id: string;
  message: string;
  leftover_kind: "unverified" | "invalid" | null;
  leftover_path: string | null;
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

  body.append(buildDirRow(st), buildRunRow(body));
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
