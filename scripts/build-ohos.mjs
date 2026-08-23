// 朱简鸿蒙端构建入口(OH-c/C3)——「前端 → Rust .so → HAP」三步一条龙。
//
// ⭐ **为什么不走 tauri CLI**:`cargo tauri ohos` 那套今天还在 Eclipse Oniro 手里做,
// 而朱简的鸿蒙工程本来就是**手写 `gen/ohos/`**(照 `android/` 的形)。460 已证实
// 「手写 gen 目录 + hvigorw assembleHap」这条路全程走得通、且不必开 DevEco 图形界面。
//
// ⛔ **本机路径一律走环境变量,不写死进仓**(memory `memory-scope-repo-vs-machine`):
// 缺哪个就当场响亮说缺哪个,别猜、别找默认值。台架配方(SDK 落点 / 包装器 / 四个
// 环境变量)在 memory `zhujian-ohos-feasibility-2026-07-17`。
//
//   必需:
//     OHOS_NDK_HOME                                   例 G:\ohos-sdk\native
//     DEVECO_HOME                                     例 F:\Program Files\Huawei\DevEco Studio
//     CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER  例 G:\ohos-sdk\wrappers\aarch64-ohos-clang.bat
//     CC_aarch64_unknown_linux_ohos / CXX_… / AR_…    同上族
//
// 签名:仓里那份 `build-profile.json5` 恒是**未签名形**。本机把签名段放进
// `ohos/src-tauri/gen/ohos/signing.local.json5`(gitignore),本脚本构建期临时注进去、
// 结束原样还回。⚠ **未签名 HAP 装不进纯血鸿蒙**(`not trusted app source`),那是
// 平台规矩不是故障。
//
// 用法:node scripts/build-ohos.mjs [--skip-frontend] [--skip-cargo] [--c4]
//
// ⚠ `--c4` = 带上 `c4-harness` feature 编(C4 真机验收那批命令)。**默认不带**:
// 那批里有 `c4_plant`(往数据目录里放半截文件)与明文回报备份码,做成运行期开关
// 迟早有人忘在生产包里,做成 feature 则「忘了关」在产物里根本不存在(判据同 433
// 在安卓那边立的编译期故障注入先例)。⛔ 别为了省事把它改成默认开。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ohosRoot = join(repoRoot, "ohos");
const crateDir = join(ohosRoot, "src-tauri");
const hapProject = join(crateDir, "gen", "ohos");
const argv = process.argv.slice(2);

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

// ---- 环境 ------------------------------------------------------------------

const need = (name) => process.env[name] ?? die(`环境变量 ${name} 没设 —— 台架配方见 memory zhujian-ohos-feasibility-2026-07-17`);
const devecoHome = need("DEVECO_HOME");
need("OHOS_NDK_HOME");
need("CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER");

// ⚠ Git Bash 上从 node 起 `.bat` 只有一种可用形:**绝对路径 + shell:true**
// (memory `gradle-bat-from-node-on-git-bash`)——两种自然写法都静默失败成假红。
const hvigorw = join(devecoHome, "tools", "hvigor", "bin", "hvigorw.bat");
const ohpm = join(devecoHome, "tools", "ohpm", "bin", "ohpm.bat");
for (const [name, p] of [["hvigorw", hvigorw], ["ohpm", ohpm]]) {
  if (!existsSync(p)) die(`找不到 ${name}:${p}(DEVECO_HOME 指对了吗)`);
}
const devecoEnv = {
  ...process.env,
  DEVECO_SDK_HOME: join(devecoHome, "sdk"),
  OHOS_BASE_SDK_HOME: join(devecoHome, "sdk", "default", "openharmony"),
  NODE_HOME: join(devecoHome, "tools", "node"),
  PATH: [
    join(devecoHome, "tools", "node"),
    join(devecoHome, "tools", "ohpm", "bin"),
    join(devecoHome, "tools", "hvigor", "bin"),
    process.env.PATH,
  ].join(";"),
};

