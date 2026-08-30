//! 朱简**两只手机壳共用的壳层**(OH-d 抽出;此前整份住在 `android/src-tauri/src/`)。
//!
//! 定位:**119 起手机 = 全功能主力端**(用户拍板「手机须能独立作唯一端」)——本 crate
//! 只做 tauri 壳的**平台无关那半**,数据层与同步全在共享 crate `zhujian-core`
//! (与桌面逐字节同一套,迁移链不可裁;151 起启动对既有库前滚迁移,下限 v28)。
//! **117 起 BlobPolicy::Full(反转 android-plan §4 M1,用户拍板)——图字节全量下行、
//! 时间轴显示配图(get_item_image)**;**phone-space-plan 起与桌面对称:可创号、
//! 可邀请设备、可当引导快照源(缺字节者拒供的防线在 core,端无关)**。
//! 111 起(multispace 工序 6)严格启动:fresh 建主库 + `SpaceCatalog::load`
//! fail-closed(已有库不迁移,版本不符 = 封锁页清库重配,multispace-plan §10/§19)。
//! 工序 7/8(multispace-plan §15):多空间——空间创建 + 两阶段配对账户唯一闸(§4)、
//! 切换 + 显式捕获目标(§9/§16.2 提案 B)+ 手动全部同步(§7 lean-B);业务命令面
//! 显式携带 `space_id`(「点击时看到的空间」),裁决全在 [`coord::Coord`]。
//! **119 全功能底座**:桌面业务命令 1:1 上机(灵感编辑/回收站/转待办/看板全流转/
//! 成就归档/标签管理/配图增删/搜索/统计),编排全在 core、此处只是 coord 正道薄包装。
//!
//! # 两只壳各自留下了什么(⛔ 别往这里搬)
//!
//! | 只在安卓壳 | 为什么 |
//! |---|---|
//! | `check_update` + `update.rs` | 分发通道是 `android.json`,鸿蒙没有对应的东西 |
//! | `take_shared_text` / `take_deep_link` | 取的是 MainActivity 那条 Intent 薄桥落的文件 |
//! | `backup_outbox_dir` | 它是**给 Kotlin 的 SAF 桥比对用的期望值**,鸿蒙侧没有那条桥 |
//! | barcode-scanner 插件 | 依赖 gate 写死 `target_os = android|ios`,鸿蒙上编不过 |
//!
//! | 只在鸿蒙壳 | 为什么 |
//! |---|---|
//! | `ohos_data_dir()` | ⛔ 那一端**不许**用 `app.path().app_data_dir()`(它会落进桌面那支) |
//! | `hilog.rs` | 日志通道不是 logcat |
//!
//! # ⭐ 承重的一条:`tauri` 依赖按 crates.io 声明
//!
//! 见 `Cargo.toml` 里那一行的头注 —— 同一份源码在两端各解析各的 tauri,靠的是
//! **各壳自己的 `[patch.crates-io]`**,不是这里做 cfg 分支。
//!
//! # 各壳的接线只有三处
//!
//! 1. `run()` 里 `setup_shell(app, data_dir, config_dir)` —— 数据目录**由壳自己算**;
//! 2. `generate_handler![zhujian_mobile::xxx, …]` —— 命令都是 `pub`,包装宏带
//!    `#[macro_export]`(tauri-macros 只对 `pub` 函数发它),跨 crate 引用得了;
//! 3. 壳自己那几条命令照旧写在壳里。


