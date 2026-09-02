// 按需探针(⛔ 不在默认套件里):**量看板顶栏三档塌缩各自「恒一行」的门槛**。
//
// 为什么它该活在仓里(570 立):`board.css` 那三个断点是**内容决定的机制值** —— 顶栏每加一枚
// 控件、任何一句标签改长,它们就该重量一次。485 那轮的注释已经写过「再加第七枚控件之前重新量
// 一次」,而 502 加了「到期汇总」之后没人回头量,结果 1100–1300 一整档静默掉成两行、直到用户
// 当面点名(569/570)。⇒ 把那次测量做成一支能重跑的探针,下一个动顶栏的人跑一遍就有数。
//
// **跑法**(⛔ 要绝对路径才能在 519 那条第二桌面的路上点名;普通跑法用相对路径也行):
//   npm run test:e2e -- --specFileRetries=0 --spec e2e/probes/hdr-tiers.e2e.js
//
// **它答什么**:对每一档塌缩配置 × 每一套文本,从窄到宽扫窗宽,报**第一个让顶栏收成一行的**
// 窗宽与那一刻的**顶栏内容宽**(= 断点该取的数,断点写「需要值 − 1」)。
//
// ⚠ **四条焊死的坑(都是 570 当场栽的)**:
//  ① **先把仓里那几条塌缩规则顶回去再量**(`BASE`)—— 不然量到的是它们自己,不是「全形要多宽」。
//     第一版没顶,三档量出来一模一样的 920。
//  ② **看板上必须有任务** —— 一条都没有时「复制看板」那颗**根本不渲染**,tier 0 会少量掉它那
//     ~90px。这里读不到那颗就**当场抛**,别让它安静地给个偏小的数。
//  ③ **每枚控件要填该字典里最长的那一句**(排序有三档、到期有三段、计数取三位数),
//     否则量到的是「今天这台机器上恰好的文本」。
//  ④ **两套文本各量一遍**:同一个断点要同时对中英两份字典成立,而英文单词比汉字长
//     (570 实测中文 1010/930/840/550、英文 1200/1110/1000/580)。今天断点只按中文取,
//     英文那半是知情的取舍,账在 backlog 用户面 66。
//
// ⚠ 「排了几行」用**顶栏高度**判(实测一行 71–73、两行 116 ⇒ 80 是安全的分界)。
// ⛔ 别去数子元素有几个不同的顶边:顶栏是 `align-items: baseline`,同一行上 h1 与那几枚钮的
//    top 本来就不同(570 第一版这么写,把一行的顶栏判成了 3 行)。
import { browser } from "@wdio/globals";
import { goNotebook, invoke } from "../specs/support.js";

const OUT = "e2e/probes";

// 把仓里那三档塌缩整个顶回去(⛔ 别删:见头注 ①)。
const BASE =
  ".v-board header .hbtn .lbl{display:inline}" +
  ".v-board header .hbtn .lbl-short{display:none}" +
  ".v-board header .copy-slot{display:inline}" +
  ".v-board header .hbtn .k{display:block}";

const TIERS = [
  { name: "全形", css: BASE },
  { name: "摘键帽", css: BASE + ".v-board header .hbtn .k{display:none}" },
  {
    name: "再摘复制看板",
    css: BASE + ".v-board header .hbtn .k{display:none}.v-board header .copy-slot{display:none}",
  },
  {
    name: "字母态",
    css:
      BASE +
      ".v-board header .hbtn .lbl{display:none}.v-board header .hbtn.active .lbl{display:inline}" +
      ".v-board header .copy-slot{display:none}.v-board header .hbtn:not(.active) .lbl-short{display:inline}",
  },
];

// 每枚控件取该字典里最长的那一句(见头注 ③)。
const TEXT = {
  zh: {
    h1: "任务看板",
    add: "新建任务",
    copy: "复制看板",
    due: "逾期 12 · 今天 5 · 3 天内 8",
    dueShort: "25",
    sort: "顺序:最新在前",
    cols: "管理列",
    seal: "归档 ",
    trash: "回收站 ",
  },
  en: {
    h1: "Task board",
    add: "New task",
    copy: "Copy board",
    due: "12 overdue · 5 today · 8 within 3d",
    dueShort: "25",
    sort: "Order: newest first",
    cols: "Columns",
    seal: "Archive ",
    trash: "Trash ",
  },
};

describe("探针 · 看板顶栏塌缩三档的一行门槛", () => {
  before(async () => {
    await goNotebook("board");
    if ((await invoke("list_tasks")).length === 0) await invoke("create_task", { title: "顶栏门槛-占位" });
    await goNotebook("board"); // 让「复制看板」那颗渲出来(见头注 ②)
  });

  it("逐档扫窗宽,报门槛", async () => {
    const table = [];
    for (const lang of Object.keys(TEXT)) {
      for (const tier of TIERS) {
        let found = null;
        for (let w = 700; w <= 1600; w += 10) {
          await browser.setWindowSize(w, 700);
          await browser.pause(110);
          const m = await browser.execute(
            (css, tx) => {
              document.getElementById("probe-tier")?.remove();
              const s = document.createElement("style");
              s.id = "probe-tier";
              s.textContent = css;
              document.head.append(s);
              const q = (sel) => document.querySelector(sel);
              q(".v-board header h1").textContent = tx.h1;
              q("#add-task .lbl").textContent = tx.add;
              const cs = q("#copy-slot .hbtn");
              if (!cs) throw new Error("「复制看板」那颗没渲染出来 —— 看板上得先有任务,否则全形会量小 ~90px");
              cs.textContent = tx.copy;
              const due = q("#due-soon");
              due.hidden = false;
              due.querySelector(".lbl").textContent = tx.due;
              due.querySelector(".lbl-short").textContent = tx.dueShort;
              q("#board-sort-lbl").textContent = tx.sort;
              q("#manage-cols .lbl").textContent = tx.cols;
              q("#seal-toggle .lbl").textContent = tx.seal;
              q("#trash-toggle .lbl").textContent = tx.trash;
              q("#seal-n").textContent = "201";
              q("#trash-n").textContent = "137";
              const h = q(".v-board header");
              const st = getComputedStyle(h);
              return {
                h: Math.round(h.getBoundingClientRect().height),
                content: Math.round(h.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight)),
              };
            },
            tier.css,
            TEXT[lang],
          );
          if (m.h <= 80) {
            found = m;
            break;
          }
        }
        table.push(`${lang} · ${tier.name}:顶栏内容宽 ${found ? found.content : ">1230"}(窗宽 ${found ? found.content + 370 : ">1600"})`);
      }
    }
    console.log("\n【一行门槛】断点写「这个数 − 1」;⚠ 窗宽那一列含侧栏 172 与内边距,换台机器未必是同一个差值\n" + table.join("\n"));
    await browser.saveScreenshot(`${OUT}/out-hdr-tiers.png`);
    await browser.setWindowSize(1260, 700); // ⛔ 别把扫剩下的窗宽泄漏出去
  });
});
