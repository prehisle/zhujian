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
import { reminderCfg, saveReminderCfg, reminderPermissionOk, sendTestNotification } from "./reminder";
import { currentZoomPercent, zoomIn, zoomOut, zoomReset, onZoomChange } from "./zoom";
import { currentThemeMode, setThemeMode, type ThemeMode } from "./theme-mode";
import { currentLangChoice, setLangChoice, t, type LangChoice } from "./i18n";
import { currentSpaceId } from "./space";
import "./settings.css";

type Hotkeys = { capture: string; notebook: string };
type Which = "capture" | "notebook";
/** 左栏那三类。⛔ **别加第四类**:判据在 backlog 用户面 27 —— 我们统共 4 个小节,
 *  3 个只有一两行,分细了是另一种难看(参考的那个产品有 8 类是因为它真有那么多东西)。 */
export type SettingsCat = "general" | "hotkeys" | "backup";
/** lib.rs `device_identity` 的镜像。别名**进同步**(与热键/明暗/字号刻意不同)。 */
type DeviceIdentity = { this_device: string; devices: { device_id: string; alias: string | null }[] };

const ROWS: { which: Which; name: string; desc: string }[] = [
  { which: "capture", name: t("settings.captureWin"), desc: t("settings.captureWinDesc") },
  { which: "notebook", name: t("settings.notebookWin"), desc: t("settings.notebookWinDesc") },
];

// mac 上 metaKey = Cmd(显示与解析都用 Cmd);其它平台 metaKey = Win 键 → Super。
const IS_MAC = navigator.userAgent.includes("Mac");

let overlay: HTMLDivElement | null = null;
let hotkeys: Hotkeys = { capture: "", notebook: "" };
let recording: Which | null = null;
let recordCleanup: (() => void) | null = null;

export function initSettings(): void {
  const entry = document.getElementById("settings-entry");
  if (!entry) throw new Error("侧栏缺 #settings-entry(notebook.html 漂移?)");
  entry.addEventListener("click", () => void openSettingsPanel());
}

/**
 * 弹出设置面板。侧栏「设置」入口 + 捕获窗热键冲突提示条「点此改键」(经壳 open-settings 事件)共用。
 *
 * ⭐ **`cat` 不是可有可无的装饰**:445 分类之后,「点此改键」那条路若落在默认的「通用」上,
 * 用户点了「改键」却看不见热键行 —— 那条提示条的全部意义就没了。故那条路显式传 "hotkeys"。
 */
export async function openSettingsPanel(cat: SettingsCat = "general"): Promise<void> {
  if (overlay) return;
  hotkeys = await invoke<Hotkeys>("get_hotkeys");
  overlay = document.createElement("div");
  overlay.className = "settings-overlay";
  overlay.addEventListener("mousedown", (e) => {
    // 录制途中点外面不关(避免误关吞掉录制),先取消录制交互再说。
    if (e.target === overlay && !recording) closePanel();
  });
  const panel = document.createElement("div");
  panel.className = "settings-panel";
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onPanelEsc);
  renderPanel(panel, cat);
}

function closePanel(): void {
  stopRecording();
  // 仪式还开着就让后端丢掉那把**只在内存里**的备份钥(§3.4.1 第 11 格:关面板即清)。
  closeBackupSection();
  onZoomChange(null); // 摘掉字号回调,别对已卸载的面板 DOM 悬空引用
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onPanelEsc);
}

function onPanelEsc(e: KeyboardEvent): void {
  // 录制态的 Esc 被录制监听(window 捕获相)先吞掉(取消录制);非录制态 Esc 关面板。
  if (e.key === "Escape" && !recording) {
    e.stopPropagation();
    closePanel();
  }
}

const CATS: { cat: SettingsCat; label: string }[] = [
  { cat: "general", label: t("settings.catGeneral") },
  { cat: "hotkeys", label: t("settings.hotkeysTitle") },
  { cat: "backup", label: t("settings.catBackup") },
];

