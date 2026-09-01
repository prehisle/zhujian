// Shared 配图 (item images) controller — one source of truth for attaching, showing,
// referencing, and deleting the numbered 「图N」 images that hang off an item. Used by both
// the 灵感 cards (inbox.ts) and the 任务看板 cards (board.ts), mirroring the backend's
// images.rs / hotkey-menu.ts shared-controller pattern so the behaviour is identical across
// views. Images are a per-item 1:N attachment; the 编号 is stable and never reused, so a
// 正文「见图N」 reference always points at the same picture (see migration 0016).

import { invoke, invokeInSpace } from "./space";
import { t } from "./i18n";
import { parseChecklistLine } from "./checklist";
import { saveImageDraft, loadImageDraft, newDraftImageId, type DraftImage } from "./compose-draft";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText } from "./clipboard";
import { readImage, writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { Image as ShellImage } from "@tauri-apps/api/image";
import { flashToast, toastAction } from "./toast";
import { PhysicalPosition, PhysicalSize, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import "./item-images.css";

/** Mirror of lib.rs `ImageMeta` (no bytes): an image's id, 「图N」编号, and MIME. */
export type ImageMeta = { id: string; seq: number; mime: string };

/** attachBatch 部分失败时的补救指引。此前在 board / inbox / 捕获窗三个 compose 各抄
 *  一份、已漂成两种说法(「卡片编辑态」vs「卡片里」)——同一语义收成一处。 */
export const REPASTE_HINT = t("itemImages.repasteHint");

// ---- 挂图失败时,能对用户说的那句话(538,backlog 用户面 56)-------------------
// **病**:批量挂图(compose / 捕获窗)失败时只数得出「N 张」,配的话是「可在卡片编辑态
// 重新粘贴」—— 而 537 量到:够得着的拒法(不支持的类型 / 过大)**全是确定性的**,同样的
// 字节再贴一次还是同样被拒 ⇒ 那句指引把用户支去做一件注定失败的事;对**回填来的草稿**
// 更是空话(那张图早就不在用户手上了)。而后端**本来就说得出一句照着能行动的话**,
// 却在 `catch` 里被扔掉了(诊断那半 528 已接住,给用户看的那半没有)。
//
// **形:前端自己推那句话,⛔ 不是把后端那串原样贴出来。** 两个理由:
//   ①后端诊断串**拍板不翻**(i18n-plan)⇒ 原样贴出去,英文界面上会冒出中文;
//   ②后端也会回内部错(`FOREIGN KEY constraint failed` 之类),那种给用户看没用(528 立的界)。
// ⚠ **这是副本,后端仍是权威** —— 而且是**安全的那个方向**:本函数**只在挂图已经失败
// 之后**才跑,⇒ 名单漂了最坏是「话说得不够准」,⛔ 绝不可能挡下一张后端本来收得下的图。
// ⛔ **判定顺序照抄 `core/src/images.rs::attach`(空 → 过大 → MIME)** —— 顺序错了会答错原因。
const ATTACH_MAX_MB = 32; // = core 的 MAX_IMAGE_BYTES
const ATTACH_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"]; // = core 的 ALLOWED_MIME

/** 挂图失败的原因里**能对用户说的那句**;前端看不出来就回 `""`。
 *  ⛔ 回 `""` 时调用方该退回原来那句泛指引,**别猜一个像样的原因** —— 猜错正是这条账在修的病。 */
export function whyAttachFailed(blob: Blob): string {
  if (blob.size === 0) return t("itemImages.failEmpty");
  if (blob.size > ATTACH_MAX_MB * 1024 * 1024)
    return t("itemImages.failTooBig", {
      mb: Math.round(blob.size / (1024 * 1024)),
      max: ATTACH_MAX_MB,
    });
  if (!ATTACH_MIME.includes(blob.type)) return t("itemImages.failBadType", { mime: blob.type || "?" });
  return "";
}

/** 一批挂完的结果:几张没挂上 + **那句话**(说得准就是具体原因,说不准是 `""`)。 */
export type AttachOutcome = { failed: number; why: string };

/** 批里逐张失败原因 → 一句话:去重、按批内顺序拼;⛔ 一条都说不准时回 `""`。 */
function joinWhy(whys: string[]): string {
  return [...new Set(whys.filter((w) => w !== ""))].join("");
}

// ---- small DOM helper (kept local so this module stands alone) -------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

/** List an item's images (编号 ascending; deleted 编号 leave gaps). */
export function listImages(itemId: string): Promise<ImageMeta[]> {
  return invoke<ImageMeta[]>("list_item_images", { itemId });
}

// 「这条有哪几张图」的元数据缓存 —— 163② 修的是**图字节**那层(thumbCache),漏了这一层。
// 症状:两个视图都是「数据一变就全量重画」,每张卡重建时图条初始是 `.empty`(display:none),
// 要等 `list_item_images` 的 IPC 回来才显形 ⇒ 一屏有图的卡集体「矮 80px 再长回来」。拖卡换列
// 时最扎眼,但凡是真重画都闪(编辑一条、打个标签、对端同步下来一条)。
//
// 修法与 163 那轮同一条契约:**乐观呈现** —— 缓存只用来「先画」,每次仍照发 IPC 对账。
// ⭐ 因此它不会画错,只会画早:对端新加的图照常出现,只是晚一帧;删掉的图晚一帧消失。
// ⛔ 别把它改成「有缓存就不发 IPC」—— 那才是把「早一帧」换成「永远不对」。
// 缓的是**已到手的数组**、不缓 Promise(同 thumbCache 的理由:跨空间迟到响应永不决议,
// 缓 Promise 会把挂起永久钉进 Map,163③ 教训)。
// 内存:每条几个 {id,seq,mime},比 thumbCache 的 base64 小两个数量级,但**同样随浏览过的
// 条目线性增长、不是有界的** —— 别读成有界。
const metaCache = new Map<string, ImageMeta[]>();

/** 两份 metas 是不是同一批图(顺序也算)。对账用:相同就一个 DOM 节点都不碰。 */
function sameMetas(a: ImageMeta[] | null, b: ImageMeta[]): boolean {
  return a !== null && a.length === b.length && a.every((m, i) => m.id === b[i].id && m.seq === b[i].seq);
}

// 图字节内存纪律(163② 学安卓 117):缩略图条**每张卡都渲染只读小图**、桌面又无懒加载,
// 若像 163③ 那样按 id 缓「全尺寸 data URL」,缓存会随图库线性膨胀且永不释放——base64 是 JS
// 强引用字符串,不受 WebView 图片缓存的压力驱逐;且每个 <img> 还常驻解码整张全尺寸位图。
// 改为:缩略图**过 canvas 降采样成 ≤144² 方裁小图**(与 .img-thumb 的 72² object-fit:cover
// 同款中心裁,视觉不变),只缓小图;lightbox 要全尺寸,只留「最近看过的 1 张」(二开秒显、
// 又不无界)。两处都只缓**已到手的字符串**、不缓 Promise——统一 invoke 包装把跨空间迟到响应
// 变成「永不决议」(space.ts stale),缓 Promise 会把这种挂起永久钉进 Map(163③ 教训)。
// 图不可变(只增删不改,0016)故小图永不失效,删图时清项。
//
// **0032 起这只 Map 只是第一层**(image-perf-plan §3.3):底下多了一张本地派生表,算好的
// 小图落库,重启后也不用再「读整图 + 解码整图 + 缩 + 再编码」一遍。这一层留着,是因为它
// 缓的是 ≤144² 的小图 —— **仍然随图库线性增长,只是系数小了两个数量级**(几 KB vs 几百 KB),
// 上面那条「按 id 缓全尺寸会膨胀到不可接受」的理由不再适用。别把它读成「有界」。
const thumbCache = new Map<string, string>(); // imageId → 降采样 ≤144² data URL

// lightbox 的全尺寸缓存:只留最近看过的一张(换图即顶掉旧的 → 至多 1 张全尺寸常驻)。
let lastFull: { id: string; url: string } | null = null;

/** 全尺寸字节 → data URL(lightbox 用)。命中「刚看过那张」秒回,否则取回并顶掉旧的。 */
function getFullImage(imageId: string): Promise<string> {
  if (lastFull && lastFull.id === imageId) return Promise.resolve(lastFull.url);
  return invoke<string>("get_item_image", { imageId }).then((url) => {
    lastFull = { id: imageId, url }; // 旧 url 无人引用即可回收(至多留 1 张全尺寸)
    return url;
  });
}

// 降采样(安卓 117 手法):一律过 canvas 重编码成 ≤144² 的 cover 方裁——原图哪怕像素尺寸小
// 也可能字节巨大(多帧/元数据),直接缓原 data URL = 缓存无界;只钉短边则超宽长图 thumb 仍
// 巨大,故两边都钉死。小图不放大、照样重编码;透明 PNG 经 JPEG 扁平化会失透明(与安卓一致,
// lightbox 看的仍是原图)。解码失败响亮 reject,调用方标 .broken。
const THUMB_PX = 144;
function shrinkToThumb(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => {
      const crop = Math.min(img.naturalWidth, img.naturalHeight); // 原图中央方形
      const side = Math.min(THUMB_PX, crop);
      const c = document.createElement("canvas");
      c.width = side;
      c.height = side;
      const ctx = c.getContext("2d");
      if (!ctx) return reject(new Error("canvas 2d 上下文不可用"));
      // 中央方裁 → 缩到 side×side(cover;source rect 居中,dest 铺满)。
      ctx.drawImage(img, (img.naturalWidth - crop) / 2, (img.naturalHeight - crop) / 2, crop, crop, 0, 0, side, side);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = (): void => reject(new Error("图片解码失败"));
    img.src = url;
  });
}

/** 后端缩略图响应(镜像 lib.rs `ThumbData`)。`thumb=false` = 派生表未命中,`url` 是全尺寸。
 *  规格 token 不出 core,前端不碰它(image-perf-plan §3.1④)。 */
type ThumbData = { url: string; thumb: boolean };

/** 缩略图小图(缩略图条用)。三层:内存 Map → 本地派生表(0032)→ 全尺寸现算。
 *
 *  命中派生表就只过来几 KB,连解码整张全尺寸位图那一步都省了(§2:一屏十张卡原本要读
 *  7.8 MB、解码 10 张全尺寸位图)。未命中才走老路 —— 取全尺寸、canvas 缩、**异步回存**
 *  (不阻塞渲染);回存失败无害,下次再算,故 catch 掉不打扰用户。 */
function getThumb(imageId: string): Promise<string> {
  const hit = thumbCache.get(imageId);
  if (hit !== undefined) return Promise.resolve(hit);
  return invoke<ThumbData>("get_item_thumb", { imageId }).then(async (r) => {
    if (r.thumb) {
      thumbCache.set(imageId, r.url); // 已是 ≤144² 小图,直接进内存层
      return r.url;
    }
    const small = await shrinkToThumb(r.url);
    thumbCache.set(imageId, small);
    void invoke("put_item_thumb", {
      imageId,
      dataB64: small.slice(small.indexOf(",") + 1), // 去掉 data:image/jpeg;base64, 前缀
    }).catch(() => {}); // 存不进去就是下次再算(派生数据,失败无害)
    return small;
  });
}

// Blob -> base64 (no data: prefix) for the IPC hop. Chunked so a large image never
// blows the argument limit of String.fromCharCode(...spread).
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// 上传前降采样(194 可优化项①):两道闸——**主闸** 长边 > UPLOAD_MAX_EDGE 按比例缩;
// **副闸(B)** 尺寸达标但字节偏大的**照片**(JPEG 源)也重编码,补「小尺寸大体积」漏网。
// 副闸只认 JPEG:透明 PNG 与文字截图(截图多为 PNG)天然豁免,不被 JPEG 化丢透明/糊字。
// 任一闸命中就 canvas 重绘 → JPEG q0.85;都不命中 / 解码不了(HEIC 等)/ 缩后反更大均放行
// 原图(后端 MIME 闸仍是权威)。免相册/剪贴板原图整份进 E2EE 库并下行到所有设备。
const UPLOAD_MAX_EDGE = 2560;
const UPLOAD_HEAVY_BYTES = 1_500_000; // ~1.5MB:尺寸内但比这肥的 JPEG 照片也压
function downsampleForUpload(blob: Blob): Promise<Blob> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const done = (out: Blob): void => {
      URL.revokeObjectURL(url);
      resolve(out);
    };
    const img = new Image();
    img.onload = (): void => {
      const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
      const overDim = maxDim > UPLOAD_MAX_EDGE; // 主闸
      const heavyPhoto = blob.type === "image/jpeg" && blob.size > UPLOAD_HEAVY_BYTES; // 副闸
      if (!overDim && !heavyPhoto) return done(blob); // 尺寸达标且非肥照片:原样(不动透明)
      const scale = Math.min(1, UPLOAD_MAX_EDGE / maxDim); // 只缩不放大;副闸场景 scale=1 仅重编码
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return done(blob);
      ctx.drawImage(img, 0, 0, w, h);
      c.toBlob((out) => done(out && out.size < blob.size ? out : blob), "image/jpeg", 0.85);
    };
    img.onerror = (): void => done(blob); // 解码失败(HEIC 等):原样交后端,该拒的响亮拒
    img.src = url;
  });
}

