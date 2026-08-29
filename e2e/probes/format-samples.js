// 图片格式解码探针的**样本组**(backlog 用户面 56)。node 侧读,注入前编成 base64。
//
// ⛔⛔ **HEIC 与 AVIF 那两枚第三方样本刻意不进仓**,理由是许可证不是取舍:
//   - `tigranbs/test-heic-images` —— **仓里没有 LICENSE**,不可再分发;
//   - `link-u/avif-sample-images` —— **CC-BY-SA-4.0**,是传染性的 share-alike,
//     而本仓是 MIT 且**公开**(白名单导出快照)。
//   ⇒ 两枚都由使用者自己取到本机 `.fmt-samples/`(已 gitignore)。缺了就**响亮说缺**,
//   ⛔ **绝不静默跳过** —— 「没量到」被读成「量到了坏结果」正是这条账要修的那个病。
//
// 自造的那几枚(png/jpeg/gif/webp/bmp/tiff/svg)是 8×8 的渐变小图,Pillow 生成后取 base64
// 焊进来:它们是我们自己的字节,没有许可证问题,也不必联网。
//
// **取样本**(两条命令,复制即用;跑探针时它会把这两行原样印给你):
//   curl -sL -o .fmt-samples/image4.heic https://raw.githubusercontent.com/tigranbs/test-heic-images/master/image4.heic
//   curl -sL -o .fmt-samples/red.avif    https://raw.githubusercontent.com/link-u/avif-sample-images/master/red-at-12-oclock-with-color-profile-lossy.avif
//
// ⚠ **下载完必须验完整性,别只看「文件在不在」**:第一趟 `curl --max-time` 超时留下了一份
// **2742/2840 字节的半截 AVIF**,文件在、扩展名对、`ls` 看着正常 —— 拿它去量会得到
// 「引擎解不开 AVIF」这个**错结论**。⇒ 本模块按 **git blob sha** 逐字节核,对不上当场拒。
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DIR = process.env.ZJ_FMT_SAMPLES || resolve(here, "../../.fmt-samples");

// 自造样本:8×8 渐变(ICO 被剔掉了 —— Pillow 出的那只要么内嵌 PNG、要么 9 KB,
// 而现实里没人往条目里粘 .ico,留着只是噪音)。
const SELF = {
  png: {
    mime: "image/png",
    note: "✅ 白名单内 —— 阳性对照",
    b64: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR4nGNkYGCQZ5DFRCwMqrIMDFjQ4JQAAMXFCR1fYTzFAAAAAElFTkSuQmCC",
  },
  jpeg: {
    mime: "image/jpeg",
    note: "✅ 白名单内 —— 阳性对照",
    b64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDz34V/CL4eacsEMPizwy10QP8AmK25CD1Pz9fb/JKKKxzWvj5Y+vh6OMq0oUpOEY05uCtF2u7bt9W/RWVkfpXh/jMb/YVJuvJt97dl5H//2Q==",
  },
  gif: {
    mime: "image/gif",
    note: "✅ 白名单内 —— 阳性对照",
    b64: "R0lGODdhCAAIAIUAANneebreXJveP9m5XLq5P5u5Il256HzeIl3eBXy5BdmUP7qUIpuUBXyU6F2Uyz7e6B/eywDerj65yx+5rgC5kT6Urh+UkQCUdJtv6LpK6JtKy9lvIrpvBdlKBXxvy11vrnxKrl1KkT5vkR9vdABvVz5KdB9KVwBKOtkl6Loly5slrtkDlroDeZsDXNkAy7oArpsAkXwlkV0ldHwDP10DInwAdF0AVz4lVx8lOh8D6AADyz4AOgAlHT4DBR8AHQAAACwAAAAACAAIAAAISwB/+NhhowaMFy544LghI4aKFChOmCgRAoSGDB1IjBDxwQMGDhsuWKjgoAGDBQooTJBgIEEBAgMiQHiA4ICAAAB05OhBY0YLFisCAgA7",
  },
  webp: {
    mime: "image/webp",
    note: "✅ 白名单内 —— 阳性对照",
    b64: "UklGRo4AAABXRUJQVlA4IIIAAACwAgCdASoIAAgAAMASJbACdHIAtQCbQAcsUP5ebqAA/v8R9A+FdP/plE9CHebPJ//oef/0uuX/u6Ocx/ZLB3fv5YvfDS2xfmFqLrgrd/vnWV/hDYT/gL/tfyOrcC+rFv3r/0NsTNPkV4DlxwblPNOz//8K4+HaOTLL++UGz2v/nAAA",
  },
  bmp: {
    mime: "image/bmp",
    note: "候选:白名单外,Windows 上真粘得到",
    b64: "Qk32AAAAAAAAADYAAAAoAAAACAAAAAgAAAABABgAAAAAAMAAAADEDgAAxA4AAAAAAAAAAAAAywMA6AMfBQM+IgNdPwN8XAObeQO6lgPZrt4Ay94f6N4+Bd5dIt58P96bXN66ed7ZkbkArrkfy7k+6LldBbl8IrmbP7m6XLnZdJQAkZQfrpQ+y5Rd6JR8BZSbIpS6P5TZV28AdG8fkW8+rm9dy2986G+bBW+6Im/ZOkoAV0ofdEo+kUpdrkp8y0qb6Eq6BUrZHSUAOiUfVyU+dCVdkSV8riWbyyW66CXZAAAAHQAfOgA+VwBddAB8kQCbrgC6ywDZ",
  },
  tiff: {
    mime: "image/tiff",
    note: "候选:白名单外(扫描件常见)",
    b64: "SUkqAAgAAAAKAAABBAABAAAACAAAAAEBBAABAAAACAAAAAIBAwADAAAAhgAAAAMBAwABAAAAAQAAAAYBAwABAAAAAgAAABEBBAABAAAAjAAAABUBAwABAAAAAwAAABYBBAABAAAACAAAABcBBAABAAAAwAAAABwBAwABAAAAAQAAAAAAAAAIAAgACAAAAAAfAB0+ADpdAFd8AHSbAJG6AK7ZAMsAJR0fJTo+JVddJXR8JZGbJa66JcvZJegASjofSlc+SnRdSpF8Sq6bSsu6SujZSgUAb1cfb3Q+b5Fdb658b8ubb+i6bwXZbyIAlHQflJE+lK5dlMt8lOiblAW6lCLZlD8AuZEfua4+uctdueh8uQWbuSK6uT/ZuVwA3q4f3ss+3uhd3gV83iKb3j+63lzZ3nkAA8sfA+g+AwVdAyJ8Az+bA1y6A3nZA5Y=",
  },
  svg: {
    mime: "image/svg+xml",
    note: "候选:白名单外;⚠ 另有 canvas 污染那一格",
    b64: "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPjxyZWN0IHdpZHRoPSI4IiBoZWlnaHQ9IjgiIGZpbGw9IiNjMDM5MmIiLz48L3N2Zz4=",
  },
};

