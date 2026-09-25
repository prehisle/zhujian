// 设置面板「关于」一类(盈利准备 C7 + C10)。三节:版本(版本号 / 构建身份戳 / 检查更新 / 作者一句)、
// 链接(官网 / 源码 / 更新日志 / 用户指南 / 三份协议)、诊断(本机库 / 网络自检 / 日志文件夹 / 复制诊断信息)。
//
// ⭐ 版本那一行此前住在同步面板底部 —— 没开同步的人根本不会点开那个面板,于是「你装的是
// 几点几」这句答不上来。从这里起它只有这一个家(⛔ 别在同步面板再挂一份:两处显示同一件事,
// 改一处漏一处)。
// ⭐ 诊断三块照抄安卓诊断面(`android/src/main.ts` 的 loadDb / runProbe / loadAbout),两条命令
// 与手机端同名同形;「打开日志文件夹」是桌面独有(日志落点见 lib.rs setup 里 tauri_plugin_log 那段)。
// 「复制诊断信息」把这一页看得到的东西抄成一段人话,贴进反馈邮件用 —— 只抄屏上已有的,不另采集。
// ⭐ 崩溃弹框(C9,lib.rs `install_panic_dialog_hook`)那枚「复制诊断信息」抄的也是**这一份**:
// 开机时 notebook 窗拼一次递给壳(`bootCrashDiag`),这一页每拿到一段新结果再递一次;壳在
// 崩的那一刻把它 + 那次崩溃的原话与位置一起放进剪贴板。⛔ 别在 Rust 侧另拼一份。
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { buildStamp, formatBuiltAt } from "../shared/build-stamp";
import { checkForUpdateManual } from "./update";
import { copyButton } from "./clipboard";
import { currentSpaceId } from "./space";
import { DEFAULT_SYNC_URL } from "./sync";
import { t } from "./i18n";
import { elText as el } from "./dom";
import { errDetail, errText } from "./err";

/** lib.rs `DbInfo` 的镜像(与 mobile/src/shell.rs 同形)。 */
type DbInfo = {
  path: string;
  sqlite_version: string;
  journal_mode: string;
  user_version: number;
  device_id: string;
  items: number;
};
/** core `transport::ProbeStep`:`name` 是稳定标识(不译),`detail` 是 core 的原话。 */
type ProbeStep = { name: string; ok: boolean; detail: string };

// 桌面只从 zhujian.app 分发(国内版 / 境外版那道渠道接缝只在手机端),故链接写死境外站。
// ⚠ 用户指南住公开仓(export ALLOW 里有它),官网上没有这一页。
const SITE = "https://zhujian.app";
const REPO = "https://github.com/prehisle/zhujian";

export function buildAboutPane(pane: HTMLElement): void {
  // 复制诊断信息时要拼的几段,各自拿到结果后填进来;没拿到的那段照实说「没拿到」。
  const report: Report = { version: "", build: "", db: [], probe: [] };

  pane.append(
    el("h2", "settings-title settings-sect", t("settings.catAbout")),
    el("p", "settings-sub", t("settings.aboutSub")),
    buildVersionRow(report),
    // 作者一句:是一句话不是读数 ⇒ 正文字体(⛔ 别套 .about-mono)。手机端那格逐字同句。
    el("p", "about-author", t("settings.aboutAuthor")),

    el("h2", "settings-title settings-sect", t("settings.linksTitle")),
    el("p", "settings-sub", t("settings.linksSub")),
    buildLinks(),

    el("h2", "settings-title settings-sect", t("settings.diagTitle")),
    el("p", "settings-sub", t("settings.diagSub")),
    buildDbBlock(report),
    buildProbeBlock(report),
    buildLogRow(),
    buildCopyRow(report),
  );
}

type Report = { version: string; build: string; db: string[]; probe: string[] };

