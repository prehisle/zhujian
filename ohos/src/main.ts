// C4 验收页。⛔ **不是产品前端** —— 它只把每条复核面显成一个读数。
//
// ⭐ OH-d/D3 起产品前端是**共用的那棵树**(`android/index.html` + `android/src`),
// 由 `ohos/vite.config.ts` 的 root 决定用哪一份:带 `ZJ_OHOS_C4=1`(= `build-ohos.mjs --c4`)
// 出的才是这一页。**它与 Rust 侧的 `c4-harness` feature 成对** —— 验收命令面在哪一趟,
// 验收按钮就在哪一趟。⛔ 产品包里不许出现这一页(里头有 `c4_plant` 与明文回报备份码)。
import { invoke } from "@tauri-apps/api/core";

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`没有 #${id}`);
  return el;
};

const show = (id: string, value: unknown): void => {
  $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

// 失败一律原样摊开:骨架轮最怕的就是把「这条路没通」显示成一句和缓的空文案。
const run = async (id: string, task: () => Promise<unknown>): Promise<void> => {
  try {
    show(id, await task());
  } catch (e) {
    show(id, `失败:${e}`);
  }
};

// 启动闸:轮到不是 pending 为止。
// ⚠ **判别键是 `status` 不是 `state`**(OH-d/D1 起这条命令来自共享 crate,
// 那边的 `#[serde(tag = "status")]` 才是权威)——写错了它会永远轮询下去,不报错。
const pollGate = async (): Promise<void> => {
  for (;;) {
    try {
      const gate = (await invoke("startup_gate")) as { status: string };
      show("gate", gate);
      if (gate.status !== "pending") return;
    } catch (e) {
      show("gate", `失败:${e}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
};

$("paths-btn").addEventListener("click", () => void run("paths", () => invoke("ohos_paths")));
// ⚠ 这两条 OH-d/D1 起走的是**产品命令**(共享 crate 那 93 条里的两条),
// 不再是骨架轮那两条 `smoke_*` —— 那两条已删。⭐ 这样这一格验的是真路径,不是旁路。
$("capture-btn").addEventListener("click", () => {
  const content = ($("text") as HTMLInputElement).value.trim();
  void run("smoke", () => invoke("capture_idea", { spaceId: "main", content }));
});
$("inbox-btn").addEventListener("click", () =>
  void run("smoke", async () => {
    const rows = (await invoke("list_ideas", { spaceId: "main" })) as { content: string }[];
    return { count: rows.length, latest: rows[0]?.content ?? null };
  }),
);

// ---- C4 那批 -------------------------------------------------------------
//
// ⭐ **结论不从这个 <pre> 上读** —— 壳那边每条命令都把结论同时打进 hilog,PC 侧脚本
// 挂着实时 `hdc shell "hilog"` 收。屏幕这份是给人看的第二现场。
// ⚠ 但**失败**必须两边都有:命令不存在 / 参数名对不上这类错,壳那边根本没机会 log,
// 只有前端拿得到 ⇒ 这里 catch 到就**原样**写进 <pre>,并且再 `console.error` 一次
// (ArkWeb 的 console 也进 hilog,于是脚本那边同样看得见)。
const c4 = (btn: string, label: string, task: () => Promise<unknown>): void => {
  $(btn).addEventListener("click", () => {
    void (async () => {
      show("c4-out", `${label} 跑着…`);
      try {
        const out = await task();
        show("c4-out", `${label} 好了\n${JSON.stringify(out, null, 2)}`);
        console.log(`C4-JS ${label} ok`);
      } catch (e) {
        show("c4-out", `${label} 失败:${e}`);
        console.error(`C4-JS ${label} fail: ${e}`);
      }
    })();
  });
};

c4("c4-schema", "1 schema", () => invoke("c4_schema"));
c4("c4-entries", "2 目录清单", () => invoke("c4_entries"));
// ⚠ 空间名固定 —— 验收要的是「建得出来」,不是名字有多好看;固定值让日志可对拍。
c4("c4-create", "3 新建空间", () => invoke("c4_create_space", { name: "C4 测试空间" }));
c4("c4-clobber", "4 归位撞名", () => invoke("c4_publish_clobber"));
c4("c4-backup", "5 备份→恢复", () => invoke("c4_backup_cycle"));
c4("c4-plant-creating", "6 预置 creating", () => invoke("c4_plant", { kind: "creating" }));
c4("c4-plant-joining", "7 预置 joining", () => invoke("c4_plant", { kind: "joining" }));
c4("c4-plant-orphan", "8 预置孤儿", () => invoke("c4_plant", { kind: "orphan-side" }));
c4("c4-plant-boot", "9 预置引导残留", () => invoke("c4_plant", { kind: "boot-residue" }));
c4("c4-plant-reset-a", "10 半态 a", () => invoke("c4_plant", { kind: "reset-a" }));
c4("c4-plant-reset-b", "11 半态 b", () => invoke("c4_plant", { kind: "reset-b" }));
c4("c4-plant-reset-c", "12 半态 c", () => invoke("c4_plant", { kind: "reset-c" }));
c4("c4-reset", "13 重置 main", () => invoke("c4_reset_main"));
// ⚠ 无参 —— 服务器地址与配对码由壳那边从 PC 侧参数口现取(`hdc rport`,见 c4.rs);
// 手机上打字这条路太脆,而配对码是一次性、十分钟过期的凭据。
c4("c4-join", "14 加入空间", () => invoke("c4_join_space"));

void pollGate();
