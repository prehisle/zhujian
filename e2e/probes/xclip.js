// Linux(X11)真剪贴板 IO —— 两支 Linux 探针共用。Windows 那边这一层是两个 `.ps1`
// (`set-clipboard.ps1` / `get-clipboard-image.ps1`),Linux 侧每个动作都是一条 `xclip`,
// 故直接收成这个模块,不另起 shell 脚本。
//
// ⛔ **四条实测坑焊在这里(415),照 Windows 那支的形硬套会拿到假绿、或者当场挂死**:
//  ①剪贴板上是**文字**时,`xclip -selection clipboard -t image/png -o` 竟然 **exit 0 并把
//    那段文字原样吐出来** —— 它不按 target 过滤。⇒ **判据必须先读 `TARGETS`**,永远不能拿
//    「读图这条命令成功了」当「剪贴板上有图」。(Windows 的 `Clipboard::GetImage()` 没这个坑,
//    所以那边的形不能直接抄。)
//  ②X11 **没有「清空剪贴板」这个原语**:选区是归 owner 进程所有的,`printf '' | xclip` 只是
//    把它换成一段**空文本**(`TARGETS` 里仍有 `UTF8_STRING`)。真正的空 = **压根没有 owner**,
//    ⇒ 清空 = 杀掉 xclip;此后三种读法一律 exit 1(`target … not available`)。
//    这才是 Windows `Clipboard::Clear()` 的对应物。
//  ③⛔ **写剪贴板不能捕获它的输出,否则整个跑手当场卡死**:`xclip -i` 读完输入会 **fork 常驻**
//    当 owner,子进程把继承来的 stdout/stderr **一直攥着**不放 ⇒ `execFileSync` 那种「等管子
//    EOF」的同步调用要等到选区易主才返回。实测:留任意一根管子 = 卡到超时(415 头一趟探针
//    就是这么挂的,600 秒没跑完一个用例);`stdio: "ignore"` 全关 = **22ms 返回**。
//    ⚠ 连带一条:**别用 `spawn` + 异步 `stdin.end()` 再接同步轮询** —— 事件循环没机会 flush,
//    数据永远写不出去,现象是「命令看着成功、剪贴板读回空」(第二次实测撞到)。用
//    `spawnSync` 的 `input` 选项,它是同步喂的。
//  ④**读**没有这个问题:`xclip -o` 打完就退,照常捕获 stdout 即可(14-22ms)。
//
// ⭐ 因为③把 stderr 也关掉了,退出码几乎是唯一信号 —— 所以每个写动作**都回头验一次效果**
// (`TARGETS` 里真出现了期望的那一项),而不是信那个 0。验效果比验返回码硬。
//
// ⚠ 这一层会**真的改写本机剪贴板**(用户手上复制的东西会没)—— 与 Windows 那两支同一个
// 取舍,故同样住 `e2e/probes/`、刻意不进默认套件。
import { spawnSync } from "node:child_process";

const SEL = ["-selection", "clipboard"];

/** 剪贴板当前提供的 target 列表;**没有 owner(真空)时回空数组**,不抛。 */
export function clipboardTargets() {
  const r = spawnSync("xclip", [...SEL, "-t", "TARGETS", "-o"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return [];
  return r.stdout.trim().split("\n").filter(Boolean);
}

/** 写完回头验:等到 `TARGETS` 里出现 `want` 为止(坑③把 stderr 关了,退出码不足以当字据)。 */
function settle(want, what) {
  for (let i = 0; i < 30; i++) {
    if (clipboardTargets().includes(want)) return;
    spawnSync("sleep", ["0.1"]);
  }
  throw new Error(`xclip 写完 3 秒了,剪贴板上还是没有 ${want}(${what});TARGETS=${clipboardTargets()}`);
}

/** 把一张 PNG 放上剪贴板(xclip fork 常驻当 owner)。 */
export function setClipboardImage(pngPath) {
  const r = spawnSync("xclip", [...SEL, "-t", "image/png", "-i", pngPath], {
    stdio: "ignore", // ← 坑③:一根管子都不能留
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error(`xclip 写图失败(status=${r.status}, error=${r.error?.code})`);
  settle("image/png", pngPath);
  return `image ← ${pngPath}`;
}

/** 把一段文字放上剪贴板。 */
export function setClipboardText(text) {
  const r = spawnSync("xclip", SEL, {
    input: text, // ← 坑③的连带:同步喂 stdin,别用异步 spawn
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error(`xclip 写文字失败(status=${r.status}, error=${r.error?.code})`);
  settle("UTF8_STRING", text);
  return `text ← ${text}`;
}

/** 真清空 = 让选区**无主**(见上面坑②)。
 *  ⛔ **别假设 owner 就是 xclip**(415 实测撞到):app 自己按 Ctrl+C 复制过之后,占着选区的是
 *  **app 里的 arboard**,`pkill -x xclip` 一点用没有。⇒ 通用做法是**先抢再杀**:用 xclip 把
 *  选区抢过来(原 owner 当场失去它),再杀掉 xclip ⇒ 谁都不占了 = 真空。
 *  ⛔ 按**进程名**杀(`-x`),别用 `pkill -f`:模式串也在自己这条命令行里,会当场自杀。 */
export function clearClipboard() {
  for (let round = 0; round < 3; round++) {
    spawnSync("pkill", ["-x", "xclip"]);
    for (let i = 0; i < 10; i++) {
      if (clipboardTargets().length === 0) return "empty(unowned)";
      spawnSync("sleep", ["0.1"]);
    }
    // 还有人占着 ⇒ 那不是我们起的 xclip(多半是 app 的 arboard):抢过来,下一轮把它杀掉。
    spawnSync("xclip", SEL, { input: "", stdio: ["pipe", "ignore", "ignore"], timeout: 10000 });
  }
  throw new Error(`清了三轮,选区还有人占着:TARGETS=${clipboardTargets()}`);
}

/** 剪贴板上那张图的尺寸,形如 `image 37x21`;没有图回 `"none"`。
 *  尺寸直接从 PNG 的 IHDR 读(不引任何图像库):8 字节签名 + 4 长度 + 4 "IHDR",宽高各 4 字节 BE。 */
export function clipboardImage() {
  if (!clipboardTargets().includes("image/png")) return "none"; // ← 坑①:先看 TARGETS
  const r = spawnSync("xclip", [...SEL, "-t", "image/png", "-o"], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error(`TARGETS 里有 image/png,读出来却失败(status=${r.status})`);
  const buf = r.stdout;
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47)
    throw new Error(`剪贴板上那份 image/png 不是 PNG(前 4 字节 ${buf.subarray(0, 4).toString("hex")})`);
  if (buf.toString("latin1", 12, 16) !== "IHDR")
    throw new Error("PNG 第一个块不是 IHDR,读不出尺寸");
  return `image ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}
