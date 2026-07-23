// P4-c 捕获页 + 统一时间轴 + 勾标完成;P4-d 接同步;107 扫码配对;
// 工序 7/8(multispace-plan):多空间——头部空间 chip(§9 捕获目标常显、点名可切)、
// 空间面板(列表/新建/改名/全部同步)、业务命令显式携带「点击时看到的 spaceId」
// (§16.2 提案 B:目标由后端协调器复核,切换中响亮拒、草稿成功落库才清)。
// currentSpace 只是后端 foreground 的影子:每次切换/恢复后从 foreground_space 对账。
// 119 起空间影子 + sinvoke + 业务命令包装上抬到 src/api.ts(全功能底座的调用层,
// 单一真相源);本文件只剩视图编排,业务调用一律走 api 包装。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentSpace,
  setCurrentSpace,
  sinvoke,
  captureIdea,
  captureTodo,
  completeTask,
  deleteItemImage,
  getItemImage,
  listSpaces,
  listTimeline,
  listTopicsFull,
  spaceLabel,
  syncCreateAccount,
  syncPairStart,
  type SpaceInfo,
  type TimelineItem,
} from "./api";
import { $, confirmBar, esc, fmtWhen, hideConfirmBar, showBar, showError, STAGE_LABEL } from "./ui";
import { composeImages, pickImage } from "./images";
import * as cardPanel from "./cardpanel";
import * as filter from "./filter";
import * as panes from "./panes";
import * as topics from "./topics";
import { initCardSwipe } from "./swipe";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  scan,
  cancel,
  checkPermissions,
  requestPermissions,
  Format,
} from "@tauri-apps/plugin-barcode-scanner";

type DbInfo = {
  path: string;
  sqlite_version: string;
  journal_mode: string;
  user_version: number;
  device_id: string;
  items: number;
};
type ProbeStep = { name: string; ok: boolean; detail: string };
type SyncStatus = {
  configured: boolean;
  state: string; // off | connecting | booting | online | offline
  account_id: string | null;
  device_id: string | null;
  server_url: string | null;
  peers_online: number;
  error: string | null;
  frozen: string[];
  suspended: number;
  skew: boolean;
  clock_skew: boolean;
};
type SyncOutcome = {
  space: string;
  name: string | null;
  outcome: string;
  progressed: boolean;
  detail: string | null;
};
type SyncAllReport = { outcomes: SyncOutcome[]; restore_error: string | null };
// 事件桥的统一信封(后端 bridge_emit):space 标 + 代次 + 原 payload。前端按
// 「space=当前 且 generation ≥ 该空间已见最大代次」过滤——切换/回滚/遍历恢复
// 会重激活同一空间,旧桥 buffer 里的迟到事件不许盖过新代次的状态(§12)。
type Spaced<T> = { space: string; generation: number; payload: T };

const seenGeneration: Record<string, number> = {};

function acceptSpaced(e: { space: string; generation: number }): boolean {
  if ((seenGeneration[e.space] ?? 0) > e.generation) return false;
  seenGeneration[e.space] = e.generation;
  return e.space === getCurrentSpace();
}

// 启动闸(工序 6):**默认封锁**——问闸之前不发任何数据面调用、不取分享暂存。
let gateBlocked = true;

// ---- 当前空间(影子在 api.ts,这里只剩切换编排的本地态) ----------------------

const LAST_SPACE_KEY = "zhujian.last-space";

let spacesCache: SpaceInfo[] = [];
let switching = false; // 切换编排进行中:禁保存/禁再切(后端 UserSwitching 拒兜底)
let renamingSpace = false; // 空间面板当前行的行内改名态
let resettingSpace: string | null = null; // 空间面板「重置」两拍确认中的行(epoch-plan §7)
let spaceMenuFor: string | null = null; // 空间行「⋯」展开态(ui-audit P1 #11:重置入口降权)

// ---- 主视图 mode(146):灵感/任务两面 = 同一条 live_timeline 的投影 ----------
// lastItems 恒存全量(卡片面板真值、跨面定位查 stage 都靠它),渲染按 mode 过滤;
// mode 从不压 history 层(不是层),启动恒落灵感面、不持久化。

type ViewMode = "ideas" | "tasks";
let viewMode: ViewMode = "ideas";
// 时间轴筛选(灵感/看板两面各持一份,同桌面 board/inbox 各自记忆自己的筛选):
// 切面保留、切空间清零。allFilterTopics 是带 kind 的全量标签(list_topics_full),
// 每轮刷新重取——类型轴的真相只在它上(per-item chip 不带 kind)。
const filters: Record<ViewMode, filter.FilterState> = {
  ideas: { kind: "all", topic: "all", text: "" },
  tasks: { kind: "all", topic: "all", text: "" },
};
let allFilterTopics: filter.FilterTopic[] = [];
// 用户主动导航(点 mode 钮)/开始保存 → ++,作废在途的 focus 定位(146 ▲M2/▲▲M3:
// 旧定位的内部切面不许反抢用户刚选的面、不许打破保存的「新卡在当前面」承诺)。
let navSeq = 0;
// 「记下」single-flight(146 ▲H1):在飞期间禁再点、禁 mode/pane/空间切换。
let captureSaving = false;
// 在飞期间发生过新输入/分享追加(哪怕后来又删空,实现审 L1):成功回执据此判
// 「用户正在打字」——不 blur、不抢焦点、不滚动;别用「框是否为空」当替身。
let captureLiveTouched = false;
// 草稿断电恢复(197 下一步①):compose 文字草稿走 localStorage(纯设备本地 UI 状态,
// 绝不进 DB/同步;图走 IndexedDB,见 images.ts)。输入即写、记下成功清、启动回填——
// 意外断电/杀进程后重开,上次没记下的文字还在。单条全局草稿(与文字框跨面/跨空间
// 复用同哲学,存到记下那刻落当前空间)。
const COMPOSE_DRAFT_KEY = "zhujian.compose-draft";
function persistComposeText(): void {
  const v = ($("text") as HTMLTextAreaElement).value;
  if (v) localStorage.setItem(COMPOSE_DRAFT_KEY, v);
  else localStorage.removeItem(COMPOSE_DRAFT_KEY);
}
$("text").addEventListener("input", () => {
  if (captureSaving) captureLiveTouched = true;
  persistComposeText();
});

// 记灵感时的暂存配图(195 slice1):点「加图」贴进 compose 暂存条,「记下」建条目后
// 随之挂上(save() 的两缓冲结算)。暂存不随切面/切空间清(与文字草稿同律),存到保存
// 那刻落到当前空间。取图/转码走共享件 images.ts,与卡片操作面「加图」同一套。
const compImgs = composeImages($("compose-thumbs"));
$("compose-addimg").addEventListener("click", async () => {
  if (captureSaving || switching) return; // 在飞/切换中不受理(与「记下」同闸)
  const file = await pickImage();
  if (!file) return;
  compImgs.add(file);
  if (captureSaving) captureLiveTouched = true; // 罕见:选图期间「记下」在飞=新输入
  ($("text") as HTMLTextAreaElement).focus(); // 贴完回到输入,顺手写配文
});

// stage → 主视图归属。穷尽映射,未知值响亮抛(铁律:不写兜底)。
const MODE_OF_STAGE: Record<string, ViewMode> = {
  inbox: "ideas",
  filed: "ideas",
  todo: "tasks",
  doing: "tasks",
  confirming: "tasks",
  done: "tasks",
};
function modeOfStage(stage: string): ViewMode {
  const m = MODE_OF_STAGE[stage];
  if (!m) throw new Error(`未知 stage:${stage}`);
  return m;
}

// 任务面四态分组(看板列同一套中文、固定顺序,空组不显;组内沿时间倒序——
// 手机不读 position/不做拖排,组内时间序是本端自己的确定性顺序,146 §2.1)。
const TASK_SECTIONS: { stage: string; label: string }[] = [
  { stage: "todo", label: "待办" },
  { stage: "doing", label: "进行中" },
  { stage: "confirming", label: "待确认" },
  { stage: "done", label: "已完成" },
];

// ---- 统一时间轴 -------------------------------------------------------------

function renderCard(it: TimelineItem): string {
  const label = STAGE_LABEL[it.stage];
  const isTask = label !== undefined;
  const done = it.stage === "done";
  const tick = isTask
    ? `<label class="tick"><input type="checkbox" data-id="${esc(it.id)}"
         ${done ? "checked disabled" : ""} /><span class="box"></span></label>`
    : "";
  const pill = isTask ? `<span class="pill">${label}</span>` : "";
  const chips = it.topics
    .map(
      (t) =>
        `<span class="chip"${t.color ? ` style="--tc:${esc(t.color)}"` : ""}>${esc(t.title)}</span>`,
    )
    .join("");
  // 配图缩略(117):只渲染占位框,字节滚到可视区才拉(thumbObserver)。
  const thumbs = it.images.length
    ? `<div class="thumbs">${it.images
        .map(
          (im) =>
            `<button class="thumb" data-img="${esc(im.id)}" data-seq="${im.seq}"
               aria-label="查看图${im.seq}"><span class="tag-n">图${im.seq}</span><span class="thumb-del" role="button" aria-label="删除图${im.seq}">×</span></button>`,
        )
        .join("")}</div>`
    : "";
  // 120:data-id 供卡片操作面板定位;截止/优先级角标(任务行、有值才显)。
  const meta: string[] = [];
  if (it.due_on) meta.push(`<span class="chip">截止 ${esc(it.due_on)}</span>`);
  if (it.priority) meta.push(`<span class="chip">${["", "低", "中", "高"][it.priority]}优先</span>`);
  // 完成时刻(0030):已完成卡显示「完成于 <时刻>」;done_at 为 null(本功能前完成的老卡)则不显示。
  const doneAt = done && it.done_at ? `<time class="done-at">完成于 ${esc(fmtWhen(it.done_at))}</time>` : "";
  return `<article class="card${done ? " done" : ""}" data-id="${esc(it.id)}">${tick}<div class="body">
    <p class="content">${esc(it.content)}</p>${thumbs}
    <footer>${pill}<time>${esc(fmtWhen(it.created_at))}</time>${doneAt}${meta.join("")}${chips}</footer>
  </div></article>`;
}

// 时间轴最新一次渲染的条目快照(卡片操作面板的真值来源;refreshOnce 每轮重建)。
let lastItems = new Map<string, TimelineItem>();

// ---- 配图:取图去重 + 缩略图降采样缓存 + 点开大图(117;codex H1/M1) ----------
// 内存纪律:**全尺寸 data URL 一律不缓存**(单图协议上限 32MiB,Base64 后 ~43MiB,
// 存几张就把 WebView 撑爆)——缩略图取回后立刻降采样成小图(短边 144px,~几 KB)
// 只缓存小图;大图只在查看器打开时取、关闭即置空 src 释放。缓存键带空间标,
// 图不可变(删图=编号退役不复用)故小图永不过期。

const thumbCache = new Map<string, string>(); // `${space}/${imageId}` → 降采样小图
const imgPending = new Map<string, Promise<string>>(); // 取图 in-flight 去重

/** 全尺寸图的一次取回(IPC 去重;空间已切走 = 返回 null,调用方直接放弃——
 *  刻意不走 sinvoke 的「永不决议」:悬挂的 Promise 会把 pending 表堵死,切回
 *  该空间后同一张图就再也取不到了)。`space` 由调用方显式传「发起那一刻的
 *  空间」(codex 三审:排队醒来重读 currentSpace 会拿 A 空间的 key 去查 B 库,
 *  撞 ID 时错图进 A 缓存)。 */
function fetchImageUrl(space: string, id: string): Promise<string | null> {
  const key = `${space}/${id}`;
  let p = imgPending.get(key);
  if (!p) {
    p = getItemImage(space, id).finally(() => imgPending.delete(key));
    imgPending.set(key, p);
  }
  return p.then((url) => (getCurrentSpace() === space ? url : null));
}

/** 降采样:**一律过 canvas 重编码成 ≤144×144 的 cover 方裁**(codex 二审:原图
 *  哪怕像素尺寸小也可能字节巨大[多帧/元数据],直接放原 URL 进缓存 = 缓存无界;
 *  只钉短边则超宽长图 thumb 仍巨大——两边都钉死)。小图不放大,但照样重编码。
 *  解码失败响亮抛给调用方标错框。 */
