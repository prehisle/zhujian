//! 朱简安卓壳(P4-c 捕获+时间轴+勾完成、P4-d 接同步,android-plan §0/§2/§4)。
//!
//! 定位:**119 起手机 = 全功能主力端**(用户拍板「手机须能独立作唯一端」;96 的「捕获 +
//! 勾完成」旧定位作废,当前 UI 仍只有捕获时间轴、能力面已全量就位)——本 crate
//! 只做 tauri 壳,数据层与同步全在共享 crate `zhujian-core`(与桌面逐字节同一套,
//! 迁移链不可裁;151 起启动对既有库前滚迁移,下限 v28)。
//! P4-d 起常驻同步传输任务;**117 起 BlobPolicy::Full(反转 §4 M1,用户拍板)——
//! 图字节全量下行、时间轴显示配图(get_item_image)**;**phone-space-plan 起与
//! 桌面对称:可创号、可邀请设备、可当引导快照源(缺字节者拒供的防线在 core,
//! 端无关)**。
//! P4-b 诊断面(db_info/net_probe)保留。
//! 106 半自动更新(check_update,见 update.rs);107 扫码配对(桌面二维码 → 官方
//! barcode-scanner 插件扫码,解析后走同一条 sync_pair_join,协议零改动)。
//! 111 起(multispace 工序 6)严格启动:fresh 建主库 + `SpaceCatalog::load`
//! fail-closed(已有库不迁移,版本不符 = 封锁页清库重配,multispace-plan §10/§19)。
//! 工序 7/8(multispace-plan §15):多空间——空间创建 + 两阶段配对账户唯一闸(§4)、
//! 切换 + 显式捕获目标(§9/§16.2 提案 B)+ 手动全部同步(§7 lean-B);业务命令面
//! 显式携带 `space_id`(「点击时看到的空间」),裁决全在 [`coord::Coord`]。
//! **119 全功能底座**:桌面业务命令 1:1 上机(灵感编辑/回收站/转待办/看板全流转/
//! 成就归档/标签管理/配图增删/搜索/统计),编排全在 core、此处只是 coord 正道
//! 薄包装;UI 渐进接线,前端调用层见 `src/api.ts`。

mod coord;
mod update;

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use coord::{Coord, SyncAllReport};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::UnboundedReceiver;
use zhujian_core::spaces;
use zhujian_core::sync::supervisor::SpaceSupervisor;
use zhujian_core::sync::transport::{self, SyncEvent};
use zhujian_core::{db, images, notes, repo, task};

/// 启动闸(工序 6;本轮升级为**类型化三种 status、四种封锁 kind**,codex 设计审
/// H3/H4 + 实现审 H1):
/// - `pending`:装配(含前滚迁移)还在 blocking worker 上跑,前端轮询等待;
/// - `ready`:正常启动,数据面 state 已 manage;
/// - `blocked{kind,message}`:封锁页,**处置按 kind 四分流**——`upgrade-required`
///   只许提示装新版(绝不出现「清除数据」,单设备用户照做即真丢数据)、
///   `retryable` 释放空间/重启重试、`repair-required` 数据完好装新版再试、
///   `reset-required` 才是清库重配(§19,只由明确判断产生)。
#[derive(Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
enum GateStatus {
    Pending,
    Ready,
    Blocked { kind: &'static str, message: String },
}

fn gate_kind_str(kind: spaces::StartupBlockKind) -> &'static str {
    match kind {
        spaces::StartupBlockKind::UpgradeRequired => "upgrade-required",
        spaces::StartupBlockKind::Retryable => "retryable",
        spaces::StartupBlockKind::RepairRequired => "repair-required",
        spaces::StartupBlockKind::ResetRequired => "reset-required",
    }
}

struct Gate(std::sync::Mutex<GateStatus>);

#[tauri::command]
fn startup_gate(gate: State<'_, Gate>) -> GateStatus {
    gate.0.lock().expect("gate mutex poisoned").clone()
}

/// 事件桥:一个 runtime 一任务,事件信封带**空间标 + 代次**(§12「事件按
/// space+generation 过滤」):emit 前复核现任代次提前退场只是快路,check 与 emit
/// 之间仍有换代窗口(codex 工序 7/8 M6)——信封携带 generation,前端按每空间
/// 最大代次丢弃迟到事件,才是硬闸。旧任务消亡时发送端 drop,循环自然收尾。
fn spawn_bridge(
    app: AppHandle,
    sup: Arc<SpaceSupervisor>,
    space: String,
    generation: u64,
    mut ev_rx: UnboundedReceiver<SyncEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = ev_rx.recv().await {
            let current = sup.get(&space).map(|rt| rt.generation);
            if current != Ok(generation) {
                break; // 已不是现任(Stopping/已停/新代次):桥退场。
            }
            let _ = match ev {
                SyncEvent::Status(s) => bridge_emit(&app, "sync-status", &space, generation, s),
                SyncEvent::Changed => bridge_emit(&app, "sync-changed", &space, generation, ()),
                // 空间名变了(live replay / boot 物化):只发通知,**重扫不在桥里做**
                // (codex 实现审 H1:桥并发 refresh_catalog 有「旧快照后写」竞态,且
                // `app.state::<Coord>()` 在 manage 前是 panic 窗)——前端收到后调
                // `rescan_spaces` 命令做一次串行重扫再重查,失败也响亮在命令返回值上。
                // 前端对本事件**不按 space 过滤**(space-name-sync-plan §4.7)。
                SyncEvent::SpaceNameChanged => {
                    bridge_emit(&app, "space-name-changed", &space, generation, ())
                }
                SyncEvent::Toast(m) => bridge_emit(&app, "sync-toast", &space, generation, m),
                SyncEvent::BootProgress { received, total } => bridge_emit(
                    &app,
                    "sync-boot",
                    &space,
                    generation,
                    serde_json::json!({ "received": received, "total": total }),
                ),
                // 邀请方(opener)进度:joined / done / failed(phone-space-plan
                // §2.2;done=注册完成≠对方引导完成,出码页不据此自动关)。
                SyncEvent::Pair { phase, detail } => {
                    bridge_emit(&app, "sync-pair", &space, generation, pair_event_json(phase, &detail))
                }
            };
        }
    });
}

/// Pair 事件的 payload(纯函数,单测钉字段完整性——实现审 L6)。
fn pair_event_json(phase: &str, detail: &str) -> serde_json::Value {
    serde_json::json!({ "phase": phase, "detail": detail })
}

/// 事件信封(工序 8 统一形:前端按 space + generation 双过滤)。纯函数供单测。
fn bridge_envelope<T: serde::Serialize>(
    space: &str,
    generation: u64,
    payload: T,
) -> serde_json::Value {
    serde_json::json!({ "space": space, "generation": generation, "payload": payload })
}

fn bridge_emit<T: serde::Serialize + Clone>(
    app: &AppHandle,
    event: &str,
    space: &str,
    generation: u64,
    payload: T,
) -> tauri::Result<()> {
    app.emit_to("main", event, bridge_envelope(space, generation, payload))
}

/// Coord 内部激活(切换回滚 / 全部同步恢复前台)存下的事件接收端,在命令层收尾时
/// 接上桥——事件不许石沉大海。返回接上的 (space, generation) 供 "space-foreground"
/// 事件携带(前端先立代次水位再对账,工序 7/8 二审 L1)。
fn bridge_pending(app: &AppHandle, coord: &Coord) -> Option<(String, u64)> {
    let (space, generation, ev_rx) = coord.take_pending_bridge()?;
    spawn_bridge(app.clone(), coord.sup.clone(), space.clone(), generation, ev_rx);
    Some((space, generation))
}

/// 前台变更广播:携带 space + 现任代次(0 = 代次未知,只指示「去对账」、不立水位)。
fn emit_foreground(app: &AppHandle, space: &str, generation: u64) {
    let _ = app.emit_to(
        "main",
        "space-foreground",
        serde_json::json!({ "space": space, "generation": generation }),
    );
}