function renderPanel(panel: HTMLDivElement, initial: SettingsCat): void {
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

  // ⛔ **三类的内容一次全建好,切分类只切显隐 —— 别改成「点哪类才建哪类」**。
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
    buildPane(cat, pane);
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

  // 高亮与显隐的单一渲染点:按当前分类重画全部三枚,不在点击处各自 toggle(同 paintSeg)。
  function show(cat: SettingsCat): void {
    CATS.forEach(({ cat: c }, i) => {
      btns[i].classList.toggle("on", c === cat);
      const pane = panes.get(c);
      if (pane) pane.hidden = c !== cat;
    });
    content.scrollTop = 0; // 换一类从头看起,别把上一类滚到一半的位置带过来
  }
  show(initial);
}

function buildPane(cat: SettingsCat, pane: HTMLElement): void {
  if (cat === "hotkeys") {
    pane.append(
      el("h2", "settings-title settings-sect", t("settings.hotkeysTitle")),
      el("p", "settings-sub", t("settings.hotkeysIntro")),
    );
    for (const row of ROWS) pane.appendChild(buildRow(row));
    pane.appendChild(el("p", "settings-foot", IS_MAC ? t("settings.recordHintMac") : t("settings.recordHint")));
    return;
  }

  if (cat === "general") {
    pane.append(
      el("h2", "settings-title settings-sect", t("settings.appearance")),
      el("p", "settings-sub", t("settings.appearanceSub")),
      buildThemeRow(),

      el("h2", "settings-title settings-sect", t("settings.langTitle")),
      el("p", "settings-sub", t("settings.langSub")),
      buildLangRow(),

      el("h2", "settings-title settings-sect", t("settings.textSize")),
      el("p", "settings-sub", t("settings.textSizeSub")),
      buildZoomRow(),

      el("h2", "settings-title settings-sect", t("settings.aliasTitle")),
      el("p", "settings-sub", t("settings.aliasSub")),
      buildAliasRow(),

      el("h2", "settings-title settings-sect", t("reminder.title")),
      el("p", "settings-sub", t("reminder.sub")),
      buildReminderRow(),
    );
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
    buildBackupSection(),
  );
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
  const sub = el("div", "hkset-desc", t("common.loading"));

  // 本机 device_id 只有取回身份面之后才知道;取回前整行禁用,**不编造占位值**。
  let thisDevice: string | null = null;
  let saved = "";
  void invoke<DeviceIdentity>("device_identity", { spaceId: currentSpaceId() })
    .then((d) => {
      thisDevice = d.this_device;
      saved = d.devices.find((x) => x.device_id === d.this_device)?.alias ?? "";
      input.value = saved;
      // id 前 6 位当副标题:没起名时它是这台设备唯一能自证身份的东西(卡片上刻意
      // 不显 id 片段,设置面这里显——这里的语境是「这是哪台」,不是噪音)。
      sub.textContent = t("settings.thisDevice", { id: d.this_device.slice(0, 6) });
      input.disabled = false;
      save.disabled = false;
    })
    .catch((e) => setMsg(msg, String(e), "err"));

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
      setMsg(msg, next === "" ? t("settings.aliasCleared") : t("settings.aliasSaved"), "ok");
    } catch (e) {
      input.value = saved; // 后端拒了(超长等):回显旧值 + 后端原话
      setMsg(msg, String(e), "err");
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
    // Esc 在这里只放弃编辑、不关面板(面板级 Esc 监听在 document 上,这里先吞掉)。
    if (e.key === "Escape") {
      e.stopPropagation();
      input.value = saved;
      setMsg(msg, "", "");
    }
  });

  const ctrls = document.createElement("div");
  ctrls.className = "alias-ctrls";
  ctrls.append(input, save);
  line.append(el("div", "hkset-name", t("settings.aliasName")), sub, ctrls);

  const wrap = document.createElement("div");
  wrap.append(line, msg);
  return wrap as HTMLDivElement;
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
    onBtn.classList.toggle("on", cfg.on);
    offBtn.classList.toggle("on", !cfg.on);
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
      .catch((e) => setMsg(msg, String(e), "err"))
      .finally(() => {
        test.disabled = false;
      });
  });

  const ctrls = document.createElement("div");
  ctrls.className = "remind-ctrls";
  ctrls.append(seg, time, test);
  line.append(el("div", "hkset-name", t("reminder.rowName")), ctrls);

  const wrap = document.createElement("div");
  wrap.append(line, msg);
  return wrap as HTMLDivElement;
}

