//! 桌面壳的空间策略层。97(sync-plan §六)在此落地全部多空间逻辑;multispace-plan
//! 工序 3+5 把「存在与身份」(发现/白名单/四不变量/只读描述符/建库/写者租约)上抬进
//! 共享层 `zhujian_core::spaces`、live 会话编排(activate/stop/运行时表)上抬进
//! `zhujian_core::sync::supervisor`(安卓壳同一套)——本文件只剩**桌面策略**:
//! 空间数不设上限(去 110 回归锚)、e2e 禁扫禁建、hard-veto 死空间陈列、空间生命周期互斥。

use std::path::PathBuf;
use std::sync::Arc;

use zhujian_core::sync::supervisor::{ActiveRuntime, SpaceSupervisor};

/// 逻辑与类型的共享层再导出:97 时这些都定义在本文件,上抬后消费方(lib.rs)
/// 的名字不变。
pub use zhujian_core::spaces::{
    create_space, discover, heal_legacy_space_name, identity_vetoes, read_descriptor,
    read_identity, reset_main_files, reset_space_files, resume_main_reset, set_space_name,
    space_name, sweep_stale_creating, sweep_stale_joining, JoiningSlot, SpaceIdentity, Veto,
    WriterLease, MAIN_SPACE,
};
/// 移动结果五分道上抬进 core(codex 安卓实现审 #5,两壳单一真相源);桌面 re-export
/// 保持 lib.rs / 前端契约名字不变。
pub use zhujian_core::move_item::MoveResult;

/// 空间数不设产品上限(109 决定①「任意多空间无上限」;110 曾以 `MAX_SPACES=2` 留作
/// 回归锚,2026-07-13 按用户拍板去除——空间多了无害、不需要限制)。桌面 eager 全连
/// 所有发现的空间;engine pending 64MiB/origin、单图拉流 32MiB、boot 快照磁盘峰值都
/// 按空间数放大,真堆到几十个再做 app 级聚合预算(ResourceGovernor,multispace-plan
/// §8 已推迟),当前自用不设限。`DESKTOP_MAX_LIVE = usize::MAX` = supervisor 永不因
/// 数量拒激活;discover 也不设 cap(全部合法空间文件都装载,不静默忽略)。
pub const DESKTOP_MAX_LIVE: usize = usize::MAX;

/// 装载不进表的死空间(hard veto:同一物理库两个名字)。切换器仍列出它并说明
/// 原因——文件在目录里却「消失」是静默,响亮原则不许。
pub struct DeadSpace {
    pub id: String,
    pub reason: String,
}