/// 正常启动的整段装配(工序 6/7;在 blocking worker 上跑,codex H4):
/// 手机启动地基一段式 `spaces::prepare_mobile_catalog`(清扫 → 重置续完 → fresh
/// 判据 → **前滚迁移**[收回「安卓不跑迁移」,下限 v28] → 严格 catalog)→ 协调器 →
/// 激活主空间(开库正道 `spaces::open_space`:NO_CREATE、先验后写)→ 事件桥。
/// 任何一步 Err 都由调用方转成封锁页(Gate),不闪退——闪退给不了指引。
fn assemble_spaces(app: &AppHandle, data_dir: std::path::PathBuf) -> Result<(), spaces::StartupError> {
    // catalog 已过严格检查,此后的装配失败(开库/激活)不是「数据坏了」的证据:
    // 归「重试」,不劝清库(codex 实现审 H1:Reset 只许由明确判断产生)。
    let retry = |message: String| spaces::StartupError {
        kind: spaces::StartupBlockKind::Retryable,
        message,
    };
    let catalog = spaces::prepare_mobile_catalog(&data_dir)?;
    let tauri::async_runtime::RuntimeHandle::Tokio(rt_handle) = tauri::async_runtime::handle();
    // 手机同刻单活跃 runtime(multispace-plan 决定④:max_live=1;切换 = 先 stop
    // 后 activate,由 Coord 编排)。
    let sup = Arc::new(SpaceSupervisor::new(rt_handle, 1));
    let coord = Coord::new(sup.clone(), data_dir, catalog);
    // 启动激活主空间(上次停在别的空间由前端 localStorage 记忆,init 时切换过去
    // ——空间记忆是设备本地 UI 状态,与桌面 zhujian.last-space 同哲学)。
    let desc = coord.descriptor(spaces::MAIN_SPACE).map_err(retry)?;
    let (rt, ev_rx) = coord.activate_from_descriptor(&desc).map_err(retry)?;
    log::info!(
        "DB_INFO user_version={} device_id={} path={}",
        db::SCHEMA_VERSION,
        desc.device_id,
        desc.path.display()
    );
    // manage 先于桥(codex 实现审二轮):桥虽已不碰 state,但事件驱动的前端命令
    // (rescan_spaces)可能在首批事件后立刻打进来——Coord 必须先就位。
    app.manage(coord);
    spawn_bridge(app.clone(), sup, rt.id.clone(), rt.generation, ev_rx);
    Ok(())
}

// ---- 空间命令面(工序 7/8,multispace-plan §15) ----

/// 一个空间的概要(空间菜单行)。手机非当前空间没有 runtime:`current` 标记前台,
/// `configured` 来自 catalog 描述符(account_id 在否);名字缺省的人话由前端定
/// (main 未命名显「默认空间」,§16.1)。
#[derive(serde::Serialize)]
struct SpaceInfo {
    id: String,
    name: Option<String>,
    configured: bool,
    current: bool,
}

#[tauri::command]
fn list_spaces(coord: State<'_, Coord>) -> Vec<SpaceInfo> {
    let (fg, _) = coord.foreground();
    coord
        .all_descriptors()
        .into_iter()
        .map(|d| SpaceInfo {
            current: d.id == fg,
            configured: d.account_id.is_some(),
            id: d.id,
            name: d.name,
        })
        .collect()
}

/// 新建空间(工序 7,§3):名字必填(§16.1 提案 A——空间名唯一录入点 = 空间自身,
/// 非 main 创建时必填)。建库即跑全部迁移 + 生独立 device_id;同步不自动配——
/// 空间=账户,进哪个账户由用户在该空间里**创号或配对**决定(phone-space-plan:
/// 手机创号与桌面对称)。创建**不激活**:前端创建成功后自行调 activate_space 切过去。
#[tauri::command]
async fn create_space(name: String, coord: State<'_, Coord>) -> Result<String, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("给空间起个名字(比如「家庭」)".into());
    }
    // 生命周期互斥(§4):建空间与配对/改名串行——catalog 变更与账户闸的世界观
    // 之间不留并发窗口。
    let _life = coord.lifecycle.lock().await;
    let (id, _path) = spaces::create_space(&coord.data_dir, &trimmed)?;
    // 严格 catalog 重扫(刚建的库也走一遍全量验):失败 = 建出的库有问题或目录
    // 被并发动过,响亮上抛(库文件留着,下次启动整体裁决)。
    coord.refresh_catalog()?;
    Ok(id)
}

/// 改空间显示名(0028 起账户内共享:同事务 UPSERT + 发射 space op,随同步跨端;
/// §16.1 join 后「给默认空间命名」的落点)。只改**当前空间**——改别的空间先切过去
/// (手机同刻单 runtime,不为改名开第二条写连接)。写成功后广播 space-name-changed
/// (§4.7 三入口之「本地改名」;codex 实现审 M2——不发则新增消费者全靠调用方自刷)。
#[tauri::command]
async fn rename_space(
    space_id: String,
    name: String,
    app: AppHandle,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    let _life = coord.lifecycle.lock().await;
    let rt = coord.control_runtime(&space_id)?;
    // H1(工序 9 二审):控制命令持 rt(RW 连接)动库,登记为长命令让并发切换的
    // stop 等它收场后再放行下一次激活(与 pair_join 同纪律;此命令无 await,窗口极小,
    // 但纳入同一闸更一致)。
    let _op = rt.begin_op().ok_or_else(|| "空间正在停止,稍后再改名".to_string())?;
    {
        let (mut conn, mut clk) = rt.write_locks();
        // ReopenRequired 复核在锁内(space-entry-plan §3.2,codex 二轮 M2)。
        if let Some(e) = rt.restart_required() {
            return Err(format!("此空间的同步会话需要重启:{e}——切换空间后切回,或重启应用"));
        }
        spaces::set_space_name(&mut conn, &mut clk, &name)?;
    }
    let r = coord.refresh_catalog();
    drop(rt); // 先松连接,再由 _op(scope 末)通知 stop——命令侧连接清零后才放行激活。
    let _ = app.emit_to(
        "main",
        "space-name-changed",
        serde_json::json!({ "space": space_id, "generation": 0, "payload": null }),
    );
    r
}

/// 串行重扫 catalog(space-name-changed 的前端处理器专用;codex 实现审 H1):重扫
/// 从事件桥挪进命令面——refresh_catalog 内部有覆盖 load+swap 的重载互斥,失败响亮
/// 在返回值上(不许「让 _ = 」吞掉后照发「已刷新」)。
#[tauri::command]
async fn rescan_spaces(coord: State<'_, Coord>) -> Result<(), String> {
    coord.refresh_catalog()
}

/// 切换前台空间(工序 8,§9):返回 = 本地 runtime 就绪(**不等网络**);失败已
/// 回滚旧空间。切换成功广播 "space-foreground"(捕获目标可见性的数据源)。
#[tauri::command]
async fn activate_space(
    space_id: String,
    app: AppHandle,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    let result = coord.switch_to(&space_id).await;
    match result {
        Ok(None) => Ok(()), // 已在目标空间,幂等。
        Ok(Some((rt, ev_rx))) => {
            let generation = rt.generation;
            spawn_bridge(app.clone(), coord.sup.clone(), rt.id.clone(), generation, ev_rx);
            emit_foreground(&app, &space_id, generation);
            Ok(())
        }
        Err(e) => {
            // 回滚激活出的 runtime 也要接桥;其代次随广播立水位。
            let bridged = bridge_pending(&app, &coord);
            let (fg, _) = coord.foreground();
            let generation = match &bridged {
                Some((space, generation)) if *space == fg => *generation,
                _ => 0,
            };
            emit_foreground(&app, &fg, generation);
            Err(e)
        }
    }
}

/// 深链接按账户找空间(4c):返回本机装的、account_id==acc 的空间 id(无=None);链接
/// 的 acc= 分支用它把跨设备账户身份映射到本机 space id,再交前端 activate_space 切过去。
#[tauri::command]
fn find_space_by_account(account_id: String, coord: State<'_, Coord>) -> Result<Option<String>, String> {
    coord.space_id_for_account(&account_id)
}

/// 前台空间 id(前端启动对账用;运行中变更走 "space-foreground" 事件)。
#[tauri::command]
fn foreground_space(coord: State<'_, Coord>) -> String {
    coord.foreground().0
}

