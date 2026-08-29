import { browser, expect } from "@wdio/globals";
import { SAMPLE_DIR, buildInjectable } from "./format-samples.js";

// 按需探针(桌面 / WebView2)——**量具,不是回归断言**。
// 跑法:`npx wdio run e2e/wdio.conf.js --spec e2e/probes/format-support.e2e.js --specFileRetries=0`
//
// **它回答的那一问**(backlog 用户面 56 第六节点名的「下一轮第一件事是量,不是写」):
// 后端 `core/src/images.rs::ALLOWED_MIME` 只认 png/jpeg/webp/gif 四种,而两端前端只看
// `image/*` 前缀放行 ⇒ 差出来的格式**前端放行、后端拒**,提示语还告诉用户「可在卡片编辑态
// 重新粘贴」——而那一刻字节已经没了。修法 ②「干脆别让它失败」= 解得开就当场重编码成 JPEG,
// **盖得住哪几种,取决于这个引擎解不解得开**,那一格此前只有推断。
//
// ⛔ **这支不进默认套件**(住 `e2e/probes/`,要 `--spec` 点名)。它不该变成回归网:
// 引擎版本一换读数就变,而**读数变化本身不是缺陷**。
//
// ⭐ **两头对照是这支探针能不能被引用的前提,写成了真断言**:
//   - 阳性:四种白名单格式必须 `ok` —— 不然是台架坏了,不是引擎不认;
//   - 阴性:`broken`(半截 PNG)必须 `err` —— 它证明这支探针**报得出** err。
//   ⛔ 主角那几行(heic/avif/bmp/tiff/svg)**刻意不断言**:量什么就是什么。
describe("探针 · 这个渲染引擎解得开哪些图片格式", () => {
  it("逐格式量:<img> 解码 / createImageBitmap / canvas 重编码成 JPEG", async () => {
    const { source, missing } = buildInjectable();

    // ⛔ 缺的样本要**响亮说缺**,别让它安静地从表里消失 —— 「没量到」被读成
    // 「量到了坏结果」正是用户面 56 那条账在修的病,量具自己先别犯。
    console.log(`\n样本目录:${SAMPLE_DIR}`);
    if (missing.length > 0) {
      console.log("⛔ 下面这几枚没量到(不是「解不开」,是根本没喂进去):");
      for (const m of missing) console.log(`   - ${m.key}:${m.why}\n     取它:${m.cmd}`);
    } else {
      console.log("✅ 第三方样本两枚都在,且 git blob sha 逐字节对得上。");
    }

    // ⭐ 注入的这段文本与安卓侧 `evalfile` 要跑的那份**出自同一个 buildInjectable()**
    // ⇒ 这一趟绿了,等于那份也验过了(⛔ 别在安卓侧另手写一份)。
    // 间接 eval ⇒ 落在**全局**作用域,且返回末句表达式的值(那个 Promise)。
    // 仓里 `tauri.conf.json` 的 `csp` 是 null,没有 unsafe-eval 那道坎。
    const r = await browser.executeAsync((src, done) => {
      try {
        (0, eval)(src).then(done, (e) => done({ error: String(e && e.stack ? e.stack : e) }));
      } catch (e) {
        done({ error: `eval 就炸了:${String(e && e.stack ? e.stack : e)}` });
      }
    }, source);

    // ⚠ 表要**先印**再断言:对照红了的时候,读数比那句 AssertionError 有用得多。
    if (r.error) console.log(`⛔ 注入体自己炸了:${r.error}`);
    expect(r.error).toBe(undefined);
    console.log(`\n引擎:${r.ua}\n文档:${r.href}\n`);
    console.log(
      "key     mime                       bytes  <img>  尺寸      bitmap        重编码           出字节",
    );
    for (const x of r.rows) {
      const size = x.img === "ok" ? `${x.w}×${x.h}` : "-";
      console.log(
        `${x.key.padEnd(7)} ${x.mime.padEnd(26)} ${String(x.bytes).padStart(6)}  ` +
          `${x.img.padEnd(6)} ${size.padEnd(9)} ${x.bitmap.padEnd(13)} ` +
          `${x.reenc.padEnd(16)} ${String(x.out || "-").padStart(6)}   ${x.note}`,
      );
    }
    console.log("");

    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    // 阳性对照:四种白名单格式解不开 = 台架坏了,整张表作废(不是「引擎不认」)。
    for (const k of ["png", "jpeg", "gif", "webp"]) {
      console.log(`对照(阳性)${k}:解码=${by[k].img} 重编码=${by[k].reenc}`);
      expect(by[k].img).toBe("ok");
      expect(by[k].reenc).toBe("image/jpeg");
    }
    // 阴性对照:它不红 ⇒ 这支探针报不出 err ⇒ 上面每一行 err 都是废的。
    console.log(`对照(阴性)broken:解码=${by.broken.img}(必须 err)\n`);
    expect(by.broken.img).toBe("err");
  });
});