/** Attach one image blob (pasted screenshot or picked file) to an item as its next 「图N」.
 *  Resolves to the new image's metadata. Throws on a bad type / empty blob (the backend's
 *  CHECK is the authority — fail-fast, no silent default). */
export async function attachBlob(itemId: string, blob: Blob, space?: string): Promise<ImageMeta> {
  const use = await downsampleForUpload(blob); // 大图先降采样,截图/小图原样
  const dataB64 = await toBase64(use);
  // 显式空间 = 必落账链(创建后挂图):响应恒到达,不走「跨空间迟到即永不决议」的
  // 统一包装——那会把 in-flight 闸卡死(codex P1 二审 H1)。
  if (space !== undefined)
    return invokeInSpace<ImageMeta>(space, "add_item_image", { itemId, mime: use.type, dataB64 });
  return invoke<ImageMeta>("add_item_image", { itemId, mime: use.type, dataB64 });
}

// ---- 挂图失败的原因留在哪儿(528,backlog 测试与工装 45)-------------------
// `attachBatch` / `attachAll` 逐张挂、**一张失败不拖垮其余张**,所以 `catch` 本身是对的;
// 错的是此前那两处是**裸 `catch`** —— 只把张数加一、**原因整个丢掉**。⇒ 用户看到「N 张图
// 未能附加」,而开发者手上一个字都没有:526 那条账因此卡了三轮(515 只好绕道去读屏幕上
// 那句提示,那是**从外面**看,读不到异常本身;而 526 拿探针猜根,猜错了)。
//
// 形(刻意小):①`console.error` 一份,本机开发直接看得见;②压进一个**有上界**的环,
// 挂在 `window` 上给 e2e / 诊断读 —— 理由是 **wry 上浏览器 console 到不了 CI 日志**,
// 而 e2e 的失败消息到得了(`e2e/specs/support.js::waitItemImages` 现在会带上它)。
// ⛔ **不进 DB / 不进同步 / 不进用户可见文案** —— 给用户的那句仍是 `savedImagesFailed`
// (用户看不懂 `NotFoundError`,也帮不上忙)。⚠ 它是**诊断**不是判据:环会被后来的失败挤掉,
// 读不到不代表没失败过。
const ATTACH_FAIL_KEEP = 8;
const attachFailures: string[] = [];
function noteAttachFailure(itemId: string, e: unknown): void {
  const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  // ⚠ 这一句**刻意写成英文**:它是给开发者看的诊断(落 CI 日志 / console),不是用户文案。
  // 第一版写的是中文,`check-i18n-drift` 当场逮到(「写死的可见中文」)—— 那道闸没判错:
  // 它扫的就是前端产物里的中文。⛔ 别去 STRING_REGISTRY 里签字绕过它,**把非用户文案挪出
  // 那个面**才是对的;给用户的那句仍是 `savedImagesFailed`,在字典里。
  const line = `add_item_image(${itemId}) failed: ${why}`;
  console.error(line);
  attachFailures.push(line);
  if (attachFailures.length > ATTACH_FAIL_KEEP) attachFailures.shift();
}
(window as unknown as { __zhujianAttachFailures?: () => string[] }).__zhujianAttachFailures = () =>
  attachFailures.slice();

/** The first image on a paste, or null if the clipboard carried none (so the caller can let
 *  a normal text paste through). Screenshots arrive as a `file`-kind image item. */
export function imageFromPaste(e: ClipboardEvent): Blob | null {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const it of items) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/** 退路:直接问壳的剪贴板要图(Rust 侧 arboard 交回原始 RGBA),重绘成一张 PNG blob。
 *  剪贴板里根本没有图是**常态**(用户按了 Ctrl+V 但复制的是别的东西)⇒ 那一路 resolve
 *  null,不是失败;真失败(尺寸对不上像素数、canvas 不可用)照旧 throw,由调用方响亮报。 */
async function imageFromShellClipboard(): Promise<Blob | null> {
  let shot: ShellImage;
  try {
    shot = await readImage();
  } catch {
    return null; // 剪贴板里没有图 —— 正常的一次「没什么可贴」,不报错
  }
  const { width, height } = await shot.size();
  const rgba = await shot.rgba();
  if (width <= 0 || height <= 0 || rgba.length === 0) return null;
  if (rgba.length !== width * height * 4)
    throw new Error(`剪贴板图尺寸对不上:${width}×${height} 却有 ${rgba.length} 字节`);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas 2d 上下文不可用");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("图片编码失败");
  return blob;
}

/** 一次粘贴里取图的**唯一入口**(compose 暂存与卡片编辑态两条 wire 都走它)。
 *
 *  「要不要拦下这次粘贴」必须**同步**决定完(preventDefault 不能等 await),故分三支:
 *  ①标准 DataTransfer 给了图 ⇒ 当场拦下收图。Windows/mac 恒走这条,行为一字不变。
 *  ②没图但有文字 ⇒ 这就是一次文字粘贴,放行,**不去问壳**(不给每次贴字都加一趟 IPC)。
 *  ③既无图也无文字 ⇒ 默认粘贴本来就什么都插不进去(拦与不拦同果),故**不 preventDefault**、
 *    异步问一次壳。Linux(WebKitGTK)恒落这条:它 paste 事件里的 clipboardData 的
 *    `types`/`items`/`files` 全是空的、只有 `getData` 拿得到文字 ⇒ 贴文字一直正常,断的
 *    只有图这条(progress-log 394 锁死的根因)。
 *
 *  ⚠ 诚实边界:图与文字**同时**在剪贴板上时,两条路会给出不同结果 —— 标准路认图(①),
 *  WebKitGTK 那条只看得见文字、按②放行贴字。这是平台差异,不在本轮射程内。 */
