import { invoke, mirrorSpace, spaceLabel, listSpaces, dotClass, MAIN_SPACE } from "./space";
import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { openLightboxUrl, pendingImages } from "./item-images";
import { saveTextDraft, loadTextDraft, clearTextDraft } from "./compose-draft";
import { createCaptureCommands } from "./capture-commands";
import { initTheme } from "./theme-mode";

const input = document.getElementById("capture") as HTMLTextAreaElement;
const slip = document.querySelector(".slip") as HTMLElement;
const imagesBar = document.getElementById("cap-images") as HTMLElement;
const errLine = document.getElementById("cap-err") as HTMLElement;
const spaceTag = document.getElementById("cap-space") as HTMLElement;
const modsBar = document.getElementById("cap-mods") as HTMLElement;
const hotkeyBar = document.getElementById("cap-hotkey") as HTMLElement;
const cmdPanel = document.getElementById("cap-cmd") as HTMLElement;
const spacesPanel = document.getElementById("cap-spaces") as HTMLElement;
const appWindow = getCurrentWindow();

// 捕获目标空间(工序 8,§9「目标可见」/§16.2 提案 B):壳侧 ForegroundSpace 的
// 影子,只用于**显示**;保存那刻才 mirrorSpace 锁进 invoke 注入层——保存期间它
// 若再变(notebook 并发切空间),后端复核「目标已变」响亮拒、草稿保留,绝不改写
// 目标。切换入口刻意不放捕获窗(要换空间去 notebook 切,克制:浮窗只做记录)。
//
// 启动时序(codex 工序 7/8 M5):**先 await 装好 listener、再查快照**,且事件一到
// 就以事件为准(sawEvent)——否则 notebook 恢复上次空间的 "space-foreground" 可能
// 在 listener 就位前发出,capture 永久停在 main、保存每次被「目标已变」拒。
let targetSpace = MAIN_SPACE;
let targetNames: Record<string, string | null> = {};
let sawForegroundEvent = false;

function renderSpaceTag(): void {
  // 单空间落点无歧义,徽章是纯噪音 → 只在 ≥2 空间时亮(名字表空 = 壳未就绪/查询
  // 失败,同样按单空间藏——宁缺勿错)。显隐改变浮窗自然高度,重新量窗。
  const multi = Object.keys(targetNames).length >= 2;
  spaceTag.hidden = !multi;
  if (multi) {
    spaceTag.textContent = spaceLabel({ id: targetSpace, name: targetNames[targetSpace] ?? null });
  }
  void fitWindow();
}

async function refreshSpaceNames(): Promise<void> {
  try {
    const all = await listSpaces();
    targetNames = Object.fromEntries(all.map((s) => [s.id, s.name]));
  } catch {
    // 壳还没就绪:名字表空着,先显缺省人话。
  }
  renderSpaceTag();
}

async function initSpaceTag(): Promise<void> {
  await listen<string>("space-foreground", (e) => {
    sawForegroundEvent = true;
    targetSpace = e.payload;
    void refreshSpaceNames(); // 顺带刷新名字表(改名/新建后标签不腐)。
  });
  // 空间名变了(本地改名 / 远端改名落地 / 引导落名;space-name-sync-plan §4.7):
  // 徽章只靠 space-foreground 顺带刷会漏「没切空间只改名」的一切路径。
  await listen("space-name-changed", () => {
    void refreshSpaceNames();
  });
  try {
    const fg = await rawInvoke<string>("get_foreground_space");
    // 查询期间事件已到 = 事件更新(它是壳广播的最新态),快照作废。
    if (!sawForegroundEvent) targetSpace = fg;
  } catch {
    // 壳还没就绪(启动竞速):保持 main;随后的事件会对齐。
  }
  await refreshSpaceNames();
}
void initSpaceTag();

