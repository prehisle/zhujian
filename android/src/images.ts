// 安卓加图共享件(195/后续)——两个加图入口(卡片操作面 cardpanel、记灵感 compose)
// 共用一套「唤起系统相册 + 字节转码 + compose 暂存」,免各写各的造能力漂移。
// 取图机制:借 WebView 的 `<input type=file accept=image/*>`,wry 0.55 安卓端接了
// onShowFileChooser,点击即弹系统相册/文件选择器,**无需任何插件**(195 真机验通)。
// 391 起两条来路,底层都还是那一个 `<input>`、仍无插件、仍不碰 Rust 侧:
//   ①**相册多选** `multiple` → wry 那侧认 `MODE_OPEN_MULTIPLE`,给 intent 挂
//     `EXTRA_ALLOW_MULTIPLE` 并从 `clipData` 逐个回传 uri;
//   ②**当场拍照** `capture` → wry 那侧认 `isCaptureEnabled`(要 accept 恰为
//     `image/*`),起 `ACTION_IMAGE_CAPTURE`、照片经 FileProvider 回传。
//     ⚠ 这条路要 manifest 的 `<queries>` 声明(targetSdk 30+ 的包可见性:没声明
//     则 `resolveActivity` 返 null,wry **静默回落成文件选择器** = 点了拍照弹出
//     相册,不报错)。
import { addItemImage } from "./api";
import { t } from "./i18n";

/** Blob → base64(不带 data: 前缀,过 IPC 给 add_item_image)。分块喂 btoa,
 *  免大图一次 fromCharCode(...几百万) 爆栈(与桌面 item-images.ts::toBase64 同法)。 */
export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---- 挂图失败时,能对用户说的那句话(538,backlog 用户面 56)-------------------
// **病**:批量挂图(compose)失败时只数得出「N 张」,配的话是「可在该卡片『加图』重贴」
// —— 而 537 量到:够得着的拒法(不支持的类型 / 过大)**全是确定性的**,同样的字节再贴
// 一次还是同样被拒 ⇒ 那句指引把用户支去做一件注定失败的事。而后端**本来就说得出一句
// 照着能行动的话**,却在这只 `attachBatch` 的**裸 catch** 里被整个扔了(⚠ 528 销
// 「测试与工装 45」时只修了桌面那半,这只同名函数从来没进过覆盖面)。
//
// **形:前端自己推那句话,⛔ 不是把后端那串原样贴出来。** 两个理由:
//   ①后端诊断串**拍板不翻**(i18n-plan)⇒ 原样贴出去,英文界面上会冒出中文;
//   ②后端也会回内部错(`FOREIGN KEY constraint failed` 之类),那种给用户看没用。
// ⚠ **这是副本,后端仍是权威** —— 而且是**安全的那个方向**:本函数**只在挂图已经失败
// 之后**才跑,⇒ 名单漂了最坏是「话说得不够准」,⛔ 绝不可能挡下一张后端本来收得下的图。
// ⛔ **判定顺序照抄 `core/src/images.rs::attach`(空 → 过大 → MIME)** —— 顺序错了会答错原因。
// ⚠ **桌面孪生 = `src/item-images.ts::whyAttachFailed`**,两端各一份(独立 vite 工程,
//   物理上合不成一份;同 filter / timing / theme 那族)。改一处**必须改另一处**。
const ATTACH_MAX_MB = 32; // = core 的 MAX_IMAGE_BYTES
const ATTACH_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"]; // = core 的 ALLOWED_MIME

/** 挂图失败的原因里**能对用户说的那句**;前端看不出来就回 `""`。
 *  ⛔ 回 `""` 时调用方该退回泛指引,**别猜一个像样的原因** —— 猜错正是这条账在修的病。 */
export function whyAttachFailed(file: File): string {
  if (file.size === 0) return t("images.failEmpty");
  if (file.size > ATTACH_MAX_MB * 1024 * 1024)
    return t("images.failTooBig", { mb: Math.round(file.size / (1024 * 1024)), max: ATTACH_MAX_MB });
  if (!ATTACH_MIME.includes(file.type)) return t("images.failBadType", { mime: file.type || "?" });
  return "";
}