function pasteImage(e: ClipboardEvent, onBlob: (b: Blob) => void, onError: (err: unknown) => void): void {
  const direct = imageFromPaste(e);
  if (direct) {
    e.preventDefault();
    onBlob(direct);
    return;
  }
  if (e.clipboardData?.getData("text/plain")) return; // 文字粘贴:放行
  imageFromShellClipboard()
    .then((blob) => {
      if (blob) onBlob(blob);
    })
    .catch(onError);
}

// 看图时 Ctrl+C 复制整张图(223)。剪贴板写图在 Chromium/WebView2 只保证认 image/png,
// 而库里存的可能是 jpeg/webp/gif,故一律过 canvas 重绘成 PNG 再写——不是转码洁癖,是不转
// 就写不进去。已知折损:GIF 动图只得当前帧(canvas 取不到动画),透明 PNG 走 canvas 保 alpha。
// 走的是 <img> 已解码的像素,不重新取字节(全尺寸图本就在眼前这张 img 上)。
async function copyImageToClipboard(img: HTMLImageElement): Promise<void> {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas 2d 上下文不可用");
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("图片编码失败");
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch (webErr) {
    // Linux 真机(progress-log 394):WebKitGTK 的异步剪贴板**只认文本**,写图恒
    // `NotAllowedError`(真按键、有用户手势也一样)——那条路上用户拿到的是「复制失败」。
    // 退到壳的剪贴板插件(Rust 侧 arboard)把同一张图交给系统剪贴板。不是兜底默认值:
    // 它是另一条真机制,两条都不成才失败,而失败照旧响亮(调用方的 copyFail 回执)。
    // Windows/mac 上第一条本就成功,永远走不到这里(生产端行为一字不变)。
    // 交的是**canvas 的原始 RGBA**,不是上面那份 PNG 字节:插件的 writeImage 只认 RGBA
    // (喂 PNG 字节报「expected RGBA image data」),而由 PNG 字节造 Image 的
    // `Image.fromBytes` 要 tauri 的 `image-png` feature —— 用 RGBA 两样都不欠。
    try {
      const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
      await writeImage(await ShellImage.new(new Uint8Array(rgba.buffer), c.width, c.height));
    } catch (shellErr) {
      throw new Error(`剪贴板写图失败(web:${String(webErr)} / shell:${String(shellErr)})`);
    }
  }
}

/** Mount a full-window overlay around `inner`; click anywhere or press Esc closes it.
 *  `onClose` runs while the overlay is STILL up and is awaited before teardown — so a caller
 *  that shrinks a grown window does it under the dark backdrop (no bare-window flash on close).
 *  焦点陷阱(a11y):开图即把焦点移进遮罩、Tab/Shift+Tab 焦点困在遮罩内转圈(别溜到背后被盖住
 *  的看板/灵感按钮上误触),关闭时把焦点还给打开前的元素(缩略图/正文链接)。 */