// ---- 全局热键冲突提示条(232 起撞键不崩,此处告知用户)-------------------------
// 启动时某枚全局热键被别的程序占用会注册失败(壳把失效键记进 HotkeyConflicts)。捕获窗
// 是启动唯一可见的窗,在这里挂一条非模态提示条:「点此改键」直达主窗设置面板去换键。
// 用户按 × 收起后本会话不再出现(捕获窗隐藏不销毁,dismiss 稳);改好键后壳清空冲突,
// 下次唤起(onFocusChanged 复查)自然消失。
let hotkeyDismissed = false;
function renderHotkeyBar(conflicts: string[]): void {
  hotkeyBar.replaceChildren();
  if (hotkeyDismissed || conflicts.length === 0) {
    hotkeyBar.hidden = true;
    void fitWindow();
    return;
  }
  const fix = document.createElement("button");
  fix.type = "button";
  fix.className = "hk-fix";
  fix.textContent = `⚠ 快捷键 ${conflicts.join("、")} 被占用,点此改键`;
  fix.addEventListener("click", () => {
    void rawInvoke("open_settings");
    void appWindow.hide(); // 让位给主窗设置面板(草稿原样留着,同 Esc 收窗)
  });
  const x = document.createElement("span");
  x.className = "hk-x";
  x.textContent = "×";
  x.title = "知道了";
  x.addEventListener("click", () => {
    hotkeyDismissed = true;
    renderHotkeyBar([]);
  });
  hotkeyBar.append(fix, x);
  hotkeyBar.hidden = false;
  void fitWindow();
}
async function refreshHotkeyBar(): Promise<void> {
  if (hotkeyDismissed) return; // 收起后不再打扰(会话级)
  try {
    renderHotkeyBar(await rawInvoke<string[]>("hotkey_conflicts"));
  } catch {
    // 壳未就绪 / 无此命令(不该发生):静默,不拦记录。
  }
}
void refreshHotkeyBar();

// ---- 本次捕获的修饰(模式 + 标签)+ 空间选择器 + 斜杠命令 -----------------------
// 捕获默认存成想法;/task 把本次转任务(存看板)、/tag 给本次挂标签、/space 换落点
// 空间。修饰是「本条」状态,存完即结算回想法;和文字/图草稿一样断电可恢复(念头别丢)。
type CaptureMode = "idea" | "task";
let captureMode: CaptureMode = "idea";
let captureTags: string[] = []; // 标签名(存 title,存那刻才 resolve/建 topic,弃稿不留孤儿)

// 修饰草稿(纯设备本地 UI 状态,不进 DB / 同步;与 compose-draft 同体感,单列小键)。
const MODS_KEY = "zhujian.capture-mods";
function saveMods(): void {
  if (captureMode === "idea" && captureTags.length === 0) {
    localStorage.removeItem(MODS_KEY);
    return;
  }
  try {
    localStorage.setItem(MODS_KEY, JSON.stringify({ mode: captureMode, tags: captureTags }));
  } catch {
    // 持久化尽力而为,不拦输入。
  }
}
function loadMods(): void {
  const raw = localStorage.getItem(MODS_KEY);
  if (!raw) return;
  try {
    const v = JSON.parse(raw) as { mode?: string; tags?: unknown };
    captureMode = v.mode === "task" ? "task" : "idea";
    captureTags = Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [];
  } catch {
    // 坏 JSON:当没有修饰。
  }
}
function resetMods(): void {
  captureMode = "idea";
  captureTags = [];
  saveMods();
  renderMods();
}
function chipX(title: string, onClick: () => void): HTMLSpanElement {
  const x = document.createElement("span");
  x.className = "x";
  x.textContent = "×";
  x.title = title;
  x.addEventListener("click", onClick);
  return x;
}
function renderMods(): void {
  modsBar.replaceChildren();
  if (captureMode === "task") {
    const chip = document.createElement("span");
    chip.className = "cap-chip mode";
    const label = document.createElement("span");
    label.textContent = "任务";
    chip.append(
      label,
      chipX("改回想法", () => {
        captureMode = "idea";
        saveMods();
        renderMods();
        void fitWindow();
        input.focus();
      }),
    );
    modsBar.appendChild(chip);
  }
  for (const t of captureTags) {
    const chip = document.createElement("span");
    chip.className = "cap-chip";
    const label = document.createElement("span");
    label.textContent = "#" + t;
    chip.append(
      label,
      chipX("移除标签", () => {
        captureTags = captureTags.filter((g) => g !== t);
        saveMods();
        renderMods();
        void fitWindow();
        input.focus();
      }),
    );
    modsBar.appendChild(chip);
  }
}

