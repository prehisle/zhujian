// 手机「记一笔」里的「长文」钮验收(backlog 152 ③,831 补:一篇长文都没有时底栏没有「长文」钮,
// 第一篇只能从这儿进)。
//
// 判据都读 DOM / localStorage / 命令回包:
//   ① 版面:「＋ 加图 / ＋ 拍照 / ＋ 清单 / 长文 / 记下」在中文 115% 档(用户那台)排成一行;中英 × 100 / 115 / 130
//     各档没有一枚钮的字折行(装不下整枚换行是既有约定,`.compose-row` 那条 CSS 头注)。读数逐档印出来。
//   ② 带过去:框里的字 + 两张暂存图 → 点「长文」⇒ 长文面开着、停在编辑器;⭐ **点下去那一刻长文草稿就落了**
//     (不等停笔 1 秒 ——「记一笔」那份已清,这时杀进程字只在这儿);「记一笔」那边字清了、暂存条空了、文字草稿键
//     没了;带过来的图**开编辑器即建篇挂上**(832 起没有长文暂存条),正文 = 框里的字 + 末尾两段「图1」「图2」。
//   ③ 返回 ⇒ 落到这一篇的阅读页(832 起返回键同「保存」钮)、正文原样(连引用)、带着那两张图;一路返回 ⇒ 面关了、底栏「长文」钮显形;重载后「记一笔」
//     暂存条仍空(IndexedDB 那份跟着 takeBatch 清了)。
//   ④ 有一份没写完的新篇草稿时:框里的字**接在它后面**(空一行),⛔ 不覆盖。
//   ⑤ 框里没字、没有草稿 ⇒ 空编辑器;一个字没写就返回 = 不建。
//   ⑥ 「记一笔」取图在飞时点「长文」不受理(面不开、框里的字还在);放行后照常。
//
// 阴性对照(831 实跑):把 `startDocFrom` 里那次 saveDraft 摘掉 ⇒ ② 的「点下去那一刻长文草稿就落了」红;
// 把 main.ts 那枚钮的 `picking` 闸摘掉 ⇒ ⑥ 红。
//
// 取图不经系统选择器:同 `cdp-acceptance-docs-images.mjs`(页内换掉 file input 的 click)。诚实边界同那支。
//
// ⛔ **会写库**:只动自己种的(正文带「记一笔转长文验收」的长文);收尾 purge。当前空间配过账户就拒跑
//    (`--allow-synced` 放行)。「记一笔」框里有字 / 有暂存图、或有没写完的新篇草稿就拒跑 —— 那是用户的东西。
//    字号与语言跑前记下、收尾还原。
//
// 跑法(MuMu / 真机的 devtools 包;先 `node scripts/android-cdp.mjs forward`):
//   CDP_PORT=9222 node scripts/cdp-acceptance-docs-from-compose.mjs
// 退出码 0 = 全过。
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const PORT = Number(process.env.CDP_PORT || 9222);
const ALLOW_SYNCED = argv.includes("--allow-synced");
const MARK = "记一笔转长文验收";

