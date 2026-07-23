// 回收站 / 归档册 / 搜索 低频面(120)。统一纪律(codex 120 设计审 M7):
// 每次加载开头取定 {space, seq},响应回来复核 space 未变且 seq 仍是最新才画
// ——旧查询晚回不许盖新查询,切空间后的迟到响应整体弃。写操作 in-flight 禁点,
// 彻底删/清空的两拍确认在底部固定确认条(ui-audit P0 #4:原位换话术会改按钮几何,
// 第二拍可能落到毗邻单拍的「恢复」上;固定条几何恒定,onYes 复核行还在才执行)。
import {
  getCurrentSpace,
  listSealedTasks,
  listTrash,
  purgeAllTrash,
  purgeNote,
  purgeTask,
  restoreNote,
  restoreTask,
  searchNotes,
  unsealTask,
  type SearchStatus,
} from "./api";
import { $, confirmBar, esc, fmtWhen, hideConfirmBar, isTaskStage, showBar, showError, STAGE_LABEL } from "./ui";

type Deps = {
  refreshTimeline: () => Promise<void>;
  /** 搜索命中活跃条目 → 关面 + 回主视图定位并闪一下那张卡(在 main.ts 实现,
   *  146 起按条目 stage 先切到灵感/任务面再定位)。 */
  focusCard: (id: string) => void;
  /** 搜索命中分流(ui-audit P1 #8):回收站/归档册的命中切到对应面(main.ts openPane)。 */
  showPane: (name: "trash" | "sealed") => void;
};

let deps: Deps;

/** 收起底部确认条(重载/切空间时:旧确认不许挂在新列表上)。 */
function clearConfirm() {
  hideConfirmBar();
}

// ---- 回收站 -------------------------------------------------------------------

let trashSeq = 0;
let trashBusy = false;
let trashRows: import("./api").TrashItem[] = [];

export async function loadTrash(): Promise<void> {
  const space = getCurrentSpace();
  const seq = ++trashSeq;
  const box = $("trash-list");
  box.innerHTML = `<p class="muted empty">读取中…</p>`;
  try {
    const rows = await listTrash(space);
    if (space !== getCurrentSpace() || seq !== trashSeq) return;
    trashRows = rows;
    clearConfirm();
    renderTrash();
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== trashSeq) return;
    box.innerHTML = `<p class="empty" style="color:var(--seal)">回收站读取失败:${esc(String(err))}</p>`;
  }
}

function renderTrash() {
  const box = $("trash-list");
  ($("trash-empty") as HTMLButtonElement).disabled = trashBusy || trashRows.length === 0;
  if (!trashRows.length) {
    box.innerHTML = `<p class="muted empty">回收站是空的。</p>`;
    return;
  }
  box.innerHTML = trashRows
    .map((r) => {
      const kind = STAGE_LABEL[r.stage] ?? "灵感";
      const chips = r.topics
        .map(
          (t) =>
            `<span class="chip"${t.color ? ` style="--tc:${esc(t.color)}"` : ""}>${esc(t.title)}</span>`,
        )
        .join("");
      return `<article class="card" data-trash="${esc(r.id)}"><div class="body">
        <p class="content">${esc(r.content)}</p>
        <footer><span class="pill">${kind}</span><time>删于 ${esc(fmtWhen(r.archived_at))}</time>${chips}</footer>
        <div class="panel"><div class="acts">
          <button data-trash-act="restore"${trashBusy ? " disabled" : ""}>恢复</button>
          <button data-trash-act="purge" class="warn"${trashBusy ? " disabled" : ""}>彻底删除</button>
        </div></div>
      </div></article>`;
    })
    .join("");
}

async function trashRun(op: (space: string) => Promise<unknown>, doneMsg?: string) {
  if (trashBusy) return;
  const space = getCurrentSpace();
  trashBusy = true;
  renderTrash();
  try {
    await op(space);
    if (space === getCurrentSpace() && doneMsg) showBar(doneMsg, true);
  } catch (err) {
    if (space === getCurrentSpace()) showError(String(err));
  } finally {
    trashBusy = false;
    clearConfirm();
    if (space === getCurrentSpace()) {
      await loadTrash();
      void deps.refreshTimeline();
    }
  }
}

function onTrashClick(e: Event) {
  const t = e.target as HTMLElement;
  if (t.id === "trash-empty") {
    if (!trashRows.length || trashBusy) return;
    confirmBar(`清空回收站?${trashRows.length} 条将彻底删除、无法找回`, "清空", () => {
      if (trashBusy || !trashRows.length) return; // 期间已重载成空/在写:弃
      void trashRun(
        async (space) => {
          const n = await purgeAllTrash(space);
          return n;
        },
        "回收站已清空",
      );
    });
    return;
  }
  const act = t.closest<HTMLElement>("[data-trash-act]")?.dataset.trashAct;
  if (!act || trashBusy) return;
  const id = t.closest<HTMLElement>("[data-trash]")?.dataset.trash;
  const row = trashRows.find((r) => r.id === id);
  if (!row) return;
  const task = isTaskStage(row.stage);
  if (act === "restore") {
    // 146:恢复=回主视图,按该行冻结 stage 指路(任务回任务面、灵感回灵感面)。
    void trashRun(
      (space) => (task ? restoreTask(space, row.id) : restoreNote(space, row.id)),
      task ? "已恢复,在底栏「任务」里" : "已恢复,在底栏「灵感」里",
    );
    return;
  }
  if (act === "purge") {
    confirmBar("彻底删除这条?无法找回", "彻底删除", () => {
      // 确认期间列表可能已被远端刷新重载:按 id 重取现行,行没了就弃(绝不误删别行)。
      const fresh = trashRows.find((r) => r.id === row.id);
      if (!fresh || trashBusy) return;
      const freshTask = isTaskStage(fresh.stage);
      void trashRun((space) => (freshTask ? purgeTask(space, fresh.id) : purgeNote(space, fresh.id)));
    });
  }
}