/** 构建身份戳那一行(版本行下面那格,也是诊断信息的第二行)。 */
function buildLine(): string {
  const b = buildStamp();
  const vars = { commit: b.commit, at: formatBuiltAt(b.at) };
  // ⚠ 两条静态 t() 而不是 `t(cond ? a : b, …)`:文案门禁按字面量核键。
  return b.dirty ? t("settings.buildDirty", vars) : t("settings.buildStamp", vars);
}

/** 本机库那几行(当前空间)。拿不到就是一行「读不出本机库:…」,照实进诊断信息。 */
async function loadDbRows(): Promise<{ rows: [string, string][] | null; lines: string[] }> {
  try {
    const d = await invoke<DbInfo>("db_info", { spaceId: currentSpaceId() });
    const rows: [string, string][] = [
      ["SQLite", d.sqlite_version],
      ["journal_mode", d.journal_mode],
      [t("settings.diagMigration"), String(d.user_version)],
      ["device_id", d.device_id],
      [t("settings.diagItems"), String(d.items)],
      [t("settings.diagPath"), d.path],
    ];
    return { rows, lines: rows.map(([k, v]) => `${k}: ${v}`) };
  } catch (e) {
    return { rows: null, lines: [t("settings.diagDbFailed", { error: errDetail(e) })] };
  }
}

/** 诊断信息成文:「复制诊断信息」那枚钮与崩溃弹框共用这一份。 */
function reportText(report: Report): string {
  return [
    `${t("common.appName")} ${report.version}`,
    report.build,
    "",
    `[${t("settings.diagDb")}]`,
    ...report.db,
    "",
    `[${t("settings.probeTitle")}]`,
    ...(report.probe.length ? report.probe : [t("settings.probeNotRun")]),
  ].join("\n");
}

/** 把诊断信息交给壳留着(崩溃弹框用)。递不过去只记一笔:这不该挡住任何一条用户路径。 */
function pushCrashDiag(report: Report): void {
  void invoke("set_crash_diag", { text: reportText(report) }).catch((e: unknown) =>
    console.error("set_crash_diag:", e),
  );
}

/** 开机那一次(notebook 窗启动序调):版本 + 构建 + 本机库,网络自检留「没跑过」。 */
export async function bootCrashDiag(): Promise<void> {
  const [version, db] = await Promise.all([getVersion(), loadDbRows()]);
  pushCrashDiag({ version: `v${version}`, build: buildLine(), db: db.lines, probe: [] });
}

// ---- 版本 ----

function buildVersionRow(report: Report): HTMLElement {
  const line = el("div", "hkset-row", "");
  const name = el("span", "hkset-name", "");
  report.build = buildLine();
  const stamp = el("div", "hkset-desc about-mono", report.build);
  const check = el("button", "hkset-change", t("settings.checkUpdate"));
  check.addEventListener("click", () => void checkForUpdateManual());
  line.append(name, stamp, check);
  const msg = el("p", "hkset-msg", "");
  void getVersion()
    .then((v) => {
      report.version = `v${v}`;
      name.textContent = report.version;
      pushCrashDiag(report);
    })
    .catch((e) => setMsg(msg, errText(e)));
  const wrap = el("div", "", "");
  wrap.append(line, msg);
  return wrap;
}

// ---- 链接 ----

function buildLinks(): HTMLElement {
  const links: [string, string][] = [
    [t("settings.linkSite"), SITE],
    [t("settings.linkSource"), REPO],
    // 更新日志与官网同一个来源拼(⛔ 别写死域名:哪天桌面也分渠道,改 SITE 一处就跟着走)。
    [t("settings.linkChangelog"), `${SITE}/changelog.html`],
    [t("settings.linkGuide"), `${REPO}/blob/main/docs/user-guide.md`],
    [t("settings.linkTerms"), `${SITE}/terms.html`],
    [t("settings.linkPrivacy"), `${SITE}/privacy.html`],
    [t("settings.linkRights"), `${SITE}/privacy-rights.html`],
  ];
  const msg = el("p", "hkset-msg", "");
  const row = el("div", "about-links", "");
  for (const [label, url] of links) {
    const a = el("a", "about-link", label);
    a.href = url;
    a.title = url; // 悬停看得到真实地址(同正文链接 .link-ref 的做法)
    a.addEventListener("click", (e) => {
      e.preventDefault(); // 裸 href 会把 webview 自己导走 —— 一律交给系统浏览器
      void openUrl(url).catch((err) => setMsg(msg, errText(err)));
    });
    row.appendChild(a);
  }
  const wrap = el("div", "", "");
  wrap.append(row, msg);
  return wrap;
}

