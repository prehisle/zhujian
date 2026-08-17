# Zhujian (朱简)

> **English** · [简体中文](readme.md)

A personal notes-and-tasks tool — **strictly manual, unconstrained, easy to maintain**. The name joins *zhūshā* (朱砂, cinnabar) and *jiǎndú* (简牍, the bamboo and wooden slips written on before paper): writing in red on short strips, for the small things worth keeping. The second character also carries the sense of plain and simple. (It was called 朱笺 before, and ys-notebook before that.) The paper-and-cinnabar look runs through everything.

```
capture fast → let notes settle → move them by hand (tag / make a task) → push them across the board
```

A single-user, local-first desktop tool. Capture has almost no friction, the original text is never lost, and **no AI is involved at any point**: every step a note takes is something you do by hand, and the data lives in a SQLite file on your machine.

> **A change of direction**: this started life as an "AI idea pipeline". On 2026-06-26 it was repositioned as a strictly manual tool — the AI code (filing, resurfacing) was **physically deleted**, and both the interface and the data model were pared back. On 2026-06-28 ideas and tasks were further collapsed into **one entity** (one row that changes state, no copies). Using AI again would mean adding it from scratch.

## Stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri v2 (Rust backend + WebView frontend) |
| How you summon it | Global hotkeys `Ctrl+Alt+N` (jot something down) / `Ctrl+Alt+M` (open the main window, on whichever view you left it) — **both rebindable** under Settings in the sidebar (change one if it clashes with another app; a clash no longer keeps the app from starting) + the system tray (**double-click = open the main window, right-click = menu**, with the matching shortcuts shown) |
| Frontend | Vite + TypeScript (vanilla, no framework) |
| Storage | SQLite (rusqlite, bundled) |

## Features

- **Quick capture**: a hotkey or the tray pops up a floating slip; type a note, press Enter, it lands in Notes and the window disappears. **Screenshots paste straight in** (Ctrl+V): pasted images show as small previews in the slip (each removable) and are stored with the note on Enter, each numbered `Image N`; an image with no text is fine too. **Type `/` at the start of a line for commands**: `/task` files this one straight onto the board instead of Notes, `/tag family` attaches a tag, `/space` picks which space it lands in (when you have several). Ordinary text that happens to start with `/` (say `/etc/hosts`) does not trigger anything and saves as usual. The space badge in the top-right is clickable too.
- **Notes** (the main window's default view): two tabs —
  - **Notes**: a compose box at the top (**Ctrl+V pastes images here too**, previewed and stored with the note on Enter, same as the capture slip). Tagged and untagged notes live **in one list** (a tag is just handy metadata, not a second tab), **grouped by day into a timeline** (Today / Yesterday / the day before / date headings, with a rail down the left and the time on each card). Once you have a few, the top also offers **tag filtering + text filtering** (All / Untagged / each tag — the same pair the board uses, and they stack; clear the text or press `Esc` to go back, switch the tag back to All to go back). A note written while a tag filter is on **gets that tag automatically**; one written while a text filter is on clears the filter — a new card never gets filtered out by the filter that was on when you wrote it. Every note offers **Edit (history kept)**, **Images**, **Make a task**, **Tags**, **Copy**, **Delete**; tagged ones grow tag chips. **Delete** is always a **soft delete into the trash** (restorable, so there is no confirmation — a slip of the hand costs nothing); to destroy something for good, go to the trash and **Delete forever**. (Note: **a note that becomes a task leaves Notes for the board** — same subject, different gear, so it is not in two places.) The header carries one faint line of **flow stats**: `Captured this week: N · Made into tasks: X%` (of the items born as notes, how many later became tasks; the number accumulates from the day the stat went in — older data is never guessed at).
  - **Trash**: soft-deleted notes can be **Restored**, **Deleted forever** (with a confirmation) or **Emptied**.
- **Task board**: four columns — **To do / In progress / To confirm / Done** —
  - **Drag** between columns to change state, or within a column to order by hand (dropped where you put it). Drag a Done card to the archive strip at the bottom to **file it in the Archive** (a real archive, not a delete; the strip stays out of the way and only appears while you are dragging a finished card).
  - **To confirm** (an optional fourth column): work that is finished but waiting on someone else, separated out from In progress. It is **never mandatory** — In progress → Done skips it, and all four states move freely in both directions (things can be sent back).
  - Done cards show **when** they were finished (today / yesterday / a date); sending one back or archiving it preserves that moment. (Cards finished before this feature shipped show nothing — the moment is unknown.)
  - Cards can carry a **due date / priority / tags**, with overdue and due-today highlighted; each offers **Edit**, **Images**, **Copy** and **Delete** (soft delete into the trash, confirmed once and then not again).
  - **Hover to select, plus a shortcut cheat sheet**: move the mouse over a card and a ⋯ menu in its corner lists every action with its single key; press the key directly if you already know it — Edit `E` / Copy `C` / Tags `L` / Due `S` / Priority `P` / Send back `B` / Delete `D` / `]` next column / `[` previous column (so the keyboard moves cards between columns too). **Note cards use the same hover-and-shortcut scheme** (the overlapping actions keep the same keys, E/C/L/D, so the habit carries over). **Double-clicking a card** (on empty space) runs the default action, Edit — on both note and task cards.
  - A **To do** task can be **sent back to Notes** (a note is a task you have not thought through yet, so it returns to the earlier stage): **the same row** flips back — if it still has tags it lands as filed, and only an untagged one returns as unfiled. In progress and Done are already thought through, so they do not get this button.
  - The top offers **tag filtering** (All / Untagged / each tag) and a **text filter** (finding a card gets hard once there are many: type to filter, matching titles only; it stacks with the tag filter, and clearing it or pressing `Esc` brings everything back. Creating a task clears the filter, so a new card is never filtered out by itself. To search across views and through old versions, use Search in the sidebar). Dragging works while filtered, and the header can **copy the board** as Markdown.
  - **Archive**: finished work is history worth keeping, and should not share a bin with the trash — the Done column header archives **everything** in one go (two-step confirmation), or drag to the strip at the bottom, or use **Archive** in a card's menu. The archive view groups into a timeline **by the day the work was finished** (not the day it was filed, so archiving a week's work at once does not squash it into today), with a line of **stats** in the header (`Finished this week: N · N in total`). It can be read but **not deleted from** (to delete, **un-archive** back to the board first and then delete normally — one extra step, on purpose).
  - The **Trash** view: deleted tasks can be restored (to their original column), deleted forever, or emptied. Archiving is not deleting; the two have separate doors.
