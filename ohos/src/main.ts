// C3 骨架的验收页。⛔ 不是产品前端 —— 它只把六条复核面各显成一个读数。
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

// 启动闸:轮到不是 pending 为止(与安卓同形)。
const pollGate = async (): Promise<void> => {
  for (;;) {
    try {
      const gate = (await invoke("startup_gate")) as { state: string };
      show("gate", gate);
      if (gate.state !== "pending") return;
    } catch (e) {
      show("gate", `失败:${e}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
};

$("paths-btn").addEventListener("click", () => void run("paths", () => invoke("ohos_paths")));
$("capture-btn").addEventListener("click", () => {
  const content = ($("text") as HTMLInputElement).value.trim();
  void run("smoke", () => invoke("smoke_capture", { content }));
});
$("inbox-btn").addEventListener("click", () => void run("smoke", () => invoke("smoke_inbox")));

void pollGate();