/// 桌面空间面:live 编排(core supervisor,`max_live = usize::MAX` 即 eager 全连
/// 所有发现的空间)+ 桌面策略字段。命令面唯一入口是 [`Spaces::get`](经 supervisor):
/// 读锁查表 → clone Arc → 放锁,绝不持表锁做 SQL / 网络 / 等控制通道(§六命令面定案)。
pub struct Spaces {
    pub sup: SpaceSupervisor,
    /// 空间库所在目录(新建空间落这里)。None = e2e/YS_DB_PATH 模式:禁扫也禁建(§六③)。
    pub dir: Option<PathBuf>,
    /// boot 引导临时文件目录(`<数据目录>/.boot`,§六①:不在空间扫描面里)。
    pub boot_dir: PathBuf,
    /// 空间生命周期互斥:建空间 / 创号 / 配对 / 加入整段串行(限额检查+建库+账户闸
    /// +插表之间不留并发窗口——「已有几个空间/谁占着哪个账户」的判断与后续动作必须
    /// 原子)。
    pub lifecycle: tokio::sync::Mutex<()>,
    /// 启动时被 hard veto 的空间(不装载、无 runtime;见 [`Veto::Hard`])。
    pub dead: Vec<DeadSpace>,
    /// Some = 「加入空间」正在跑(single-flight 标 + 取消信号;space-entry-plan §3.3)。
    /// Arc:join future 被 drop 时 reaper 任务要在 staging transport 真消亡后才清标
    /// (codex 二轮 M1),'static 任务须持有它。
    pub join_cancel: Arc<std::sync::Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
    /// 加入的账户 reservation(§3.5):GrantPending 起占、Integrated 释放;publish/
    /// 清理/集成失败后保留到进程重启(fail-closed);创号/main 配对的账户闸一并查。
    pub reserved_accounts: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl Spaces {
    pub fn new(
        sup: SpaceSupervisor,
        dir: Option<PathBuf>,
        boot_dir: PathBuf,
        dead: Vec<DeadSpace>,
    ) -> Spaces {
        Spaces {
            sup,
            dir,
            boot_dir,
            lifecycle: tokio::sync::Mutex::new(()),
            dead,
            join_cancel: Arc::new(std::sync::Mutex::new(None)),
            reserved_accounts: std::sync::Mutex::new(std::collections::HashSet::new()),
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<ActiveRuntime>, String> {
        self.sup.get(id)
    }

    /// 写命令/控制命令的取用口(space-entry-plan §3.2,codex 一轮 M3):transport 以
    /// ReopenRequired 收场(引导已提交、原连接还挂着引导库)后,**写与控制拒、读照常**
    /// ——状态面/浏览继续可用(与安卓分层一致),重启或重新装配即恢复(库本体已
    /// 可信提交,数据无损)。
    pub fn get_writable(&self, id: &str) -> Result<Arc<ActiveRuntime>, String> {
        let rt = self.sup.get(id)?;
        if let Some(e) = rt.restart_required() {
            return Err(format!("此空间的初始同步已完成,但需要重启朱简完成装配:{e}"));
        }
        Ok(rt)
    }

    /// 快照全部空间(表序不稳定,调用方自己排;用于 list_spaces 与不变量重查)。
    pub fn all(&self) -> Vec<Arc<ActiveRuntime>> {
        self.sup.all()
    }
}

// ---- 跨空间移动(cross-space-move v1,codex 设计审三轮已折入) ------------------------

/// 三原语编排(§2.2/三轮 #6):调用方(命令层)已持全局 `lifecycle` 互斥(single-
/// flight,与创号/配对同锁);本函数依序**独立拿放**两个空间的锁,绝不同时持有,
/// 无锁序/死锁面。M6 + 三轮 #1 后端验证在此,不信 UI 列表:源≠目标、两 runtime
/// 均存在(get 对未知/已停响亮)、**任一端带 `sync_veto` 一律拒**——soft-veto 的
/// runtime 可 get 可本地写,但 transport 根本不启动,移动产生的 op 进不了账户
/// 同步网(未配置账户但无 veto 的纯本地空间仍放行)。
pub fn move_between(
    spaces: &Spaces,
    source: &str,
    target: &str,
    item_id: &str,
) -> Result<MoveResult, String> {
    if source == target {
        return Err("目标空间就是当前空间,无需移动".to_string());
    }
    let src = spaces.get(source)?;
    let dst = spaces.get(target)?;
    if let Some(v) = src.veto() {
        return Err(format!(
            "当前空间的同步已被停用({v}),移动产生的删除进不了这个账户的同步网——先处理停用原因"
        ));
    }
    if let Some(v) = dst.veto() {
        return Err(format!(
            "目标空间的同步已被停用({v}),移过去的内容进不了那个账户的同步网——先处理停用原因"
        ));
    }
    // ReopenRequired 的写闸(space-entry-plan §3.2):两端任一 runtime 的连接已判
    // 「须重开」,移动的写不能落在它上面——重启朱简后再移。
    for rt in [&src, &dst] {
        if let Some(e) = rt.restart_required() {
            return Err(format!("空间需要重启朱简完成初始同步装配,暂不能移动:{e}"));
        }
    }
    // 原语一:导出(只持源锁;两道预检是业务结果,分道返回)。
    let pkg = {
        let (mut conn, _clock) = src.write_locks();
        // ReopenRequired 锁内复核(space-entry-plan §3.2,codex 二轮 M2;三段各自
        // 复核——旗可能在任意两段之间落下)。
        if let Some(e) = src.restart_required() {
            return Err(format!("当前空间需要重启朱简完成初始同步装配,暂不能移动:{e}"));
        }
        match zhujian_core::move_item::export(&mut conn, item_id)? {
            zhujian_core::move_item::ExportOutcome::Ready(p) => p,
            zhujian_core::move_item::ExportOutcome::ImagesPending { count } => {
                return Ok(MoveResult::ImagesPending { count })
            }
            zhujian_core::move_item::ExportOutcome::DanglingRefs { seqs } => {
                return Ok(MoveResult::DanglingRefs { seqs })
            }
        }
    };
    // 原语二:目标导入(只持目标锁;失败整体回滚,源分毫未动)。
    let new_id = {
        let (mut conn, mut clock) = dst.write_locks();
        if let Some(e) = dst.restart_required() {
            return Err(format!("目标空间需要重启朱简完成初始同步装配,暂不能移动:{e}"));
        }
        zhujian_core::move_item::import(&mut conn, &mut clock, &pkg)?
    };
    // 原语三:源库专用删除事务(只持源锁;重验指纹,拒删=CopiedButSourceKept)。
    // **目标 commit 之后不许再冒裸 Err**(codex 实现审 #1):finalize 出错时目标条目
    // 已真实存在,裸 Err 丢掉 new_id 会诱导用户重跑整个移动、制造第二份;源此刻
    // 删没删未知(可能死在 DELETE 后 commit 前),如实报 unconfirmed,不谎报 kept。
    let fin = {
        let (mut conn, mut clock) = src.write_locks();
        if let Some(e) = src.restart_required() {
            // 目标已建、源删被旗挡:如实走 unconfirmed 家族(绝不丢 new_id)。
            Err(format!("源空间需要重启朱简完成初始同步装配,删除未执行:{e}"))
        } else {
            zhujian_core::move_item::finalize_source(&mut conn, &mut clock, &pkg)
        }
    };
    Ok(MoveResult::from_finalize(new_id, fin))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use zhujian_core::clock::Clock;
    use zhujian_core::spaces as core_spaces;
    use zhujian_core::sync::supervisor::ActivateSpec;
    use zhujian_core::sync::transport;
    use zhujian_core::{images, notes};

    /// 造「main + 家庭」双 runtime 的桌面空间面(与 lib.rs 装配同构:开库正道 +
    /// supervisor reserve/commit;未配置账户的 transport 睡通道零打扰)。
    async fn boot_two(tag: &str) -> (Spaces, PathBuf) {
        let dir = std::env::temp_dir().join(format!("zj-move-shell-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        core_spaces::create_main_db(&dir).unwrap();
        core_spaces::create_space(&dir, "家庭").unwrap();
        let main_db = dir.join("notebook.sqlite3");
        let catalog = core_spaces::SpaceCatalog::load(&main_db, Some(&dir), None).unwrap();
        let sup = SpaceSupervisor::new(tokio::runtime::Handle::current(), DESKTOP_MAX_LIVE);
        let boot_dir = dir.join(".boot");
        for d in catalog.spaces() {
            let conn = core_spaces::open_space(d).unwrap();
            let clock = Clock::load(&conn).unwrap();
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            let res = sup.reserve(&d.id).unwrap();
            res.commit(
                ActivateSpec {
                    id: d.id.clone(),
                    path: d.path.clone(),
                    expected_file: Some(d.file),
                    events: tx,
                    boot_dir: boot_dir.clone(),
                    blob_policy: transport::BlobPolicy::Full,
                    allow_boot_source: true,
                    sync_veto: None,
                },
                conn,
                clock,
            )
            .unwrap();
        }
        (Spaces::new(sup, Some(dir.clone()), boot_dir, vec![]), dir)
    }

    fn fam_id(spaces: &Spaces) -> String {
        spaces.all().into_iter().map(|r| r.id.clone()).find(|id| id != MAIN_SPACE).unwrap()
    }

    /// 幸福路 + M6 验证:同空间拒、未知空间拒、happy 移动落目标且源消失。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_between_validates_and_moves() {
        let (spaces, dir) = boot_two("happy").await;
        let fam = fam_id(&spaces);
        let id = {
            let rt = spaces.get(MAIN_SPACE).unwrap();
            let (mut conn, mut clock) = rt.write_locks();
            notes::capture(&mut conn, &mut clock, "搬去家庭").unwrap()
        };
        assert!(move_between(&spaces, MAIN_SPACE, MAIN_SPACE, &id).is_err(), "同空间拒");
        assert!(move_between(&spaces, MAIN_SPACE, "01UNKNOWNSPACE00000000000X", &id).is_err());
        match move_between(&spaces, MAIN_SPACE, &fam, &id).unwrap() {
            MoveResult::Moved { new_id, source_already_gone } => {
                assert!(!source_already_gone);
                assert_ne!(new_id, id);
                let rt = spaces.get(&fam).unwrap();
                let conn = rt.db.lock().unwrap();
                let n: i64 = conn
                    .query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&new_id], |r| r.get(0))
                    .unwrap();
                assert_eq!(n, 1, "目标空间有了");
            }
            other => panic!("应 Moved,得到 {:?}", serde_json::to_string(&other)),
        }
        let rt = spaces.get(MAIN_SPACE).unwrap();
        let conn = rt.db.lock().unwrap();
        let n: i64 =
            conn.query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "源空间没了");
        drop(conn);
        drop(rt);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 三轮 #1:源或目标任一端带 sync_veto 一律拒(soft-veto 可 get、transport 不启动)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn veto_on_either_end_blocks_move() {
        let (spaces, dir) = boot_two("veto").await;
        let fam = fam_id(&spaces);
        let id = {
            let rt = spaces.get(MAIN_SPACE).unwrap();
            let (mut conn, mut clock) = rt.write_locks();
            notes::capture(&mut conn, &mut clock, "被 veto 挡下").unwrap()
        };
        *spaces.get(&fam).unwrap().sync_veto.lock().unwrap() = Some("身份复核不过".into());
        let err = move_between(&spaces, MAIN_SPACE, &fam, &id).unwrap_err();
        assert!(err.contains("停用"), "{err}");
        *spaces.get(&fam).unwrap().sync_veto.lock().unwrap() = None;
        *spaces.get(MAIN_SPACE).unwrap().sync_veto.lock().unwrap() = Some("时钟异常".into());
        let err = move_between(&spaces, MAIN_SPACE, &fam, &id).unwrap_err();
        assert!(err.contains("停用"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// codex 实现审 #1(故障注入):目标 commit 后源 finalize 出错——结果必须是
    /// 携带 new_id 的 CopiedButSourceUnconfirmed(裸 Err 会诱导重跑制造第二份),
    /// 目标条目在、源条目也还在(本例的注入让首个写语句就失败,事务整体没动源)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn finalize_failure_after_import_reports_unconfirmed_with_new_id() {
        let (spaces, dir) = boot_two("unconfirmed").await;
        let fam = fam_id(&spaces);
        let id = {
            let rt = spaces.get(MAIN_SPACE).unwrap();
            let (mut conn, mut clock) = rt.write_locks();
            notes::capture(&mut conn, &mut clock, "删源会失败").unwrap()
        };
        // 注入:源连接置只读——finalize 的临时归档 UPDATE 直接报错(目标导入用的是
        // 家庭空间连接,不受影响)。
        {
            let rt = spaces.get(MAIN_SPACE).unwrap();
            let conn = rt.db.lock().unwrap();
            conn.pragma_update(None, "query_only", true).unwrap();
        }
        let r = move_between(&spaces, MAIN_SPACE, &fam, &id).unwrap();
        {
            let rt = spaces.get(MAIN_SPACE).unwrap();
            let conn = rt.db.lock().unwrap();
            conn.pragma_update(None, "query_only", false).unwrap();
        }
        match r {
            MoveResult::CopiedButSourceUnconfirmed { new_id, error } => {
                assert!(!new_id.is_empty() && !error.is_empty());
                let rt = spaces.get(&fam).unwrap();
                let conn = rt.db.lock().unwrap();
                let n: i64 = conn
                    .query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&new_id], |r| r.get(0))
                    .unwrap();
                assert_eq!(n, 1, "目标条目已建、new_id 必须随结果带出");
            }
            other => panic!("应 CopiedButSourceUnconfirmed,得到 {other:?}"),
        }
        let rt = spaces.get(MAIN_SPACE).unwrap();
        let conn = rt.db.lock().unwrap();
        let n: i64 =
            conn.query_row("SELECT COUNT(*) FROM items WHERE id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "注入的失败发生在写入前,源条目原样保留");
        drop(conn);
        drop(rt);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// §2.3① 的壳层映射:缺字节图 → Ok(ImagesPending),不是 Err(UI 分道)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pending_images_map_to_structured_outcome() {
        let (spaces, dir) = boot_two("pending").await;
        let fam = fam_id(&spaces);
        let id = {
            let rt = spaces.get(MAIN_SPACE).unwrap();
            let (mut conn, mut clock) = rt.write_locks();
            let id = notes::capture(&mut conn, &mut clock, "有图在路上").unwrap();
            let (img, _) = images::attach(&mut conn, &mut clock, &id, &[1], "image/png").unwrap();
            // 行删 op 留(无 tombstone)= 轻端「op 到字节没到」的库形态。
            conn.execute("DELETE FROM item_image WHERE id = ?1", [&img]).unwrap();
            id
        };
        match move_between(&spaces, MAIN_SPACE, &fam, &id).unwrap() {
            MoveResult::ImagesPending { count } => assert_eq!(count, 1),
            other => panic!("应 ImagesPending,得到 {:?}", serde_json::to_string(&other)),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
