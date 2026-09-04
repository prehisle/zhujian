// ⛔ **按需探针,刻意不在默认套件里**(住 `e2e/probes/`,`specs/**/*.e2e.js` 那条 glob 扫不到)。
//
// 干什么:给 `support.js::inboxCompose` 那半「自证」**做阴性对照** —— 它的价值全在
// 「红的时候说得清是哪一种」,而 memory `test-negative-control` 那条最难看出的形正是
// **刀没落上与刀被吸收了同屏**:一个只会在 CI 上偶尔红的东西,本机上永远绿,
// 光看「本机跑绿了」证明不了它对失败局面还有话说。
//
// 三格(一正两刀,两把刀各造一种**机理不同**的失败,判据是「红得对不对」不只是「红没红」):
//   ① 正例:什么都不动 —— `inboxCompose` 该静静地成功,库里出现那条。
//   ② 刀 A(驱动侧):在 document 捕获阶段把 click 拦下 ⇒ 点出去了、**没进 onclick**。
//      期望 = 抛,且话里带 `ran=0`,且**试满三次**(这一形重试有意义)。
//   ③ 刀 B(产品侧):捕获阶段不拦事件,只把输入框**清空**再放行 ⇒ onclick 跑了,
//      而 `prepare` 把空正文拒收、一声不响返回。期望 = 抛,话里带 `ran=1`,
//      且**只试一次**(⛔ 这一形不许重试:重试会把产品侧的病变成一次运气好的绿)。
//
// ⚠ 两把刀都装在 **document 捕获阶段**,不动产品源码 —— 它们模拟的是「这一记点击到不了
// 处理器」与「处理器跑了却没产出」这两种**局面**,不是去改被测对象。
// ⚠ 刀 B 用的手法(点击落到钮上之前把框清掉)与真实病因不必相同;要证的只有一件:
// **`ran ≥ 1` 那一支不会被重试盖过去**。
//
// 怎么跑(先另起 `npm run dev -- --host 127.0.0.1`):
//   YS_E2E_FAST=1 npm run test:e2e -- --specFileRetries=0 --spec e2e/probes/inbox-compose-selfproof.e2e.js
import { browser, expect } from "@wdio/globals";
import { invoke, goNotebook, clearInbox, inboxCompose } from "../specs/support.js";

const OK = "E2EP66-正例";
const KNIFE_A = "E2EP66-刀A";
const KNIFE_B = "E2EP66-刀B";

// 捕获阶段的刀:mode="block" 拦下事件(不进 onclick);mode="empty" 放行但先清空输入框。
async function armKnife(mode) {
  await browser.execute((m) => {
    window.__zjKnife = (e) => {
      if (!(e.target instanceof Element) || !e.target.closest(".v-inbox .compose-add")) return;
      if (m === "block") {
        e.stopPropagation();
        e.preventDefault();
      } else {
        const input = document.querySelector(".v-inbox .compose-input");
        if (input) input.value = "";
      }
    };
    document.addEventListener("click", window.__zjKnife, true);
  }, mode);
}
async function disarmKnife() {
  await browser.execute(() => {
    if (window.__zjKnife) document.removeEventListener("click", window.__zjKnife, true);
    window.__zjKnife = null;
  });
}

// 跑一趟并把「抛没抛 + 抛的是什么话」原样交回(⛔ 别只答布尔:红得对不对全在话里)。
async function run(text) {
  try {
    await inboxCompose(text);
    return { threw: false, msg: "" };
  } catch (e) {
    return { threw: true, msg: String(e.message) };
  }
}

describe("测试与工装 66 · inboxCompose 的自证面还有没有牙齿", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });
  afterEach(async () => {
    await disarmKnife();
  });
  after(async () => {
    await clearInbox();
  });

  it("① 正例:没刀的时候它静静成功,库里真出现那条", async () => {
    const r = await run(OK);
    expect(r).toMatchObject({ threw: false });
    const ideas = await invoke("list_ideas");
    expect(ideas.some((i) => i.content === OK)).toBe(true);
  });

  it("② 刀 A(点击进不了 onclick):抛,话里是 ran=0,且试满三次", async () => {
    await armKnife("block");
    const r = await run(KNIFE_A);
    console.log(`[探针66/刀A] ${r.msg}`);
    expect(r.threw).toBe(true);
    expect(r.msg).toContain("ran=0");
    // 三次都试过 = 这一形重试是有意义的那一支(话里逐次实得有三段)。
    expect(r.msg).toContain("3:ran=0");
    const ideas = await invoke("list_ideas");
    expect(ideas.some((i) => i.content === KNIFE_A)).toBe(false);
  });

  it("③ 刀 B(处理器跑了却没产出):抛,话里是 ran=1,且只试了一次", async () => {
    await armKnife("empty");
    const r = await run(KNIFE_B);
    console.log(`[探针66/刀B] ${r.msg}`);
    expect(r.threw).toBe(true);
    expect(r.msg).toContain("ran=1");
    // ⛔ 承重的一格:产品侧那一支**不许**被重试盖掉 ⇒ 逐次实得只有一段。
    expect(r.msg).not.toContain("2:");
    const ideas = await invoke("list_ideas");
    expect(ideas.some((i) => i.content === KNIFE_B)).toBe(false);
  });
});
