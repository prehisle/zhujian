// 设置面板(232):全局热键 + 外观 + 语言 + 界面字号。热键——用户可改捕获窗 / 主窗两枚键,解决
// 「热键被别的程序占用后就没法用」;录制态里按下的组合(要求带修饰键)转成加速键串交给
// 后端 set_hotkey(注销旧+注册新+存盘+刷托盘)。外观(250)——明暗三档,自动 / 亮 / 暗。
// 语言(358)——自动 / 中文 / English,改档 reload 两窗。字号——整体缩放主窗。
// 侧栏底部「设置」入口点开。全部纯设备本地、不进同步。可见文案走字典(i18n-plan)。
//
// ⭐ **445:左栏分类 + 右栏内容两栏**(444 那轮拍板「分两步走」的第二步;444 做的是第一步 =
// 行的形,纯 CSS)。此前 6 节 30 多行控件全在同一个滚动流里,要改备份落点得滚过热键 /
// 外观 / 语言 / 字号 / 别名(444 实测面板整高 2546px,而它之前是 6649px)。
import { invoke } from "@tauri-apps/api/core";
import { buildBackupSection, closeBackupSection, noteFold } from "./backup";
import { buildAboutPane } from "./about";
import { exportMarkdown } from "./export-md";
import { reminderCfg, saveReminderCfg, reminderPermissionOk, sendTestNotification } from "./reminder";
import { setTaskDeleteConfirm, taskDeleteConfirmOn } from "./delete-confirm";
import { DUE_SOON_DAYS } from "./tasktime";
import { currentZoomPercent, zoomIn, zoomOut, zoomReset, onZoomChange, ZOOM_MAX_PERCENT, ZOOM_MIN_PERCENT } from "./zoom";
import { currentThemeMode, setThemeMode, type ThemeMode } from "./theme-mode";
import { currentLangChoice, langChoiceReloads, setLangChoice, t, type LangChoice } from "./i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { currentSpaceId } from "./space";
import { copyButton } from "./clipboard";
import { compressImagesOn, setCompressImages } from "./item-images";
import { buildKeySheet } from "./keysheet";
import "./settings.css";
import { errText } from "./err";
import { holdKeyboard, type KeyboardHold } from "./dom";
import { closeSyncPanel, rosterIds } from "./sync";
import { shortIds } from "./devices";
import { loadHotkeys, setHotkeys, type Hotkeys } from "./hotkey-state";

type Which = "capture" | "notebook";
/** lib.rs `HOTKEY_TAKEN` 的镜像:`set_hotkey` 「新键注册不上」那一格的判别记号(⛔ 不是显示文案,
 *  两处逐字同)。见到它就换成「哪一枚、为什么」的人话(W4 A2)。 */
const HOTKEY_TAKEN = "hotkey-taken";
/** 左栏那几类。445 定「只分 3 类」(backlog 用户面 27:小节太少,分细了是另一种难看);
 *  第四类「关于」是盈利准备 C7 / C10 加的 —— 版本 / 链接 / 诊断三节是一整块新东西,
 *  塞进「通用」会把那一页拖到两屏半。⛔ 再加第五类之前先问能不能并进这四类。 */
export type SettingsCat = "general" | "hotkeys" | "backup" | "about";
/** lib.rs `device_identity` 的镜像。别名**进同步**(与热键/明暗/字号刻意不同)。 */
type DeviceIdentity = { this_device: string; devices: { device_id: string; alias: string | null }[] };

const ROWS: { which: Which; name: string; desc: string }[] = [
  { which: "capture", name: t("settings.captureWin"), desc: t("settings.captureWinDesc") },
  { which: "notebook", name: t("settings.notebookWin"), desc: t("settings.notebookWinDesc") },
];

// mac 上 metaKey = Cmd(显示与解析都用 Cmd);其它平台 metaKey = Win 键 → Super。
const IS_MAC = navigator.userAgent.includes("Mac");

let overlay: HTMLDivElement | null = null;
let hold: KeyboardHold | null = null;
/** 设置面板通往外面的两条路(notebook.ts 递进来):开空间菜单(W4 Q6)、切到某个空间(恢复回执的「去看看」,A16)。 */
export type SettingsDeps = { openSpaces(): void; gotoSpace(id: string, label: string): void };
let deps: SettingsDeps | null = null;
/** 上次关掉时停在哪一类、右栏滚到哪(W4 Q11 / WD-36:此前重开总回「通用」最上面)。只活在这一趟进程里。 */
let lastCat: SettingsCat = "general";
let lastScroll = 0;
/** 改语言要重载整窗(i18n.ts):重载前记一笔,重载后把设置重新打开在「语言」那一行(WD-36)。
 *  sessionStorage = 跟着这只窗活、跨 reload 还在,退出就没了 —— 正是「这一次改语言」的寿命。 */
const REOPEN_KEY = "zhujian.settings-reopen";
let hotkeys: Hotkeys = { capture: "", notebook: "", capture_taken: false, notebook_taken: false };
let recording: Which | null = null;
let recordCleanup: (() => void) | null = null;

export function initSettings(d: SettingsDeps): void {
  deps = d;
  const entry = document.getElementById("settings-entry");
  if (!entry) throw new Error("侧栏缺 #settings-entry(notebook.html 漂移?)");
  entry.addEventListener("click", () => void openSettingsPanel());
}

/** 启动序末尾调一次:刚因为改语言重载过,就把设置开回「语言」那一行、焦点落在选中的那档(WD-36)。 */
export function reopenSettingsAfterReload(): void {
  if (sessionStorage.getItem(REOPEN_KEY) !== "lang") return;
  sessionStorage.removeItem(REOPEN_KEY);
  void openSettingsPanel("general", null, "lang");
}

/**
 * 弹出设置面板。侧栏「设置」入口 + 捕获窗热键冲突提示条「点此改键」(经壳 open-settings 事件)共用。
 *
 * ⭐ **`cat` 不是可有可无的装饰**:445 分类之后,「点此改键」那条路若落在默认的「通用」上,
 * 用户点了「改键」却看不见热键行 —— 那条提示条的全部意义就没了。故那条路显式传 "hotkeys"。
 */
