#!/usr/bin/env node
/**
 * site-font.mjs —— 官网标题字体(霞鹜文楷)的子集:生成,与「够不够用」的核对。
 *
 * 为什么要子集:文楷全量 25 MB,按页面用字裁完一百来 KB(量法见 progress-log 778)。
 * 为什么自托管:境内站(zhujian.cool)不许依赖境外字体服务(site-redesign-plan 结论页)。
 *
 * 收哪些字 = 官网字典(`site/index.html` 里 ⟦i18n-dict⟧ 之间)**全部** zh / en 值 + 文档中心的标题
 *   (`docs/user-guide.md` 里「#」到「###」那几行,改版 3a)+ 可打印 ASCII
 *   + 鸿蒙商店竖版图的标题(`store-assets/harmonyos/make-portrait.mjs` 的 `title:`,改版 4c;说明那行用系统黑体,不收)。
 *   ⭐ 刻意收全字典,不只收标题用到的那几键:哪一段换成标题字体都不用回来重裁;
 *      收窄只省几十 KB,换来的是「某个字没进子集 ⇒ 那一个字掉回系统楷体」这种不报错的丑。
 *   ⇒ 改了字典就可能要重裁;漏没漏由下面的 `missingChars()` 核,`build-site-cool.mjs`
 *      每次跑(含 branch-gate land 跑的 `--check`)都调它,缺字当场红 —— ⛔ 不是新开门禁。
 *
 * 产物(都进仓,`site/` 在导出白名单里,随公开仓走;OFL 许可要求字体与许可证同行):
 *   site/fonts/zhujian-wenkai.woff2      子集字体
 *   site/fonts/zhujian-wenkai.chars.txt  子集里的全部字符(核对只读它,不用解析字体)
 *   site/fonts/OFL.txt                   SIL Open Font License 1.1 原文(上游仓根那份)
 *
 * 跑法(重裁):
 *   pip install fonttools brotli        # 一次性;pyftsubset 来自 fonttools
 *   下载上游 LXGW WenKai **Medium**(v1.522,github.com/lxgw/LxgwWenKai releases,约 25 MB,不进仓)
 *   node scripts/site-font.mjs --src <LXGWWenKai-Medium.ttf 的路径>
 * 只核不写:
 *   node scripts/site-font.mjs --check
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site", "index.html");
const GUIDE = join(ROOT, "docs", "user-guide.md");
// 更新日志与开发手记(改版 3b):页标题与手记每篇的标题也用标题字体
const LOG_SRCS = [join(ROOT, "site", "changelog.md"), join(ROOT, "site", "devlog.md")];
const STORE = join(ROOT, "store-assets", "harmonyos", "make-portrait.mjs");
const OUT_DIR = join(ROOT, "site", "fonts");
const WOFF2 = join(OUT_DIR, "zhujian-wenkai.woff2");
const CHARS = join(OUT_DIR, "zhujian-wenkai.chars.txt");

/** 官网要用标题字体排的全部字符(去重、排序)。 */
export function neededChars() {
  const html = readFileSync(SITE, "utf8");
  const a = html.indexOf("var M = { /* ⟦i18n-dict⟧ */");
  const b = html.indexOf("}; /* ⟦/i18n-dict⟧ */");
  if (a < 0 || b < a) throw new Error("site-font: site/index.html 里找不到 ⟦i18n-dict⟧ 那对标记");
  const dict = html.slice(a, b);
  const set = new Set();
  for (const m of dict.matchAll(/\b(?:zh|en): "((?:[^"\\]|\\.)*)"/g)) {
    for (const ch of JSON.parse(`"${m[1]}"`)) set.add(ch);
  }
  /* 文档中心(改版 3a)的页标题与小节标题也用标题字体:user-guide 里「#」到「###」那几行 */
  for (const f of [GUIDE, ...LOG_SRCS]) for (const m of readFileSync(f, "utf8").matchAll(/^#{1,3}\s+(.*)$/gm)) for (const ch of m[1].trim()) set.add(ch);
  /* 鸿蒙商店竖版图的标题(改版 4c:商店图与官网同一套标题字体);只收 `title:`,说明那行是系统黑体 */
  const store = readFileSync(STORE, "utf8");
  const titles = [...store.matchAll(/\btitle: "([^"]*)"/g)];
  if (!titles.length) throw new Error("site-font: make-portrait.mjs 里一个 title 都没认出来 —— PANELS 的写法变了?");
  for (const m of titles) for (const ch of m[1]) set.add(ch);
  for (let c = 0x20; c < 0x7f; c++) set.add(String.fromCharCode(c));
  return [...set].sort();
}

/** 字典里有、子集里没有的字符。空数组 = 够用。 */
export function missingChars() {
  const have = new Set(readFileSync(CHARS, "utf8"));
  return neededChars().filter((ch) => !have.has(ch));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes("--check")) {
    const miss = missingChars();
    if (miss.length) {
      console.error(`✗ 标题字体子集缺 ${miss.length} 个字:${miss.join("")}\n  ⇒ 按本文件头注重裁`);
      process.exit(1);
    }
    console.log("✓ 标题字体子集覆盖官网字典全部字符");
  } else {
    const i = process.argv.indexOf("--src");
    if (i < 0 || !process.argv[i + 1]) {
      console.error("用法:node scripts/site-font.mjs --src <LXGWWenKai-Medium.ttf>   或   --check");
      process.exit(2);
    }
    const chars = neededChars().join("");
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(CHARS, chars);
    execFileSync("pyftsubset", [
      process.argv[i + 1],
      `--text-file=${CHARS}`,
      "--flavor=woff2",
      `--output-file=${WOFF2}`,
      "--layout-features=kern,liga,locl",
      "--no-hinting",
      "--desubroutinize",
    ], { stdio: ["ignore", "ignore", "inherit"] });
    const kb = (readFileSync(WOFF2).length / 1024).toFixed(1);
    console.log(`✓ ${chars.length} 个字符 → site/fonts/zhujian-wenkai.woff2(${kb} KB)`);
  }
}
