// 安卓发版(106):核对 android/ 三处版本号一致 + 生成安卓更新清单 android.json。
// 与桌面 latest.json 刻意分开:那份归 Tauri updater 严格消费,两端发版节奏也不绑死。
// 用法:
//   node scripts/gen-android-update-manifest.mjs ["更新说明"]
// 前置:先 `cd android && npx tauri android build --apk --target aarch64`(签名钥
// keystore.properties)。生成后按打印的 scp 命令上传 VPS(APK 上传时改名带版本号)。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://zhujian.app/updates";
const fwd = (p) => p.replace(/\\/g, "/");

// ── 1. 安卓三处版本号必须一致(与桌面 gen-update-manifest.mjs 同一纪律,漂移即拒发) ──
const pkg = JSON.parse(readFileSync(join(root, "android/package.json"), "utf8")).version;
const conf = JSON.parse(
  readFileSync(join(root, "android/src-tauri/tauri.conf.json"), "utf8"),
).version;
const cargo = readFileSync(join(root, "android/src-tauri/Cargo.toml"), "utf8").match(
  /^version\s*=\s*"([^"]+)"/m,
)?.[1];
if (!(pkg === conf && conf === cargo)) {
  console.error(
    `版本号不一致:android/package.json=${pkg} tauri.conf.json=${conf} Cargo.toml=${cargo}`,
  );
  console.error("安卓发版前三处必须同步 bump(android-plan §8)。");
  process.exit(1);
}
const version = pkg;

// ── 2. versionCode 与 tauri 同公式(android/src-tauri/src/update.rs 同锚):
//        覆盖安装的硬闸(L2)= versionCode 单调递增,版本号只许往上走。 ──
const parts = version.split(".").map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
  console.error(`版本号「${version}」不是 x.y.z 三段数字。`);
  process.exit(1);
}
const versionCode = parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2];

// ── 3. APK 产物 ──
const apkPath = join(
  root,
  "android/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk",
);
if (!existsSync(apkPath)) {
  console.error(`找不到 APK:${fwd(apkPath)}`);
  console.error("先跑 `cd android && npx tauri android build --apk --target aarch64`。");
  process.exit(1);
}
const apkName = `zhujian_${version}_aarch64.apk`;

// ── 3.5 APK 本体必须真是本版:桌面脚本靠文件名带版本防「新旧并存拿错包」,安卓产物
//        名固定 app-universal-release.apk,该防护不存在——必须拆开验 versionCode,
//        否则清单说 2001、传上去的还是旧 2000,手机端陷入「提示→装→还是旧版→再提示」
//        死循环(107 审查抓出)。aapt 在 Android SDK build-tools 里(103 已用它核验过
//        备份 flags)。 ──
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) {
  console.error("未设 ANDROID_HOME/ANDROID_SDK_ROOT,找不到 aapt 来核验 APK 的 versionCode。");
  process.exit(1);
}
const btDir = join(sdk, "build-tools");
const bt = readdirSync(btDir).sort().at(-1);
const aapt = join(btDir, bt, process.platform === "win32" ? "aapt.exe" : "aapt");
const badging = execFileSync(aapt, ["dump", "badging", apkPath], { encoding: "utf8" });
const apkCode = badging.match(/versionCode='(\d+)'/)?.[1];
if (Number(apkCode) !== versionCode) {
  console.error(`APK 里的 versionCode=${apkCode},与本版预期 ${versionCode} 不符——是旧构建。`);
  console.error("先重新跑 `node scripts/build-android.mjs`(干净发版包)。");
  process.exit(1);
}

// ── 3.6 发版护栏(2026-07-14):APK 绝不能是带 devtools 的验收调试包(WebView 可被
//        任意调试=安全风险)。build-profile.json 由 scripts/build-android.mjs 构建时
//        写在产物旁,是构建来源的真相源:见 devtools:true 硬拒,缺标记=未走统一入口也拒
//        (这次翻车就是手动 --features devtools 构建后差点误发)。 ──
const profilePath = join(dirname(apkPath), "build-profile.json");
if (!existsSync(profilePath)) {
  console.error("产物旁没有 build-profile.json——无法确认这是不是干净发版包。");
  console.error("请用 `node scripts/build-android.mjs` 构建(它会写构建来源标记)。");
  process.exit(1);
}
const prof = JSON.parse(readFileSync(profilePath, "utf8"));
if (prof.devtools) {
  console.error("这是带 devtools 的验收调试包(WebView 可被任意调试),绝不能发版!");
  console.error("请用 `node scripts/build-android.mjs`(不带 --devtools)出干净包。");
  process.exit(1);
}
if (prof.versionCode !== versionCode) {
  console.error(
    `build-profile.json 的 versionCode=${prof.versionCode} 与本版 ${versionCode} 错配——重新构建。`,
  );
  process.exit(1);
}

// ── 4. 清单(字段与 update.rs::AndroidUpdate 逐键对应,versionCode 是比较轴) ──
const notes = process.argv[2] ?? `朱笺安卓版 v${version}`;
const manifest = {
  version,
  versionCode,
  notes,
  pub_date: new Date().toISOString(),
  url: `${BASE_URL}/${apkName}`,
};
const outPath = join(dirname(apkPath), "android.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`✔ 生成 ${fwd(outPath)}`);
console.log(`  版本 ${version} · versionCode ${versionCode} · APK ${apkName}`);
console.log("");
console.log("上传到 VPS(先清旧安卓包再传;APK 上传时改名带版本号):");
console.log('  ssh 69.63.208.74 "rm -f /var/www/zhujian-app/updates/zhujian_*_aarch64.apk"');
console.log(`  scp "${fwd(apkPath)}" 69.63.208.74:/var/www/zhujian-app/updates/${apkName}`);
console.log(`  scp "${fwd(outPath)}" 69.63.208.74:/var/www/zhujian-app/updates/`);
console.log(`  curl -s --noproxy "*" ${BASE_URL}/android.json   # 核验`);