function mountLightbox(
  inner: HTMLElement,
  onClose?: () => void | Promise<void>,
  onNav?: (delta: -1 | 1) => void,
): { overlay: HTMLElement; close: () => Promise<void> } {
  const overlay = el("div", { className: "img-lightbox" }, [inner]);
  overlay.tabIndex = -1; // 让遮罩自身可聚焦:遮罩内无可聚焦子元素时,焦点有个「家」落回这里
  const prevFocus = document.activeElement as HTMLElement | null; // 关闭后把焦点还回原处
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return; // a click + Esc race shouldn't run teardown twice
    closing = true;
    try {
      await onClose?.();
    } finally {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.(); // 焦点还给打开前的元素,不留在已摘除的遮罩上(读屏/键盘不迷路)
    }
  };
  // Tab 焦点陷阱:遮罩内通常没有可聚焦子元素(只有图+文字),故 Tab 一律钉回遮罩自身;若日后加了
  // 按钮等可聚焦项,则在首/末之间环绕——焦点始终困在遮罩内,不落到背后被盖住的界面上。
  const trapTab = (e: KeyboardEvent): void => {
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      e.preventDefault();
      overlay.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !overlay.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };
  // 遮罩底部中央的一次性回执(z 抬到遮罩之上,否则被 9000 层盖住看不见)。
  const toast = (text: string): void =>
    flashToast(window.innerWidth / 2, window.innerHeight - 20, text, { extraClass: "on-lightbox" });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    // Ctrl/Cmd+C:把眼前这张图复制到剪贴板。遮罩内没有可选文本,这个键位空着。
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      if (e.repeat) return; // 按住不放不重复编码整张图
      const shown = overlay.querySelector<HTMLImageElement>("img.img-lightbox-img");
      if (!shown || shown.naturalWidth === 0) return; // 还没解码出来 / 已换成失败面:不假装复制
      copyImageToClipboard(shown).then(
        () => toast(t("itemImages.copiedImage")),
        () => toast(t("itemImages.copyFail")), // 写剪贴板被拒要响亮,别静默(与 clipboard.ts 同纪律)
      );
      return;
    }
    // ←/→ 在同条目的整组图内翻页(只有多图时 onNav 才在,单图这两键照旧无义)。
    if (onNav && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      onNav(e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (e.key === "Tab") trapTab(e);
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  overlay.focus({ preventScroll: true }); // 开图即把焦点移进遮罩,Tab 从此在内部转圈
  return { overlay, close };
}

/** Lightbox image viewer:「整图」或「铺满宽度」两种取向 + 原生滚动 + Ctrl+滚轮缩放。图尺寸
 *  由 JS 直接写 width/height(不用 transform),溢出交给 `.img-lightbox`(overflow:auto)原生
 *  滚动——开图默认「整图」先看全貌(超高长截图也不例外;默认铺宽会让人误以为图到视口底为止),
 *  双击切「铺宽」滚看细节。交互(方案 A):无 Ctrl 滚轮=能竖滚就原生滚、否则(整图放得下)缩放;`Ctrl+滚轮`
 *  永远缩放(rect 锚点);双击切「整图↔铺宽」(且此后 resize 不再自动改取向);溢出时拖着滚(手
 *  型),整图放得下时单击关闭(延迟一个双击判定窗口,免与双击抢)。`init()` 在自然尺寸 + 最终窗口
 *  尺寸都定后挑取向并布局一次(mode 未被用户双击改过时,resize 会自动重挑取向,兜住 capture 先小
 *  窗 init 再放大的时序)。`cleanup()` 摘 EVERY 监听(含 window resize)——调用方必须在关闭时调,
 *  否则 resize 监听常驻拽住 img 的全尺寸位图不放,破「不缓存全尺寸图」内存纪律(codex 三审 H3)。 */
function makeImageViewer(
  img: HTMLImageElement,
  requestClose: () => void,
): { init: () => void; cleanup: () => void; signal: AbortSignal } {
  const ac = new AbortController();
  const { signal } = ac;
  // 布局未定不显示(ui-guidelines §3.7):.img-lightbox-img 无 CSS 尺寸约束,宽高全靠下面
  // layout() 写——从 src 解码到 init() 之间隔着取字节/量窗/放大窗数个 await,裸渲染会以
  // 原始尺寸闪现、随窗口放大反排、最后猛缩定位(2026-07-19 用户实测的「过渡状态」)。
  // 故出生即隐形零占位,init() 定形后一次成形亮相。
  img.style.visibility = "hidden";
  img.style.width = "0px";
  img.style.height = "0px";
  const PAD = 32; // 与 .img-lightbox-stage padding 一致
  const DRAG_THRESHOLD = 4; // px:超过才算拖动(否则算单击)
  // ms:单击关闭的延迟。旧值 500 是照「系统双击判定」定的,白等半秒(用户报「点了图关不掉、卡」);
  // 但把它一味砍短是拿**双击容错**换的——安卓真机实测:延迟砍到 200ms 后,两次按下间隔 226ms
  // 的双击第一击就把图关了,第二击落在空处(想放大却关了图)。系统标准的双击窗口是 300ms
  // (Android)/500ms(Windows),所以这里回到 300 老实覆盖它。
  // **速度感另有出路**:点下去立刻给遮罩挂 `.closing` 开始淡出(setClosing),延迟这段就不再是
  // 一段静止的白等——用户读成「卡」的是「点了没反应」,不是「没立刻消失」。第二击一按下就
  // clearTimeout + 摘 class,淡出被平滑拉回,双击照常放大。
  const CLICK_DELAY = 300;
  let mode: "fit" | "fill" = "fit"; // fill = 铺满宽度、竖向可滚
  let zoom = 1; // 在 mode 基准尺寸上再乘的缩放(Ctrl+滚轮)
  let userToggled = false; // 用户双击切过取向后,resize 不再自动改 mode
  let dragged = false;
  let closeTimer: number | null = null;

  const scroller = (): HTMLElement | null => img.closest<HTMLElement>(".img-lightbox");
  // 关闭中的淡出开关(246):只淡内容、黑底留着(缩窗要在暗遮罩下发生);撤销时摘掉即平滑拉回。
  const setClosing = (on: boolean): void => {
    scroller()?.classList.toggle("closing", on);
  };
  const nw = (): number => img.naturalWidth || 1;
  const nh = (): number => img.naturalHeight || 1;
  const viewport = (): { w: number; h: number } => {
    const s = scroller();
    const w = s ? s.clientWidth : window.innerWidth;
    const h = s ? s.clientHeight : window.innerHeight;
    return { w: Math.max(1, w - PAD * 2), h: Math.max(1, h - PAD * 2) };
  };
  // fit 基准与最小缩放都封顶 1:1——小图不放大(旧 CSS max-width/height 的行为,M3)。
  const fitWholeScale = (): number => {
    const { w, h } = viewport();
    return Math.min(w / nw(), h / nh(), 1);
  };
  const baseScale = (): number => {
    if (mode === "fit") return fitWholeScale();
    const { w } = viewport();
    return Math.min(w / nw(), 1); // 铺宽同样不超 1:1
  };
  const canScrollY = (): boolean => {
    const s = scroller();
    return !!s && s.scrollHeight - s.clientHeight > 1;
  };
  const canScrollX = (): boolean => {
    const s = scroller();
    return !!s && s.scrollWidth - s.clientWidth > 1;
  };
  const canPan = (): boolean => canScrollX() || canScrollY();
  const layout = (): void => {
    const scale = baseScale() * zoom;
    img.style.width = `${Math.round(nw() * scale)}px`;
    img.style.height = `${Math.round(nh() * scale)}px`;
    img.style.cursor = canPan() ? "grab" : "zoom-out";
  };
  // 取向:默认恒「整图」——超高长截图也先看全貌(默认铺宽会让人以为图就到那儿为止);
  // 想看清双击切「铺宽」或 Ctrl+滚轮放大,一步就到(2026-07-18 用户拍板,反转 139 的自动挑)。
  const decideMode = (): void => {
    mode = "fit";
  };
  const init = (): void => {
    if (signal.aborted) return;
    wire(); // 遮罩此时已进 DOM → 把滚轮挂到 scroller(见 onWheel/wire)
    if (!userToggled) decideMode();
    zoom = 1;
    layout();
    const s = scroller();
    if (s) {
      s.scrollTop = 0;
      s.scrollLeft = 0;
    }
    img.style.visibility = ""; // 定形完毕,一次成形亮相(与构造时的出生隐形配对)
  };

  // 光标锚点缩放:用 img 真实 rect 算光标在图内的归一坐标,缩放后调 scroll 让它回到光标处
  // (避开 padding + 居中偏移;图仍居中未溢出时无 scroll 范围、这帧锚点近似,浏览器边界钳位)。
  const zoomAt = (cx: number, cy: number, factor: number): void => {
    const s = scroller();
    if (!s) return;
    const before = img.getBoundingClientRect();
    // 光标在图内的归一坐标钳到 [0,1]:Ctrl+滚轮落在图外 padding 时也不会算出离谱锚点(退化到边缘)。
    const fx = before.width > 0 ? Math.min(1, Math.max(0, (cx - before.left) / before.width)) : 0.5;
    const fy = before.height > 0 ? Math.min(1, Math.max(0, (cy - before.top) / before.height)) : 0.5;
    const base = baseScale();
    const oldScale = base * zoom;
    const maxScale = Math.max(1, fitWholeScale() * 8); // 上限=1:1 或整图基准 8× 取大(避免大图被放到离谱尺寸)
    const newScale = Math.min(maxScale, Math.max(fitWholeScale(), oldScale * factor));
    if (newScale === oldScale) return;
    zoom = newScale / base;
    layout();
    const after = img.getBoundingClientRect();
    s.scrollLeft += after.left + fx * after.width - cx;
    s.scrollTop += after.top + fy * after.height - cy;
  };
  // resize/mode 变后 baseScale 变,把绝对 scale 钳回 [整图可见, 8×](zoom 是相对 baseScale 的乘子)。
  const clampZoom = (): void => {
    const base = baseScale();
    const scale = Math.min(Math.max(1, fitWholeScale() * 8), Math.max(fitWholeScale(), base * zoom));
    zoom = scale / base;
  };

  // 滚轮挂在 scroller(整个遮罩,含图外 padding)——Ctrl+滚轮在任何位置都缩放(M1);普通滚轮
  // 能竖滚就交原生、只横溢出的横滚也交原生、否则(整图放得下)缩放。scroller 挂载后由 init 里的
  // wire() 接上(makeImageViewer 构造时遮罩还没进 DOM,拿不到 scroller)。
  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) {
      e.preventDefault();
      // 大图开着时 Ctrl+滚轮**归大图**:必须连冒泡一起掐掉(244 复扫)。241 的界面字号缩放
      // 挂在 document 上、同样只看 ctrlKey,只 preventDefault 拦不住冒泡——两处会同时缩,
      // 图缩一档、整个界面字号也被静默改一档还写进 localStorage(关掉大图回不去、重启还在),
      // 而回执 badge 被遮罩盖住看不见,用户只会觉得「字怎么变了」。
      e.stopPropagation();
      if (e.deltaY !== 0) zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      return;
    }
    if (canScrollY()) return;
    if (canScrollX() && (e.deltaX !== 0 || e.shiftKey)) return;
    if (e.deltaY !== 0) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }
  };
  let wired = false;
  const wire = (): void => {
    if (wired) return;
    const s = scroller();
    if (!s) return;
    wired = true;
    s.addEventListener("wheel", onWheel, { passive: false, signal });
  };
  img.addEventListener(
    "dblclick",
    (e) => {
      e.stopPropagation();
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
        setClosing(false); // 双击撤销待关:淡到一半的内容平滑回来
      }
      mode = mode === "fit" ? "fill" : "fit";
      userToggled = true; // 手动切过 → resize 不再自动改取向
      zoom = 1;
      layout();
      const s = scroller();
      if (s) {
        s.scrollTop = 0;
        s.scrollLeft = 0;
      }
    },
    { signal },
  );
  // 拖动=拽着滚(手型平移):只在有溢出时接管;主指针左键、过阈值才算拖动。
  let sx = 0;
  let sy = 0;
  let moved = 0;
  let panning = false;
  let activePointer: number | null = null;
  img.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      if (closeTimer !== null) {
        clearTimeout(closeTimer); // 第二次按下 → 取消上一击的待关(双击不误关,H1 兜底)
        closeTimer = null;
        setClosing(false); // 连带把淡出拉回来(246)
      }
      if (!canPan()) return; // 整图放得下:让单击走 click→关闭
      panning = true;
      dragged = false;
      moved = 0;
      activePointer = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      img.setPointerCapture(e.pointerId);
      img.style.cursor = "grabbing";
    },
    { signal },
  );
  img.addEventListener(
    "pointermove",
    (e) => {
      if (!panning || e.pointerId !== activePointer) return;
      const s = scroller();
      if (s) {
        s.scrollLeft -= e.clientX - sx;
        s.scrollTop -= e.clientY - sy;
      }
      moved += Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy);
      sx = e.clientX;
      sy = e.clientY;
      if (moved > DRAG_THRESHOLD) dragged = true;
    },
    { signal },
  );
  const endPan = (e: PointerEvent): void => {
    if (!panning || e.pointerId !== activePointer) return;
    panning = false;
    activePointer = null;
    img.style.cursor = canPan() ? "grab" : "zoom-out";
    try {
      img.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  img.addEventListener("pointerup", endPan, { signal });
  img.addEventListener(
    "pointercancel",
    (e) => {
      endPan(e);
      dragged = false; // 取消后无 click 收尾:主动复位,免下次单击被误当拖动吞掉(M4)
      moved = 0;
    },
    { signal },
  );
  img.addEventListener(
    "click",
    (e) => {
      e.stopPropagation(); // 图上的单击永不直接冒泡到遮罩关(交给下面的延迟判定)
      if (dragged) {
        dragged = false;
        return;
      }
      if (canPan()) return; // 长图/放大态:单击不关
      if (e.detail !== 1) return; // 只有真正的单击(非双击的第二下)才安排关闭
      if (closeTimer !== null) return;
      setClosing(true); // 立刻开始淡出 = 立刻有回执(246);延迟这段不再是静止的白等
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        requestClose();
      }, CLICK_DELAY); // 延迟关,给双击(dblclick 会 clearTimeout)取消的机会(H1)
    },
    { signal },
  );
  // resize 后视口变:未被用户双击改过取向则重挑 mode(兜 capture 先小窗后放大),再重排(zoom 留)。
  // 监听走 signal,关闭时随 cleanup 一起摘(H3:不靠"下次 resize 自摘")。
  window.addEventListener(
    "resize",
    () => {
      if (signal.aborted) return;
      if (!userToggled) decideMode();
      clampZoom(); // 视口变后把绝对 scale 钳回合法区间(zoom 保留;M2/M3 残留)
      layout();
    },
    { signal },
  );
  return {
    init,
    signal,
    cleanup: (): void => {
      if (closeTimer !== null) clearTimeout(closeTimer);
      ac.abort();
    },
  };
}

/** 关闭第一步:把遮罩里的**内容**卸干净,只留纯黑底。遮罩本体还盖着,所以不会露裸窗。
 *  为什么单拎一步:关闭要先把主窗从「撑到近满屏」缩回原尺寸,而缩窗会让 WebView 把整个
 *  主窗重排重绘一遍——此刻若全尺寸位图还挂在遮罩里,它得陪着一起重绘;偏偏遮罩要等
 *  restore 跑完才撤,这一段全发生在用户「已经想关了」之后、且零反馈(用户报的「关闭好卡」
 *  的第二段,第一段是单击延迟)。先卸再缩,缩的是一屏纯色。
 *  `removeAttribute("src")` 而非 `src=""`:后者在部分 WebView 里会当相对 URL 去重新请求
 *  当前页;移掉属性才是干净地断掉对那份 data URL 的引用,位图可即刻回收。 */
function shedVisuals(overlay: HTMLElement, img: HTMLImageElement): void {
  img.removeAttribute("src");
  overlay.replaceChildren(); // stage / 左右箭头 / 角标一并撤走
}