const THUMB_PX = 144;
async function shrinkToThumb(url: string): Promise<string> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("图片解码失败"));
    img.src = url;
  });
  const crop = Math.min(img.naturalWidth, img.naturalHeight); // 原图中央方形
  const side = Math.min(THUMB_PX, crop);
  const c = document.createElement("canvas");
  c.width = side;
  c.height = side;
  c.getContext("2d")!.drawImage(
    img,
    (img.naturalWidth - crop) / 2,
    (img.naturalHeight - crop) / 2,
    crop,
    crop,
    0,
    0,
    side,
    side,
  );
  return c.toDataURL("image/jpeg", 0.8);
}

// 缩略管线(取字节+解码+降采样)全局并发闸 = 2(codex 二审:可视区一次能冒出
// 几十张占位框,imgPending 只并单同一张图、拦不住几十张不同图同时全尺寸解码
// ——12MP 一张解码 ~48MiB,十张就几百 MiB)。排队的醒来直接继承坑位。
let thumbSlots = 2;
const thumbQueue: (() => void)[] = [];
async function withThumbSlot<T>(f: () => Promise<T>): Promise<T> {
  if (thumbSlots === 0) {
    await new Promise<void>((res) => thumbQueue.push(res));
  } else {
    thumbSlots--;
  }
  try {
    return await f();
  } finally {
    const next = thumbQueue.shift();
    if (next) next();
    else thumbSlots++;
  }
}

async function fillThumb(btn: HTMLElement) {
  const id = btn.dataset.img!;
  const space = getCurrentSpace(); // 发起那一刻的空间,全程显式带着(排队醒来不重读)
  const key = `${space}/${id}`;
  let small = thumbCache.get(key);
  if (!small) {
    try {
      small =
        (await withThumbSlot(async () => {
          if (getCurrentSpace() !== space) return null; // 排队期间切走:放弃,不查错库
          const cached = thumbCache.get(key); // 排队期间别人可能已做完
          if (cached) return cached;
          const full = await fetchImageUrl(space, id);
          if (!full) return null; // 空间已切走:时间轴整个重画了,别再动旧节点
          const s = await shrinkToThumb(full);
          thumbCache.set(key, s);
          return s;
        })) ?? undefined;
      if (!small) return;
    } catch {
      // 极窄窗口(刷新与取图之间图被远端删)或暂态读错:亮错标,点一下可重试;
      // 真删掉的图下次 sync-changed 刷新就整个消失。不打全局错误条。
      btn.classList.add("err");
      return;
    }
  }
  if (!btn.isConnected) return; // 期间时间轴重建了:小图已入缓存,新节点直取
  if (!btn.querySelector("img")) {
    const img = document.createElement("img");
    img.src = small;
    img.alt = `图${btn.dataset.seq}`;
    btn.prepend(img);
  }
}

// 滚到可视区才拉字节(时间轴是全量列表,启动就把每张图都过一遍 IPC 太重;并发
// 天然被视口束住)。observer 只认「当前这代」占位框——refresh 重建 DOM 前必须
// disconnect,否则未进过视区的旧节点被 observer 长期钉住(codex M1 泄漏)。
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    void fillThumb(e.target as HTMLElement);
  }
});

function hydrateThumbs(scope: HTMLElement) {
  scope.querySelectorAll<HTMLElement>(".thumb[data-img]").forEach((btn) => {
    if (thumbCache.has(`${getCurrentSpace()}/${btn.dataset.img}`)) {
      void fillThumb(btn); // 小图现成:直接填,省一轮 observer 回调。
    } else {
      thumbObserver.observe(btn);
    }
  });
}

// ---- 返回键层账本(143):安卓返回键的第一本能是「关掉当前层」,此前直接退 app。
// WryActivity 内建「WebView 有历史先 goBack」,故开层(面板/大图)pushState 压一枚
// 守门条目,返回键触发 popstate 时关最上层;UI 主动关层则补一记 history.back() 把
// 守门条目消掉(popSuppress 标记让 popstate 只记账不再关层),账本与屏幕恒一致。
let histDepth = 0;
// popSuppress 兼任「back 在飞」标志(146 ▲▲M4):settleHistory 发出的 history.back()
// 到对应 popstate 之间,histDepth 还没递减——这段窗口内再调 settleHistory 会看着
// histDepth>0 又 back 一次(双弹)。settle 只在无 back 在飞时发;窗口内的开层请求
// DOM 照开、pushState 挂账(deferredLayers),popstate 收口后补压——账本与屏幕恒一致,
// 绝不让 pushState 与 back 乱序。
let popSuppress = 0;
let deferredLayers = 0;

function pushLayer() {
  if (popSuppress > 0) {
    deferredLayers++; // back 在飞:挂账,收口后补压(histDepth 由补压处递增)
    return;
  }
  histDepth++;
  history.pushState({ layer: histDepth }, "");
}

/** UI 主动收层之后调:消掉守门条目。层是 popstate 关的就不要再调。 */
function settleHistory() {
  if (deferredLayers > 0) {
    deferredLayers--; // 这层还没压进历史(挂账中):直接销账,不发 back
    return;
  }
  if (nativeBackPending) {
    // native 的 back 在飞、正要弹的就是这枚守门条目(codex 终局审 M1:此窗口内
    // 用户点 UI 关层,层已由 UI 关掉——把在飞的 pop 归因成本次 settle,改记
    // suppressed,popstate 到达时只记账不再关层;绝不再补发第二记 back)。
    nativeBackPending = false;
    popSuppress++;
    return;
  }
  if (popSuppress > 0) return; // 已有 back 在飞:幂等 no-op,收口时账目自然对齐
  if (histDepth > 0) {
    popSuppress++;
    history.back();
  }
}

// Kotlin 侧返回键的原子入口(146,codex 补审 M1/M2):判断+消费一体,返回 true=
// 本次返回已被页面消费,false=无层可关(Kotlin 走系统默认路退 app)。
// WebView.canGoBack() 对 pushState 同文档条目返回 false(真机取证),native 判定
// 不可用——账本是唯一真相源。窄窗全在这里收口:
// - 扫码层优先(它不压 history 层):走既有取消路收相机,消费本次返回;
// - back 在飞(native 发的/settleHistory 发的)期间重复按:合并吞掉,绝不补发
//   history.back()(双 pop 会把守门账本打穿);
// - 挂账层(deferredLayers,back 在飞窗口内开的层):没有已压的历史条目可弹,
//   直接关最上层并销账。
let nativeBackPending = false; // native 请求的 history.back() 已发、popstate 未归

(window as unknown as Record<string, unknown>).__zhujianHandleBack = (): boolean => {
  if (document.body.classList.contains("scanning")) {
    dismissScanOverlay(); // 扫码层收掉(UI 收尾不等插件),下面的面板/时间轴原地不动
    return true;
  }
  // 挂账层必须先于「在飞合并」判(codex 终局审 M1):deferredLayers 只在
  // popSuppress>0 窗口内产生,后判就永远够不着——「UI 关层 back 在飞→重开层→
  // 硬件返回」会被合并吞掉、重开的层却还开着。挂账层没有已压的历史条目,直关销账。
  if (deferredLayers > 0) {
    if (!$("viewer").hidden) closeViewerNow();
    else if (activePane !== null) closePaneNow();
    settleHistory(); // 销挂账(settleHistory 首分支),不发 back
    return true;
  }
  if (nativeBackPending || popSuppress > 0) return true; // back 在飞:合并
  if (histDepth > 0) {
    nativeBackPending = true;
    history.back();
    return true;
  }
  return false;
};

window.addEventListener("popstate", () => {
  nativeBackPending = false; // native 发的 back 已归账
  histDepth = Math.max(0, histDepth - 1);
  if (popSuppress > 0) {
    popSuppress--;
    while (deferredLayers > 0) {
      deferredLayers--; // back 已收口:把窗口内挂账的层补压进历史
      histDepth++;
      history.pushState({ layer: histDepth }, "");
    }
    return;
  }
  if (!$("viewer").hidden) {
    closeViewerNow();
    return;
  }
  if (activePane !== null) closePaneNow();
  // 都没开 = 陈旧守门条目(空间切换复位等已把层收掉):静默吞,再按一次才退 app。
  // mode 从不压层:任务面按返回与灵感面同账,直接退 app(146 §2.3)。
});

// 大图查看:全屏覆盖层。未放大时单击关(260ms 让位双击判定)、双击 2.5 倍/复位、
// 双指捏合 1~8 倍、放大后单指拖拽平移、返回键关(history 层)。全图每次打开现取
// (IPC 去重内已并单),关闭即置空 src——大图字节不驻留。请求带代次(codex 二审):
// 快速连点几张图,迟到的旧响应不许盖掉最新点击;关闭也推代次,在途响应作废不复弹。
let viewerSeq = 0;
let viewerImgId: string | null = null; // 当前大图的 image id(删图按钮据此删这张)
async function openViewer(id: string, seq: string) {
  const my = ++viewerSeq;
  hideConfirmBar(); // 开大图 = 放弃挂着的两拍确认(确认条 z 在查看器之上,别浮在图上)
  const space = getCurrentSpace(); // 点击那一刻的空间(切走后 fetchImageUrl 返 null 即弃)
  try {
    const url = await fetchImageUrl(space, id);
    if (!url || my !== viewerSeq) return;
    viewerImgId = id; // 现显的这张(删图按钮据此),迟到响应被 my!==viewerSeq 挡在上面
    resetZoom(); // 换图不继承上一张的缩放
    const img = $("viewer-img") as HTMLImageElement;
    img.src = url;
    img.alt = `图${seq}`; // 读屏语义与角标同源
    $("viewer-cap").textContent = `图${seq}`;
    if ($("viewer").hidden) {
      $("viewer").hidden = false;
      pushLayer();
    }
  } catch (err) {
    if (my === viewerSeq) showError(String(err));
  }
}

function closeViewerNow() {
  viewerSeq++; // 在途的打开请求作废
  viewerImgId = null;
  hideConfirmBar(); // 关图即弃挂着的删图确认(旧确认不许作用到下一张/下个语境)
  $("viewer").hidden = true;
  ($("viewer-img") as HTMLImageElement).src = ""; // 释放大图
  resetZoom();
}

// -- 查看器手势(143):transform = translate(t) scale(s),原点为 img 布局中心。
// 页面级缩放已在 viewport 锁死,这里自己接管指针;基座矩形在图片 load 时量一次
//(查看器开着期间布局静止)。捏合公式:中点下的图像点保持在中点下。
const viewerImgEl = $("viewer-img") as HTMLImageElement;
let vScale = 1;
let vTx = 0;
let vTy = 0;
let vBase = { cx: 0, cy: 0, w: 0, h: 0 };
let suppressClick = false; // 手势(捏合/拖拽)收尾时 WebView 可能补发 click:吞掉
let closeTimer: number | undefined;
let lastTap = { t: 0, x: 0, y: 0 };

function applyTransform(anim = false) {
  const identity = vScale === 1 && vTx === 0 && vTy === 0;
  viewerImgEl.style.transition = anim ? "transform 0.18s ease-out" : "";
  viewerImgEl.style.transform = identity ? "" : `translate(${vTx}px, ${vTy}px) scale(${vScale})`;
  // 放大/拖动中「图N」角标是噪音,且 transform 不改布局、放大后必与图重合:淡出,复位再现。
  $("viewer").classList.toggle("zoomed", !identity);
}

function resetZoom() {
  vScale = 1;
  vTx = 0;
  vTy = 0;
  viewerImgEl.style.transition = "";
  viewerImgEl.style.transform = "";
  $("viewer").classList.remove("zoomed");
}

viewerImgEl.addEventListener("load", () => {
  resetZoom(); // 量未变换的布局盒
  const r = viewerImgEl.getBoundingClientRect();
  vBase = { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height };
});