export async function openSettingsPanel(
  cat?: SettingsCat,
  probeUrl: string | null = null,
  landOn: "lang" | "feedback" | null = null,
): Promise<void> {
  if (overlay) return;
  // 一次只开一层(W4 A9 / 新撞-2):错误条里的「网络自检」是从同步浮层里点出来的,此前设置叠在
  // 同步浮层上面、关掉设置底下那层还在。先收掉它 —— 它把焦点还给侧栏「同步」那枚钮,下面
  // `holdKeyboard` 记下的「打开它的那枚」于是就是它,关掉设置焦点回到那儿。
  closeSyncPanel();
  hotkeys = await loadHotkeys();
  if (overlay) return; // 等 get_hotkeys 那一跳里又被打开了一次(连点两下)
  overlay = document.createElement("div");
  overlay.className = "settings-overlay";
  overlay.addEventListener("mousedown", (e) => {
    // 录制途中点外面不关(避免误关吞掉录制),先取消录制交互再说。
    if (e.target === overlay && !recording) closePanel();
  });
  const panel = document.createElement("div");
  panel.className = "settings-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", t("settings.title"));
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onPanelEsc);
  // 没点名哪一类(侧栏「设置」)= 回到上次那一类、上次那个位置(WD-36);点了名的(「点此改键」/
  // 「网络自检」/ 改完语言)照点的去。
  const focus = renderPanel(panel, cat ?? lastCat, probeUrl, cat === undefined ? lastScroll : 0, landOn);
  // 接管键盘(A3):焦点进面板 —— 平时落在当前那一类的左栏钮上;从「网络自检」进来的落在自检
  // 那节的「开始」上(A9,那一节先滚进视口)。Esc 的条件同下面的 `onPanelEsc`。
  hold = holdKeyboard(overlay, panel, {
    focus,
    onEscape: () => {
      if (!recording) closePanel();
    },
  });
}

function closePanel(): void {
  // 记下停在哪一类、滚到哪(WD-36);下次从侧栏开回到这儿。
  const content = overlay?.querySelector<HTMLElement>(".settings-content");
  const on = overlay?.querySelector<HTMLElement>(".settings-cat.on");
  if (content && on?.dataset.cat) {
    lastCat = on.dataset.cat as SettingsCat;
    lastScroll = content.scrollTop;
  }
  stopRecording();
  // 仪式还开着就让后端丢掉那把**只在内存里**的备份钥(§3.4.1 第 11 格:关面板即清)。
  closeBackupSection();
  onZoomChange(null); // 摘掉字号回调,别对已卸载的面板 DOM 悬空引用
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onPanelEsc);
  hold?.release(); // 焦点还给打开它的那枚(侧栏「设置」/ 随记页顶那条「点此改键」)
  hold = null;
}

function onPanelEsc(e: KeyboardEvent): void {
  // 录制态的 Esc 被录制监听(window 捕获相)先吞掉(取消录制);非录制态 Esc 关面板。
  // ⚠ 焦点在面板里时 Esc 走 `holdKeyboard` 的 onEscape(浮层那一层就把它截住了);这一只接的是
  // 焦点掉到 body 的时候(面板里某一块重画把聚焦的钮换掉了)。
  if (e.key === "Escape" && !recording) {
    e.stopPropagation();
    closePanel();
  }
}

const CATS: { cat: SettingsCat; label: string }[] = [
  { cat: "general", label: t("settings.catGeneral") },
  { cat: "hotkeys", label: t("settings.hotkeysTitle") },
  { cat: "backup", label: t("settings.catBackup") },
  { cat: "about", label: t("settings.catAbout") },
];

/** `probeUrl`:从错误条「网络诊断」进来时,自检要测的那台(err.ts `errNode`)。
 *  返回打开时焦点该落的那枚(见 `openSettingsPanel`)。 */
function renderPanel(
  panel: HTMLDivElement,
  initial: SettingsCat,
  probeUrl: string | null,
  scroll: number,
  landOn: "lang" | "feedback" | null,
): HTMLElement | null {
  panel.innerHTML = "";
  // 标题行 + ✕(2026-08-31 用户点名「只能点面板外关」)。Esc 与点外面照旧;✕ 是显式
  // 关闭意图,⛔ 不套 `!recording` 保护(那两道是防误触,这枚不是误触)—— closePanel
  // 自己会先 stopRecording,收干净。形照留言面板的 `.cm-close`(✕ 是符号不进字典,
  // title / aria-label 走字典)。
  const head = document.createElement("div");
  head.className = "settings-head";
  const close = document.createElement("button");
  close.className = "settings-close";
  close.textContent = "✕";
  close.title = t("settings.closeTitle");
  close.setAttribute("aria-label", t("settings.closeTitle"));
  close.addEventListener("click", () => closePanel());
  head.append(el("h2", "settings-title", t("settings.title")), close);
  panel.appendChild(head);

  const cols = document.createElement("div");
  cols.className = "settings-cols";
  const nav = document.createElement("div");
  nav.className = "settings-nav";
  const content = document.createElement("div");
  content.className = "settings-content";
  cols.append(nav, content);
  panel.appendChild(cols);

  // ⛔ **各类的内容一次全建好,切分类只切显隐 —— 别改成「点哪类才建哪类」**。
  // 判据不是省事,是这几节各自挂着状态:备份那节有仪式态(只在内存里的那把钥)与自动备份
  // 轮询、别名那行有一发 `device_identity` 请求、字号那行往 `onZoomChange` 注册了唯一那个
  // 回调槽。按需重建 = 每次切回来重发请求、丢掉仪式态、把旧 DOM 上的回调悬空
  // (memory `module-state-hoisting-checklist` 那五坑)。
  // ⭐ 代价是零:今天打开面板本来就把这些全建了一遍,445 一个 invoke 都没多发也没少发。
  const panes = new Map<SettingsCat, HTMLElement>();
  for (const { cat } of CATS) {
    const pane = document.createElement("section");
    pane.className = "settings-pane";
    pane.dataset.cat = cat;
    buildPane(cat, pane, probeUrl, show);
    panes.set(cat, pane);
    content.appendChild(pane);
  }

  const btns = CATS.map(({ cat, label }) => {
    const b = el("button", "settings-cat", label) as HTMLButtonElement;
    b.dataset.cat = cat; // e2e 与将来的深链按它认人,不认可见文字(文字随语言变)
    b.addEventListener("click", () => show(cat));
    return b;
  });
  nav.append(...btns);
  // W5 A14:左栏 ↑ ↓(Home / End)换类 —— 焦点跟着到那一枚、右边当场换页(此前只能 Tab + 回车)。到头绕回。
  nav.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const at = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let i: number;
    if (e.key === "ArrowDown") i = (at + 1) % btns.length;
    else if (e.key === "ArrowUp") i = (at - 1 + btns.length) % btns.length;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = btns.length - 1;
    else return;
    e.preventDefault();
    btns[i].focus();
    show(CATS[i].cat);
  });

  // 高亮与显隐的单一渲染点:按当前分类重画全部几枚,不在点击处各自 toggle(同 paintSeg)。
  function show(cat: SettingsCat): void {
    CATS.forEach(({ cat: c }, i) => {
      btns[i].classList.toggle("on", c === cat);
      const pane = panes.get(c);
      if (pane) pane.hidden = c !== cat;
    });
    content.scrollTop = 0; // 换一类从头看起,别把上一类滚到一半的位置带过来
  }
  show(initial);
  // 回到上次那个位置(WD-36)。⚠ 备份那一节是异步建的,内容回来之前滚不到那么深 —— 那就停在能到的最深处。
  if (scroll > 0) content.scrollTop = scroll;
  // 改完语言重载回来(WD-36):「语言」那一行滚进视口,焦点落在选中的那档上。
  if (landOn === "lang") {
    const seg = panes.get("general")?.querySelector<HTMLElement>(".lang-row .seg-btn.on");
    if (!seg) throw new Error("通用页缺「语言」那一行(buildLangRow 漂移?)");
    seg.closest(".hkset-row")?.scrollIntoView({ block: "center" });
    return seg;
  }
  // 从设备名单「移除」确认里那枚「意见反馈」进来(161 / W4 A38:想彻底隔离只能重置整个账户,那条路走写信):
  // 「意见反馈」那一节滚进视口,焦点落在邮箱链接上(同关于页那句「意见反馈」的落点)。
  if (landOn === "feedback") {
    const general = panes.get("general");
    const sect = general?.querySelector<HTMLElement>(".feedback-sect");
    const mail = general?.querySelector<HTMLElement>(".feedback-mail");
    if (!sect || !mail) throw new Error("通用页缺「意见反馈」那一节(buildPane 漂移?)");
    sect.scrollIntoView({ block: "start" });
    return mail;
  }
  // 从错误条「网络自检」进来(W4 A9 / 新撞-2):此前停在「关于」页最上面,自检那节在可视区下沿
  // 之外、得自己往下找。⇒ 那一节滚进视口(顶对齐:下面的结果行跟着露出来),焦点落在「开始」上。
  if (probeUrl !== null) {
    const block = panes.get("about")?.querySelector<HTMLElement>(".about-probe-block");
    const run = block?.querySelector<HTMLElement>(".about-probe-run");
    if (!block || !run) throw new Error("关于页缺网络自检那一节(about.ts 漂移?)");
    block.scrollIntoView({ block: "start" });
    return run;
  }
  return btns[CATS.findIndex((c) => c.cat === initial)] ?? null;
}