/** 看已保存图时把笔记本主窗放大到「图原尺寸 + 边距」(上限=显示器 92%),返回还原原
 *  几何的闭包;不需要放大(已最大化 / 图比当前窗口还小)时返回 null。lightbox 的暗遮罩
 *  铺满的是窗口而非屏幕,故只有把窗口撑到接近屏幕,CSS 的「适配容器」才等于用户要的
 *  「适配屏幕」——小图近原大、大图缩到屏幕合适。复用捕获窗 openPreviewLarge 验证过的
 *  92%/PAD 算法(main.ts)。所有权限调用失败(没授权/取不到显示器)都吞成 null:lightbox
 *  照常显示,只是仍受窗口边界。scaleFactor 走免权限的 devicePixelRatio。 */
async function planGrowMainWindow(
  naturalW: number,
  naturalH: number,
): Promise<{ restore: () => Promise<void>; applyGrow: () => Promise<void> } | null> {
  const win = getCurrentWindow();
  try {
    if (await win.isMaximized()) return null; // 已铺满屏幕,lightbox 本就是屏幕尺寸
    const sf = window.devicePixelRatio || 1;
    const prevSize = await win.innerSize(); // physical;原样存、原样还原,免 DPI 换算误差
    const prevPos = await win.outerPosition(); // physical
    const prevW = prevSize.width / sf; // 逻辑单位,与 naturalWidth(CSS px)/显示器逻辑尺寸同口径
    const prevH = prevSize.height / sf;
    let maxW = 1280;
    let maxH = 880;
    const mon = await currentMonitor();
    if (mon) {
      const msf = mon.scaleFactor || 1;
      maxW = Math.floor((mon.size.width / msf) * 0.92);
      maxH = Math.floor((mon.size.height / msf) * 0.92);
    }
    const PAD = 56; // lightbox padding + 一点余量
    const targetW = Math.max(900, Math.min((naturalW || 600) + PAD, maxW)); // 笔记本 minWidth 900
    const targetH = Math.max(600, Math.min((naturalH || 400) + PAD, maxH)); // minHeight 600
    if (targetW <= prevW && targetH <= prevH) return null; // 图已放得下,别动窗口(免无谓跳动)
    // 原地长大,不再无脑 center(用户报:看张图不该把整个主窗甩到屏幕正中):保持原左上角,只在撑大
    // 后会超出当前显示器时朝内钳最小的一段(窗比屏还大就贴左上角)。全程用物理像素算——outerPosition
    // 与显示器 position/size 都是物理量,免 DPI 换算误差;取不到显示器信息(mon 为空)才退回旧的居中。
    let targetPos: PhysicalPosition | null = null;
    if (mon) {
      const msf = mon.scaleFactor || 1;
      const physW = Math.round(targetW * msf); // setSize 用逻辑尺寸;窗在本显示器上,物理尺寸即 ×msf
      const physH = Math.round(targetH * msf);
      const maxX = mon.position.x + mon.size.width - physW; // 右不溢出的左上角上界
      const maxY = mon.position.y + mon.size.height - physH; // 下不溢出的左上角上界
      const x = Math.max(mon.position.x, Math.min(prevPos.x, maxX)); // 先钳上界再钳下界:窗>屏时落左上
      const y = Math.max(mon.position.y, Math.min(prevPos.y, maxY));
      targetPos = new PhysicalPosition(x, y);
    }
    // restore 与 applyGrow 分开返回:调用方先登记 restore 再 applyGrow,故即使关闭抢在
    // 放大过程中(setSize/setPosition 的 await 间隙)发生,onClose 也能把窗口还原回去。
    // 位置到底动没动:targetPos 为空走的是 center()(必动),否则只有钳位真把左上角挪开才算动。
    // 「原地长大」是常态(窗口没越出显示器),那时还原只需改回尺寸——省掉的这次 setPosition
    // 是关闭路径上一整趟 IPC + 一记窗口消息,而关闭时遮罩正等着它跑完才撤(用户感知的「卡」)。
    const posMoved = targetPos === null || targetPos.x !== prevPos.x || targetPos.y !== prevPos.y;
    const restore = async (): Promise<void> => {
      try {
        await win.setSize(new PhysicalSize(prevSize.width, prevSize.height));
        if (posMoved) await win.setPosition(new PhysicalPosition(prevPos.x, prevPos.y));
      } catch {
        /* 还原失败无妨——用户可手动调整 */
      }
    };
    const applyGrow = async (): Promise<void> => {
      await win.setSize(new LogicalSize(targetW, targetH));
      if (targetPos) await win.setPosition(targetPos); // 原地长大 + 边界钳位(替代无脑 center)
      else await win.center(); // 无显示器信息:退回旧的居中行为
    };
    return { restore, applyGrow };
  } catch {
    return null;
  }
}

/** 放大窗口的 IPC 返回不等于 WebView 视口已更新(WM_SIZE→webview 重排→JS resize 异步
 *  到达)。init() 若用旧视口布局,亮相后会被迟到的 resize 再排一次——尺寸可见地跳一记
 *  (163 续案,超高图最显眼)。这里等视口真离开放大前的尺寸并连续两帧稳定再放行;600ms
 *  兜底——setSize 被拒/无效时视口永不变,超时按当前视口布局(等于旧行为,不更糟)。 */
function viewportSettle(preW: number, preH: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let lastW = -1;
    let lastH = -1;
    let stable = 0;
    const tick = (): void => {
      if (signal.aborted) return resolve(); // 关闭抢先:立即放行,调用方靠 closed 止步
      const w = window.innerWidth;
      const h = window.innerHeight;
      if ((w !== preW || h !== preH) && w === lastW && h === lastH) {
        stable += 1;
        if (stable >= 2) return resolve();
      } else stable = 0;
      lastW = w;
      lastH = h;
      if (performance.now() - t0 > 600) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** A full-window overlay showing a SAVED image at full size (bytes load lazily as a data:
 *  URL by id). 滚轮缩放 / 滚动、拖动平移、双击切取向;click backdrop 或 Esc 关闭(见 makeImageViewer)。
 *  在暗遮罩下把主窗撑到近屏幕(planGrowMainWindow),关闭时先摘监听再还原窗口——两步都在
 *  遮罩仍覆盖时发生,无裸窗闪(与捕获窗同纪律)。
 *  **224 起收同条目的整组图**:`images` 是这条目的全部配图、`index` 是点开的那张;>1 张时
 *  ←/→ 键与左右箭头按钮在组内循环翻页(角标显「图N · i/共」)。只一张时零变化——按钮与角标
 *  都不出现,老路径原样。翻页**不重新撑窗**:窗口按第一张的尺寸定好就不再动,否则每翻一张
 *  窗口跳一次(比看不清更难受)。 */
export async function openLightbox(images: ImageMeta[], index: number): Promise<void> {
  if (images.length === 0) return; // 没图可看:不挂空遮罩
  const multi = images.length > 1;
  let cur = Math.min(Math.max(index, 0), images.length - 1);
  let gen = 0; // 换图代次:翻得快时迟到的字节/解码不许盖住新的那张(同安卓 viewerSeq)
  const img = el("img", { className: "img-lightbox-img", alt: t("itemImages.badge", { n: images[cur].seq }) });
  // 取字节/解码/定窗期间的加载指示(§3.7 审计 #14):CSS 延迟淡入,快路径(命中「刚看过」的
  // 全尺寸缓存)一闪而过时不露脸;init 前 remove,showError 的 replaceChildren 也会带走它。
  const loading = el("div", { className: "img-lightbox-loading", textContent: t("itemImages.loading") });
  const stage = el("div", { className: "img-lightbox-stage" }, [loading, img]);
  let closed = false;
  let restore: (() => Promise<void>) | null = null;
  let grow: Promise<void> | null = null; // 进行中的放大;关闭须等它跑完(成/败)再唯一一次还原(H4)
  const viewer = makeImageViewer(img, () => close());
  const { overlay, close } = mountLightbox(
    stage,
    async () => {
      closed = true; // 关标志:让下面异步流(invoke/load/放大)每个 await 后止步
      viewer.cleanup(); // 摘缩放/滚动监听(含 window resize),不泄漏 img
      shedVisuals(overlay, img); // 先卸大图、只留黑底,再去缩窗(见 shedVisuals)
      if (grow) await grow.catch(() => {}); // 等放大真正结束(即便 center 抛错),避免 restore 与放大并发
      if (restore) await restore(); // 仍在暗遮罩下还原窗口几何(只此一次)
    },
    multi ? (delta) => void present((cur + delta + images.length) % images.length, false) : undefined,
  );
  const showError = (): void => {
    if (closed) return;
    viewer.cleanup();
    overlay.replaceChildren(el("div", { className: "img-lightbox-err", textContent: t("itemImages.loadFail") }));
  };
  // 组内导航件(只在多图时存在):左右箭头 + 「图N · i/共」角标。都 position:fixed 钉在视口,
  // 放大后拖着滚图时不跟着跑。按钮的 click 必须 stopPropagation——遮罩自身的 click 是「关闭」。
  const counter = multi ? el("div", { className: "img-lightbox-count" }) : null;
  const navBtn = (dir: -1 | 1): HTMLButtonElement => {
    const b = el("button", {
      className: `img-lightbox-nav ${dir < 0 ? "prev" : "next"}`,
      textContent: dir < 0 ? "‹" : "›",
      title: dir < 0 ? t("itemImages.prev") : t("itemImages.next"),
    });
    b.addEventListener("click", (e) => {
      e.stopPropagation(); // 别冒泡到遮罩的「点背景关闭」
      void present((cur + dir + images.length) % images.length, false);
    });
    return b;
  };
  if (multi && counter) overlay.append(navBtn(-1), navBtn(1), counter);

  /** 呈现第 i 张。`first`=开图那次(要量图撑窗);换图那次只重新解码 + 重排,窗口不动。 */
  async function present(i: number, first: boolean): Promise<void> {
    if (closed) return;
    const my = ++gen;
    cur = i;
    const m = images[cur];
    img.alt = t("itemImages.badge", { n: m.seq });
    if (counter) counter.textContent = t("itemImages.counter", { n: m.seq, i: cur + 1, total: images.length });
    if (!first) {
      // 换图:先隐去旧图(否则新图按旧尺寸闪一下再重排)、把加载指示放回去——与「布局未定
      // 不显示」同纪律,定形后由 viewer.init() 一次成形亮相。
      img.style.visibility = "hidden";
      if (!loading.isConnected) stage.prepend(loading);
    }
    try {
      const src = await getFullImage(m.id);
      if (closed || my !== gen) return;
      // 图解码出来才知道自然尺寸 → 据此把主窗撑到近屏幕(在暗遮罩下 resize,无闪)。load 监听走
      // viewer.signal:关闭时随 cleanup 一起摘、并由 abort 事件让本 Promise 必定 settle(M5)。
      // 已经是这张(翻回刚看过的一张、或两张字节相同)则不重新等 load——同 src 不再触发 load 事件。
      if (!(img.src === src && img.complete && img.naturalWidth > 0)) {
        await new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true, signal: viewer.signal });
          img.addEventListener("error", () => resolve(), { once: true, signal: viewer.signal });
          viewer.signal.addEventListener("abort", () => resolve(), { once: true });
          img.src = src;
        });
        if (closed || my !== gen) return;
      }
      if (img.naturalWidth === 0) {
        showError(); // 解码失败:明确失败 UI + 立刻 cleanup,别留空白遮罩(M5)
        return;
      }
      if (first) {
        const plan = await planGrowMainWindow(img.naturalWidth, img.naturalHeight);
        if (closed || my !== gen) return; // 关在放大前:窗口没动,onClose 里 restore 仍 null,无需还原
        if (plan) {
          const preW = window.innerWidth; // 放大前的视口:viewportSettle 以「离开此尺寸」为信号
          const preH = window.innerHeight;
          restore = plan.restore; // 先登记还原,再启动放大:onClose 会等 grow 完再还原(串行,不并发)
          grow = plan.applyGrow();
          await grow.catch(() => {}); // 放大失败不致命(权限/重启未生效时窗口保持原尺寸)
          if (closed || my !== gen) return; // 关已在放大中发生:onClose 负责等 grow + 还原,这里不再动
          await viewportSettle(preW, preH, viewer.signal); // 视口真落定再布局,亮相后不再被迟到 resize 重排
          if (closed || my !== gen) return;
        }
      }
      loading.remove();
      viewer.init(); // 窗口已定尺(放大过或没放大)→ 挑取向 + 布局一次 + 亮相
    } catch {
      showError();
    }
  }

  await present(cur, true);
}