/** 一批挂完的结果:几张没挂上 + **那句话**(说得准就是具体原因,说不准是 `""`)。 */
export type AttachOutcome = { failed: number; why: string };

// 上传前降采样(194 可优化项①):相册原图动辄几 MB,全量入 E2EE 库并下行到所有设备=同步
// 体积负担。两道闸——**主闸** 长边 > UPLOAD_MAX_EDGE 按比例缩;**副闸(B)** 尺寸达标但字节
// 偏大的**照片**(JPEG 源)也重编码,补「小尺寸大体积」漏网。副闸只认 JPEG:透明 PNG 与文字
// 截图(截图多为 PNG)天然豁免,不被 JPEG 化丢透明/糊字。任一闸命中就 canvas 重绘 → JPEG
// q0.85;都不命中 / 解码不了(HEIC 等)/ 缩后反更大均放行原图(后端 MIME 闸仍是权威,该拒
// 的照拒)。pickImage 是安卓唯一的用户字节入口,在这里做即两加图入口全覆盖。
const UPLOAD_MAX_EDGE = 2560;
const UPLOAD_HEAVY_BYTES = 1_500_000; // ~1.5MB:尺寸内但比这肥的 JPEG 照片也压
async function downsampleForUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("decode"));
      img.src = url;
    });
    const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
    const overDim = maxDim > UPLOAD_MAX_EDGE; // 主闸
    const heavyPhoto = file.type === "image/jpeg" && file.size > UPLOAD_HEAVY_BYTES; // 副闸
    if (!overDim && !heavyPhoto) return file; // 尺寸达标且非肥照片:原样(截图/透明 PNG 天然豁免)
    const scale = Math.min(1, UPLOAD_MAX_EDGE / maxDim); // 只缩不放大;副闸场景 scale=1 仅重编码
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file; // 编码失败 / 缩后反更大:放行原图
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file; // 解码失败(HEIC 等):原样交后端,该拒的响亮拒,不静默转码
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 唤起系统选择器的**唯一**底层:配好隐藏 `<input>` 点开、等结果、清节点,交回原始
 *  File[](降采样在上层逐张做——多选时要边处理边交付)。选择器是系统模态,期间 app 在
 *  后台。change=选中;有些 ROM 取消不发 change,故回到前台 1s 后若仍未 settle 判为取消
 *  (已 settle 则本兜底空转,绝不抢在 change 之前误判)。调用点须由用户手势触发
 *  (input.click 要手势),故只在点击处理器里调。 */