- **Tags**: lightweight classification. Each tag's row shows `N notes · M tasks`; **clicking the row expands it in place** (▸/▾) to show the notes and tasks carrying that tag (read-only; tasks show their column, due date and priority) — expanding and collapsing happen right there, with no jump to a separate page. **Create / rename / delete / merge** by hand (merging folds scattered tags into one and rewrites the membership). **Drag the handle to reorder tags** (your order is followed everywhere — the tag list, the tag picker, the chips on cards), and new tags go to the end. **A tag can be given a "kind"** (free text, none by default — "person", say), for grouping by kind later. **To get hierarchy, name with a slash**: create `zhujian/sync`, and as long as a tag named `zhujian` also exists, it is indented under it in the list and shows only "sync" (hover for the full name) — but **the hierarchy is only visual**: filtering, counting and merging still treat it as an independent tag (filtering `zhujian` does not include `zhujian/sync`; if something belongs to both, put both tags on it).
- **Global search**: find any item by content across Notes / Tasks / Trash, **including versions you have since edited away** (archived achievements are searchable too, badged "Archived"), with matches highlighted and state badges plus tag chips to orient you.
- **Images**: when words are not enough, attach images to a note or a task. **Anywhere you can type body text you can paste** — editing a card, the capture slip, the compose boxes in Notes and on the board: **paste a screenshot (Ctrl+V)** and it is attached (when creating, it is previewed first and stored with the item). One item can hold **several**. Each thumbnail is badged with its **`Image N` number**; click to view it full size, and writing "Image 1" in the body turns into a link to that image. The number is the image's identity — deleting one does **not** renumber the rest (the gap stays), so a reference in the body always points at the same image; replacing an image means deleting the old one and adding a new one. Images follow their item into the trash, back out of it, and into oblivion.
  - **On the phone** there is no clipboard route, so you get two buttons instead: **"+ Image" picks from the gallery, up to 9 at a time** (they land in the pending strip one by one and are stored with the item when you tap "Note it"); **"+ Photo" opens the camera** and the shot you take comes straight back into the pending strip. Items you already noted work the same way — open the card and its action row offers Add image and Camera. Gallery originals are often several MB, so they are scaled down to a sensible size before being stored (screenshots and small images are left exactly as they are).