// ---- 归档册 -------------------------------------------------------------------

let sealedSeq = 0;
let sealedBusy = false;

export async function loadSealed(): Promise<void> {
  const space = getCurrentSpace();
  const seq = ++sealedSeq;
  const box = $("sealed-list");
  box.innerHTML = `<p class="muted empty">读取中…</p>`;
  try {
    const rows = await listSealedTasks(space);
    if (space !== getCurrentSpace() || seq !== sealedSeq) return;
    box.innerHTML = rows.length
      ? rows
          .map(
            (r) => `<article class="card" data-sealed="${esc(r.id)}"><div class="body">
              <p class="content">${esc(r.title)}</p>
              <footer><time>${
                r.done_at ? `完成于 ${esc(fmtWhen(r.done_at))}` : `归档于 ${esc(fmtWhen(r.sealed_at!))}`
              }</time></footer>
              <div class="panel"><div class="acts">
                <button data-unseal="${esc(r.id)}"${sealedBusy ? " disabled" : ""}>取消入册(回看板已完成)</button>
              </div></div>
            </div></article>`,
          )
          .join("")
      : `<p class="muted empty">归档册还是空的——完成的任务入册后在这里。</p>`;
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== sealedSeq) return;
    box.innerHTML = `<p class="empty" style="color:var(--seal)">归档册读取失败:${esc(String(err))}</p>`;
  }
}

function onSealedClick(e: Event) {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-unseal]")?.dataset.unseal;
  if (!id || sealedBusy) return;
  const space = getCurrentSpace();
  sealedBusy = true;
  void (async () => {
    try {
      await unsealTask(space, id);
      if (space === getCurrentSpace()) showBar("已取消入册,在「任务」的「已完成」里", true);
    } catch (err) {
      if (space === getCurrentSpace()) showError(String(err));
    } finally {
      sealedBusy = false;
      if (space === getCurrentSpace()) {
        await loadSealed();
        void deps.refreshTimeline();
      }
    }
  })();
}

// ---- 搜索 --------------------------------------------------------------------

const SEARCH_STATUS_LABEL: Record<SearchStatus, string> = {
  inbox: "灵感",
  processed: "已归类",
  task: "任务",
  archived: "回收站",
  sealed: "归档册",
};

let searchSeq = 0;

async function runSearch() {
  // 序号先行(实现审 L7):空查询也要作废在途的旧查询——否则「清空再点搜」后,
  // 旧查询的迟到结果会把空态盖回旧列表。
  const space = getCurrentSpace();
  const seq = ++searchSeq;
  const q = ($("search-input") as HTMLInputElement).value.trim();
  const box = $("search-results");
  if (!q) {
    box.innerHTML = `<p class="muted empty">输入词再搜(连编辑历史一起搜)。</p>`;
    return;
  }
  box.innerHTML = `<p class="muted empty">搜索中…</p>`;
  try {
    const hits = await searchNotes(space, q);
    if (space !== getCurrentSpace() || seq !== searchSeq) return;
    box.innerHTML = hits.length
      ? hits
          .map(
            (h) => `<article class="card" data-hit="${esc(h.id)}" data-hit-status="${esc(h.status)}"><div class="body">
              <p class="content">${esc(h.content)}</p>
              <footer><span class="pill">${SEARCH_STATUS_LABEL[h.status] ?? esc(h.status)}</span>
                <time>${esc(fmtWhen(h.created_at))}</time>
                ${h.topics.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</footer>
            </div></article>`,
          )
          .join("")
      : `<p class="muted empty">没有找到「${esc(q)}」。</p>`;
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== searchSeq) return;
    box.innerHTML = `<p class="empty" style="color:var(--seal)">搜索失败:${esc(String(err))}</p>`;
  }
}

/** 搜到了要到得了(ui-audit P1 #8):活跃条目回时间轴定位闪卡(focusCard 自带
 *  「已不在时间轴」响亮提示),回收站/归档册命中切对应面现读。 */
function onSearchClick(e: Event) {
  const card = (e.target as HTMLElement).closest<HTMLElement>("[data-hit]");
  if (!card) return;
  const status = card.dataset.hitStatus as SearchStatus;
  if (status === "archived") deps.showPane("trash");
  else if (status === "sealed") deps.showPane("sealed");
  else deps.focusCard(card.dataset.hit!);
}

export function focusSearch() {
  ($("search-input") as HTMLInputElement).focus();
}

/** 切空间后清空各面的陈旧内容(面会随 pane 关闭,重开时现读)。 */
export function resetPanesForSpaceChange() {
  trashSeq++;
  sealedSeq++;
  searchSeq++;
  trashRows = [];
  clearConfirm();
  $("trash-list").innerHTML = "";
  $("sealed-list").innerHTML = "";
  $("search-results").innerHTML = "";
  ($("search-input") as HTMLInputElement).value = "";
}

export function initPanes(d: Deps) {
  deps = d;
  $("trash-pane").addEventListener("click", onTrashClick);
  $("sealed-pane").addEventListener("click", onSealedClick);
  $("search-results").addEventListener("click", onSearchClick);
  $("search-btn").addEventListener("click", () => void runSearch());
  $("search-input").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).isComposing) return; // IME 组合期的 Enter 是上屏,不是搜索
    if ((e as KeyboardEvent).key === "Enter") void runSearch();
  });
}
