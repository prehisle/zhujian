// 卡片颜色标记(0040):调色板(单一真相源)+ 染色助手 + 色板浮层。
//
// ⭐ **定位是「临时视觉标记」,不是分类**(用户 2026-09-16 拍板):分类走标签(topics,M:N)。
// 同轮一并拍死两条,⛔ 别重议:
//   ① **不做「卡片颜色跟着标签走」** —— 一按标签筛选就整屏同色,颜色与筛选成了同一维度的
//      两次表达,信息量归零(用户原话:「一筛全是同一种颜色,没啥意义」);
//   ② **不做按颜色筛选** ⇒ 颜色不进任何逻辑(筛选 / 排序 / 统计 / 归档判定全不看它),纯展示层。
//
// 存的是 6 位十六进制(`#RRGGBB`)。后端命令层 `task::set_color` 与**回放 shape 层**
// `replay::validate_color_value` 引用同一个 `notes::is_hex_color`,两道闸只认这一种形式
// (首版自检清单 14:颜色格式只许有一个正式子)。
//
// ⛔⛔ **消费面硬约束(backlog 休眠账 7 触发门②)**:`--card-color` 是**同步来的自由文本**,
// 只许经 `color-mix()` 或 `background-color:` 消费。⛔ 绝不许写成 `background: var(--card-color)`
// —— `background` 简写吃 `url()`,那条账的实测字据里它**真发出了网络请求**(信标,泄露
// 「这台在线 + 它的 IP」)。⚠ 新增任何一处消费点之前,回去把那条账读完。
//
// ⚠ **手机端不走这套**(用户面 110 起两只手机壳也画颜色,只画不设色):`color-mix()` 要 Chrome 111,
// 台架 MuMu 是 110,且含 `var()` 时补兜底救不了(IACVT,`.claude/rules/mobile.md` 643)⇒ 手机端把
// hex 解成三个整数、配一枚 alpha 令牌画同一层淡底,见 `android/src/ui.ts::cardTint` 与
// `android/index.html` 的 `.card.tinted`(浓度在手机上另量过,与这边的 18% / 20% 不是同一组数)。
// ⚠ 那边的小字补偿值是**对着这七色**算的 —— 这里加色,那边的补偿要重算(理由在 `.card.tinted`)。

import { t } from "./i18n";
import { el } from "./dom";
import { armDismiss } from "./hotkey-menu";

export type CardColor = { hex: string; name: string };

// 七色,对上 1-7 七枚数字键(0 = 清除)。
//
// ⭐ **刻意不复用 `tag-color.ts` 的 TAG_COLORS,理由是量出来的**(697,真机逐档并排看):
// 那八枚是给**标签 chip** 设计的 —— chip 是小块饱和色,而这里是**大面积 18% 淡底**,
// 两者对色差的要求差一个量级。拿 TAG_COLORS 铺 9 枚实测,有**三组**分不开:
// 苔绿/竹绿/松石、赭红/绛红、墨褐 vs 无色。
//
// ⛔ **也别改成「HSL 色相等距」** —— 那一版(每 34 度一枚)照样有两组糊(黄绿/草绿/翠绿、
// 蓝/靛):色相等距 ≠ **感知**等距,人眼在绿区(90-160 度)分辨率本来就低,再被 18% 淡底把
// 色差压掉约 5 倍。⇒ 定形 = **绿区只取一枚、蓝靛合一枚**,这才是「每一枚都真分得开」的上限。
//
// ⛔ 全体避开 0-25 度的**朱砂族**:那是 `--seal` 的地盘(「进行中 / 逾期」那根左条的信号色),
// 整卡染同族色会把那个信号稀释掉(TAG_COLORS 当初避开纯朱红是同一条理由)。
//
// ⚠ **要再加色先回去看那三组实测**:9 枚在 18% 下必有 2-3 枚是用户自己也分不出来的 ——
// 那几枚不只是「没用」,是**会读错**(以为标了 B 类,扫一眼读成 A 类)。真要更多类别,那是
// **分类**需求、该走标签(chip 没有这个天花板),⛔ 别在这里加。
export const CARD_COLORS: CardColor[] = [
  { hex: "#c07a3f", name: t("cardColor.amber") },
  { hex: "#b5883a", name: t("cardColor.straw") },
  { hex: "#4a8f52", name: t("cardColor.bamboo") },
  { hex: "#3f8a86", name: t("cardColor.celadon") },
  { hex: "#3f78a0", name: t("cardColor.azure") },
  { hex: "#6d5ba0", name: t("cardColor.violet") },
  { hex: "#9e5397", name: t("cardColor.mallow") },
];

function nameOf(hex: string): string {
  return CARD_COLORS.find((c) => c.hex === hex)?.name ?? hex;
}

/** 给一张卡染色 / 摘色:写入 `--card-color` 自定义属性并加 `.tinted`(具体怎么用这个变量
 *  由 CSS 决定 —— 极淡底色)。⛔ 消费面约束见文件头。 */
export function applyCardColor(card: HTMLElement, color: string | null | undefined): void {
  if (color) {
    card.style.setProperty("--card-color", color);
    card.classList.add("tinted");
  } else {
    card.style.removeProperty("--card-color");
    card.classList.remove("tinted");
  }
}

/** 在 `wrap` 里就地展开色板(同 due / priority 选择器的形:Esc 或点别处收起,不设「取消」钮)。
 *
 *  ⭐ 每个色点上印着**自己的数字键** —— 这是「悬停 + 数字键」那条快速通道的**唯一发现入口**
 *  (那八枚 Act 是 `hidden` 的、不进 ⋯ 菜单,否则 14 行的菜单会被撑到 22 行)。 */
export function openCardColorPicker(
  wrap: HTMLElement,
  current: string | null,
  apply: (hex: string | null) => void,
): void {
  let off = () => {};
  off = armDismiss(wrap, () => wrap.replaceChildren());
  const pick = (hex: string | null): void => {
    off(); // 先摘监听:apply 成功会重渲整卡、失败要报错,两条路都不该留下没监听的半开态
    apply(hex);
  };
  const swatch = (hex: string | null, key: string): HTMLElement => {
    const b = el("button", {
      className: hex ? "color-swatch" : "color-swatch none",
      title: hex ? `${nameOf(hex)} (${key})` : `${t("board.colorNone")} (${key})`,
      textContent: hex ? key : t("board.colorNone"),
      draggable: false,
    });
    if (hex) b.style.setProperty("--card-color", hex);
    if ((current ?? null) === hex) b.classList.add("current");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      pick(hex);
    });
    return b;
  };
  wrap.replaceChildren(
    el("div", { className: "card-color-row" }, [
      ...CARD_COLORS.map((c, i) => swatch(c.hex, String(i + 1))),
      swatch(null, "0"),
    ]),
  );
}