// ⭐ **623(用户面 74 / G):单行组不写行名** —— 一组只有一行控件时,`.settings-title` 那句
// 已经是这一格的名字,行里再写一遍就是把同一个词说了两遍(改前:语言/语言、界面字号/字号、
// 本机别名/名字三组字面重复,外加外观/明暗、截止提醒/每日提醒两组近义重复)。⇒ 通用页这
// 五组的 `.hkset-name` 全摘掉,控件靠 `.hkset-row` 那条自动外边距照旧右对齐。
// ⛔ **多行组照写行名**(快捷键两行、备份那节):那里行名是「这一行是哪一样」的唯一读法。
// ⇒ 判据是「**这一组有几行**」,不是「读着重不重复」—— 备份那节的组名与首行同为「备份」,
// 623 摘过一次又照图退回来了(理由记在 backup.ts 那行旁边)。
function buildPane(cat: SettingsCat, pane: HTMLElement, probeUrl: string | null, show: (cat: SettingsCat) => void): void {
  if (cat === "hotkeys") {
    pane.append(
      el("h2", "settings-title settings-sect", t("settings.hotkeysTitle")),
      el("p", "settings-sub", t("settings.hotkeysIntro")),
    );
    for (const row of ROWS) pane.appendChild(buildRow(row));
    pane.appendChild(el("p", "settings-foot", IS_MAC ? t("settings.recordHintMac") : t("settings.recordHint")));
    pane.appendChild(buildKeySheet(IS_MAC)); // 123:应用里的单键速查(只读;键位读 keymap.ts)
    return;
  }

  if (cat === "general") {
    pane.append(
      // W4 Q6 ★①(WD-17 / X-14):空间的入口也挂一份在设置里(同手机 W3 Q7)。此前只有一个空间时侧栏不显示
      // 空间名、设置里也没有「空间」,新建空间只能猜到「同步 → 空间…」里去 —— 而新建空间是纯本地的事。
      el("h2", "settings-title settings-sect", t("settings.spacesTitle")),
      el("p", "settings-sub", t("settings.spacesSub")),
      buildSpacesRow(),

      el("h2", "settings-title settings-sect", t("settings.autostartTitle")),
      el("p", "settings-sub", t("settings.autostartSub")),
      buildAutostartRow(),

      el("h2", "settings-title settings-sect", t("settings.appearance")),
      el("p", "settings-sub", t("settings.appearanceSub")),
      buildThemeRow(),

      el("h2", "settings-title settings-sect", t("settings.langTitle")),
      el("p", "settings-sub", t("settings.langSub")),
      buildLangRow(),

      el("h2", "settings-title settings-sect", t("settings.textSize")),
      el("p", "settings-sub", t("settings.textSizeSub")),
      buildZoomRow(),

      el("h2", "settings-title settings-sect", t("settings.compressTitle")),
      el("p", "settings-sub", t("settings.compressSub")),
      buildCompressRow(),

      el("h2", "settings-title settings-sect", t("settings.deleteConfirmTitle")),
      el("p", "settings-sub", t("settings.deleteConfirmSub")),
      buildDeleteConfirmRow(),

      el("h2", "settings-title settings-sect", t("settings.aliasTitle")),
      el("p", "settings-sub", t("settings.aliasSub")),
      buildAliasRow(),

      el("h2", "settings-title settings-sect", t("reminder.title")),
      el("p", "settings-sub", t("reminder.sub", { days: DUE_SOON_DAYS })),
      buildReminderRow(),

      // `feedback-sect`:关于页那句「在『意见反馈』里告诉我」点过来落在这儿(W4 Q11 / WD-33)。
      el("h2", "settings-title settings-sect feedback-sect", t("settings.feedbackTitle")),
      el("p", "settings-sub", t("settings.feedbackSub")),
      buildFeedbackRow(),
    );
    return;
  }

  if (cat === "about") {
    // 版本 / 链接 / 诊断,整节住 src/about.ts。「意见反馈」那几个字点了跳到通用页那一节(WD-33)。
    buildAboutPane(pane, probeUrl, () => {
      show("general");
      const sect = pane.parentElement?.querySelector<HTMLElement>(".feedback-sect");
      const mail = pane.parentElement?.querySelector<HTMLElement>(".feedback-mail");
      if (!sect || !mail) throw new Error("通用页缺「意见反馈」那一节(buildPane 漂移?)");
      sect.scrollIntoView({ block: "start" });
      mail.focus();
    });
    return;
  }

  // 备份(412,backup-plan 笔①-a):与上面几样一样是**每台机器自己的事**(钥与落点
  // 都在本机配置,不进 DB、不同步)。整节住 src/backup.ts —— 这里只挂标题与位置。
  // ⚠ 恢复那半也在这一节里(§16),故左栏那枚按钮叫「备份与恢复」。
  // ⭐ 三段长说明(是什么 / §9 那两段边界)收进一只「说明」折叠(2026-08-31 用户拍板
  // 「收纳不删」—— 此前字典里那句「常驻」被用户当面重议;⛔ 内容与措辞一字没动)。
  pane.append(
    el("h2", "settings-title settings-sect", t("backup.title")),
    noteFold(t("backup.sub"), t("backup.footSecrets"), t("backup.footUninstall")),
    buildBackupSection({
      gotoSpace: (id, label) => {
        if (!deps) throw new Error("设置面板没接 notebook 的出路(initSettings 漏传?)");
        closePanel();
        deps.gotoSpace(id, label);
      },
    }),

    // 导出为 Markdown(用户面 136):「不绑死你」的那一半 —— 备份是给朱简自己恢复用的加密文件,
    // 这一行给的是离开朱简也读得懂的明文。低频、全量,故住在这一页而不在随记顶栏(顶栏那枚
    // 「复制随记」管的是随手复制当前那批)。写法在 export-md.ts,落盘在 core::export_md。
    buildExportRow(),
  );
}

