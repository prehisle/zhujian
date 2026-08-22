// 鸿蒙上真正的入口是 lib.rs 里 `#[tauri::mobile_entry_point]` 展开出来的
// `#[ability(webview, …)] fn openharmony(...)`,由 ArkTS 的 NativeAbility 加载 .so 时拉起。
// 这个 bin 只为「在宿主机上 cargo run 一下」保留,与安卓壳同形。
fn main() {
    zhujian_ohos_lib::run()
}