/** 出界钳位:图比视口大时不许拖出黑边,比视口小的轴回中。 */
function clampView() {
  vScale = Math.min(8, Math.max(1, vScale));
  const hw = (vBase.w * vScale) / 2;
  const hh = (vBase.h * vScale) / 2;
  const cl = (lo: number, hi: number, v: number) =>
    lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
  vTx = cl(window.innerWidth - vBase.cx - hw, hw - vBase.cx, vTx);
  vTy = cl(window.innerHeight - vBase.cy - hh, hh - vBase.cy, vTy);
}

const vPtrs = new Map<number, { x: number; y: number }>();
let gest: { s: number; tx: number; ty: number; d0: number; mx: number; my: number } | null = null;

function beginGesture() {
  const ps = [...vPtrs.values()];
  const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
  const my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
  const d0 = ps.length >= 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
  gest = { s: vScale, tx: vTx, ty: vTy, d0, mx, my };
}

$("viewer").addEventListener("pointerdown", (e) => {
  if (vPtrs.size === 0) suppressClick = false; // 新一轮手势:上一轮的抑制标志作废
  vPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  beginGesture();
});
$("viewer").addEventListener("pointermove", (e) => {
  if (!vPtrs.has(e.pointerId) || !gest) return;
  vPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const ps = [...vPtrs.values()];
  const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
  const my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
  if (ps.length >= 2) {
    const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
    const ns = Math.min(8, Math.max(1, (gest.s * d) / (gest.d0 || d)));
    const vx = (gest.mx - vBase.cx - gest.tx) / gest.s;
    const vy = (gest.my - vBase.cy - gest.ty) / gest.s;
    vScale = ns;
    vTx = mx - vBase.cx - ns * vx;
    vTy = my - vBase.cy - ns * vy;
    suppressClick = true;
  } else if (vScale > 1.01) {
    vTx = gest.tx + (mx - gest.mx);
    vTy = gest.ty + (my - gest.my);
    if (Math.hypot(mx - gest.mx, my - gest.my) > 8) suppressClick = true;
  } else {
    return;
  }
  clampView();
  applyTransform();
});
const viewerPtrEnd = (e: PointerEvent) => {
  vPtrs.delete(e.pointerId);
  if (vPtrs.size) beginGesture(); // 双指抬一指:剩下的手指重新起基准,不跳变
  else gest = null;
};
$("viewer").addEventListener("pointerup", viewerPtrEnd);
$("viewer").addEventListener("pointercancel", viewerPtrEnd);

$("viewer").addEventListener("click", (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const now = Date.now();
  const dbl = now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
  if (dbl) {
    window.clearTimeout(closeTimer);
    lastTap.t = 0;
    if (vScale > 1.01) {
      vScale = 1;
      vTx = 0;
      vTy = 0;
    } else {
      const vx = (e.clientX - vBase.cx - vTx) / vScale;
      const vy = (e.clientY - vBase.cy - vTy) / vScale;
      vScale = 2.5;
      vTx = e.clientX - vBase.cx - vScale * vx;
      vTy = e.clientY - vBase.cy - vScale * vy;
    }
    clampView();
    applyTransform(true);
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  if (vScale > 1.01) return; // 放大态单击不关(误触保护):双击复位或返回键关
  closeTimer = window.setTimeout(() => {
    closeViewerNow();
    settleHistory();
  }, 260);
});

// 删图(196):看大图时删这张。永久销毁(图无回收站、编号退役不复用),两拍确认——
// 确认条 z(17)在查看器(15)之上能盖住。stopPropagation 挡掉查看器自身的单击关/双击缩放。
// onYes 复核「还在看这张、空间没换」(期间换图/关闭/切空间一律作废);删成关查看器 +
// settleHistory(平掉开图压的历史层)+ 刷新轴(缩略图随之消失)。
$("viewer-del").addEventListener("click", (e) => {
  e.stopPropagation();
  const id = viewerImgId;
  if (!id) return;
  const space = getCurrentSpace();
  confirmBar("删除这张图?删了不可恢复", "删除", () => {
    if (viewerImgId !== id || getCurrentSpace() !== space) return;
    void (async () => {
      try {
        await deleteItemImage(space, id);
        closeViewerNow();
        settleHistory();
        await refresh();
        showBar("已删除该图", true);
      } catch (err) {
        showError(String(err));
      }
    })();
  });
});

// 编辑态多图管理(cardpanel 给 actions 面开着的卡片挂 .imgmanage 露出缩略图 ×):删这张图。
// 两拍确认,与查看器删图(197)同律(图无回收站、编号退役不复用);删成刷新轴,缩略图随之消失。
// actions 面无脏草稿,refresh 不被草稿闸延后(edit 面恒脏才有那问题,故删图放 actions 面)。
function confirmDeleteImage(space: string, id: string, seq: string) {
  confirmBar(`删除图${seq}?删了不可恢复`, "删除", () => {
    if (getCurrentSpace() !== space) return; // 期间切空间:作废
    void (async () => {
      try {
        await deleteItemImage(space, id);
        await refresh();
        showBar("已删除该图", true);
      } catch (err) {
        showError(String(err));
      }
    })();
  });
}

$("timeline").addEventListener("click", (e) => {
  if (switching) return; // 切换编排中:屏上还是旧空间的卡,不接受任何取图请求
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLElement>(".thumb[data-img]");
  if (!btn) return;
  if (target.closest(".thumb-del")) {
    // 露出的删图 ×(仅 .imgmanage 卡可见):两拍确认删,不落到看大图。
    confirmDeleteImage(getCurrentSpace(), btn.dataset.img!, btn.dataset.seq ?? "");
    return;
  }
  if (btn.classList.contains("err")) {
    btn.classList.remove("err"); // 暂态读错不判死:点一下重试
    void fillThumb(btn);
    return;
  }
  void openViewer(btn.dataset.img!, btn.dataset.seq ?? "");
});

// 读失败画在读的位置(时间轴区域),写失败亮在错误条——两个通道各管各的。
// single-flight + rerun(codex 二审):保存/勾完成/同步事件会重叠触发刷新——
// 并行跑两份,晚发先回时旧列表会盖掉新列表,且先回那份 observe 的占位框在后回
// 那份重建 DOM 后没人 disconnect(泄漏)。合并成一条在飞 + 循环重跑,**重入调用
// 拿到的是覆盖到最终一次重跑的同一个 Promise**(codex 四审:否则 await refresh()
// 在「已有在飞」时立即返回,切换路以为画完了、旧 DOM 还在屏上)。
// 刻意不走 sinvoke(它对迟到响应「永不决议」,会把在飞闸永久毒化):自己带空间标,
// 响应回来空间已切走 = 静默弃掉(错误同弃、不碰 DOM),现任那轮自己负责重建。
let refreshRun: Promise<void> | null = null;
let rerunRefresh = false;

// 草稿保护(120,codex H1):编辑态/未提交的新标签输入在场时,任何一轮重画都
// 延后——查询前早退是快路,**await 之后、动 DOM 之前必须复检**(刷新已在飞、
// 用户随后进入编辑,旧响应回来仍会冲掉草稿);错误分支同检。延后用独立标志,
// 不复用 rerunRefresh(持续同步事件会把 rerun 循环空转)。草稿收场时补刷。
let refreshDeferred = false;
// 快照有效性单一标志(146 ▲▲M2,收敛原 lastRefreshOk):true = lastItems 是本空间
// 一次成功读取的全量快照且已落过 DOM。读失败/清屏置 false——失效期间 mode 切换
// **不许把旧快照投影回可点击卡**(错误页保留、顺手重试);focus 定位也据此区分
// 「读取失败」与「条目真的已离开」。
let lastRefreshOk = false;

/** 投影提交(146 ▲M1 统一函数):observer 断开 → 按当前 mode 过滤重建 DOM →
 *  缩略图 hydrate → 面板 restore,四步收在一处;refresh 落 DOM 与 mode 切换共用。
 *  **写 DOM 这一刻读当前 viewMode**,绝不用请求发起时的旧 mode。 */
function projectTimeline(): void {
  const box = $("timeline");
  thumbObserver.disconnect();
  const items = [...lastItems.values()];
  const modeItems = items.filter((i) => modeOfStage(i.stage) === viewMode);
  const f = filters[viewMode];
  // 死标签/死类型回落(纯状态,先于渲染 pills 与应用过滤,同桌面共享件次序)。
  filter.reconcileTopicFilter(f, allFilterTopics);
  filter.reconcileKindFilter(f, allFilterTopics);
  renderFilterBar(modeItems);
  const shown = filter.applyFilter(modeItems, f, (i) => i.content, allFilterTopics);
  if (viewMode === "ideas") {
    box.innerHTML = shown.length
      ? shown.map(renderCard).join("")
      : modeItems.length === 0
        ? `<p class="muted empty">还没有灵感。</p>`
        : filteredEmptyHtml(f);
  } else {
    box.innerHTML = shown.length
      ? TASK_SECTIONS.filter((s) => shown.some((t) => t.stage === s.stage))
          .map(
            (s) =>
              `<section class="tl-group"><h3 class="tl-sec">${s.label}</h3>${shown
                .filter((t) => t.stage === s.stage)
                .map(renderCard)
                .join("")}</section>`,
          )
          .join("")
      : modeItems.length === 0
        ? `<p class="muted empty">还没有任务。</p>`
        : filteredEmptyHtml(f);
  }
  hydrateThumbs(box);
  cardPanel.restore(box); // 展开态跨重画恢复(条目已不在=清态)
}

/** 筛选条:本面有条目才显示(空面无可筛)。类型行 + 标签行由 filter.ts 渲染,文本框
 *  是常驻元素(不随 pills 重建、打字不丢焦点),值在 applyMode/清筛处另行同步。 */
function renderFilterBar(modeItems: TimelineItem[]): void {
  const bar = $("filterbar");
  bar.hidden = modeItems.length === 0;
  if (modeItems.length === 0) return;
  const f = filters[viewMode];
  filter.renderKindPills($("filter-kinds"), modeItems, allFilterTopics, f, onFilterPick);
  filter.renderTopicPills($("filter-topics"), modeItems, allFilterTopics, f, onFilterPick);
}

/** 点 pill 的落点:先过草稿闸(卡片编辑未存时重投影会拆掉草稿),再改本面筛选状态
 *  并重投影(纯客户端,不重新拉数据)。切类型时 filter.ts 已带上 topic:"all"。 */
function onFilterPick(patch: Partial<filter.FilterState>): void {
  if (cardPanel.hasDirtyDraft()) {
    showError("先保存或取消正在编辑的内容");
    return;
  }
  Object.assign(filters[viewMode], patch);
  projectTimeline();
}

/** 筛空(本面有条目、被当前筛选滤没了)的空态文案:词优先,再标签,再类型——别让
 *  用户以为记录全没了。 */
function filteredEmptyHtml(f: filter.FilterState): string {
  const q = f.text.trim();
  if (q) return `<p class="muted empty">没有匹配「${esc(q)}」的记录。</p>`;
  if (f.topic === "none") return `<p class="muted empty">没有未打标签的记录。</p>`;
  const t = allFilterTopics.find((x) => x.id === f.topic);
  if (t) return `<p class="muted empty">「${esc(t.title)}」下没有记录。</p>`;
  if (f.kind !== "all") return `<p class="muted empty">「${esc(f.kind)}」类型下没有记录。</p>`;
  return `<p class="muted empty">没有匹配的记录。</p>`;
}

/** 清掉某面的筛选并同步文本框(新记录落该面时用,避免被停留的筛选藏起)。 */
function clearFilter(mode: ViewMode): void {
  const f = filters[mode];
  if (f.kind === "all" && f.topic === "all" && f.text === "") return;
  filters[mode] = { kind: "all", topic: "all", text: "" };
  if (mode === viewMode) ($("filter-text") as HTMLInputElement).value = "";
}

async function refreshOnce(): Promise<void> {
  if (cardPanel.hasDirtyDraft()) {
    refreshDeferred = true;
    return;
  }
  const space = getCurrentSpace();
  try {
    // 时间轴 + 带 kind 的全量标签一把取(同 space、同一轮):后者供筛选条的类型轴与
    // 标签色/死筛回落用(per-item chip 不带 kind、也不含当前无条目的标签)。
    const [items, ftopics] = await Promise.all([listTimeline(space), listTopicsFull(space)]);
    if (space !== getCurrentSpace()) return;
    if (cardPanel.hasDirtyDraft()) {
      refreshDeferred = true;
      return;
    }
    lastItems = new Map(items.map((i) => [i.id, i])); // 全量真值,只在成功读取后更新
    allFilterTopics = ftopics.map((t) => ({ id: t.id, title: t.title, color: t.color, kind: t.kind }));
    lastRefreshOk = true;
    projectTimeline();
  } catch (err) {
    if (space !== getCurrentSpace()) return;
    if (cardPanel.hasDirtyDraft()) {
      refreshDeferred = true;
      return;
    }
    thumbObserver.disconnect();
    $("timeline").innerHTML =
      `<p class="empty" style="color:var(--seal)">时间轴读取失败:${esc(String(err))}</p>`;
    lastRefreshOk = false; // 快照失效:mode 切换不投影、定位不误报"已归档"
  }
}

function refresh(): Promise<void> {
  if (refreshRun) {
    rerunRefresh = true;
    return refreshRun;
  }
  refreshRun = (async () => {
    do {
      rerunRefresh = false;
      await refreshOnce();
    } while (rerunRefresh);
  })().finally(() => {
    refreshRun = null;
  });
  return refreshRun;
}

/** 空间已切换(currentSpace 刚翻):旧空间的时间轴立即离场(codex 四审——旧 DOM
 *  多留一拍,点它的缩略图/勾框就会拿旧条目 id 打到新空间;清屏 = 没有可点的旧目标),
 *  随后的 refresh 负责画新空间。 */
function blankTimelineForSpaceChange(): void {
  refreshDeferred = false; // 旧空间欠的刷新作废:新空间马上整轴重拉
  cardPanel.forceClose("空间已切换,未保存的编辑已丢弃"); // 有草稿才响,静默无草稿路
  resetPanesForSpaceChange(); // 统一复位:关全部面 + 清陈旧内容 + 诊断缓存作废
  thumbObserver.disconnect();
  lastItems = new Map();
  lastRefreshOk = false; // 快照失效(146 ▲▲M2):新空间读到之前,mode 切换不许投影旧数据
  $("timeline").innerHTML = `<p class="muted empty">正在载入…</p>`;
}

// 勾「标完成」:写命令,带点击时看到的空间;成败都刷新,不吞错、不做静默幂等。
$("timeline").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.id;
  if (!id || input.disabled) return;
  if (switching) {
    input.checked = false; // 切换编排中:屏上还是旧空间的卡,勾选不受理、当场回弹
    return;
  }
  input.disabled = true;
  try {
    await completeTask(getCurrentSpace(), id);
  } catch (err) {
    showError(String(err));
  }
  await refresh();
});