const run = (label, cmd, args, opts = {}) => {
  // ⚠ `shell: true` 下带空格的可执行文件路径**必须自己加引号**(DevEco 装在
  // `F:\Program Files\…`)——不加会被 cmd 从第一个空格切开,报的是
  // 「'F:\Program' 不是内部或外部命令」,与「找不到 DevEco」长得完全不像。
  const quoted = cmd.includes(" ") ? `"${cmd}"` : cmd;
  console.log(`\n── ${label}\n   ${quoted} ${args.join(" ")}`);
  const r = spawnSync(quoted, args, { stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) die(`${label} 失败(退出码 ${r.status ?? r.signal})`);
};

// ---- 1. 前端 ---------------------------------------------------------------

// ⛔⛔ **`--skip-cargo` 会连前端一起跳过,哪怕这一步真的重跑了 vite** ——
// `--features tauri/custom-protocol` 下前端产物是**在 cargo 编译期烤进 `.so`** 的
// (`generate_context!` 把 `dist/` 整个嵌进二进制),`dist/` 更新了而 cargo 不重编
// = 装到机器上的还是上一版页面。**它不报错,只是给你一个旧界面**(2026-08-23 真栽:
// 改完版式 `--skip-cargo` 重打包,截图与改之前逐像素一样,查了半天才想起这条)。
// ⇒ **动了前端就别带 `--skip-cargo`**(OH-d/D3 起「前端」= 共用那棵树 `android/index.html`
//    + `android/src/`,不再只是 `ohos/src/`)。
//
// ⭐ **`--c4` 同时决定前端出哪一页**(OH-d/D3):`ZJ_OHOS_C4=1` 让 `ohos/vite.config.ts`
// 把 root 从共用那棵树切回 `ohos/`,出的是验收面板。⇒ 验收命令面(`c4-harness` feature)
// 与验收按钮**成对出现、成对消失**,⛔ 不会有「包里有后门命令但没按钮」或反过来的半态。
if (!argv.includes("--skip-frontend")) {
  run("前端 vite build", "npm", ["run", "build"], {
    cwd: ohosRoot,
    env: { ...process.env, ZJ_OHOS_C4: argv.includes("--c4") ? "1" : "" },
  });
}

// ---- 2. Rust .so -----------------------------------------------------------

const TRIPLE = "aarch64-unknown-linux-ohos";
const soName = "libzhujian_ohos_lib.so";
const soPath = join(crateDir, "target", TRIPLE, "release", soName);
const startedAt = Date.now();

const withC4 = argv.includes("--c4");
if (withC4) {
  console.log(`\n⚠⚠ 本趟带 **c4-harness** 验收命令面 —— 出来的是验收包,不是正式包。`);
}

if (!argv.includes("--skip-cargo")) {
  // ⚠ `--features tauri/custom-protocol` 不能省:dev/prod 由 `dev = !custom-protocol`
  // 这个 feature 决定,平时靠 tauri CLI 代传;手编不带它,装到设备上的包会去连
  // localhost:1420(白屏,且不报错)。
  const features = withC4 ? "tauri/custom-protocol,c4-harness" : "tauri/custom-protocol";
  run(
    `cargo build(aarch64-ohos, release${withC4 ? " + c4-harness" : ""})`,
    "cargo",
    ["build", "--lib", "--release", "--target", TRIPLE, "--features", features],
    { cwd: crateDir },
  );
}
if (!existsSync(soPath)) die(`没有产物:${soPath}`);
// 产物鲜度自证(memory `verify-artifact-predates-fix`):⛔ 这不是「必须重编」——
// Rust 一个字没动时 cargo 不重编正是对的答案;这里只是把读数摆出来让人自己判。
const soAgeS = Math.round((statSync(soPath).mtimeMs - startedAt) / 1000);
const freshness = soAgeS >= 0 ? `本次重编(开跑后 ${soAgeS}s 落盘)` : `**沿用旧产物**(比本次开跑早 ${-soAgeS}s)`;
console.log(`\n   ${soName}:${(statSync(soPath).size / 1048576).toFixed(1)} MB,${freshness}`);

const libsDir = join(hapProject, "entry", "libs", "arm64-v8a");
mkdirSync(libsDir, { recursive: true });
copyFileSync(soPath, join(libsDir, soName));
console.log(`   → ${join(libsDir, soName)}`);

// ---- 3. 签名段(有就临时注入,没有就响亮说清后果)---------------------------

const profilePath = join(hapProject, "build-profile.json5");
const localSigning = join(hapProject, "signing.local.json5");
const appScopePath = join(hapProject, "AppScope", "app.json5");
const originalProfile = readFileSync(profilePath, "utf8");
const originalAppScope = readFileSync(appScopePath, "utf8");
let signed = false;

// ⛔⛔ **还原必须挂在 `process.on("exit")` 上,不能只靠 `finally`** —— 这是踩出来的:
// `die()` 走的是 `process.exit(1)`,而 **`process.exit` 不跑 `finally`**。第一次
// hvigor 失败时,签名材料(证书路径 + DevEco 加密口令)就这么留在了工作区里,
// 而 `build-profile.json5` 是 **tracked** 文件 ⇒ 一次 `git add -A` 就提交进仓、
// 再随 `sync-public` 推上**公开仓**。
// ⭐ 判据可直接套用:**凡是「临时改一个 tracked 文件」的脚本,还原点要挂在进程退出上,
// 别挂在控制流上** —— 控制流有 `process.exit` / 未捕获异常 / 信号三条绕过它的路。
let patchedFiles = false;
process.on("exit", () => {
  if (!patchedFiles) return;
  writeFileSync(profilePath, originalProfile);
  writeFileSync(appScopePath, originalAppScope);
});

if (existsSync(localSigning)) {
  // json5 里有注释与尾逗号 ⇒ 不能用 JSON.parse;这里只做**文本级**替换,替换点是
  // 仓里那份自己写死的两个锚,替换不中就当场死(⛔ 别静默出一个没签名的包)。
  // ⚠ 两个锚都写成对行尾免疫的正则:仓里这份是 LF,但经 git autocrlf 检出可能是 CRLF,
  // 而「锚匹配不中」在这条路上会被 die 挡住 —— 挡住是对的,但为一个行尾字符挡住是白挡。
  const local = readFileSync(localSigning, "utf8").trim();
  const anchor = /"signingConfigs":\s*\[\],/;
  if (!anchor.test(originalProfile)) die('build-profile.json5 里找不到 "signingConfigs": [], —— 仓里那份被改过?');
  let patched = originalProfile.replace(anchor, `"signingConfigs": ${local},`);
  const prodAnchor = /("name":\s*"default",\r?\n\s*)("compatibleSdkVersion")/;
  if (!prodAnchor.test(patched)) die("build-profile.json5 里找不到 products 锚 —— 仓里那份被改过?");
  patched = patched.replace(prodAnchor, '$1"signingConfig": "default",\n        $2');
  patchedFiles = true; // ⚠ 先置位再落盘:置位晚一行,中间崩掉就还原不了。
  writeFileSync(profilePath, patched);
  signed = true;
  console.log(`\n── 签名段已临时注入(来源 signing.local.json5)`);

  // ⚠ debug profile **绑 bundleName**。本机那份若绑的不是 app.zhujian.notebook,
  // 在 signing.local.json5 旁边放一个 bundle-name.local.txt 写上要用的名字,
  // 本脚本临时改 AppScope/app.json5 —— 仓里那份永远是真身份。
  const bundleOverride = join(hapProject, "bundle-name.local.txt");
  if (existsSync(bundleOverride)) {
    const name = readFileSync(bundleOverride, "utf8").trim();
    const before = originalAppScope;
    const after = before.replace(/"bundleName":\s*"[^"]*"/, `"bundleName": "${name}"`);
    if (after === before) die("AppScope/app.json5 里找不到 bundleName —— 仓里那份被改过?");
    writeFileSync(appScopePath, after);
    console.log(`   ⚠ bundleName 临时改成 ${name}(仓里那份仍是 app.zhujian.notebook)`);
  }
} else {
  console.log(`\n── ⚠ 没有 signing.local.json5 ⇒ 出的是 **unsigned HAP**`);
  console.log(`   纯血鸿蒙默认不允许侧载,未签名包装机会报 not trusted app source。`);
}

// ---- 4. 依赖:⛔ ohpm 必须在仓外跑,这不是洁癖 -----------------------------
//
// **现象**:在 `G:\yj2026\zhujian\` 里跑 `ohpm install`,**确定性**失败于
//   `EPERM: operation not permitted, rename '…/@ohos-rs/ability.<pid>.<n>' -> '…/@ohos-rs/ability'`
// 同一条命令在仓外一次就过。三格分诊已做:①仓外 OK / 仓内失败;②与**路径深度无关**
// (仓根下建一个浅目录同样失败);③普通目录改名在仓内是好的 ⇒ 不是权限、不是 MAX_PATH。
//
// **因**:仓根有一只 `vite` dev server(`npm run dev`)在跑,它的文件监视**递归**盯着
// 整个仓 —— 新建目录一出现就被按住,于是「解包到临时名 → 立刻 rename 就位」这个形踩空。
// 同族旁证:那期间 `rm -rf` 那个目录报的是 `Device or resource busy`。
// ⚠ 这与 CLAUDE.md 里 e2e 那条「跑动期间别在同一台机器上并行跑会抢焦点的命令」是同一族,
// 只是这次抢的不是焦点是**文件句柄**。
//
// **解**:在仓外的固定 scratch 目录里装,再**解引用**拷回来(ohpm 装出来的
// `entry/oh_modules/@ohos-rs/ability` 是指向 store 的符号链接,直接拷会得到一串
// 指向 scratch 的死链;`dereference: true` 把内容真拷过来)。
// ⛔ **别改成「让用户先关掉 dev server」** —— 那是把环境耦合写进流程,而 hvigor 本身
// 在同样的环境下打包是好的(实测),只有 ohpm 这一步踩。
// ⚠ scratch 用**固定名字**不是每次新建(memory `zhujian-test-tempdir-leak-cleanup`:
// 临时目录堆过两次,一次 30 GB)。

function ohpmInstallOutOfTree() {
  const scratch = join(tmpdir(), "zhujian-ohpm-scratch");
  console.log(`\n── ohpm install(仓外 scratch:${scratch};理由见本文件注释)`);
  mkdirSync(join(scratch, "entry"), { recursive: true });
  // ohpm 从 build-profile.json5 读模块清单,再各自读 oh-package.json5。
  copyFileSync(join(hapProject, "oh-package.json5"), join(scratch, "oh-package.json5"));
  copyFileSync(join(hapProject, "build-profile.json5"), join(scratch, "build-profile.json5"));
  copyFileSync(join(hapProject, "entry", "oh-package.json5"), join(scratch, "entry", "oh-package.json5"));
  run("ohpm install", ohpm, ["install"], { cwd: scratch, env: devecoEnv });
  for (const rel of [["oh_modules"], ["entry", "oh_modules"]]) {
    const from = join(scratch, ...rel);
    if (!existsSync(from)) continue;
    cpSync(from, join(hapProject, ...rel), { recursive: true, dereference: true, force: true });
  }
  for (const rel of [["oh-package-lock.json5"], ["entry", "oh-package-lock.json5"]]) {
    const from = join(scratch, ...rel);
    if (existsSync(from)) copyFileSync(from, join(hapProject, ...rel));
  }
  console.log(`   → oh_modules 已解引用拷回 ${hapProject}`);
}

// ---- 5. 打包 ---------------------------------------------------------------

try {
  ohpmInstallOutOfTree();
  run("hvigorw assembleHap", hvigorw, ["assembleHap", "--no-daemon"], { cwd: hapProject, env: devecoEnv });
} finally {
  // 正常路径上早点还原(退出钩子里那份是兜底,两处都要有:钩子挡的是 process.exit,
  // 这里挡的是「后面还有代码要跑,而它读到的应当已经是仓里那份」)。
  if (patchedFiles) {
    writeFileSync(profilePath, originalProfile);
    writeFileSync(appScopePath, originalAppScope);
    patchedFiles = false;
  }
}

const outDir = join(hapProject, "entry", "build", "default", "outputs", "default");
const hap = join(outDir, signed ? "entry-default-signed.hap" : "entry-default-unsigned.hap");
if (!existsSync(hap)) die(`打包说成功了,但没有产物:${hap}`);
console.log(`\n✔ HAP:${hap}`);
console.log(`   ${(statSync(hap).size / 1048576).toFixed(1)} MB · ${signed ? "已签名,可装机" : "未签名,装不进设备"}`);
if (signed) {
  console.log(`\n装机(MSYS_NO_PATHCONV=1 破 hdc 的远端路径转换坑):`);
  console.log(`   cd /g/ohos-sdk/toolchains && MSYS_NO_PATHCONV=1 ./hdc.exe file send '${hap}' /data/local/tmp/zj.hap`);
  console.log(`   MSYS_NO_PATHCONV=1 ./hdc.exe shell "bm install -p /data/local/tmp/zj.hap"`);
}
