// 任务卡左右滑改状态(182):落在任务卡上的横滑 → 前进/后退一个 stage。
// 待办→进行中→待确认→已完成 是一条线性链,右滑前进、左滑后退;端点(待办再左滑、
// 已完成再右滑)不响应——撤回/入册/转待办仍走操作面板(守克制,不把 off-axis 动作塞进滑动)。
// 只拦「pointerdown 命中任务卡」的横滑;顶部标题栏等非卡区域的横滑一概不吃,给日后
// 「横滑切视图」留一条干净通道。竖向滚动交回原生(.card { touch-action: pan-y }),
// 横向占优才锁定为滑动。进 done 走 update_task_status,后端照常盖 done_at(与勾框一致)。

import { updateTaskStatus, type TaskStatus, type TimelineItem } from "./api";
import { confirmBar, isTaskStage, showError, STAGE_LABEL } from "./ui";

// 任务四态线性链(与 STAGE_LABEL 同词汇表;数组顺序即右滑前进方向)。
const CHAIN: TaskStatus[] = ["todo", "doing", "confirming", "done"];

// 提交阈值(横移达卡宽 35% 或硬下限 84px)、锁定阈值、端点方向的橡皮筋阻尼。
const COMMIT_RATIO = 0.35;
const COMMIT_MIN = 84;
const LOCK_PX = 12;
const RUBBER = 0.28;
const RUBBER_CAP = 56;

type Deps = {
  /** 时间轴条目快照(id → item);判定任务态、读当前 stage 都靠它。 */
  getItem: (id: string) => TimelineItem | undefined;
  getCurrentSpace: () => string;
  /** 切换编排中:屏上是旧空间的卡,一律不受理。 */
  isSwitching: () => boolean;
  /** 有草稿在编辑:与「点空白开面」同闸,不受理滑动。 */
  hasDirtyDraft: () => boolean;
  /** 写成功后的整轴重拉(single-flight)。 */
  refresh: () => Promise<void>;
};

/** from 态按方向算目标态;端点方向返回 null(不响应)。 */
function targetStage(from: string, dir: 1 | -1): TaskStatus | null {
  const i = CHAIN.indexOf(from as TaskStatus);
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < CHAIN.length ? CHAIN[j] : null;
}