// ---- 捕获(146:seg 两态删除,落点=当前主视图,placeholder 随面换) -----------

// ---- 系统分享入口(M4):原生侧暂存,这里一次性取走、只预填不自动保存 ----------
// 分享文本只是**预填草稿**(§16.2 提案 B):草稿不带目标空间,保存那刻结算。

let pullingShare = false;
let rerunShare = false;

async function pullSharedText() {
  if (gateBlocked) return;
  if (pullingShare) {
    rerunShare = true;
    return;
  }
  pullingShare = true;
  try {
    for (;;) {
      const text = await invoke<string | null>("take_shared_text");
      if (!text) break;
      const ta = $("text") as HTMLTextAreaElement;
      ta.value = ta.value.trim() ? `${ta.value}\n${text}` : text;
      persistComposeText(); // 分享追加的文字也持久化(程序改值不触发 input)
      if (captureSaving) captureLiveTouched = true; // 分享追加=在飞新输入(实现审 L1)
      ta.focus();
    }
  } catch (err) {
    showError(String(err));
  } finally {
    pullingShare = false;
    if (rerunShare) {
      rerunShare = false;
      void pullSharedText();
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void pullSharedText();
  void pullDeepLink(); // 回前台也取一次深链接(热启动 emit 可能丢,文件兜底)
  void initUpdate(); // 后台切回也查一次新版(否则只有冷启动才提示)
});
window.addEventListener("zhujian-share", () => void pullSharedText());
window.addEventListener("zhujian-deeplink", () => void pullDeepLink());

// ---- 深链接消费(4c,照抄分享薄桥)------------------------------------------
// zhujian://open?acc=<账户>&item=<条目> | space=<空间>&item=<条目>。take_deep_link 取走
// 原生暂存的 URI → 解析 → 匹本机空间(space= 按 id;acc= 走后端 find_space_by_account,因
// SpaceInfo 不暴露 account_id)→ 若非当前空间先切过去(异步、会停机)→ focusTimelineCard
// 定位高亮。与分享不同,深链接是一次性跳转、不做追加合并,简单 single-flight 去重即可。
// 回收站/归档册的条目 focusTimelineCard 会如实报「已不在」(v1 只覆盖灵感/任务两面)。
type ParsedDeepLink = { acc: string | null; space: string | null; item: string };
function parseDeepLink(raw: string): ParsedDeepLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "zhujian:" || u.host !== "open") return null;
  const item = u.searchParams.get("item");
  if (!item) return null;
  return { acc: u.searchParams.get("acc"), space: u.searchParams.get("space"), item };
}

let pullingDeepLink = false;
async function pullDeepLink(): Promise<void> {
  if (pullingDeepLink) return;
  pullingDeepLink = true;
  try {
    const raw = await invoke<string | null>("take_deep_link");
    if (!raw) return;
    const p = parseDeepLink(raw);
    if (!p) return;
    let target: string | null = null;
    if (p.space) {
      const spaces = await invoke<SpaceInfo[]>("list_spaces");
      target = spaces.find((s) => s.id === p.space)?.id ?? null;
    } else if (p.acc) {
      target = await invoke<string | null>("find_space_by_account", { accountId: p.acc });
    }
    if (!target) {
      showError("这条所在的空间不在这台设备上");
      return;
    }
    // 切到目标空间(若不同):switchSpace 是异步、有停机,返回即前台 runtime 就绪、
    // switching 已复位——之后再定位,躲开 focusTimelineCard 的 switching 守卫。
    if (target !== getCurrentSpace()) await switchSpace(target);
    await focusTimelineCard(p.item);
  } catch (e) {
    showError(String(e));
  } finally {
    pullingDeepLink = false;
  }
}

// 保存 = 写命令:显式携带「点击那刻看到的空间与 mode」,后端在协调状态内复核(切换中
// 响亮拒、目标已变响亮拒)。**两缓冲**(146 ▲H1▲▲M1,与 145 takeBatch「保存那刻冻结」
// 同律):点「记下」那刻**取走**草稿并清框,在飞期间的新输入/分享追加落进清空后的框
// (liveDraft),与已提交段互不沾染——绝不「保留全文再存一遍」(A 会重复入库)。
// 成功只消费取走的那份;失败放回(有新输入则合并,先写在前)。textarea 是静态节点、
// 从不重建,框内现值即 liveDraft 的单一真相源。刻意不走 sinvoke(§16.2-4)。
async function save() {
  const ta = $("text") as HTMLTextAreaElement;
  if (captureSaving) return;
  if (!ta.value.trim()) {
    // 图不能独立成条(条目正文非空):只贴图没写字时给可辨识提示,不静默无反应。
    if (compImgs.count() > 0) showError("先写点文字,图片作为配文一起记下");
    return;
  }
  if (cardPanel.hasDirtyDraft()) {
    // ▲▲M3:卡片草稿在场时保存后的 refresh 会被无限延后、新卡落不了 DOM——响亮拒。
    showError("先保存或取消正在编辑的内容");
    return;
  }
  const space = getCurrentSpace();
  const mode = viewMode; // 落点冻结在点击那刻,响应回来绝不重读
  const savingDraft = ta.value;
  ta.value = "";
  // 图与文字同刻冻结带走(两缓冲,同 takeBatch):在飞期间新贴的图属于下一条,清预览。
  const savingImgs = compImgs.takeBatch();
  localStorage.removeItem(COMPOSE_DRAFT_KEY); // 文字草稿同刻清(图持久化由 takeBatch 清)
  captureSaving = true;
  captureLiveTouched = false;
  navSeq++; // 作废在途 focus 定位:不许其内部切面打破「新卡在当前面」承诺
  const btn = $("save") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const capture = mode === "ideas" ? captureIdea : captureTodo;
    const newId = await capture(space, savingDraft);
    // 条目已建 → 把冻结的暂存图逐张挂上(失败按张计,条目在、图可去卡片「加图」重贴)。
    // 挂完再刷新,新卡带着缩略图一次呈现。
    if (savingImgs.length) {
      const failed = await compImgs.attachBatch(space, newId, savingImgs);
      if (failed > 0) showError(`有 ${failed} 张配图没挂上,可在该卡片「加图」重贴`);
    }
    // 新卡落 mode 面:清掉该面停留的筛选,免得刚记的记录被藏起(「记了却没出现」的
    // 错觉)。桌面在筛着标签时改为自动挂标签保留可见,安卓这版先取「清筛见新卡」的
    // 简单形(捕获不自动打标签,故没有可保留的标签维度)。
    clearFilter(mode);
    if (!captureLiveTouched) {
      // 在飞期间无新输入:现状回执——收键盘让新卡露出来,滚到顶闪一下
      // (ui-audit P1 #7:原 finally 无条件 ta.focus() 让键盘永不收、新卡被挡)。
      ta.blur();
      await refresh();
      const card = document.querySelector<HTMLElement>(`#timeline [data-id="${newId}"]`);
      if (card) {
        window.scrollTo({ top: 0 });
        card.classList.add("flash");
        window.setTimeout(() => card.classList.remove("flash"), 1200);
      }
    } else {
      // 用户正在续打(或分享追加了):不 blur、不抢焦点、不滚动,只刷新列表。
      await refresh();
    }
  } catch (err) {
    showError(String(err));
    // 失败:取走的那份放回。框里有新字就合并(先写的在前),光标置尾接着改。
    const live = ta.value;
    ta.value = live === "" ? savingDraft : `${savingDraft}\n${live}`;
    persistComposeText(); // 退回的文字重新持久化(程序改值不触发 input)
    compImgs.putBack(savingImgs); // 图同样退回预览条,可连同文字一起重试
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  } finally {
    captureSaving = false;
    btn.disabled = !!switching;
  }
}
$("save").addEventListener("click", save);

// ---- 空间面板(工序 7/8):列表可切、新建、当前空间改名、全部同步 --------------

// 单空间时「空间」概念整个隐藏(116 捕获徽章同源原则):徽章藏起、同步标题不带名,
// 空间面板从同步面底部「空间…」兜底可达;多空间时徽章即入口、兜底收起。三个状态
// 在同一处原子维护,启动时静态 HTML 徽章即 hidden,不闪。
function renderSpaceChip() {
  const cur = spacesCache.find((s) => s.id === getCurrentSpace());
  const single = spacesCache.length <= 1;
  const chip = $("space-chip") as HTMLButtonElement;
  chip.hidden = single;
  chip.textContent = cur ? spaceLabel(cur) : "默认空间";
  $("sync-spaces-btn").hidden = !single;
  $("sync-title").textContent = single ? "同步" : `同步 · ${cur ? spaceLabel(cur) : "默认空间"}`;
}