function openPicker(configure: (el: HTMLInputElement) => void): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*"; // wry 认 capture 的前提之一:accept 恰为 image/*
    input.hidden = true;
    configure(input);
    let settled = false;
    const settle = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => settle([...(input.files ?? [])]), { once: true });
    window.addEventListener(
      "focus",
      () => window.setTimeout(() => settle([]), 1000),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

/** 一次多选的张数上界(391,用户拍板 9)。这些字节缩完每张仍有 300-500KB,且整份进
 *  E2EE 库、下行到**所有**设备——上界守的是同步体积,不是本地磁盘。超了整批不收
 *  (响亮拒,不静默截断掉前 9 张:用户以为全加上了才是真的坏)。 */
export const PICK_MAX = 9;

export type PickOutcome =
  | { kind: "picked"; count: number }
  | { kind: "cancelled" }
  | { kind: "tooMany"; count: number };

/** 相册多选(≤ PICK_MAX 张)。**每张降采样完就 onEach 交付一次**——9 张原图串行解码
 *  重编码要几秒,逐张交付才有「图在一张张长出来」的反馈,而不是干等一个大 Promise;
 *  故本函数不返回文件数组,onEach 是唯一交付通道(免调用方两处重复处理同一批)。
 *  取消(没选)= cancelled;超上界 = tooMany 且一张都不收。
 *
 *  ⭐ `onPicked(n)` 在**降采样开跑之前**报「选中了几张」(用户面 36)。为什么要多这一枚:
 *  `downsampleForUpload` 是解码位图(相机原图 4000×3000 ≈ 48MiB)+ canvas 重绘 + JPEG
 *  重编码,全在主线程,几百 ms 到几秒;在它之前屏幕上**一个像素都不动**,用户读成「没加上」。
 *  调用方据此先摆占位。⛔ 它排在 tooMany 之后 —— 整批不收的时候一个占位也不该冒出来。 */
export async function pickImages(
  onEach: (file: File) => void,
  onPicked?: (n: number) => void,
): Promise<PickOutcome> {
  const files = await openPicker((el) => {
    el.multiple = true;
  });
  if (!files.length) return { kind: "cancelled" };
  if (files.length > PICK_MAX) return { kind: "tooMany", count: files.length };
  onPicked?.(files.length);
  for (const f of files) onEach(await downsampleForUpload(f));
  return { kind: "picked", count: files.length };
}

/** 当场拍一张(HTML `capture` → wry 起系统相机)。resolve 已降采样的那张;取消/没拍成
 *  resolve null。⚠ 首次会弹系统相机权限框(manifest 声明了 CAMERA,wry 那侧据此先要
 *  权限再开相机),用户拒了等同取消——不另弹说明,系统框本身已经说清楚了。
 *  相机原图动辄 4000×3000,必过降采样主闸;EXIF 方向由 Chromium 的
 *  `image-orientation: from-image` 默认值在解码时校正,竖拍不会躺倒。 */
export async function capturePhoto(onPicked?: () => void): Promise<File | null> {
  const files = await openPicker((el) => {
    // `capture` 不在 lib.dom 的 HTMLInputElement 上(各 TS 版本不一),走属性写死。
    el.setAttribute("capture", "environment"); // 后置摄像头:拍的是东西不是人
  });
  const f = files[0];
  if (!f) return null;
  onPicked?.(); // 同 pickImages:降采样之前先报信,调用方摆占位(相机原图那一趟最久)
  return await downsampleForUpload(f);
}

// ---- compose 暂存图的断电恢复(197 下一步①):图走 IndexedDB(存 Blob 原生、容量够,
// 不像 localStorage 会被大图撑爆)。单条全局草稿一份(与文字草稿同哲学,不按空间分);
// 启动回填。纯设备本地 UI 状态,绝不进 DB/同步。
// **392 起一张一个键**(391 可优化项④):此前是「held 一变就把整批 blob 整体覆盖写一个键」,
// 相册多选把它放大了——一张张加到 9 张 = 1+2+…+9 = 45 次 blob 拷贝,而真正的新字节只有 9 张。
// 现在每张自己一个 `img:<id>` 键、另有一个 id 顺序清单键,写入是**收敛**:库里没有的才写、
// 不再持有的删掉。加第 N 张 = 1 次 blob 写 + 一份字符串清单,与 N 无关。
// ⚠ 顺序是清单说了算,不是键序——键是 id、id 不含次序,重排/退回只重写清单(几十字节)。
const DRAFT_DB = "zhujian-compose-draft";
const DRAFT_STORE = "images";
const ORDER_KEY = "order"; // → string[](id 顺序清单)
const IMG_PREFIX = "img:"; // + id → Blob(一张一个键)

// ⚠ 这两个 Promise 的**每一条**终局都必须接上。写入是串行链(见 persist),链上任何一环
// 永不落地 = 之后所有草稿写入(含「记下后清空」那一次)全部沉默,而 IndexedDB 停在最后
// 一次成功的快照上 —— 下次启动 restore 就把一张早该没了的图回填进暂存条(391 真机上
// 见过一次:库里停着第一次写入的那张,跨了四轮「记下」都没被清掉)。IndexedDB 的请求有
// blocked、事务有 abort,漏接哪个哪个就是那口井。
function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DRAFT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DRAFT_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("draft db open blocked"));
  });
}

type DraftItem = { id: string; blob: Blob };

/** 把库收敛到 `items` 这一份:库里没有的字节才写、不在 items 里的键一律删(**顺带扫掉
 *  392 前那个整体覆盖写留下的老键 `pending`,和任何孤儿**),最后写 id 顺序清单。
 *  ⚠ 三步都在同一个事务里,故「清单与字节」对不上这种半态落不了地。 */