- **Links in the body**: `http(s)://` URLs in a note or task turn into links — **left-click** opens them in your default browser, **right-click** copies the URL (for pasting into a specific browser), and hovering shows the full address.
- **Editing saves itself**: double-click a card (or press `E`) to edit; **Enter or clicking elsewhere** saves, `Esc` cancels — there is no Save button to hunt for.
- **Remembers the window and the view**: the main window's size, position and maximized state, plus which view you left it on (Notes / Tasks / Tags / Search), all come back after a restart; the first run centres a default-sized window.
- **Collapsible sidebar**: the small button in the sidebar's corner or `Ctrl+B` folds the sidebar into a strip to free up horizontal space; click or press again to expand, and the state is remembered.
- **Light / dark (auto / light / dark)**: "auto" by default — it follows the system light/dark setting (phones usually switch by time of day, so it goes dark in the evening); pick Light or Dark to pin one instead. On the desktop it is under Settings → Appearance at the bottom of the sidebar, on the phone under the gear in the top bar. **This choice affects that device only and does not sync** (dark on the phone at night and light on the desktop by day is a perfectly good arrangement). Interface text size works the same way — `Ctrl +` / `Ctrl -` / `Ctrl 0` zoom the desktop window; the phone has Settings → Text size with Small / Standard / Large / Extra large (applied on top of the system font size).
- **Multi-device sync (experimental, self-hosted)**: the Sync entry at the bottom of the sidebar — several devices sync through your own server, **end-to-end encrypted** (notes and images are encrypted before they leave the machine; the server only ever sees ciphertext, which it relays and holds briefly). On the first device, click "Create account" (no invite code needed) and you get a **recovery code** (write it down on paper: it is the account key, *not* a data backup — recovering data still requires at least one complete copy on a live device; the server cannot help there). Other devices join with a **pairing code** generated by an existing one, receive the full dataset, and from then on work offline and top each other up when online. Unconfigured, the whole feature stays silent and does not get in the way of single-machine use.
- **Automatic direct transfer on the same wifi (LAN acceleration)**: two devices on the same local network **talk to each other directly** instead of going around the server — faster, and **it keeps syncing even when the router has no internet**. The encryption is unchanged: a direct link is end-to-end encrypted exactly like the server path, so the content is visible **neither to the server nor to anyone else on the network**. There is nothing to configure; if a direct link cannot be made it silently falls back to the server.
  **The honest cost**: other people on the same network cannot see your content, but they **can see that these two devices are syncing**, along with the device ids, local addresses, and when and how much data moved — which is more than the server can see. On your own wifi at home that hardly matters; on office or café wifi, that information is visible to everyone else on the network. **There is currently no switch to turn it off.**
- **Name your devices, and see which one wrote what**: when several devices are in use, each can be given a name — on the desktop under Settings → This device's alias at the bottom of the sidebar, on the phone under the gear → Settings → This device's alias; change it any time, and clearing it goes back to showing nothing. Once a name is set, items written on **other** devices carry a very faint note on their time line saying where they came from (like `· Juanjuan's phone`), in both the note list and the task board, with "written on …" on hover. Three restrained rules: **what this device wrote is never labelled** (you know), **unnamed devices are not labelled** (so with one person and one device the feature is silent throughout), and **items written before the feature shipped are never labelled** (nothing is guessed or backfilled). Names **do sync to other devices** (unlike theme / text size / hotkeys, which are per-device), and they are **set per space** — the same machine can be one name in "Personal" and another in "Family", so name it again in whichever space you share. Note: moving an item to another space records the device that performed the move.
- **The device list · removing a device**: the sync panel holds **the current device list for this space** — one row per device, showing its name (devices without one show the first few characters of their id, extended automatically when that is not enough to tell them apart), marked **This device** and **Admin** where they apply; the full id can be expanded and copied. The list **comes from the server**, so "which devices are still enrolled" is answered there rather than from each device's own memory.
  - **Who may remove whom**: the first device to create the account is an admin automatically, and others can be promoted later. **Only an admin can remove someone else**; a non-admin device can do exactly one thing — **remove itself** from the space. So that nobody locks themselves out, **the admin set may not be emptied**: when one admin is left, it can neither be removed nor leave on its own.
  - **What removal actually means** (the confirmation spells all of it out, nothing omitted): the removed device **can no longer sync this space through the server**; but the content **already on it is not deleted** — removing is not wiping it, and **the account key and the full copy handed over at pairing cannot be taken back** (worth thinking through in a team). On the same wifi: **every device still on the list drops its direct local-network link to it as soon as that device can fetch the current list from the server** — usually at once, or a few minutes later on a poor connection; a device that cannot fetch the list may keep syncing with it directly.
  - **If it still holds content that has not synced out, let it come online and finish first**: rejoining requires wiping its data, and whatever only it had is gone.
  - **To cut a device off completely** (a lost device, or someone leaving a shared space), removal is **not enough** — the data is end-to-end encrypted and the key is already in their hands; that takes resetting the whole account (every device re-pairs, a new recovery code), which means asking whoever runs the server.
