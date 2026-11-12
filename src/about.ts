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
import { DEFAULT_SYNC_URL, configuredServer } from "./sync";
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
/** 六项里「连没连上那台服务器」的那一项(core `selftest.rs::net_probe`)。人话结论只看它:
 *  前五项是本机的加密自测,与「连得上连不上」无关(它们红了照样在下面那几行里报红)。 */
const CONNECT_STEP = "wss-challenge";

// 桌面只从 zhujian.app 分发(国内版 / 境外版那道渠道接缝只在手机端),故链接写死境外站。
// W4 Q11 / WD-23:用户指南链官网文档中心(`/docs/`,由公开仓那份 user-guide.md 按「##」拆页生成,
// build-site-cool.mjs),⛔ 不再链 GitHub 上的 md 源文件 —— 那是开发者的仓库界面,境内也不一定打得开。
const SITE = "https://zhujian.app";
const REPO = "https://github.com/prehisle/zhujian";
/** 用户指南的地址。设置左栏底那枚「用户指南 ↗」与本页「链接」里那枚读的是这同一个(898 B5),⛔ 别抄第二份。 */
export const GUIDE_URL = `${SITE}/docs/`;

/** `gotoFeedback`:作者那句里「意见反馈」几个字点了去哪(设置面板把通用页那一节翻出来,W4 Q11 / WD-33)。 */
export function buildAboutPane(pane: HTMLElement, probeUrl: string | null, gotoFeedback: () => void): void {
  // 复制诊断信息时要拼的几段,各自拿到结果后填进来;没拿到的那段照实说「没拿到」。
  const report: Report = { version: "", build: "", db: [], probe: [] };

  pane.append(
    el("h2", "settings-title settings-sect", t("settings.catAbout")),
    el("p", "settings-sub", t("settings.aboutSub")),
    buildVersionRow(report),
    // 作者一句:是一句话不是读数 ⇒ 正文字体(⛔ 别套 .about-mono)。手机端那格逐字同句(也是三段拼,
    // 同 android shell.aboutAuthorPre / Link / Post)。「意见反馈」做成链接跳过去(WD-33:此前点了没反应)。
    buildAuthorLine(gotoFeedback),

    el("h2", "settings-title settings-sect", t("settings.linksTitle")),
    el("p", "settings-sub", t("settings.linksSub")),
    buildLinks(),

    el("h2", "settings-title settings-sect", t("settings.diagTitle")),
    el("p", "settings-sub", t("settings.diagSub")),
    buildDbBlock(report),
    buildProbeBlock(report, probeUrl),
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
  const check = el("button", "hkset-change about-check", t("settings.checkUpdate"));
  // W4 A26(WD-28):此前点了钮不变、不说在查,结果在设置浮层外的右下角闪 4 秒半,关于页一个字不留。
  // ⇒ 点下钮写「正在检查…」并禁用;结论留在这一行下面(这一格常占一行的位置,出字不推版面 —— A19 同理)。
  // 有新版照旧走那张更新提示条(update.ts),这里多一句指过去。
  const result = el("p", "hkset-msg about-update-msg", "");
  check.addEventListener("click", () => {
    check.disabled = true;
    check.textContent = t("update.checking");
    result.className = "hkset-msg about-update-msg";
    result.textContent = "";
    checkForUpdateManual()
      .then((r) => {
        result.className = "hkset-msg about-update-msg ok";
        result.textContent = r.kind === "newer" ? t("update.newerHere", { v: r.version }) : t("update.upToDate", { v: r.version });
      })
      .catch((e) => {
        result.className = "hkset-msg about-update-msg err";
        result.textContent = t("update.checkFailed", { err: errDetail(e) });
      })
      .finally(() => {
        check.disabled = false;
        check.textContent = t("settings.checkUpdate");
      });
  });
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
  wrap.append(line, result, msg);
  return wrap;
}

function buildAuthorLine(gotoFeedback: () => void): HTMLElement {
  const p = el("p", "about-author", t("settings.aboutAuthorPre"));
  const a = el("a", "about-link about-feedback", t("settings.aboutAuthorLink"));
  a.href = "#";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    gotoFeedback();
  });
  p.append(a, t("settings.aboutAuthorPost"));
  return p;
}

// ---- 链接 ----

function buildLinks(): HTMLElement {
  const links: [string, string][] = [
    [t("settings.linkSite"), SITE],
    [t("settings.linkSource"), REPO],
    // 更新日志与官网同一个来源拼(⛔ 别写死域名:哪天桌面也分渠道,改 SITE 一处就跟着走)。
    [t("settings.linkChangelog"), `${SITE}/changelog.html`],
    [t("settings.linkGuide"), GUIDE_URL],
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

/** 地址框填哪台(用户面 137):错误条带来的那台 > 当前空间已配置的 > 默认。 */
function buildProbeBlock(report: Report, probeUrl: string | null): HTMLElement {
  const line = el("div", "hkset-row", "");
  const input = el("input", "alias-input about-url", "");
  input.type = "text";
  input.value = probeUrl ?? configuredServer() ?? DEFAULT_SYNC_URL;
  input.spellcheck = false;
  const run = el("button", "hkset-change about-probe-run", t("settings.probeRun"));
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
        // 人话结论放最上面(W4 Q5 ★①,WD-22):此前六行全是 tls-provider / ed25519 / spake2 之类
        // 缩写,成功失败都没一句结论,失败时也不写连的是哪台。术语那几行照旧留在下面(查问题用)。
        // ⚠ 两句与手机诊断页**逐字同**(两端各一份字典,`probe.verdict*`)。
        const conn = steps.find((s) => s.name === CONNECT_STEP);
        if (!conn) throw new Error(`net_probe 的结果里没有 ${CONNECT_STEP} 那一项(core 改了名?)`);
        const verdict = conn.ok ? t("probe.verdictOk", { url }) : t("probe.verdictFail", { url });
        out.replaceChildren(
          el("p", `about-verdict ${conn.ok ? "ok" : "fail"}`, verdict),
          ...steps.map((s) => {
            const r = el("div", `about-step ${s.ok ? "ok" : "fail"}`, "");
            r.append(el("span", "about-mark", s.ok ? "✓" : "✗"), el("span", "about-mono", s.name), el("span", "", s.detail));
            return r;
          }),
        );
        report.probe = [url, verdict, ...steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name} — ${s.detail}`)];
        pushCrashDiag(report);
        // 结论与那几行常落在右栏下沿之外(这一节就在「关于」页靠底;W4 A9 从错误条进来时尤其如此)⇒ 跑完把整节挪进视口。
        wrap.scrollIntoView({ block: "nearest" });
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
  // `about-probe-block`:从错误条「网络自检」进来时 settings.ts 把这一节滚进视口、焦点落在「开始」上(A9)。
  const wrap = el("div", "about-block about-probe-block", "");
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