/// 重置空间(epoch-plan §7):清除本机该空间副本,之后配对重新加入。**前端义务
/// (multispace §20 门 4)**:二段确认红字(本机该空间数据将删除;须有另一台在线
/// 完整副本;旧 device_id 报运营者吊销)后才许调;完成后引导回「加入空间」配对流。
/// 前台被重置时前台落回 main(main 自己重置 = 原地重建 fresh 空库),随
/// "space-foreground" 广播;文件步失败该空间本进程内封锁,重启自动走恢复路径。
#[tauri::command]
async fn reset_space(
    space_id: String,
    app: AppHandle,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    let _life = coord.lifecycle.lock().await;
    match coord.reset_space(&space_id).await {
        Ok(None) => Ok(()),
        Ok(Some((rt, ev_rx))) => {
            let generation = rt.generation;
            let fg = rt.id.clone();
            spawn_bridge(app.clone(), coord.sup.clone(), fg.clone(), generation, ev_rx);
            emit_foreground(&app, &fg, generation);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// 跨空间移动(cross-space-move-plan §2.7 安卓入口):源=前端「点击时看到的空间」
/// (= 前台),目标由用户在选择器里按 space_id 选。全部后端验证在 coord.move_between
/// 内(源=前台闸/目标完全 Stopped/新鲜 catalog 无 veto/图字节预算),命令层只透传
/// ——**不在此再拿 lifecycle**(move_between 内部已拿双锁,tokio mutex 不可重入)。
/// 结果五分道(zhujian_core::move_item::MoveResult),前端按 outcome 分道处理。
#[tauri::command]
async fn move_item_to_space(
    space_id: String,
    target_space_id: String,
    item_id: String,
    coord: State<'_, Coord>,
) -> Result<zhujian_core::move_item::MoveResult, String> {
    coord.move_between(&space_id, &target_space_id, &item_id).await
}

/// 手动「全部同步」(工序 8,§7 lean-B):single-flight,遍历全部已配对空间各出
/// 一份本轮结果(前台=现状快照,其余=停旧起新各追赶一次),只在内存;进度走
/// "sync-all-progress"。UI 绝不显示「全部同步完成」——只显示「试了 N 个、M 个
/// 有进展、X 个超时」(§12);收尾恢复前台失败也在回执里如实带出。
#[tauri::command]
async fn sync_all_spaces(app: AppHandle, coord: State<'_, Coord>) -> Result<SyncAllReport, String> {
    let progress_app = app.clone();
    let result = coord
        .sync_all(move |space, done, total| {
            let _ = progress_app.emit_to(
                "main",
                "sync-all-progress",
                serde_json::json!({ "space": space, "done": done, "total": total }),
            );
        })
        .await;
    // 恢复前台激活出的 runtime 接桥;其代次随广播立水位。
    let bridged = bridge_pending(&app, &coord);
    let (fg, _) = coord.foreground();
    let generation = match &bridged {
        Some((space, generation)) if *space == fg => *generation,
        _ => 0,
    };
    emit_foreground(&app, &fg, generation);
    // 收尾通知刷名兜底(space-name-sync-plan §4.7):遍历期间非当前空间的临时
    // session 若收到远端改名,其事件桥早随 session 结束而撤——发一枚事件,前端
    // 会经 `rescan_spaces` 串行重扫后重查(重扫不在这里做,与桥同纪律)。
    let _ = app.emit_to(
        "main",
        "space-name-changed",
        serde_json::json!({ "space": fg, "generation": generation, "payload": null }),
    );
    result
}

// ---- 业务命令面(显式 space_id = 前端「点击时看到的空间」,§16.2 提案 B) ----

/// 捕获一条灵感(born_stage='inbox')——与桌面捕获同一条编排路。落库目标 =
/// 点「记下」那刻的前台空间,后端在协调状态内复核(切换中响亮拒、目标已变响亮拒、
/// 全部同步中取消遍历恢复前台后执行)。
#[tauri::command]
async fn capture_idea(
    space_id: String,
    content: String,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord.write(&space_id, |conn, clock| notes::capture(conn, clock, &content)).await
}

/// 捕获一条待办(born_stage='todo')——task::create 固定生 todo、frindex 置列首。
#[tauri::command]
async fn capture_todo(
    space_id: String,
    content: String,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord
        .write(&space_id, |conn, clock| task::create(conn, clock, &content, None, None, None))
        .await
}

// §9「未配对非 main 空间禁一切业务写」的闸已随「空间两来路」连根删除
// (space-entry-plan §4,codex 一轮 M4 已核:WriterLease/目标复核/phase/账户唯一
// 均不依赖它):「新建空间」= 立即可写的纯本地本子,同步唯一路 = 创号;「为加入
// 账户准备空槽」的旧场景改走隐式 `.joining-*` staging(coord::join_space),用户
// 永远看不到空槽——「配对失败就清库不丢内容」由 staging 不可见性天然成立。

/// 任务行勾「标完成」= task::transition(id,"done")。done→done / 不存在 / 已归档 /
/// 远端抢先改态,一律响亮拒——前端收到错误就刷新时间轴(android-plan §2 必改②)。
#[tauri::command]
async fn complete_task(
    space_id: String,
    id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::transition(conn, clock, &id, "done")).await
}

/// 一枚标签(时间轴 chip 展示与归类选择器共用;color 为 `#RRGGBB` 或 null=无色)。
#[derive(serde::Serialize)]
struct TopicItem {
    id: String,
    title: String,
    color: Option<String>,
}

impl From<repo::TagRef> for TopicItem {
    fn from(t: repo::TagRef) -> Self {
        TopicItem { id: t.id, title: t.title, color: t.color }
    }
}

/// 一张配图的元数据(id + 「图N」编号 + MIME,不带字节;删过的编号留洞、永不重排)。
/// 字节由 `get_item_image` 按需取(可视才拉,data: URL 不小)。
#[derive(serde::Serialize)]
struct ImageMeta {
    id: String,
    seq: i64,
    mime: String,
}

/// 统一时间轴的一行:灵感+任务同列,`stage` 原样透传(六态之一)。
/// 117 起带 `images` 元数据(只列**已物化**的图——Full 下行在途的图没有行,
/// 字节到齐落行才出现,随 sync-changed 刷新自然补上)。
#[derive(serde::Serialize)]
struct TimelineItem {
    id: String,
    content: String,
    created_at: String,
    stage: String,
    /// 120 起随行带出(卡片操作面板显示当前真值,禁另拼 list_tasks——两次 SELECT
    /// 非同一快照;灵感行恒 null)。
    due_on: Option<String>,
    priority: Option<i64>,
    /// 完成时刻(RFC3339,0030 done_at):done 行据它显示「完成于」;灵感/未完成行 null。
    done_at: Option<String>,
    topics: Vec<TopicItem>,
    images: Vec<ImageMeta>,
}

/// 统一时间轴(repo::live_timeline 单一查询入口)。读也显式 space_id:全部同步
/// 遍历中只读直读前台库(数据静止,读不打断遍历);切换瞬态响亮拒,前端切换
/// 完成后重拉。
#[tauri::command]
fn list_timeline(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TimelineItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::live_timeline(conn).map_err(|e| e.to_string())?;
        // 批量取图元数据(单条 JOIN 按 item_id 分组),替代逐行 list_item_images 的
        // N+1;两条查询在同一把连接锁下即同一快照。
        let mut images = repo::live_timeline_images(conn).map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let images = images
                    .remove(&r.id)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|i| ImageMeta { id: i.id, seq: i.seq, mime: i.mime })
                    .collect();
                TimelineItem {
                    id: r.id,
                    content: r.content,
                    created_at: r.created_at,
                    stage: r.stage,
                    due_on: r.due_on,
                    priority: r.priority,
                    done_at: r.done_at,
                    topics: r.topics.into_iter().map(TopicItem::from).collect(),
                    images,
                }
            })
            .collect())
    })
}

/// 一张图的字节,直接给 `data:` URL(前端 `img.src` 即用);不存在 = 响亮错,
/// 无占位图(fail-fast——远端删图与本地刷新之间的窗口极窄,下次刷新即消失)。
#[tauri::command]
fn get_item_image(space_id: String, image_id: String, coord: State<'_, Coord>) -> Result<String, String> {
    // 锁内只读字节,Base64 编码在锁外做——with_read 持前台相位锁+库锁,大图在锁内
    // 编码会拖住切换与写命令。
    let (bytes, mime) = coord.with_read(&space_id, |conn| {
        repo::item_image_data(conn, &image_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("图片不存在:{image_id}"))
    })?;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

// ---- 全功能业务命令面(119 底座:桌面业务命令 1:1 上机,UI 渐进接线) ----
//
// 命令名/参数/返回形状与桌面壳逐字段一致(未来手机 UI 可对齐桌面视图的代码模式),
// 编排全在 core(notes/task/images/repo),这里只是 coord 正道的薄包装:
// - 写命令走 `coord.write`(§16.2 提案 B:显式携带「点击时看到的空间」,切换中
//   响亮拒、全部同步中取消遍历恢复前台后执行;148 起零账户前置闸——space-entry-plan
//   删 §9「未配对非 main 禁写」,任何空间即建即写);
// - 读命令走 `coord.with_read`(遍历中只读直读、切换瞬态拒)。
// 刻意不搬:delete_note(inbox 硬删原语,桌面注释明言「别再给 UI 接回硬删」,只服务
// 桌面 e2e 清库)、list_inbox/list_processed(㊲ 起被 list_ideas 合并取代的旧投影,
// 桌面留着是历史契约)。sync_create_account/sync_pair_start 已随 phone-space-plan
// 补齐(对称升格,96 的旧边界作废);move_item_to_space 已随 136 上机(本文件上方,
// cross-space-move-plan §2.7)。

/// 一条灵感(未归类+已归类合并;stage 'inbox'|'filed',topics 空 = 无标签)。
/// 与桌面 ProcessedItem 同形。
#[derive(serde::Serialize)]
struct IdeaItem {
    id: String,
    content: String,
    created_at: String,
    stage: String,
    topics: Vec<TopicItem>,
}

impl From<repo::OrganizedRow> for IdeaItem {
    fn from(n: repo::OrganizedRow) -> Self {
        IdeaItem {
            id: n.id,
            content: n.content,
            created_at: n.created_at,
            stage: n.stage,
            topics: n.topics.into_iter().map(TopicItem::from).collect(),
        }
    }
}

/// 全部活着的灵感(最新在前)——灵感视图的数据源。
#[tauri::command]
fn list_ideas(space_id: String, coord: State<'_, Coord>) -> Result<Vec<IdeaItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::live_ideas(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(IdeaItem::from).collect())
    })
}

