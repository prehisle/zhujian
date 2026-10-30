// 配图缩略图管线(117;codex H1/M1):取图 in-flight 去重 + 缩略图降采样缓存 +
// 滚到可视区才拉字节。310 第③笔:自 main.ts 纯搬迁成模块,行为零改动。入向依赖
// 只有 api(getCurrentSpace + 取图三命令),没有要注入的 main.ts 状态、也没有要挂的
// 模块外事件,故不走 initX(Deps) 的形——模块加载即就绪。
// 内存纪律:**全尺寸 data URL 一律不缓存**(单图协议上限 32MiB,Base64 后 ~43MiB,
// 存几张就把 WebView 撑爆)——缩略图取回后立刻降采样成小图(短边 144px,~几 KB)
// 只缓存小图;大图只在查看器打开时取、关闭即置空 src 释放。缓存键带空间标,
// 图不可变(删图=编号退役不复用)故小图永不过期。
import { getCurrentSpace, getItemImage, getItemThumb, putItemThumb, type ThumbData } from "./api";
import { t } from "./i18n";

const thumbCache = new Map<string, string>(); // `${space}/${imageId}` → 降采样小图
const imgPending = new Map<string, Promise<string>>(); // 取图 in-flight 去重

/** 全尺寸图的一次取回(IPC 去重;空间已切走 = 返回 null,调用方直接放弃——
 *  刻意不走 sinvoke 的「永不决议」:悬挂的 Promise 会把 pending 表堵死,切回
 *  该空间后同一张图就再也取不到了)。`space` 由调用方显式传「发起那一刻的
 *  空间」(codex 三审:排队醒来重读 currentSpace 会拿 A 空间的 key 去查 B 库,
 *  撞 ID 时错图进 A 缓存)。 */
export function fetchImageUrl(space: string, id: string): Promise<string | null> {
  const key = `${space}/${id}`;
  let p = imgPending.get(key);
  if (!p) {
    p = getItemImage(space, id).finally(() => imgPending.delete(key));
    imgPending.set(key, p);
  }
  return p.then((url) => (getCurrentSpace() === space ? url : null));
}

// ---- 长文正文里原位显示的图(「图N」单独成段)---------------------------------------
// 同上头那条内存纪律:全尺寸 data URL 取回后**当场**降到显示用的大小(宽 ≤ FIG_MAX_W)、重编码成
// object URL,原串立刻丢掉;本来就窄而且不肥的图原样转 Blob。缓的是**一篇**的图:换了篇整盘
// revoke ⇒ 上界 = 当前这篇的图数。在途的也记着(停笔重画 / 来回切预览别并发取同一张全尺寸)。
// 空间切走了 ⇒ reject(渲染器把那格标坏),⛔ 不进表。
const FIG_MAX_W = 1280;
const FIG_FAT = 2_000_000; // data URL 超过这么长(≈1.5 MB 字节)就算窄也重编码
let figDoc: string | null = null;
const figUrl = new Map<string, string>();
const figWait = new Map<string, Promise<string>>();

function figFrom(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => {
      if (img.naturalWidth <= FIG_MAX_W && dataUrl.length <= FIG_FAT) {
        void fetch(dataUrl)
          .then((r) => r.blob())
          .then((b) => resolve(URL.createObjectURL(b)), reject);
        return;
      }
      const w = Math.min(FIG_MAX_W, img.naturalWidth);
      const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return reject(new Error("canvas 2d unavailable"));
      ctx.drawImage(img, 0, 0, w, h);
      img.src = ""; // 全尺寸位图尽早放手
      c.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error("encode failed"))), "image/webp", 0.9);
    };
    img.onerror = (): void => reject(new Error("decode failed"));
    img.src = dataUrl;
  });
}

/** 长文 `docId` 里那张图原位显示用的地址:已到手就同步交回,否则交一个 Promise。 */
export function figureSrc(space: string, docId: string, imageId: string): string | Promise<string> {
  const doc = `${space}/${docId}`;
  if (figDoc !== doc) {
    for (const u of figUrl.values()) URL.revokeObjectURL(u);
    figUrl.clear();
    figWait.clear();
    figDoc = doc;
  }
  const hit = figUrl.get(imageId);
  if (hit !== undefined) return hit;
  const going = figWait.get(imageId);
  if (going !== undefined) return going;
  const p = fetchImageUrl(space, imageId)
    .then((url) => {
      if (url === null) throw new Error("space changed");
      return figFrom(url);
    })
    .then((u) => {
      if (figDoc !== doc) {
        URL.revokeObjectURL(u); // 取回来时已经换篇了:这张不进新篇的表
        return u;
      }
      figUrl.set(imageId, u);
      return u;
    })
    .finally(() => {
      if (figDoc === doc) figWait.delete(imageId);
    });
  figWait.set(imageId, p);
  return p;
}

// 缩略图取数(0032 派生表,image-perf-plan §3):命中就只过来几 KB、连全尺寸位图都不用解;
// 未命中才回退全尺寸,由下面 fillThumb 缩完异步回存。与 imgPending 分开一只 in-flight 去重
// (两条路的载荷差着两个数量级,合用一只会让看大图去等缩略图、或反过来)。
const thumbPending = new Map<string, Promise<ThumbData>>();
function fetchThumbData(space: string, id: string): Promise<ThumbData | null> {
  const key = `${space}/${id}`;
  let p = thumbPending.get(key);
  if (!p) {
    p = getItemThumb(space, id).finally(() => thumbPending.delete(key));
    thumbPending.set(key, p);
  }
  return p.then((d) => (getCurrentSpace() === space ? d : null));
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

export async function fillThumb(btn: HTMLElement) {
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
          const data = await fetchThumbData(space, id);
          if (!data) return null; // 空间已切走:时间轴整个重画了,别再动旧节点
          if (data.thumb) {
            thumbCache.set(key, data.url); // 派生表命中:已是 ≤144² 小图,不必再解不必再缩
            return data.url;
          }
          const s = await shrinkToThumb(data.url);
          thumbCache.set(key, s);
          // 异步回存,不阻塞渲染;存不进去就是下次再算(派生数据,失败无害)。
          void putItemThumb(space, id, s.slice(s.indexOf(",") + 1)).catch(() => {});
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
    img.alt = t("images.imageN", { n: btn.dataset.seq ?? "" });
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

export function hydrateThumbs(scope: HTMLElement) {
  scope.querySelectorAll<HTMLElement>(".thumb[data-img]").forEach((btn) => {
    if (thumbCache.has(`${getCurrentSpace()}/${btn.dataset.img}`)) {
      void fillThumb(btn); // 小图现成:直接填,省一轮 observer 回调。
    } else {
      thumbObserver.observe(btn);
    }
  });
}

/** refresh/清屏重建 DOM 之前必须调(main.ts 三处):observer 只认「当前这代」占位框,
 *  不断开的话未进过视区的旧节点会被 observer 长期钉住(codex M1 泄漏)。 */
export function disconnectThumbObserver(): void {
  thumbObserver.disconnect();
}
