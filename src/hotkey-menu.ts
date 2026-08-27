import "./hotkey-menu.css";
import { t } from "./i18n";
import { NATIVE_MENU_KEEP } from "./context-menu";

// 悬停即选中 + ⋯ 速查菜单 + 单键直达 —— 抽自 inbox 的原型,做成视图无关的公共件,
// 让「同一个键 = 同一个概念」跨视图(灵感 / 任务看板 / …)一致,肌肉记忆才能迁移。
//
// One declared action = one dropdown row + one single-key shortcut. The SAME list
// drives the hover ⋯ menu (the visible cheat-sheet) and the keydown dispatch, so a
// key shown in the menu can never do something else (single source of truth).

/** portal 到 body 的「卫星浮层」白名单——落点在这些层里不算「点别处」,不触发
 *  编辑态的默认保存 / 确认态的收起。此前这串选择器以字面量抄在三处(board / inbox 的
 *  onDown 与这里的 armDismiss,顺序还不一致),新增留言层(.cm-overlay)三处都没登记;
 *  收成唯一登记点:**新增 portal 层改这里一处**。 */
export const SATELLITE_LAYERS = ".hk-menu, .img-lightbox, .cm-overlay";

export type Act = {
  /** 菜单行左侧文案。 */
  label: string;
  /** 单键,按它被匹配的形态存:字母用大写("E"),其它可打印键用原样("]"、"[")。 */
  key: string;
  /** 危险操作(删除类),菜单行染成朱砂。 */
  danger?: boolean;
  /** 普通动作:先关菜单,再执行。run / feedback 二选一。 */
  run?: () => void;
  /** 留开动作(如复制):执行后在自己的菜单行里闪一下返回的文案,而非关闭菜单。
   *  从键盘触发(菜单没开)时静默执行。返回值即要闪的文案,失败也自行兜底成文案。 */
  feedback?: () => Promise<string>;
};

/** 一张卡片接入后拿到的句柄。 */
export type CardHandle = {
  /** 给这张卡片新造一个 ⋯ 按钮 + 懒展开的下拉。放到卡片视图态里任意位置;每次卡片重渲
   *  视图态都要重新调一次(旧节点在父级 replaceChildren 后就失效了)。 */
  menu(): HTMLElement;
};

export type HotkeyController = {
  /** 把「悬停选中 + 单键」接到 `card` 上。`actions` 每次开菜单 / 按键时现读,所以可用动作
   *  随状态变(看板:撤回仅待办、列间移动看是否到头)的卡片永远反映当前真相。
   *  `suspended()` 为真 = 此刻键盘归卡片自己(行内编辑 / 确认中),全局单键让位。 */
  register(card: HTMLElement, actions: () => Act[], suspended?: () => boolean): CardHandle;
  /** 重渲前调一次:关掉残留菜单、清掉已失效的选中目标(否则会指向已脱离 DOM 的旧卡片)。 */
  reset(): void;
  /** 卸载视图时调:摘掉 document 上的 keydown 与任何打开的菜单。 */
  destroy(): void;
};

// ---- small DOM helper (same shape as the views) ----------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