function renderSpaceList() {
  const box = $("space-list");
  box.innerHTML = spacesCache
    .map((s) => {
      const label = esc(spaceLabel(s));
      if (s.current && renamingSpace) {
        return `<div class="space-row current">
          <input class="rename" id="space-rename-input" value="${esc(s.name ?? "")}"
                 placeholder="${label}" autocapitalize="off" autocomplete="off" />
          <button class="act" data-rename-ok="1">确定</button>
          <button class="act" data-rename-cancel="1">取消</button>
        </div>`;
      }
      // 重置两拍确认(epoch-plan §7,multispace §20 门 4 的警告义务):红字说清
      // 「删的是本机副本、须另一台在线完整副本、旧设备身份报运营者吊销」。
      // 确认钮全宽独行、与「取消」拉开(ui-audit P1 #11:别让最重操作挨着毗邻控件)。
      if (resettingSpace === s.id) {
        // 重置话术分流(space-entry-plan §5):已开同步的空间=清本机副本、可重新
        // 加入;仅本机的本子=删除**唯一副本**,不再用「清库重配」安抚。
        const warnText = s.configured
          ? `将删除本机此空间的全部数据,不可恢复。确认另一台设备有在线完整副本后再继续;
              重置后可用「加入空间」重新加入,旧设备身份请告知运营者吊销。`
          : `此空间未开启同步,本机就是**唯一副本**——重置=永久删除这个本子的全部内容,
              没有任何地方可以找回。`;
        return `<div class="space-row current" data-space="${esc(s.id)}">
          <div style="flex:1">
            <div>${label}</div>
            <div class="tag warn" style="display:block;white-space:normal">${warnText}</div>
            <button class="act warn reset-confirm" data-reset-ok="${esc(s.id)}">确认重置(删除本机数据)</button>
            <button class="act reset-cancel" data-reset-cancel="1">取消</button>
          </div>
        </div>`;
      }
      const tag = s.current
        ? `<span class="tag" style="color:var(--seal)">当前</span>`
        : s.configured
          ? ""
          : `<span class="tag">仅本机</span>`;
      // 「重置」= 删本机全部数据的最重操作,不常驻行上(ui-audit P1 #11):收进「⋯」。
      const act =
        (s.current ? `<button class="act" data-rename="1">改名</button>` : "") +
        `<button class="act" data-more="${esc(s.id)}" aria-label="更多操作">⋯</button>`;
      const more =
        spaceMenuFor === s.id
          ? `<div class="space-row sub"><button class="act warn" data-reset="${esc(s.id)}">重置(删除本机此空间数据)…</button></div>`
          : "";
      return `<div class="space-row${s.current ? " current" : ""}" data-space="${esc(s.id)}">
        <button class="sname" data-switch="${esc(s.id)}">${label}</button>${tag}${act}
      </div>${more}`;
    })
    .join("");
}

async function refreshSpaces() {
  try {
    spacesCache = await listSpaces();
  } catch (err) {
    showError(String(err));
    return;
  }
  renderSpaceChip();
  renderSpaceList();
}

/** 空间切换后的整页重拉(chip/列表/同步状态/时间轴)。幂等,多来一次无害。 */
/** 同步面的一次性展示态全体复位:出码页/恢复码/连接信息/辅路折叠与输了一半的码。
 *  切空间必调——旧空间的恢复码挂在新空间的同步页上=把错误密钥当新空间的交付
 *  (codex 实现审必修 1);空间重置后同理。 */
function resetSyncTransient() {
  $("sync-pair-out").hidden = true;
  const recovery = $("sync-recovery");
  recovery.hidden = true;
  recovery.textContent = "";
  $("sync-recovery-note").hidden = true;
  $("sync-info").hidden = true;
  resetSecondary();
}

async function onSpaceChanged() {
  renderSpaceChip();
  // 出码页属于旧空间的会话,切走即失效(旧配对流由 stop→core 收口烧槽)。
  resetSyncTransient();
  await refreshSpaces();
  void sinvoke<SyncStatus>("sync_status").then(renderSync).catch(() => {});
  await refresh();
}

/** 与后端 foreground 对账:不一致就跟上(后端是权威,§16.2 提案 B)。 */
async function reconcileForeground() {
  try {
    const fg = await invoke<string>("foreground_space");
    if (fg !== getCurrentSpace()) {
      setCurrentSpace(fg);
      blankTimelineForSpaceChange(); // 同 switchSpace:过期 DOM 不许多留一拍
      localStorage.setItem(LAST_SPACE_KEY, fg);
      await onSpaceChanged();
    }
  } catch {
    /* 封锁态/极端错误:保持现状。 */
  }
}

async function switchSpace(id: string) {
  if (switching || captureSaving || id === getCurrentSpace()) return;
  if (cardPanel.hasDirtyDraft()) {
    // 用户主动切换(含新建空间后的自动切)被草稿挡下;后端强制的前台变更走
    // reconcileForeground → blankTimelineForSpaceChange 丢草稿并响一声。
    showError("先保存或取消正在编辑的内容,再切换空间");
    return;
  }
  switching = true;
  ($("save") as HTMLButtonElement).disabled = true;
  try {
    await invoke("activate_space", { spaceId: id });
    setCurrentSpace(id);
    blankTimelineForSpaceChange(); // 旧空间 DOM 立即离场,不留可点的过期目标
    localStorage.setItem(LAST_SPACE_KEY, id);
    await onSpaceChanged();
  } catch (err) {
    showError(String(err));
    await reconcileForeground(); // 失败已回滚(§9):对账回真前台。
  } finally {
    switching = false;
    ($("save") as HTMLButtonElement).disabled = false;
  }
}

// ---- 单一 activePane(120,codex L11):空间/同步/搜索/回收站/归档册/诊断
// 同刻只开一个;开合都过草稿闸(编辑中不许把面从脚下抽走)。 ------------------

const PANE_EL: Record<string, string> = {
  spaces: "spaces",
  sync: "sync",
  search: "search-pane",
  trash: "trash-pane",
  sealed: "sealed-pane",
  topics: "topics-pane",
  diag: "diag",
};
let activePane: string | null = null;

/** 底栏高亮的单一渲染点(146 ▲M3):pane 开着高亮 pane 钮,否则高亮当前 mode 钮
 *  ——popstate/closePaneNow 关面后必须回到 mode 高亮,不能清光。 */
function renderBottomBar() {
  document.querySelectorAll<HTMLButtonElement>("#bottombar button").forEach((b) => {
    b.classList.toggle(
      "active",
      activePane !== null ? b.dataset.pane === activePane : b.dataset.mode === viewMode,
    );
  });
}

/** 关面回时间轴的 DOM 部分(143 拆出):popstate(返回键)与 UI 关面共用;
 *  history 账目由调用方处置——UI 关面随后 settleHistory(),popstate 已经弹掉。 */
function closePaneNow() {
  activePane = null;
  hideConfirmBar(); // 关面 = 放弃面内挂着的两拍确认(ui-audit P0 #4)
  for (const id of Object.values(PANE_EL)) $(id).hidden = true;
  document.body.classList.remove("pane-open"); // 恢复 compose+时间轴
  renderBottomBar();
}

function openPane(name: string) {
  if (switching || captureSaving) return; // 146 ▲▲M3:切换编排/保存在飞期间面不动
  if (cardPanel.hasDirtyDraft()) {
    showError("先保存或取消正在编辑的内容");
    return;
  }
  if (activePane === name) {
    closePaneNow(); // 再点同一入口 = 收面(toggle)
    settleHistory();
    return;
  }
  const wasOpen = activePane !== null;
  activePane = name;
  hideConfirmBar(); // 面换面:上一面挂着的确认作废
  for (const [key, id] of Object.entries(PANE_EL)) $(id).hidden = key !== name;
  document.body.classList.add("pane-open"); // 开面板接管视图:收 compose+时间轴
  renderBottomBar();
  if (!wasOpen) pushLayer(); // 首层才压守门条目;面换面同层,返回键一次回时间轴
  if (name === "spaces") {
    spaceMenuFor = null; // 重开面板不带上次的「⋯」展开残留
    void refreshSpaces();
  }
  else if (name === "trash") void panes.loadTrash();
  else if (name === "sealed") void panes.loadSealed();
  else if (name === "topics") void topics.loadTopics();
  else if (name === "search") panes.focusSearch();
  else if (name === "diag" && !diagLoaded) {
    diagLoaded = true;
    loadDb();
    runProbe();
  }
}

// ---- 主视图切换(146 §2.3 状态机) --------------------------------------------

/** 切面落地:翻 mode → placeholder/底栏高亮 → 投影。快照失效(读失败/清屏中)时
 *  不投影旧数据——错误页/载入页保留,顺手触发一次重试(▲▲M2)。 */
function applyMode(target: ViewMode) {
  viewMode = target;
  ($("text") as HTMLTextAreaElement).placeholder =
    target === "ideas" ? "记一笔灵感…" : "记一件待办…";
  ($("filter-text") as HTMLInputElement).value = filters[target].text; // 各面记忆自己的过滤词
  renderBottomBar();
  if (lastRefreshOk) projectTimeline();
  else void refresh();
}

/** 底栏 mode 钮:受理条件 !switching && !captureSaving;卡片编辑草稿挡切面
 *  (compose 草稿不挡,随面走);pane 开着=先关面(settleHistory 恰一次,由
 *  openPane 的 toggle 路负责),关面后不自动弹键盘;无 pane 重复点当前面=聚焦
 *  输入框(143「一步回捕获」推广到两面)。 */
function onModeButton(target: ViewMode) {
  if (switching || captureSaving) return;
  if (cardPanel.hasDirtyDraft()) {
    showError("先保存或取消正在编辑的内容");
    return;
  }
  navSeq++; // 用户主动导航:作废在途 focus 定位(▲M2)
  const hadPane = activePane !== null;
  if (hadPane) openPane(activePane!); // toggle 关面(无草稿必然关成)
  if (target === viewMode) {
    if (!hadPane) ($("text") as HTMLTextAreaElement).focus();
    return;
  }
  applyMode(target);
}

/** 空间变化的统一复位(实现审 M5):关全部面、activePane 归零、诊断缓存作废
 *  (diagLoaded 跨空间残留会把 A 空间的库信息端给 B)、低频面内容清空。 */
function resetPanesForSpaceChange() {
  closePaneNow();
  settleHistory(); // 守门条目同轮消掉,不给返回键留「按一下没反应」的空炮
  diagLoaded = false;
  $("db").innerHTML = `<span class="muted">读取中…</span>`;
  $("probe").innerHTML = `<span class="muted">未运行</span>`;
  panes.resetPanesForSpaceChange();
  topics.resetTopicsForSpaceChange();
  // 筛选是 A 空间的标签 id/词,绝不带进 B 空间(allFilterTopics 随下轮刷新重取)。
  filters.ideas = { kind: "all", topic: "all", text: "" };
  filters.tasks = { kind: "all", topic: "all", text: "" };
  allFilterTopics = [];
  ($("filter-text") as HTMLInputElement).value = "";
}

/** 远端变更时活动面也要跟上(实现审 M6):回收站/归档册打开着就重载,不给
 *  幽灵条目;搜索维持「显式点搜」契约不自动重跑。 */
function refreshActivePane() {
  if (activePane === "trash") void panes.loadTrash();
  else if (activePane === "sealed") void panes.loadSealed();
  // 标签面:拖动/类型编辑进行中不被动重载(免把正在操作的行从脚下拆掉),空闲才重读。
  else if (activePane === "topics" && !topics.topicsInteracting()) void topics.loadTopics();
  cardPanel.onRemoteChanged(); // tags 面的标签集标脏重读
}

/** 搜索命中活跃条目:收面 + 按条目 stage 切到它住的面(146 起灵感/任务分面)+ 滚到
 *  那张卡并闪一下(定位,不自动开操作面板——与桌面「跳看板高亮」同一克制)。
 *  codex H3:草稿在场时 openPane 会拒绝关面(卡还盖着,滚下去看不见),故先响亮拒、不跳。
 *  codex H4:目标可能还没进 timeline DOM——关面后先 await refresh() 把快照刷到最新再找;
 *  仍找不到(归档/入册/删的窄窗)响亮提示、不静默吞。
 *  ▲M2:内部为定位切面不作废自己;用户点 mode 钮/开始保存(navSeq++)则作废本次定位。 */