/** A full-window overlay showing an image from a ready src (object URL / data URL) — for an
 *  unsaved preview (e.g. a just-pasted capture image, which has no id yet). `opts.onClose` runs
 *  after it closes; `opts.grow`(捕获窗传入)把浮窗放大到图的近原尺寸——`apply` 在暗遮罩下
 *  放大、`restore` 关闭时缩回。**放大→视口落定→亮相**的无闪时序由本函数统一负责(与已保存图
 *  的 openLightbox 同纪律,163 续案):先前捕获窗是「先小窗 init、放大后 resize 重挑」,亮相后
 *  被迟到的 resize 重排一次(尺寸可见跳一记);现改为图先隐形解码、窗口在暗遮罩下放大、viewport
 *  真落定后一次成形亮相。放大/解码期间显「图片载入中…」加载指示(§3.7,快路径 <0.2s 不露脸)。 */
export function openLightboxUrl(
  src: string,
  alt = t("itemImages.preview"),
  opts: {
    onClose?: () => void | Promise<void>;
    grow?: { apply: () => Promise<void>; restore: () => Promise<void> };
  } = {},
): void {
  const img = el("img", { className: "img-lightbox-img", alt });
  const loading = el("div", { className: "img-lightbox-loading", textContent: t("itemImages.loading") });
  const stage = el("div", { className: "img-lightbox-stage" }, [loading, img]);
  let closed = false;
  let restore: (() => Promise<void>) | null = null;
  let grow: Promise<void> | null = null; // 进行中的放大;关闭须等它跑完(成/败)再唯一一次还原(H4)
  const viewer = makeImageViewer(img, () => close());
  // 关闭:先摘缩放/滚动监听(含 window resize),等在途放大跑完再唯一一次还原窗口,最后跑调用方
  // 的 onClose——都在暗遮罩仍覆盖时发生,无裸窗闪(与 openLightbox 同纪律)。
  const { overlay, close } = mountLightbox(stage, async () => {
    closed = true; // 关标志:让下面异步流每个 await 后止步
    viewer.cleanup();
    shedVisuals(overlay, img); // 先卸大图、只留黑底,再去缩窗(见 shedVisuals)
    if (grow) await grow.catch(() => {}); // 等放大真正结束,避免 restore 与放大并发
    if (restore) await restore(); // 仍在暗遮罩下还原窗口几何(只此一次)
    await opts.onClose?.();
  });
  const showError = (): void => {
    if (closed) return;
    viewer.cleanup();
    overlay.replaceChildren(el("div", { className: "img-lightbox-err", textContent: t("itemImages.loadFail") }));
  };
  void (async () => {
    try {
      // src 已就绪(object URL / data URL),但大截图仍要解码——等 load 拿到自然尺寸再走(图此刻
      // 隐形,不闪)。监听走 viewer.signal:关闭随 cleanup 一起摘、abort 让本 Promise 必定 settle。
      await new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true, signal: viewer.signal });
        img.addEventListener("error", () => resolve(), { once: true, signal: viewer.signal });
        viewer.signal.addEventListener("abort", () => resolve(), { once: true });
        img.src = src;
      });
      if (closed) return;
      if (img.naturalWidth === 0) {
        showError();
        return;
      }
      if (opts.grow) {
        const preW = window.innerWidth; // 放大前视口:viewportSettle 以「离开此尺寸」为信号
        const preH = window.innerHeight;
        restore = opts.grow.restore; // 先登记还原,再启动放大:onClose 会等 grow 完再还原(串行)
        grow = opts.grow.apply();
        await grow.catch(() => {}); // 放大失败不致命(权限/重启未生效时窗口保持原尺寸)
        if (closed) return;
        await viewportSettle(preW, preH, viewer.signal); // 视口真落定再布局,不被迟到 resize 重排
        if (closed) return;
      }
      loading.remove();
      viewer.init(); // 窗口已定尺(放大过或没放大)→ 挑取向 + 布局一次 + 亮相
    } catch {
      showError();
    }
  })();
}

/** A thumbnail strip for an item's images. `editable` adds a × to delete each one (used in a
 *  card's edit mode); read-only strips just open the lightbox on click. Returns the root plus
 *  a `reload` so the editor can refresh it after an attach/delete. `onChange` fires after a
 *  delete so the host can re-linkify its 正文 (a 图N whose image just left becomes plain text). */
export function imageStrip(
  itemId: string,
  opts: { editable: boolean; onChange?: () => void; onMetas?: (metas: ImageMeta[]) => void },
): { root: HTMLElement; reload: () => Promise<void> } {
  // 初始即 .empty(隐藏):reload 前默认无图,免得配图工具条在 load 完成前闪一下再收起。
  // ⭐ 但**上次见过这条的图就不必再空一帧**——下面的乐观首帧会当场把它画出来。
  const root = el("div", { className: "img-strip empty" });
  // 当前已画的那批(乐观首帧画的,或对账后画的)。null = 还没画过任何一批。
  let shown: ImageMeta[] | null = null;

  // `all` = 本条同批列出的整组图:点开任一张后 ←/→ 能在组内翻页(224)。
  function thumb(m: ImageMeta, all: ImageMeta[]): HTMLElement {
    const wrap = el("div", { className: "img-thumb" });
    const img = el("img", { className: "img-thumb-img", alt: t("itemImages.badge", { n: m.seq }), title: t("itemImages.badge", { n: m.seq }) });
    getThumb(m.id)
      .then((url) => {
        img.src = url; // 缓存命中=同帧微任务落 src,重渲不再逐张闪现(且落的是小图,不解全尺寸位图)
      })
      .catch(() => {
        wrap.classList.add("broken");
      });
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      void openLightbox(all, all.indexOf(m));
    });
    wrap.append(img, el("span", { className: "img-badge", textContent: t("itemImages.badge", { n: m.seq }) }));
    if (opts.editable) {
      const del = el("button", { className: "img-del", textContent: "×", title: t("itemImages.deleteImage") });
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await invoke("delete_item_image", { imageId: m.id });
        } catch {
          return; // leave the thumb in place if the delete failed
        }
        thumbCache.delete(m.id); // 内存卫生:小图缓存清项
        if (lastFull && lastFull.id === m.id) lastFull = null; // 连带清掉可能命中的「刚看过」
        await reload();
        opts.onChange?.();
      });
      wrap.append(del);
    }
    return wrap;
  }

  function paint(metas: ImageMeta[]): void {
    shown = metas;
    root.classList.toggle("empty", metas.length === 0);
    root.replaceChildren(...metas.map((m) => thumb(m, metas)));
  }

  async function reload(): Promise<void> {
    let metas: ImageMeta[];
    try {
      metas = await listImages(itemId);
    } catch {
      shown = null;
      root.replaceChildren();
      return;
    }
    metaCache.set(itemId, metas); // 唯一的写入点:取图这一步就是缓存这一步
    // 对账:与已画的那批逐项相同就**一个节点都别碰** —— 否则乐观首帧之后立刻再
    // replaceChildren 一次,等于把刚消掉的那次闪烁原样搬了回来(图还要重新解码)。
    if (!sameMetas(shown, metas)) paint(metas);
    opts.onMetas?.(metas);
  }

  // 乐观首帧:上次见过这条的图,**同步**画出来(不等 IPC)。重画时图条不再「消失再出现」,
  // 卡片高度也不跳。紧接着的 reload() 仍会对账,画早了的那一帧由它纠正。
  const known = metaCache.get(itemId);
  if (known) {
    paint(known);
    opts.onMetas?.(known);
  }

  void reload();
  return { root, reload };
}

