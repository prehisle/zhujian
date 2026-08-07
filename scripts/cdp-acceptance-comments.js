// 314 条目留言(迁移 0035,identity-plan §4)安卓**命令层**真机验收:
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-comments.js
//
// 四条命令(add/remove/list/count)是 315 写的,但那一轮安卓侧**够不着**(手机 UI 在
// 第③笔)。这里是它们第一次在真机上真跑:`coord.write` 的空间锁+相位、`with_read` 的
// 直读前台库、`Option<(String,String)>` 游标经 IPC 的往返,全是安卓壳这一侧独有的路。
//
// 分三段:①往返与语义(最近优先 / 署名恒为本机 / 删除幂等 / 计数跟着走)
//        ②四道拒原样传上来(空正文 / 宿主 id 非规范 / 宿主不存在 / 正文超 200 KiB)
//        ③51 条两页分页(游标经 IPC 往返;并发写还顺带把「同一毫秒 created_at」造出来,
//          那正是 `(created_at,id)` 元组游标要靠 id 打平的那一格)
// 末尾 finally 把临时条目 purge 掉,留言随 FK CASCADE 走(顺带在真实库上走一遍级联)。
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail ?? "" });
  /** 期待被拒:返回拒绝原话;没拒(resolve)返回 null。 */
  const rejects = async (p) => {
    try {
      await p;
      return null;
    } catch (e) {
      return String(e);
    }
  };

  const spaces = await invoke("list_spaces");
  const space = spaces.find((s) => s.current)?.id;
  check("有前台空间", !!space, space ?? "");
  if (!space) return { pass: false, rows };

  const ident = await invoke("device_identity", { spaceId: space });
  const me = ident.this_device;
  check("拿到本机 device_id", !!me, me ?? "");

  let itemId = null;
  try {
    itemId = await invoke("capture_idea", { spaceId: space, content: `【CDP验收314】留言宿主 ${Date.now()}` });

    // ---- ① 往返与语义 --------------------------------------------------------
    const a = await invoke("add_item_comment", { spaceId: space, itemId, content: "第一句" });
    const b = await invoke("add_item_comment", { spaceId: space, itemId, content: "第二句" });
    const c = await invoke("add_item_comment", { spaceId: space, itemId, content: " 第三句(前后空白应被 trim) " });
    check("写三条各返回一个 id", !!a && !!b && !!c && a !== b && b !== c);

    let page = await invoke("list_item_comments", { spaceId: space, itemId, cursor: null });
    check("一页读回三条", page.rows.length === 3, `rows=${page.rows.length}`);
    check("最近优先(第三句在最前)", page.rows[0]?.id === c, page.rows.map((r) => r.content).join(" | "));
    check("正文两端空白已 trim", page.rows[0]?.content === "第三句(前后空白应被 trim)", page.rows[0]?.content);
    check(
      "署名恒为本机 device_id(不是 null、不是别台)",
      page.rows.every((r) => r.born_device === me),
      page.rows.map((r) => r.born_device).join(","),
    );
    check("单页不满 50 时 has_more=false", page.has_more === false);
    check("next_cursor 是 (created_at,id) 二元组", Array.isArray(page.next_cursor) && page.next_cursor.length === 2, JSON.stringify(page.next_cursor));

    let counts = await invoke("item_comment_counts", { spaceId: space });
    check("聚合计数 = 3", counts[itemId] === 3, String(counts[itemId]));

    await invoke("delete_item_comment", { spaceId: space, id: b });
    page = await invoke("list_item_comments", { spaceId: space, itemId, cursor: null });
    counts = await invoke("item_comment_counts", { spaceId: space });
    check("删一条后剩两条", page.rows.length === 2 && !page.rows.some((r) => r.id === b));
    check("计数跟着走 = 2", counts[itemId] === 2, String(counts[itemId]));
    // 幂等:行不在 = no-op,不是错误(UI 的两拍确认与远端删除可能撞车)。
    const again = await rejects(invoke("delete_item_comment", { spaceId: space, id: b }));
    check("重复删同一条 = 幂等 no-op(不报错)", again === null, again ?? "");

    // ---- ② 四道拒原样传上来 --------------------------------------------------
    const e1 = await rejects(invoke("add_item_comment", { spaceId: space, itemId, content: "   " }));
    check("空正文被拒", !!e1 && e1.includes("不能为空"), e1 ?? "没拒!");
    const e2 = await rejects(
      invoke("add_item_comment", { spaceId: space, itemId: "not-a-ulid", content: "x" }),
    );
    check("宿主 id 非规范被拒", !!e2 && e2.includes("规范形"), e2 ?? "没拒!");
    const e3 = await rejects(
      invoke("add_item_comment", { spaceId: space, itemId: "01JZZZZZZZZZZZZZZZZZZZZZZZ", content: "x" }),
    );
    check("宿主不存在被拒", !!e3 && e3.includes("条目不存在"), e3 ?? "没拒!");
    const e4 = await rejects(
      invoke("add_item_comment", { spaceId: space, itemId, content: "宽".repeat(70000) }),
    );
    check("正文超 200 KiB 被拒", !!e4, e4 ?? "没拒!");
    const afterRejects = await invoke("item_comment_counts", { spaceId: space });
    check("四道拒一条都没落库", afterRejects[itemId] === 2, String(afterRejects[itemId]));

    // ---- ③ 51 条两页分页 -----------------------------------------------------
    // 先清干净,再灌 51 条(并发写:coord.write 的空间锁排队,顺带把「同一毫秒
    // created_at」造出来——元组游标靠 id 打平的那一格,串行写反而不容易撞上)。
    for (const r of (await invoke("list_item_comments", { spaceId: space, itemId, cursor: null })).rows) {
      await invoke("delete_item_comment", { spaceId: space, id: r.id });
    }
    await Promise.all(
      Array.from({ length: 51 }, (_, i) =>
        invoke("add_item_comment", { spaceId: space, itemId, content: `分页 #${i}` }),
      ),
    );
    const p1 = await invoke("list_item_comments", { spaceId: space, itemId, cursor: null });
    check("第一页恰 50 行", p1.rows.length === 50, String(p1.rows.length));
    check("第一页 has_more=true", p1.has_more === true);
    const p2 = await invoke("list_item_comments", { spaceId: space, itemId, cursor: p1.next_cursor });
    check("第二页恰 1 行", p2.rows.length === 1, String(p2.rows.length));
    check("第二页 has_more=false", p2.has_more === false);
    const ids = new Set([...p1.rows, ...p2.rows].map((r) => r.id));
    check("两页并起来 51 个互不相同的 id", ids.size === 51, String(ids.size));
    const dupTs = new Set([...p1.rows, ...p2.rows].map((r) => r.created_at)).size < 51;
    check(
      "同毫秒 created_at 也没漏行(元组游标靠 id 打平)",
      ids.size === 51,
      dupTs ? "本轮真撞上了同毫秒" : "本轮没撞上同毫秒(该格未被压到)",
    );
  } finally {
    // 宿主一删,留言随 FK CASCADE 走——顺带在**真实库**上走一遍级联。
    if (itemId) {
      await invoke("archive_note", { spaceId: space, id: itemId }).catch(() => {});
      await invoke("purge_note", { spaceId: space, id: itemId }).catch(() => {});
      const left = await invoke("list_item_comments", { spaceId: space, itemId, cursor: null }).catch(() => null);
      const cnt = await invoke("item_comment_counts", { spaceId: space }).catch(() => ({}));
      check("宿主 purge 后留言 0 行(CASCADE)", left && left.rows.length === 0, String(left?.rows.length));
      check("宿主 purge 后聚合计数里没有它", cnt[itemId] === undefined);
    }
  }

  return { pass: rows.every((r) => r.ok), rows };
})();
