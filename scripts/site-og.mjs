// 官网每页一张分享卡片图(og:image,1200×630;官网改版 4b)。
//
//   node scripts/site-og.mjs          # 只重画缺了 / 过期的那几张
//   node scripts/site-og.mjs --all    # 全部重画
//
// 清单不在这里:`build-site-cool.mjs --og-spec` 印出每页该画什么(标题 / 页眉小字 / 描述 / 首页的截图)
// 和一枚指纹;这里照单画、把指纹写进 `site/og/rendered.json`,没人登记的旧图删掉。
// ⇒ 生成器 `--check`(land 跑的那道)比对指纹:改了文案 / 版式 / 截图 / 字体而没重画,当场红。
//   ⚠ 指纹里含**本文件的源码** ⇒ 改一个字的版式,全部卡片都要重画一遍 —— 这是故意的。
//
// 版面(纸与朱墨,色值抄自 `site/index.html` 亮色档令牌;⚠ 复制值,改了主色记得跟一次):
//   左上印章 + 名字;中间页眉小字(朱色)、标题(霞鹜文楷,官网自托管的那份子集)、描述(系统黑体);
//   首页那两张右侧压一块看板截图(与首屏同一张,展示库拍的)。⛔ 卡片上不印域名:两站共用这一套图。
//
// ⚠ 要 `dangerouslyDisableSandbox`(chrome 往仓内写文件会落沙箱影子,同 make-portrait.mjs)。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const OUT = join(root, "site", "og");
const W = 1200;
const H = 630;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!existsSync(CHROME)) throw new Error(`找不到 chrome:${CHROME}`);

const all = process.argv.includes("--all");
const spec = JSON.parse(
  execFileSync(process.execPath, [join(here, "build-site-cool.mjs"), "--og-spec"], { encoding: "utf8", maxBuffer: 1 << 24 }),
);
if (!spec.length) throw new Error("卡片清单是空的 —— build-site-cool --og-spec 的登记坏了");

mkdirSync(OUT, { recursive: true });
const RENDERED = join(OUT, "rendered.json");
const rendered = existsSync(RENDERED) ? JSON.parse(readFileSync(RENDERED, "utf8")) : {};
const fontUrl = `data:font/woff2;base64,${readFileSync(join(root, "site/fonts/zhujian-wenkai.woff2")).toString("base64")}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function titleHtml(c) {
  let t = esc(c.title);
  if (c.accent) t = t.replace(esc(c.accent), `<em>${esc(c.accent)}</em>`);
  return t.replace(/\n/g, "<br>");
}

// 标题字号按长度分三档(一行放得下的字数:中文约 14、英文约 26);描述最多三行,超了省略号
function titleSize(c) {
  const longest = Math.max(...c.title.split("\n").map((l) => [...l].length * (c.lang === "en" ? 0.55 : 1)));
  return c.image ? 64 : longest <= 12 ? 76 : longest <= 16 ? 64 : 54;
}

function page(c) {
  const hero = !!c.image;
  const img = hero ? `file:///${join(root, "site", c.image).replace(/\\/g, "/")}` : null;
  return `<!doctype html><html lang="${c.lang}"><head><meta charset="utf-8"><style>
  @font-face { font-family: "Zhujian WenKai"; src: url("${fontUrl}") format("woff2"); font-weight: 400 700; font-display: block; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body {
    position: relative;
    background: radial-gradient(70% 90% at 100% 0%, rgba(179, 64, 43, 0.1), transparent 60%), #f3eee3;
    color: #221f19;
    font-family: ${c.lang === "en" ? '"Segoe UI", ' : ""}"Microsoft YaHei", "PingFang SC", sans-serif;
  }
  .col { position: absolute; left: 80px; top: 72px; bottom: 72px; width: ${hero ? 500 : 1040}px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 16px; font-family: "Zhujian WenKai"; font-size: 30px; font-weight: 700; letter-spacing: 0.06em; }
  .seal { width: 52px; height: 52px; border-radius: 25%; background: #b3402b; color: #fdf6ee; display: grid; place-items: center; font-size: 32px; transform: rotate(-4deg); }
  .body { margin-top: auto; }
  .kicker { font-size: 26px; color: #b3402b; letter-spacing: 0.08em; margin-bottom: 18px; }
  h1 { font-family: "Zhujian WenKai"; font-weight: 700; font-size: ${titleSize(c)}px; line-height: 1.22; letter-spacing: ${c.lang === "en" ? "0" : "0.03em"}; text-wrap: balance; }
  h1 em { font-style: normal; color: #b3402b; }
  p { margin-top: 26px; font-size: ${hero ? 24 : 27}px; line-height: 1.6; color: #6c6354; display: -webkit-box; -webkit-line-clamp: ${hero ? 4 : 3}; -webkit-box-orient: vertical; overflow: hidden; }
  .rule { position: absolute; left: 80px; bottom: 44px; width: 56px; height: 4px; border-radius: 2px; background: #b3402b; }
  .shot { position: absolute; left: 640px; top: 96px; width: 640px; height: 450px; overflow: hidden; border-radius: 16px;
    box-shadow: 0 30px 70px -30px rgba(40, 30, 18, 0.55), 0 2px 6px rgba(40, 30, 18, 0.12); outline: 1px solid rgba(34, 31, 25, 0.1); }
  .shot img { display: block; width: 1100px; }
</style></head><body>
  <div class="col">
    <div class="brand"><span class="seal">朱</span>${esc(c.brand)}</div>
    <div class="body">
      ${c.kicker ? `<div class="kicker">${esc(c.kicker)}</div>` : ""}
      <h1>${titleHtml(c)}</h1>
      <p>${esc(c.desc)}</p>
    </div>
  </div>
  <div class="rule"></div>
  ${hero ? `<div class="shot"><img src="${img}"></div>` : ""}
</body></html>`;
}