// 标签名 → topic id:list_topics 复用同名,缺则 create_topic(存那刻才建,弃稿不留孤儿)。
type TopicItem = { id: string; title: string };
async function resolveTags(titles: string[]): Promise<string[]> {
  const all = await invoke<TopicItem[]>("list_topics");
  const byTitle = new Map(all.map((t) => [t.title, t.id]));
  const ids: string[] = [];
  for (const t of titles) {
    let tid = byTitle.get(t);
    if (!tid) {
      tid = await invoke<string>("create_topic", { title: t });
      byTitle.set(t, tid);
    }
    ids.push(tid);
  }
  return ids;
}

// 空间选择器(方案 B:切壳侧前台空间 → 广播 space-foreground → 本窗 targetSpace 更新、
// notebook 连带切)。徽章点击 + /space 命令共用这一个入口;单空间无从切,不开。
let spacePickerOpen = false;
async function openSpacePicker(): Promise<void> {
  if (spacePickerOpen) {
    closeSpacePicker();
    return;
  }
  const alive = (await listSpaces()).filter((s) => s.alive);
  if (alive.length < 2) return;
  spacesPanel.replaceChildren();
  for (const s of alive) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "space-pick-row";
    const dot = document.createElement("span");
    dot.className = `sync-dot ${dotClass(s.status)}`;
    const name = document.createElement("span");
    name.textContent = spaceLabel(s);
    row.append(dot, name);
    if (s.id === targetSpace) {
      const cur = document.createElement("span");
      cur.className = "cur";
      cur.textContent = "✓";
      row.append(cur);
    }
    row.addEventListener("click", () => {
      closeSpacePicker();
      void pickSpace(s.id);
    });
    spacesPanel.appendChild(row);
  }
  spacesPanel.hidden = false;
  spacePickerOpen = true;
  void fitWindow();
  input.focus();
}
function closeSpacePicker(): void {
  spacesPanel.hidden = true;
  spacesPanel.replaceChildren();
  spacePickerOpen = false;
  void fitWindow();
  input.focus();
}
async function pickSpace(id: string): Promise<void> {
  // 只切壳侧前台空间;本窗 targetSpace 由随后的 space-foreground 广播更新(见 initSpaceTag)。
  try {
    await rawInvoke("set_foreground_space", { spaceId: id });
  } catch (e) {
    console.error("set_foreground_space:", e);
  }
}
spaceTag.addEventListener("click", () => void openSpacePicker());

const cmd = createCaptureCommands({
  input,
  panel: cmdPanel,
  commands: [
    {
      id: "space",
      label: "切换空间",
      hint: "换个本子记",
      takesArg: false,
      enabled: () => Object.keys(targetNames).length >= 2,
    },
    { id: "task", label: "记为任务", hint: "存进看板而非灵感", takesArg: false },
    { id: "tag", label: "打标签", hint: "/tag 家庭", takesArg: true },
  ],
  onExec: (id, arg) => {
    if (id === "space") {
      void openSpacePicker();
    } else if (id === "task") {
      captureMode = "task";
      saveMods();
      renderMods();
    } else if (id === "tag") {
      const name = arg.trim();
      if (name && !captureTags.includes(name)) captureTags.push(name);
      saveMods();
      renderMods();
    }
    persistCaptureText();
    void fitWindow();
  },
});

// The slip is a fixed 560px-wide floating window, but its HEIGHT grows with content so
// multi-line text + a pasted-image preview strip aren't crammed into one short box. The
// textarea auto-grows to its content (down to a one-line floor), the slip wraps it + the
// strip + the error line, and the window is sized to the slip — clamped so a huge paste /
// long text can't fill the screen (past the cap the textarea scrolls inside).
const WIN_W = 560;
const MIN_H = 110; // floor; one comfortable line is naturally ~114, so it rarely clamps
const MAX_H = 460;
const BODY_PAD_V = 16 + 26; // body padding: top + bottom (see index.html)