use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use crate::coord::{Coord, SyncAllReport, WriteAttempt};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::UnboundedReceiver;
use zhujian_core::spaces;
use zhujian_core::sync::supervisor::SpaceSupervisor;
use zhujian_core::sync::transport::{self, SyncEvent};
use zhujian_core::{clock, comments, db, identity, images, notes, repo, task, thumbs};

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
pub enum GateStatus {
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

pub struct Gate(std::sync::Mutex<GateStatus>);

#[tauri::command]
pub fn startup_gate(gate: State<'_, Gate>) -> GateStatus {
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
                // ⛔ **这一格刻意不转发,不是漏了**:`BootFailed` 是给「加入空间」那条
                // 前台仪式当收场判据用的(用户面 34),而**已引导**空间的报错面一个字
                // 没变 —— 同一次失败照旧走上面那条 Toast 与 `status.error`,转发它等于
                // 把同一句话对用户说两遍。⚠ 真要在这一端另做处置,先读
                // `transport::JoinBootWatch` 的头注:那两条路刻意不同。
                SyncEvent::BootFailed { .. } => continue,
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
    let sup = Arc::new(SpaceSupervisor::new(rt_handle, 1, None));
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
pub struct SpaceInfo {
    id: String,
    name: Option<String>,
    configured: bool,
    current: bool,
}

#[tauri::command]
pub fn list_spaces(coord: State<'_, Coord>) -> Vec<SpaceInfo> {
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
pub async fn create_space(name: String, coord: State<'_, Coord>) -> Result<String, String> {
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
pub async fn rename_space(
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

/// 设备身份面(identity-plan §2.3):本机是哪台 + 这个账户里见过哪些设备。
/// 一次取齐——设置面的「本机别名」输入框与时间轴卡片的署名 chip 都要它。
#[derive(serde::Serialize)]
pub struct DeviceIdentity {
    /// 本机在**这个空间**里的 device_id(身份是「设备 × 空间」粒度)。
    this_device: String,
    /// 全量名册。⚠ 口径是**「见过的设备」**,不是「当前在册的设备」——被服务端吊销的
    /// 设备,它的别名行照样在。要权威在册名单得等 §5「移除设备」。
    devices: Vec<DeviceEntryItem>,
}

#[derive(serde::Serialize)]
pub struct DeviceEntryItem {
    device_id: String,
    /// null = 从未命名或显式清名。后端绝不编造缺省名,人话缺省归前端。
    alias: Option<String>,
}

/// 读身份面。走只读直读前台库(同 list_timeline),不占写锁。
#[tauri::command]
pub fn device_identity(space_id: String, coord: State<'_, Coord>) -> Result<DeviceIdentity, String> {
    coord.with_read(&space_id, |conn| {
        let this_device = clock::Clock::load(conn)?.device_id().to_string();
        let devices = identity::device_roster(conn)?
            .into_iter()
            .map(|d| DeviceEntryItem { device_id: d.device_id, alias: d.alias })
            .collect();
        Ok(DeviceIdentity { this_device, devices })
    })
}

/// 给一台设备起/改/清别名(identity-plan §2)。`alias` 传 null 或空白 = 清名。
/// 别名**进同步**(和空间名同族);字号 / 明暗那两样是环境属性刻意不同步,别搞混。
/// 纪律同 `rename_space`:持 lifecycle + control_runtime + begin_op,锁内复核 restart。
#[tauri::command]
pub async fn set_device_alias(
    space_id: String,
    device_id: String,
    alias: Option<String>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    let _life = coord.lifecycle.lock().await;
    let rt = coord.control_runtime(&space_id)?;
    let _op = rt.begin_op().ok_or_else(|| "空间正在停止,稍后再改别名".to_string())?;
    let r = {
        let (mut conn, mut clk) = rt.write_locks();
        if let Some(e) = rt.restart_required() {
            return Err(format!("此空间的同步会话需要重启:{e}——切换空间后切回,或重启应用"));
        }
        identity::set_device_alias(&mut conn, &mut clk, &device_id, alias.as_deref())
    };
    drop(rt); // 先松连接,再由 _op(scope 末)通知 stop——同 rename_space 的次序。
    r
}

/// 串行重扫 catalog(space-name-changed 的前端处理器专用;codex 实现审 H1):重扫
/// 从事件桥挪进命令面——refresh_catalog 内部有覆盖 load+swap 的重载互斥,失败响亮
/// 在返回值上(不许「让 _ = 」吞掉后照发「已刷新」)。
#[tauri::command]
pub async fn rescan_spaces(coord: State<'_, Coord>) -> Result<(), String> {
    coord.refresh_catalog()
}

/// 切换前台空间(工序 8,§9):返回 = 本地 runtime 就绪(**不等网络**);失败已
/// 回滚旧空间。切换成功广播 "space-foreground"(捕获目标可见性的数据源)。
#[tauri::command]
pub async fn activate_space(
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
pub fn find_space_by_account(account_id: String, coord: State<'_, Coord>) -> Result<Option<String>, String> {
    coord.space_id_for_account(&account_id)
}

/// 前台空间 id(前端启动对账用;运行中变更走 "space-foreground" 事件)。
#[tauri::command]
pub fn foreground_space(coord: State<'_, Coord>) -> String {
    coord.foreground().0
}

/// 重置空间(epoch-plan §7):清除本机该空间副本,之后配对重新加入。**前端义务
/// (multispace §20 门 4)**:二段确认红字(本机该空间数据将删除;须有另一台在线
/// 完整副本;旧 device_id 报运营者吊销)后才许调;完成后引导回「加入空间」配对流。
/// 前台被重置时前台落回 main(main 自己重置 = 原地重建 fresh 空库),随
/// "space-foreground" 广播;文件步失败该空间本进程内封锁,重启自动走恢复路径。
#[tauri::command]
pub async fn reset_space(
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
pub async fn move_item_to_space(
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
pub async fn sync_all_spaces(app: AppHandle, coord: State<'_, Coord>) -> Result<SyncAllReport, String> {
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
pub async fn capture_idea(
    space_id: String,
    content: String,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord.write(&space_id, |conn, clock| notes::capture(conn, clock, &content)).await
}

/// 捕获一条待办(born_stage='todo')——task::create 固定生 todo、frindex 置列首。
#[tauri::command]
pub async fn capture_todo(
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
pub async fn complete_task(
    space_id: String,
    id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord
        .write(&space_id, |conn, clock| {
            // 发送端闸的运行期事实(board-columns-plan §5;B-e 第 1 段)。**在 `write`
            // 的临界区里现采**,与桌面那三处同一个理由(锁前查有「查后置位抢锁」竞态)。
            let facts = zhujian_core::board::gate::RuntimeFacts::observe(&coord.sup, &space_id);
            task::transition(conn, clock, &id, "done", &facts)
        })
        .await
}

/// 一枚标签(时间轴 chip 展示与归类选择器共用;color 为 `#RRGGBB` 或 null=无色)。
#[derive(serde::Serialize)]
pub struct TopicItem {
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
pub struct ImageMeta {
    id: String,
    seq: i64,
    mime: String,
}

/// 统一时间轴的一行:灵感+任务同列,`stage` 原样透传(六态之一)。
/// 117 起带 `images` 元数据(只列**已物化**的图——Full 下行在途的图没有行,
/// 字节到齐落行才出现,随 sync-changed 刷新自然补上)。
#[derive(serde::Serialize)]
pub struct TimelineItem {
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
    /// 出生设备(0033 born_device),null = 未知(0033 前的存量行)。前端经
    /// `device_identity` 的名册翻成别名显一枚署名 chip;**只在「不是本机」且「那台起过
    /// 别名」时显**,其余一律不显(identity-plan §3.7 + 2026-08-05 用户拍板)。
    born_device: Option<String>,
    topics: Vec<TopicItem>,
    images: Vec<ImageMeta>,
}

/// 统一时间轴(repo::live_timeline 单一查询入口)。读也显式 space_id:全部同步
/// 遍历中只读直读前台库(数据静止,读不打断遍历);切换瞬态响亮拒,前端切换
/// 完成后重拉。
#[tauri::command]
pub fn list_timeline(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TimelineItem>, String> {
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
                    born_device: r.born_device,
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
pub fn get_item_image(space_id: String, image_id: String, coord: State<'_, Coord>) -> Result<String, String> {
    // 锁内只读字节,Base64 编码在锁外做——with_read 持前台相位锁+库锁,大图在锁内
    // 编码会拖住切换与写命令。
    let (bytes, mime) = coord.with_read(&space_id, |conn| {
        repo::item_image_data(conn, &image_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("图片不存在:{image_id}"))
    })?;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

/// 缩略图响应(image-perf-plan §3.2,与桌面壳逐字段一致):`thumb=false` 表示未命中、
/// `url` 是全尺寸,前端该自己缩一次再回存(规格 token 不出 core)。
#[derive(serde::Serialize)]
pub struct ThumbData {
    url: String,
    thumb: bool,
}

/// 一张图的**缩略图**:命中本地派生表只吐几 KB;未命中吐全尺寸(维持今天的行为)。
/// 与 `get_item_image` 同纪律 —— 锁内只读字节,Base64 编码在锁外做。
#[tauri::command]
pub fn get_item_thumb(space_id: String, image_id: String, coord: State<'_, Coord>) -> Result<ThumbData, String> {
    let hit = coord.with_read(&space_id, |conn| {
        if let Some(bytes) = thumbs::get(conn, &image_id).map_err(|e| e.to_string())? {
            return Ok(Some(bytes));
        }
        Ok(None)
    })?;
    if let Some(bytes) = hit {
        return Ok(ThumbData {
            url: format!("data:{};base64,{}", thumbs::THUMB_MIME, STANDARD.encode(&bytes)),
            thumb: true,
        });
    }
    let (bytes, mime) = coord.with_read(&space_id, |conn| {
        repo::item_image_data(conn, &image_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("图片不存在:{image_id}"))
    })?;
    Ok(ThumbData {
        url: format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)),
        thumb: false,
    })
}

/// 回存一张算好的缩略图(惰性填充)。纯本地派生:不发 op、不动时钟。
///
/// ⚠ 走**非阻塞**的 `with_write`,`Busy` 当场静默跳过 —— 绝不走 async `coord.write`:
/// 那条在 `ManualSyncing` 下会 `request_cancel_sync_all()`,让一次缩略图缓存回存把用户
/// 的「全部同步」取消掉。
///
/// **Busy 那一支的契约要说清**(299 codex 实现审 L4):这次不落库,而前端此刻已经把小图
/// 放进了内存层,所以**本进程内不会再来第二次** —— 补上是**下次进程启动**的事。「全部同步」
/// 是用户手动触发的短暂相位,期间看过的那几张图下次冷启动补录,不影响正确性。
#[tauri::command]
pub fn put_item_thumb(
    space_id: String,
    image_id: String,
    data_b64: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    // 先按**编码长度**拒,再解码(299 codex 实现审 L3):Busy 那一支尤其明显——
    // 原先会先把整串解完,再把结果丢掉。
    if data_b64.len() > thumbs::MAX_THUMB_B64_CHARS {
        return Err(format!(
            "缩略图数据过长({} 字符,上限 {}),拒绝回存",
            data_b64.len(),
            thumbs::MAX_THUMB_B64_CHARS
        ));
    }
    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("缩略图数据解码失败:{e}"))?;
    match coord.with_write(&space_id, |conn, _clock| thumbs::put(conn, &image_id, &bytes)) {
        WriteAttempt::Done(r) => r,
        WriteAttempt::Busy => Ok(()),
    }
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
pub struct IdeaItem {
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
pub fn list_ideas(space_id: String, coord: State<'_, Coord>) -> Result<Vec<IdeaItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::live_ideas(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(IdeaItem::from).collect())
    })
}

/// 灵感回收站(archived_at 轴,最新在前)。
#[tauri::command]
pub fn list_archived(space_id: String, coord: State<'_, Coord>) -> Result<Vec<IdeaItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::idea_trash(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(IdeaItem::from).collect())
    })
}

/// 灵感流转统计(纯派生只算不存;week_start = 前端按本地周一换算的 UTC RFC3339,
/// 后端从不算本地时间——与 due_on 同哲学)。
#[derive(serde::Serialize)]
pub struct IdeaStatsItem {
    captured_week: i64,
    born_inbox: i64,
    converted: i64,
}

#[tauri::command]
pub fn idea_stats(space_id: String, week_start: String, coord: State<'_, Coord>) -> Result<IdeaStatsItem, String> {
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
pub struct SearchHitItem {
    id: String,
    content: String,
    created_at: String,
    status: String,
    topics: Vec<String>,
}

/// 全局搜索(连历史、覆盖灵感/任务/回收站/归档册)。空词响亮拒,不倒全库。
#[tauri::command]
pub fn search_notes(space_id: String, query: String, coord: State<'_, Coord>) -> Result<Vec<SearchHitItem>, String> {
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
pub async fn edit_note(
    space_id: String,
    id: String,
    content: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::edit(conn, clock, &id, &content)).await
}

/// 一个被替换掉的旧版本。
#[derive(serde::Serialize)]
pub struct RevisionItem {
    content: String,
    archived_at: String,
}

/// 条目的编辑历史(最新在前;当前文本在条目自身上)。
#[tauri::command]
pub fn list_note_history(space_id: String, id: String, coord: State<'_, Coord>) -> Result<Vec<RevisionItem>, String> {
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
pub async fn archive_note(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::archive(conn, clock, &id)).await
}

/// 从回收站恢复灵感(回到冻结时的 stage)。
#[tauri::command]
pub async fn restore_note(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::restore(conn, clock, &id)).await
}

/// 彻底删除一条回收站里的灵感(二次确认后的那一步;只有已在回收站的能删)。
#[tauri::command]
pub async fn purge_note(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::purge(conn, clock, &id)).await
}

/// 清空灵感回收站,返回删除条数。
#[tauri::command]
pub async fn purge_archived(space_id: String, coord: State<'_, Coord>) -> Result<usize, String> {
    coord.write(&space_id, |conn, clock| notes::purge_all_archived(conn, clock)).await
}

/// 灵感转待办(翻 stage 零副本,单实体 ㉜)。返回任务 id(= 条目自身 id)。
#[tauri::command]
pub async fn promote_note_to_task(
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
pub async fn revert_task_to_inbox(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::revert_task_to_inbox(conn, clock, &id)).await
}

/// 给灵感挂标签:已有标签给 topic_id,新标签给 new_title(二选一)。返回标签 id。
#[tauri::command]
pub async fn file_note_to_topic(
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
pub async fn remove_note_topic(
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

/// 一列看板列的当前态(与桌面 `BoardColumn` 同形;board-columns-plan §2.1 的 read model)。
///
/// ⛔ **前端别再自己拼一份「有哪几列」** —— 不变量 3 的唯一正式子在 core
/// (`board::list_columns`),两只壳都只是搬运。⚠ `position` 刻意不出壳(读序已排好)。
#[derive(serde::Serialize)]
pub struct BoardColumn {
    id: String,
    /// ⚠ `title_overridden == false` 时**不是**要显示的字符串:那时按 `id` 查本端字典(§7.1d)。
    title: String,
    kind: String,
    system: bool,
    title_overridden: bool,
    /// 已删 = 只读收容区(§4.3):卡只出不进,列身仍要画,否则卡就「不见了」。
    deleted: bool,
    live_items: i64,
    deletable: bool,
}

impl From<zhujian_core::board::BoardColumnRow> for BoardColumn {
    fn from(c: zhujian_core::board::BoardColumnRow) -> Self {
        BoardColumn {
            id: c.id,
            title: c.title,
            kind: c.kind,
            system: c.system,
            title_overridden: c.is_title_overridden,
            deleted: c.deleted,
            live_items: c.live_items,
            deletable: c.deletable,
        }
    }
}

/// 全部看板列(**含已删的**),已按 `(position, id)` 排好。
#[tauri::command]
pub fn list_board_columns(space_id: String, coord: State<'_, Coord>) -> Result<Vec<BoardColumn>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = zhujian_core::board::list_columns(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(BoardColumn::from).collect())
    })
}

/// 一张看板卡(与桌面 TaskItem 同形)。
#[derive(serde::Serialize)]
pub struct TaskItem {
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
pub fn list_tasks(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TaskItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::list_tasks(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(TaskItem::from).collect())
    })
}

/// 任务回收站(最近删除在前;各自保留删除前的 status)。
#[tauri::command]
pub fn list_archived_tasks(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TaskItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::archived_tasks(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(TaskItem::from).collect())
    })
}

/// 成就归档册(sealed_at 非 null,最近归档在前)。
#[tauri::command]
pub fn list_sealed_tasks(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TaskItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::sealed_tasks(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(TaskItem::from).collect())
    })
}

#[derive(serde::Serialize)]
pub struct PaneCounts {
    trash: i64,
    sealed: i64,
}

/// 底栏「回收站/归档册」显形用的两个计数(408-A1:空则不渲染那枚钮)。
/// 只为显隐服务——别拿它当列表口径,两个面各有自己的 list 命令。
#[tauri::command]
pub fn pane_counts(space_id: String, coord: State<'_, Coord>) -> Result<PaneCounts, String> {
    coord.with_read(&space_id, |conn| {
        let q = |sql: &str| conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string());
        Ok(PaneCounts {
            trash: q("SELECT COUNT(*) FROM items WHERE archived_at IS NOT NULL")?,
            sealed: q("SELECT COUNT(*) FROM items WHERE sealed_at IS NOT NULL")?,
        })
    })
}

/// 新建任务(生而 todo、置列首;due/priority/标签可选,整体原子)。返回 id。
/// (capture_todo 是它的极简别名——只有标题;保留两个入口不合并,捕获语义
/// 不该背上看板参数。)
#[tauri::command]
pub async fn create_task(
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
pub async fn rename_task(
    space_id: String,
    id: String,
    title: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::rename(conn, clock, &id, &title)).await
}

/// 任务换列(todo/doing/confirming/done 自由流转;非法迁移/过期视图响亮拒)。
#[tauri::command]
pub async fn update_task_status(
    space_id: String,
    id: String,
    to: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord
        .write(&space_id, |conn, clock| {
            // 发送端闸的运行期事实(board-columns-plan §5;B-e 第 1 段)。**在 `write`
            // 的临界区里现采**,与桌面那三处同一个理由(锁前查有「查后置位抢锁」竞态)。
            let facts = zhujian_core::board::gate::RuntimeFacts::observe(&coord.sup, &space_id);
            task::transition(conn, clock, &id, &to, &facts)
        })
        .await
}

/// 列内/跨列拖动排序(无过滤的强契约路;ordered_ids = 目标列完整新序)。
#[tauri::command]
pub async fn reorder_task(
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
            // 发送端闸的运行期事实(board-columns-plan §5;B-e 第 1 段)。**在 `write`
            // 的临界区里现采**,与桌面那三处同一个理由(锁前查有「查后置位抢锁」竞态)。
            let facts = zhujian_core::board::gate::RuntimeFacts::observe(&coord.sup, &space_id);
            task::reorder(
                conn,
                clock,
                &id,
                &from_status,
                &to_status,
                &base_target_ids,
                &ordered_ids,
                &facts,
            )
        })
        .await
}

