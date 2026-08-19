// 「这趟到底跑没跑、红没红」的判据 —— `flaky-hunt.mjs` 手里那把尺。
//
// **为什么单独住一个文件**:这把尺原本有两处 fail-open,而它偏偏是用来判「一支测试
// 是不是随机红」的 —— **尺读错了,会把「稳定红」判成「抖动」,或者把「压根没跑」判成
// 「不复现」**。两处都是本轮查实的(不是推的):
//   ① e2e 形:`res.status === 0 && !sawFailed`,而红的字据只有两个记号(`FAILED in`
//      与 `✖`)⇒ **记号认不出就等于没红**。两个记号今天真的还在(wdio 9.28.0 实测,
//      样本在 check-test-verdict.mjs),但 wdio 哪天换掉输出格式,这把尺会**安静地报绿**
//      —— 与 416 那道签名闸方向**相反**(那道读不出是拒发)。
//   ② cargo 形:只看退出码,而 **libtest 一只测试都没跑也退 0**:
//      `--exact` 名字拼错一个字母 ⇒ `test result: ok. 0 passed; 0 failed; … 961 filtered out`
//      退出码 **0**(2026-08-18 本机 core 测试二进制实测)⇒ `single` 形会一路印
//      「轮 12/12 …=12/12」、汇总「一轮不红」,而它**一次都没跑过**。
//
// ⇒ 修法是**要正面字据**:跑手自己印的那行汇总必须读得出,且必须说「跑完了 · 零失败 ·
//    真跑了东西」。读不出就是读不出 —— 不许退回「那就算它绿吧」。
//
// 三态,不是两态(438 的 `BootSweep` 同形):
//   'green'    有正面字据说「跑完了且零失败」
//   'red'      有失败字据(退出码 / 记号 / 汇总里的失败数,**取或**)
//   'unknown'  **判不出** ⇒ 调用方按红处理,但**必须与 red 分开报** ——
//              把工装自己的故障记进某只用例的抖动账,正是这把尺骗人的另一种方式。
//
// ⛔ 别把 unknown 并进 green(那就是把 fail-open 原样搬回来),也别并进 red
//    (那会往「谁在抖」的汇总里塞假账)。

/**
 * 判一趟 wdio 跑的结果。
 * @param {string} out  stdout + stderr 全文
 * @param {number|null} status  spawnSync 的退出码(被杀 / 超时是 null)
 * @returns {{state:'green'|'red'|'unknown', why:string, counts:Record<string,number>}}
 */
export function wdioVerdict(out, status) {
  const text = String(out ?? '');

  // 正面字据:wdio 每趟收尾必印的那行。形(9.28.0 实测原文,注意是制表符):
  //   `Spec Files:\t 39 passed, 39 total (100% completed) in 00:10:11`
  //   `Spec Files:\t 0 passed, 1 failed, 1 total (100% completed) in 00:00:12`
  const m = text.match(/^Spec Files:\s*([^(]*?)\s*\((\d+)% completed\)/m);
  const counts = {};
  if (m) for (const c of m[1].matchAll(/(\d+)\s+([a-z]+)/gi)) counts[c[2].toLowerCase()] = Number(c[1]);
  const pct = m ? Number(m[2]) : null;

  // 红的字据取或 —— 哪天再冒出别的「吸收」机制(retry / 容忍阈值),退出码会骗人,
  // 而这几处不会。⚠ 记号认不出**不再**等于没红,那半交给下面的 unknown。
  const red = [];
  if (status === null) red.push('跑手没有正常退出(被杀 / 超时)');
  else if (status !== 0) red.push(`退出码 ${status}`);
  if (/\bFAILED in\b/.test(text)) red.push('输出里有「FAILED in」');
  if (/[✖✗×]\s+\S/.test(text)) red.push('输出里有「✖」用例标记');
  if (counts.failed > 0) red.push(`汇总说 ${counts.failed} 个 spec 红`);
  if (red.length) return { state: 'red', why: red.join(' · '), counts };

  // 到这儿为止「没有任何失败字据」——**这还不够**,得有正面字据。
  if (!m) {
    return {
      state: 'unknown',
      why: '找不到 wdio 的「Spec Files: …(N% completed)」汇总行 —— 要么这趟没跑到底,要么 wdio 换了输出格式(那这把尺当场作废,别报绿)',
      counts,
    };
  }
  if (pct !== 100) return { state: 'unknown', why: `汇总说只跑完 ${pct}%`, counts };
  if (!counts.total) return { state: 'unknown', why: '汇总说一个 spec 都没跑(--spec 匹配到 0 个?)', counts };
  // ⛔ 刻意**不猜** `skipped` 那一格长什么样:本机没量到过带跳过的真实汇总,照着猜写
  //    就把样本从「量到的」改成「编的」(416 那条纪律)。对不上 ⇒ unknown(响亮),不是 green。
  if (counts.passed !== counts.total) {
    return {
      state: 'unknown',
      why: `汇总自相矛盾或有没数清的格:${m[1]}(passed ${counts.passed ?? '?'} ≠ total ${counts.total})`,
      counts,
    };
  }
  return { state: 'green', why: `${counts.total} 个 spec 全过`, counts };
}

/**
 * 判一趟 libtest(cargo test 二进制)的结果。
 * @param {string} out  stdout + stderr 全文
 * @param {number|null} status  spawnSync 的退出码(被杀 / 超时是 null)
 * @returns {{state:'green'|'red'|'unknown', why:string, counts:Record<string,number>}}
 */
export function libtestVerdict(out, status) {
  const text = String(out ?? '');

  // 形(2026-08-18 本机 rustc --test 实测原文):
  //   `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s`
  //   `test result: FAILED. 1 passed; 1 failed; …`
  // 收**全部**行再聚合:一个二进制今天只印一行,但多印一行时漏掉后面那行 = 漏红。
  const lines = [...text.matchAll(/^test result:\s*(ok|FAILED)\.\s*(.*)$/gm)];
  const counts = { passed: 0, failed: 0, ignored: 0, filtered: 0 };
  let anyFailedWord = false;
  for (const l of lines) {
    if (l[1] === 'FAILED') anyFailedWord = true;
    const seg = l[2];
    counts.passed += num(seg, /(\d+)\s+passed/);
    counts.failed += num(seg, /(\d+)\s+failed/);
    counts.ignored += num(seg, /(\d+)\s+ignored/);
    counts.filtered += num(seg, /(\d+)\s+filtered out/);
  }

  const red = [];
  if (status === null) red.push('跑手没有正常退出(被杀 / 超时)');
  else if (status !== 0) red.push(`退出码 ${status}`);
  if (anyFailedWord) red.push('输出里有「test result: FAILED.」');
  if (counts.failed > 0) red.push(`汇总说 ${counts.failed} 只测试红`);
  if (red.length) return { state: 'red', why: red.join(' · '), counts };

  if (lines.length === 0) {
    return { state: 'unknown', why: '找不到「test result: …」那行 —— 这趟根本没跑起来,或 libtest 换了输出格式', counts };
  }
  // ⭐ 这一条就是 ②:**退 0 且零失败,但一只都没跑**。`single` 形拼错名字恒走这里。
  if (counts.passed === 0) {
    return {
      state: 'unknown',
      why: `一只测试都没跑(ignored ${counts.ignored} · filtered out ${counts.filtered})—— 测试名拼错了?退出码 0 在这里什么都不证明`,
      counts,
    };
  }
  return { state: 'green', why: `${counts.passed} 只全过`, counts };
}

function num(s, re) {
  const m = String(s).match(re);
  return m ? Number(m[1]) : 0;
}
