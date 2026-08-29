// 图片格式解码探针的**注入体**(backlog 用户面 56;⛔ 它不是断言,是量具)
//
// 量的是**渲染引擎自己**的能力,与朱简的业务代码无关 —— 所以两端注入的是**同一份文本**:
// 桌面走 `browser.execute(源文本 + "; return __zjFormatProbe(...)")`,
// 安卓走 CDP `Runtime.evaluate({expression: 源文本 + "; __zjFormatProbe(...)", awaitPromise:true})`。
// ⛔ 别在任何一端另写一份 —— 两份会漂,而这一次量的结论要拿去改产品代码。
//
// **为什么要量**(账在 backlog 用户面 56):后端 `core/src/images.rs` 的 `ALLOWED_MIME` 恰四种
// (png/jpeg/webp/gif),而两端前端只看 `image/*` 前缀放行 ⇒ 中间差出来的格式**前端放行、后端拒**,
// 而那一刻用户手上的字节已经没了。修法 ②(「干脆别让它失败」= 解得开就当场重编码成 JPEG)
// 到底盖得住哪几种,取决于**这个引擎解不解得开** —— 那一格此前一次都没量过,只有推断。
//
// **三格读数,逐格对应一个真实判据**:
//   ① `new Image()` + blob URL   → 这条**正是** `downsampleForUpload` 今天走的路(两端同形)
//   ② `createImageBitmap(blob)`  → 另一条解码路;若它比 ① 强,修法就多一个选项
//   ③ 解开之后 canvas → `toBlob("image/jpeg")` → 修法 ② 的**完整形**,含 canvas 被污染那一格
//
// **两头对照,缺一不可**(⛔ 没有它们,一行 `err` 说明不了是「引擎不认这个格式」还是「我的样本坏了」):
//   - 阳性:png / jpeg / gif / webp 四种**白名单内**的必须 `ok`;
//   - 阴性:`broken` 是随机字节冒充 image/png,**必须 `err`** —— 它证明这支探针真报得出 err。

/* eslint-disable */
function __zjFormatProbe(samples) {
  function toBlob(b64, mime) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  async function one(key, s) {
    const row = {
      key: key,
      mime: s.mime,
      bytes: 0,
      img: "?", // ① <img>:ok / err
      w: 0,
      h: 0,
      bitmap: "?", // ② createImageBitmap:ok / err:<name>
      reenc: "?", // ③ 重编码:image/jpeg / null / tainted / throw:<name> / -(没解开就没这一格)
      out: 0,
      note: s.note || "",
    };
    let blob;
    try {
      blob = toBlob(s.b64, s.mime);
      row.bytes = blob.size;
    } catch (e) {
      row.img = "b64err";
      return row;
    }

    const url = URL.createObjectURL(blob);
    const img = new Image();
    row.img = await new Promise(function (res) {
      img.onload = function () {
        res("ok");
      };
      img.onerror = function () {
        res("err");
      };
      img.src = url;
    });
    row.w = img.naturalWidth;
    row.h = img.naturalHeight;

    try {
      const bm = await createImageBitmap(blob);
      row.bitmap = "ok";
      if (bm.close) bm.close();
    } catch (e) {
      row.bitmap = "err:" + (e && e.name ? e.name : String(e));
    }

    // ⚠ 只有 ① 解开了才谈重编码 —— 修法 ② 的前提就是这一格。
    if (row.img === "ok" && row.w > 0 && row.h > 0) {
      try {
        const c = document.createElement("canvas");
        c.width = row.w;
        c.height = row.h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        // ⚠ 被污染的 canvas 上 toBlob **抛** SecurityError(不是回 null)—— SVG 那一格靠它区分。
        const out = await new Promise(function (res, rej) {
          try {
            c.toBlob(res, "image/jpeg", 0.85);
          } catch (e) {
            rej(e);
          }
        });
        if (!out) {
          row.reenc = "null";
        } else {
          row.reenc = out.type;
          row.out = out.size;
        }
      } catch (e) {
        row.reenc = (e && e.name === "SecurityError" ? "tainted:" : "throw:") + (e && e.name);
      }
    } else {
      row.reenc = "-";
    }
    URL.revokeObjectURL(url);
    return row;
  }

  const keys = Object.keys(samples);
  return (async function () {
    const rows = [];
    for (let i = 0; i < keys.length; i++) rows.push(await one(keys[i], samples[keys[i]]));
    // ⚠ `href` 一并回报:读数必须能归到「哪个引擎、哪个文档」上,否则下次没人敢引用它。
    return { ua: navigator.userAgent, href: location.href, rows: rows };
  })();
}