export function createHotkeyController(): HotkeyController {
  // The hovered (or menu-locked) card is the shortcut target; its action list is read
  // live, so the menu and the keyboard can never disagree. `openMenuCloser` keeps at
  // most one menu open across the whole view.
  type Row = { card: HTMLElement; actions: () => Act[]; suspended: () => boolean; openMenu: () => void };
  let activeRow: Row | null = null;
  let openMenuCloser: (() => void) | null = null;
  // 注册序 = 渲染序 = 视觉序(灵感的时间轴、看板的列内从上到下/列间从左到右),
  // 是 ↑/↓ 键盘选卡的移动轨道;每次重渲 reset() 清空、register 重排。
  let rows: Row[] = [];

  // 执行一个动作。feedback 型:跑完把返回文案交给 flash(菜单开着才闪)。run 型:直接跑。
  function runAct(act: Act, flash: ((text: string) => void) | null): void {
    if (act.feedback) {
      void act.feedback().then((text) => flash?.(text));
    } else {
      act.run?.();
    }
  }

  function onKey(e: KeyboardEvent): void {
    // Modifiers stay with the system/global shortcuts (Ctrl+Alt+N, Ctrl+C, …).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Never steal a keystroke from a field — typing 'e' must type 'e'.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    // ↑/↓ 键盘选卡:和悬停同一个「选中」概念(选中后单键 / `/` 照常),不碰鼠标也能
    // 挑卡。没有选中时 ↓ 从头、↑ 从尾进入;菜单开着时不动(菜单是自己的键盘域)。
    // 跳过已脱离 DOM 的陈尸行(离场动画中的卡)。
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (openMenuCloser) return;
      const alive = rows.filter((r) => r.card.isConnected);
      if (alive.length === 0) return;
      e.preventDefault();
      const at = activeRow ? alive.indexOf(activeRow) : -1;
      const next =
        e.key === "ArrowDown"
          ? alive[at < 0 ? 0 : Math.min(at + 1, alive.length - 1)]
          : alive[at < 0 ? alive.length - 1 : Math.max(at - 1, 0)];
      if (next !== activeRow) {
        activeRow?.card.classList.remove("is-active");
        activeRow = next;
        next.card.classList.add("is-active");
        next.card.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (!activeRow) return;
    // A card mid inline-edit / mid-confirm owns the keyboard (its own Enter/Esc).
    if (activeRow.suspended()) return;
    if (e.key.length !== 1) return;
    const want = e.key.toUpperCase();
    // `/` 弹出当前卡片的 ⋯ 速查菜单(忘了哪个键时翻一眼);其余单键直接派发动作。
    if (want === "/") {
      e.preventDefault();
      activeRow.openMenu();
      return;
    }
    const act = activeRow.actions().find((a) => a.key === want);
    if (!act) return;
    e.preventDefault();
    openMenuCloser?.(); // acting from the keyboard shuts any open menu first
    runAct(act, null); // menu is closed → feedback runs silently (e.g. copy still happens)
  }
  document.addEventListener("keydown", onKey);

  function register(card: HTMLElement, getActions: () => Act[], suspended: () => boolean = () => false): CardHandle {
    card.classList.add("hk-host");
    // Per-card menu state — persists across menu() rebuilds (each view re-render makes a
    // fresh ⋯ wrap but reuses these so an open menu / pending timer is never orphaned).
    let hovering = false;
    let menuOpenFlag = false;
    let menuEl: HTMLElement | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    // Reassigned by menu() each render so the row-level cleanup always tears down
    // whatever menu is currently shown, and the keyboard (`/`) can pop the latest one.
    let closeMenu: () => void = () => {};
    // `at` = 光标位置(右键那条路);不带 = 老路,按 ⋯ 图标的 rect 定位。
    let openMenuRef: (at?: { x: number; y: number }) => void = () => {};

    const api: Row = { card, actions: getActions, suspended, openMenu: () => openMenuRef() };
    rows.push(api);

    // Hover sets the active card (the shortcut target) and reveals the icon (CSS).
    // While a menu is open the card stays active even if the pointer drifts off, so a
    // shortcut can never fire on the wrong card.
    card.addEventListener("mouseenter", () => {
      hovering = true;
      // While another card's menu is open it stays the locked target — a stray hover
      // (e.g. reaching toward that menu) must not steal it.
      if (openMenuCloser && openMenuCloser !== closeMenu) return;
      setActive();
    });
    card.addEventListener("mouseleave", () => {
      hovering = false;
      if (!menuOpenFlag) clearActiveIfMine();
    });
    // 右键 = 开同一枚 ⋯ 菜单。菜单与单键本来就读同一份 actions,右键因此不可能比 ⋯ 少
    // 一项或多一项(单一真相源不动);它给的只是「不必先找到那枚只在悬停时才显形的图标」
    // 这个入口。⛔ 三条让位判据一条都别省 —— 在这些地方右键本来就有更该做的事,抢过来
    // 就是负优化:
    //   ① 输入框 / 可编辑区:编辑态右键要粘贴(配图那条路正是粘贴);
    //   ② 链接与图片:各自已有右键约定(item-images 的「右键复制链接」);
    //   ③ 本卡内有非空选区:用户正想右键复制选中的那段字。
    // 另外 suspended()(行内编辑 / 确认中)整个让位 —— 那时键盘也是让位的,同一条规矩。
    // ⭐ 505 起 ①② 那两项的选择器住 `context-menu.ts`(`NATIVE_MENU_KEEP`)—— 文档级那条路
    // 要读同一份,抄两份必漂移。⚠ ③ 刻意仍是**卡片内**的选区(`card.contains`),与文档级
    // 那条「点在选区上」不是同一个判据:这里让位的理由是「这张卡上有选区」。
    card.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.closest(NATIVE_MENU_KEEP)) return;
      if (suspended()) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount > 0 && card.contains(sel.getRangeAt(0).commonAncestorContainer))
        return;
      e.preventDefault();
      // 已经开着的先收:别的卡片那枚(保持「全视图至多一枚」),或本卡那枚(⋯ 点开的 /
      // 上一次右键的)——后者要收掉才能挪到新的光标位置,openMenu 见 menuEl 非空会直接返回。
      if (openMenuCloser && openMenuCloser !== closeMenu) openMenuCloser();
      if (menuEl) closeMenu();
      setActive();
      openMenuRef({ x: e.clientX, y: e.clientY });
    });
    function setActive(): void {
      activeRow = api;
      card.classList.add("is-active");
    }
    function clearActiveIfMine(): void {
      if (activeRow === api) activeRow = null;
      card.classList.remove("is-active");
    }

    // Built fresh each render. The ⋯ icon shows on card hover, but the menu opens only on a
    // CLICK of the icon — hover-to-open was too twitchy (a stray sweep over the corner popped
    // it). The single-key shortcuts still fire on plain card hover, so the menu is purely a
    // click-to-open cheat-sheet; close it via outside-click / Esc / picking an item.
    function menu(): HTMLElement {
      // draggable:false on every interactive piece so that on a draggable host (the
      // task board) a mousedown on the icon/menu never starts a card drag (matches how
      // the board's chips opt out). Harmless on a non-draggable host (灵感).
      const wrap = el("div", { className: "hk-menu-wrap", draggable: false });
      const iconBtn = el("button", {
        className: "hk-btn",
        textContent: "⋯",
        title: t("hotkeyMenu.actionsTitle"),
        draggable: false,
      });
      iconBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menuEl) closeMenu(); // click again toggles it shut
        else openMenu();
      });
      wrap.append(iconBtn);

      function onDocClick(e: MouseEvent): void {
        // The menu is portaled to <body> (not inside wrap), so exempt it too — otherwise
        // this capture-phase handler would tear it down before the item's own click runs.
        const t = e.target as Node;
        if (!wrap.contains(t) && !(menuEl && menuEl.contains(t))) closeMenu();
      }
      function onMenuKey(e: KeyboardEvent): void {
        if (e.key === "Escape") {
          e.preventDefault();
          closeMenu();
        }
      }
      function openMenu(at?: { x: number; y: number }): void {
        clearTimeout(closeTimer);
        if (menuEl) return;
        openMenuCloser?.(); // at most one menu open across the view
        menuEl = el(
          "div",
          { className: "hk-menu", draggable: false },
          getActions().map((a) => {
            const item = el("button", {
              className: a.danger ? "hk-item danger" : "hk-item",
              draggable: false,
            });
            item.dataset.key = a.key;
            const label = el("span", { className: "hk-label", textContent: a.label });
            item.append(label, el("kbd", { className: "hk-key", textContent: a.key }));
            item.addEventListener("click", (e) => {
              e.stopPropagation();
              if (a.feedback) {
                // keep the menu up to flash the result in this row
                runAct(a, (text) => {
                  label.textContent = text;
                  clearTimeout(closeTimer);
                  closeTimer = setTimeout(() => closeMenu(), 900);
                });
              } else {
                closeMenu();
                a.run?.();
              }
            });
            return item;
          }),
        );
        // Portal to <body>, NOT into wrap: a menu nested in the card is trapped inside the
        // card's stacking context and clipped by the column body's overflow:auto — WebView2
        // then mis-hit-tests its rows (a sibling card's chip "receives" the click). At body
        // root with position:fixed + z-index it sits above everything and hit-tests cleanly.
        document.body.appendChild(menuEl);
        // Position in the viewport from the icon's rect, then CLAMP so the whole menu (every
        // row, incl. the last) stays on-screen — the icon may sit low in a full, scrolling
        // column, so a naive drop-down would push the bottom rows off-screen (→ not
        // interactable). Prefer below the icon; if it won't fit, go above; else pin to the
        // bottom margin, never above the top margin.
        const M = 6;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const mh = menuEl.offsetHeight; // measured now that it is in the DOM
        let top: number;
        if (at) {
          // 右键那条路:左上角贴着光标(常规右键菜单的形)。⭐ 横向也要钳 —— ⋯ 那条是
          // 右对齐图标、天然不会出右边界,这条会(靠视口右缘右键时菜单整个跑出去)。
          menuEl.style.right = "auto";
          menuEl.style.left = `${Math.max(M, Math.min(at.x, vw - M - menuEl.offsetWidth))}px`;
          top = at.y;
        } else {
          const r = iconBtn.getBoundingClientRect();
          menuEl.style.left = "auto";
          menuEl.style.right = `${Math.max(M, vw - r.right)}px`;
          top = r.bottom + 4;
          if (top + mh > vh - M) top = r.top - 4 - mh; // won't fit below → flip above the icon
        }
        // Hard clamp so the WHOLE menu (every row, incl. the last) is on-screen even when the
        // icon sits low in / below the fold of a full scrolling column.
        top = Math.max(M, Math.min(top, vh - M - mh));
        menuEl.style.top = `${top}px`;
        menuOpenFlag = true;
        setActive();
        openMenuCloser = closeMenu;
        document.addEventListener("click", onDocClick, true);
        document.addEventListener("keydown", onMenuKey, true);
      }
      closeMenu = () => {
        clearTimeout(closeTimer);
        if (menuEl) {
          menuEl.remove();
          menuEl = null;
        }
        menuOpenFlag = false;
        if (openMenuCloser === closeMenu) openMenuCloser = null;
        document.removeEventListener("click", onDocClick, true);
        document.removeEventListener("keydown", onMenuKey, true);
        if (!hovering) clearActiveIfMine();
      };
      openMenuRef = openMenu; // let the keyboard (`/`) open this render's menu
      return wrap;
    }

    return { menu };
  }

  function reset(): void {
    openMenuCloser?.();
    activeRow = null;
    rows = [];
  }

  function destroy(): void {
    openMenuCloser?.();
    rows = [];
    document.removeEventListener("keydown", onKey);
  }

  return { register, reset, destroy };
}

