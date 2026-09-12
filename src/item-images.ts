// Shared 配图 (item images) controller — one source of truth for attaching, showing,
// referencing, and deleting the numbered 「图N」 images that hang off an item. Used by both
// the 灵感 cards (inbox.ts) and the 任务看板 cards (board.ts), mirroring the backend's
// images.rs / hotkey-menu.ts shared-controller pattern so the behaviour is identical across
// views. Images are a per-item 1:N attachment; the 编号 is stable and never reused, so a
// 正文「见图N」 reference always points at the same picture (see migration 0016).

import { invoke, invokeInSpace, currentSpaceId } from "./space";
import { t } from "./i18n";
import { parseChecklistLine } from "./checklist";
import { saveImageDraft, loadImageDraft, newDraftImageId, type DraftImage } from "./compose-draft";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText } from "./clipboard";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import type { Image as ShellImage } from "@tauri-apps/api/image";
import { flashToast, toastAction } from "./toast";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  type ImageMeta,
  type LightboxBody,
  type LightboxOpen,
  type MonitorRect,
  LIGHTBOX_LABEL,
  LIGHTBOX_OPEN,
  LIGHTBOX_PING,
  LIGHTBOX_READY,
} from "./lightbox-msg";
import "./item-images.css";
import { el } from "./dom";

// `ImageMeta` 的**唯一定义**住在 lightbox-msg.ts(开图那条跨窗消息也要用它);这里原样再导出,
// 视图侧照旧 `import { ImageMeta } from "./item-images"`。⛔ 别在这儿再写一份形状。
export type { ImageMeta };

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







// ---- 开图 = 请遮罩窗来一趟(606)-------------------------------------------------
// **606 之前遮罩长在本窗的 DOM 上**,于是「让它看起来像全屏」只能去动本窗:138 把主窗撑成
// 「图原尺寸 + 边距」、605 改成把主窗切全屏 —— 用户两次都指出同一件事:**看张图不该动我的窗**。
// ⇒ 遮罩搬进它自己的窗(`lightbox.ts`,常驻隐藏的无边框透明置顶窗),本文件这一侧只剩
// 「发一条开图事件」。主窗/捕获窗的几何、最大化态、窗口状态落盘,本轮起一个字节都不碰。
//
// ⛔ **显示器要在这一侧量**:遮罩窗自己查 `currentMonitor()` 得到的是「它上次在的那块屏」,
// 双屏下就摆错屏。量不到(没授权 / 取不到)就送 null —— 遮罩窗保持自己的几何照常显示,
// 不是静默兜底:看图这件事不该因为查不到显示器就做不成。
// 遮罩窗在不在(它答过 "我在了" 就算)。⚠ 它的页面在 app 启动后约 **1.4 秒**才加载完并装上
// listener,在那之前发过去的开图事件**没人收、一声不响**;e2e 里这一段更长(驱动一进来时
// 那只窗还是 about:blank,606 实测)⇒ 不堵就是「点了没反应」+ 一支随机红。
let lightboxReady = false;
void listen(LIGHTBOX_READY, () => {
  lightboxReady = true;
});

/** 等遮罩窗把 listener 装好:每 100ms ping 一次,它答 "我在了" 就走。
 *  ⛔ 3 秒上界不是静默兜底 —— 超时之后**照发不误**,让失败留在明处(遮罩不出来是看得见的),
 *  而不是在这里把「看图」这件事整个吞掉。 */
async function waitLightboxReady(): Promise<void> {
  const t0 = Date.now();
  while (!lightboxReady && Date.now() - t0 < 3000) {
    await emitTo(LIGHTBOX_LABEL, LIGHTBOX_PING, {});
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function openOverlay(body: LightboxBody): Promise<void> {
  await waitLightboxReady();
  let monitor: MonitorRect | null = null;
  try {
    const mon = await currentMonitor();
    if (mon) monitor = { x: mon.position.x, y: mon.position.y, w: mon.size.width, h: mon.size.height };
  } catch {
    /* 量不到显示器:遮罩窗保持自己当前几何 */
  }
  await emitTo(LIGHTBOX_LABEL, LIGHTBOX_OPEN, {
    ...body,
    from: getCurrentWindow().label,
    monitor,
  } satisfies LightboxOpen);
}

/** 看这条目的整组图(已入库)。**只送元数据**:字节由遮罩窗自己 `get_item_image` 取,
 *  全尺寸 base64 不过事件。`index` = 点开的那张;>1 张时遮罩窗内 ←/→ 组内循环翻页。
 *  空间 id 显式带上 —— 遮罩窗没有「当前空间」这个概念,它只按送来的那个查。 */
export async function openLightbox(images: ImageMeta[], index: number): Promise<void> {
  if (images.length === 0) return; // 没图可看:不惊动遮罩窗
  await openOverlay({ kind: "saved", spaceId: currentSpaceId(), images, index });
}

/** 看一张**还没入库**的图(compose 暂存 / 捕获窗暂存)。object URL 是本窗文档私有的、
 *  跨不了窗,故把字节读成 data URL 随事件送过去。⚠ 那份 base64 与保存时 `attachBlob`
 *  过 IPC 的是同一个量级(同一张图、同一种编码),不是本轮新引入的开销。 */
export async function openLightboxBlob(blob: Blob, alt = t("itemImages.preview")): Promise<void> {
  const src = `data:${blob.type || "image/png"};base64,${await toBase64(blob)}`;
  await openOverlay({ kind: "data", src, alt });
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
        // ⚠ 606:「刚看过那张全尺寸」的缓存搬到遮罩窗去了(lightbox.ts),本窗清不动它。
        // 不补一条「忘掉这张」的跨窗事件:图 id 永不复用 ⇒ 陈旧条目**不可能**被错服务,
        // 上界也没变(至多 1 张全尺寸),代价只是那一张要等下次看图才被顶掉。
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
 *  ⚠ `draggable=false` 只是标注意图:子元素的 draggable=false 挡不住父卡起拖(671 补在真 WebView2
 *  上量的);「按下这枚方框不变成拖卡」真靠的是 board.ts 卡片 mousedown 看落点(CARD_CONTROLS 含 button)。 */
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
    /** 点预览看大图的方式;不传就用默认 alt(捕获浮窗要换成自己那句)。⚠ 交的是 **blob**
     *  不是 object URL —— 遮罩窗是另一个窗,object URL 跨不过去(606)。 */
    openPreview?: (blob: Blob) => void;
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
      if (opts.openPreview) opts.openPreview(blob);
      else void openLightboxBlob(blob);
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
