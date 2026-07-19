import { invoke } from "./space";
import { focusBoardView, focusTask } from "./board";
import { focusInboxItem } from "./inbox";
import type { View, ViewCtx } from "./notebook";
import { when } from "./tasktime";
import "./search.css";

// Mirror of the Rust contract (lib.rs `search_items`): an item whose current text
// OR any past version matched. Single-entity model — a hit can be an idea (未归类 /
// 已归类), a board task, or anything in the 回收站. Read-only — manage from the tabs.
type SearchHit = {
  id: string;
  content: string;
  created_at: string;
  status: "inbox" | "processed" | "archived" | "task" | "sealed";
  topics: string[];
};

// ---- small DOM helper (same shape as inbox.ts / topics.ts) -----------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

// Where the item currently lives. 灵感 is one merged list now (tags are just metadata, no
// inbox/filed split), so both idea statuses read as 灵感; plus 回收站 and 任务 (the board).
const STATUS_LABEL: Record<SearchHit["status"], string> = {
  inbox: "灵感",
  processed: "灵感",
  archived: "回收站",
  task: "任务",
  sealed: "归档", // 成就归档(sealed 轴)——已入册的干完的活,不在看板上
};

// Build the matched text as text + <mark> nodes (never innerHTML), so the
// highlight can never inject markup from user content. Case-insensitive, every
// occurrence.
function highlighted(text: string, query: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return [text];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) out.push(text.slice(from, at));
    out.push(el("mark", { textContent: text.slice(at, at + needle.length) }));
    from = at + needle.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

const SKELETON = `
  <header data-tauri-drag-region>
    <h1>搜索</h1>
  </header>
  <div class="searchbar">
    <div class="field">
      <span class="mag" aria-hidden="true">&#xE721;</span>
      <input id="q" type="text" placeholder="搜索灵感的内容……" autocomplete="off" spellcheck="false" />
      <button id="clear" class="clear" title="清空" aria-label="清空" hidden>&#xE711;</button>
    </div>
  </div>
  <main id="list"></main>
`;

// The last query typed here. Module scope so it survives a view switch: navigate()
// unmounts+remounts on every switch, and a fresh <input> would otherwise come back
// empty. (Same rationale as topics.ts `expanded`, board.ts `topicFilter`, inbox.ts
// `active`.) Only one search view is mounted at a time.
let lastQuery = "";

