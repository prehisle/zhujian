// 标签颜色:调色板(单一真相源)+ 给 chip 着色的助手。颜色是标签的可选属性(同步字段),
// 看板卡片的 chip 与筛选条据此着色,便于一眼定位。设计取向「纸与朱墨」——一组克制的暗调色,
// 落在纸色底上仍安静;颜色只是冗余的次通道,文字始终是主。默认无色。
//
// 存的是 6 位十六进制(`#RRGGBB`),后端(notes::set_topic_color)只认这一种形式。

export type TagColor = { hex: string; name: string };

// 八个可区分的暗调色(避开纯朱红——那是截止/新生脉冲的强调色,别撞)。手选热标签用,
// 不铺满。顺序即调色板里的排布。
export const TAG_COLORS: TagColor[] = [
  { hex: "#c0563f", name: "赭红" },
  { hex: "#cc8b3c", name: "黄土" },
  { hex: "#7f8b3a", name: "苔绿" },
  { hex: "#3f8272", name: "松石" },
  { hex: "#3f7a99", name: "黛蓝" },
  { hex: "#6b5b95", name: "藤紫" },
  { hex: "#a8577e", name: "绛红" },
  { hex: "#7a7166", name: "墨褐" },
];

// 给一个 chip 元素套上/摘掉颜色:着色时写入 --tag-color 自定义属性并加 .tinted class
// (具体如何用这变量由 CSS 决定：左侧色条 + 极淡底色);无色时还原成默认 pill。
export function applyTagColor(chip: HTMLElement, color: string | null | undefined): void {
  if (color) {
    chip.style.setProperty("--tag-color", color);
    chip.classList.add("tinted");
  } else {
    chip.style.removeProperty("--tag-color");
    chip.classList.remove("tinted");
  }
}