let focusSeq = 0;
async function focusTimelineCard(id: string) {
  if (cardPanel.hasDirtyDraft()) {
    showError("先保存或取消正在编辑的内容");
    return;
  }
  const space = getCurrentSpace();
  const seq = ++focusSeq;
  const nav = navSeq;
  if (activePane) openPane(activePane); // 发起面本身无草稿,必然关成
  await refresh(); // 快照刷到最新,避免目标卡尚未落 DOM 就判"找不到"
  // await 期间用户可能切空间 / 再点定位 / 手动切面或保存(navSeq)/ 开别的面 / 进编辑 /
  // 正切换编排(codex 二审 H2 + ▲▲M3):任一发生就放弃这次旧定位,让最新动作赢。
  if (
    seq !== focusSeq ||
    nav !== navSeq ||
    space !== getCurrentSpace() ||
    switching ||
    captureSaving ||
    activePane !== null ||
    cardPanel.hasDirtyDraft()
  ) {
    return;
  }
  if (!lastRefreshOk) {
    showError("时间轴读取失败,稍后再试"); // 读失败 ≠ 条目已离开,别误报
    return;
  }
  const item = lastItems.get(id); // 全量真值:住哪个面由 stage 定(穷尽映射)
  if (!item) {
    showError("这条记录已不在(可能已归档或入册)");
    return;
  }
  const target = modeOfStage(item.stage);
  if (target !== viewMode) applyMode(target); // 快照有效,applyMode 同步投影
  const card = document.querySelector<HTMLElement>(`#timeline [data-id="${id}"]`); // ULID 仅字母数字,选择器安全
  if (!card) {
    showError("这条记录已不在(可能已归档或入册)");
    return;
  }
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.add("flash");
  window.setTimeout(() => card.classList.remove("flash"), 1200);
}

// 点头部「朱笺」= 回时间轴(143):面板开着就收面,和「再点一次入口」同一条 toggle 路。
document.querySelector("header h1")!.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("#space-chip")) return; // chip 自己开空间面板
  if (activePane !== null) openPane(activePane);
});
$("space-chip").addEventListener("click", () => openPane("spaces"));
$("sync-spaces-btn").addEventListener("click", () => openPane("spaces"));
$("topics-toggle").addEventListener("click", () => openPane("topics"));
$("search-toggle").addEventListener("click", () => openPane("search"));
// 文本过滤(常驻框,不随 pills 重建):输入即筛,走 projectTimeline 单一渲染路径。
// 卡片编辑草稿在场时不受理(重投影会拆掉草稿)——把框回退到已存值、响一声,不静默毁稿。
$("filter-text").addEventListener("input", () => {
  const input = $("filter-text") as HTMLInputElement;
  if (cardPanel.hasDirtyDraft()) {
    input.value = filters[viewMode].text;
    showError("先保存或取消正在编辑的内容");
    return;
  }
  filters[viewMode].text = input.value;
  projectTimeline();
});
$("bottombar").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("#bottombar button");
  if (!btn) return;
  if (btn.dataset.pane) openPane(btn.dataset.pane);
  else if (btn.dataset.mode) onModeButton(btn.dataset.mode as ViewMode);
});
$("sync-diag-btn").addEventListener("click", () => openPane("diag"));

$("space-list").addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const sw = t.closest<HTMLElement>("[data-switch]")?.dataset.switch;
  if (sw && sw !== getCurrentSpace()) {
    spaceMenuFor = null;
    await switchSpace(sw);
    return;
  }
  if (t.dataset.more) {
    // 「⋯」开合重置入口(P1 #11);重开即收上一行的,恒最多一行展开。
    spaceMenuFor = spaceMenuFor === t.dataset.more ? null : t.dataset.more;
    resettingSpace = null;
    renderSpaceList();
    return;
  }
  if (t.dataset.reset) {
    resettingSpace = t.dataset.reset; // 第一拍:亮红字确认,不动数据。
    renamingSpace = false;
    spaceMenuFor = null;
    renderSpaceList();
    return;
  }
  if (t.dataset.resetCancel) {
    resettingSpace = null;
    renderSpaceList();
    return;
  }
  if (t.dataset.resetOk) {
    const id = t.dataset.resetOk;
    resettingSpace = null;
    try {
      await invoke("reset_space", { spaceId: id });
      showError("已重置此空间。要重新加入账户,用「空间」里的「加入空间」。");
      resetSyncTransient(); // 重置空间的恢复码/出码页等一次性展示随之作废。
      await reconcileForeground(); // 前台可能已落回 main(后端广播为准,这里对账兜底)。
      await refreshSpaces();
    } catch (err) {
      showError(String(err));
      await refreshSpaces();
    }
    return;
  }
  if (t.dataset.rename) {
    renamingSpace = true;
    spaceMenuFor = null; // 进改名态顺带收「⋯」,改完/取消不回弹重置入口(codex L)
    renderSpaceList();
    ($("space-rename-input") as HTMLInputElement | null)?.focus();
    return;
  }
  if (t.dataset.renameCancel) {
    renamingSpace = false;
    renderSpaceList();
    return;
  }
  if (t.dataset.renameOk) {
    const name = ($("space-rename-input") as HTMLInputElement).value.trim();
    if (!name) {
      showError("空间名不能为空");
      return;
    }
    try {
      await invoke("rename_space", { spaceId: getCurrentSpace(), name });
      renamingSpace = false;
      await refreshSpaces();
    } catch (err) {
      showError(String(err));
    }
  }
});

$("space-create").addEventListener("click", async () => {
  // 草稿闸前置(实现审 M4):创建+自动切换是不可拆的一体动作,后端调用之前就拒
  // ——否则建出一个用户并不想留的空空间、切换又被草稿挡下,现场撕裂。
  if (cardPanel.hasDirtyDraft()) {
    showError("先保存或取消正在编辑的内容");
    return;
  }
  const input = $("space-new-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) {
    showError("给空间起个名字(比如「家庭」)");
    return;
  }
  const btn = $("space-create") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const id = await invoke<string>("create_space", { name });
    input.value = "";
    await refreshSpaces();
    // 创建在途期间用户可能又开了编辑(三审 M4 的 TOCTOU 窗口):切换会被草稿闸
    // 或并发切换挡下——只有真切过去了才说「已创建并切换」,否则如实分开说。
    await switchSpace(id); // 创建即切过去——新本子即建即用,人就该在那个空间里。
    if (getCurrentSpace() === id) {
      showBar("空间已创建,现在就能记录。想多端同步,到「同步」里创建账户。", true);
    } else {
      showBar("空间已创建,但还没切换过去——到「空间」列表里点它即可。", true);
    }
  } catch (err) {
    showError(String(err));
  } finally {
    btn.disabled = false;
  }
});

// 全部同步(§7 lean-B):有界 best-effort;结果只显「试了 N 个」,绝不显「全部完成」。
const OUTCOME_LABEL: Record<string, string> = {
  boot_completed: "完成初始同步",
  connected: "已连接追赶",
  no_boot_peer: "等不到引导(需桌面在线)",
  timed_out: "超时",
  failed: "失败",
  cancelled: "被打断",
};

$("sync-all-btn").addEventListener("click", async () => {
  const btn = $("sync-all-btn") as HTMLButtonElement;
  const box = $("sync-all-result");
  btn.disabled = true;
  box.textContent = "正在逐空间同步…";
  try {
    const report = await invoke<SyncAllReport>("sync_all_spaces");
    const outcomes = report.outcomes;
    if (!outcomes.length) {
      // 「全部同步」只遍历开了同步的空间——纯本地本子被跳过是预期(space-entry-plan §5)。
      box.textContent = "没有开启同步的空间(纯本地的本子不参与,属预期)。";
    } else {
      const progressed = outcomes.filter((o) => o.progressed).length;
      const lines = outcomes
        .map((o) => {
          const label = esc(spaceLabel({ id: o.space, name: o.name }));
          const verdict = OUTCOME_LABEL[o.outcome] ?? o.outcome;
          const detail = o.detail ? `:${esc(o.detail)}` : "";
          return `<div>${label} — ${verdict}${o.progressed ? "(有新数据)" : ""}${detail}</div>`;
        })
        .join("");
      const restore = report.restore_error
        ? `<div style="color:var(--seal)">${esc(report.restore_error)}(重启应用可恢复)</div>`
        : "";
      box.innerHTML = `<div>试了 ${outcomes.length} 个空间,${progressed} 个有新数据:</div>${lines}${restore}`;
    }
    await reconcileForeground();
    await refresh(); // 前台空间在遍历期间可能收到过草稿保存,重拉一次。
  } catch (err) {
    showError(String(err));
    box.textContent = "";
    await reconcileForeground();
  } finally {
    btn.disabled = false;
  }
});

void listen<{ space: string; done: number; total: number }>("sync-all-progress", (e) => {
  $("sync-all-result").textContent = `正在逐空间同步…(${e.payload.done}/${e.payload.total})`;
});

// ---- 诊断面(P4-b 收编:打开才读库、才跑网络闸门;120 起入口在底部工具行) -----

let diagLoaded = false;