// 与上面「从备份恢复」同形的一行:名字 + 说明 + 右端一枚钮(⛔ 起初单开一节「标题 + 说明 + 孤零零一枚钮」,
// 截图里与同页那几行不成一族,改成了这样);结果(路径 / 原话报错)落在行下。
function buildExportRow(): HTMLElement {
  const wrap = document.createElement("div");
  const row = el("div", "hkset-row", "");
  const msg = el("p", "hkset-msg", "");
  msg.id = "export-msg"; // 同页还有备份那节的 .hkset-msg,e2e 按 id 认这一句
  const run = document.createElement("button");
  run.className = "hkset-change";
  run.textContent = t("export.run");
  run.addEventListener("click", () => {
    run.disabled = true;
    msg.className = "hkset-msg";
    msg.textContent = t("export.running");
    void exportMarkdown()
      .then((path) => {
        msg.className = "hkset-msg ok";
        msg.textContent = t("export.done", { path });
      })
      .catch((e) => {
        msg.className = "hkset-msg err";
        msg.textContent = errText(e);
      })
      .finally(() => {
        run.disabled = false;
      });
  });
  row.append(el("div", "hkset-name", t("export.title")), el("div", "hkset-desc", t("export.sub")), run);
  wrap.append(row, msg);
  return wrap;
}

// ---- 意见反馈(国内上架 17)----
//
// ⭐ **它的来历是上架硬门槛**:OPPO《包体测试FAQ》原文「所有应用都必须设置显著有效的客服
// 反馈渠道」,且须在**应用功能界面内**,「而非仅展示在隐私政策链接或用户协议链接内」。
// 那道门管的是国内安卓商店,桌面这端不在其内 —— 但此前桌面**一个联系方式都没有**,
// 三端说同一句话才是对的,故一并做(手机那半在 android/index.html 的 #settings-pane)。
//
// ⭐ W4 Q11 / WD-33(用户 2026-11-06 拍「全取推荐」)**推翻了此前「不做成 mailto 链接」那条**:
// 走查里人点地址本身没反应(诊断区还叫人「贴进反馈邮件」),于是地址做成链接,点了走壳的打开外链那条路
// (opener 插件,`mailto:` 在它的默认放行里)拉起写信。原先担心的两件照旧成立、换了接法:
// ①没配默认邮件程序的机器:Windows 自己弹「你要用什么打开」那一问(W4 D2 走查实例上实测,opener 不报错);
//   opener 真报错的那种在行下照实说一句(⛔ 不是静默什么都不发生)。两种情况复制钮都还在;
// ②会拉起一个程序 ⇒ 那正是点地址的人要的。
// ⚠ 按 623「单行组不写行名」:这一组只有一行,`.settings-title` 那句已经是这一格的名字,
// 故行里那枚 `.hkset-name` 放的是**地址本身**,不是再说一遍「邮箱」。
// ⚠ 零新 CSS:`.hkset-name` 左、复制钮吃 `.hkset-row > :not(...)` 那条自动外边距靠右
// ——⛔ 别往这一行里再加第二个控件,那条规则会把空隙均分给两个(它自己的注释里写着)。
//
// ⚠ 地址在两端各有一份出处(这里 + android/index.html 那个 input 的 value),
// **刻意没做成共享常数** —— 两棵前端树今天本来就不共享代码(仓根 `shared/` 那笔还在 backlog),
// 为一个邮箱地址开那条路不值。改地址时两处一起改,外加政策页那几处。
const FEEDBACK_MAIL = "3069848@qq.com";

function buildFeedbackRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row";
  const msg = el("p", "hkset-msg", "");
  const mail = el("a", "hkset-name about-link feedback-mail", FEEDBACK_MAIL) as HTMLAnchorElement;
  mail.href = `mailto:${FEEDBACK_MAIL}`;
  mail.title = t("settings.feedbackMailTitle");
  mail.addEventListener("click", (e) => {
    e.preventDefault(); // 裸 href 会把 webview 自己导走 —— 交给系统(同关于页那几条链接)
    setMsg(msg, "", "");
    void openUrl(`mailto:${FEEDBACK_MAIL}`).catch((err) => setMsg(msg, t("settings.feedbackMailFailed", { error: errText(err) }), "err"));
  });
  // copyButton 自带「已复制 / 复制失败」闪回;行下那句只给「拉不起写信」用。
  line.append(mail, copyButton(FEEDBACK_MAIL, "hkset-change"));
  const wrap = document.createElement("div");
  wrap.append(line, msg);
  return wrap as HTMLDivElement;
}