export function mount(root: HTMLElement, ctx: ViewCtx): View {
  const view = el("div", { className: "v-search" });
  view.innerHTML = SKELETON;
  root.replaceChildren(view);

  const list = view.querySelector("#list") as HTMLElement;
  const input = view.querySelector("#q") as HTMLInputElement;
  const clearBtn = view.querySelector("#clear") as HTMLButtonElement;

  function renderCenter(big: string, detail: string): void {
    list.replaceChildren(
      el("div", { className: "center" }, [
        el("div", { className: "big", textContent: big }),
        el("div", { textContent: detail }),
      ]),
    );
  }

  function renderError(message: string): void {
    list.replaceChildren(
      el("div", { className: "center" }, [
        el("div", { className: "big", textContent: "搜索失败" }),
        el("div", { className: "err-box", textContent: message }),
      ]),
    );
  }

  // 搜到了要到得了(ui-audit P1 #8):按 status 分流到条目现在住的地方——任务→看板
  // 高亮(focusTask 通道)、灵感→灵感视图定位、归档→看板归档册、回收站→
  // 按 stage 分家判归属(灵感回收站 / 看板回收站,一条 archived_at 轴两端列表)。
  // jumpSeq:连点两个命中时只有最后一次点击落地(codex 二审 M——同查询下先回的旧
  // 回包不许抢跳)。
  let jumpSeq = 0;
  async function jump(hit: SearchHit): Promise<void> {
    const myJump = ++jumpSeq;
    if (hit.status === "task") {
      focusTask(hit.id);
      ctx.navigate("board");
    } else if (hit.status === "inbox" || hit.status === "processed") {
      focusInboxItem(hit.id, "ideas");
      ctx.navigate("inbox");
    } else if (hit.status === "sealed") {
      focusTask(hit.id);
      focusBoardView("sealed");
      ctx.navigate("board");
    } else {
      // archived 命中不带 stage:用现成读命令就地判归属。读失败=真读失败,走错误页
      // (可重搜),不猜着跳(fail-fast,无静默兜底)。await 期间改搜/离开视图 = 本次
      // 跳转作废,旧回包不许盖过更新的动作(codex P1 审 M2)。
      const q = shown;
      try {
        const ideasTrash = await invoke<{ id: string }[]>("list_archived");
        if (jumpSeq !== myJump || shown !== q || !view.isConnected) return;
        if (ideasTrash.some((i) => i.id === hit.id)) {
          focusInboxItem(hit.id, "archived");
          ctx.navigate("inbox");
        } else {
          focusTask(hit.id);
          focusBoardView("trash");
          ctx.navigate("board");
        }
      } catch (err) {
        if (jumpSeq !== myJump || shown !== q || !view.isConnected) return;
        renderError(String(err));
      }
    }
  }

  // One result card: the matched thought (highlighted) + a meta row of provenance.
  function card(hit: SearchHit, query: string): HTMLElement {
    const meta = el("div", { className: "hit-meta" }, [
      el("span", {
        className: `badge ${hit.status}`,
        textContent: STATUS_LABEL[hit.status],
      }),
      ...hit.topics.map((t) => el("span", { className: "chip", textContent: t })),
    ]);
    meta.append(el("time", { className: "hit-time", textContent: when(hit.created_at) }));

    const node = el("article", { className: "hit", tabIndex: 0 }, [
      el("p", { className: "hit-text" }, highlighted(hit.content, query)),
      meta,
    ]);
    node.addEventListener("click", () => void jump(hit));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void jump(hit);
      }
    });
    return node;
  }

  // The query whose results are currently shown — guards against an out-of-order
  // response (a slow earlier search resolving after a newer one) and lets a focus
  // refresh re-run the live query.
  let shown = "";

  async function run(query: string): Promise<void> {
    const q = query.trim();
    shown = q;
    lastQuery = q; // remember across view switches
    if (!q) {
      renderCenter("在所有条目里查找", "输入关键词,跨灵感 / 任务 / 回收站搜索内容,连改过的旧版本一起找。");
      return;
    }
    try {
      const hits = await invoke<SearchHit[]>("search_notes", { query: q });
      if (shown !== q) return; // a newer query already superseded this one
      if (hits.length === 0) {
        renderCenter("没有匹配的灵感", `没有灵感的内容包含「${q}」。`);
        return;
      }
      list.replaceChildren(
        el("p", { className: "count", textContent: `${hits.length} 条匹配` }),
        ...hits.map((h) => card(h, q)),
      );
    } catch (err) {
      if (shown !== q) return;
      renderError(String(err));
    }
  }

  // Debounce keystrokes so we don't fire a query per character.
  let timer: number | undefined;
  function onInput(): void {
    clearBtn.hidden = input.value.length === 0;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(input.value), 150);
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期的 Enter 是上屏,不是立即搜索(ui-audit P0 #1)
    if (e.key === "Enter") {
      window.clearTimeout(timer);
      void run(input.value);
    } else if (e.key === "Escape") {
      // Esc clears a non-empty box; on an empty box it does nothing (this is one
      // view in the notebook — leave via the sidebar, don't close the window).
      if (input.value) {
        input.value = "";
        onInput();
        void run("");
      }
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    void run("");
    input.focus();
  });

  // Restore the query from a prior visit (module-scope lastQuery). If empty, show the
  // idle hint; if not, replay it so the results are back exactly as left.
  if (lastQuery) {
    input.value = lastQuery;
    clearBtn.hidden = false;
    void run(lastQuery);
  } else {
    renderCenter("在所有条目里查找", "输入关键词,跨灵感 / 任务 / 回收站搜索内容,连改过的旧版本一起找。");
  }
  input.focus();

  return {
    unmount() {
      root.replaceChildren();
    },
    onFocus() {
      // Re-focus ready to type and re-run the live query in case the underlying
      // notes changed (filed, edited, archived) since last shown.
      input.focus();
      if (shown) void run(shown);
    },
  };
}
