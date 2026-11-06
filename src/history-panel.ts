// 编辑历史面板(桌面随记编辑态;longform-plan §4,1b)。
//
// 目录只取元数据(时间 + 字数),点开一版才取那一版的全文 —— ⛔ 别退回「一次取全部正文」
// (旧的 list_note_history:200 版 × 200 KiB 过 IPC 再全建 DOM)。同一时刻至多展开一版,
// 全文缓存就是那一份。只读:⛔ 没有「恢复到这一版」(longform-plan §4 末)。
import { el, trapTab } from "./dom";
import { errText } from "./err";
import { t } from "./i18n";
import { invoke } from "./space";
import { when } from "./tasktime";
import { toastError } from "./toast";
import { renderDiff } from "../shared/diff-dom";

type RevisionMeta = { revision_id: number; archived_at: string; chars: number };
type RevisionCatalog = { entries: RevisionMeta[]; total: number; has_more: boolean };
type VersionText = { revision_id: number | null; archived_at: string | null; content: string };
type VersionPair = { a: VersionText; b: VersionText };

/** 比对前把两版的末行补齐换行(165 / W5 A32):行尾的换行是行的一部分,上一版末行没带换行、补了一段之后它带上了 ⇒
 *  同一行字被比成「删掉一行 + 加上一行」,红一遍又一字不差绿一遍,读着像改过。⛔ 只改**拿去比的那两份**,存下的版本一个字不动。
 *  两版**只**差末尾那个换行:补齐就成了同一份、比对里一处差异都不标 ⇒ 这种照原样比(差异就是那个换行,照实报)。
 *  与手机 `android/src/ui.ts::diffPair` 逐字孪生;长文历史(docs.ts)与随记 / 看板卡的历史(这里)同一条。 */
export function diffPair(a: string, b: string): [string, string] {
  const eol = (s: string): string => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
  const na = eol(a);
  const nb = eol(b);
  return na === nb ? [a, b] : [na, nb];
}

/** 往 `host` 里挂「历史 N 版」开关与面板;没有历史就什么也不挂。目录读失败照抛,由调用方决定
 *  怎么降级(编辑态里历史是附带的,读不到不该挡编辑)。`expanded` = 不要开关、目录直接摊开
 *  (看板卡的历史读框:框本身就是「要看」,再套一层能收起的开关是多一步)。`onCollapse` 见开关那一行。 */
export async function mountHistory(
  host: HTMLElement,
  itemId: string,
  opts: { expanded?: boolean; onCollapse?: () => void } = {},
): Promise<void> {
  const first = await invoke<RevisionCatalog>("list_revisions", { id: itemId, before: null });
  if (first.total === 0) return;

  const list = el("div", { className: "hist-list" });
  const more = el("button", { className: "hist-more", textContent: t("inbox.historyMore") });
  const panel = el("div", { className: "hist-panel", hidden: true }, [list, more]);
  // 在途请求的代次:点了别的版本 / 收起之后,旧回包 ⛔ 不许把文字塞回来。
  let seq = 0;
  let open: HTMLElement | null = null; // 展开着的那一行(.hist-item)

  const collapse = (): void => {
    open?.querySelector(".hist-text")?.remove();
    open?.classList.remove("open");
    open = null;
  };

  const addPage = (page: RevisionCatalog): void => {
    for (const r of page.entries) {
      const row = el("div", { className: "hist-item" });
      const head = el("button", { className: "hist-entry" }, [
        el("time", { className: "hist-time", textContent: t("inbox.editedAt", { time: when(r.archived_at) }) }),
        el("span", { className: "hist-chars", textContent: t("inbox.histChars", { n: r.chars }) }),
      ]);
      head.onclick = async () => {
        const mine = ++seq;
        const wasOpen = open === row;
        collapse();
        if (wasOpen) return;
        open = row;
        row.classList.add("open");
        const text = el("div", { className: "hist-text" });
        row.append(text);
        try {
          const pair = await invoke<VersionPair>("revision_texts", { id: itemId, a: { rev: r.revision_id }, b: "current" });
          if (mine !== seq) return;
          // 157 G4 / P5:复用长文的比对 —— 这一版 → 现在,删掉的标红、加上的标绿(此前只摊旧版全文,
          // 改了哪儿得自己对)。算不出逐行差异时 renderDiff 自己退回两份原文,这里补一句说明。
          const d = renderDiff(...diffPair(pair.a.content, pair.b.content)); // 165 / W5 A32:末行换行先补齐再比
          text.replaceChildren(
            el("p", { className: "hist-vs", textContent: t("inbox.histVsNow") }),
            ...(d.degraded !== null ? [el("p", { className: "hist-vs", textContent: t("docs.histDegraded") })] : []),
            d.root,
          );
        } catch (e) {
          if (mine === seq) text.textContent = errText(e);
        }
      };
      row.append(head);
      list.append(row);
    }
    more.hidden = !page.has_more;
    more.onclick = async () => {
      const before = page.entries[page.entries.length - 1].revision_id;
      more.disabled = true;
      try {
        addPage(await invoke<RevisionCatalog>("list_revisions", { id: itemId, before }));
      } catch (e) {
        // 在途时编辑态已收起(面板脱离文档)就不报 —— 否则旧请求的错会弹到新界面上(codex 1b 一弹 L)
        if (more.isConnected) toastError(errText(e));
      } finally {
        more.disabled = false;
      }
    };
  };
  addPage(first);

  if (opts.expanded) {
    panel.hidden = false;
    host.replaceChildren(panel);
    return;
  }
  const toggle = el("button", {
    className: "hist-toggle",
    textContent: t("inbox.historyToggle", { n: first.total }),
    // `onCollapse`(随记读态那份,W5 A15):摊开着再点这一行 = 整块收走、交给宿主(此前只藏面板、卡上留着
    // 「历史 1 版」那一行,之后按 H 第一下收这行、第二下才展开)。编辑态那份不给,照旧只开合面板。
    onclick: () => {
      if (!panel.hidden && opts.onCollapse) opts.onCollapse();
      else panel.hidden = !panel.hidden;
    },
  });
  host.replaceChildren(toggle, panel);
}