async function syncDraft(items: DraftItem[]): Promise<void> {
  const db = await openDraftDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, "readwrite");
      const store = tx.objectStore(DRAFT_STORE);
      const keysReq = store.getAllKeys(); // 只取键不取值:不读一个 blob 字节
      keysReq.onsuccess = () => {
        const alive = new Set(items.map((it) => IMG_PREFIX + it.id));
        const onDisk = new Set<string>();
        for (const k of keysReq.result) {
          // 删要拿**原样的键**去删(String() 只用来比对;真有非字符串键时
          // 拿字符串去 delete 是删不掉的,那才是留下孤儿字节的形)。
          const s = String(k);
          if (s !== ORDER_KEY && !alive.has(s)) store.delete(k);
          else onDisk.add(s);
        }
        for (const it of items) {
          if (!onDisk.has(IMG_PREFIX + it.id)) store.put(it.blob, IMG_PREFIX + it.id);
        }
        store.put(
          items.map((it) => it.id),
          ORDER_KEY,
        );
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("draft persist aborted"));
    });
  } finally {
    db.close();
  }
}

/** 读回上次的暂存:清单定顺序,逐 id 取字节。清单里有 id 却没字节的跳过(半态落不了地,
 *  但库被外力动过时不该整批失败)。**同一事务里顺带扫掉不在清单里的键**——老键与孤儿
 *  的字节否则会一直占着(一次都不再加图的设备,persist 永远不跑,没人替它清)。 */
async function loadDraft(): Promise<DraftItem[]> {
  const db = await openDraftDb();
  try {
    return await new Promise<DraftItem[]>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, "readwrite"); // 要扫孤儿,故非只读
      const store = tx.objectStore(DRAFT_STORE);
      const out: DraftItem[] = [];
      const orderReq = store.get(ORDER_KEY);
      orderReq.onsuccess = () => {
        const ids = (orderReq.result as string[] | undefined) ?? [];
        const alive = new Set(ids.map((id) => IMG_PREFIX + id));
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = () => {
          for (const k of keysReq.result) {
            const s = String(k);
            if (s !== ORDER_KEY && !alive.has(s)) store.delete(k); // 同上:原样的键
          }
        };
        for (const id of ids) {
          const req = store.get(IMG_PREFIX + id);
          // 请求按发出顺序回调 ⇒ out 天然就是清单的顺序。
          req.onsuccess = () => {
            const b = req.result as Blob | undefined;
            if (b) out.push({ id, blob: b });
          };
        }
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("draft load aborted"));
    });
  } finally {
    db.close();
  }
}

/** 暂存图的本地 id:只用来当 IndexedDB 的键与「这张写过没有」的判据,不出这个模块、
 *  不进 DB/同步。会话内单调 + 启动时刻做前缀 ⇒ 与上次会话回填进来的 id 不会撞。 */
let draftIdSeq = 0;
function newDraftId(): string {
  draftIdSeq += 1;
  return `${Date.now().toString(36)}-${draftIdSeq.toString(36)}`;
}

/** 暂存条里一张图的对外形(点开大图时交给查看器):字节已经在手上,`remove` 摘掉它。 */
export type ComposePreview = { url: string; remove: () => void };

/** compose 暂存图(记灵感时先贴、条目还没建):holder 在给定容器里渲染缩略图(带
 *  「×」移除),对外只暴露 File[] 批次。与 save() 的两缓冲对齐(桌面 pendingImages 同律):
 *  点「记下」那刻 takeBatch 冻结带走并清预览,在飞期间新贴的图属于下一条;创建成功
 *  attachBatch 逐张挂上、失败图按张计数(条目已建、图可去卡片「加图」重贴);创建失败
 *  putBack 原样退回可重试。objectURL 是纯渲染态,取批/退回时按需重建。 */
export type ComposeImages = {
  /** 已经拿到字节的张数(占位不算 —— 它还不是一张图)。 */
  count: () => number;
  add: (file: File) => void;
  /** 选中/拍完的那一刻先摆 n 个占位(降采样要几百 ms 到几秒,见 pickImages 的注)。 */
  reserve: (n: number) => void;
  /** 收尾:清掉没被填上的占位(取消 / 解码半途没交付)。**每次 reserve 都要有一次配对的
   *  这个** —— 漏了就在屏上留一个永远转下去的骨架。 */
  dropReserved: () => void;
  takeBatch: () => File[];
  putBack: (batch: File[]) => void;
  clear: () => void;
  /** 逐张挂到刚建好的条目;返回挂失败张数(fail-fast,调用方告诉用户)。 */
  attachBatch: (space: string, itemId: string, batch: File[]) => Promise<AttachOutcome>;
  /** 启动回填:从 IndexedDB 读回上次没记下的暂存图(仅当前无暂存时,不覆盖已贴的)。 */
  restore: () => Promise<void>;
};