/// 过滤视图下的拖动排序(前端只见可见子集,后端 visible-merge 合回全列)。
#[tauri::command]
pub async fn reorder_task_visible(
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
            // 发送端闸的运行期事实(board-columns-plan §5;B-e 第 1 段)。**在 `write`
            // 的临界区里现采**,与桌面那三处同一个理由(锁前查有「查后置位抢锁」竞态)。
            let facts = zhujian_core::board::gate::RuntimeFacts::observe(&coord.sup, &space_id);
            task::reorder_visible(
                conn,
                clock,
                &id,
                &from_status,
                &to_status,
                &base_visible_ids,
                &visible_after,
                &facts,
            )
        })
        .await
}

/// 设/清任务截止日(用户本地日历日 `YYYY-MM-DD`,null=清)。
#[tauri::command]
pub async fn set_task_due(
    space_id: String,
    id: String,
    due_on: Option<String>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::set_due(conn, clock, &id, due_on.as_deref())).await
}

/// 设/清任务优先级(1/2/3=低/中/高,null=未设)。
#[tauri::command]
pub async fn set_task_priority(
    space_id: String,
    id: String,
    priority: Option<i64>,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::set_priority(conn, clock, &id, priority)).await
}

/// 给任务挂一个标签(M:N,幂等)。
#[tauri::command]
pub async fn add_task_topic(
    space_id: String,
    id: String,
    topic_id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::add_topic(conn, clock, &id, &topic_id)).await
}