// ---- 视图级全局单键 --------------------------------------------------------
// header 上的全局动作(新建任务 / 回收站 / 新建标签 …)没有「悬停的卡片」可挂,但同样
// 该能不碰鼠标就触发——尤其全屏时鼠标要跑很远。这里给「整个视图」注册单键:不悬停任何
// 卡片也生效;焦点在输入框、或带修饰键(让给系统级 Ctrl+Alt+N/M)时让位。
//
// 选键务必和该视图的卡片单键(hotkey 菜单里的 E/C/L/S/P/B/D/]/[ …)错开,否则悬停一张
// 卡片时同一个键会两义。返回卸载函数,视图 unmount 时调一次。
export type ViewKey = { key: string; run: () => void };

// ---- 内联选择器的「Esc / 点别处 收起」手势 ---------------------------------
// 卡片上就地展开的选择器(标签 L / 截止 S / 优先级 P …)不该再挂「取消」按钮——和 ⋯ 菜单
// 同一套约定:Esc 或点选择器以外任意处即收起。抽出来让三个选择器一致(单一真相源)。
//
// `root` = 选择器容器(点它内部不算离开);`close` = 收起(通常重渲回展示态)。返回 teardown:
// 选中某项走 mutate+重渲的路径必须先手动调它,否则 document 监听泄漏。放行 ⋯ 菜单浮层
// (portal 到 body)与看大图遮罩——那是卫星 UI,不该误触发收起。
export function armDismiss(root: HTMLElement, close: () => void): () => void {
  function teardown(): void {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    teardown();
    close();
  }
  function onDown(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (root.contains(t)) return;
    if (t.closest(SATELLITE_LAYERS)) return;
    teardown();
    close();
  }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  return teardown;
}

export function registerViewKeys(keys: ViewKey[]): () => void {
  function onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key.length !== 1) return;
    const want = e.key.toUpperCase();
    const k = keys.find((x) => x.key === want);
    if (!k) return;
    e.preventDefault();
    k.run();
  }
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}
