// 设置面板(232):目前只管全局热键——用户可改捕获窗 / 主窗两枚键,解决「热键被别的
// 程序占用后就没法用」。侧栏底部「设置」入口点开;录制态里按下的组合(要求带修饰键)
// 转成加速键串交给后端 set_hotkey(注销旧+注册新+存盘+刷托盘)。纯设备本地、不进同步。
import { invoke } from "@tauri-apps/api/core";
import "./settings.css";

type Hotkeys = { capture: string; notebook: string };
type Which = "capture" | "notebook";

const ROWS: { which: Which; name: string; desc: string }[] = [
  { which: "capture", name: "捕获窗", desc: "从任何地方弹出快速记录窗" },
  { which: "notebook", name: "主窗", desc: "从任何地方唤起朱简主窗口" },
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
    el("h2", "settings-title", "设置"),
    el("p", "settings-sub", "全局快捷键——在任何程序里都能唤起朱简。若和别的软件撞了用不了,在这里换一个。"),
  );
  for (const row of ROWS) panel.appendChild(buildRow(row));
  panel.appendChild(
    el(
      "p",
      "settings-foot",
      IS_MAC
        ? "点「更改」后,按住 Cmd / Ctrl / Option 等修饰键再按一个字母或数字;Esc 取消。"
        : "点「更改」后,按住 Ctrl / Alt / Shift 等修饰键再按一个字母或数字;Esc 取消。",
    ),
  );
}

function buildRow(row: { which: Which; name: string; desc: string }): HTMLDivElement {
  const wrap = document.createElement("div");
  const line = document.createElement("div");
  line.className = "hk-row";

  const keys = document.createElement("div");
  keys.className = "hk-keys";
  const combo = el("span", "hk-combo", hotkeys[row.which]);
  const change = el("button", "hk-change", "更改") as HTMLButtonElement;
  keys.append(combo, change);

  line.append(el("div", "hk-name", row.name), el("div", "hk-desc", row.desc), keys);

  const msg = el("p", "hk-msg", "");
  change.addEventListener("click", () => startRecording(row.which, combo, msg));

  wrap.append(line, msg);
  return wrap;
}

function startRecording(which: Which, combo: HTMLElement, msg: HTMLElement): void {
  if (recording) stopRecording(); // 同一时刻只录一枚
  recording = which;
  combo.classList.add("recording");
  combo.textContent = "按下新快捷键…";
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
      setMsg(msg, "要按住至少一个修饰键(Ctrl / Alt …)", "err");
      return;
    }
    const key = keyToken(e.code);
    if (!key) {
      setMsg(msg, "这个键不支持,换一个", "err");
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
    setMsg(msg, "已更新,立即生效", "ok");
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
  msg.className = "hk-msg" + (kind ? " " + kind : "");
}
