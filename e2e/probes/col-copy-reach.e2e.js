// 按需探针(⛔ 不在默认套件里):**量「复制」这条路在窄窗 + 多列时够不够得着,以及列头还剩多少地方**。
//
// 为什么它该活在仓里(65 立):顶栏那颗「复制看板」按**顶栏内容宽**退场(≤929),列头那颗
// 「复制本列」按**列宽**退场(≤240)—— 两根不同的轴,窄窗 + 多列时同时成立,「把看板/某列
// 复制成 Markdown」这条路整个没了(backlog 用户面 65)。要修就得先知道:**让列头那颗留下时,
// 列头还装不装得下**(它是一行 nowrap,只有列名能缩)。⇒ 把那次测量做成能重跑的探针。
//
// **跑法**:
//   npm run test:e2e -- --specFileRetries=0 --spec e2e/probes/col-copy-reach.e2e.js
//
// **它答什么**:在「顶栏那颗已经退场」的窗宽下,对 done 列(列头最挤的那一列:名 + 计数 +
// 复制 + 全部归档)× 三种让位配置 × 两套文本,报每件的实得宽与列名剩多少、有没有被裁。
//
// ⚠ 焊死的坑:
//  ① **列宽不是「窗宽 ÷ 列数」** —— 569 起列宽下限 200px、装不下就横滚。所以这里**直接量
//     `.col` 的实得宽**,别拿窗宽反推。
//  ② **每套文本取该字典里最长的那一句**(列名用「已完成」/ "Completed",计数三位数)——
//     否则量到的是「今天这台机器上恰好的文本」。
//  ③ **列名可缩到 0**(`min-width:0` + ellipsis)⇒ `head.scrollWidth > clientWidth` 恒为假,
//     它证明不了「装得下」。真正的判据是**列名剩多少 px、够不够写完**(`name.scrollWidth`
//     是它想要的宽,`clientWidth` 是实得)。
//  ④ **这里的「裁了」是最坏情况,不是日常** —— 计数按坑 ② 填了三位数 `137`。真实数据下
//     (个位数计数)`board-seal.e2e.js` 那格量到的 `nameClipped` 是 **false**,两处不打架。
import { browser, $ } from "@wdio/globals";
import { goNotebook, invoke } from "../specs/support.js";

const OUT = "e2e/probes";

// 三种让位配置(都在「顶栏那颗已退场」的前提下量)。⛔ **第一档必须是「仓里当前」而不是
// 写死的某一版行为** —— 65 落地后仓里的形就变了,档名若还叫「今天」就会静默答错(同族教训
// 见 memory `stale-number-in-docs-and-fixtures`)。
// ⛔⛔ **注入的选择器必须与仓里那条同特异性**(靠「后来居上」赢,注入的 <style> 在 head 末尾)
//     —— 第一版写的是 `.v-board .col-copy{…}`(0,2,0),输给仓里的
//     `.v-board[data-hdrcopy="off"] .col-copy`(0,3,0),**三档量出一模一样的读数**、而屏上
//     与「刀落上了」完全同形(memory `test-negative-control`:刀没落上与刀被吸收了同屏)。
//     ⇒ 下面 `expectOff` 那格就是替这件事把关的,别删。
const OFF = '.v-board[data-hdrcopy="off"]';
const SEAL_LONG = `${OFF} .seal-all-slot .lbl-long{display:inline}${OFF} .seal-all-slot .lbl-short{display:none}`;
const CASES = [
  { name: "仓里当前", css: "" },
  { name: "65 之前(两颗同时没了)", css: `${OFF} .col-copy{display:none}${SEAL_LONG}`, expectOff: true },
  { name: "让位链少一环(留下复制、归档仍长标签)", css: `${OFF} .col-copy{display:inline-block}${SEAL_LONG}` },
];

const TEXT = {
  zh: { name: "已完成", copy: "复制", sealLong: "全部归档", sealShort: "归档" },
  en: { name: "Completed", copy: "Copy", sealLong: "Archive all", sealShort: "Archive" },
};