/// 灵感回收站(archived_at 轴,最新在前)。
#[tauri::command]
fn list_archived(space_id: String, coord: State<'_, Coord>) -> Result<Vec<IdeaItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::idea_trash(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(IdeaItem::from).collect())
    })
}

/// 灵感流转统计(纯派生只算不存;week_start = 前端按本地周一换算的 UTC RFC3339,
/// 后端从不算本地时间——与 due_on 同哲学)。
#[derive(serde::Serialize)]
struct IdeaStatsItem {
    captured_week: i64,
    born_inbox: i64,
    converted: i64,
}

#[tauri::command]
fn idea_stats(space_id: String, week_start: String, coord: State<'_, Coord>) -> Result<IdeaStatsItem, String> {
    coord.with_read(&space_id, |conn| {
        let s = repo::idea_stats(conn, &week_start).map_err(|e| e.to_string())?;
        Ok(IdeaStatsItem {
            captured_week: s.captured_week,
            born_inbox: s.born_inbox,
            converted: s.converted,
        })
    })
}

/// 一条搜索命中(status = 前端视图词汇:inbox/processed/task/archived/sealed)。
#[derive(serde::Serialize)]
struct SearchHitItem {
    id: String,
    content: String,
    created_at: String,
    status: String,
    topics: Vec<String>,
}

/// 全局搜索(连历史、覆盖灵感/任务/回收站/归档册)。空词响亮拒,不倒全库。
#[tauri::command]
fn search_notes(space_id: String, query: String, coord: State<'_, Coord>) -> Result<Vec<SearchHitItem>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("搜索词不能为空".to_string());
    }
    coord.with_read(&space_id, |conn| {
        let rows = repo::search_items(conn, &q).map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|h| SearchHitItem {
                id: h.id,
                content: h.content,
                created_at: h.created_at,
                status: h.status,
                topics: h.topics,
            })
            .collect())
    })
}

/// 编辑条目正文(全 stage;旧版本先入 item_revisions,历史级不可变性)。
#[tauri::command]
async fn edit_note(
    space_id: String,
    id: String,
    content: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::edit(conn, clock, &id, &content)).await
}

/// 一个被替换掉的旧版本。
#[derive(serde::Serialize)]
struct RevisionItem {
    content: String,
    archived_at: String,
}

/// 条目的编辑历史(最新在前;当前文本在条目自身上)。
#[tauri::command]
fn list_note_history(space_id: String, id: String, coord: State<'_, Coord>) -> Result<Vec<RevisionItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::item_revisions(conn, &id).map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| RevisionItem { content: r.content, archived_at: r.archived_at })
            .collect())
    })
}

/// 灵感删除 = 软删进回收站(73 规则:销毁只在回收站里发生)。
#[tauri::command]
async fn archive_note(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::archive(conn, clock, &id)).await
}

/// 从回收站恢复灵感(回到冻结时的 stage)。
#[tauri::command]
async fn restore_note(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::restore(conn, clock, &id)).await
}

/// 彻底删除一条回收站里的灵感(二次确认后的那一步;只有已在回收站的能删)。
#[tauri::command]
async fn purge_note(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::purge(conn, clock, &id)).await
}

/// 清空灵感回收站,返回删除条数。
#[tauri::command]
async fn purge_archived(space_id: String, coord: State<'_, Coord>) -> Result<usize, String> {
    coord.write(&space_id, |conn, clock| notes::purge_all_archived(conn, clock)).await
}

/// 灵感转待办(翻 stage 零副本,单实体 ㉜)。返回任务 id(= 条目自身 id)。
#[tauri::command]
async fn promote_note_to_task(
    space_id: String,
    id: String,
    title: String,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord
        .write(&space_id, |conn, clock| notes::promote_to_task(conn, clock, &id, &title))
        .await
}

/// 待办撤回为灵感(仅 todo 列;回到转待办前的灵感形态)。
#[tauri::command]
async fn revert_task_to_inbox(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::revert_task_to_inbox(conn, clock, &id)).await
}

/// 给灵感挂标签:已有标签给 topic_id,新标签给 new_title(二选一)。返回标签 id。
#[tauri::command]
async fn file_note_to_topic(
    space_id: String,
    id: String,
    topic_id: Option<String>,
    new_title: Option<String>,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord
        .write(&space_id, |conn, clock| {
            notes::file_to_topic(conn, clock, &id, topic_id.as_deref(), new_title.as_deref())
        })
        .await
}

/// 摘掉灵感的一个标签(幂等;去掉最后一个标签会把「已整理」退回「未归类」)。
#[tauri::command]
async fn remove_note_topic(
    space_id: String,
    id: String,
    topic_id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord
        .write(&space_id, |conn, clock| notes::remove_topic(conn, clock, &id, &topic_id))
        .await
}

// ---- 任务(看板能力;title=content、status=stage 的桌面前端契约照搬) ----

/// 一张看板卡(与桌面 TaskItem 同形)。
#[derive(serde::Serialize)]
struct TaskItem {
    id: String,
    title: String,
    status: String,
    due_on: Option<String>,
    priority: Option<i64>,
    sealed_at: Option<String>,
    /// 完成时刻(RFC3339,0030 done_at),null = 未知老卡。归档册按 COALESCE(done_at,
    /// sealed_at) 排序/显示(完成日优先),看板已完成卡走 list_timeline 显示。只增不清。
    done_at: Option<String>,
    topics: Vec<TopicItem>,
}

impl From<repo::TaskRow> for TaskItem {
    fn from(t: repo::TaskRow) -> Self {
        TaskItem {
            id: t.id,
            title: t.content,
            status: t.stage,
            due_on: t.due_on,
            priority: t.priority,
            sealed_at: t.sealed_at,
            done_at: t.done_at,
            topics: t.topics.into_iter().map(TopicItem::from).collect(),
        }
    }
}

/// 全部活跃任务(前端按 status 分列;列内序 = 后端紧迫度序)。
#[tauri::command]
fn list_tasks(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TaskItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::list_tasks(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(TaskItem::from).collect())
    })
}

/// 任务回收站(最近删除在前;各自保留删除前的 status)。
#[tauri::command]
fn list_archived_tasks(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TaskItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::archived_tasks(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(TaskItem::from).collect())
    })
}

/// 成就归档册(sealed_at 非 null,最近归档在前)。
#[tauri::command]
fn list_sealed_tasks(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TaskItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::sealed_tasks(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(TaskItem::from).collect())
    })
}

/// 新建任务(生而 todo、置列首;due/priority/标签可选,整体原子)。返回 id。
/// (capture_todo 是它的极简别名——只有标题;保留两个入口不合并,捕获语义
/// 不该背上看板参数。)
#[tauri::command]
async fn create_task(
    space_id: String,
    title: String,
    due_on: Option<String>,
    priority: Option<i64>,
    topic_id: Option<String>,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord
        .write(&space_id, |conn, clock| {
            task::create(conn, clock, &title, due_on.as_deref(), priority, topic_id.as_deref())
        })
        .await
}

/// 改任务标题(活跃任务;空标题/已删/不存在响亮拒)。
#[tauri::command]
async fn rename_task(
    space_id: String,
    id: String,
    title: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::rename(conn, clock, &id, &title)).await
}

/// 任务换列(todo/doing/confirming/done 自由流转;非法迁移/过期视图响亮拒)。
#[tauri::command]
async fn update_task_status(
    space_id: String,
    id: String,
    to: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::transition(conn, clock, &id, &to)).await
}

/// 列内/跨列拖动排序(无过滤的强契约路;ordered_ids = 目标列完整新序)。
#[tauri::command]
async fn reorder_task(
    space_id: String,
    id: String,
    from_status: String,
    to_status: String,
    base_target_ids: Vec<String>,
    ordered_ids: Vec<String>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord
        .write(&space_id, |conn, clock| {
            task::reorder(conn, clock, &id, &from_status, &to_status, &base_target_ids, &ordered_ids)
        })
        .await
}