// 第三方样本:git blob sha 是**逐字节**的判据(GitHub API 的 `sha` 字段就是它),
// ⛔ 别退化成比文件大小 —— 半截文件的大小也可能凑巧对得上。
const THIRD_PARTY = [
  {
    key: "heic",
    file: "image4.heic",
    mime: "image/heic",
    note: "⭐ 主角:安卓「高效模式」拍的就是它",
    sha: "efd119a0ea5f9c59d225e2f1ba7269bfe1802d0b",
    url: "https://raw.githubusercontent.com/tigranbs/test-heic-images/master/image4.heic",
  },
  {
    key: "avif",
    file: "red.avif",
    mime: "image/avif",
    note: "候选:白名单外,修法 ② 的主要指望",
    sha: "4f2d48cba0498796be67ab29e71e7bb408d01fda",
    url: "https://raw.githubusercontent.com/link-u/avif-sample-images/master/red-at-12-oclock-with-color-profile-lossy.avif",
  },
];

function gitBlobSha(buf) {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]))
    .digest("hex");
}

/** 组样本。返回 `{ samples, missing }` —— `missing` 里每条都带「怎么取它」那一行。
 *  ⛔ 缺的那几枚**不会**被塞进 samples,调用方必须把 missing 原样印出来。 */
export function loadSamples() {
  const samples = {};
  for (const [k, v] of Object.entries(SELF)) samples[k] = v;

  const missing = [];
  for (const tp of THIRD_PARTY) {
    const p = resolve(SAMPLE_DIR, tp.file);
    if (!existsSync(p)) {
      missing.push({ key: tp.key, why: "文件不在", cmd: `curl -sL -o "${p}" ${tp.url}` });
      continue;
    }
    const buf = readFileSync(p);
    const got = gitBlobSha(buf);
    if (got !== tp.sha) {
      missing.push({
        key: tp.key,
        why: `内容对不上(git blob sha ${got.slice(0, 12)} ≠ ${tp.sha.slice(0, 12)},${buf.length} 字节)—— 多半是下载被截断了`,
        cmd: `curl -sL -o "${p}" ${tp.url}`,
      });
      continue;
    }
    samples[tp.key] = { mime: tp.mime, note: tp.note, b64: buf.toString("base64") };
  }

  // ⛔ 阴性对照放最后:半截 PNG(取自上面那枚自造 PNG 的前 40 字节)冒充 image/png。
  // 它**必须**判 err —— 否则这支探针报不出 err,上面所有 err 都是废的。
  samples.broken = {
    mime: "image/png",
    note: "⛔ 阴性对照:半截 PNG,必须 err",
    b64: Buffer.from(SELF.png.b64, "base64").subarray(0, 40).toString("base64"),
  };
  return { samples, missing };
}

/** 注入体的源文本(两端共用同一份)。 */
export function payloadSource() {
  return readFileSync(resolve(here, "format-probe-payload.js"), "utf8");
}

/** 组一份**自足**的注入源:注入体 + 样本,末尾那句表达式的值就是那个 Promise。
 *  ⭐ 两端注入的是**同一个函数造出来的同一段文本** —— 桌面探针 `(0,eval)` 它,
 *  安卓侧 `scripts/format-probe-emit.mjs` 把它落成文件交给 `android-cdp.mjs evalfile`
 *  (那条路 `awaitPromise: true`,接得住 Promise)。
 *  ⇒ 桌面跑绿的那一刻,**安卓侧要跑的那份文本已经被验过了**,不是"照着再写一遍"。 */
export function buildInjectable() {
  const { samples, missing } = loadSamples();
  const source = `${payloadSource()}\n;__zjFormatProbe(${JSON.stringify(samples)});\n`;
  return { source, samples, missing };
}