describe("探针 · 窄窗多列下「复制」够不够得着 + 列头还剩多少地方", () => {
  before(async () => {
    await goNotebook("board");
    const id = await invoke("create_task", { title: "列头余量-占位" });
    await invoke("update_task_status", { id, to: "done" });
    await goNotebook("board");
    await $('.col[data-col="done"] .col-head').waitForExist({ timeout: 10000 });
  });

  it("逐配置量 done 列列头", async () => {
    const table = [];
    // 900 = 用户账里点名的那个现场(改前「窗 1000 / 5 列就已经是这样」);1068 = 四列各 200 的下界。
    for (const w of [900, 1068]) {
      await browser.setWindowSize(w, 700);
      await browser.pause(250);
      for (const lang of Object.keys(TEXT)) {
        for (const c of CASES) {
          const m = await browser.execute(
            (css, tx) => {
              document.getElementById("probe-colcopy")?.remove();
              if (css) {
                const s = document.createElement("style");
                s.id = "probe-colcopy";
                s.textContent = css;
                document.head.append(s);
              }
              const head = document.querySelector('.col[data-col="done"] .col-head');
              const q = (sel) => head.querySelector(sel);
              q(".col-name").textContent = tx.name;
              q(".col-count").textContent = "137";
              const cp = q(".col-copy");
              if (cp) cp.textContent = tx.copy;
              const sl = q(".seal-all-slot .lbl-long");
              if (sl) sl.textContent = tx.sealLong;
              const ss = q(".seal-all-slot .lbl-short");
              if (ss) ss.textContent = tx.sealShort;
              const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
              const nm = q(".col-name");
              return {
                col: Math.round(document.querySelector('.col[data-col="done"]').getBoundingClientRect().width),
                headCopyShown: getComputedStyle(document.querySelector("#copy-slot")).display !== "none",
                copyShown: vis(cp),
                copyW: cp ? Math.round(cp.getBoundingClientRect().width) : 0,
                countW: Math.round(q(".col-count").getBoundingClientRect().width),
                sealW: Math.round(q(".seal-all-slot")?.getBoundingClientRect().width ?? 0),
                nameGot: Math.round(nm.clientWidth),
                nameWants: Math.round(nm.scrollWidth),
                nameClipped: nm.scrollWidth > nm.clientWidth + 1,
                headOverflow: head.scrollWidth > head.clientWidth + 1,
              };
            },
            c.css,
            TEXT[lang],
          );
          // 自证:标了 expectOff 的那一档要是没把列头那颗按下去,就是注入根本没生效(见上面
          // 那条 ⛔),此刻整张表都不算数 —— 当场抛,别让它安静地印一组同形的数。
          if (c.expectOff && m.copyShown) {
            throw new Error(`注入没生效:「${c.name}」这一档列头那颗仍显示 ⇒ 特异性输给了仓里那条,整张表作废`);
          }
          table.push(
            `窗${w} · ${lang} · ${c.name}:列宽 ${m.col} / 顶栏复制 ${m.headCopyShown ? "在" : "没了"} / ` +
              `列头复制 ${m.copyShown ? `在(${m.copyW})` : "没了"} / 计数 ${m.countW} / 归档钮 ${m.sealW} / ` +
              `列名 得 ${m.nameGot} 要 ${m.nameWants}${m.nameClipped ? " ⚠裁了" : ""}${m.headOverflow ? " ⚠列头溢出" : ""}`,
          );
        }
      }
    }
    console.log("\n【列头余量】\n" + table.join("\n"));
    // 出图:⛔ 注入的样式先摘掉 —— 要留的是**仓里那两条 @container + data-hdrcopy 真实生效**
    // 的样子(门禁与断言全绿 ≠ 长得对,memory `gates-green-is-not-looks-right`)。
    await browser.execute(() => document.getElementById("probe-colcopy")?.remove());
    await goNotebook("board"); // ⛔ 重画一次:上面逐档改过列名/计数的文本,不还原就把篡改拍进图里
    await browser.setWindowSize(900, 700); // ⛔ 必须在 goNotebook **之后** —— 它自己会把窗还原成 1260
    await browser.pause(250);
    // 900px / 四列 ⇒ 横滚(569 起列宽下限 200)。done 列在最右,不滚过去图里根本看不到它。
    await browser.execute(() => {
      const b = document.querySelector(".v-board .cols"); // ⛔ 横滚在 .cols 上,不在 #board
      b.scrollLeft = b.scrollWidth;
    });
    await browser.pause(200);
    await browser.saveScreenshot(`${OUT}/out-col-copy-reach.png`);
    await browser.setWindowSize(1260, 700); // ⛔ 别把扫剩下的窗宽泄漏出去
  });
});