// The compact box's current height, remembered so the preview-lightbox can restore it after
// temporarily growing the window to show an image near full size.
let lastH = MIN_H;

// Grow the textarea to fit its text (CSS min-height keeps a comfortable single-line box).
function autoGrowInput(): void {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

async function fitWindow(): Promise<void> {
  autoGrowInput();
  const maxSlip = MAX_H - BODY_PAD_V;
  if (slip.offsetHeight > maxSlip) {
    // Capped: shrink the textarea so the whole slip fits MAX_H, and let it scroll inside.
    const others = slip.offsetHeight - input.offsetHeight; // strip + error line
    input.style.height = `${Math.max(0, maxSlip - others)}px`;
    input.style.overflowY = "auto";
  } else {
    input.style.overflowY = "hidden";
  }
  const h = Math.max(MIN_H, Math.min(MAX_H, slip.offsetHeight + BODY_PAD_V));
  lastH = h;
  try {
    await appWindow.setSize(new LogicalSize(WIN_W, h));
  } catch {
    // setSize needs core:window:allow-set-size + an app restart to take effect; until then
    // the window keeps its fixed height (content scrolls) rather than crashing.
  }
}

// Click a pasted preview → show a lightbox, growing the capture window so the image is near
// its real size (capped to ~92% of the monitor); restore the compact box on close.
//
// 无闪时序全交给 openLightboxUrl(与已保存图的 openLightbox 同纪律,163 续案):它先在暗遮罩
// 下放大(apply)、等 viewport 真落定再让图一次成形亮相,关闭时(遮罩仍覆盖)先等放大跑完再
// 缩回(restore)——本函数只提供「怎么放大 / 怎么缩回」两个钩子,放大/关闭的编排不再自管。
function openPreviewLarge(url: string, naturalW: number, naturalH: number): void {
  const shrink = async (): Promise<void> => {
    try {
      await appWindow.setSize(new LogicalSize(WIN_W, lastH));
      await appWindow.center();
    } catch {
      /* nothing to restore if the grow didn't happen */
    }
  };
  const growWindow = async (): Promise<void> => {
    let maxW = 1280;
    let maxH = 880;
    try {
      const mon = await currentMonitor();
      if (mon) {
        const sf = mon.scaleFactor || 1;
        maxW = Math.floor((mon.size.width / sf) * 0.92);
        maxH = Math.floor((mon.size.height / sf) * 0.92);
      }
    } catch {
      // no monitor info — fall back to the generous fixed cap
    }
    const PAD = 56; // lightbox padding + a little breathing room
    const w = Math.max(420, Math.min((naturalW || 600) + PAD, maxW));
    const h = Math.max(320, Math.min((naturalH || 400) + PAD, maxH));
    await appWindow.setSize(new LogicalSize(w, h));
    await appWindow.center();
  };
  openLightboxUrl(url, "预览", { grow: { apply: growWindow, restore: shrink } });
}

// Images pasted while composing, held in memory until save — the shared pendingImages
// controller (item-images.ts, 同灵感/看板的新建输入框). Capture creates the item (and its
// id) only on Enter, so the images ride along and get attached right after capture_note
// returns the new id. onChange re-fits the window as previews come and go; clicking a
// preview goes through openPreviewLarge so the WINDOW grows with the lightbox.
const pend = pendingImages({
  // A stale save-error shouldn't linger once the previews change (matches the old paste
  // handler); the failure message from attachAll is set AFTER it resolves, so it survives.
  onChange: () => {
    errLine.textContent = "";
    void fitWindow();
  },
  openPreview: (url, w, h) => void openPreviewLarge(url, w, h),
  // 断电恢复(198 桌面侧):暂存图落 IndexedDB,重开回填。捕获浮窗不分空间(落点在按
  // 回车那刻定),文字草稿见下方 CAPTURE_DRAFT_KEY。
  persistKey: "zhujian.capture-images",
});
imagesBar.replaceChildren(pend.root);
pend.wire(input);

// compose 文字草稿断电恢复:输入即写 localStorage、记下/dismiss 清、启动回填(见 compose-draft.ts)。
// 捕获浮窗落点在回车那刻才定,草稿不分空间(space 恒 null)。程序改值处(记下清空、dismiss)
// 显式补调 persistCaptureText——input.value 赋值不触发 input 事件,不补调就与磁盘脱节。
const CAPTURE_DRAFT_KEY = "zhujian.capture-draft";
function persistCaptureText(): void {
  saveTextDraft(CAPTURE_DRAFT_KEY, { text: input.value, space: null });
}

// Grow/shrink the window as the text wraps to more / fewer lines; persist the draft live.
input.addEventListener("input", () => {
  persistCaptureText();
  cmd.refresh(); // 首行以 / 起且有匹配时亮命令面板(非承诺式,见 capture-commands)
  void fitWindow();
});

// 启动回填:上次没记下的文字 + 暂存图(意外断电 / 杀进程后重开还在)。文字同步灌回、
// 量窗;图走 IndexedDB 异步回填(填好经 onChange 再量一次窗)。
loadMods();
renderMods(); // 上次没记下的模式/标签 chip(意外断电 / 杀进程后重开还在)
const captureDraft = loadTextDraft(CAPTURE_DRAFT_KEY);
if (captureDraft && captureDraft.text) input.value = captureDraft.text;
void fitWindow();
void pend.restore();

// 明暗三档(250):首帧定色已由 index.html 头里的内联脚本做掉,这里接上「自动」档跟随
// 系统变化 + 主窗改档时的跨窗广播(捕获窗自己没有开关,只跟)。
initTheme();

// Capture-first: Enter saves, Shift+Enter is a newline, Esc hides but KEEPS the draft.
// in-flight 闸(ui-audit P0 #2):capture_note 往返窗口里第二记 Enter 会用同一内容再建
// 一条重复灵感——保存中直接让位(同编辑态的 saving 闸)。
let capSaving = false;
input.addEventListener("keydown", async (e) => {
  // IME 组合期的按键是给输入法的(选字/上屏),不是给我们的——放行会把半打的拼音
  // 当正文存库、或把上屏那记 Enter 当保存(ui-audit P0 #1)。
  if (e.isComposing) return;
  // 斜杠命令面板开着时先吃键(↑↓ 选、Enter/Tab 执行、Esc 关面板)——绝不让 Enter 直接
  // 保存、Esc 直接收窗。面板没开返回 false,照旧走下面的保存/收窗。
  if (cmd.handleKey(e)) {
    void fitWindow(); // Esc 关面板 / 执行后正文变短 → 缩回窗口
    return;
  }
  // 空间选择器开着时 Esc 只关它(不收窗)。
  if (e.key === "Escape" && spacePickerOpen) {
    e.preventDefault();
    closeSpacePicker();
    return;
  }
  // While a preview lightbox is open it owns Esc (close it, don't dismiss/save the capture).
  if (document.querySelector(".img-lightbox")) return;
  if (e.key === "Escape") {
    e.preventDefault();
    // Esc 收窗**保稿**:文字与暂存图原样留着,下次 Ctrl+Alt+N 唤起接着写——半打的
    // 念头不因随手一按而丢(「数据永不丢」的体感延伸)。清空只发生在存完(dismiss);
    // 真不要这段草稿,删掉字再关就是。错误行不属于稿,过时了,收窗顺手清。
    errLine.textContent = "";
    await appWindow.hide();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (capSaving) return;
    const content = input.value.trim();
    // Nothing to save (no text AND no image) → just close.
    if (content.length === 0 && pend.count() === 0) {
      await dismiss();
      return;
    }

    capSaving = true;
    try {
      // 落库目标 = 按下回车这一刻看到的空间(§16.2 提案 B):锁进 invoke 注入层,
      // 本次保存(建条目 + attachAll 附图)全程用它——期间 notebook 并发切空间,
      // capture_note 会被后端「目标已变」响亮拒(草稿保留);已建成再切,附图仍
      // 注入同一空间,绝不把图挂进别的空间。
      mirrorSpace(targetSpace);

      // 「按下回车那刻」冻结图批(codex 三审 M):IPC 等待期间新粘贴的图属于下一条,
      // 不结算进这条。Create the note first to get its id. On failure put the batch back
      // and keep the text so the user can retry (don't pretend it saved).
      // 冻结本次形态(与图批同理):IPC 等待期间改模式/标签属于下一条,不算进这条。
      const mode = captureMode;
      const tags = captureTags.slice();
      const batch = pend.takeBatch();
      let id: string;
      try {
        // /task 走 create_task(存看板),否则 capture_note(存灵感);两者都带前台空间守卫,
        // 保存往返里空间切走会响亮拒(草稿保留)。
        id =
          mode === "task"
            ? await invoke<string>("create_task", {
                title: content,
                dueOn: null,
                priority: null,
                topicId: null,
              })
            : await invoke<string>("capture_note", { content });
      } catch (err) {
        pend.putBack(batch);
        errLine.textContent = String(err);
        void fitWindow();
        return;
      }
      // The note is now saved — clear the text so a re-Enter can't create a duplicate.
      input.value = "";
      persistCaptureText(); // 落库成功即清磁盘草稿(空文字 → 清键;剩下的暂存图属下一条,自留)
      resetMods(); // 模式/标签随本条结算,下一条从想法起(chip 清空)

      // 挂标签:标签名 → id(复用同名 / 缺则建),想法走 file_note_to_topic(加法建链)、
      // 任务走 add_task_topic。失败不假装成功、也不吞图批——记一句提示,继续附图。
      let tagWarn = "";
      if (tags.length > 0) {
        try {
          const ids = await resolveTags(tags);
          for (const tid of ids) {
            if (mode === "task") await invoke("add_task_topic", { id, topicId: tid });
            else await invoke("file_note_to_topic", { id, topicId: tid, newTitle: null });
          }
        } catch (err) {
          tagWarn = ` 部分标签未挂上(${String(err)})`;
        }
      }

      // Attach the frozen batch to the new note. A failed attach is surfaced (fail-fast, not
      // swallowed): the note is already saved, so keep the window open with a note that the
      // image didn't stick — the user can re-paste it on the idea card.
      const kind = mode === "task" ? "任务" : "灵感";
      const failed = await pend.attachBatch(id, batch);
      if (failed > 0) {
        errLine.textContent = `${kind}已保存,但 ${failed} 张图未能附加(可在卡片里重新粘贴)${tagWarn}`;
        void fitWindow();
        return; // stay open so the message is seen; text already cleared (no duplicate)
      }
      if (tagWarn) {
        errLine.textContent = `${kind}已保存,但${tagWarn.trim()}`;
        void fitWindow();
        return; // 留窗让提示被看到;正文已清,不会重复
      }
      if (pend.count() > 0) {
        // 保存等待期间又粘了图:它们属于下一条,不许被 dismiss 的 clear 连坐(codex
        // 四审 H)——留窗接着写,正文已清、图在预览区。
        errLine.textContent = "";
        void fitWindow();
        return;
      }
      await dismiss();
    } finally {
      capSaving = false;
    }
  }
});

async function dismiss(): Promise<void> {
  input.value = "";
  errLine.textContent = "";
  clearTextDraft(CAPTURE_DRAFT_KEY); // 稿了结:清磁盘(pend.clear() 自会清图存)
  pend.clear();
  resetMods(); // 修饰(模式/标签)随稿了结一并清
  await appWindow.hide();
}

// Re-focus the field every time the window is shown again, and re-fit (a fresh blank capture
// snaps back to the compact MIN_H after a previous tall session).
appWindow.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    input.focus();
    // 顺带刷新空间名字表:新建第二个空间不一定伴随前台切换事件,唤起浮窗这一刻
    // 对齐(徽章该出现就出现、改名不腐)。
    void refreshSpaceNames();
    // 热键冲突也复查:去设置改好键后壳已清空冲突,这次唤起提示条自然消失。
    void refreshHotkeyBar();
    void fitWindow();
  }
});