// ---- 诊断:本机库 ----

function buildDbBlock(report: Report): HTMLElement {
  const wrap = el("div", "about-block", "");
  const kv = el("dl", "about-kv", "");
  wrap.append(el("div", "hkset-name", t("settings.diagDb")), kv);
  // 取回之前留空(同别名那行:几十毫秒的一闪不值得一句「读取中」)。
  void loadDbRows().then(({ rows, lines }) => {
    if (rows) for (const [k, v] of rows) kv.append(el("dt", "", k), el("dd", "", v));
    else kv.append(el("dd", "about-err", lines[0]));
    report.db = lines;
    pushCrashDiag(report);
  });
  return wrap;
}

// ---- 诊断:网络自检 ----

function buildProbeBlock(report: Report): HTMLElement {
  const line = el("div", "hkset-row", "");
  const input = el("input", "alias-input about-url", "");
  input.type = "text";
  input.value = DEFAULT_SYNC_URL;
  input.spellcheck = false;
  const run = el("button", "hkset-change", t("settings.probeRun"));
  const ctrls = el("div", "alias-ctrls", "");
  ctrls.append(input, run);
  line.append(el("div", "hkset-name", t("settings.probeTitle")), el("div", "hkset-desc", t("settings.probeDesc")), ctrls);

  const out = el("div", "about-probe", "");
  const go = (): void => {
    const url = input.value.trim();
    run.disabled = true;
    out.replaceChildren(el("div", "about-dim", t("settings.probeRunning")));
    invoke<ProbeStep[]>("net_probe", { url })
      .then((steps) => {
        out.replaceChildren(
          ...steps.map((s) => {
            const r = el("div", `about-step ${s.ok ? "ok" : "fail"}`, "");
            r.append(el("span", "about-mark", s.ok ? "✓" : "✗"), el("span", "about-mono", s.name), el("span", "", s.detail));
            return r;
          }),
        );
        report.probe = [url, ...steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name} — ${s.detail}`)];
        pushCrashDiag(report);
      })
      .catch((e) => {
        const err = t("settings.probeFailed", { error: errDetail(e) });
        out.replaceChildren(el("div", "about-err", err));
        report.probe = [url, err];
        pushCrashDiag(report);
      })
      .finally(() => {
        run.disabled = false;
      });
  };
  run.addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  });
  const wrap = el("div", "about-block", "");
  wrap.append(line, out);
  return wrap;
}

// ---- 诊断:日志文件夹 / 复制诊断信息 ----

function buildLogRow(): HTMLElement {
  const line = el("div", "hkset-row", "");
  const open = el("button", "hkset-change", t("settings.logOpen"));
  const msg = el("p", "hkset-msg", "");
  open.addEventListener("click", () => void invoke("open_log_dir").catch((e) => setMsg(msg, errText(e))));
  line.append(el("div", "hkset-name", t("settings.logTitle")), el("div", "hkset-desc", t("settings.logDesc")), open);
  const wrap = el("div", "", "");
  wrap.append(line, msg);
  return wrap;
}

function buildCopyRow(report: Report): HTMLElement {
  const line = el("div", "hkset-row", "");
  line.append(
    el("div", "hkset-name", t("settings.copyDiagTitle")),
    el("div", "hkset-desc", t("settings.copyDiagDesc")),
    copyButton(() => reportText(report), "hkset-change"),
  );
  return line;
}

function setMsg(msg: HTMLElement, text: string): void {
  msg.textContent = text;
  msg.className = "hkset-msg" + (text ? " err" : "");
}