- **Spaces**: the current space's name at the top of the sidebar ("Personal space" by default) opens a menu to **create a space** ("Family", say — as many as you like), switch between them, and rename them; the phone supports multiple spaces too. **A space arrives by one of two routes**: "New space" = a fresh notebook, usable immediately and purely local (create an account inside it if you want it on several devices); "Join a space" = attach an existing account to this machine (scan or type a pairing code), and it appears in the list once the sync has completed. Each space is a **completely separate notebook** — its own notes, board, tags and search, and its own sync account. Pair a family member's device into the "Family" space's account and the two of you share that one notebook, while **the data in your personal space never leaves its own account** (the isolation is an encryption boundary, not a permission switch). Quick capture lands in **whichever space you are in** (the slip carries a small seal in the corner naming it, hidden when there is only one), and nothing is mixed across spaces: search and the board only ever show the current one.
- **Move to another space**: filed it in the wrong place? The ⋯ menu on a note or task card offers **Move** (shortcut M) to carry that one item into another space (it only appears once you have more than one). Moving means being born again in the target and deleted in the source: tags travel by name and images keep their numbers, but **the edit history does not travel and is permanently deleted by the move** (you are warned before picking a space). If something goes wrong mid-move it will keep two copies rather than lose one, and the card says so plainly so you can sort it out.
- **Encrypted backups (desktop, manual)**: sidebar bottom → **Settings → Backup** encrypts **each space's complete data** into one file you keep yourself — a USB stick, a cloud drive, anywhere. Setting it up runs a **backup code** ceremony once: the screen shows you a code, you **write it down** (paper or a password manager), then type it back in full so it can be checked — that step exists to confirm you really wrote it down, not as a formality. After that, "Back up now" is one click. Files land in `backups/` under the data folder by default; that row also takes any full path you paste (a cloud-sync folder, say) and offers "Open folder".
  - **Without the backup code the contents cannot be read** — so a stray copy on a cloud drive, a USB stick, or in a cloud provider's version history is not a leak.
  - ⚠ **Once the backup code and every device that still holds this key are gone, no one can open your existing backups — including us.** There is no recovery channel (same honest line as the recovery code).
  - ⚠ **Uninstalling Zhujian does not delete the backup key or the data folder.** Clearing them is manual — but first make sure the backup code exists somewhere else, or the backups you keep elsewhere may never open again.
  - ⚠ A backup contains this device's sync identity and account key (otherwise a restored library could not sync) — **a backup file plus the code is full read/write access to the account**. Keep it as a secret.
  - ⚠ **A backup is not a promise that nothing can be lost**: it hands custody to you, it is not a durability guarantee. The default location sits on the same disk as your library, so store a copy elsewhere if you want to survive that disk.
  - Today it is **manual only** and **desktop only**; scheduled backups and one-click restore are not built yet.

## Layout