const s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl, { timeoutMs: 30000 });
const ev = (js) => s.evaluate(js);
let fails = 0;
const ok = (cond, what, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "✔" : "✗"} ${what}${extra !== undefined ? "  " + JSON.stringify(extra) : ""}`);
};
async function waitFor(expr, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await ev(expr)) return true;
    } catch {
      /* 重画 / 重载途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) {
      ok(false, `等「${what}」超过 ${ms}ms`, expr);
      return false;
    }
    await sleep(150);
  }
}
const inv = (cmd, args) => ev(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const back = () => ev(`window.__zhujianHandleBack()`);
/** 一路返回到面关上(新篇建成后返回先落到它的阅读页、再回列表、再关面;没建成的直接回列表)。 */
async function backToClosed() {
  for (let i = 0; i < 4 && (await paneOpen()); i++) {
    await back();
    await sleep(500);
  }
  await waitFor(`!document.body.classList.contains("pane-open")`, "面关了");
}
const paneOpen = () => ev(`document.body.classList.contains("pane-open") && !document.getElementById("docs-pane").hidden`);
const inEditor = () => ev(`!!document.querySelector("#docs-body textarea.doc-area")`);
const editorText = () => ev(`document.querySelector("#docs-body textarea.doc-area")?.value ?? null`);
const thumbCount = () => ev(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length`);
const composeThumbs = () => ev(`document.querySelectorAll("#compose-thumbs .cthumb").length`);
const composeText = () => ev(`document.getElementById("text").value`);
const docDraftKey = () => `zhujian.doc-draft:${sp}:new`;
const docDraft = () => ev(`(() => { const r = localStorage.getItem(${JSON.stringify(docDraftKey())}); return r === null ? null : JSON.parse(r).text; })()`);
async function reload() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(800);
  await waitFor(`document.readyState === "complete" && !!document.querySelector("#bottombar") && !!window.__TAURI__ && document.getElementById("gate").hidden`, "页面就绪", 30000);
}
async function openCapture() {
  if (await ev(`!document.getElementById("capture-fab").hidden`)) await ev(`document.getElementById("capture-fab").click()`);
  await waitFor(`document.getElementById("capture-fab").hidden`, "捕获层开着");
}
const typeCompose = (text) =>
  ev(`(() => { const a = document.getElementById("text"); a.value = ${JSON.stringify(text)}; a.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
/** 换掉 file input 的 click:塞 `n` 张页内现画的 PNG、发 change。`hold` = 先不交,等 `__pickGo()`。 */
const armPicker = (n, hold = false) =>
  ev(`(() => {
    if (!window.__realClick) window.__realClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file") return window.__realClick.call(this);
      const input = this;
      const deliver = async () => {
        const dt = new DataTransfer();
        for (let i = 0; i < ${n}; i++) {
          const c = document.createElement("canvas");
          c.width = 48; c.height = 48;
          const g = c.getContext("2d");
          g.fillStyle = "hsl(" + (i * 97) % 360 + ",60%,50%)";
          g.fillRect(0, 0, 48, 48);
          const blob = await new Promise((r) => c.toBlob(r, "image/png"));
          dt.items.add(new File([blob], "pick" + i + ".png", { type: "image/png" }));
        }
        input.files = dt.files;
        input.dispatchEvent(new Event("change"));
      };
      if (${hold}) window.__pickGo = deliver;
      else setTimeout(deliver, 50);
    };
    return true;
  })()`);
const disarmPicker = () => ev(`window.__realClick && (HTMLInputElement.prototype.click = window.__realClick), true`);
const markedDocs = async () => (await inv("list_docs", { spaceId: sp })).filter((d) => d.content.includes(MARK));
/** 「记一笔」那一行的几何:每枚钮的 top / 高 / 字,外加行内有没有换行。 */
const rowGeo = () =>
  ev(`(() => {
    const bs = [...document.querySelectorAll("#compose-card .compose-row button")].filter((b) => !b.hidden);
    const r = bs.map((b) => { const x = b.getBoundingClientRect(); return { t: b.textContent.trim(), mid: Math.round(x.top + x.height / 2), h: Math.round(x.height), w: Math.round(x.width) }; });
    // 字折没折行:钮里的字单独量(Range 的 client rects 数 = 行数)
    const lines = bs.map((b) => { const rg = document.createRange(); rg.selectNodeContents(b); return new Set([...rg.getClientRects()].map((q) => Math.round(q.top))).size; });
    // 同一行按竖直中线认(「记下」比别的钮高、align-items: center,上沿差几像素仍是同一行)
    const mids = r.map((x) => x.mid).sort((a, b) => a - b);
    const rows = mids.filter((m, i) => i === 0 || m - mids[i - 1] > 4).length;
    return { vw: innerWidth, rows, maxLines: Math.max(...lines), btns: r };
  })()`);

let sp = null;
let prefsRead = false; // 前置没过就中断时,收尾别去动用户的语言 / 字号 / 草稿
let origLang = null;
let origSize = null;
try {
  sp = await ev(`localStorage.getItem("zhujian.last-space")`);
  const spaces = await inv("list_spaces", {});
  const cur = spaces.find((x) => x.id === sp);
  if (!cur) throw new Error(`当前空间 ${sp} 不在 list_spaces 里`);
  if (cur.configured && !ALLOW_SYNCED) throw new Error(`当前空间配过账户,种子与墓碑会同步出去 —— 确认是测试账户再带 --allow-synced`);
  if ((await composeText()) !== "" || (await composeThumbs()) !== 0) throw new Error(`「记一笔」框里有字或暂存图(用户的),先记下再跑`);
  if ((await docDraft()) !== null) throw new Error(`有一份没写完的新篇长文草稿(用户的),先写完再跑`);
  if ((await markedDocs()).length) throw new Error(`库里已有带「${MARK}」的长文(上一趟没清干净?)`);
  origLang = await ev(`localStorage.getItem("zhujian.lang")`);
  origSize = await ev(`localStorage.getItem("zhujian.textsize")`);
  prefsRead = true;
  const hadDocs = (await inv("list_docs", { spaceId: sp })).length > 0;

  // ① 版面:中英 × 三档字号
  for (const lang of ["zh", "en"]) {
    await ev(`localStorage.setItem("zhujian.lang", ${JSON.stringify(lang)}), true`);
    await reload();
    for (const size of [100, 115, 130]) {
      await ev(`window.__zhujianTextSize.set(${size}), true`);
      await sleep(400);
      await openCapture();
      await sleep(300);
      const g = await rowGeo();
      console.log(`   ${lang} ${size}%:${g.rows} 行  ${g.btns.map((b) => `${b.t}@${b.mid}/${b.w}`).join("  ")}`);
      ok(g.maxLines === 1, `① ${lang} ${size}%:没有一枚钮的字折行`, g.maxLines);
      if (lang === "zh" && size === 115) ok(g.rows === 1, "① 中文 115%(用户那台的档)五枚钮一行排下", g);
      ok(g.btns.some((b) => b.t === (lang === "zh" ? "长文" : "Long-form")), `① ${lang}:有「长文」钮`, g.btns.map((b) => b.t));
    }
  }
  await ev(`window.__zhujianTextSize.set(${origSize === null ? 100 : Number(origSize)}), true`);
  if (origLang === null) await ev(`localStorage.removeItem("zhujian.lang"), true`);
  else await ev(`localStorage.setItem("zhujian.lang", ${JSON.stringify(origLang)}), true`);
  await reload();
  ok(hadDocs || (await ev(`document.querySelector('#bottombar [data-pane="docs"]').hidden`)), "① 前置:这个空间没有长文时底栏「长文」钮藏着", { hadDocs });

  // ② 字 + 两张暂存图带进新长文
  const TEXT = `# ${MARK} 甲\n\n从记一笔带过来的字。`;
  await openCapture();
  await typeCompose(TEXT);
  await armPicker(2);
  await ev(`document.getElementById("compose-addimg").click()`);
  await waitFor(`document.querySelectorAll("#compose-thumbs .cthumb:not(.pending)").length === 2`, "「记一笔」暂存条 2 张");
  await disarmPicker();
  // 草稿要在点下去的同一拍就在 —— 停笔 1 秒那一发还没到点。⚠ 在**同一个任务里**点完就读(833):
  // 带图过来会当场建篇,建成那一刻清掉新篇草稿(字已经在库里了);分两发读就成了和建篇赛跑,
  // MuMu 上建篇先到、读到 null(vivo 上读先到,所以 831 / 832 都绿过)。
  const draftNow = await ev(`(() => { document.getElementById("compose-doc").click(); const r = localStorage.getItem(${JSON.stringify(docDraftKey())}); return r === null ? null : JSON.parse(r).text; })()`);
  ok(draftNow === TEXT, "② ⭐ 点下去那一刻长文草稿就落了(不等停笔)", draftNow);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "编辑器");
  ok(await paneOpen(), "② 长文面开着");
  const WITH_REFS = `${TEXT}\n\n图1\n\n图2\n\n`;
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 2`, "长文缩略图 2 张(已挂上)");
  ok((await thumbCount()) === 2, "② 两张图开编辑器即挂上");
  ok((await editorText()) === WITH_REFS, "② 正文 = 框里的字 + 末尾两段「图N」", await editorText());
  ok((await composeText()) === "" && (await composeThumbs()) === 0, "② 「记一笔」那边字清了、暂存条空了", { text: await composeText(), thumbs: await composeThumbs() });
  ok((await ev(`localStorage.getItem("zhujian.compose-draft")`)) === null, "② 「记一笔」文字草稿键没了");
  ok((await markedDocs()).length === 1, "② 带图过来 = 开编辑器即建篇");

  // ③ 返回 = 建成;再返回 = 关面
  await back();
  await waitFor(`!document.querySelector("#docs-body textarea.doc-area")`, "离开编辑器");
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "返回落到这一篇的阅读页");
  let made = await markedDocs();
  ok(made.length === 1 && made[0].content === WITH_REFS, "③ 返回 ⇒ 那一篇正文原样(连引用)", made.map((d) => d.content));
  if (made.length === 1) {
    const imgs = await inv("list_item_images", { spaceId: sp, itemId: made[0].id });
    ok(imgs.length === 2, "③ 带着那两张图", imgs.length);
  }
  ok((await docDraft()) === null, "③ 建成后新篇草稿清了");
  await backToClosed();
  await waitFor(`!document.querySelector('#bottombar [data-pane="docs"]').hidden`, "底栏「长文」钮显形");
  await reload();
  ok((await composeThumbs()) === 0, "③ 重载后「记一笔」暂存条仍空(IndexedDB 那份清了)");

  // ④ 有没写完的新篇草稿:接在后面
  const PRIOR = `# ${MARK} 乙\n\n没写完的前半`;
  await ev(`localStorage.setItem(${JSON.stringify(docDraftKey())}, JSON.stringify({ text: ${JSON.stringify(PRIOR)}, gen: 1, at: new Date().toISOString() })), true`);
  await openCapture();
  await typeCompose("后半");
  await ev(`document.getElementById("compose-doc").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "编辑器");
  ok((await editorText()) === `${PRIOR}\n\n后半`, "④ 框里的字接在没写完的草稿后面(空一行),没覆盖", await editorText());
  ok((await docDraft()) === `${PRIOR}\n\n后半`, "④ 草稿也是接好的那份");
  await back();
  await waitFor(`!document.querySelector("#docs-body textarea.doc-area")`, "离开编辑器");
  await backToClosed();

  // ⑤ 空起:空编辑器,不写就走 = 不建
  const before = (await inv("list_docs", { spaceId: sp })).length;
  await openCapture();
  await ev(`document.getElementById("compose-doc").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "编辑器");
  ok((await editorText()) === "", "⑤ 框里没字、没草稿 ⇒ 空编辑器", await editorText());
  await back();
  await waitFor(`!document.querySelector("#docs-body textarea.doc-area")`, "离开编辑器");
  await sleep(500);
  ok((await inv("list_docs", { spaceId: sp })).length === before, "⑤ 一个字没写就返回 = 不建");
  await backToClosed();

  // ⑥ 取图在飞时不受理
  await openCapture();
  await typeCompose(`# ${MARK} 丙`);
  await armPicker(1, true);
  await ev(`document.getElementById("compose-addimg").click()`);
  await sleep(200);
  await ev(`document.getElementById("compose-doc").click()`);
  await sleep(500);
  ok(!(await paneOpen()), "⑥ 取图在飞时点「长文」⇒ 面不开");
  ok((await composeText()) === `# ${MARK} 丙`, "⑥ 框里的字还在");
  await ev(`window.__pickGo()`);
  await waitFor(`document.querySelectorAll("#compose-thumbs .cthumb:not(.pending)").length === 1`, "放行后暂存条 1 张");
  await disarmPicker();
  await ev(`document.getElementById("compose-doc").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "编辑器");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 1`, "放行后带过去 1 张");
  ok((await thumbCount()) === 1, "⑥ 放行后照常带过去");
  await back();
  await waitFor(`!document.querySelector("#docs-body textarea.doc-area")`, "离开编辑器");
  await backToClosed();
} catch (e) {
  ok(false, `中断:${e.message}`);
} finally {
  try {
    await disarmPicker();
  } catch {
    /* 页面可能在重载 */
  }
  try {
    // 中途断在 ① 时语言 / 字号也得还原;新篇草稿键跑前核过是空的,这里清掉的只会是本趟种的
    if (prefsRead) await ev(`(() => {
      ${origLang === null ? `localStorage.removeItem("zhujian.lang");` : `localStorage.setItem("zhujian.lang", ${JSON.stringify(origLang)});`}
      window.__zhujianTextSize.set(${origSize === null ? 100 : Number(origSize)});
      localStorage.removeItem(${JSON.stringify(sp === null ? "" : `zhujian.doc-draft:${sp}:new`)});
      return true;
    })()`);
    const seeded = sp === null ? [] : await markedDocs();
    for (const d of seeded) {
      await inv("archive_note", { spaceId: sp, id: d.id });
      await inv("purge_note", { spaceId: sp, id: d.id });
    }
    const left = sp === null ? [] : await markedDocs();
    const leftImgs = sp === null ? [] : (await inv("list_removed_images", { spaceId: sp, scope: "all" })).filter((g) => seeded.some((d) => d.id === g.item_id));
    ok(left.length === 0 && leftImgs.length === 0, "收尾:种的长文与它们的图都清了", { docs: left.length, imgs: leftImgs.length });
    await reload();
  } catch (e) {
    ok(false, `收尾失败:${e.message}`);
  }
  s.close();
}
console.log(fails === 0 ? "\n全过" : `\n${fails} 处不过`);
process.exit(fails === 0 ? 0 : 1);
