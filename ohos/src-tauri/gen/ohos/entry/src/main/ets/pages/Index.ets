// ⚠ 这一页**跑不到**:`EntryAbility` 装的是 `../shell/ZhujianPage`(658 起,照抄依赖的
// MainPage + 页面→ArkTS 的桥;它承载 WebView)。但 `module.json5` 的
// `pages` 字段是必填的、且必须指向一个真实存在的页面 ⇒ 留这个最小占位。
// ⛔ 别往这里加东西,朱简的界面全在 WebView 里(ohos/src 那份前端)。
@Entry
@Component
struct Index {
  build() {
    Column() {
      Text('朱简')
    }
    .width('100%')
    .height('100%')
  }
}