```
index.html, src/main.ts          capture slip (capture only, its own window)
notebook.html, src/notebook.ts   main window shell (4 sidebar entries + view registry + single-window navigation)
src/inbox.ts   (.v-inbox)        Notes view (notes + trash tabs; one merged list, tags are just metadata)
src/board.ts   (.v-board)        task board (four columns: drag, order, filter, trash; includes To confirm)
src/topics.ts  (.v-topics)       tags view (counts + click a row to expand notes and tasks / create, rename, delete, merge;
                                 the internal identifier is still "topics")
src/search.ts  (.v-search)       global search (by content, across states)
src/tasktime.ts                  shared task time dimension (due / priority chips + local "today")
src/clipboard.ts                 shared copy button (notes / tasks / board)
src/item-images.ts (.img-*)      shared image controller (Ctrl+V paste + Image N thumbnail strip + lightbox +
                                 "Image N" body references + pendingImages staging; shared by notes, board and the slip)
src/hotkey-menu.ts (.hk-*)       shared hover ⋯ shortcut menu (hover to select + cheat sheet + single-key dispatch)
src/i18n.ts, src/locales/        interface language (zh / en; one key per line, zh and en side by side)
src/theme.css                    the single source of truth for design tokens (paper and cinnabar)
src-tauri/
  src/lib.rs                Tauri shell (this layer only): hotkeys, tray (3 items), two windows, the command surface;
                            path dependency on ../core
core/                       zhujian-core, the shared core crate (data layer + sync client, zero Tauri coupling;
                            reused by both the desktop and Android shells as a path dependency)
  src/notes.rs              the manual line (edit keeping history / make a task / tag / merge tags / send back / purge)
  src/task.rs               board state machine (legal transitions + CAS) + drag ordering + task trash
  src/images.rs             image attachment (take the next "Image N" high-water number + insert, one transaction)
  src/repo.rs               data access (plain SQL) + read/write primitives
  src/db.rs                 connection + migration runner (user_version + numbered SQL, 35 so far)
  src/clock.rs etc.         sync data layer (device identity + HLC clock / oplog / remote replay / fractional index)
  src/sync/                 sync client (receive engine / E2EE / SPAKE2 pairing / snapshot bootstrap / WSS transport /
                            LAN direct link [lan.rs logic + lan_net.rs listen and dial + ops_serve.rs catch-up])
  migrations/0001_init.sql … 0035_item_comment.sql
                            initial schema, note history, trash guards, the AI cleanup, the single-entity merge,
                            images, achievement archive, born-stage, the sync data layer (oplog / fractional position /
                            replay exemptions / origin_seq), space-name sync, done_at, tag order and kind,
                            thumbnails, device profile, item comments
src-tauri/
  tauri.conf.json           window and packaging config
e2e/                        real GUI e2e (wdio.conf.js + 35 specs + support.js; drivers/msedgedriver not included)
sync-proto/, server/        sync envelope layer + the self-hosted sync service zhujian-syncd
                            (separate crates, zero-knowledge E2EE relay)
android/                    Android shell (its own npm project + the zhujian-android crate, path dependency on core;
                            a full-featured client since 119 — capture, unified timeline with images, tick to finish,
                            system share, QR pairing, update prompts; system backup disabled)
site/                       the zhujian.app website (one static file, no build step; bilingual zh / en)
```

## Development

Prerequisites: Node, Rust (rustup stable-msvc), the WebView2 runtime, the VS2022 C++ toolset.

```bash
npm install          # frontend dependencies (including the Tauri CLI)
npm run tauri dev    # dev mode (starts vite:1420 and the app together)
npm run tauri build  # release build (frontend embedded in a standalone exe)
```

> ⚠️ **Do not run `src-tauri/target/debug/app.exe` directly**: the debug build's WebView points at the dev
> server on `localhost:1420`, so without vite running you get "localhost refused to connect". Use
> `tauri dev` for development and `tauri build` when you want a standalone executable.
>
> The app lives in the tray and both windows default to `visible:false` — get in by double-clicking the tray
> (or "Open Zhujian" in its right-click menu), or with `Ctrl+Alt+N` (capture) or `Ctrl+Alt+M` (main window);
> the main window opens on whichever view you left it on.

## Tests / verification