// ---- 看板卡的历史读框(158 G4-A8)-------------------------------------------------------
// 随记的历史就地摊在卡里(全宽单列);看板是 200px 起的窄列、还会随同步 / 回窗整列重画,
// 摊在卡里放不下比对、也留不住 —— 同留言浮层那条「按容器形状分形」(item-comments PanelMode)。
// ⇒ portal 到 body 的读框:遮罩复用留言那张深压 `.cm-overlay`(阅读型),内容就是上面这份
// mountHistory(目录 + 点开一版画「这一版 → 现在」的比对),⛔ 不另写第二份历史 UI。
// 只读:⛔ 没有任何写口。全视图至多一枚;宿主视图卸载(切视图 / 切空间)时必须 closeHistoryDialog。

let dialog: { close: () => void } | null = null;

/** 打开 `itemId` 的历史读框。`hostText` = 这张卡现在的正文,印在框顶上(读框盖住了卡本身)。
 *  `returnFocus` = 关框时焦点回哪儿,**关的那一刻现找**:从 ⋯ 菜单 / 单键进来时 activeElement 多半已是
 *  body(菜单先拆了),框开着时宿主还可能整列重画 —— 开框那一刻记下的节点靠不住(codex A8 L1)。 */
export function openHistoryDialog(itemId: string, hostText: string, returnFocus: () => HTMLElement | null): void {
  closeHistoryDialog();
  const closeBtn = el("button", { className: "hd-close", type: "button", textContent: "✕", title: t("inbox.histClose") });
  closeBtn.setAttribute("aria-label", t("inbox.histClose"));
  const body = el("div", { className: "hd-body" }, [el("p", { className: "hist-vs", textContent: "…" })]);
  const panel = el("div", { className: "hd-panel" }, [
    el("div", { className: "hd-head" }, [el("h2", { className: "hd-title", textContent: t("inbox.actHistory") }), closeBtn]),
    el("p", { className: "hd-host", textContent: hostText }),
    body,
  ]);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", t("inbox.actHistory"));
  const overlay = el("div", { className: "cm-overlay hd-overlay" }, [panel]);
  const me = { close };
  dialog = me;

  function close(): void {
    if (dialog !== me) return; // 已被后来者顶掉:别去拆别人的框
    dialog = null;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    returnFocus()?.focus();
  }
  // 捕获阶段挂在 document 上:Esc 关框、Tab 圈在框里;其余不带修饰键的单键**一律截住** ——
  // 焦点在框里的按钮上时,看板卡的单键(hotkey-menu 的 onKey)与视图键照样收得到,不截的话
  // 读着历史按一下 D 就把身后那张卡删了。只 stopPropagation、不 preventDefault:按钮上的
  // Enter / 空格照旧是点击。
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    trapTab(panel, e);
    if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
  }
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", () => close());
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  closeBtn.focus();

  const staged = el("div");
  mountHistory(staged, itemId, { expanded: true }).then(
    () => {
      if (dialog !== me) return;
      // 目录为空 = 卡上的「改过」是上一次重画时的旧真相(别处刚把它彻底删了之类):照实说,⛔ 不留白。
      if (staged.childElementCount === 0) body.replaceChildren(el("p", { className: "hist-vs", textContent: t("inbox.histNone") }));
      else body.replaceChildren(...staged.childNodes);
    },
    (e) => {
      if (dialog === me) body.replaceChildren(el("p", { className: "hd-err", textContent: errText(e) }));
    },
  );
}

/** 关掉开着的历史读框(没开 = 什么也不做)。 */
export function closeHistoryDialog(): void {
  dialog?.close();
}
