// 设置面板(232):全局热键 + 外观 + 语言 + 界面字号。热键——用户可改捕获窗 / 主窗两枚键,解决
// 「热键被别的程序占用后就没法用」;录制态里按下的组合(要求带修饰键)转成加速键串交给
// 后端 set_hotkey(注销旧+注册新+存盘+刷托盘)。外观(250)——明暗三档,自动 / 亮 / 暗。
// 语言(358)——自动 / 中文 / English,改档 reload 两窗。字号——整体缩放主窗。
// 侧栏底部「设置」入口点开。全部纯设备本地、不进同步。可见文案走字典(i18n-plan)。
import { invoke } from "@tauri-apps/api/core";
import { buildBackupSection, closeBackupSection } from "./backup";
import { currentZoomPercent, zoomIn, zoomOut, zoomReset, onZoomChange } from "./zoom";
import { currentThemeMode, setThemeMode, type ThemeMode } from "./theme-mode";
import { currentLangChoice, setLangChoice, t, type LangChoice } from "./i18n";
import { currentSpaceId } from "./space";
import "./settings.css";

type Hotkeys = { capture: string; notebook: string };
type Which = "capture" | "notebook";
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

/** 弹出设置面板。侧栏「设置」入口 + 捕获窗热键冲突提示条「点此改键」(经壳 open-settings 事件)共用。 */
export async function openSettingsPanel(): Promise<void> {
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
  renderPanel(panel);
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

function renderPanel(panel: HTMLDivElement): void {
  panel.innerHTML = "";
  panel.append(
    el("h2", "settings-title", t("settings.title")),
    el("p", "settings-sub", t("settings.hotkeysIntro")),
  );
  for (const row of ROWS) panel.appendChild(buildRow(row));
  panel.appendChild(el("p", "settings-foot", IS_MAC ? t("settings.recordHintMac") : t("settings.recordHint")));

  panel.append(
    el("h2", "settings-title settings-sect", t("settings.appearance")),
    el("p", "settings-sub", t("settings.appearanceSub")),
    buildThemeRow(),
  );

  panel.append(
    el("h2", "settings-title settings-sect", t("settings.langTitle")),
    el("p", "settings-sub", t("settings.langSub")),
    buildLangRow(),
  );

  panel.append(
    el("h2", "settings-title settings-sect", t("settings.textSize")),
    el("p", "settings-sub", t("settings.textSizeSub")),
    buildZoomRow(),
  );

  panel.append(
    el("h2", "settings-title settings-sect", t("settings.aliasTitle")),
    el("p", "settings-sub", t("settings.aliasSub")),
    buildAliasRow(),
  );

  // 备份(412,backup-plan 笔①-a):与上面几样一样是**每台机器自己的事**(钥与落点
  // 都在本机配置,不进 DB、不同步)。整节住 src/backup.ts —— 这里只挂标题与位置。
  panel.append(
    el("h2", "settings-title settings-sect", t("backup.title")),
    el("p", "settings-sub", t("backup.sub")),
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
