import { invoke, mirrorSpace, spaceLabel, listSpaces, MAIN_SPACE } from "./space";
import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { openLightboxUrl, pendingImages } from "./item-images";

const input = document.getElementById("capture") as HTMLTextAreaElement;
const slip = document.querySelector(".slip") as HTMLElement;
const imagesBar = document.getElementById("cap-images") as HTMLElement;
const errLine = document.getElementById("cap-err") as HTMLElement;
const spaceTag = document.getElementById("cap-space") as HTMLElement;
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
});
imagesBar.replaceChildren(pend.root);
pend.wire(input);

// Grow/shrink the window as the text wraps to more / fewer lines.
input.addEventListener("input", () => void fitWindow());

// Capture-first: Enter saves, Shift+Enter is a newline, Esc hides but KEEPS the draft.
// in-flight 闸(ui-audit P0 #2):capture_note 往返窗口里第二记 Enter 会用同一内容再建
// 一条重复灵感——保存中直接让位(同编辑态的 saving 闸)。
let capSaving = false;
input.addEventListener("keydown", async (e) => {
  // IME 组合期的按键是给输入法的(选字/上屏),不是给我们的——放行会把半打的拼音
  // 当正文存库、或把上屏那记 Enter 当保存(ui-audit P0 #1)。
  if (e.isComposing) return;
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
      const batch = pend.takeBatch();
      let id: string;
      try {
        id = await invoke<string>("capture_note", { content });
      } catch (err) {
        pend.putBack(batch);
        errLine.textContent = String(err);
        void fitWindow();
        return;
      }
      // The note is now saved — clear the text so a re-Enter can't create a duplicate.
      input.value = "";

      // Attach the frozen batch to the new note. A failed attach is surfaced (fail-fast, not
      // swallowed): the note is already saved, so keep the window open with a note that the
      // image didn't stick — the user can re-paste it on the idea card.
      const failed = await pend.attachBatch(id, batch);
      if (failed > 0) {
        errLine.textContent = `灵感已保存,但 ${failed} 张图未能附加(可在灵感卡里重新粘贴)`;
        void fitWindow();
        return; // stay open so the message is seen; text already cleared (no duplicate)
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
  pend.clear();
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
    void fitWindow();
  }
});