/// 摘掉任务的一个标签(幂等)。
#[tauri::command]
pub async fn remove_task_topic(
    space_id: String,
    id: String,
    topic_id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::remove_topic(conn, clock, &id, &topic_id)).await
}

/// 任务删除 = 软删进回收站(可恢复)。
#[tauri::command]
pub async fn archive_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::archive(conn, clock, &id)).await
}

/// 从回收站恢复任务(回原列)。
#[tauri::command]
pub async fn restore_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::restore(conn, clock, &id)).await
}

/// 彻底删除一条回收站里的任务。
#[tauri::command]
pub async fn purge_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::purge(conn, clock, &id)).await
}

/// 清空任务回收站,返回删除条数。
#[tauri::command]
pub async fn purge_archived_tasks(space_id: String, coord: State<'_, Coord>) -> Result<usize, String> {
    coord.write(&space_id, |conn, clock| task::purge_all(conn, clock)).await
}

/// 已完成任务入成就册(sealed_at 轴:可查不可删,与回收站互斥)。
#[tauri::command]
pub async fn seal_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::seal(conn, clock, &id)).await
}

/// 一键归档「已完成」列全部任务,返回条数(0=列本来就空)。
#[tauri::command]
pub async fn seal_done_tasks(space_id: String, coord: State<'_, Coord>) -> Result<usize, String> {
    coord.write(&space_id, |conn, clock| task::seal_all(conn, clock)).await
}

/// 取消归档:回看板「已完成」列末尾(想删须先取消归档再走两段式)。
#[tauri::command]
pub async fn unseal_task(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| task::unseal(conn, clock, &id)).await
}

// ---- 标签(topics;「重命名只改可见中文」的铁律照旧,内部标识符不动) ----

/// 全部标签(归类选择器/标签管理的数据源)。
#[tauri::command]
pub fn list_topics(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TopicItem>, String> {
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
pub struct TopicTreeItem {
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
pub struct TopicNoteItem {
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
pub fn list_topic_tree(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TopicTreeItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::topics_with_notes(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(topic_tree_item).collect())
    })
}

/// 标签管理视图(含空标签,最近变动在前——空的才能被改名/删除)。
#[tauri::command]
pub fn list_topics_full(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TopicTreeItem>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::all_topics_with_notes(conn).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(topic_tree_item).collect())
    })
}

/// 新建标签(空名响亮拒)。返回 id。
#[tauri::command]
pub async fn create_topic(space_id: String, title: String, coord: State<'_, Coord>) -> Result<String, String> {
    coord.write(&space_id, |conn, clock| notes::create_topic(conn, clock, &title)).await
}

/// 标签改名。
#[tauri::command]
pub async fn update_topic(
    space_id: String,
    id: String,
    title: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::rename_topic(conn, clock, &id, &title)).await
}

/// 设/清标签 chip 颜色(`#RRGGBB`,null=清)。
#[tauri::command]
pub async fn set_topic_color(
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
pub async fn delete_topic(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| notes::delete_topic(conn, clock, &id)).await
}

