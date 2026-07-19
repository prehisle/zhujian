import { $, expect, browser } from "@wdio/globals";
import { invoke, goNotebook, clearInbox } from "./support.js";

// 跨空间移动 · 部分成功登记(cross-space-move §4 / codex 实现审二轮)。
// e2e 恒单空间(YS_DB_PATH 禁扫禁建),真实的移动路径不可达——本 spec 锁的是
// 登记本身的持久化契约:localStorage 里的 `${space}/${itemId}` 标记独立于 DOM,
// 重渲/重导航后卡面仍显提示;「我已处理,解除」清标记且不再回来。多空间下的
// 「入口隐藏 + 迟到结果落登记」由同一份标记函数驱动(space.ts),core/壳侧行为
// 有 rust 测试,真实互移走真库手验。
const KEY = "zhujian.move-partial";

async function markPartial(itemId, message) {
  await browser.execute(
    (k, id, msg) => {
      const m = JSON.parse(localStorage.getItem(k) ?? "{}");
      m[`main/${id}`] = msg;
      localStorage.setItem(k, JSON.stringify(m));
    },
    KEY,
    itemId,
    message,
  );
}

describe("跨空间移动 · 部分成功登记的持久化", () => {
  before(async () => {
    await goNotebook("inbox");
    await clearInbox();
  });
  after(async () => {
    await browser.execute((k) => localStorage.removeItem(k), KEY);
    await clearInbox();
  });

  it("登记在场:重导航后卡面常驻提示;解除后消失且重渲不复现", async () => {
    const id = await invoke("capture_note", { content: "E2E-移动登记-甲" });
    await markPartial(id, "已复制到目标空间,但原条目删除未执行:E2E注入原话");

    // 重导航 = 整视图重挂(等价于取消/刷新/重启后回来):提示必须还在。
    await goNotebook("inbox");
    const card = await $(".note*=E2E-移动登记-甲");
    await card.waitForExist({ timeout: 10000 });
    const notice = await $(".move-partial");
    await notice.waitForExist({ timeout: 10000 });
    expect(await notice.getText()).toContain("E2E注入原话");

    // 解除:标记清掉、提示离场,再重挂一次也不回来。
    const clearBtn = await notice.$("button*=解除");
    await clearBtn.click();
    await notice.waitForExist({ reverse: true, timeout: 10000 });
    await goNotebook("inbox");
    await (await $(".note*=E2E-移动登记-甲")).waitForExist({ timeout: 10000 });
    expect(await (await $(".move-partial")).isExisting()).toBe(false);

    const stored = await browser.execute((k) => localStorage.getItem(k) ?? "{}", KEY);
    expect(Object.keys(JSON.parse(stored))).toHaveLength(0);
  });
});