export function initCardSwipe(deps: Deps): void {
  const timeline = document.getElementById("timeline")!;
  let active: {
    card: HTMLElement;
    section: HTMLElement;
    track: HTMLElement | null;
    id: string;
    from: string;
    pointerId: number;
    startX: number;
    startY: number;
    dir: 0 | 1 | -1; // 0 = 方向未定
    to: TaskStatus | null; // dir 锁定后算好的目标态(null = 端点方向)
    width: number;
  } | null = null;
  let justSwiped = false; // 刚滑过一次:吞掉尾随的 click(别顺手把面板开了)
  let clearTimer: number | undefined;

  // 尾随 click 吞噬:cardpanel 的开面 click 也绑在 timeline(冒泡相),这里用捕获相抢先吃掉。
  timeline.addEventListener(
    "click",
    (e) => {
      if (!justSwiped) return;
      justSwiped = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );

  function reset(animate: boolean): void {
    if (!active) return;
    const { card, track } = active;
    card.style.transition = animate ? "transform 0.16s ease-out" : "";
    card.style.transform = "";
    card.classList.remove("swiping");
    if (track) track.remove();
    active = null;
  }

  timeline.addEventListener("pointerdown", (e) => {
    // 上一次滑动的尾随 click 必在本次 pointerdown 之前派发完;到这里还挂着的 justSwiped
    // 是「click 没来」的残留,清掉,免 400ms 兜底窗口误吞下一次点击。
    justSwiped = false;
    if (active) return; // 一次只跟一指
    if (deps.isSwitching() || deps.hasDirtyDraft()) return;
    const el = e.target as HTMLElement;
    // 勾框/缩略图/展开面板各有其主,不抢。
    if (el.closest(".tick") || el.closest(".thumb") || el.closest(".panel")) return;
    const card = el.closest<HTMLElement>("article.card[data-id]");
    if (!card || card.querySelector(".panel")) return; // 面板开着的卡不滑
    const id = card.dataset.id!;
    const item = deps.getItem(id);
    if (!item || !isTaskStage(item.stage)) return; // 灵感卡不滑
    const section = card.parentElement;
    if (!section) return;
    active = {
      card,
      section: section as HTMLElement,
      track: null,
      id,
      from: item.stage,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dir: 0,
      to: null,
      width: card.offsetWidth,
    };
  });

  timeline.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== active.pointerId) return;
    const dx = e.clientX - active.startX;
    const dy = e.clientY - active.startY;
    if (active.dir === 0) {
      // 竖向占优:交回原生滚动、放弃本次(touch-action:pan-y 一般已给 pointercancel,这里兜底)。
      if (Math.abs(dy) > LOCK_PX && Math.abs(dy) >= Math.abs(dx)) {
        active = null;
        return;
      }
      if (Math.abs(dx) < LOCK_PX || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      // 锁定横向。
      active.dir = dx > 0 ? 1 : -1;
      active.to = targetStage(active.from, active.dir);
      // 捕获让手指滑出卡外仍收得到事件;指针已释放等边角会抛,吞掉不中断手势(在 timeline
      // 上也照样收得到冒泡事件,捕获只是优化)。
      try {
        active.card.setPointerCapture(active.pointerId);
      } catch {
        /* 指针非活动:忽略,不影响后续跟手 */
      }
      active.card.classList.add("swiping");
      active.card.style.transition = "";
      // 可滑方向:在卡下铺一条 track 亮出目标印(端点方向不铺,只给橡皮筋手感)。
      if (active.to) {
        const track = document.createElement("div");
        track.className = "swipe-track";
        track.dataset.dir = active.dir > 0 ? "right" : "left";
        track.textContent = (active.dir > 0 ? "→ " : "← ") + STAGE_LABEL[active.to];
        track.style.top = `${active.card.offsetTop}px`;
        track.style.height = `${active.card.offsetHeight}px`;
        active.section.appendChild(track);
        active.track = track;
      }
    }
    // 已锁定:跟手平移(端点方向打折并封顶,给「到头了」的实感)。
    const tx = active.to ? dx : Math.max(-RUBBER_CAP, Math.min(RUBBER_CAP, dx * RUBBER));
    active.card.style.transform = `translateX(${tx}px)`;
    if (active.track) {
      const armed = Math.abs(dx) >= Math.min(COMMIT_MIN, active.width * COMMIT_RATIO);
      active.track.classList.toggle("armed", armed); // 过阈值 = 变实底(手势即回执)
    }
  });

  function end(e: PointerEvent, cancelled: boolean): void {
    if (!active || e.pointerId !== active.pointerId) return;
    if (active.dir === 0) {
      active = null; // 从没锁成滑动 = 当作一次点击,放它开面板
      return;
    }
    justSwiped = true; // 锁定过 = 有横移:吞掉尾随 click
    clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      justSwiped = false;
    }, 400); // click 不来时的兜底清标
    const dx = e.clientX - active.startX;
    const commit =
      !cancelled &&
      active.to !== null &&
      dx > 0 === active.dir > 0 && // 收尾方向须与锁定方向一致(半路折返不算)
      Math.abs(dx) >= Math.min(COMMIT_MIN, active.width * COMMIT_RATIO);
    const { id, from, to } = active;
    reset(true);
    if (commit && to) void commitSwipe(id, from, to);
  }

  timeline.addEventListener("pointerup", (e) => end(e, false));
  timeline.addEventListener("pointercancel", (e) => end(e, true));

  async function commitSwipe(id: string, from: string, to: TaskStatus): Promise<void> {
    if (deps.isSwitching()) return;
    const space = deps.getCurrentSpace();
    try {
      await updateTaskStatus(space, id, to);
    } catch (err) {
      showError(String(err));
      await deps.refresh();
      return;
    }
    await deps.refresh();
    flash(id);
    // 回执 + 撤销:滑动是低门槛手势,给一记 6s 可撤销窗口替代两拍确认(误滑可召回)。
    confirmBar(`已改为「${STAGE_LABEL[to]}」`, "撤销", () => {
      if (deps.isSwitching() || deps.getCurrentSpace() !== space) return; // 换空间的旧撤销作废
      void (async () => {
        try {
          await updateTaskStatus(space, id, from as TaskStatus);
        } catch (err) {
          showError(String(err));
        }
        await deps.refresh();
        flash(id);
      })();
    });
  }

  /** 移动后给卡一记朱砂脉冲(不强行滚动,免拽走视口);条目已不在则静默。 */
  function flash(id: string): void {
    const card = document.querySelector<HTMLElement>(`#timeline [data-id="${id}"]`);
    if (!card) return;
    card.classList.add("flash");
    window.setTimeout(() => card.classList.remove("flash"), 1200);
  }
}
