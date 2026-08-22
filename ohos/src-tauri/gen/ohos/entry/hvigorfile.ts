import { hapTasks } from '@ohos/hvigor-ohos-plugin';

// ⛔ demo 那份在这里挂了个 `tauriPlugin()`,构建时回调 `cargo tauri ohos
// dev-eco-studio-script` 去编 Rust。朱简**不走 tauri CLI**(460 判据:打包路径是
// 「手写 gen 目录 + hvigorw assembleHap」),Rust 那半由 scripts/build-ohos.mjs
// 先编好、再把 .so 放进 entry/libs/arm64-v8a/ —— 两步分开,失败点看得清。
export default {
  system: hapTasks,
  plugins: []
}