// ---- 空间(W4 Q6 ★①)----
// 一枚「空间…」:收掉设置、打开空间菜单(切换 / 新建 / 加入 / 改名 / 重置)。同手机设置里那一行,
// 菜单本身住 notebook.ts(同步面板里那枚「空间…」开的是同一只)。
function buildSpacesRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row";
  const open = el("button", "hkset-change settings-spaces", t("shell.spacesEntry")) as HTMLButtonElement;
  open.addEventListener("click", () => {
    if (!deps) throw new Error("设置面板没接 notebook 的出路(initSettings 漏传?)");
    closePanel();
    deps.openSpaces();
  });
  line.append(open); // 623:单行组不写行名
  return line;
}

// ---- 本机别名(identity-plan §2.4)----
//
// 与上面三样的关键差别:**别名进同步**(和空间名 140-142 同族),热键 / 明暗 / 字号
// 那三样是设备环境属性、刻意不同步。别搞混。

function buildAliasRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "alias-input";
  input.placeholder = t("settings.aliasUnnamed");
  input.maxLength = 60; // 后端上限 200 **字节**,这里按字符给个宽松的手感闸
  input.disabled = true;

  const save = el("button", "hkset-change", t("common.save")) as HTMLButtonElement;
  save.disabled = true;
  const msg = el("p", "hkset-msg", "");
  // 取回身份面之前留空(用户面 85 ③):那一跳几十毫秒,「读取中…」只是一闪的噪音;留空不是
  // 编造 —— 下一句那条纪律说的是「不编造占位**值**」,空串不是值。⚠ 只动这一处,
  // `devices.refreshing` 是另一处同名文案,那儿是用户点了「刷新」之后的真等待。
  const sub = el("div", "hkset-desc", "");

  // 本机 device_id 只有取回身份面之后才知道;取回前整行禁用,**不编造占位值**。
  let thisDevice: string | null = null;
  let saved = "";
  // 本机编号的那几位:当副标题,没起名时它是这台设备唯一能自证身份的东西(卡片上刻意不显 id 片段,设置面这里显——这里的
  // 语境是「这是哪台」,不是噪音)。161 / W4 A30(WP-15):位数与设备名单显示的一致(名单按「刚好能分开」取最短前缀,两台前 6 位
  // 相同就显 7 位;此前这里固定 6 位,两处对不上)—— 名册在手就按名册算,没连上过就按本机认得的那几台。
  let sid = "";
  // A14(WD-35 前半):本机别名存好后,框下那行跟着换成新名(此前存好了仍写「本机 · 01M6PN」,要去设备名单才看到生效)。
  const paintSub = () => {
    sub.textContent = saved === "" ? t("settings.thisDevice", { id: sid }) : t("settings.thisDeviceNamed", { name: saved, id: sid });
  };
  void invoke<DeviceIdentity>("device_identity", { spaceId: currentSpaceId() })
    .then((d) => {
      thisDevice = d.this_device;
      saved = d.devices.find((x) => x.device_id === d.this_device)?.alias ?? "";
      input.value = saved;
      const ids = rosterIds() ?? d.devices.map((x) => x.device_id);
      sid = shortIds(ids.includes(d.this_device) ? ids : [...ids, d.this_device]).get(d.this_device) ?? d.this_device;
      paintSub();
      input.disabled = false;
      save.disabled = false;
    })
    .catch((e) => setMsg(msg, errText(e), "err"));

  async function apply(): Promise<void> {
    if (thisDevice === null) return;
    const next = input.value.trim();
    if (next === saved) {
      setMsg(msg, "", "");
      return; // 同值:后端也是 no-op,连提示都不必给
    }
    save.disabled = true;
    try {
      await invoke("set_device_alias", {
        spaceId: currentSpaceId(),
        deviceId: thisDevice,
        // 空串 = 清名;后端 trim 后为空即落 null(显式清名是规范表示)。
        alias: next === "" ? null : next,
      });
      saved = next;
      input.value = next;
      paintSub();
      setMsg(msg, next === "" ? t("settings.aliasCleared") : t("settings.aliasSaved"), "ok");
    } catch (e) {
      input.value = saved; // 后端拒了(超长等):回显旧值 + 后端原话
      setMsg(msg, errText(e), "err");
    } finally {
      save.disabled = false;
    }
  }

  save.addEventListener("click", () => void apply());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void apply();
    }
    // W5 A14(WD-14):Esc 与这一层别处一个规矩 —— 框里有没存的改动时,第一下只放弃那改动(框回到存着的名字);
    // 没改动(或已放弃)时 Esc 就是关设置。此前这里一律吞掉:框里有字时第一下清字、之后怎么按都关不掉,
    // 而隔壁「提醒时刻」框里一按就关 —— 同一层两种规矩。
    if (e.key === "Escape" && !e.isComposing && input.value !== saved) {
      e.stopPropagation();
      input.value = saved;
      setMsg(msg, "", "");
    }
  });

  const ctrls = document.createElement("div");
  ctrls.className = "alias-ctrls";
  ctrls.append(input, save);
  line.append(sub, ctrls); // 623:单行组不写行名(见 buildPane 头上那条)

  const wrap = document.createElement("div");
  wrap.append(line, msg);
  return wrap as HTMLDivElement;
}

/** 分段钮(开 | 关、自动 亮 暗…)的「选中」一处画(165 / W5 A41,WD-30):此前只靠选中那段字变红、底色略深来分 ——
 *  字一样粗、没有勾,选中「关」时是红的反像在警告,读屏也读不出哪段是选中的(状态不单靠颜色,§五)。⇒ `aria-pressed`
 *  + 选中那段前面一枚勾、字加粗(settings.css `.seg-btn.on`)。⛔ 别在点击处各自 toggle:都走这里。 */
function segOn(b: HTMLButtonElement, on: boolean): void {
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", on ? "true" : "false");
}