/// 过滤视图下的拖动排序(前端只见可见子集,后端 visible-merge 合回全列)。
#[tauri::command]
async fn reorder_task_visible(
    space_id: String,
    id: String,
    from_status: String,
    to_status: String,
    base_visible_ids: Vec<String>,
    visible_after: Vec<String>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord
        .write(&space_id, |conn, clock| {
            task::reorder_visible(
                conn,
                clock,
                &id,
                &from_status,
                &to_status,
                &base_visible_ids,
                &visible_after,
            )
        })
        .await
}

/// 设/清任务截止日(用户本地日历日 `YYYY-MM-DD`,null=清)。
#[tauri::command]
async fn set_task_due(
    space_id: String,
    id: String,
    due_on: Option<String>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::set_due(conn, clock, &id, due_on.as_deref())).await
}

/// 设/清任务优先级(1/2/3=低/中/高,null=未设)。
#[tauri::command]
async fn set_task_priority(
    space_id: String,
    id: String,
    priority: Option<i64>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::set_priority(conn, clock, &id, priority)).await
}

/// 给任务挂一个标签(M:N,幂等)。
#[tauri::command]
async fn add_task_topic(
    space_id: String,
    id: String,
    topic_id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::add_topic(conn, clock, &id, &topic_id)).await
}

/// 摘掉任务的一个标签(幂等)。
#[tauri::command]
async fn remove_task_topic(
    space_id: String,
    id: String,
    topic_id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::remove_topic(conn, clock, &id, &topic_id)).await
}

/// 任务删除 = 软删进回收站(可恢复)。
#[tauri::command]
async fn archive_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::archive(conn, clock, &id)).await
}

/// 从回收站恢复任务(回原列)。
#[tauri::command]
async fn restore_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::restore(conn, clock, &id)).await
}

/// 彻底删除一条回收站里的任务。
#[tauri::command]
async fn purge_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::purge(conn, clock, &id)).await
}

/// 清空任务回收站,返回删除条数。
#[tauri::command]
async fn purge_archived_tasks(space_id: String, coord: State<'_, Coord>) -> Result<usize, String> {
    coord.write(&space_id, |conn, clock| task::purge_all(conn, clock)).await
}

/// 已完成任务入成就册(sealed_at 轴:可查不可删,与回收站互斥)。
#[tauri::command]
async fn seal_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::seal(conn, clock, &id)).await
}

/// 一键归档「已完成」列全部任务,返回条数(0=列本来就空)。
#[tauri::command]
async fn seal_done_tasks(space_id: String, coord: State<'_, Coord>) -> Result<usize, String> {
    coord.write(&space_id, |conn, clock| task::seal_all(conn, clock)).await
}

/// 取消归档:回看板「已完成」列末尾(想删须先取消归档再走两段式)。
#[tauri::command]
async fn unseal_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::unseal(conn, clock, &id)).await
}

// ---- 标签(topics;「重命名只改可见中文」的铁律照旧,内部标识符不动) ----

/// 全部标签(归类选择器/标签管理的数据源)。
#[tauri::command]
fn list_topics(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TopicItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::all_topics(conn).map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|t| TopicItem { id: t.id, title: t.title, color: t.color })
            .collect())
    })
}

/// 一枚标签与名下已归类灵感(标签视图的行;任务另由前端按 topics 交叉)。
#[derive(serde::Serialize)]
struct TopicTreeItem {
    id: String,
    title: String,
    color: Option<String>,
    /// 手动排序键(0031 frindex)或 null=未定序——标签管理面据它排序/拖动定位。
    position: Option<String>,
    /// 标签类型自由文本(0031)或 null=无类型——标签管理面据它显徽标/设类型。
    kind: Option<String>,
    notes: Vec<TopicNoteItem>,
}

/// 标签名下的一条灵感(只读展示)。
#[derive(serde::Serialize)]
struct TopicNoteItem {
    id: String,
    content: String,
    created_at: String,
}

fn topic_tree_item(t: repo::TopicTree) -> TopicTreeItem {
    TopicTreeItem {
        id: t.id,
        title: t.title,
        color: t.color,
        position: t.position,
        kind: t.kind,
        notes: t
            .notes
            .into_iter()
            .map(|n| TopicNoteItem { id: n.id, content: n.content, created_at: n.created_at })
            .collect(),
    }
}

/// 按标签浏览(只含名下有灵感的标签)。
#[tauri::command]
fn list_topic_tree(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TopicTreeItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::topics_with_notes(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(topic_tree_item).collect())
    })
}

/// 标签管理视图(含空标签,最近变动在前——空的才能被改名/删除)。
#[tauri::command]
fn list_topics_full(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TopicTreeItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::all_topics_with_notes(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(topic_tree_item).collect())
    })
}

/// 新建标签(空名响亮拒)。返回 id。
#[tauri::command]
async fn create_topic(space_id: String, title: String, coord: State<'_, Coord>) -> Result<String, String> {
    coord.write(&space_id, |conn, clock| notes::create_topic(conn, clock, &title)).await
}

/// 标签改名。
#[tauri::command]
async fn update_topic(
    space_id: String,
    id: String,
    title: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::rename_topic(conn, clock, &id, &title)).await
}

/// 设/清标签 chip 颜色(`#RRGGBB`,null=清)。
#[tauri::command]
async fn set_topic_color(
    space_id: String,
    id: String,
    color: Option<String>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord
        .write(&space_id, |conn, clock| notes::set_topic_color(conn, clock, &id, color.clone()))
        .await
}

/// 删标签(只删投影与挂链,条目本身不动)。
#[tauri::command]
async fn delete_topic(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::delete_topic(conn, clock, &id)).await
}

/// 合并标签:来源各标签名下条目并入目标(集合并),来源删除,可顺带改名。
#[tauri::command]
async fn merge_topics(
    space_id: String,
    source_ids: Vec<String>,
    target_id: String,
    new_title: Option<String>,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord
        .write(&space_id, |conn, clock| {
            notes::merge_topics(conn, clock, &source_ids, &target_id, new_title.as_deref())
        })
        .await
}

/// 标签手动重排(0031 frindex):把 `id` 挪到 `prev_id`(None=列首)与 `next_id`
/// (None=列尾)之间,只写被拖那枚的 position。标签平铺无父子,全体同层。
#[tauri::command]
async fn reorder_topic(
    space_id: String,
    id: String,
    prev_id: Option<String>,
    next_id: Option<String>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord
        .write(&space_id, |conn, clock| {
            notes::reorder_topic(conn, clock, &id, prev_id.as_deref(), next_id.as_deref())
        })
        .await
}

/// 设/清标签类型自由文本(0031;null=清、规范非空 ≤100 字节且禁控制字符)。
#[tauri::command]
async fn set_topic_kind(
    space_id: String,
    id: String,
    kind: Option<String>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::set_topic_kind(conn, clock, &id, kind.clone())).await
}

// ---- 统一回收站(120:灵感+任务合并一屏,repo::trash_items 单查询单快照) ----

/// 回收站的一行(stage=冻结在入站前的原 stage,恢复路由与类型印由它派生;
/// archived_at=跨两类可比的删除时间轴)。
#[derive(serde::Serialize)]
struct TrashItem {
    id: String,
    content: String,
    created_at: String,
    archived_at: String,
    stage: String,
    topics: Vec<TopicItem>,
}

/// 统一回收站(最近删除在前)。恢复/彻底删仍走分域命令(restore_note/restore_task
/// /purge_note/purge_task),前端按 stage 分发。
#[tauri::command]
fn list_trash(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TrashItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::trash_items(conn).map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|r| TrashItem {
                id: r.id,
                content: r.content,
                created_at: r.created_at,
                archived_at: r.archived_at,
                stage: r.stage,
                topics: r.topics.into_iter().map(TopicItem::from).collect(),
            })
            .collect())
    })
}

/// 一次清空统一回收站(灵感+任务,core 单事务逐条 tombstone;codex 120 设计审 H2:
/// 绝不拆成两条不可回滚的销毁命令)。返回删除条数。
#[tauri::command]
async fn purge_all_trash(space_id: String, coord: State<'_, Coord>) -> Result<usize, String> {
    coord.write(&space_id, |conn, clock| notes::purge_all_trash(conn, clock)).await
}

/// 给任务按标题挂标签(同名复用、缺则新建,core 单事务原子;codex 120 设计审 M9:
/// 禁 create_topic+add_task_topic 两步——半途失败留空标签)。返回标签 id。
#[tauri::command]
async fn add_task_topic_by_title(
    space_id: String,
    id: String,
    title: String,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord.write(&space_id, |conn, clock| task::add_topic_by_title(conn, clock, &id, &title)).await
}

// ---- 配图(挂图/列表/删图;get_item_image 取字节在上方时间轴区) ----

