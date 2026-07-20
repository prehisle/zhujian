// 163 常驻回归锚(ui-guidelines §3.6/§3.7 两条规则的行为证明;阴性对照实跑过:
// 撤乐观移位→例① 红、撤出生隐形→例② 红):
//   ① 拖放「手势即回执」——drop 派发的同一同步回合里,卡已在目标列 DOM(不等后端往返)。
//   ② 超高图 lightbox「布局未定不显示」——逐帧记录查看器 img,可见帧的宽度恒等于
//      终态整图宽,不存在「先宽后缩」的裸渲染帧(也捕迟到 resize 的二次重排)。
// zz 前缀刻意钉在字典序末尾:例② 会把真窗撑到近屏再还原,窗口几何敏感,放最后跑。
import { browser, $, expect } from "@wdio/globals";
import { goNotebook, invoke } from "./support.js";

describe("163 · 手势即回执 + 布局未定不显示", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("拖放 drop 同帧:卡已插入目标列(乐观移位,不等 IPC)", async () => {
    const T = "验证163-乐观移位";
    await invoke("create_task", { title: T });
    // 重载让新任务上板。
    await goNotebook("board");
    await $(".tcard*=" + T).waitForExist({ timeout: 5000 });
    // 同一 execute(同一同步回合)里:派发 dragstart/dragover/drop 后立即读目标列 DOM。
    // 后端响应最早也要下一个宏任务才可能落地,此刻卡在 doing 列 = 乐观移位在作用。
    const sameTick = await browser.execute((t) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
      const body = document.querySelector(".col.doing .col-body");
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      body.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const inDoing = [...body.querySelectorAll(".tcard")].some((c) => c.textContent.includes(t));
      card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      return inDoing;
    }, T);
    expect(sameTick).toBe(true);
    // 后端真相回来后仍应在 doing(乐观位与落库一致)。
    await browser.waitUntil(
      async () => {
        const tasks = await invoke("list_tasks");
        const found = tasks.find((x) => x.title === T);
        return found && found.status === "doing";
      },
      { timeout: 5000, timeoutMsg: "任务未落库到 doing" },
    );
  });

  it("超高图点开:可见帧宽度恒为终态整图宽(无「先宽后缩」裸渲染帧)", async () => {
    // 造一条带 400×4000 超高图的任务(canvas 在页面里现画,免依赖外部文件)。
    const T = "验证163-超高图";
    const id = await invoke("create_task", { title: T });
    await browser.execute(async (itemId) => {
      const cv = document.createElement("canvas");
      cv.width = 400;
      cv.height = 4000;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#c33";
      ctx.fillRect(0, 0, 400, 4000);
      ctx.fillStyle = "#fff";
      for (let y = 0; y < 4000; y += 200) ctx.fillRect(0, y, 400, 8);
      const dataB64 = cv.toDataURL("image/png").split(",")[1];
      await window.__TAURI__.core.invoke("add_item_image", {
        itemId,
        mime: "image/png",
        dataB64,
        spaceId: "main",
      });
    }, id);
    await goNotebook("board");
    const thumb = await $(".tcard*=" + T).$(".img-thumb-img");
    await thumb.waitForExist({ timeout: 5000 });
    // 先装逐帧记录器再点缩略图:每 rAF 记录查看器 img 的可见性与实际宽度。
    await browser.execute(() => {
      window.__rec163 = [];
      window.__rec163stop = false;
      const tick = () => {
        const img = document.querySelector(".img-lightbox-img");
        if (img) {
          window.__rec163.push({
            vis: getComputedStyle(img).visibility,
            w: img.getBoundingClientRect().width,
          });
        }
        if (!window.__rec163stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await thumb.click();
    // 等查看器 img 可见且宽度连续稳定(终态)。
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".img-lightbox-img");
          return !!img && getComputedStyle(img).visibility === "visible" && img.getBoundingClientRect().width > 0;
        }),
      { timeout: 10000, timeoutMsg: "lightbox 图片未亮相" },
    );
    await browser.pause(600); // 再收几帧,确认亮相后无二次重排
    const rec = await browser.execute(() => {
      window.__rec163stop = true;
      return window.__rec163;
    });
    const visible = rec.filter((f) => f.vis === "visible" && f.w > 0);
    expect(visible.length).toBeGreaterThan(0);
    const finalW = visible[visible.length - 1].w;
    // 超高图的终态=整图适配,宽度必然远小于原始 400px;任何可见帧宽度都不得偏离终态
    // (±2px 容差)。旧病(裸渲染原始尺寸/迟到 resize 重排)会留下 ≥400px 或与终态不同的帧。
    expect(finalW).toBeLessThan(300);
    for (const f of visible) {
      expect(Math.abs(f.w - finalW)).toBeLessThanOrEqual(2);
    }
    // 收尾:Esc 关查看器(还原窗口在遮罩下发生)。
    await browser.keys("Escape");
    await browser.pause(400);
  });
});