const THEME_CHOICES: { mode: ThemeMode; label: string }[] = [
  { mode: "auto", label: t("settings.themeAuto") },
  { mode: "light", label: t("settings.themeLight") },
  { mode: "dark", label: t("settings.themeDark") },
];

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
    btns.forEach((b, i) => b.classList.toggle("on", THEME_CHOICES[i].mode === now));
  };
  paintSeg();
  seg.append(...btns);

  line.append(el("div", "hkset-name", t("settings.themeName")), seg);
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
  line.className = "hkset-row zoom-row";

  const seg = document.createElement("div");
  seg.className = "seg";
  const btns = LANG_CHOICES.map(({ choice, label }) => {
    const b = el("button", "seg-btn", label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      void setLangChoice(choice).then(paintSeg); // 解析语言没变(auto↔同语言)时只刷高亮
    });
    return b;
  });
  const paintSeg = (): void => {
    const now = currentLangChoice();
    btns.forEach((b, i) => b.classList.toggle("on", LANG_CHOICES[i].choice === now));
  };
  paintSeg();
  seg.append(...btns);

  line.append(el("div", "hkset-name", t("settings.langTitle")), seg);
  return line;
}

function buildZoomRow(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "hkset-row zoom-row";

  const val = el("span", "zoom-val", `${currentZoomPercent()}%`);
  const minus = el("button", "zoom-btn", "−") as HTMLButtonElement;
  const plus = el("button", "zoom-btn", "＋") as HTMLButtonElement;
  const reset = el("button", "hkset-change", t("settings.zoomReset")) as HTMLButtonElement;

  minus.addEventListener("click", () => void zoomOut());
  plus.addEventListener("click", () => void zoomIn());
  reset.addEventListener("click", () => void zoomReset());
  // 键盘 / 滚轮 / 这三个按钮任一改了字号,都回来刷新这个百分比标签(单一真相源)。
  onZoomChange((p) => {
    val.textContent = `${p}%`;
  });

  const ctrls = document.createElement("div");
  ctrls.className = "zoom-ctrls";
  ctrls.append(minus, val, plus, reset);
  line.append(el("div", "hkset-name", t("settings.zoomName")), ctrls);
  return line;
}

function buildRow(row: { which: Which; name: string; desc: string }): HTMLDivElement {
  const wrap = document.createElement("div");
  const line = document.createElement("div");
  line.className = "hkset-row";

  const keys = document.createElement("div");
  keys.className = "hkset-keys";
  const combo = el("span", "hkset-combo", hotkeys[row.which]);
  const change = el("button", "hkset-change", t("settings.change")) as HTMLButtonElement;
  keys.append(combo, change);

  line.append(el("div", "hkset-name", row.name), el("div", "hkset-desc", row.desc), keys);

  const msg = el("p", "hkset-msg", "");
  change.addEventListener("click", () => startRecording(row.which, combo, msg));

  wrap.append(line, msg);
  return wrap;
}

function startRecording(which: Which, combo: HTMLElement, msg: HTMLElement): void {
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
    void applyHotkey(which, [...mods, key].join("+"), combo, msg);
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

async function applyHotkey(which: Which, accel: string, combo: HTMLElement, msg: HTMLElement): Promise<void> {
  combo.textContent = "…";
  try {
    const hk = await invoke<Hotkeys>("set_hotkey", { which, accel });
    hotkeys = hk;
    combo.textContent = hk[which];
    setMsg(msg, t("settings.hotkeyUpdated"), "ok");
  } catch (e) {
    // 后端已回滚到旧键(占用/无效等),回显旧值 + 后端原话。
    combo.textContent = hotkeys[which];
    setMsg(msg, String(e), "err");
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