async function loadDb() {
  const box = $("db");
  try {
    const d = await sinvoke<DbInfo>("db_info");
    const rows: [string, string][] = [
      ["SQLite", d.sqlite_version],
      ["journal_mode", d.journal_mode],
      ["迁移版本", String(d.user_version)],
      ["device_id", d.device_id],
      ["items 行数", String(d.items)],
      ["库路径", d.path],
    ];
    box.innerHTML = rows
      .map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`)
      .join("");
  } catch (e) {
    box.innerHTML = `<span class="v" style="color:var(--seal)">建库失败:${esc(String(e))}</span>`;
  }
}

async function runProbe() {
  const btn = $("run") as HTMLButtonElement;
  const box = $("probe");
  const url = ($("url") as HTMLInputElement).value.trim();
  btn.disabled = true;
  box.innerHTML = `<span class="muted">诊断中…(连接项最长等 10 秒)</span>`;
  try {
    const steps = await invoke<ProbeStep[]>("net_probe", { url });
    box.innerHTML = steps
      .map(
        (s) => `<div class="step ${s.ok ? "ok" : "fail"}">
          <span class="mark">${s.ok ? "✓" : "✗"}</span>
          <span class="name">${esc(s.name)}</span>
          <span class="detail">${esc(s.detail)}</span>
        </div>`,
      )
      .join("");
  } catch (e) {
    box.innerHTML = `<span class="v" style="color:var(--seal)">诊断命令失败:${esc(String(e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}
$("run").addEventListener("click", runProbe);

// ---- 同步面(P4-d):当前空间的输码一屏 + 引导进度 + 状态/恢复码 ---------------

const STATE_LABEL: Record<string, string> = {
  off: "未开启",
  connecting: "连接中…",
  booting: "初始同步中…",
  online: "在线",
  offline: "掉线,重连中…",
};

$("sync-toggle").addEventListener("click", () => openPane("sync"));

function renderSync(s: SyncStatus) {
  const dot = $("sync-dot");
  // 断网/出错态类名用 off 不用 error:全局 .error 是左上角 fixed 的错误提示条,
  // 状态点若带 error 类会被它命中、断网时被拽到左上角盖住「朱」(真机 bug)。
  dot.className =
    "dot " +
    (s.state === "online"
      ? "online"
      : s.state === "connecting" || s.state === "booting"
        ? "busy"
        : s.error || s.state === "offline"
          ? "off"
          : "");
  const err = s.error ? `<div class="err">${esc(s.error)}</div>` : "";
  const frozen = s.frozen.length
    ? `<div class="err">已冻结设备:${esc(s.frozen.join("、"))}(需人工处理)</div>`
    : "";
  $("sync-state").innerHTML =
    `<b>${esc(STATE_LABEL[s.state] ?? s.state)}</b>${err}${frozen}`;
  $("sync-join").hidden = s.configured;
  // 未配置态的路数按空间分(space-entry-plan §4):main 保留「一主两辅」(装机
  // onboarding:扫码/输码把本机并进已有账户);**非 main 只有创号一条路**——
  // 「把别处的账户带过来」的入口是空间面板的「加入空间」,不在这里。
  const isMain = getCurrentSpace() === "main";
  (($("sync-scan-btn").parentElement) as HTMLElement).hidden = !isMain;
  $("sync-alt-pair").hidden = !isMain;
  const altCreate = $("sync-alt-create") as HTMLButtonElement;
  altCreate.textContent = isMain ? "没有其他设备?创建新账户" : "开启多端同步(创建账户)";
  altCreate.classList.toggle("ghost", isMain);
  $("sync-boot").hidden = s.state !== "booting";
  $("sync-online").hidden = !s.configured;
  if (s.configured) {
    const rows: [string, string][] = [
      ["账户", s.account_id ?? ""],
      ["服务器", s.server_url ?? ""],
      ["同伴在线", String(s.peers_online)],
    ];
    $("sync-info").innerHTML = rows
      .map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`)
      .join("");
  }
}

// 辅路互斥折叠(codex 审:两条路对当前空间是互斥决策,共享的服务器地址行只在
// 任一辅路展开时显示;重复点当前项收起)。切空间时复位并清掉旧材料——上一空间
// 的配对码不许带进新空间(创号自 open-signup 起无码,无材料可清)。
type SecondaryMode = null | "pair" | "create";
let secondary: SecondaryMode = null;

function renderSecondary() {
  $("sync-manual").hidden = secondary !== "pair";
  $("sync-create").hidden = secondary !== "create";
  $("sync-server-row").hidden = secondary === null;
}

function resetSecondary() {
  secondary = null;
  ($("sync-code") as HTMLInputElement).value = "";
  renderSecondary();
}

$("sync-alt-pair").addEventListener("click", () => {
  secondary = secondary === "pair" ? null : "pair";
  renderSecondary();
});
$("sync-alt-create").addEventListener("click", () => {
  secondary = secondary === "create" ? null : "create";
  renderSecondary();
});

// 手输与扫码共用同一条加入路(107 抽出:后端 sync_pair_join 不区分码怎么来的)。
// 配对目标 = 点击那刻的当前空间(写类命令,不走 sinvoke,明确处理响应)。
async function doJoin(serverUrl: string, code: string) {
  if (!serverUrl || !code) return;
  const target = getCurrentSpace();
  const btn = $("sync-join-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "加入中…";
  try {
    await invoke("sync_pair_join", { spaceId: target, serverUrl, code });
    resetSecondary(); // 码已消费,收起辅路清掉旧材料。
    await refreshSpaces();
    const cur = spacesCache.find((s) => s.id === target);
    // 起名提示只在多空间时给(codex 审:单空间用户刚扫完码,别把「空间」概念抛回来)。
    showBar(
      spacesCache.length > 1 && cur && !cur.name
        ? "已连接,正在初始同步…(可在「空间」面板给本空间起个名字)"
        : "已连接,正在初始同步…",
      true,
    );
  } catch (err) {
    showError(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "加入";
  }
}

$("sync-join-btn").addEventListener("click", () => {
  void doJoin(
    ($("sync-server") as HTMLInputElement).value.trim(),
    ($("sync-code") as HTMLInputElement).value.trim(),
  );
});

// ---- 扫码加入(107):桌面「发起配对」旁出二维码,扫到即自动加入 ----------------

type PairPayload = { server: string; code: string };

function parsePairQr(text: string): PairPayload {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("这不是朱笺的配对二维码");
  }
  if (o?.zhujian !== "pair" || typeof o.server !== "string" || typeof o.code !== "string") {
    throw new Error("这不是朱笺的配对二维码");
  }
  if (o.v !== 1) throw new Error("二维码版本较新:请先升级手机端朱笺再扫");
  return { server: o.server, code: o.code };
}

let scanCancelled = false;

/** 收扫码层(146 真机取证):plugin 的 cancel 命令会 resolve,但**部分状态下不
 *  reject 挂着的 scan()**——页面若只等 startScan.finally 收尾,会永远停在挖空态
 *  (「取消扫码」按钮此前同患)。故 UI 收尾自己做、不等插件:cancel 尽力发出,
 *  scanning/挖空层立即收,与 startScan.finally 幂等;返回键与取消按钮共用这一条。 */
function dismissScanOverlay() {
  scanCancelled = true;
  void cancel().catch(() => {});
  document.body.classList.remove("scanning");
  $("scan").hidden = true;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 扫码取一枚配对载荷,交给 `onGot` 路由(两条消费路:main 装机配对 doJoin /
 *  「加入空间」doJoinSpace——扫码只管拿码,去哪由入口按钮决定)。 */
async function startScan(onGot: (p: PairPayload) => Promise<void>) {
  let perm = await checkPermissions();
  if (perm !== "granted" && perm !== "denied") perm = await requestPermissions();
  if (perm !== "granted") {
    showError("没有相机权限,无法扫码;可以手动输入配对码,或到系统设置里给朱笺开相机。");
    return;
  }
  scanCancelled = false;
  document.body.classList.add("scanning");
  $("scan").hidden = false;
  try {
    const got = await scan({ windowed: true, formats: [Format.QRCode] });
    const p = parsePairQr(got.content);
    document.body.classList.remove("scanning");
    $("scan").hidden = true;
    await onGot(p);
  } catch (err) {
    if (!scanCancelled) showError(errMsg(err));
  } finally {
    document.body.classList.remove("scanning");
    $("scan").hidden = true;
  }
}

$("sync-scan-btn").addEventListener("click", () =>
  void startScan(async (p) => {
    ($("sync-server") as HTMLInputElement).value = p.server;
    ($("sync-code") as HTMLInputElement).value = p.code;
    await doJoin(p.server, p.code);
  }).catch((e) => showError(errMsg(e))),
);
$("scan-cancel").addEventListener("click", dismissScanOverlay);

// ---- 加入空间(space-entry-plan §3:app 级入口,不收目标 space_id) -------------

type JoinOutcome =
  | {
      kind: "integrated";
      space: { id: string; name: string | null; configured: boolean };
      warnings: string[];
    }
  | { kind: "published_needs_restart"; space_id: string; error: string };

const JOIN_PHASE_LABEL: Record<string, string> = {
  preparing: "准备中…",
  pairing: "正在配对…",
  booting: "正在拉取账户数据…",
  publishing: "正在落成空间…",
  integrating: "正在装入空间列表…",
};

/** 当前 attempt 的 id(null=没有加入在跑)。进度事件只接受当前 attempt、terminal
 *  后拒迟到事件(取消旧加入后 WebView 队列里的旧进度不许画到新一次加入上,§3.2)。 */
let joinAttempt: string | null = null;

function renderJoinProgress(text: string | null) {
  const box = $("join-progress");
  box.hidden = !text;
  box.textContent = text ?? "";
  $("join-cancel-row").hidden = joinAttempt === null;
}

async function doJoinSpace(serverUrl: string, code: string) {
  if (!serverUrl || !code) return;
  if (joinAttempt) {
    showError("已有一次「加入空间」在进行中");
    return;
  }
  const attempt = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  joinAttempt = attempt;
  renderJoinProgress("准备中…");
  const goBtn = $("join-go") as HTMLButtonElement;
  const scanBtn = $("join-scan-btn") as HTMLButtonElement;
  goBtn.disabled = true;
  scanBtn.disabled = true;
  try {
    const out = await invoke<JoinOutcome>("join_space", {
      serverUrl,
      code,
      attemptId: attempt,
    });
    // 结果分道**先于**任何后续收尾(codex 一轮 M4):后端事实(Integrated /
    // PublishedNeedsRestart)不许被前端刷新的任何闪失盖成「普通失败」。
    $("join-form").hidden = true;
    ($("join-code") as HTMLInputElement).value = "";
    if (out.kind === "integrated") {
      const label = spaceLabel({ id: out.space.id, name: out.space.name });
      const warn = out.warnings.length ? `(注意:${out.warnings.join(";")})` : "";
      await refreshSpaces();
      // Integrated 不含视图切换(§3.2 二轮 H3):经现有**草稿感知**入口尝试切换,
      // 草稿挡住就保持原前台、指路即可——绝不 reconcileForeground 强切丢草稿。
      if (!cardPanel.hasDirtyDraft()) await switchSpace(out.space.id);
      if (getCurrentSpace() === out.space.id) {
        showBar(`已加入空间「${label}」${warn}`, true);
      } else {
        showBar(`已加入空间「${label}」,保存当前编辑后可到「空间」列表切换过去${warn}`, true);
      }
    } else {
      // 空间已真实存在(账户已注册):只提示重启后出现,绝不谎报失败(三轮 M5)。
      showError(out.error);
    }
  } catch (err) {
    showError(String(err));
  } finally {
    joinAttempt = null;
    renderJoinProgress(null);
    goBtn.disabled = false;
    scanBtn.disabled = false;
  }
}

void listen<{ attempt_id: string; phase: string; received: number; total: number }>(
  "join-progress",
  (e) => {
    const p = e.payload;
    if (p.attempt_id !== joinAttempt) return; // 只接受当前 attempt(迟到事件拒)
    renderJoinProgress(
      p.phase === "booting" && p.total > 0
        ? `正在拉取账户数据 ${fmtMb(p.received)} / ${fmtMb(p.total)}`
        : (JOIN_PHASE_LABEL[p.phase] ?? p.phase),
    );
  },
);

$("join-scan-btn").addEventListener("click", () =>
  void startScan(async (p) => {
    await doJoinSpace(p.server, p.code);
  }).catch((e) => showError(errMsg(e))),
);
$("join-alt-btn").addEventListener("click", () => {
  const f = $("join-form");
  f.hidden = !f.hidden;
});
$("join-go").addEventListener("click", () => {
  void doJoinSpace(
    ($("join-server") as HTMLInputElement).value.trim(),
    ($("join-code") as HTMLInputElement).value.trim(),
  );
});
$("join-cancel").addEventListener("click", () => {
  void invoke("join_space_cancel").catch(() => {});
});

$("sync-recovery-btn").addEventListener("click", async () => {
  const box = $("sync-recovery");
  try {
    box.textContent = await sinvoke<string>("sync_recovery_code");
    // 警示随码同现(codex 审:「恢复码≠数据备份」必须跟着码走,防误当备份)。
    $("sync-recovery-note").hidden = false;
    box.hidden = false;
  } catch (err) {
    showError(String(err));
  }
});

// 连接信息(账户/服务器/同伴)折叠:唯一出处,点开才见。
$("sync-conninfo-btn").addEventListener("click", () => {
  const info = $("sync-info");
  info.hidden = !info.hidden;
});

// ---- 创号 + 恢复码强制仪式(phone-space-plan §2.1/§3,与桌面对称) --------------

// Crockford 抄录容错的规范化,与 core parse_recovery_code **严格同口径**(只容忍
// 空格与 `-`;实现审 L7:前端多容忍 tab/换行会让仪式通过、将来真恢复时被 core
// 拒)。大写、O→0、I/L→1。只用于仪式回验比对,不做解码。
function normalizeCode(s: string): string {
  return s
    .replace(/[- ]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

let ritualCode = "";

/** 强制仪式:展示+警示+回输核对,输对才放行。post-commit 错误(目录刷新失败等)
 *  随码一起亮出——账户已创建是事实,码必须交付,错误只旁路提示(codex r1 #5)。 */
function openRitual(code: string, postErr: string | null) {
  ritualCode = code;
  $("ritual-code").textContent = code;
  const post = $("ritual-post");
  post.hidden = !postErr;
  post.textContent = postErr ?? "";
  ($("ritual-confirm") as HTMLInputElement).value = "";
  $("ritual-err").textContent = "";
  $("ritual").hidden = false;
}

$("ritual-done").addEventListener("click", () => {
  const typed = ($("ritual-confirm") as HTMLInputElement).value;
  if (normalizeCode(typed) !== normalizeCode(ritualCode)) {
    $("ritual-err").textContent = "输入与恢复码不符——请对照纸上抄写的内容逐组核对。";
    return;
  }
  ritualCode = "";
  $("ritual").hidden = true;
  showBar("账户已创建,同步已开启", true);
  resetSecondary(); // 创号完成,收起辅路。
  void refreshSpaces();
  void sinvoke<SyncStatus>("sync_status").then(renderSync).catch(() => {});
});

async function doCreateAccount() {
  const serverUrl = ($("sync-server") as HTMLInputElement).value.trim();
  if (!serverUrl) return;
  const target = getCurrentSpace();
  const btn = $("sync-create-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "创建中…";
  try {
    // 刻意不判弃迟到响应:码一旦提交只出这一次机会窗,即使空间已切走也必须
    // 走完仪式(api.ts 注释同款纪律)。
    const out = await syncCreateAccount(target, serverUrl);
    openRitual(out.recovery_code, out.post_commit_error);
  } catch (err) {
    showError(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "创建新账户";
  }
}
$("sync-create-btn").addEventListener("click", () => void doCreateAccount());

// ---- 邀请设备(老设备侧出码;phone-space-plan §2.2/§3) -------------------------

async function doInviteDevice() {
  const target = getCurrentSpace();
  const btn = $("sync-invite-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "申请配对码…";
  try {
    // 码与服务器地址由后端同 runtime 原子取(实现审 M3),不从状态缓存拼。
    const { code, server_url: server } = await syncPairStart(target);
    if (target !== getCurrentSpace()) return; // 出码页属于该空间,已切走就不画
    $("sync-pair-kv").innerHTML = (
      [
        ["服务器", server],
        ["配对码", code],
      ] as const
    )
      .map(
        ([k, v]) =>
          `<span class="k">${esc(k)}</span><span class="v" style="user-select:text">${esc(v)}</span>`,
      )
      .join("");
    $("sync-pair-copy").dataset.copy = `服务器地址:${server}\n配对码:${code}`;
    $("sync-pair-note").textContent =
      "在电脑上:「空间」→「加入空间」→ 输入配对码,两项都要填。出码和对方初始同步期间,不要切换空间、不要运行「全部同步」,并保持本机亮屏在前台。配对码 10 分钟内有效、只能用一次。";
    $("sync-pair-out").hidden = false;
  } catch (err) {
    showError(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "添加设备";
  }
}
$("sync-invite-btn").addEventListener("click", () => void doInviteDevice());

$("sync-pair-copy").addEventListener("click", () => {
  const text = $("sync-pair-copy").dataset.copy ?? "";
  navigator.clipboard.writeText(text).then(
    () => showBar("已复制,发给电脑端粘贴", true),
    () => showError("复制失败——请长按选中文字手动复制"),
  );
});

// ---- 半自动更新(106):启动静默查 + 后台切回再查(149 后用户点名),有新版出提示条 ----

type AndroidUpdate = { version: string; versionCode: number; notes: string; url: string };

// 检查会被反复触发(启动 + 每次回前台),按钮监听只在模块加载挂一次、经这两个
// 模块态取当前值;「以后再说」按 versionCode 记账,同一版本本会话内不再打扰
// (进程被杀重开自然复位=旧「重启才再提示」语义不变)。
let updateFound: AndroidUpdate | null = null;
let updateDismissedCode = 0;

async function initUpdate() {
  try {
    const u = await invoke<AndroidUpdate | null>("check_update");
    if (!u || u.versionCode === updateDismissedCode) return;
    updateFound = u;
    $("update-msg").textContent = `有新版 v${u.version}`;
    $("update").hidden = false;
  } catch {
    /* 离线/端点不可达:静默,下次回前台/启动再查。 */
  }
}
$("update-go").addEventListener("click", () => {
  if (!updateFound) return;
  void openUrl(updateFound.url).catch((err) => showError(String(err)));
});
$("update-later").addEventListener("click", () => {
  $("update").hidden = true;
  if (updateFound) updateDismissedCode = updateFound.versionCode;
});

const fmtMb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

// 远端变更 → 去抖刷新时间轴(追赶期一批 op 一次重画)+ 活动面跟上(实现审 M6)。
let refreshTimer: number | undefined;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    void refresh();
    refreshActivePane();
  }, 200);
}

// 事件桥统一信封(工序 8):按 space+generation 过滤(acceptSpaced)——非当前
// 空间(「全部同步」遍历期间的临时 session)与迟到代次一律丢弃。
void listen<Spaced<SyncStatus>>("sync-status", (e) => {
  if (!acceptSpaced(e.payload)) return;
  renderSync(e.payload.payload);
});
void listen<Spaced<unknown>>("sync-changed", (e) => {
  if (!acceptSpaced(e.payload)) return;
  refreshSoon();
});
// 空间名变了(本地改名/远端改名落地/引导落名/全部同步收尾兜底;space-name-sync-plan
// §4.7):刻意**不按 space+generation 过滤**——名字挂 chip/空间列表层,任何空间的
// 改名都要刷。先经 `rescan_spaces` 串行重扫 catalog(list_spaces 读内存快照,不重扫
// 白刷;重扫在命令面做,桥里并发重扫有旧快照后写竞态——codex 实现审 H1)。
// 失败不静默吞(codex 二轮 M1):有界重试一次(3s),再失败响亮提示——名字已落库,
// 只是列表刷新失败,下次事件/动作再追。
async function rescanThenRefreshSpaces(retryLeft: number): Promise<void> {
  try {
    await invoke("rescan_spaces");
  } catch (err) {
    if (retryLeft > 0) {
      window.setTimeout(() => void rescanThenRefreshSpaces(retryLeft - 1), 3000);
      return;
    }
    showError(`空间名已更新,但空间列表刷新失败:${String(err)}`);
    return;
  }
  await refreshSpaces();
}
void listen("space-name-changed", () => {
  void rescanThenRefreshSpaces(1);
});
void listen<Spaced<string>>("sync-toast", (e) => {
  if (!acceptSpaced(e.payload)) return;
  showBar(e.payload.payload, true);
});
void listen<Spaced<{ received: number; total: number }>>("sync-boot", (e) => {
  if (!acceptSpaced(e.payload)) return;
  const { received, total } = e.payload.payload;
  const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
  ($("sync-boot-fill") as HTMLElement).style.width = `${pct}%`;
  $("sync-boot-text").textContent =
    received >= total
      ? `快照 ${fmtMb(total)} 已收全,校验并导入中…`
      : `拉取快照 ${fmtMb(received)} / ${fmtMb(total)}(${pct}%)`;
});
// 邀请方配对进度(phone-space-plan §2.2)。done=注册完成≠对方引导完成(codex r2
// N4):不自动关出码页,提示等电脑端初始同步完成。
void listen<Spaced<{ phase: string; detail: string }>>("sync-pair", (e) => {
  if (!acceptSpaced(e.payload)) return;
  const { phase, detail } = e.payload.payload;
  $("sync-pair-note").textContent =
    phase === "done"
      ? `${detail}——请等电脑端显示初始同步完成后再离开本页。`
      : phase === "failed"
        ? `配对失败:${detail}(可重新出码)`
        : detail;
});
// 后端 foreground 变更(切换成功/失败回滚/遍历恢复)——先立代次水位(同空间
// 重激活后,旧桥 buffer 里还没吐完的旧代次事件从此被拒,工序 7/8 二审 L1;
// generation=0 表示代次未知,只对账不立水位),再对账跟上。
void listen<{ space: string; generation: number }>("space-foreground", (e) => {
  const { space, generation } = e.payload;
  if (generation > (seenGeneration[space] ?? 0)) seenGeneration[space] = generation;
  void reconcileForeground();
});
// 配对落库(本窗发起的在 doJoin 里已处理;这里兜底刷新列表的 configured 标)。
void listen<string>("space-configured", () => void refreshSpaces());

// ---- 卡片操作面板 + 低频面接线(120) -----------------------------------------

cardPanel.initCardPanel({
  getItem: (id) => lastItems.get(id),
  refresh,
  // 草稿收场(保存/取消/被迫丢弃):把被草稿保护延后的那轮刷新补上。
  onDraftClosed: () => {
    if (refreshDeferred) {
      refreshDeferred = false;
      void refresh();
    }
  },
  isSwitching: () => switching,
  // 「记下」在飞(146 ▲▲M3):面板整体禁点——尤其不得进入 edit/tags 草稿态,
  // 否则保存后的 refresh 被草稿闸无限延后、新卡落不了 DOM。
  isCaptureSaving: () => captureSaving,
  // 移动入口按空间数决定是否出现;picker 列其他空间(main.ts 的 spacesCache 影子)。
  getSpaces: () => spacesCache,
});
initCardSwipe({
  getItem: (id) => lastItems.get(id),
  getCurrentSpace,
  isSwitching: () => switching,
  hasDirtyDraft: () => cardPanel.hasDirtyDraft(),
  refresh,
});
panes.initPanes({ refreshTimeline: refresh, focusCard: focusTimelineCard, showPane: openPane });
topics.initTopicsPane({ refreshTimeline: refresh, isSwitching: () => switching });

// ---- 启动闸(工序 6)+ 上次空间恢复(工序 8) --------------------------------

// 安卓首启偶发:前端 bundle 执行(void init())时 WebView 的 IPC 桥可能还没接好,
// 发出的**首个 invoke 会被丢弃**、promise 永不 settle,前端就永远卡在「正在检查
// 本机空间…」——startup_gate 只 clone managed Gate,「重启即好」正是时序不同躲过
// 了这个窗口(132 观察债)。startup_gate 幂等,故超时或出错就重发;装配(含前滚
// 升级)在后端 blocking worker 上跑,`pending` 期间轮询等待(codex 设计审 H4);
// 封锁由 `blocked` 状态作**返回值**携带(不是抛异常),不会被重试逻辑吞掉。
type GateStatus =
  | { status: "pending" }
  | { status: "ready" }
  | {
      status: "blocked";
      kind: "upgrade-required" | "retryable" | "repair-required" | "reset-required";
      message: string;
    };

async function resolveStartupGate(): Promise<GateStatus & { status: "blocked" } | null> {
  const TIMEOUT_MS = 1500;
  for (let attempt = 1; ; attempt++) {
    try {
      const timedOut = Symbol("timeout");
      const r = await Promise.race([
        invoke<GateStatus>("startup_gate"),
        new Promise<typeof timedOut>((res) => setTimeout(() => res(timedOut), TIMEOUT_MS)),
      ]);
      if (r !== timedOut) {
        const g = r as GateStatus;
        if (g.status === "ready") return null;
        if (g.status === "blocked") return g;
        // pending:装配还在跑(可能正在升级数据格式),提示后继续轮询。
        if (attempt >= 3) $("gate-checking").textContent = "正在准备本机空间…";
        await new Promise((res) => setTimeout(res, 150));
        continue;
      }
    } catch {
      // manage(Gate) 之前的窗口会抛「state not managed」:歇一下重发,不当封锁。
    }
    if (attempt >= 3) $("gate-checking").textContent = "正在检查本机空间…(重试中)";
    await new Promise((res) => setTimeout(res, 150));
  }
}

async function init() {
  // 先用空缓存画一次空间入口(按单空间态:chip 藏、兜底「空间…」显)——否则首次
  // list_spaces 失败时 chip 与兜底都停在静态 hidden,空间面板整个不可达(codex 必修 3)。
  renderSpaceChip();
  const blocked = await resolveStartupGate();
  if (blocked !== null) {
    // 封锁处置按 kind 四分流(codex 设计审 H3 + 实现审 H1):只有 reset-required
    // 才出现「清除数据」;升级/重试/修复三页都明示「不要清除数据」。
    $("gate-checking").hidden = true;
    const pane =
      blocked.kind === "upgrade-required"
        ? "upgrade"
        : blocked.kind === "retryable"
          ? "retry"
          : blocked.kind === "repair-required"
            ? "repair"
            : "reset";
    $(`gate-msg-${pane}`).textContent = blocked.message;
    $(`gate-${pane}`).hidden = false;
    $("gate-blocked").hidden = false;
    return; // gateBlocked 保持 true
  }
  gateBlocked = false;
  $("gate").hidden = true;
  // 草稿断电恢复(197 下一步①):闸放行即回填 compose 上次没记下的文字 + 暂存图。
  // 先于下方 pullSharedText——冷启动被分享拉起时,分享文本追加在已恢复的草稿之后。
  const draftText = localStorage.getItem(COMPOSE_DRAFT_KEY);
  if (draftText) ($("text") as HTMLTextAreaElement).value = draftText;
  void compImgs.restore();
  // 上次空间恢复(设备本地 UI 记忆,与桌面 zhujian.last-space 同哲学):后端启动
  // 恒在 main,记忆指向别的空间就切过去;失效记忆清掉。
  await refreshSpaces();
  const last = localStorage.getItem(LAST_SPACE_KEY);
  if (last && last !== getCurrentSpace()) {
    if (spacesCache.some((s) => s.id === last)) {
      await switchSpace(last);
    } else {
      localStorage.removeItem(LAST_SPACE_KEY);
    }
  }
  void sinvoke<SyncStatus>("sync_status").then(renderSync).catch(() => {});
  void pullSharedText();
  void pullDeepLink(); // 冷启动:被 zhujian:// 链接拉起时取走暂存的 URI 并定位(空间已恢复后)
  void initUpdate();
  void refresh();
}

void init();