/** `openPreview` = 点缩略图看大图(桌面 `src/item-images.ts` 的暂存图从 53 起就能点开,
 *  安卓这一格一直空着 —— 用户面 36 报的正是它)。刻意由调用方注入而不在这里 import
 *  viewer:取图这一层不该知道查看器长什么样,注入也免了一条模块环。不传 = 不可点。 */
export function composeImages(
  container: HTMLElement,
  openPreview?: (items: ComposePreview[], idx: number) => void,
): ComposeImages {
  /** 一格暂存位。`held === null` = **占位骨架**:字节还在降采样,节点已经在屏上转着。
   *  节点在这一格出生时就造好、此后**只填不重建** —— 整条 replaceChildren 会把已在跑的
   *  淡入过场打断(加第二张时第一张会闪一下),也白白重解一遍前面每张图。 */
  type Slot = {
    node: HTMLElement;
    img: HTMLImageElement;
    del: HTMLButtonElement;
    held: { id: string; file: File; url: string } | null;
  };
  let slots: Slot[] = [];

  const ready = (): Slot[] => slots.filter((s) => s.held !== null);

  /** id 在暂存条内必须唯一——`syncDraft` 的「库里已经有这个键就不重写字节」全靠它;
   *  撞了就会拿上一张的字节冒充这一张(静默错图,不是报错)。会话前缀让跨会话天然
   *  不撞,**除非系统时钟被往回拨**,故这里再挡一道:撞了就继续往下取号。 */
  function freshId(): string {
    let id = newDraftId();
    while (slots.some((s) => s.held?.id === id)) id = newDraftId();
    return id;
  }

  // 暂存条一变就把 IndexedDB 收敛到它(串行成链防并发写乱序;失败吞掉——持久化尽力而为,
  // 不拦业务)。**快照要在链外同步取**:等轮到这一环时它可能已经又变了,那一变自己
  // 会排在后面再收敛一次。写的是 File(结构化克隆含字节),读回可当 Blob 用。
  // ⛔ 占位不入快照:它还没有字节,进去就是个空洞。
  let persistChain: Promise<void> = Promise.resolve();
  function persist(): void {
    const snapshot = ready().map((s) => ({ id: s.held!.id, blob: s.held!.file as Blob }));
    persistChain = persistChain.then(() => syncDraft(snapshot)).catch(() => {});
  }

  /** 一张都没有(含占位)才整条收起 —— 占位期间这条得**留在屏上**,它就是那个反馈。 */
  function syncVisibility(): void {
    container.hidden = slots.length === 0;
  }

  function drop(slot: Slot): void {
    if (slot.held) URL.revokeObjectURL(slot.held.url);
    slot.node.remove();
    slots = slots.filter((s) => s !== slot);
    syncVisibility();
  }

  function makeSlot(): Slot {
    const img = document.createElement("img");
    // 解码完才淡入(CSS `.cthumb img` 起手 opacity:0)。**error 也要摘骨架**:HEIC 这类
    // 本端解不开的原图会原样放行(downsampleForUpload 的诚实边界),不接这一路就留下
    // 一个永远转下去的圈。标 .err 与卡上缩略图同形(`.thumb.err`)。
    img.addEventListener("load", () => img.classList.add("in"), { once: true });
    img.addEventListener(
      "error",
      () => {
        img.classList.add("in");
        node.classList.add("err");
      },
      { once: true },
    );
    const spin = document.createElement("span");
    spin.className = "cspin";
    spin.setAttribute("aria-label", t("images.processing"));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "cthumb-del";
    del.textContent = "×";
    del.setAttribute("aria-label", t("images.removeThis"));
    const node = document.createElement("div");
    node.className = "cthumb pending";
    node.append(img, spin, del);
    const slot: Slot = { node, img, del, held: null };
    del.addEventListener("click", (e) => {
      e.stopPropagation(); // 别连带触发下面那条「点缩略图看大图」
      drop(slot);
      persist();
    });
    // 点开大图。占位态不响应 —— 那时候还没有字节可看,点了只能是「没反应」。
    node.addEventListener("click", () => {
      if (!openPreview || !slot.held) return;
      const items = ready();
      const idx = items.indexOf(slot);
      if (idx < 0) return;
      openPreview(
        items.map((s) => ({ url: s.held!.url, remove: () => (drop(s), persist()) })),
        idx,
      );
    });
    return slot;
  }

  /** 把字节填进一格(新贴 / 启动回填共用)。`id` 传了 = 回填,库里已有这份字节。 */
  function fill(slot: Slot, file: File, id?: string): void {
    const url = URL.createObjectURL(file);
    slot.held = { id: id ?? freshId(), file, url };
    slot.node.classList.remove("pending");
    slot.img.src = url; // load 回来自己淡入
  }

  function appendFilled(file: File, id?: string): Slot {
    const slot = makeSlot();
    slots.push(slot);
    container.append(slot.node);
    fill(slot, file, id);
    syncVisibility();
    return slot;
  }

  syncVisibility();

  return {
    count: () => ready().length,
    add(file) {
      // 有占位就填最前面那个空的(次序 = 选图次序);没有就当场长一格
      // (拍照那条路若 onPicked 没走到、或字节比占位来得还早)。
      const waiting = slots.find((s) => s.held === null);
      if (waiting) fill(waiting, file);
      else appendFilled(file);
      persist();
    },
    reserve(n) {
      for (let i = 0; i < n; i += 1) {
        const slot = makeSlot();
        slots.push(slot);
        container.append(slot.node);
      }
      syncVisibility(); // 占位不 persist:没有字节可写
    },
    dropReserved() {
      for (const s of [...slots]) if (s.held === null) drop(s);
    },
    takeBatch() {
      // ⛔ 只带走**已经有字节**的那些;占位留在屏上 —— 它们的字节还在路上,按两缓冲
      // 的规矩属于下一条,骨架也该继续给着反馈。
      const taken = ready();
      const files = taken.map((s) => s.held!.file);
      for (const s of taken) drop(s);
      persist(); // 冻结带走即清持久化(记下成功=草稿了结;失败由 putBack 复写回)
      return files;
    },
    putBack(batch) {
      // 退回的旧批插在在飞期间新贴的图之前(重试时次序不变),objectURL 重建。
      // id 也是新的:takeBatch 那一刻这些键已从库里删掉,退回等于重新写一遍字节。
      // ⚠ **先进 DOM 再填字节**(同 appendFilled 的次序):过渡要有「插进来那一刻是
      // opacity:0」这一步才跑得起来,填完再插等于直接以终态露面。
      const restored = batch.map(() => makeSlot());
      slots = [...restored, ...slots];
      container.prepend(...restored.map((s) => s.node));
      restored.forEach((s, i) => fill(s, batch[i]));
      syncVisibility();
      persist();
    },
    clear() {
      for (const s of [...slots]) drop(s);
      persist();
    },
    async attachBatch(space, itemId, batch) {
      let failed = 0;
      const whys: string[] = [];
      for (const file of batch) {
        try {
          await addItemImage(space, itemId, file.type, await toBase64(file));
        } catch {
          // ⛔ 别退回裸 catch(538):原因丢了就只剩「几张」,而用户那句话也就只能是泛指引。
          whys.push(whyAttachFailed(file));
          failed += 1;
        }
      }
      return { failed, why: [...new Set(whys.filter((w) => w !== ""))].join("") };
    },
    async restore() {
      if (slots.length) return; // 启动后用户已抢先贴图/正在取图:不覆盖
      let items: DraftItem[];
      try {
        items = await loadDraft();
      } catch {
        return; // IndexedDB 不可用/读失败:恢复尽力而为,不拦启动
      }
      if (!items.length || slots.length) return; // await 期间可能已被贴入:再核一次
      // **id 原样带回**:这些字节库里已经有了,下一次 persist 只写清单不重写它们。
      for (const it of items) appendFilled(it.blob as File, it.id);
    },
  };
}