// ---- 截止提醒(用户面 39 第一版)----
//
// 开关 + 报点 + 「试一条」。全部纯设备本地(localStorage,同热键/明暗/字号),调度与
// 通知在 src/reminder.ts;这里只是它的配置面。「试一条」是用户唯一能确认「通知在这台
// 机器上真的显得出来」的路(勿扰/专注模式吞通知是安静的),当场把今天的数发一遍。
function buildReminderRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row zoom-row";

  const seg = document.createElement("div");
  seg.className = "seg";
  const onBtn = el("button", "seg-btn", t("reminder.on")) as HTMLButtonElement;
  const offBtn = el("button", "seg-btn", t("reminder.off")) as HTMLButtonElement;
  seg.append(onBtn, offBtn);

  const time = document.createElement("input");
  time.type = "time";
  time.className = "remind-time";

  const test = el("button", "hkset-change", t("reminder.test")) as HTMLButtonElement;
  const msg = el("p", "hkset-msg", "");
  msg.id = "remind-msg"; // e2e 探针按它认行。⛔ 别改成类:setMsg 会整写 className,类会被冲掉

  const paint = (): void => {
    const cfg = reminderCfg();
    segOn(onBtn, cfg.on);
    segOn(offBtn, !cfg.on);
    time.value = cfg.time;
    time.disabled = !cfg.on;
  };
  paint();

  onBtn.addEventListener("click", () => {
    saveReminderCfg({ ...reminderCfg(), on: true });
    paint();
    // 开的那一刻就把权限问清:被系统拒着的话,到点才发现「怎么一直没响」是最糟的形。
    void reminderPermissionOk().then((ok) => setMsg(msg, ok ? "" : t("reminder.permDenied"), ok ? "" : "err"));
  });
  offBtn.addEventListener("click", () => {
    saveReminderCfg({ ...reminderCfg(), on: false });
    paint();
    setMsg(msg, "", "");
  });
  time.addEventListener("change", () => {
    // <input type=time> 清空时 value 是 "":不落半配置,回显已存值。
    if (!/^\d{2}:\d{2}$/.test(time.value)) {
      paint();
      return;
    }
    saveReminderCfg({ ...reminderCfg(), time: time.value });
    setMsg(msg, t("reminder.saved", { time: time.value }), "ok");
  });
  test.addEventListener("click", () => {
    test.disabled = true;
    sendTestNotification()
      .then(() => setMsg(msg, t("reminder.testSent"), "ok"))
      .catch((e) => setMsg(msg, errText(e), "err"))
      .finally(() => {
        test.disabled = false;
      });
  });

  const ctrls = document.createElement("div");
  ctrls.className = "remind-ctrls";
  ctrls.append(seg, time, test);
  line.append(ctrls); // 623:单行组不写行名(见 buildPane 头上那条)

  const wrap = document.createElement("div");
  wrap.append(line, msg);
  return wrap as HTMLDivElement;
}

// ---- 压缩大图(用户面 147)----
// 开 / 关两档,默认关(= 按原图存)。纯设备本地;规则与「为什么默认关」在 item-images.ts。
function buildCompressRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row zoom-row";
  const seg = document.createElement("div");
  seg.className = "seg";
  const onBtn = el("button", "seg-btn", t("settings.compressOn")) as HTMLButtonElement;
  const offBtn = el("button", "seg-btn", t("settings.compressOff")) as HTMLButtonElement;
  seg.append(onBtn, offBtn);
  const paint = (): void => {
    const on = compressImagesOn();
    segOn(onBtn, on);
    segOn(offBtn, !on);
  };
  paint();
  onBtn.addEventListener("click", () => {
    setCompressImages(true);
    paint();
  });
  offBtn.addEventListener("click", () => {
    setCompressImages(false);
    paint();
  });
  line.append(seg); // 623:单行组不写行名
  return line;
}

// 「删任务前确认」(158 G3 / Q6,WD-18):看板删除确认里那枚「不再提示」勾过之后,在这里改回来。
// 同压缩大图那一形(开 / 关两档 seg,单行组不写行名);偏好本身住 delete-confirm.ts。写失败照实说。
function buildDeleteConfirmRow(): HTMLDivElement {
  const wrap = document.createElement("div");
  const line = document.createElement("div");
  line.className = "hkset-row zoom-row";
  const seg = document.createElement("div");
  seg.className = "seg";
  const onBtn = el("button", "seg-btn", t("settings.deleteConfirmOn")) as HTMLButtonElement;
  const offBtn = el("button", "seg-btn", t("settings.deleteConfirmOff")) as HTMLButtonElement;
  onBtn.id = "delete-confirm-on"; // e2e 探针按它认钮
  offBtn.id = "delete-confirm-off";
  seg.append(onBtn, offBtn);
  const msg = el("p", "hkset-msg", "");
  const paint = (): void => {
    const on = taskDeleteConfirmOn();
    segOn(onBtn, on);
    segOn(offBtn, !on);
  };
  paint();
  const pick = (on: boolean): void => {
    const ok = setTaskDeleteConfirm(on);
    setMsg(msg, ok ? "" : t("settings.deleteConfirmSaveFailed"), ok ? "" : "err");
    paint();
  };
  onBtn.addEventListener("click", () => pick(true));
  offBtn.addEventListener("click", () => pick(false));
  line.append(seg); // 623:单行组不写行名
  wrap.append(line, msg);
  return wrap;
}

const THEME_CHOICES: { mode: ThemeMode; label: string }[] = [
  { mode: "auto", label: t("settings.themeAuto") },
  { mode: "light", label: t("settings.themeLight") },
  { mode: "dark", label: t("settings.themeDark") },
];

// ---- 开机自启(用户面 124 ①)----
//
// 开 / 关两档 seg,与截止提醒同形。⭐ 高亮只跟后端回来的**系统真值**走(get / set 都回读
// 注册表那一格),⛔ 不在点击处先乐观翻 —— 写失败时屏上必须仍是原来那档,外加一句原话。
// 默认开那一步在壳里(lib.rs::apply_autostart_default),这里不管默认。
function buildAutostartRow(): HTMLDivElement {
  const wrap = document.createElement("div");
  const line = document.createElement("div");
  line.className = "hkset-row zoom-row";
  const seg = document.createElement("div");
  seg.className = "seg";
  const onBtn = el("button", "seg-btn", t("settings.autostartOn")) as HTMLButtonElement;
  const offBtn = el("button", "seg-btn", t("settings.autostartOff")) as HTMLButtonElement;
  seg.append(onBtn, offBtn);
  const msg = el("p", "hkset-msg", "");
  const paint = (on: boolean): void => {
    segOn(onBtn, on);
    segOn(offBtn, !on);
  };
  const run = (p: Promise<boolean>): void => {
    onBtn.disabled = offBtn.disabled = true;
    void p
      .then((on) => {
        paint(on);
        setMsg(msg, "", "");
      })
      .catch((e) => setMsg(msg, errText(e), "err"))
      .finally(() => {
        onBtn.disabled = offBtn.disabled = false;
      });
  };
  onBtn.addEventListener("click", () => run(invoke<boolean>("set_autostart", { on: true })));
  offBtn.addEventListener("click", () => run(invoke<boolean>("set_autostart", { on: false })));
  run(invoke<boolean>("get_autostart"));
  line.append(seg); // 623:单行组不写行名
  wrap.append(line, msg);
  return wrap;
}

function buildThemeRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row zoom-row";

  const seg = document.createElement("div");
  seg.className = "seg";
  const btns = THEME_CHOICES.map(({ mode, label }) => {
    const b = el("button", "seg-btn", label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      setThemeMode(mode);
      paintSeg(); // 高亮的单一渲染点:改完回来按当前档重画,不在点击处各自 toggle
    });
    return b;
  });
  const paintSeg = (): void => {
    const now = currentThemeMode();
    btns.forEach((b, i) => segOn(b, THEME_CHOICES[i].mode === now));
  };
  paintSeg();
  seg.append(...btns);

  line.append(seg); // 623:单行组不写行名(见 buildPane 头上那条)
  return line;
}

// ---- 语言(358,i18n-plan)----
//
// 与明暗同形的三档 seg。语言名按惯例显自己那门语言(中文 / English),不随界面语言翻译。
// 改档 = setLangChoice 存 + 广播 + 两窗 reload(面板随窗一起没了,不必自己收)。

const LANG_CHOICES: { choice: LangChoice; label: string }[] = [
  { choice: "auto", label: t("settings.langAuto") },
  { choice: "zh", label: t("settings.langZh") },
  { choice: "en", label: t("settings.langEn") },
];

function buildLangRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row zoom-row lang-row"; // lang-row:改完语言重载回来落在这一行(WD-36)

  const seg = document.createElement("div");
  seg.className = "seg";
  const btns = LANG_CHOICES.map(({ choice, label }) => {
    const b = el("button", "seg-btn", label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      // 要重载才记那一笔(auto↔同语言不重载,记了就会在下一次随便哪种重载后莫名其妙弹出设置)。
      if (langChoiceReloads(choice)) sessionStorage.setItem(REOPEN_KEY, "lang");
      void setLangChoice(choice).then(paintSeg); // 解析语言没变(auto↔同语言)时只刷高亮
    });
    return b;
  });
  const paintSeg = (): void => {
    const now = currentLangChoice();
    btns.forEach((b, i) => segOn(b, LANG_CHOICES[i].choice === now));
  };
  paintSeg();
  seg.append(...btns);

  line.append(seg); // 623:单行组不写行名(见 buildPane 头上那条)
  return line;
}

// ---- 界面字号(W4 A21,WD-12 / WD-29)----
// 此前每点一档整窗缩放,这一行在浮层里的位置跟着变:到 120% 掉出可视区、得先滚才能接着点,200% 时被浮层
// 底边切掉半截;到 200% 再点「＋」没反应也不说到顶,两头的钮也不变灰。⇒ 三件:
//   ① 点完把右栏滚回去,让刚点的那枚钮落回点之前在屏幕上的位置(缩放改的是 CSS 像素对屏幕像素的比,
//      ⇒ 按「CSS 坐标 × 倍数」对齐),对不齐的(滚到头了)至少整行滚进视口;
//   ② 到头那枚钮变灰;③ 说明格写「已到最大 / 最小」(两头一样;平时写范围,一行常在、不跳)。
function buildZoomRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row zoom-row zoom-size-row";

  const val = el("span", "zoom-val", `${currentZoomPercent()}%`);
  const minus = el("button", "zoom-btn", "−") as HTMLButtonElement;
  const plus = el("button", "zoom-btn", "＋") as HTMLButtonElement;
  const reset = el("button", "hkset-change", t("settings.zoomReset")) as HTMLButtonElement;
  minus.setAttribute("aria-label", t("settings.zoomOut"));
  plus.setAttribute("aria-label", t("settings.zoomIn"));
  const desc = el("div", "hkset-desc zoom-limit", "");

  const paint = (p: number): void => {
    val.textContent = `${p}%`;
    minus.disabled = p <= ZOOM_MIN_PERCENT;
    plus.disabled = p >= ZOOM_MAX_PERCENT;
    desc.textContent =
      p >= ZOOM_MAX_PERCENT
        ? t("settings.zoomAtMax", { p })
        : p <= ZOOM_MIN_PERCENT
          ? t("settings.zoomAtMin", { p })
          : t("settings.zoomRange", { min: ZOOM_MIN_PERCENT, max: ZOOM_MAX_PERCENT });
    desc.classList.toggle("at-limit", p >= ZOOM_MAX_PERCENT || p <= ZOOM_MIN_PERCENT);
  };
  paint(currentZoomPercent());

  /** 点一档,点完把这枚钮钉回点之前的屏幕位置(①)。 */
  const step = (btn: HTMLButtonElement, run: () => Promise<number>): void => {
    const content = line.closest<HTMLElement>(".settings-content");
    const z0 = currentZoomPercent() / 100;
    const y0 = btn.getBoundingClientRect().top * z0;
    const w0 = window.innerWidth;
    void run().then(() =>
      afterZoomLayout(w0).then(() => {
        if (!content || !line.isConnected) return;
        const z1 = currentZoomPercent() / 100;
        // 滚多少(CSS 像素):让 `top × z1` 回到 `y0`。
        content.scrollTop += btn.getBoundingClientRect().top - y0 / z1;
        keepRowInView(line, content);
        // 到头那枚变灰了,焦点别丢在一枚禁用的钮上:落到同一行还能按的那枚。
        if (btn.disabled) (btn === plus ? minus : plus).focus();
      }),
    );
  };
  minus.addEventListener("click", () => step(minus, zoomOut));
  plus.addEventListener("click", () => step(plus, zoomIn));
  reset.addEventListener("click", () => step(reset, zoomReset));
  // 键盘 / 滚轮 / 这三个按钮任一改了字号,都回来刷新这一行(单一真相源)。
  onZoomChange(paint);

  const ctrls = document.createElement("div");
  ctrls.className = "zoom-ctrls";
  ctrls.append(minus, val, plus, reset);
  line.append(ctrls, desc); // 623:单行组不写行名(见 buildPane 头上那条)
  return line;
}