- **Logic**: `cd core && cargo test` (**766 tests**, including folded proofs that every migration loses nothing, a convergence property test for the sync engine, and end-to-end tests of two libraries against a real sync server; all backend tests live in the shared `zhujian-core` crate, while `cd src-tauri && cargo test` covers the desktop shell's multi-space unit tests). Separate crates: `cd sync-proto && cargo test` (envelope layer) / `cd server && cargo test` (sync service) / `cd android/src-tauri && cargo test` (Android shell).
- **Real GUI e2e**: `npm run test:e2e` (**35 spec files / 149 cases**) — WebdriverIO → tauri-driver → msedgedriver → a real WebView2, with real clicks, real IPC and real SQLite (see `docs/dev-and-testing.md`).
  - **fast (day-to-day, ~80s)**: in another terminal run `npm run dev` (**vite only — not `tauri dev`**, which grabs the `Ctrl+Alt+N` global hotkey and makes the e2e app panic), then `YS_E2E_FAST=1 npm run test:e2e` (debug exe; onPrepare runs an incremental `cargo build`).
  - **release (final check, ~5min)**: `npm run tauri build -- --no-bundle`, then `npm run test:e2e` (the default; self-contained, no vite needed). Stop the dev server first here too.
  - Isolation: e2e uses a temporary database at `%TEMP%\ys-nb-e2e.sqlite3` (emptied each run) and **never touches your real notebook**.
  - Dependencies: `tauri-driver` (`cargo install tauri-driver`) and `e2e/drivers/msedgedriver.exe` (**not in the repository**; download the Edge WebDriver matching your local WebView2 runtime and put it at that path).
- **Look inside the database**: `node --experimental-sqlite scripts/verify-db.mjs`.
- Database location: `%APPDATA%\app.zhujian.notebook\notebook.sqlite3` (overridable with the `YS_DB_PATH` environment variable, which e2e uses).

> If crates.io is hard to reach from your network, add your own `.cargo/config.toml` with a proxy
> (not in the repository — it is machine-local configuration).

## Data model, in brief

- Primary keys are all **ULIDs** (TEXT) and timestamps are RFC3339 UTC TEXT; `due_on` is the exception, a local calendar day `YYYY-MM-DD` (a deadline is an intent about a calendar day, so storing a UTC instant would put it a day off).
- **One entity (2026-06-28)**: a note and a task are **the same `items` row in a different `stage`** (`inbox` / `filed` | `todo` / `doing` / `confirming` / `done`) — not two records. **Making a task = flipping the stage to `todo`, with no copy**; sending it back flips it to `inbox`/`filed`. Rows in a task stage never appear in the note views, so there is nothing to de-duplicate. `archived_at` is the trash axis (it freezes the stage and restores to it), and the frontend splits the trash into "notes" and "tasks" by that frozen stage.
- **Separated concepts**: `items.stage` is the gear in the flow (note ↔ task); `topics` + `item_topic` (M:N) are tags (called "tags" to the user; tasks have had real multi-tagging since ㉞ — one task can carry several tags and shows up under each).
- **Immutability is historical, not per-row**: you **can** edit your own items, and before each change a DB trigger (migration 0014 `trg_item_archive_on_edit`) archives the previous version into `item_revisions` (append-only, unrewritable, unbypassable) **across every stage** (editing a task title archives too). The original and every version since are never lost.
- **Deleting is the user's prerogative, with graduated fail-safes**: what is guarded against is accidental or silent destruction, not you clearing out your own data.
  - **Deleting means the trash; destruction only happens inside the trash** (since 2026-07-08 this covers unfiled notes too): every **Delete** is a soft delete (setting `archived_at`, restorable to its original gear) and only a confirmed **Delete forever** in the trash actually removes it (cascading tags and history). Notes and tasks **share this one `archived_at` axis**. The storage-layer guards (migration 0014) still stand: filed notes and tasks cannot be hard-deleted at the database level while active. The hard-delete primitive for unfiled notes remains, but only for the command layer and for emptying the database in tests.
- **Send back to Notes** (a note is a task you have not thought through, so only **To do** can go back — In progress and Done cannot): **the same row flips its stage back** — with tags it lands as filed, without any it returns unfiled. There is no longer a distinction between "restore the source note" and "create one from the title": it was always the same row.
- **`topics` (tags) is a recomputable projection**: a manual merge (`merge_topics`) rewrites membership in `item_topic` (covering notes and tasks in one pass) and folds scattered tags into the surviving one without keeping membership history — no item is lost and no content is touched.
- Every connection runs `PRAGMA foreign_keys = ON`, and link tables are `ON DELETE CASCADE`. There is no catch-all metadata JSON column; extensions go through explicit migrations.

## Design rules

- **Strictly manual**: every step a note takes (tagging / making a task / sending back / deleting) is a manual transaction and depends on no AI.
- **Fail fast**: production code never writes silent fallbacks or default values; an illegal operation rolls the whole transaction back and reports.
- **Only "your data is not lost" guarantees are kept**: history archiving (0003) and the ban on directly deleting processed items (0004) stay. The "lock down the flow" triggers written to stop AI or the system from silently changing data (the suggested gate, the frozen archive state) left along with the AI, in exchange for flexibility and lower maintenance.
- **Style**: light, minimal, paper and cinnabar (warm paper, dark ink, cinnabar accents; body text in a serif, interface text in a sans).

## Licence

The code is released under [MIT](LICENSE). The name "Zhujian" (朱简, formerly 朱笺), the seal icon and the `zhujian.app` domain are brand marks and are **not** covered by the code licence — if you deploy or distribute a derivative, please change the name and the mark. Official downloads and the sync service are at [zhujian.app](https://zhujian.app).