const work = join(tmpdir(), "zj-site-og");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

let drawn = 0;
for (const c of spec) {
  const out = join(OUT, `${c.slug}.jpg`);
  if (!all && rendered[c.slug] === c.hash && existsSync(out)) continue;
  const html = join(work, `${c.slug}.html`);
  writeFileSync(html, page(c), "utf8");
  const raw = join(work, `${c.slug}.png`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--allow-file-access-from-files",
      "--virtual-time-budget=3000",
      `--window-size=${W},${H}`,
      `--screenshot=${raw}`,
      `file:///${html.replace(/\\/g, "/")}`,
    ],
    { stdio: "ignore" },
  );
  if (!existsSync(raw)) throw new Error(`chrome 没落下产物:${raw}(沙箱影子?要 dangerouslyDisableSandbox)`);
  const b = readFileSync(raw);
  if (b.readUInt32BE(16) !== W || b.readUInt32BE(20) !== H) throw new Error(`${raw} 是 ${b.readUInt32BE(16)}×${b.readUInt32BE(20)},要 ${W}×${H}`);
  // 存 JPEG(质量 88):纸色底上的渐变让 PNG 一张近百 KB,JPEG 约一半,字边在这个质量下看不出损失;
  // 而指纹连本文件源码 ⇒ 每改一次版式整套重进仓,体积要紧。
  execFileSync("python", ["-c", "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2],'JPEG',quality=88,optimize=True,progressive=True)", raw, out]);
  rendered[c.slug] = c.hash;
  drawn += 1;
  console.log(`  ✔ ${c.slug}.jpg  ${(readFileSync(out).length / 1024).toFixed(0)} KB`);
}

// 清单里没有的:图删掉、指纹删掉(生成器把孤儿当红)
const want = new Set(spec.map((c) => c.slug));
for (const f of readdirSync(OUT)) {
  if (f !== "rendered.json" && !(f.endsWith(".jpg") && want.has(f.slice(0, -4)))) {
    rmSync(join(OUT, f));
    console.log(`  ✖ 删掉清单外的 ${f}`);
  }
}
for (const k of Object.keys(rendered)) if (!want.has(k)) delete rendered[k];
writeFileSync(RENDERED, JSON.stringify(Object.fromEntries(Object.entries(rendered).sort()), null, 2) + "\n");
rmSync(work, { recursive: true, force: true });
console.log(`画了 ${drawn} 张,清单共 ${spec.length} 张 → site/og/`);
