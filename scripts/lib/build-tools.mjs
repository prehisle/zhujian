// Android SDK `build-tools/` 底下挑「用哪一版」的那把尺。
//
// **为什么单独住一个文件**:两处调用点(scripts/build-android.mjs 的 aapt 核 versionCode、
// scripts/gen-android-update-manifest.mjs 的 aapt + apksigner 签名证书闸)原本各写一句
// `readdirSync(btDir).sort().at(-1)` —— **字典序**。今天 `35.0.1 < 36.0.0` 侥幸对,但:
//   · `35.0.9` 与 `35.0.10` 并存 ⇒ 字典序挑 **35.0.9**(比 '9' 与 '1',第一位就分胜负);
//   · `36.0.0` 与 `36.0.0-rc1` 并存 ⇒ 字典序挑 **rc**(前缀相同时长的赢);
//   · 主版本进到三位数(`100.x`)⇒ 字典序挑 **36**。
//
// ⚠ **挑错不一定报错**,可能只是换了一版工具、换了输出格式 —— 那正是 416 栽的那个病:
// 签名证书闸把 signer 那行的头写死成 build-tools 35 的形,CI 装的是 36,**这道闸在真 CI 上
// 第一次执行就读不到指纹、拒发**。⇒ 「解析外部工具输出」的地方,先得保证**解析的是哪一版
// 工具**这件事本身是确定的。发版闸尤其危险:它们平时不跑,红的时候你正在发版。
// 来源:backlog「测试与工装 16①」。
//
// ⚠ 这个函数被两处调用点与 scripts/check-build-tools-pick.mjs **共用同一份** ——
// 后者压的就是上面那三种挑错,别把逻辑再抄一遍(抄一遍就成了自指的空测,292 判例)。

/** `M.m.p` 或 `M.m.p-<预览后缀>`;两处调用点见到的目录名一律是这个形。 */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/**
 * 从 `build-tools/` 的目录项里挑出该用的那一版。
 *
 * 判据(逐条都有阴性对照钉在 check-build-tools-pick.mjs 里):
 *  1. **按数字段比**,不是字典序 —— `35.0.10 > 35.0.9`、`100.0.0 > 36.0.0`。
 *  2. 数字段相同时 **正式版赢预览版**(semver 那条:`36.0.0 > 36.0.0-rc1`)——
 *     预览版正是"输出格式会变"的高发地,发版闸不该被它选中。
 *  3. 认不出的目录项(`source.properties` / `.DS_Store` / 半截下载)**不挑、但要报出来**,
 *     ⛔ 不许静默吞掉(438 那条纪律:改的不是行为,是"有没有人知道")。
 *  4. 一个都认不出 ⇒ 回 `name: null`,**调用方必须 fail-closed 拒**(416 判例)。
 *
 * @param {string[]} names `readdirSync(join(sdk, "build-tools"))` 的原样返回
 * @returns {{name: string|null, prerelease: boolean, skipped: string[]}}
 */
export function pickBuildTools(names) {
  const skipped = [];
  const parsed = [];
  for (const raw of names ?? []) {
    const name = String(raw);
    const m = VERSION.exec(name);
    if (!m) {
      skipped.push(name);
      continue;
    }
    parsed.push({
      name,
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      // 无后缀 = 正式版。用 1/0 而不是布尔,是为了下面那句比较能直接相减。
      stable: m[4] === undefined ? 1 : 0,
      suffix: m[4] ?? "",
    });
  }
  parsed.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return b.nums[i] - a.nums[i];
    if (a.stable !== b.stable) return b.stable - a.stable;
    // 同号同为预览版:按后缀倒字典序,只为**结果确定**(rc2 > rc1 在这里恰好也对)。
    return b.suffix < a.suffix ? -1 : b.suffix > a.suffix ? 1 : 0;
  });
  const best = parsed[0];
  return {
    name: best ? best.name : null,
    prerelease: best ? best.stable === 0 : false,
    skipped,
  };
}

/**
 * 两处调用点共用的那段话 —— 把「挑了谁 / 跳过了谁 / 它是不是预览版」如实说出来。
 * ⛔ 别把它改成只在出事时才说:发版日志里那一行「用的是哪一版工具」,正是 416 复盘时
 * 想找却找不到的东西。
 * @param {{name: string|null, prerelease: boolean, skipped: string[]}} pick
 * @returns {string[]} 逐行的人话,调用方自己决定往 stdout 还是 stderr 印
 */
export function describeBuildToolsPick(pick) {
  const lines = [];
  if (pick.name) lines.push(`build-tools:挑中 ${pick.name}${pick.prerelease ? "(⚠ 预览版——它的输出格式可能与正式版不同)" : ""}`);
  if (pick.skipped.length) lines.push(`build-tools:认不出版本号、已跳过 ${pick.skipped.length} 项:${pick.skipped.join(", ")}`);
  return lines;
}
