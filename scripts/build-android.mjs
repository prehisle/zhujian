// 安卓构建统一入口(2026-07-14)——把「发版干净包」与「验收 devtools 调试包」分成
// 两条明确路径,堵死两个坑:
//   ① 误发 devtools 包:产物旁写 build-profile.json 作构建来源标记,
//      gen-android-update-manifest.mjs 见到 devtools:true 硬拒发版。
//   ② 干净包备份被 gradle clean 清掉(2026-07-14 翻过一次):干净包统一复制到
//      构建目录外的 android/apk-out/(gitignore),下次 gradle clean 清不到。
//
// devtools feature = WebView 远程调试(Chrome DevTools 协议),只给真机 UI 验收用
// (见 scripts/android-cdp.mjs);发版包绝不能带(WebView 可被任意调试是安全风险)。
//
// 用法:
//   node scripts/build-android.mjs            # 干净发版包(默认,不带 devtools)
//   node scripts/build-android.mjs --devtools # 验收调试包(WebView 远程可调试)
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devtools = process.argv.includes("--devtools");

// ── 1. 三处版本号一致(与 gen-android-update-manifest.mjs 同锚,构建前先拦) ──
const pkg = JSON.parse(readFileSync(join(root, "android/package.json"), "utf8")).version;
const conf = JSON.parse(
  readFileSync(join(root, "android/src-tauri/tauri.conf.json"), "utf8"),
).version;
const cargo = readFileSync(join(root, "android/src-tauri/Cargo.toml"), "utf8").match(
  /^version\s*=\s*"([^"]+)"/m,
)?.[1];
if (!(pkg === conf && conf === cargo)) {
  console.error(`版本号不一致:package.json=${pkg} tauri.conf.json=${conf} Cargo.toml=${cargo}`);
  console.error("安卓发版前三处必须同步 bump(android-plan §8)。");
  process.exit(1);
}
const version = pkg;
const parts = version.split(".").map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
  console.error(`版本号「${version}」不是 x.y.z 三段数字。`);
  process.exit(1);
}
const versionCode = parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2];

// ── 2. 构建 ──
console.log(
  `构建安卓${devtools ? "验收调试包(devtools)" : "发版干净包"} v${version} / versionCode ${versionCode}…`,
);
const args = ["tauri", "android", "build", "--apk", "--target", "aarch64"];
if (devtools) args.push("--features", "devtools");
execFileSync("npx", args, { cwd: join(root, "android"), stdio: "inherit", shell: true });

// ── 3. aapt 验产物 versionCode(与 gen 脚本同一 aapt 定位) ──
const apkDir = join(
  root,
  "android/src-tauri/gen/android/app/build/outputs/apk/universal/release",
);
const apkPath = join(apkDir, "app-universal-release.apk");
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) {
  console.error("未设 ANDROID_HOME/ANDROID_SDK_ROOT,找不到 aapt 核验 APK。");
  process.exit(1);
}
const btDir = join(sdk, "build-tools");
const bt = readdirSync(btDir).sort().at(-1);
const aapt = join(btDir, bt, process.platform === "win32" ? "aapt.exe" : "aapt");
const badging = execFileSync(aapt, ["dump", "badging", apkPath], { encoding: "utf8" });
const apkCode = badging.match(/versionCode='(\d+)'/)?.[1];
if (Number(apkCode) !== versionCode) {
  console.error(`APK versionCode=${apkCode} 与预期 ${versionCode} 不符——构建异常。`);
  process.exit(1);
}

// ── 4. 产物旁写构建来源标记(发版护栏的真相源) ──
const profile = { profile: devtools ? "devtools" : "release", devtools, version, versionCode };
writeFileSync(join(apkDir, "build-profile.json"), JSON.stringify(profile, null, 2) + "\n");

// ── 5. 干净包复制到构建目录外(gradle clean 清不到;发版从这里取) ──
if (!devtools) {
  const outDir = join(root, "android/apk-out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outApk = join(outDir, `zhujian_${version}_aarch64.apk`);
  copyFileSync(apkPath, outApk);
  writeFileSync(join(outDir, "build-profile.json"), JSON.stringify(profile, null, 2) + "\n");
  console.log(`\n✔ 干净发版包已就位:`);
  console.log(`  产物 ${apkPath}`);
  console.log(`  副本 ${outApk}(构建目录外,gradle clean 清不到)`);
  console.log(`  下一步:node scripts/gen-android-update-manifest.mjs "更新说明"`);
} else {
  console.log(`\n✔ 验收调试包已就位(WebView 远程可调试):`);
  console.log(`  ${apkPath}`);
  console.log(`  装机后:adb install -r <apk> → node scripts/android-cdp.mjs forward`);
  console.log(`  ⚠ 此包带 devtools,gen-android-update-manifest.mjs 会拒绝用它发版。`);
}
