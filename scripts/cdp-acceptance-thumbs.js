// 299 缩略图本地派生表(迁移 0032,image-perf-plan §3)安卓真机验收。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-thumbs.js
//
// 分两段,合起来才算证完:
//   A 段「命令层往返 + 三道闸 + 级联」——自造一张真 JPEG 当种子,末尾 finally 清净;
//   B 段「真实图的命中率」——不造数据,直查这台机上**用户真图**里有多少已经被
//     app 自己的 fillThumb 回存过。B 段才是「产品路径真跑通了」的证据:A 段的 put
//     是我在脚本里手调的,只证后端;B 段的 put 全部出自 android/src/thumbs.ts(310 第③笔前住 main.ts)。
//
// ⚠ B 段要有意义,得先让 app 真渲染过缩略图 —— 跑本脚本前先把时间轴滚过几屏带图的卡。
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail ?? "" });

  const spaces = await invoke("list_spaces");
  const space = spaces.find((s) => s.current)?.id;
  check("有前台空间", !!space, space ?? "");
  if (!space) return { pass: false, rows };

  const b64 = (dataUrl) => dataUrl.slice(dataUrl.indexOf(",") + 1);
  // 画一张有噪声的图:纯色会被 JPEG 压到几 KB,量不出「缩略图远小于原图」。
  const paint = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = (i * 7) % 255;
      img.data[i + 1] = (i * 13) % 255;
      img.data[i + 2] = (i * 29) % 255;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };
  // 与 android/src/thumbs.ts::shrinkToThumb 同口径(144² cover 方裁 / JPEG q0.8)。
  const shrink = (srcUrl) =>
    new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        const crop = Math.min(im.naturalWidth, im.naturalHeight);
        const side = Math.min(144, crop);
        const c = document.createElement("canvas");
        c.width = side;
        c.height = side;
        c.getContext("2d").drawImage(
          im, (im.naturalWidth - crop) / 2, (im.naturalHeight - crop) / 2,
          crop, crop, 0, 0, side, side,
        );
        res(c.toDataURL("image/jpeg", 0.8));
      };
      im.onerror = () => rej(new Error("解码失败"));
      im.src = srcUrl;
    });

  let itemId = null;
  try {
    // ── A 段:命令层往返 ──────────────────────────────────────────────
    const full = paint(900, 700).toDataURL("image/jpeg", 0.92);
    itemId = await invoke("capture_idea", { spaceId: space, content: `299缩略图验收 ${Date.now()}` });
    const meta = await invoke("add_item_image", {
      spaceId: space, itemId, mime: "image/jpeg", dataB64: b64(full),
    });
    check("种子图已挂上", !!meta.id, `seq=${meta.seq} bytes≈${b64(full).length}`);

    const miss = await invoke("get_item_thumb", { spaceId: space, imageId: meta.id });
    check("未命中:thumb=false", miss.thumb === false, `thumb=${miss.thumb}`);
    check("未命中:吐的是全尺寸", b64(miss.url).length === b64(full).length,
      `${b64(miss.url).length} vs ${b64(full).length}`);

    const small = await shrink(miss.url);
    await invoke("put_item_thumb", { spaceId: space, imageId: meta.id, dataB64: b64(small) });

    const hit = await invoke("get_item_thumb", { spaceId: space, imageId: meta.id });
    check("回存后:thumb=true", hit.thumb === true, `thumb=${hit.thumb}`);
    check("命中:声明 image/jpeg", hit.url.startsWith("data:image/jpeg;base64,"),
      hit.url.slice(0, 32));
    check("命中:字节与回存的一字不差", b64(hit.url) === b64(small),
      `${b64(hit.url).length} vs ${b64(small).length}`);
    // 这条是本件的全部意义:命中路上过 IPC 的字节要小一个数量级。
    check("命中远小于全尺寸(<1/5)", b64(hit.url).length * 5 < b64(full).length,
      `${b64(hit.url).length} vs ${b64(full).length}`);

    // ── 三道闸各自真咬人,且拒了不留痕 ───────────────────────────────
    const png = b64(paint(16, 16).toDataURL("image/png")); // 魔数 89 50 4E 47
    let e1 = null;
    await invoke("put_item_thumb", { spaceId: space, imageId: meta.id, dataB64: png })
      .catch((e) => { e1 = String(e); });
    check("闸①非 JPEG 被拒", !!e1, e1 ?? "竟然放行了");

    let e2 = null;
    await invoke("put_item_thumb", {
      spaceId: space, imageId: meta.id, dataB64: "/9j/" + "A".repeat(180_000),
    }).catch((e) => { e2 = String(e); });
    check("闸②超长被拒", !!e2, e2 ?? "竟然放行了");

    let e3 = null;
    await invoke("put_item_thumb", {
      spaceId: space, imageId: "01JZZZZZZZZZZZZZZZZZZZZZZZ", dataB64: b64(small),
    }).catch((e) => { e3 = String(e); });
    check("闸③外键:图不存在被拒", !!e3, e3 ?? "竟然放行了");

    const after = await invoke("get_item_thumb", { spaceId: space, imageId: meta.id });
    check("三次被拒后原行分毫未动", after.thumb === true && b64(after.url) === b64(small),
      `thumb=${after.thumb} len=${b64(after.url).length}`);

    // ── 级联:删图 → 缩略图跟着没 ────────────────────────────────────
    await invoke("delete_item_image", { spaceId: space, imageId: meta.id });
    let e4 = null;
    await invoke("get_item_thumb", { spaceId: space, imageId: meta.id })
      .catch((e) => { e4 = String(e); });
    check("删图后取缩略图响亮错(级联真生效)", !!e4, e4 ?? "竟然还查得到");
  } catch (e) {
    check("A 段未抛异常", false, String(e));
  } finally {
    if (itemId) {
      await invoke("archive_note", { spaceId: space, id: itemId }).catch(() => {});
      await invoke("purge_note", { spaceId: space, id: itemId }).catch(() => {});
    }
  }

  // ── B 段:用户真图上,app 自己回存了多少 ──────────────────────────
  try {
    const items = await invoke("list_timeline", { spaceId: space });
    const withImg = items.filter((i) => (i.images?.length ?? 0) > 0);
    const ids = withImg.flatMap((i) => i.images.map((m) => m.id)).slice(0, 24);
    check("这台机上有带图条目", ids.length > 0, `图 ${ids.length} 张 / 条目 ${withImg.length} 条`);
    let hits = 0;
    let hitBytes = 0;
    let missBytes = 0;
    for (const id of ids) {
      const d = await invoke("get_item_thumb", { spaceId: space, imageId: id });
      if (d.thumb) { hits++; hitBytes += b64(d.url).length; } else { missBytes += b64(d.url).length; }
    }
    check("app 自己回存过缩略图(命中 > 0)", hits > 0, `命中 ${hits}/${ids.length}`);
    check("命中的都是小图(均 < 64KB)", hits === 0 || hitBytes / hits < 64 * 1024,
      `均 ${hits ? Math.round(hitBytes / hits) : 0} 字符,未命中侧共 ${missBytes} 字符`);
  } catch (e) {
    check("B 段未抛异常", false, String(e));
  }

  return { pass: rows.every((r) => r.ok), rows };
})();
