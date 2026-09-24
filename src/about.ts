// 设置面板「关于」一类(盈利准备 C7 + C10)。三节:版本(版本号 / 构建身份戳 / 检查更新)、
// 链接(官网 / 源码 / 用户指南 / 三份协议)、诊断(本机库 / 网络自检 / 日志文件夹 / 复制诊断信息)。
//
// ⭐ 版本那一行此前住在同步面板底部 —— 没开同步的人根本不会点开那个面板,于是「你装的是
// 几点几」这句答不上来。从这里起它只有这一个家(⛔ 别在同步面板再挂一份:两处显示同一件事,
// 改一处漏一处)。
// ⭐ 诊断三块照抄安卓诊断面(`android/src/main.ts` 的 loadDb / runProbe / loadAbout),两条命令
// 与手机端同名同形;「打开日志文件夹」是桌面独有(日志落点见 lib.rs setup 里 tauri_plugin_log 那段)。
// 「复制诊断信息」把这一页看得到的东西抄成一段人话,贴进反馈邮件用 —— 只抄屏上已有的,不另采集。
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

// ---- 版本 ----

function buildVersionRow(report: Report): HTMLElement {
  const line = el("div", "hkset-row", "");
  const name = el("span", "hkset-name", "");
  const b = buildStamp();
  const vars = { commit: b.commit, at: formatBuiltAt(b.at) };
  // ⚠ 两条静态 t() 而不是 `t(cond ? a : b, …)`:文案门禁按字面量核键。
  report.build = b.dirty ? t("settings.buildDirty", vars) : t("settings.buildStamp", vars);
  const stamp = el("div", "hkset-desc about-mono", report.build);
  const check = el("button", "hkset-change", t("settings.checkUpdate"));
  check.addEventListener("click", () => void checkForUpdateManual());
  line.append(name, stamp, check);
  const msg = el("p", "hkset-msg", "");
  void getVersion()
    .then((v) => {
      report.version = `v${v}`;
      name.textContent = report.version;
    })
    .catch((e) => setMsg(msg, String(e)));
  const wrap = el("div", "", "");
  wrap.append(line, msg);
  return wrap;
}

// ---- 链接 ----

function buildLinks(): HTMLElement {
  const links: [string, string][] = [
    [t("settings.linkSite"), SITE],
    [t("settings.linkSource"), REPO],
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
      void openUrl(url).catch((err) => setMsg(msg, String(err)));
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
  void invoke<DbInfo>("db_info", { spaceId: currentSpaceId() })
    .then((d) => {
      const rows: [string, string][] = [
        ["SQLite", d.sqlite_version],
        ["journal_mode", d.journal_mode],
        [t("settings.diagMigration"), String(d.user_version)],
        ["device_id", d.device_id],
        [t("settings.diagItems"), String(d.items)],
        [t("settings.diagPath"), d.path],
      ];
      for (const [k, v] of rows) kv.append(el("dt", "", k), el("dd", "", v));
      report.db = rows.map(([k, v]) => `${k}: ${v}`);
    })
    .catch((e) => {
      const err = t("settings.diagDbFailed", { error: String(e) });
      kv.append(el("dd", "about-err", err));
      report.db = [err];
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
      })
      .catch((e) => {
        const err = t("settings.probeFailed", { error: String(e) });
        out.replaceChildren(el("div", "about-err", err));
        report.probe = [url, err];
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
  open.addEventListener("click", () => void invoke("open_log_dir").catch((e) => setMsg(msg, String(e))));
  line.append(el("div", "hkset-name", t("settings.logTitle")), el("div", "hkset-desc", t("settings.logDesc")), open);
  const wrap = el("div", "", "");
  wrap.append(line, msg);
  return wrap;
}

function buildCopyRow(report: Report): HTMLElement {
  const line = el("div", "hkset-row", "");
  const text = (): string =>
    [
      `${t("common.appName")} ${report.version}`,
      report.build,
      "",
      `[${t("settings.diagDb")}]`,
      ...report.db,
      "",
      `[${t("settings.probeTitle")}]`,
      ...(report.probe.length ? report.probe : [t("settings.probeNotRun")]),
    ].join("\n");
  line.append(
    el("div", "hkset-name", t("settings.copyDiagTitle")),
    el("div", "hkset-desc", t("settings.copyDiagDesc")),
    copyButton(text, "hkset-change"),
  );
  return line;
}

function setMsg(msg: HTMLElement, text: string): void {
  msg.textContent = text;
  msg.className = "hkset-msg" + (text ? " err" : "");
}