// Trailing punctuation that commonly hugs a URL in prose but isn't part of it, so
// "见 https://a.com。" or "(https://a.com)" don't swallow the 。/) into the link.
const URL_TAIL = /[)\].,;:!?，。、;:!?…）】》」』]+$/;

/** Render `text` for a card's content node. Two layers:
 *
 *   - **逐行**:行首是 `- [ ] ` / `- [x] ` 的画成一枚方框(checklist.ts 认行)。传了
 *     `onToggle` 就是可点的按钮(点了回调行号,写回由调用方管);不传 = 只读视图
 *     (回收站 / 归档册),照样显出勾没勾但不给点。
 *   - **行内**:每一行(待办项则是标记后面那一截)再走 `appendInline` 那一遍扫描。
 *
 *  Returns a fragment the caller drops into the content node. */
export function renderContent(
  text: string,
  images: ImageMeta[],
  onToggle?: (lineIndex: number) => void,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split("\n");
  let prevWasBox = false;
  lines.forEach((line, i) => {
    const box = parseChecklistLine(line);
    if (box === null) {
      // 正文是 white-space:pre-wrap,换行原样交回去 —— 但**待办项那行是 flex 块、自带
      // 换行**,紧跟它再补一个 `\n` 就会空出一行。故只在「上一行也是普通文本」时补。
      if (i > 0 && !prevWasBox) frag.append("\n");
      appendInline(frag, line, images);
      prevWasBox = false;
      return;
    }
    // 一整行包成 flex:⛔ 别只把方框摆在文字前面 —— 那样长条目**折行后第二行会顶格**
    // (跑到方框左边去),两个待办项的边界当场糊成一片(真机截图逮到的)。flex 让折行挂在
    // 文字那一列下面。缩进(嵌套清单)化成整行的左内边距,不靠 pre-wrap 里的空白字符
    // ——flex 容器里的纯空白子节点是要被丢掉的。
    const row = el("span", { className: `ckline${box.checked ? " on" : ""}` });
    if (box.indent !== "") row.style.setProperty("--ck-indent", String(box.indent.length));
    const rest = el("span", { className: "cktext" });
    const inner = document.createDocumentFragment();
    appendInline(inner, box.rest, images);
    rest.append(inner);
    row.append(checkbox(box.checked, i, onToggle), rest);
    frag.append(row);
    prevWasBox = true;
  });
  return frag;
}

/** 正文里那枚方框。
 *
 *  ⛔ 用 `<button>` 不用 `<input type=checkbox>` —— 后者是替换元素、渲染不出 `::before`,
 *  §2.3 那套热区扩展技法在它身上用不了(同 backup.ts 那条判据)。
 *  ⛔ 只读视图(回收站 / 归档册)那形也是 button、只是 `disabled` —— 不是换成 span:
 *  两形同一个签名才共用同一份 CSS(含那道热区扩展),否则热区门禁看到的是两个签名。
 *  ⛔ `draggable=false`:看板卡自己是可拖的,按下这枚方框不该变成拖卡。 */
function checkbox(checked: boolean, lineIndex: number, onToggle?: (lineIndex: number) => void): HTMLElement {
  // ⚠ 勾没勾这个状态挂在**外层 `.ckline`** 上(一处翻,方框与文字压淡同时跟着走),
  // 方框自己不带 `.on`。
  if (onToggle === undefined) {
    const state = checked ? t("checklist.checked") : t("checklist.unchecked");
    const box = el("button", { className: "ckbox", type: "button", disabled: true, title: state });
    box.setAttribute("aria-label", state);
    return box;
  }
  const label = checked ? t("checklist.uncheck") : t("checklist.check");
  const box = el("button", { className: "ckbox", type: "button", title: label, draggable: false });
  box.setAttribute("aria-label", label);
  box.addEventListener("click", (e) => {
    e.stopPropagation(); // 卡片上还有别的点击主(悬停菜单 / 拖拽),这一下只归方框
    onToggle(lineIndex);
  });
  return box;
}

/** 一行之内的两种内联引用,单趟从左到右扫出来(两者永不重叠、不重复吃同一段文字):
 *   - 「图N」 that has a matching image → a clickable chip that opens the lightbox. A 图N with NO
 *     such image is left as plain text — we never fake a link.
 *   - an http/https URL → a clickable link that opens in the system browser (never navigates the
 *     webview itself). Only http/https are linkified; any other scheme stays plain text. */
function appendInline(frag: DocumentFragment, text: string, images: ImageMeta[]): void {
  const bySeq = new Map(images.map((m) => [m.seq, m]));
  // One combined scanner: alternation of a URL or a 图N, matched in document order so the
  // two never overlap or double-consume a span of text.
  const re = /(https?:\/\/[^\s，。、;：！？）】《」』]+)|图(\d+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      // ---- URL ----
      let url = m[1];
      const tail = URL_TAIL.exec(url);
      const drop = tail ? tail[0].length : 0; // punctuation that hugs the URL stays as text
      url = url.slice(0, url.length - drop);
      if (m.index > last) frag.append(text.slice(last, m.index));
      // title = 完整链接 + 手势提示,悬停即自解释(尾随标点已剥,hover 看得到真实地址)。
      const a = el("a", { className: "link-ref", href: url, title: t("itemImages.linkTitle", { url }) });
      a.textContent = url;
      a.addEventListener("click", (e) => {
        e.preventDefault(); // a bare href would navigate the webview away — open externally
        e.stopPropagation();
        void openUrl(url).catch(() => {});
      });
      // 右键 = 复制链接(想粘到指定浏览器时用),抑制原生右键菜单、就地飘一个「已复制链接」。
      a.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyText(url)
          .then(() => flashToast(e.clientX, e.clientY, t("itemImages.copiedLink")))
          .catch(() => flashToast(e.clientX, e.clientY, t("itemImages.copyFail")));
      });
      frag.append(a);
      last = m.index + url.length; // leave any trailing punctuation for the plain-text tail
      continue;
    }
    // ---- 图N ----
    const meta = bySeq.get(Number(m[2]));
    if (!meta) continue; // no such image — leave the literal "图N" text untouched
    if (m.index > last) frag.append(text.slice(last, m.index));
    const chip = el("button", { className: "img-ref", textContent: t("itemImages.badge", { n: meta.seq }) });
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      void openLightbox(images, images.indexOf(meta)); // 从正文链接进去也能 ←/→ 翻同条目的图
    });
    frag.append(chip);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
}

/** 新建入口的「暂存配图」控制器 —— 捕获浮窗 / 灵感「记下灵感」/ 看板「新建任务」三个入口共用
 *  的单一真相源。条目要等提交才存在,粘贴时还没有 id 可挂,所以图先以内存预览暂存(object URL,
 *  移除/清空时 revoke 不漏内存),提交拿到 id 后 attachAll 逐张挂上。规则:凡是能输入条目正文的
 *  地方,都能 Ctrl+V 配图 —— 新入口一律接这个控制器,不再各写各的。 */
/** 暂存图条目(pendingImages 内部批的元素;takeBatch/putBack/attachBatch 传递用)。 */
export type PendingImage = { id: string; blob: Blob; url: string; thumb: HTMLElement };