/// 给条目挂一张图(字节 base64 过 IPC;编号「图N」永不复用)。返回元数据。
#[tauri::command]
async fn add_item_image(
    space_id: String,
    item_id: String,
    mime: String,
    data_b64: String,
    coord: State<'_, Coord>,
) -> Result<ImageMeta, String> {
    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("图片数据解码失败:{e}"))?;
    let (id, seq) = coord
        .write(&space_id, |conn, clock| images::attach(conn, clock, &item_id, &bytes, &mime))
        .await?;
    Ok(ImageMeta { id, seq, mime })
}

/// 一个条目的配图元数据(编号升序;删过的编号留洞)。
#[tauri::command]
fn list_item_images(space_id: String, item_id: String, coord: State<'_, Coord>) -> Result<Vec<ImageMeta>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::list_item_images(conn, &item_id).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(|r| ImageMeta { id: r.id, seq: r.seq, mime: r.mime }).collect())
    })
}

/// 删一张配图(编号退役不重排;不存在响亮错)。
#[tauri::command]
async fn delete_item_image(space_id: String, image_id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| images::remove(conn, clock, &image_id)).await
}

// ---- 同步命令面(与桌面对称:创号 / 邀请 / 加入 / 状态 / 改服务器,phone-space-plan) ----

/// 同步状态快照(当前空间;变更另有 "sync-status" 事件实时推送)。非前台空间没有
/// runtime,拒——前端只该问当前空间。
#[tauri::command]
fn sync_status(space_id: String, coord: State<'_, Coord>) -> Result<transport::SyncStatus, String> {
    let rt = coord.sup.get(&space_id)?;
    let s = rt.status.lock().expect("sync status mutex poisoned").clone();
    Ok(s)
}

/// 创建同步账户(账户首台,与桌面对称;open-signup 无感创号——账户 ULID 由
/// core 自生成,无码)。机械在 `coord::create_account`(lifecycle 锁+begin_op+
/// shutdown 取消);返回结构化结果——core 一旦提交,恢复码必达前端仪式页,
/// post-commit 失败只在 `post_commit_error` 旁路报告(codex r1 #5,绝不吞码)。
/// 前端拿到码必须走强制仪式(展示+警示+回输核对)后才许关闭。
#[tauri::command]
async fn sync_create_account(
    space_id: String,
    server_url: String,
    app: AppHandle,
    coord: State<'_, Coord>,
) -> Result<coord::CreateAccountOutcome, String> {
    let mut out = coord.create_account(&space_id, &server_url).await?;
    // emit 失败同样并进 post_commit_error(实现审 M2):码在结构里,永不因收尾
    // 失败变整体 Err。
    if let Err(e) = app.emit_to("main", "space-configured", &space_id) {
        let msg = format!("配置事件未送达前端:{e}(空间列表可能未刷新,重启应用可恢复)");
        out.post_commit_error = Some(match out.post_commit_error.take() {
            Some(prev) => format!("{prev};{msg}"),
            None => msg,
        });
    }
    Ok(out)
}

/// 发起配对(老设备侧,出配对码;与桌面对称)。返回码 + 本空间服务器地址(同
/// runtime 原子取,实现审 M3——码不含地址,出码页两项都要展示,对方两项都要填)。
#[tauri::command]
async fn sync_pair_start(
    space_id: String,
    coord: State<'_, Coord>,
) -> Result<coord::PairStartOutcome, String> {
    coord.pair_start(&space_id).await
}

/// 用配对码加入账户(新设备侧;107 起也可扫码,同一条路)。**space-entry-plan §2
/// 起只接受 main**(后端不变量,不是 UI 藏按钮):非 main 空间的两条来路是「新建
/// =纯本地本子(同步唯一路=创号)」与「加入空间」(`join_space`,隐式 staging 槽,
/// 不收目标 space_id)——直接 invoke 非 main 一律拒。工序 7 起带**两阶段账户唯一
/// 闸**(§4):gate 回调由 core 卡在「拿到 Grant 之后、配置落库之前」,磁盘现扫 +
/// join reservation 一并裁决——两个本地空间绑同一账户会互灌数据、污染共享副本,
/// 响亮中止、配置一个键都不写(服务器端孤儿注册等 revoke 清理)。
#[tauri::command]
async fn sync_pair_join(
    space_id: String,
    server_url: String,
    code: String,
    app: AppHandle,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    pair_join_target_gate(&space_id)?;
    // 账户绑定互斥(§4 全局 account-binding mutex):同刻只配一个空间,可跨网络
    // 长等;不阻塞捕获/浏览/切空间。
    let _life = coord.lifecycle.lock().await;
    let rt = coord.control_runtime(&space_id)?;
    // H1(工序 9 二审):把配对登记为可被 stop 等待/取消的长命令。切走本空间会
    // stop 它——stop 靠 op guard 等我们放手旧 runtime/连接后才放行下一次激活,堵住
    // 「配对未结束就切走再切回、开出第二条写连接」(旧路径跨 await 长持 Arc 违反
    // supervisor 契约)。空间正在停止则拒。
    let _op = rt.begin_op().ok_or_else(|| "空间正在停止,无法配对(稍后重试)".to_string())?;
    // 取消订阅用 wait_for(|v| *v):先看当前值再等变化——若切换的 shutdown 恰落在
    // subscribe 之前,changed() 会把 true 当「已见」永等不到(codex 二审 M1)。
    let mut cancel = rt.subscribe_shutdown();
    let gate_cancel = rt.subscribe_shutdown();
    let coord_ref: &Coord = &coord;
    let gate_space = space_id.clone();
    let join = transport::pair_join(&rt.db, &server_url, &code, move |acc: &str| {
        // 磁盘现扫 + join reservation 的权威裁决(space-entry-plan §3.5):读不出
        // 某库 = fail-closed,配对中止。
        coord_ref.account_free(Some(&gate_space), acc)?;
        // approve/Enroll 前**最后一刻**查取消(放扫描之后,窗口最紧;残留仅此后到
        // send(Enroll) 的 µs 级)。切换已请求 = 不发 Enroll、不烧身份;Enroll 已发后
        // 的取消 = 本机仍未配置、服务器可能已注册 → §19 清库重配(不作过强承诺)。
        if *gate_cancel.borrow() {
            return Err("配对已取消:切换了空间".into());
        }
        Ok(())
    });
    // 切换会拉高本 runtime 的 shutdown:cancel 到即放弃配对(drop future 关 socket)。
    // biased:配对已到 save_config(pair_join 提交后已无 await、立即 Ready)时,即便
    // 同刻 shutdown 也走成功路,不把「已落库的配对」误报「已取消」(平局归 join;
    // cancel 只在 join 仍 pending 时才赢——切换确实还能取消在飞的配对)。
    let outcome: Result<(), String> = tokio::select! {
        biased;
        r = join => r,
        _ = cancel.wait_for(|v| *v) => {
            Err("配对已取消:切换了空间(切回该空间后重试)".into())
        }
    };
    // 所有路径先松开本命令对旧 runtime 的持有,再由 _op(scope 末)通知 stop——
    // _op 只持独立 tracker、不持连接,故此刻命令侧的 ActiveRuntime Arc 已清零,
    // stop 放行的下一次激活绝不与残留连接撞第二 writer(codex 二审 H2)。
    drop(rt);
    outcome?;
    // account_id 落库了:catalog 快照刷新;poke 现任 runtime 上线(配对期间用户
    // 切走再切回的话,现任已是新代次,同样被 poke 到)。
    coord.refresh_catalog()?;
    if let Ok(rt2) = coord.sup.get(&space_id) {
        let _ = rt2.control.send(transport::Control::Reconfigured).await;
    }
    let _ = app.emit_to("main", "space-configured", &space_id);
    Ok(())
    // _op 在此 drop(最后)——refresh/poke 全程它仍在,stop 一直等到这里才放行。
}

/// 配对加入的目标闸(space-entry-plan §2,后端不变量、不是 UI 藏按钮):只接受
/// main——非 main 空间的两条来路是「新建=纯本地本子(同步唯一路=创号)」与
/// 「加入空间」(隐式 staging 槽,不收目标 space_id);直接 invoke 非 main 必拒。
fn pair_join_target_gate(space_id: &str) -> Result<(), String> {
    if space_id != spaces::MAIN_SPACE {
        return Err(
            "这个空间不走配对加入:想把别处的账户带到这台手机,请用「加入空间」;本空间要多端同步请在「同步」里创建账户"
                .into(),
        );
    }
    Ok(())
}