/// 合并标签:来源各标签名下条目并入目标(集合并),来源删除,可顺带改名。
#[tauri::command]
pub async fn merge_topics(
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
pub async fn reorder_topic(
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
pub async fn set_topic_kind(
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
pub struct TrashItem {
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
pub fn list_trash(space_id: String, coord: State<'_, Coord>) -> Result<Vec<TrashItem>, String> {
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
pub async fn purge_all_trash(space_id: String, coord: State<'_, Coord>) -> Result<usize, String> {
    coord.write(&space_id, |conn, clock| notes::purge_all_trash(conn, clock)).await
}

/// 给任务按标题挂标签(同名复用、缺则新建,core 单事务原子;codex 120 设计审 M9:
/// 禁 create_topic+add_task_topic 两步——半途失败留空标签)。返回标签 id。
#[tauri::command]
pub async fn add_task_topic_by_title(
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
pub async fn add_item_image(
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
pub fn list_item_images(space_id: String, item_id: String, coord: State<'_, Coord>) -> Result<Vec<ImageMeta>, String> {
    coord.with_read(&space_id, |conn| {
        let rows = repo::list_item_images(conn, &item_id).map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(|r| ImageMeta { id: r.id, seq: r.seq, mime: r.mime }).collect())
    })
}

/// 删一张配图(编号退役不重排;不存在响亮错)。
#[tauri::command]
pub async fn delete_item_image(space_id: String, image_id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| images::remove(conn, clock, &image_id)).await
}

// ---- 条目留言(identity-plan §4;第②笔命令面,与桌面壳逐字对称)----------------
//
// **DTO 直接用 core 的 `comments::Comment` / `CommentPage`**:§4.14.2 第 1 条要的
// 「两壳契约同源」若靠两个壳各抄一份结构体维持,就只是纪律;返回同一个类型,漂移
// 在编译期即不可能。写命令一律走 `coord.write`(空间锁 + 相位),**不许直开旁路连接**。

/// 写一条留言。四道校验(非空 / 200 KiB / 宿主在 / 500 软闸)全在 `comments::add`
/// 的同一个事务里,壳不复述也不预判。
#[tauri::command]
pub async fn add_item_comment(
    space_id: String,
    item_id: String,
    content: String,
    coord: State<'_, Coord>,
) -> Result<String, String> {
    coord.write(&space_id, |conn, clock| comments::add(conn, clock, &item_id, &content)).await
}

/// 销毁一条留言(**不进回收站**;UI 两拍确认兜)。行不在 = 幂等 no-op。
#[tauri::command]
pub async fn delete_item_comment(space_id: String, id: String, coord: State<'_, Coord>) -> Result<(), String> {
    coord.write(&space_id, |conn, clock| comments::remove(conn, clock, &id)).await
}

/// 一页留言(最近优先)。`cursor` = 上一页的 `next_cursor`,null = 第一页。
/// 读走只读直读前台库(同 list_timeline),不占写锁。
#[tauri::command]
pub fn list_item_comments(
    space_id: String,
    item_id: String,
    cursor: Option<(String, String)>,
    coord: State<'_, Coord>,
) -> Result<comments::CommentPage, String> {
    coord.with_read(&space_id, |conn| {
        let cur = cursor.as_ref().map(|(ca, id)| (ca.as_str(), id.as_str()));
        comments::list_for_item(conn, &item_id, cur)
    })
}

/// 每条目徽章聚合(留言数 + 未读,0038):一次 `GROUP BY` 聚合读,不 N+1;零留言的
/// 条目不在返回里。
#[tauri::command]
pub fn item_comment_counts(
    space_id: String,
    coord: State<'_, Coord>,
) -> Result<std::collections::HashMap<String, comments::CommentBadge>, String> {
    coord.with_read(&space_id, |conn| comments::counts_all(conn))
}

/// 推进一条条目的留言已读水位(0038):留言层第一页渲染成功后带上页首那条的 id。
/// 纯本地簿记:不发 op、不动时钟。走**非阻塞** `with_write`、`Busy` 静默跳过
/// (同 put_item_thumb 的理由:绝不让一次红点簿记把用户的「全部同步」取消掉;
/// 这次没推进,下次开层重渲会再推,无损)。
#[tauri::command]
pub fn mark_item_comments_seen(
    space_id: String,
    item_id: String,
    seen_id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    match coord.with_write(&space_id, |conn, _clock| comments::mark_seen(conn, &item_id, &seen_id)) {
        WriteAttempt::Done(r) => r,
        WriteAttempt::Busy => Ok(()),
    }
}

// ---- 同步命令面(与桌面对称:创号 / 邀请 / 加入 / 状态 / 改服务器,phone-space-plan) ----

/// 同步状态快照(当前空间;变更另有 "sync-status" 事件实时推送)。非前台空间没有
/// runtime,拒——前端只该问当前空间。
#[tauri::command]
pub fn sync_status(space_id: String, coord: State<'_, Coord>) -> Result<transport::SyncStatus, String> {
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
pub async fn sync_create_account(
    space_id: String,
    server_url: String,
    app: AppHandle,
    coord: State<'_, Coord>,
) -> Result<crate::coord::CreateAccountOutcome, String> {
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
pub async fn sync_pair_start(
    space_id: String,
    coord: State<'_, Coord>,
) -> Result<crate::coord::PairStartOutcome, String> {
    coord.pair_start(&space_id).await
}

/// 设备管理(与桌面对称;identity-plan §5.3)。DTO 直接用 core 那个枚举 —— 与线上
/// CBOR 变体名同源是编译期事实,不是要记得对齐的纪律。
#[tauri::command]
pub async fn sync_device_admin(
    space_id: String,
    device_id: String,
    action: transport::DeviceAction,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.device_admin(&space_id, device_id, action).await
}

/// 拉一枚当前设备名册(§5.4)。回执自带名单;`sync_status.roster` 那一份服务的是
/// 服务器主动推送那条路。
#[tauri::command]
pub async fn sync_roster_refresh(
    space_id: String,
    coord: State<'_, Coord>,
) -> Result<(), String> {
    coord.roster_refresh(&space_id).await
}

/// 用配对码加入账户(新设备侧;107 起也可扫码,同一条路)。**space-entry-plan §2
/// 起只接受 main**(后端不变量,不是 UI 藏按钮):非 main 空间的两条来路是「新建
/// =纯本地本子(同步唯一路=创号)」与「加入空间」(`join_space`,隐式 staging 槽,
/// 不收目标 space_id)——直接 invoke 非 main 一律拒。工序 7 起带**两阶段账户唯一
/// 闸**(§4):gate 回调由 core 卡在「拿到 Grant 之后、配置落库之前」,磁盘现扫 +
/// join reservation 一并裁决——两个本地空间绑同一账户会互灌数据、污染共享副本,
/// 响亮中止、配置一个键都不写(服务器端孤儿注册等 revoke 清理)。
#[tauri::command]
pub async fn sync_pair_join(
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
pub async fn join_space(
    server_url: String,
    code: String,
    attempt_id: String,
    app: AppHandle,
    coord: State<'_, Coord>,
) -> Result<crate::coord::JoinOutcome, String> {
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
pub fn join_space_cancel(coord: State<'_, Coord>) {
    coord.request_cancel_join();
}

/// 改服务器地址(运营者迁服务器时用;须已加入账户)。写入即触发重连。
#[tauri::command]
pub async fn sync_set_server(
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
pub fn sync_recovery_code(space_id: String, coord: State<'_, Coord>) -> Result<String, String> {
    let rt = coord.sup.get(&space_id)?;
    let conn = rt.db.lock().expect("db mutex poisoned");
    transport::recovery_code(&conn)
}

// ⛔ **`take_shared_text` / `take_deep_link` / `check_update` 不在这里** ——
// 它们是安卓壳自己的三条(Intent 薄桥的取走端 × 2 + `android.json` 更新检查),
// 判据见本文件头注那两张表。搬进来会给鸿蒙端长出三条永远返回空的假入口。

/// 诊断页「本机库」区:当前空间的建库 + 迁移 + 设备身份可视佐证。
#[derive(serde::Serialize)]
pub struct DbInfo {
    path: String,
    sqlite_version: String,
    journal_mode: String,
    user_version: i64,
    device_id: String,
    items: i64,
}

#[tauri::command]
pub fn db_info(space_id: String, coord: State<'_, Coord>) -> Result<DbInfo, String> {
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
pub async fn net_probe(url: String) -> Vec<transport::ProbeStep> {
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

// ── 加密备份:安卓那半(backup-plan §17 笔③;core 一个字未改)───────────────────
//
// 形一句话:**Kotlin 只搬密文,整库明文快照的字节不出 core**(§17.3)。备份仍由
// `BackupCoordinator` 在 app 私有区里整套跑完(明文全程锁在 0700 的 `.backup-staging`
// 里),产出的**密文**落私有 **outbox**(= `BackupPaths::production` 的 `default_dir`),
// 再由 Kotlin 那条 SAF 桥拷进用户自己挑的目录。
//
// ⛔ **这一层与桌面同纪律:不做任何策略** —— 准入 / 封锁 / 仪式全在 core。
// 与桌面壳的三处**刻意不同**,每处都是判据不是口味:
//
// 1. **`BackupStatusDto` 没有 `dir` 这一格**(§17.3 末):在这一端 `status().dir` 是
//    **中转 outbox**,不是用户的落点(落点是那个 tree URI,core 永远不知道它存在)。
//    把它显示出来等于骗人 ⇒ 干脆不交给前端,「想当然地显示它」在类型上就写不出来。
// 2. **命令面两个入口都只收「裸文件名」**(`backup_verify`),路径由 Rust 自己 join ——
//    与 §17.5 那条 H-1 的桥面闸同形:前端手里从来就没有一条完整路径可传。
// 3. **没有 `backup_set_dir` / `backup_open_dir` / 自动备份那几条**:v1 不做
//    (§17.2 / §17.15),而不做的意思是**入口不存在**,不是"按钮先藏起来"。

/// 私有中转 outbox 的路径。`backup_verify` 拿它 join 回拷名(⛔ 前端手里从来没有
/// 一条完整路径可传,见本节头注 2)。
///
/// ⭐ **字段是 `pub` 的,那是给安卓壳的**:那一端还要把它作为**期望值**交给 Kotlin 的
/// SAF 桥做运行时相等比对(§17.5 那道闸),于是 `backup_outbox_dir` **那条命令住在
/// 安卓壳里**、只有它读这个字段。⛔ 别把那条命令搬进来:鸿蒙侧没有那条桥,
/// 搬进来等于给它长一条「说了不算」的入口。
pub struct BackupOutbox(pub String);

#[derive(serde::Serialize)]
pub struct BackupStatusDto {
    configured: bool,
    blocked: Option<String>,
    /// "backup" | "cleanup" | "restore" | null。
    busy: Option<&'static str>,
    awaiting_ceremony: bool,
    problem: Option<String>,
}

/// 一份刚产出的密文。⭐ **只给文件名不给路径**(见本节头注 2)。
#[derive(serde::Serialize)]
pub struct BackupMadeDto {
    space_id: String,
    file_name: String,
    bytes: u64,
}

#[derive(serde::Serialize)]
pub struct BackupFailedDto {
    space_id: String,
    message: String,
    /// "unverified"(写完没验过)| "invalid"(验不过又删不掉)。⛔ 两种都不得计作一份备份。
    leftover_kind: Option<&'static str>,
    leftover_name: Option<String>,
}

#[derive(serde::Serialize)]
pub struct BackupReportDto {
    made: Vec<BackupMadeDto>,
    failed: Vec<BackupFailedDto>,
    /// 剩余**根本没跑**的空间数;UI 必须与「跑了但失败」显著区分。
    skipped: usize,
    fatal: Option<String>,
    blocked: Option<String>,
}

#[derive(serde::Serialize)]
pub struct VerifiedBackupDto {
    space_id: String,
    space_name: Option<String>,
    created_at: String,
    app_version: String,
    plain_bytes: u64,
    /// 验完那份回拷**没能删掉**(实现审一弹 M-4)。⛔ **不是失败** —— 验证结论本身照旧成立,
    /// 留下的是一份**密文**垃圾,下次启动壳会接着清。但它也**不许静默**:
    /// 「无论成败都要删掉」这条义务没兑现,就得让人看得见(照 core 的 `RestoredSpace.cleanup_error` 那个形)。
    cleanup_error: Option<String>,
}

fn backup_status_dto(s: zhujian_core::backup::BackupStatus) -> BackupStatusDto {
    use zhujian_core::backup::Busy;
    BackupStatusDto {
        configured: s.configured,
        blocked: s.blocked,
        busy: s.busy.map(|b| match b {
            Busy::Backup => "backup",
            Busy::Cleanup => "cleanup",
            Busy::Restore => "restore",
        }),
        awaiting_ceremony: s.awaiting_ceremony,
        problem: s.problem,
    }
}

/// 只取 `path` 的最后一段。⛔ 前端不该拿到路径(本节头注 2),core 的产物名
/// (`zhujian-<8>-<UTC>-<ULID>.zjbak`)自己就是唯一的。
fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// **回拷名闸**(与 §17.5 那张表里 `putFile` 的裸名校验同形,⛔ 这不是重复,是同一条
/// 规则在两条入口上各落一次)。四条:不含路径分隔符 / 不是 `.`|`..` / 以 `.zjbak` 收尾 /
/// **以 `verify-` 开头**。
///
/// ⭐ **第四条是承重的那条,别当装饰**:验完要把这份回拷删掉(§17.10「无论成败都要删」),
/// 而那把删除动作绑在这条命令上 —— 若名字可以是任意 `.zjbak`,它就能删掉 outbox 里
/// **一份刚做好、还没搬进用户目录的真产物**(那正是 `put` 唯一的、不可再生的锚)。
/// ⇒ 只许删「壳自己造的尺 4 名字」。
///
/// ⭐ 单独成函数是为了让它**可被直接测**(§17.16 那几刀要逐条真红)。
fn fetched_name_gate(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err("备份文件名不合法".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') || name.contains("..") {
        return Err("备份文件名不许带路径".into());
    }
    if !name.ends_with(".zjbak") {
        return Err("这不是一个 .zjbak 文件".into());
    }
    if !name.starts_with("verify-") {
        return Err("这不是一份回拷来验的文件".into());
    }
    Ok(())
}

#[tauri::command]
pub fn backup_status(app: AppHandle) -> BackupStatusDto {
    backup_status_dto(app.state::<zhujian_core::backup::BackupCoordinator>().status())
}

// ⛔ **`backup_outbox_dir` 那条命令在安卓壳里**,不在这儿(判据见 `BackupOutbox` 头注)。

/// 仪式第一步:生成备份钥(**只在内存**)并返回要抄的码。
/// ⛔ 没有 `dir` 入参 —— 这一端的落点由 SAF 定,core 那边恒用默认 outbox。
#[tauri::command]
pub fn backup_begin_setup(app: AppHandle) -> Result<String, String> {
    app.state::<zhujian_core::backup::BackupCoordinator>()
        .begin_setup(None)
        .map_err(|e| e.to_string())
}

/// 仪式第二步:回输核对。**对上了才落盘**(⛔ 不许退化成勾「我已抄下」——
/// 在这一端它更要紧:清数据 / 卸载之后抄下来那份是**唯一**的钥,§17.7)。
#[tauri::command]
pub fn backup_confirm_setup(app: AppHandle, code: String) -> Result<(), String> {
    app.state::<zhujian_core::backup::BackupCoordinator>()
        .confirm_setup(&code)
        .map_err(|e| e.to_string())
}

/// 放弃仪式(关面 / 点取消):进程内那把钥当场丢掉,盘上什么都没写过。
#[tauri::command]
pub fn backup_cancel_setup(app: AppHandle) {
    app.state::<zhujian_core::backup::BackupCoordinator>().cancel_setup();
}

/// 跑一趟备份(所有空间,逐空间串行)——产物落**私有 outbox**,还没进用户的目录。
///
/// ⭐ `spawn_blocking` 不是礼节:整库 `VACUUM INTO` + 全量加密 + 全量自验,大库好几秒;
/// 手机上把 UI 线程占住会被系统判成无响应。
#[tauri::command]
pub async fn backup_run(app: AppHandle) -> Result<BackupReportDto, String> {
    use zhujian_core::backup::Leftover;
    tauri::async_runtime::spawn_blocking(move || {
        let report = app
            .state::<zhujian_core::backup::BackupCoordinator>()
            .run_backup()
            .map_err(|e| e.to_string())?;
        Ok(BackupReportDto {
            made: report
                .made
                .into_iter()
                .map(|m| BackupMadeDto {
                    space_id: m.space_id,
                    file_name: base_name(&m.path),
                    bytes: m.bytes,
                })
                .collect(),
            failed: report
                .failed
                .into_iter()
                .map(|f| {
                    let (kind, name) = match f.leftover {
                        None => (None, None),
                        Some(Leftover::Unverified(p)) => (Some("unverified"), Some(base_name(&p))),
                        Some(Leftover::Invalid(p)) => (Some("invalid"), Some(base_name(&p))),
                    };
                    BackupFailedDto {
                        space_id: f.space_id,
                        message: f.message,
                        leftover_kind: kind,
                        leftover_name: name,
                    }
                })
                .collect(),
            skipped: report.skipped,
            fatal: report.fatal,
            blocked: report.blocked,
        })
    })
    .await
    .map_err(|e| format!("备份任务没跑起来:{e}"))?
}

/// 验一份**已回拷进 outbox** 的备份:整个解一遍(与恢复同一条路)。
///
/// 入参是 Kotlin 造的那把「尺 4」名字(`verify-<ULID>.zjbak`),⛔ 不是 SAF 的回读名
/// (provider 可能把它改成 `.bin`,而 core 那道扩展名闸会在解之前就拒掉,§17.4-6)。
#[tauri::command]
pub async fn backup_verify(app: AppHandle, name: String) -> Result<VerifiedBackupDto, String> {
    fetched_name_gate(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&app.state::<BackupOutbox>().0).join(&name);
        let verified = app
            .state::<zhujian_core::backup::BackupCoordinator>()
            .verify_backup(&path.to_string_lossy())
            .map_err(|e| e.to_string());
        // ⭐ **无论成败都删掉那份回拷**(§17.10 幕⑤ 那行;checklist §4「已提交的义务不许随
        // `?` 蒸发」)。⚠ 它与消费者在同一处 —— 于是桥上不必再开第六个入口,
        // 也就没有「删任意 outbox 文件」这个能力面。
        let cleanup_error = match std::fs::remove_file(&path) {
            Ok(()) => None,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                log::warn!("BACKUP_VERIFY 回拷删不掉 {}:{e}", path.display());
                Some(format!("验完的临时副本没能删掉({e});它是密文,下次启动会再清一次"))
            }
        };
        // ⛔ **删不掉不翻案**(把一次成功的验证报成失败才是真的误导),
        // ⛔ **但也不许静默**(实现审一弹 M-4:那时 UI 会说「验证成功」而义务没兑现)⇒
        // 成功那支把它挂在 DTO 上,失败那支缀在原话后面。
        match verified {
            Ok(v) => Ok(VerifiedBackupDto {
                space_id: v.space_id,
                space_name: v.space_name,
                created_at: v.created_at,
                app_version: v.app_version,
                plain_bytes: v.plain_bytes,
                cleanup_error,
            }),
            Err(e) => Err(match cleanup_error {
                None => e,
                Some(c) => format!("{e}(另:{c})"),
            }),
        }
    })
    .await
    .map_err(|e| format!("验证任务没跑起来:{e}"))?
}

/// 重试清扫暂存区(封锁态的**唯一**出路;⛔ 没有「忽略」按钮 —— 封锁的意思是盘上
/// 真躺着明文整库副本)。
#[tauri::command]
pub async fn backup_retry_cleanup(app: AppHandle) -> Result<BackupStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<zhujian_core::backup::BackupCoordinator>()
            .retry_cleanup()
            .map(backup_status_dto)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("清扫任务没跑起来:{e}"))?
}

/// 数据目录的一行速写(名字 + 字节数),**只给日志用**。
///
/// ⭐ **为什么它是产品代码而不是 harness 的一部分**:鸿蒙那一端没有控制台、没有
/// `adb logcat` 的等价物、私有区 `hdc` 也够不着 —— 「冷启之后目录里还剩什么」除了
/// 应用自己说,**没有第二个人能回答**。而这正是引导清扫 / 重置续跑 / 归位残留三条路
/// 唯一的可观测面。⚠ 代价是一次 `read_dir`(几项),在启动的 blocking worker 里,
/// 不占启动线程。
/// ⛔ 读不出的项要**留痕**,别 `.flatten()` 吃掉 —— 那可能正是要找的那份残留(438 的判据)。
fn dir_brief(dir: &std::path::Path) -> String {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => return format!("<读目录失败:{e}>"),
    };
    let mut items: Vec<String> = rd
        .map(|entry| match entry {
            Ok(e) => match e.metadata() {
                Ok(m) if m.is_dir() => format!("{}/", e.file_name().to_string_lossy()),
                Ok(m) => format!("{}({})", e.file_name().to_string_lossy(), m.len()),
                Err(err) => format!("<读不出 {}:{err}>", e.file_name().to_string_lossy()),
            },
            Err(e) => format!("<读不出目录项:{e}>"),
        })
        .collect();
    items.sort();
    if items.is_empty() {
        return "<空>".into();
    }
    items.join(" ")
}

/// 两只手机壳共用的启动装配。**`run()` 不在这里** —— 那是各壳自己的(插件表、入口宏、
/// TLS 提供者安装、`generate_handler!` 的清单都是壳自己的事),这里只装「装配」那一段。
///
/// ⛔⛔ **`data_dir` / `config_dir` 是入参,不是这里算的** —— 这是整个抽取里最要紧的一条:
/// 安卓那端 `app.path().app_data_dir()` 是对的,而**鸿蒙那端它是错的**(fork 的 path 解析器
/// 只按 `target_os = "android"` 分了一支,鸿蒙是 `target_os = "linux"` ⇒ 落进桌面那支去解
/// `$XDG_DATA_HOME`,在沙箱里要么建不出、要么**静默落在错的地方**)。⇒ 由壳自己算完传进来,
/// 这里一次都不碰 `app.path()`。判据全文见 `ohos/src-tauri/src/lib.rs` 的 `ohos_data_dir` 头注。
///
/// 顺序承重(与 111 起那条一字未改):建目录 → **WriterLease** → 备份路径域 → Gate 落 Pending
/// → blocking worker(引导清扫 → `assemble_spaces`)。⛔ 租约必须先于任何开库;清扫必须先于
/// 任何 transport 启动;备份路径域必须在租约之后(启动清扫要删明文,那时才排他、才敢删)。
///
/// 返回私有中转 outbox 的路径:安卓壳还要拿它喂 `BackupOutbox`……不,**这里已经 manage 过了**
/// (见下),返回只是给壳记一行日志用。
pub fn setup_shell(
    app: &AppHandle,
    data_dir: std::path::PathBuf,
    config_dir: std::path::PathBuf,
) -> String {
    std::fs::create_dir_all(&data_dir).expect("create app data dir");
    // 单写者租约(multispace-plan §5,门 1;与桌面壳同纪律):先于开库取
    // 目录级 OS 排他锁。锁文件永不删,句柄 manage 持到进程退出。
    let lease = spaces::WriterLease::acquire(&data_dir.join("writer.lock"))
        .unwrap_or_else(|e| panic!("{e}"));
    app.manage(lease);
    // 加密备份(backup-plan §17):路径域**必须与上面那把租约一一对应**,故就
    // 插在取到租约之后 —— 启动清扫要删明文,那时才排他、才敢删。
    // ⭐ `BackupPaths::production` 在安卓端**直接可用、core 零改动**:tauri 的
    // `getConfigDir` 与 `getDataDir` 在安卓返回同一个 `activity.dataDir`(§17.3
    // 源码级核过)⇒ 六个字段全落在 app 私有区、与 `writer.lock` 同域。
    // ⚠ `default_dir` 在手机端的语义是**中转 outbox,不是用户的落点**。
    let outbox = {
        let paths = zhujian_core::backup::BackupPaths::production(
            &config_dir,
            &data_dir,
            &data_dir.join("notebook.sqlite3"),
        );
        let outbox = paths.default_dir.display().to_string();
        app.manage(BackupOutbox(outbox.clone()));
        let coordinator = zhujian_core::backup::BackupCoordinator::new(
            paths,
            app.package_info().version.to_string(),
        );
        // 清不掉 = **封锁备份**(不拒启:用户还得能用 app 看自己的数据)。
        // ⚠ 这是 core 那半(staging 里的**明文**);私有 outbox 里的密文垃圾归壳
        // 自己清(§17.6,安卓在 MainActivity 启动那四步里),两边**刻意不同档**。
        if let Some(reason) = coordinator.sweep_on_start() {
            log::warn!("BACKUP_SWEEP {reason}");
        }
        app.manage(coordinator);
        outbox
    };
    // ---- 启动装配挪 blocking worker(codex 设计审 H4):前滚迁移是潜在
    // O(库大小) 的同步工作,不占启动线程——setup 只 manage「进行中」闸即返,
    // 前端轮询 startup_gate 等 ready/blocked(封锁页按 kind 分流处置)。
    // Ready 只在装配整段成功后落(codex H1:不许「闸已放行、装配死在半路」)。
    app.manage(Gate(std::sync::Mutex::new(GateStatus::Pending)));
    let handle = app.clone();
    let gate_handle = handle.clone();
    // JoinHandle 必须被消费(codex 实现审 M1):worker 内任意 panic 若只是
    // 被丢弃,Gate 永远停在 Pending、前端无限「正在准备」——外包一层 async
    // 监控,panic/cancel 都翻成可见的封锁态(retryable:数据未动,重启重试)。
    tauri::async_runtime::spawn(async move {
        let joined = tauri::async_runtime::spawn_blocking(move || {
            // ⭐ **装配之前先把目录原样报一遍**(OH-c/C3 立,D1 起两端共用):
            // 重置续跑 / 引导清扫 / 归位残留三条恢复路都发生在下面这几行里,而它们
            // **做完之后现场就没了**。一前一后两条日志 = 恢复真跑过的唯一字据。
            // ⚠ 在鸿蒙那端这**不是可选的**:那一端没有控制台、私有区 `hdc` 也够不着,
            // 「冷启之后目录里还剩什么」除了应用自己说,没有第二个人能回答。
            log::info!("DIR_BEFORE {}", dir_brief(&data_dir));
            // #4(codex 二审):清上次进程 kill/crash 残留的明文引导快照(手机
            // 常被系统 kill);必须在任何 transport 启动前。
            // 升档:清不掉 = **响亮**(明文完整库副本)。判据见 core 那边的头注。
            let boot_sweep = transport::sweep_stale_boot_files(&data_dir);
            if !boot_sweep.is_clean() {
                log::error!("BOOT_SWEEP {boot_sweep}");
            }
            let assembled = assemble_spaces(&handle, data_dir.clone());
            log::info!("DIR_AFTER {}", dir_brief(&data_dir));
            assembled
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
    outbox
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
        let dir = crate::test_temp::dir().join(format!("zj-android-{tag}-{}", std::process::id()));
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

    // ---- 加密备份的安卓半(backup-plan §17)------------------------------------------

    /// H-1 那道闸在**命令面**这一半的逐条阴性面(§17.16:⛔ 别只测正例)。
    ///
    /// ⭐ 它与 Kotlin 侧的 `SafPure.resolveOutboxChild` 是**同一条规则的两次落地**
    /// (命令面一次、桥面一次),两处都必须真拒 —— 少一处就等于没封。
    #[test]
    fn fetched_name_gate_rejects_everything_but_the_shell_made_name() {
        // 正例:壳自己造的「尺 4」名字。
        assert!(fetched_name_gate("verify-01JT0000000000000000000000.zjbak").is_ok());

        // ①路径分隔符与 `..` —— 桥面两个方向都只收**裸名**。
        let sep = format!("..{}verify-x.zjbak", std::path::MAIN_SEPARATOR);
        for bad in ["../verify-x.zjbak", "sub/verify-x.zjbak", "verify-..x.zjbak", &sep] {
            assert!(fetched_name_gate(bad).is_err(), "该拒:{bad}");
        }
        // ②扩展名(provider 可能把它改成 .bin —— 那种名字**不许**当落地名,§17.4-6)。
        assert!(fetched_name_gate("verify-x.bin").is_err());
        // ③⭐ **承重的那条**:不是 `verify-` 开头的一律拒 —— 验完要删掉这个文件,
        //    放行 core 的产物名等于给出一条「删掉一份还没搬走的真备份」的路,
        //    而那正是 `put` 唯一的、**不可再生**的锚。
        assert!(fetched_name_gate("zhujian-abcd1234-20260818T000000Z-01JT.zjbak").is_err());
        // ④空与点。
        for bad in ["", ".", ".."] {
            assert!(fetched_name_gate(bad).is_err(), "该拒:{bad}");
        }
    }

    /// outbox 的推导契约(§17.5 那道运行时相等闸的 Rust 那一半)。
    ///
    /// ⚠ **诚实边界**:这只测**只钉得住 Rust 这一侧** —— Kotlin 那边是
    /// `File(context.dataDir, "backups")`,跑不进 cargo,而两边硬编码同一个常量就是
    /// 判据自指(memory `verification-independence`;codex 二弹当场点名过这一格)。
    /// ⇒ **承重的是运行时那道闸**:开面时把这个值交给壳当场比,不等就一趟 transfer 都不许起。
    /// 这只测守的是另一件事:**哪天 core 把目录名从 `backups` 改掉,这里当场红** ——
    /// 否则壳会安安静静地去一个空目录里找文件。
    #[test]
    fn production_outbox_is_data_dir_slash_backups() {
        let data = PathBuf::from("/data/user/0/app.zhujian.notebook");
        let paths = zhujian_core::backup::BackupPaths::production(
            &data,
            &data,
            &data.join("notebook.sqlite3"),
        );
        assert_eq!(paths.default_dir.file_name().unwrap(), "backups");
        assert_eq!(paths.default_dir.parent().unwrap(), data.as_path());
        // ⭐ 安卓上 config 与 data 是**同一个** `activity.dataDir`(§17.3 源码级核过),
        // 于是钥与 staging 也落在这个域里,与 `writer.lock` 同域 —— 那正是 `BackupPaths`
        // 头注钉死的那条对应关系。
        assert_eq!(paths.config_path.parent().unwrap(), data.as_path());
        assert_eq!(paths.staging.parent().unwrap(), data.as_path());
    }

    /// 只给文件名不给路径(§17 那一节头注 2):前端手里从来没有一条完整路径可传。
    #[test]
    fn base_name_strips_both_separators() {
        assert_eq!(base_name("/data/user/0/pkg/backups/a.zjbak"), "a.zjbak");
        assert_eq!(base_name("a.zjbak"), "a.zjbak");
        let win = format!("C:{s}x{s}a.zjbak", s = '\\');
        assert_eq!(base_name(&win), "a.zjbak");
    }
}