export function pendingImages(
  opts: {
    /** 增删预览后回调(捕获浮窗用它随内容长/缩窗口)。 */
    onChange?: () => void;
    /** 点预览看大图的方式;不传就用普通遮罩 openLightboxUrl(捕获浮窗要连窗口一起放大)。 */
    openPreview?: (url: string, naturalW: number, naturalH: number) => void;
    /** 传了就把暂存图持久化到 IndexedDB(此键分桶),供断电恢复;不传=纯内存(旧行为)。
     *  见 compose-draft.ts:三入口各用一个键。持久化尽力而为,写失败吞掉不拦业务。 */
    persistKey?: string;
  } = {},
): {
  root: HTMLElement;
  count: () => number;
  wire: (area: HTMLTextAreaElement) => void;
  attachAll: (itemId: string) => Promise<AttachOutcome>;
  takeBatch: () => PendingImage[];
  putBack: (batch: PendingImage[]) => void;
  disposeBatch: (batch: PendingImage[]) => void;
  attachBatch: (itemId: string, batch: PendingImage[], space?: string) => Promise<AttachOutcome>;
  clear: () => void;
  /** 启动回填:从 IndexedDB 读回上次没记下的暂存图(仅当前无暂存时,不覆盖已贴的)。
   *  未传 persistKey 时为 no-op。 */
  restore: () => Promise<void>;
} {
  let held: PendingImage[] = [];
  // 复用保存态缩略图的样式(.img-thumb/.img-del),只是没有「图N」角标——编号要入库才有。
  const root = el("div", { className: "img-strip img-pending empty" });

  // held 一变就把 IndexedDB 那一桶收敛到它(串行成链防并发写乱序;失败吞掉不拦业务)。
  // 每个 held 变动点(add / × 删 / takeBatch / putBack / clear)都调 persist()。
  // **快照要在链外同步取**:等轮到这一环时 held 可能已经又变了,那一变自己会排在后面再收敛一次。
  let persistChain: Promise<void> = Promise.resolve();
  function persist(): void {
    if (!opts.persistKey) return;
    const key = opts.persistKey;
    const snapshot = held.map((p) => ({ id: p.id, blob: p.blob }));
    persistChain = persistChain.then(() => saveImageDraft(key, snapshot)).catch(() => {});
  }

  /** id 在 held 内必须唯一——`saveImageDraft` 的「桶里已有这个键就不重写字节」全靠它,
   *  撞了就会拿上一张的字节冒充这一张(静默错图,不是报错)。会话前缀让跨会话天然不撞,
   *  **除非系统时钟被往回拨**,故这里再挡一道:撞了就继续往下取号。 */
  function freshId(): string {
    let id = newDraftImageId();
    while (held.some((p) => p.id === id)) id = newDraftImageId();
    return id;
  }

  function sync(): void {
    root.classList.toggle("empty", held.length === 0);
    opts.onChange?.();
  }

  // restoreId:回填时把磁盘上那张的 id 原样带回,下一次 persist 就只写清单、不重写它的字节。
  function add(blob: Blob, restoreId?: string): void {
    const url = URL.createObjectURL(blob);
    const img = el("img", { className: "img-thumb-img", src: url, title: t("itemImages.clickZoom") });
    img.addEventListener("click", () => {
      if (opts.openPreview) opts.openPreview(url, img.naturalWidth, img.naturalHeight);
      else openLightboxUrl(url);
    });
    const del = el("button", { className: "img-del", textContent: "×", title: t("itemImages.removeImage") });
    const thumb = el("div", { className: "img-thumb" }, [img, del]);
    const entry: PendingImage = { id: restoreId ?? freshId(), blob, url, thumb };
    del.addEventListener("click", () => {
      URL.revokeObjectURL(url);
      thumb.remove();
      held = held.filter((p) => p !== entry);
      sync();
      persist();
    });
    held.push(entry);
    root.append(thumb);
    sync();
    persist();
  }

  function clear(): void {
    for (const p of held) URL.revokeObjectURL(p.url);
    held = [];
    root.replaceChildren();
    sync();
    persist();
  }

  return {
    root,
    count: () => held.length,
    /** 在输入框上接管图片粘贴(文本粘贴放行)。composeBar 重建时对新框再 wire 一次即可。 */
    wire(area: HTMLTextAreaElement): void {
      area.addEventListener("paste", (e) => {
        pasteImage(
          e,
          (blob) => add(blob),
          () => toastAction(t("itemImages.pasteFail")), // 取图真失败要响亮(与 copyFail 同纪律)
        );
      });
    },
    /** 把暂存图逐张挂到刚建好的条目上,随后清空暂存;返回挂失败的张数(fail-fast,调用方
     *  负责把失败数告诉用户——条目已存在,图可以去卡片编辑态重新粘贴)。 */
    // 「保存那刻」同步取批(codex P1 二审 H2):按下保存立即把 held 冻结带走并摘预览
    // ——创建 IPC 等待期间新粘贴的图属于下一条,绝不结算进旧条目。创建失败 putBack
    // 原样退回(thumb 未销毁,可重试);成功后 attachBatch 逐张挂上、按张计 failed。
    takeBatch(): PendingImage[] {
      const batch = held;
      held = [];
      for (const p of batch) p.thumb.remove();
      sync();
      persist(); // 冻结带走即清持久化(记下成功=草稿了结;失败由 putBack 复写回)
      return batch;
    },
    putBack(batch: PendingImage[]): void {
      // 原样恢复:旧批插回等待期间新粘贴的图**之前**,重试时「图N」次序不变(codex 三审)。
      held = [...batch, ...held];
      for (const p of [...batch].reverse()) root.prepend(p.thumb);
      sync();
      persist();
    },
    disposeBatch(batch: PendingImage[]): void {
      // 空间已切走的失败批:不许追加进别的空间的预览区(codex 三审 H),revoke 即弃。
      for (const p of batch) URL.revokeObjectURL(p.url);
    },
    async attachBatch(itemId: string, batch: PendingImage[], space?: string): Promise<AttachOutcome> {
      let failed = 0;
      const whys: string[] = [];
      for (const p of batch) {
        try {
          await attachBlob(itemId, p.blob, space);
        } catch (e) {
          noteAttachFailure(itemId, e); // ⛔ 别退回裸 catch:原因丢了就只剩「几张」,查不动
          whys.push(whyAttachFailed(p.blob)); // 给**用户**的那句(诊断那句仍归上面那行)
          failed += 1;
        }
      }
      for (const p of batch) URL.revokeObjectURL(p.url);
      return { failed, why: joinWhy(whys) };
    },
    async attachAll(itemId: string): Promise<AttachOutcome> {
      // 兼容入口(捕获浮窗:mirrorSpace 保证保存期间空间不动、响应恒到达):
      // 同一套「先取批再挂」,失败图随批清走(可重粘)。
      const batch = held;
      held = [];
      for (const p of batch) p.thumb.remove();
      sync();
      persist();
      let failed = 0;
      const whys: string[] = [];
      for (const p of batch) {
        try {
          await attachBlob(itemId, p.blob);
        } catch (e) {
          noteAttachFailure(itemId, e); // 同 attachBatch,别退回裸 catch
          whys.push(whyAttachFailed(p.blob));
          failed += 1;
        }
      }
      for (const p of batch) URL.revokeObjectURL(p.url);
      return { failed, why: joinWhy(whys) };
    },
    clear,
    async restore(): Promise<void> {
      if (!opts.persistKey || held.length > 0) return; // 用户已抢先贴图:不覆盖
      let items: DraftImage[];
      try {
        items = await loadImageDraft(opts.persistKey);
      } catch {
        return; // IndexedDB 不可用 / 读失败:恢复尽力而为,不拦启动
      }
      if (items.length === 0 || held.length > 0) return; // await 期间可能已被贴入:再核一次
      // ⛔ **字节必须在这里就脱手,不许攥着 IndexedDB 背书的 Blob 走**(526,Linux CI 上
      // 红了两次的那个)。`loadImageDraft` 交回来的 Blob 底下是 IndexedDB 里那条记录,而
      // 「记下」那一刻的次序是硬的:`takeBatch()` 同步调 `persist()` 把本桶收敛到空
      // ——**先把这些记录删掉**;真正去读它们(`attachBlob` → `toBase64` →
      // `blob.arrayBuffer()`)要等创建条目那趟 IPC 回来**之后**。删在前、读在后,中间
      // 隔着一整趟 IPC ⇒ 这段代码在**读一份自己刚刚删掉的字节**。
      // ⚠⚠ **别把下面这条因果读成已证的**(526 当轮被自己的探针打脸,如实记在这儿):
      // Linux CI 上「回填的草稿一记下就『N 张图未能附加』」红过两次(app 自己弹的
      // `.form-err`),我据此写下「Chromium 肯让记录已删的 Blob 继续活、WebKit 不肯」——
      // 而探针在 **Chromium 与 WebKitGTK 上都答 SURVIVES**,那个解释**没有字据**,
      // 那两次红的根**至今未查实**(backlog 测试与工装 44)。
      // ⇒ 改这里的理由因此收窄成一条**不依赖那个解释**的:**不该去读一份自己刚删掉的
      // 字节** —— 那是拿引擎的实现细节当契约,而它今天连契约都算不上(规格没保证)。
      // ⛔ 修法**不是**去调那个先后:`takeBatch()` 同步取批是 codex P1 二审 H2 钉死的
      // (IPC 等待期间新粘贴的图必须归下一条)。修的是**让回填出来的图跟粘贴进来的图是
      // 同一种东西** —— 当场把字节读进内存,从此不欠 IndexedDB 任何东西。
      // **id 原样带回**:这些字节桶里已经有了,下一次 persist 只写清单不重写它们。
      const loaded: DraftImage[] = [];
      for (const it of items) {
        try {
          loaded.push({ id: it.id, blob: new Blob([await it.blob.arrayBuffer()], { type: it.blob.type }) });
        } catch {
          // 这一张此刻就读不出字节:跳过它,别回填一个注定挂不上的缩略图
          // (回填本就是尽力而为,与上面那条 catch 同一纪律;下次 persist 会顺手删掉它)。
        }
      }
      if (held.length > 0) return; // 读字节也是 await:再核一次(同上)
      for (const it of loaded) add(it.blob, it.id);
    },
  };
}

/** Wire a textarea so pasting an image attaches it (instead of dumping a path / nothing).
 *  Returns nothing; on a successful attach it calls `onAttached` (refresh the strip). A
 *  paste with no image falls through to normal text paste (取图的三支见 `pasteImage`)。 */
export function wirePasteToAttach(
  area: HTMLTextAreaElement,
  itemId: string,
  onAttached: (meta: ImageMeta) => void,
  onError: (e: unknown) => void,
): void {
  area.addEventListener("paste", (e) => {
    pasteImage(
      e,
      (blob) => void attachBlob(itemId, blob).then(onAttached).catch(onError),
      onError,
    );
  });
}