/// 「加入空间」(space-entry-plan §3):本设备加入一个已在别处存在的账户——隐式
/// `.joining-*` staging 槽上完成配对 + 引导,成功才出现为正式空间。**不收目标
/// space_id**(一轮 H3:空槽不暴露成用户可见空间);扫码/输码同一条路。进度走
/// "join-progress" 事件(带 attempt_id,前端只接受当前 attempt、terminal 后拒迟到
/// 事件)。结果两分道:Integrated(前端走草稿感知切换)/ PublishedNeedsRestart
/// (空间已真实存在,只提示「重启后出现」,绝不谎报失败)。
#[tauri::command]
async fn join_space(
    server_url: String,
    code: String,
    attempt_id: String,
    app: AppHandle,
    coord: State<'_, Coord>,
) -> Result<coord::JoinOutcome, String> {
    let progress_app = app.clone();
    let aid = attempt_id.clone();
    let out = coord
        .join_space(&server_url, &code, move |phase, received, total| {
            let _ = progress_app.emit_to(
                "main",
                "join-progress",
                serde_json::json!({
                    "attempt_id": aid, "phase": phase, "received": received, "total": total
                }),
            );
        })
        .await?;
    Ok(out)
}

/// 取消进行中的「加入空间」(只在 BootCommitted 前生效;提交与取消同时就绪时
/// 成功优先)。取消结果(含清理失败的如实报)在 join_space 的返回值里。
#[tauri::command]
fn join_space_cancel(coord: State<'_, Coord>) {
    coord.request_cancel_join();
}

/// 改服务器地址(运营者迁服务器时用;须已加入账户)。写入即触发重连。
#[tauri::command]
async fn sync_set_server(
    space_id: String,
    server_url: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    let _life = coord.lifecycle.lock().await;
    let rt = coord.control_runtime(&space_id)?;
    // H1(工序 9 二审):持 rt(RW 连接)跨 control.send().await——登记为长命令,
    // 让并发切换的 stop 等它收场再放行下一次激活(否则旧连接可与再激活撞第二 writer)。
    let _op = rt.begin_op().ok_or_else(|| "空间正在停止,稍后再改服务器".to_string())?;
    {
        let conn = rt.db.lock().expect("db mutex poisoned");
        // ReopenRequired 复核在 db 锁内(codex 三轮 M2:旗与导入共临界区,锁前预检
        // 有「查后落旗抢锁」竞态——set_server 是裸 db.lock 写,不走 write_locks)。
        if let Some(e) = rt.restart_required() {
            return Err(format!("此空间的同步会话需要重启:{e}——切换空间后切回,或重启应用"));
        }
        transport::set_server(&conn, &server_url)?;
    }
    coord.refresh_catalog()?;
    // clone 出 sender 后先松 rt(连接侧清零),再发 poke;_op 持到 scope 末通知 stop。
    let ctl = rt.control.clone();
    drop(rt);
    ctl.send(transport::Control::Reconfigured)
        .await
        .map_err(|_| "同步任务未运行".to_string())
}

/// 查看恢复码(K_acc 的人眼形态;当前空间)。密钥材料不出 core(P4-a 窄公开面)。
#[tauri::command]
fn sync_recovery_code(space_id: String, coord: State<'_, Coord>) -> Result<String, String> {
    let rt = coord.sup.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    transport::recovery_code(&conn)
}

/// 系统分享薄桥的取走端(M4,android-plan §7):MainActivity 把 ACTION_SEND 的
/// 文本原子暂存在 app 数据根。取走协议(codex P4-e 轮 M2):先把 pending
/// **rename 成 consuming 接手**,读与删都对 consuming 做。分享文本只是**预填草稿**
/// (§16.2 提案 B:草稿不带目标,保存那刻才结算落库空间)。
#[tauri::command]
fn take_shared_text(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let pending = dir.join("shared_text.pending");
    let consuming = dir.join("shared_text.consuming");
    if !consuming.exists() {
        match std::fs::rename(&pending, &consuming) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        }
    }
    let text = std::fs::read_to_string(&consuming).map_err(|e| e.to_string())?;
    std::fs::remove_file(&consuming).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

/// 深链接薄桥的取走端(4c):MainActivity 把 ACTION_VIEW 的 zhujian:// URI 原子暂存在
/// app 数据根。取走协议同分享——先 rename 成 consuming 接手,读与删都对 consuming 做
/// (取走端读不到半截、并发取走幂等)。返回 URI 字符串,前端解析后定位条目。
#[tauri::command]
fn take_deep_link(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let pending = dir.join("deep_link.pending");
    let consuming = dir.join("deep_link.consuming");
    if !consuming.exists() {
        match std::fs::rename(&pending, &consuming) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        }
    }
    let url = std::fs::read_to_string(&consuming).map_err(|e| e.to_string())?;
    std::fs::remove_file(&consuming).map_err(|e| e.to_string())?;
    Ok(Some(url))
}

/// 半自动更新(106):拉 android.json 比 versionCode,更新才回条目、已最新回 null。
#[tauri::command]
async fn check_update() -> Result<Option<update::AndroidUpdate>, String> {
    let r = tauri::async_runtime::spawn_blocking(update::check)
        .await
        .map_err(|e| e.to_string())?;
    match &r {
        Ok(Some(u)) => log::info!("UPDATE_CHECK newer version={} code={}", u.version, u.version_code),
        Ok(None) => log::info!("UPDATE_CHECK up-to-date"),
        Err(e) => log::warn!("UPDATE_CHECK fail {e}"),
    }
    r
}

/// 诊断页「本机库」区:当前空间的建库 + 迁移 + 设备身份可视佐证。
#[derive(serde::Serialize)]
struct DbInfo {
    path: String,
    sqlite_version: String,
    journal_mode: String,
    user_version: i64,
    device_id: String,
    items: i64,
}