/** 等缩放落到版面上:WebView 换了倍数之后视口的 CSS 宽跟着变(`setZoom` 的 promise 回来时未必已经变了),
 *  逐帧看 `innerWidth` 离开点之前那个值再量。倍数没变(复位时本来就是 100%)就等满一小会儿收手。 */
function afterZoomLayout(w0: number): Promise<void> {
  const until = performance.now() + 500;
  return new Promise((done) => {
    const tick = (): void => {
      if (window.innerWidth !== w0 || performance.now() > until) requestAnimationFrame(() => done());
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** 整行都在右栏的可视区里(上下都不被切);放不下时顶对齐。 */
function keepRowInView(row: HTMLElement, content: HTMLElement): void {
  const r = row.getBoundingClientRect();
  const c = content.getBoundingClientRect();
  if (r.top < c.top) content.scrollTop -= c.top - r.top;
  else if (r.bottom > c.bottom) content.scrollTop += Math.min(r.bottom - c.bottom, r.top - c.top);
}

function buildRow(row: { which: Which; name: string; desc: string }): HTMLDivElement {
  const wrap = document.createElement("div");
  const line = document.createElement("div");
  line.className = "hkset-row";

  const keys = document.createElement("div");
  keys.className = "hkset-keys";
  const combo = el("span", "hkset-combo", hotkeys[row.which]);
  const change = el("button", "hkset-change", t("settings.change")) as HTMLButtonElement;
  // 被别的程序占着、按了没反应的那枚(W4 A6 / Q8 ①):此前照常陈列,看不出它根本没生效。
  // 改键成功(`applyHotkey` 换进新回执)就收。
  // 165 / W5 A40:同随记页顶那条,前面带错误那枚「!」圆(err.css `.err-msg::before`),不单靠红字。
  const dead = el("span", "hkset-dead err-msg", t("settings.hotkeyTakenTag"));
  dead.dataset.which = row.which; // e2e 按它认是哪一枚
  keys.append(dead, combo, change);
  const paintDead = (): void => {
    dead.hidden = !hotkeys[row.which === "capture" ? "capture_taken" : "notebook_taken"];
  };
  paintDead();

  line.append(el("div", "hkset-name", row.name), el("div", "hkset-desc", row.desc), keys);

  const msg = el("p", "hkset-msg", "");
  change.addEventListener("click", () => startRecording(row, combo, msg, paintDead));

  wrap.append(line, msg);
  return wrap;
}

function startRecording(
  row: { which: Which; name: string },
  combo: HTMLElement,
  msg: HTMLElement,
  paintDead: () => void,
): void {
  const which = row.which;
  if (recording) stopRecording(); // 同一时刻只录一枚
  recording = which;
  combo.classList.add("recording");
  combo.textContent = t("settings.pressNewHotkey");
  setMsg(msg, "", "");

  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      finishRecording(combo);
      combo.textContent = hotkeys[which];
      return;
    }
    if (isModifierKey(e.code)) return; // 光按修饰键 → 继续等一个主键
    const mods = modTokens(e);
    if (mods.length === 0) {
      setMsg(msg, t("settings.needModifier"), "err");
      return;
    }
    const key = keyToken(e.code);
    if (!key) {
      setMsg(msg, t("settings.keyUnsupported"), "err");
      return;
    }
    finishRecording(combo);
    void applyHotkey(row, [...mods, key].join("+"), combo, msg, paintDead);
  };
  // window 捕获相:抢在视图自己的单键派发(hotkey-menu 的 E/C/L…)之前吃掉按键。
  recordCleanup = () => window.removeEventListener("keydown", onKey, true);
  window.addEventListener("keydown", onKey, true);
}

function finishRecording(combo: HTMLElement): void {
  stopRecording();
  combo.classList.remove("recording");
}

function stopRecording(): void {
  recordCleanup?.();
  recordCleanup = null;
  recording = null;
}

async function applyHotkey(
  row: { which: Which; name: string },
  accel: string,
  combo: HTMLElement,
  msg: HTMLElement,
  paintDead: () => void,
): Promise<void> {
  const which = row.which;
  combo.textContent = "…";
  try {
    const hk = await invoke<Hotkeys>("set_hotkey", { which, accel });
    hotkeys = hk;
    setHotkeys(hk); // 随记页顶那条「点此改键」、空态那句跟着变(hotkey-state.ts)
    combo.textContent = hk[which];
    paintDead();
    setMsg(msg, t("settings.hotkeyUpdated"), "ok");
  } catch (e) {
    // 后端什么都没动(只碰改的这一枚,失败即原样;A2),回显旧值。被占着的那一格说清是哪一枚、
    // 为什么 —— 此前一律「这个快捷键可能被别的程序占用了」,而真正失败的常是另一枚没动的键。
    combo.textContent = hotkeys[which];
    setMsg(msg, String(e) === HOTKEY_TAKEN ? t("settings.hotkeyTaken", { name: row.name, key: accel }) : errText(e), "err");
  }
}

// ---- 键位映射 ----

function isModifierKey(code: string): boolean {
  return /^(Control|Alt|Shift|Meta|OS)(Left|Right)$/.test(code) || code === "CapsLock";
}

function modTokens(e: KeyboardEvent): string[] {
  const m: string[] = [];
  if (e.ctrlKey) m.push("Ctrl");
  if (e.metaKey) m.push(IS_MAC ? "Cmd" : "Super");
  if (e.altKey) m.push("Alt");
  if (e.shiftKey) m.push("Shift");
  return m;
}

// e.code → 加速键 token(后端 global_hotkey 大写后解析:KEYN/DIGIT1/F5/ARROWUP…全接受)。
// 字母/数字取干净单字符,功能键与方向键给友好名,常见符号键回落到 code,其余不支持。
function keyToken(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  switch (code) {
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Space":
    case "Enter":
    case "Tab":
    case "Backquote":
    case "Minus":
    case "Equal":
    case "BracketLeft":
    case "BracketRight":
    case "Backslash":
    case "Semicolon":
    case "Quote":
    case "Comma":
    case "Period":
    case "Slash":
      return code;
    default:
      return null;
  }
}

// ---- 小工具 ----

function el(tag: string, cls: string, text: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}

function setMsg(msg: HTMLElement, text: string, kind: "ok" | "err" | ""): void {
  msg.textContent = text;
  msg.className = "hkset-msg" + (kind ? " " + kind : "");
}