#[tauri::command]
fn db_info(space_id: String, coord: State<'_, Coord>) -> Result<DbInfo, String> {
    let rt = coord.sup.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    let q1 = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let device_id: String = conn
        .query_row("SELECT value FROM sync_meta WHERE key='device_id'", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(DbInfo {
        path: rt.path.display().to_string(),
        sqlite_version: rusqlite::version().to_string(),
        journal_mode,
        user_version: q1("PRAGMA user_version")?,
        device_id,
        items: q1("SELECT COUNT(*) FROM items")?,
    })
}

/// M3 网络栈闸门(android-plan §9):真跑 core 的密码学与传输路径。
#[tauri::command]
async fn net_probe(url: String) -> Vec<transport::ProbeStep> {
    let steps = transport::net_probe(&url).await;
    for s in &steps {
        log::info!(
            "NET_PROBE {} {} — {}",
            if s.ok { "OK  " } else { "FAIL" },
            s.name,
            s.detail
        );
    }
    steps
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // wss:// 的 TLS 提供者(android-plan §1 M2,与桌面壳同纪律):启动即装,坏了当场
    // 响亮,不留到第一次连接才在 async 命令里 panic(84 真机踩过)。
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("rustls CryptoProvider 已被安装过(依赖漂移?)");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        // 106「下载」跳系统浏览器(android 忽略 openWith 参数);capability 用
        // opener:default——㊾ 踩过 allow-open-url 配空 scope 拒所有 URL 的坑。
        .plugin(tauri_plugin_opener::init());
    // 107 扫码配对:官方扫码插件是移动端专属 crate(桌面 dev 构型里没有它)。
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            // 库进 app 私有数据目录(安卓 /data/data/<pkg>/…);schema 权威与桌面
            // 共享,不可裁(android-plan §2)。
            let data_dir = app.path().app_data_dir().expect("resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("create app data dir");
            // 单写者租约(multispace-plan §5,门 1;与桌面壳同纪律):先于开库取
            // 目录级 OS 排他锁。锁文件永不删,句柄 manage 持到进程退出。
            let lease = spaces::WriterLease::acquire(&data_dir.join("writer.lock"))
                .unwrap_or_else(|e| panic!("{e}"));
            app.manage(lease);
            // ---- 启动装配挪 blocking worker(codex 设计审 H4):前滚迁移是潜在
            // O(库大小) 的同步工作,不占启动线程——setup 只 manage「进行中」闸即返,
            // 前端轮询 startup_gate 等 ready/blocked(封锁页按 kind 分流处置)。
            // Ready 只在装配整段成功后落(codex H1:不许「闸已放行、装配死在半路」)。
            app.manage(Gate(std::sync::Mutex::new(GateStatus::Pending)));
            let handle = app.handle().clone();
            let gate_handle = handle.clone();
            // JoinHandle 必须被消费(codex 实现审 M1):worker 内任意 panic 若只是
            // 被丢弃,Gate 永远停在 Pending、前端无限「正在准备」——外包一层 async
            // 监控,panic/cancel 都翻成可见的封锁态(retryable:数据未动,重启重试)。
            tauri::async_runtime::spawn(async move {
                let joined = tauri::async_runtime::spawn_blocking(move || {
                    // #4(codex 二审):清上次进程 kill/crash 残留的明文引导快照(手机
                    // 常被系统 kill);必须在任何 transport 启动前。
                    transport::sweep_stale_boot_files(&data_dir);
                    assemble_spaces(&handle, data_dir)
                })
                .await;
                let done = match joined {
                    Ok(Ok(())) => GateStatus::Ready,
                    Ok(Err(e)) => {
                        log::error!("SPACE_GATE blocked [{}]: {}", gate_kind_str(e.kind), e.message);
                        GateStatus::Blocked { kind: gate_kind_str(e.kind), message: e.message }
                    }
                    Err(join_err) => {
                        log::error!("SPACE_GATE worker died: {join_err}");
                        GateStatus::Blocked {
                            kind: "retryable",
                            message: format!("启动任务异常中断:{join_err}"),
                        }
                    }
                };
                *gate_handle.state::<Gate>().0.lock().expect("gate mutex poisoned") = done;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_gate,
            list_spaces,
            create_space,
            rename_space,
            rescan_spaces,
            activate_space,
            foreground_space,
            reset_space,
            move_item_to_space,
            sync_all_spaces,
            capture_idea,
            capture_todo,
            list_timeline,
            get_item_image,
            complete_task,
            // 119 全功能底座:灵感
            list_ideas,
            list_archived,
            idea_stats,
            search_notes,
            edit_note,
            list_note_history,
            archive_note,
            restore_note,
            purge_note,
            purge_archived,
            promote_note_to_task,
            revert_task_to_inbox,
            file_note_to_topic,
            remove_note_topic,
            // 119 全功能底座:任务
            list_tasks,
            list_archived_tasks,
            list_sealed_tasks,
            create_task,
            rename_task,
            update_task_status,
            reorder_task,
            reorder_task_visible,
            set_task_due,
            set_task_priority,
            add_task_topic,
            remove_task_topic,
            archive_task,
            restore_task,
            purge_task,
            purge_archived_tasks,
            seal_task,
            seal_done_tasks,
            unseal_task,
            // 119 全功能底座:标签
            list_topics,
            list_topic_tree,
            list_topics_full,
            create_topic,
            update_topic,
            set_topic_color,
            delete_topic,
            merge_topics,
            reorder_topic,
            set_topic_kind,
            // 119 全功能底座:配图
            add_item_image,
            list_item_images,
            delete_item_image,
            // 120 UI 第一批的 core 加菜
            list_trash,
            purge_all_trash,
            add_task_topic_by_title,
            take_shared_text,
            take_deep_link,
            find_space_by_account,
            check_update,
            sync_status,
            sync_create_account,
            sync_pair_start,
            sync_pair_join,
            join_space,
            join_space_cancel,
            sync_set_server,
            sync_recovery_code,
            db_info,
            net_probe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use zhujian_core::clock;

    /// space-entry-plan §2 后端不变量:sync_pair_join 只接受 main——直接 invoke
    /// 非 main 必拒(不许只测按钮隐藏);main 照常放行(装机 onboarding 不变)。
    #[test]
    fn pair_join_gate_rejects_non_main() {
        assert!(pair_join_target_gate(spaces::MAIN_SPACE).is_ok());
        let err = pair_join_target_gate("01JT0000000000000000000000").unwrap_err();
        assert!(err.contains("加入空间"), "拒绝话术要指路新入口:{err}");
    }

    /// 实现审 L6:Pair 事件经统一信封桥出——space + generation 双轴与 phase/detail
    /// 字段一个不少(前端 acceptSpaced 过滤与出码页渲染都吃这个形)。
    #[test]
    fn pair_event_envelope_carries_space_generation_and_fields() {
        let v = bridge_envelope("01SPACEAAAAAAAAAAAAAAAAAAA", 7, pair_event_json("done", "新设备已加入"));
        assert_eq!(v["space"], "01SPACEAAAAAAAAAAAAAAAAAAA");
        assert_eq!(v["generation"], 7);
        assert_eq!(v["payload"]["phase"], "done");
        assert_eq!(v["payload"]["detail"], "新设备已加入");
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zj-android-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 工序 6 fresh 路:全新目录一次调用建出主库(当前 schema + 设备身份),
    /// 二次启动(已有库、恰当前版本)happy-path 直接作第一空间、身份不变(§10)。
    /// 首启中途被杀的残留(`.creating-main`)不挡道——sweep 掉重建,fresh 自愈。
    #[test]
    fn load_spaces_fresh_then_exact_reopen() {
        let dir = tmp_dir("fresh");
        std::fs::write(dir.join(".creating-main.sqlite3"), b"junk").unwrap();
        let cat = spaces::prepare_mobile_catalog(&dir).unwrap();
        assert_eq!(cat.spaces().len(), 1);
        assert_eq!(cat.main().id, "main");
        assert!(spaces::is_ulid_name(&cat.main().device_id));
        let dev = cat.main().device_id.clone();
        let cat2 = spaces::prepare_mobile_catalog(&dir).unwrap();
        assert_eq!(cat2.main().device_id, dev, "重启动身份不变");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 封锁路版本分流(codex 设计审 H1/H3):未来版 = `upgrade-required`(话术
    /// 绝不指向清库);低于手机下限(v27)= `reset-required`(1-27 老迁移不上手机)。
    #[test]
    fn load_spaces_rejects_tampered_version() {
        let dir = tmp_dir("gate");
        spaces::prepare_mobile_catalog(&dir).unwrap();
        {
            let conn = Connection::open(dir.join("notebook.sqlite3")).unwrap();
            conn.pragma_update(None, "user_version", 999).unwrap();
        }
        let err = spaces::prepare_mobile_catalog(&dir).unwrap_err();
        assert_eq!(err.kind, spaces::StartupBlockKind::UpgradeRequired);
        assert_eq!(gate_kind_str(err.kind), "upgrade-required");
        assert!(err.message.contains("比本程序"), "{}", err.message);
        assert!(!err.message.contains("清"), "升级封锁语绝不许劝清库:{}", err.message);
        {
            let conn = Connection::open(dir.join("notebook.sqlite3")).unwrap();
            conn.pragma_update(None, "user_version", 27).unwrap();
        }
        let err = spaces::prepare_mobile_catalog(&dir).unwrap_err();
        assert_eq!(err.kind, spaces::StartupBlockKind::ResetRequired);
        assert!(err.message.contains("支持下限"), "{}", err.message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 主库丢失但目录里还有正式 ULID 空间 ≠ fresh(codex M1):静默补一个空 main
    /// 会把残缺目录伪装成正常——必须封锁,且不许顺手把 main 建出来。
    #[test]
    fn load_spaces_blocks_when_main_missing_but_spaces_exist() {
        let dir = tmp_dir("m1");
        spaces::create_space(&dir, "家庭").unwrap();
        let err = spaces::prepare_mobile_catalog(&dir).unwrap_err();
        assert!(err.message.contains("不完整"), "{}", err.message);
        assert!(!dir.join("notebook.sqlite3").exists(), "封锁路不许建库");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真机升级锚(codex L3):已配账户四键 + 存量捕获(oplog 随行)的现役库,
    /// 覆盖装再启动(严格 catalog + open_space 开库正道)零迁移零损伤直通——
    /// 身份/账户/业务行/oplog 原样(v28→29 的**前滚**升级锚在 core:
    /// `prepare_mobile_catalog_forward_migrates_v28`)。
    #[test]
    fn load_spaces_preserves_existing_configured_db() {
        let dir = tmp_dir("upgrade");
        let cat = spaces::prepare_mobile_catalog(&dir).unwrap();
        let dev = cat.main().device_id.clone();
        // 「升级前」快照:oplog 指纹逐值比对,不满足于「还有 op」(codex 二轮 L2)。
        let fingerprint = |conn: &Connection| -> (i64, String) {
            let n = conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0)).unwrap();
            let last = conn
                .query_row("SELECT COALESCE(MAX(op_id),'') FROM oplog", [], |r| r.get(0))
                .unwrap();
            (n, last)
        };
        let before;
        {
            let mut conn = spaces::open_space(cat.main()).unwrap();
            let mut clk = clock::Clock::load(&conn).unwrap();
            notes::capture(&mut conn, &mut clk, "存量捕获").unwrap();
            conn.execute_batch(&format!(
                "INSERT INTO sync_meta(key,value) VALUES
                   ('account_id','01AAAAAAAAAAAAAAAAAAAAACCT'),
                   ('k_acc','{z}'),('device_key','{z}'),('server_url','wss://x');",
                z = "00".repeat(32),
            ))
            .unwrap();
            before = fingerprint(&conn);
            assert!(before.0 >= 1);
        }
        let cat2 = spaces::prepare_mobile_catalog(&dir).unwrap();
        assert_eq!(cat2.main().device_id, dev);
        assert_eq!(cat2.main().account_id.as_deref(), Some("01AAAAAAAAAAAAAAAAAAAAACCT"));
        let conn = spaces::open_space(cat2.main()).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(fingerprint(&conn), before, "启动全链不追加/不改写任何 op");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
