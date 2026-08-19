package app.zhujian.notebook

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * 加密备份的安卓落点(backup-plan §17 笔③)——**SAF 那条桥**。
 *
 * ⭐ **一句话形:Kotlin 只搬密文**。备份整套仍由 core 的 `BackupCoordinator` 在 app 私有区
 * 跑完(整库明文快照全程锁在 0700 的 `.backup-staging` 里,由 core 建、由 core 销毁),
 * 产出的**密文**落私有 outbox(`<dataDir>/backups`),这条桥只负责把它拷进用户用系统
 * 选择器挑的那个目录。⇒ 桥面见到的第一个字节就已经是密文。
 *
 * ⛔ **桥面只开五个文件操作入口**(`pickTree` / `currentTree` / `putFile` / `listTree` /
 * `fetchFile`)——⛔ 不给「写任意路径」「读任意路径」的通用入口:那会把 419 立的那条
 * 「只认备份目录里的文件,否则等于拿备份钥解任意路径」在这一端从桥上绕过去。
 * ⚠ **另有两个不碰文件字节的入口**(`expectOutbox` 一致性闸 / `startupState` 只读自家 prefs)
 * —— 实现审一弹 L-1:按字面 `@JavascriptInterface` 是**七个**,别再说「只有五个」。
 * ⚠ 并且 `expectOutbox` 收的值来自 JS,⛔ **它是漂移/可用性闸,不是对付恶意 renderer 的
 * 安全边界** —— 安全那半全靠下面两条(裸名 + 当前 tree 重建),别把它当第三道。
 *
 * ⛔ **两个方向都不收路径,只收名字**(codex 一弹 H-1,§17.5 那张表):规格第一版只给
 * `fetchFile` 的目标钉了闸、把 `putFile` 的**源**敞着 —— 那等于一条「把私有区任意文件搬进
 * 用户目录」的路,**`.backup-staging` 里那份整库明文快照**与 `.backup.json`(明文钥)当场
 * 可外泄。四条校验在 [SafPure.resolveOutboxChild],⛔ 别在这里另写一份。
 *
 * ⛔⛔ **同一个洞在实现里又长回来过一次,两条修法缺一不可**(实现审一弹 H-1):
 * `fetchFile` 当初收的是**任意字符串 URI**,而 `ContentResolver.openInputStream` **认 `file://`**
 * ⇒ 先 `fetchFile("file:///data/user/0/<pkg>/.backup.json")` 把明文钥读成一份
 * `verify-<ULID>.zjbak`(那个名字**天然过得了** outbox 那四条校验),再 `putFile` 把它搬进
 * 用户目录 —— **两个各自"封好"的入口串起来,就是一条通用外泄管道**。
 * ⇒ ①`fetchFile` 的目标必须由 [SafBridge.docInCurrentTree] 从**当前 tree 重建**;
 * ②`putFile` 的源必须过 [SafPure.isProductName](只认 core 的产物名、显式拒掉 `verify-`)。
 * ⭐ 判据一句:**每个入口自己看都封住了,不等于它们的组合封住了。**
 *
 * ⚠ 与已有两条窄桥(250 `__zhujianSystemBars` / 251 `__zhujianTextSize`)**形不同**:那两条
 * 打完就走,这条要等系统选择器 / 一次文件拷贝的结果 ⇒ 异步应答 + reqId 表。
 * ⛔ **但回调不是真相源**(§17.5):低内存下 Activity 会被回收重建、WebView 重载,挂着的
 * promise 就没了。真相源是 SharedPreferences 里那条 `transfer` 记录 + 那个 tree URI,
 * 面每次打开都重新问一次,不指望回调把状态带回来。
 */

/**
 * 进程级单例。⛔ **single-flight 那把锁与后台 worker 必须活在这里,不是桥实例上**
 * (codex 二弹 M):`onWebViewCreate` 会在 **Activity 重建**时再跑一遍,锁若跟着新桥实例走,
 * **旧的那趟拷贝还在后台跑、新桥却又放行一趟** —— H-3 原样回来。
 * Kotlin 的 `object` 挂在类加载器上 ⇒ 与进程同生共死,正是要的那个寿命。
 * ⇒ `onWebViewCreate` 只许把桥**指向**它,⛔ 不许重置它。
 */
object SafState {
    /** 当前在飞那一趟的 `transferId`;`null` = 空闲。⭐ CAS 决出唯一赢家。 */
    val inFlight = AtomicReference<String?>(null)

    /** 拷贝跑在这上面 —— ⛔ 不许在 binder 线程(桥面)或 UI 线程上拷(ANR,§17.4-5)。 */
    val io = Executors.newSingleThreadExecutor { r -> Thread(r, "zhujian-saf").apply { isDaemon = true } }

    /**
     * ⛔ **只读的列目录**另走一条线,⛔ **不许与 [io] 共用**(实现审弹 2 复核轮的 M):
     * 共用那条单线程时,一次大目录 / 慢云盘的列表会**排在 transfer 前面**,而 `putFile` 已经
     * claim 了锁、写了 `running`、把 `transferId` 回给了 JS —— 轮询于是如实看到
     * `running + busy=true` 一直等,**备份搬运被列表饿死**。
     * ⚠ 分线**不破** outbox 的单写者不变量:列目录一个字节都不碰 outbox。
     */
    val listIo = Executors.newSingleThreadExecutor { r ->
        Thread(r, "zhujian-saf-list").apply { isDaemon = true }
    }

    /** 列表的 single-flight:⛔ 连点「刷新」不许排进无限个全量扫描(同上一条 M)。 */
    val listing = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Rust 侧交来的 outbox 期望值(§17.5 那道运行时相等闸)。⭐ 它**只用来比对**,
     * ⛔ 永远不用来打开文件 —— 打开的恒是壳自己 join 出来的那条(H-1)。
     */
    @Volatile
    var expectedOutbox: String? = null

    /** 选择器在飞的那个 reqId(Activity 重建后回调仍会来,那时 JS 那边的 promise 已经没了)。 */
    @Volatile
    var pickReqId: Double = -1.0

    /**
     * 启动收尸做过了没有。⛔ **它必须是进程级的,不是 Activity 级的**(实现审一弹 H-2):
     * `onCreate` 会在转屏 / 低内存回收时再跑一遍,而那时**进程没死** —— 再收一次尸会把一趟
     * **正在跑**的记录改成 `failed`,紧接着的清扫还会 unlink worker 正在写的文件。
     */
    val settled = java.util.concurrent.atomic.AtomicBoolean(false)
}

/** SharedPreferences 那份**真相源**。⛔ 别往 `.backup.json` 里加字段(§15.4 原样适用)。 */
object SafStore {
    private const val PREFS = "zhujian.backup"
    private const val K_TREE = "tree_uri"
    private const val K_XFER = "xfer"
    private const val K_LEDGER = "ledger"

    /**
     * ⛔ **两个独立的布尔位,不是一枚三选一的枚举**(codex 六弹 M):
     * 「记录读不出来」与「清扫只清掉一半」**会同时发生**,单枚枚举只存得下一个、
     * 另一个事实当场丢失。⚠ 它们是 **UI 的输入**,⛔ 不是准入的输入 —— 别让一堆密文垃圾
     * 剥夺用户再备份一次的能力(与 core 那边 `sweep_on_start` 的「清不干净就封锁」端间
     * 不一致,而这个不一致是对的:core 那边清的是**明文**)。
     */
    private const val K_HEALTH_RECORD = "backup_health_record_unknown"
    private const val K_HEALTH_CLEANUP = "backup_health_cleanup_failed"

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun outbox(c: Context): File = File(c.dataDir, "backups")

    fun tree(c: Context): Uri? = prefs(c).getString(K_TREE, null)?.let { Uri.parse(it) }

    fun setTree(c: Context, uri: Uri) {
        prefs(c).edit().putString(K_TREE, uri.toString()).commit()
    }

    fun record(c: Context): SafPure.Transfer? = parseRecord(prefs(c).getString(K_XFER, null))

    /**
     * ⛔ **`commit()` 不是 `apply()`**(codex 三弹 M):记录必须**先可靠落盘**,再起 worker、
     * 再把 `transferId` 回给 JS。否则存在这个窗口 —— 进程在记录落盘之前被杀 ⇒ 启动时既没有
     * `running` 记录可收尸、outbox 那份又被照常清掉,而 SAF 里可能已经躺着一份半截,
     * 用户面上表现成「什么都没发生过,但文件夹里多了个打不开的东西」。
     * ⇒ 回 `false` = **这一趟不起**(不起 worker、不回 transferId,响亮说)。
     */
    fun writeRecord(c: Context, t: SafPure.Transfer): Boolean {
        val o = JSONObject()
        o.put("transferId", t.transferId)
        o.put("kind", t.kind)
        o.put("outboxName", t.outboxName)
        o.put("docId", t.docId ?: JSONObject.NULL)
        o.put("displayName", t.displayName ?: JSONObject.NULL)
        o.put("state", t.state)
        o.put("reason", t.reason ?: JSONObject.NULL)
        o.put("retryable", t.retryable)
        return prefs(c).edit().putString(K_XFER, o.toString()).commit()
    }

    fun parseRecord(raw: String?): SafPure.Transfer? {
        if (raw.isNullOrEmpty()) return null
        val o = JSONObject(raw) // 抛 = 记录损坏,由调用方按「状态未知」处置
        val t = SafPure.Transfer(
            transferId = o.getString("transferId"),
            kind = o.getString("kind"),
            outboxName = o.getString("outboxName"),
            docId = o.optString("docId", "").ifEmpty { null },
            displayName = o.optString("displayName", "").ifEmpty { null },
            state = o.getString("state"),
            reason = o.optString("reason", "").ifEmpty { null },
            retryable = o.optBoolean("retryable", false),
        )
        // ⛔ **键在不在 ≠ 值合不合法**(实现审一弹 M-3):一条 `kind:"potato"` 或空
        // `transferId` 的记录,字段齐全却语义已坏 —— 放它过去,收尸与轮询都会拿它当正常记录,
        // 而「状态未知」那条路本来就是为这种东西留的。⇒ 值域不对就抛,按记录损坏处置。
        if (!SafPure.isValid(t)) throw IllegalStateException("在飞记录的值域不合法")
        return t
    }

    fun recordJson(t: SafPure.Transfer?): JSONObject? {
        if (t == null) return null
        return JSONObject()
            .put("transferId", t.transferId)
            .put("kind", t.kind)
            .put("outboxName", t.outboxName)
            .put("docId", t.docId ?: JSONObject.NULL)
            .put("displayName", t.displayName ?: JSONObject.NULL)
            .put("state", t.state)
            .put("reason", t.reason ?: JSONObject.NULL)
            .put("retryable", t.retryable)
    }

    /**
     * **本机产出账**(§17.9)——⛔ 它是**加速索引,不是有效性判据**,更不是过滤边界:
     * 账里有 = 「这是我写出去的」,不等于「它是好的」,列表里默认仍是「还没验过」。
     * ⚠ 它也**不是**「这些就是全部备份」:用户抄下码之后清数据 / 卸载,账没了而 SAF 里那些
     * 备份在桌面上拿码照样解得开 ⇒ 被 provider 改过名的那份要靠「其他文件」那条恒显的路
     * 才找得回来(codex 二弹 M 的反例)。
     */
    fun ledger(c: Context): JSONArray =
        try {
            JSONArray(prefs(c).getString(K_LEDGER, "[]"))
        } catch (e: Exception) {
            JSONArray()
        }

    fun addLedger(c: Context, docId: String, displayName: String, outboxName: String) {
        val arr = ledger(c)
        val next = JSONArray()
        // 同一个 docId 重试覆盖写时只留一条(⛔ 别攒重复项占掉 200 的名额)。
        for (i in 0 until arr.length()) {
            val e = arr.optJSONObject(i) ?: continue
            if (e.optString("docId") != docId) next.put(e)
        }
        next.put(
            JSONObject()
                .put("docId", docId)
                .put("displayName", displayName)
                .put("outboxName", outboxName)
                .put("ms", System.currentTimeMillis())
        )
        // 上界:超了丢最老的(**丢账不丢文件** —— 那份仍在用户目录里)。
        val trimmed = JSONArray()
        val start = maxOf(0, next.length() - SafPure.LEDGER_CAP)
        for (i in start until next.length()) trimmed.put(next.get(i))
        prefs(c).edit().putString(K_LEDGER, trimmed.toString()).commit()
    }

    fun ledgerDocIds(c: Context): Set<String> {
        val arr = ledger(c)
        val out = HashSet<String>()
        for (i in 0 until arr.length()) arr.optJSONObject(i)?.optString("docId")?.let { out.add(it) }
        return out
    }

    /** ⛔ 两个位**每次启动都恰写一次**(包括「这次没事」也要显式写 `false`)—— 否则上一次的
     *  旧值会冒充这一次的事实。 */
    fun writeHealth(c: Context, recordUnknown: Boolean, cleanupFailed: Boolean): Boolean =
        prefs(c).edit()
            .putBoolean(K_HEALTH_RECORD, recordUnknown)
            .putBoolean(K_HEALTH_CLEANUP, cleanupFailed)
            .commit()

    /** 事后把「记录写不进去」这件事补记进健康位(worker 的终态 commit 失败那条路)。 */
    fun flagRecordUnknown(c: Context) {
        val (_, cleanup) = health(c)
        if (!writeHealth(c, true, cleanup)) {
            android.util.Log.w("zhujian", "BACKUP_RECORD 健康位也写不进去")
        }
    }

    fun health(c: Context): Pair<Boolean, Boolean> =
        Pair(
            prefs(c).getBoolean(K_HEALTH_RECORD, false),
            prefs(c).getBoolean(K_HEALTH_CLEANUP, false),
        )

    /**
     * 启动那一刻的四步,**顺序写死**(codex 三弹:原文只写了「同一刻」,没写谁先谁后):
     * 1. **先读**在飞记录 —— ⛔ 一定在清扫之前读,否则「上次那趟干到哪儿了」这个事实就被
     *    自己删没了;
     * 2. `running` ⇒ 收尸,并**按 `kind` 分支**(⛔ 一刀切会把 `fetch` 的合法重建一起撤掉);
     * 3. **再**清扫 outbox(§17.6:密文垃圾,不是安全问题是垃圾问题);
     * 4. **最后**落那两个健康位(UI 下次开面自然读到)。
     *
     * ⛔ 每一步自己失败了也要写死、不许 `runCatching {}` 静默吞 —— 逐条见函数体里的注释。
     */
    fun startupSettle(c: Context) {
        // ⛔⛔ **每进程恰一次,不是每个 Activity 一次**(实现审一弹 H-2)。
        // `onCreate` 会在**转屏 / 低内存回收**时再跑一遍,而那时**进程没死**:worker 还在拷、
        // `SafState.inFlight` 还指着它 —— 再跑一遍收尸就会把一趟**正在跑**的记录改成 `failed`,
        // 紧接着的清扫还会 unlink 它正在写的文件(甚至删掉 core 刚产出、还没搬走的真产物)。
        // ⇒ 进程级 CAS 挡住第二次;再加一道「有在飞就不动」当纵深(两条各挡一半:
        // CAS 挡的是重建,后者挡的是「哪天有人从别处又调了一次」)。
        // ⚠ **两道的顺序不能反**:先看在飞、再 CAS —— 反过来的话,一次「因为有在飞而跳过」
        // 会把 `settled` 永久置真,这个进程从此再也不会收尸。
        if (SafState.inFlight.get() != null) {
            android.util.Log.w("zhujian", "BACKUP_SETTLE 有在飞的 transfer,跳过启动收尸")
            return
        }
        if (!SafState.settled.compareAndSet(false, true)) return
        // 1
        var recordUnknown = false
        val raw = try {
            prefs(c).getString(K_XFER, null)
        } catch (e: Exception) {
            recordUnknown = true
            null
        }
        val parsed = try {
            parseRecord(raw)
        } catch (e: Exception) {
            // ⛔ 记录损坏 = **状态未知**,不是「没有在飞记录」:照旧往下清扫,UI 响亮说。
            recordUnknown = true
            null
        }
        // 2
        if (parsed != null) {
            val settled = SafPure.settle(parsed)
            if (settled != null && settled != parsed && !writeRecord(c, settled)) {
                // 写回失败:响亮 + **这一趟别撤重试入口以外的东西**;下次启动继续收敛(幂等)。
                android.util.Log.w("zhujian", "BACKUP_SETTLE 收尸写回失败,下次启动继续")
                recordUnknown = true
            }
        }
        // 3
        val cleanupFailed = sweepOutbox(c)
        // 4 ⛔ 这一步自己失败也不许静默(实现审一弹 M-3):写不进去 = 这两格状态**没有稳定的家**,
        //   下次启动会读到上一次的旧值并把它当成本次的事实。
        if (!writeHealth(c, recordUnknown, cleanupFailed)) {
            android.util.Log.w("zhujian", "BACKUP_SETTLE 健康位写不进去,界面读到的可能是上一次的")
        }
    }

    /**
     * 清 outbox 里的密文垃圾(拷到一半被杀会留一份半截)。回 `true` = **有清不掉的**。
     *
     * ⛔ **绝不显示成「已清理」**(§17.10 那张表第 3 行):部分失败要记 `cleanup_failed` 并
     * 响亮提示,下次启动继续收敛。⚠ 这一刻不可能有在飞的拷贝 —— 进程若在拷贝期间被杀,
     * 那趟本就是废的(§17.6,与 391 `clearCaptureLeftovers` 同一条判据)。
     */
    private fun sweepOutbox(c: Context): Boolean {
        val dir = outbox(c)
        // ⛔ **「目录不存在」与「读不出来」是两件事**(实现审一弹 M-3):`listFiles()` 两种
        // 情况都回 `null`,把它们收成一个 `return false` 等于把一次 I/O 故障说成「已清理」。
        if (!dir.exists()) return false // 一份都还没备过,不是故障
        val files = try {
            dir.listFiles()
        } catch (e: Exception) {
            android.util.Log.w("zhujian", "BACKUP_SWEEP 读不了中转目录:${e.message}")
            return true
        } ?: run {
            android.util.Log.w("zhujian", "BACKUP_SWEEP 中转目录在、却列不出来")
            return true
        }
        var failed = false
        for (f in files) {
            if (!f.isFile || !SafPure.isSweepable(f.name)) continue
            if (!f.delete()) {
                android.util.Log.w("zhujian", "BACKUP_SWEEP 删不掉 ${f.name}")
                failed = true
            }
        }
        return failed
    }
}

/**
 * 桥本体。⚠ 所有 `@JavascriptInterface` 方法跑在 **binder 线程**上:小写入(`commit()` 一条
 * 小记录)可以接受,**拷贝一律挪 [SafState.io]**(§17.4-5)。
 */
class SafBridge(private val activity: MainActivity) {

    // ---- 五个入口 ------------------------------------------------------------------

    /**
     * 挑落点(仅首次 / 换目录)。⛔ 没有超时 —— 选择器可以开着好几分钟(§17.5 末)。
     * 结果由 [MainActivity] 的 launcher 回来,那时才 `takePersistableUriPermission`。
     */
    @JavascriptInterface
    fun pickTree(reqId: Double) {
        SafState.pickReqId = reqId
        activity.runOnUiThread { activity.launchTreePicker() }
    }

    /**
     * 现在的落点是什么(同步)。⭐ **面每次打开都重新问一次** —— 回调可能永远不来
     * (进程被杀),真相源在 SharedPreferences。
     *
     * ⚠ 「落点还在不在」用**便宜那招**:持久授权 + 一次轻量 `canWrite`;
     * ⛔ **不做「假写一个探针文件」**(会在用户目录里留垃圾,而 v1 不给删除入口)。
     * 真写之前不加额外探测 —— 写本身就是探测(§17.10 末)。
     */
    @JavascriptInterface
    fun currentTree(): String {
        val o = JSONObject()
        val uri = SafStore.tree(activity)
        if (uri == null) {
            o.put("configured", false)
            return o.toString()
        }
        o.put("configured", true)
        o.put("uri", uri.toString())
        o.put("name", treeLabel(uri))
        o.put("writable", treeWritable(uri))
        return o.toString()
    }

    /**
     * 把 outbox 里那份密文搬进用户的目录。**同步**返回 `{transferId}`(或 `{error}`),
     * 真拷贝在 [SafState.io] 上。
     *
     * ⭐ **闸在这儿,不在 UI 置灰上**(codex 一弹 H-3):`BackupCoordinator` 在 `run_backup()`
     * 返回那一刻就把准入还回去了,而拷贝还在跑 —— UI 置灰只是提示,双击 / 事件重入 /
     * 面被重建都能再进来一趟。`putFile` 与 `fetchFile` **共用同一把** single-flight:
     * 两者都在动 outbox,幕⑤ 的回拷若与幕③ 的搬运同时跑,会让「无论成败都删掉回拷」删到别人的东西。
     */
    @JavascriptInterface
    fun putFile(reqId: Double, outboxName: String): String {
        val tree = arrayOfNulls<Uri>(1)
        preflight(tree)?.let { return err(it) }
        val gate = tree[0]!!
        // ⛔⛔ **只许搬 core 自己的产物**(实现审一弹 H-1 的第二半闸)——⛔ 别以为
        // `resolveOutboxChild` 那四条够了:`fetchFile` 会把东西落成壳自己造的
        // `verify-<ULID>.zjbak`,而那个名字**天然过得了**那四条 ⇒「先 fetch 进来、再 put 出去」
        // 就是一条通用外泄管道。这道闸把 `verify-` 整个名字空间挡在外面。
        if (!SafPure.isProductName(outboxName)) return err("只能搬备份产物")
        val holder = arrayOfNulls<File>(1)
        SafPure.resolveOutboxChild(SafStore.outbox(activity), outboxName, holder)?.let {
            return err(it)
        }
        val src = holder[0]!!
        // ⭐ 重试 = **新的 `transferId`、同一个 `docId`**(⛔ 不再 `createDocument`,否则用户
        // 目录里会攒下 `…(1).zjbak` 一串半截货,而 v1 又不给删除入口)。
        // ⚠ 记录损坏时 `record()` 会抛(值域校验,M-3)—— 这条路上**当没有记录处置**:
        // 坏记录里的 `docId` 本来就不可信,新建一份文档是安全的那一侧。
        // ⛔ 别让它从 `@JavascriptInterface` 里抛出去(JS 那边只会收到一个没头没尾的异常)。
        val lastRecord = try {
            SafStore.record(activity)
        } catch (e: Exception) {
            android.util.Log.w("zhujian", "BACKUP_RECORD 读不出上一趟(${e.message}),按没有处置")
            null
        }
        // ⛔ 第三条锚:旧 `docId` 必须**属于当前这棵 tree**(实现审二弹 M)——
        // 换过文件夹之后,旧授权并不会被撤销,直接复用会把新一趟覆盖写进**旧文件夹**里,
        // 而界面照说成功。重建不出来就不复用,在当前 tree 新建一份是安全的那一侧。
        val reuse = SafPure.putTargetDocId(lastRecord, outboxName) { docInCurrentTree(gate, it)?.toString() }
        val id = SafPure.ulid()
        if (!SafPure.claim(SafState.inFlight, id)) return err("上一趟还在跑,请等它结束")
        val rec = SafPure.Transfer(
            transferId = id,
            kind = SafPure.KIND_PUT,
            outboxName = outboxName,
            docId = reuse,
            displayName = null,
            state = SafPure.STATE_RUNNING,
            reason = null,
            retryable = true,
        )
        if (!SafStore.writeRecord(activity, rec)) {
            SafPure.release(SafState.inFlight, id)
            return err("这一趟没能记下来(存储写不进),没有开始")
        }
        SafState.io.execute { runPut(reqId, id, gate, src, reuse) }
        return JSONObject().put("transferId", id).toString()
    }

    /**
     * 列目录(异步)。⛔ **常量闸**:最多 [SafPure.LIST_CAP] 条,超出**明说截断**;
     * 「其他文件」那个 N **饱和计数**(数到 201 就停)—— ⛔ 要一个精确的 N 就得遍历整个目录,
     * 而**工作量的上界必须与展示的上界一致**(codex 三弹 M)。
     *
     * `mode = "all"` = 全量候选(用户点开那条恒显的「还有 N 个其他文件」)。
     */
    @JavascriptInterface
    fun listTree(reqId: Double, mode: String) {
        // ⛔ 已经有一趟在读就**当场说**,⛔ 不排队(连点「刷新」会排进无限个全量扫描)。
        if (!SafState.listing.compareAndSet(false, true)) {
            resolve(reqId, JSONObject().put("error", "上一次读取还没完成"))
            return
        }
        // ⛔ 走 `listIo` 不是 `io`:只读的列目录**绝不许排在 transfer 前面**把它饿死。
        SafState.listIo.execute {
            try {
                resolve(reqId, listTreeSync(mode == "all"))
            } catch (e: Exception) {
                resolve(reqId, JSONObject().put("error", "读不了这个文件夹:${e.message}"))
            } finally {
                SafState.listing.set(false)
            }
        }
    }

    /**
     * 把用户目录里那一份**回拷**进 outbox,好交给 core 真解一遍(幕⑤)。
     *
     * ⛔ **落地名由壳自己造**(尺 4 `verify-<ULID>.zjbak`),⛔ 既不来自请求名、也不来自
     * provider 的**回读名** —— 后者可能已被改成 `.bin`,而 core 的 `verify_backup` 在真解
     * 之前有一道 `.zjbak` 扩展名闸,照回读名落地会让一份**好备份**在验之前就被拒(§17.4-6)。
     *
     * ⚠ 「验完删掉那份回拷」由 **Rust 那条命令**在 `finally` 位置做 —— 它与消费者同一处,
     * 桥上因此不必再开第六个入口(也就没有「删任意 outbox 文件」这个能力面)。
     */
    @JavascriptInterface
    fun fetchFile(reqId: Double, docId: String): String {
        val tree = arrayOfNulls<Uri>(1)
        preflight(tree)?.let { return err(it) }
        // ⛔⛔ **本案第二重的一条**(实现审一弹 H-1):这里此前收的是**任意字符串 URI**,
        // 而 `ContentResolver.openInputStream` **认 `file://`** ⇒
        // `fetchFile("file:///data/user/0/<pkg>/.backup.json")` 就能把**明文钥**读进 outbox,
        // 再 `putFile` 搬进用户目录 —— §17.3 那条唯一的安全论证被两个入口串起来打穿。
        // ⇒ 这一趟要读的文档**必须由我们自己从当前 tree 重建**(与「尺 4 落地名壳自己造」
        // 同一条纪律:⛔ 外面递进来的字符串只当**参数**,永远不当**权柄**)。
        val doc = docInCurrentTree(tree[0]!!, docId) ?: return err("这份文件不在你选的文件夹里")
        val localName = SafPure.fetchLocalName(SafPure.ulid())
        val id = SafPure.ulid()
        if (!SafPure.claim(SafState.inFlight, id)) return err("上一趟还在跑,请等它结束")
        val rec = SafPure.Transfer(
            transferId = id,
            kind = SafPure.KIND_FETCH,
            outboxName = localName,
            // ⭐ 记的是**我们重建出来的那个**,不是外面递进来的字符串(重试要拿它再取一次)。
            docId = doc.toString(),
            displayName = null,
            state = SafPure.STATE_RUNNING,
            reason = null,
            retryable = true,
        )
        if (!SafStore.writeRecord(activity, rec)) {
            SafPure.release(SafState.inFlight, id)
            return err("这一趟没能记下来(存储写不进),没有开始")
        }
        SafState.io.execute { runFetch(reqId, id, doc, localName) }
        return JSONObject().put("transferId", id).toString()
    }

    // ---- 两个不碰文件的辅助入口(⚠ 它们不构成任何读写授权)---------------------------

    /**
     * 收下 Rust 侧算的 outbox 期望值并**当场比对**(§17.5 那道运行时相等闸,codex 二弹 M:
     * 光有一只测不够 —— 运行时不相等就直接拒)。
     *
     * ⚠ **这不违反 H-1**:传过来的是**用来比对的期望值**,不是用来打开文件的路径;
     * `putFile` 打开的仍然只是壳自己 join 出来的那条。
     * 理由 = 这是**漂移**类风险(哪天 tauri 改了 `getDataDir`、或我们换了 identifier),
     * 而漂移的表现会是「备份说成功了、文件搬不过去」—— 最不能静默的一类。
     */
    @JavascriptInterface
    fun expectOutbox(path: String): String {
        SafState.expectedOutbox = path
        val mine = SafStore.outbox(activity)
        val same = try {
            File(path).canonicalPath == mine.canonicalPath
        } catch (e: Exception) {
            File(path).absolutePath == mine.absolutePath
        }
        return if (same) "" else "安装形态与预期不符:备份中转目录 ${mine.absolutePath} ≠ $path"
    }

    /** 启动那四步留下的事实:两个健康位 + 上一趟的记录(UI 据此说话,⛔ 不据此挡新备份)。 */
    @JavascriptInterface
    fun startupState(): String {
        val (recordUnknown, cleanupFailed) = SafStore.health(activity)
        val o = JSONObject()
        o.put("recordUnknown", recordUnknown)
        o.put("cleanupFailed", cleanupFailed)
        o.put("busy", SafState.inFlight.get() != null)
        val last = try {
            SafStore.record(activity)
        } catch (e: Exception) {
            null
        }
        // ⛔ **`fetch` 的「可再取」不是无条件的**(codex 六弹 M):§17.4-3 自己就写着授权会被撤、
        // 目录会被删、OTG 会被拔 ⇒ `docId` 不保证还解析得开。三条锚前提任一不成立就**不显示
        // 重试入口** —— 摆一个点下去必然失败的按钮,比说实话更糟。判据要在**点之前**问。
        val j = SafStore.recordJson(last)
        if (j != null && last!!.retryable && last.kind == SafPure.KIND_FETCH) {
            // ⭐ 三条锚:①还属于**当前**这棵 tree(换过文件夹之后旧 `docId` 就不算数了,
            // 与 H-1 那道闸同一个函数);②授权还在;③文档还在。
            val tree = SafStore.tree(activity)
            val doc = if (tree != null && last.docId != null) docInCurrentTree(tree, last.docId) else null
            j.put("retryable", doc != null && treeWritable(tree!!) && docAlive(doc.toString()))
        }
        o.put("last", j ?: JSONObject.NULL)
        return o.toString()
    }

    // ---- 内部 ----------------------------------------------------------------------

    /**
     * 起任何一趟 transfer 之前的共同前提。回 `null` = 过;回字符串 = **拒的理由**。
     *
     * ⛔ **三种拒必须说三句不同的话**:「装的形不对」「还没挑落点」「落点没了」各有各的下一步,
     * 糊成一句「备份失败」等于什么都没说(§17.10 那张表的通则)。
     */
    private fun preflight(out: Array<Uri?>): String? {
        val expected = SafState.expectedOutbox ?: return "还没核对安装形态,请退出这一页重进"
        val mine = SafStore.outbox(activity)
        val same = try {
            File(expected).canonicalPath == mine.canonicalPath
        } catch (e: Exception) {
            File(expected).absolutePath == mine.absolutePath
        }
        if (!same) return "安装形态与预期不符:备份中转目录 ${mine.absolutePath} ≠ $expected"
        val uri = SafStore.tree(activity) ?: return "还没挑落点"
        if (!treeWritable(uri)) return "落点没了,请重新挑一个文件夹"
        out[0] = uri
        return null
    }

    /**
     * worker 侧写在飞记录 —— ⛔ **结果不许丢**(实现审一弹 M-1)。
     *
     * 起头那次 `commit()` 失败可以「这一趟不起」,而**终态**这几次失败没法回滚:活儿已经干了。
     * ⇒ 能做的是**别让它安静**:记录会停在 `running` 而锁已经放掉,那正是「界面永远转圈」的形。
     * 补记一枚 `record_unknown` 健康位,UI 下次开面就会说「上次那趟的状态读不出来」。
     */
    private fun note(t: SafPure.Transfer) {
        // 故障注入(⑬,编译期门控见 [SafFault]):终态那次 commit 失败一次,走的是**同一条**
        // 补救路径 —— ⛔ 别在这里另写一份「假装失败」的分支,那样验的就不是真代码了。
        if (SafFault.swallowTerminalCommit(t.state)) {
            android.util.Log.w("zhujian", "BACKUP_RECORD (注入)终态写不进去,状态将标为未知")
            SafStore.flagRecordUnknown(activity)
            return
        }
        if (SafStore.writeRecord(activity, t)) return
        android.util.Log.w("zhujian", "BACKUP_RECORD 写不进去(${t.kind}/${t.state}),状态将标为未知")
        SafStore.flagRecordUnknown(activity)
    }

    private fun runPut(reqId: Double, id: String, tree: Uri, src: File, reuse: String?) {
        var doc: Uri? = reuse?.let { Uri.parse(it) }
        try {
            if (doc == null) {
                // ⚠ 尺 2 = 向 SAF **请求**的名(= 尺 1);⛔ 绝不当成盘上的名 —— provider 撞名
                // 会自己改成 `…(1).zjbak`,MIME 还可能给补个 `.bin`(§17.4-1/2)。
                doc = DocumentsContract.createDocument(
                    activity.contentResolver,
                    DocumentsContract.buildDocumentUriUsingTree(
                        tree,
                        DocumentsContract.getTreeDocumentId(tree)
                    ),
                    "application/octet-stream",
                    src.name,
                ) ?: throw java.io.IOException("这个文件夹里建不了文件")
                // 建成了就先记下 docId:重试要拿它覆盖写,⛔ 别等拷完才记(拷到一半被杀就丢了)。
                note(
                    SafPure.Transfer(id, SafPure.KIND_PUT, src.name, doc.toString(), null,
                        SafPure.STATE_RUNNING, null, true)
                )
            }
            SafFault.beforeCopy() // ①②⑥:把「拷贝中途」撑成一个真能踩进去的窗口
            SafFault.failWriteAfterCreate() // ⑫:文档已建、写入失败 ⇒ 保留 retry
            // "wt" = 截断重写:重试往同一个 `docId` 覆盖写的那条路靠它。
            activity.contentResolver.openOutputStream(doc, "wt").use { out ->
                if (out == null) throw java.io.IOException("这个文件写不进去")
                src.inputStream().use { it.copyTo(out) }
            }
            // 尺 3 = **回读**的显示名:给人认脸用的那一格(⛔ 不当落地路径的名)。
            val shown = docLabel(doc) ?: src.name
            SafStore.addLedger(activity, doc.toString(), shown, src.name)
            // ⭐ 拷成功才删 outbox 那份;失败**刻意不删**(它是这次的成果,留给重试)。
            src.delete()
            note(
                SafPure.Transfer(id, SafPure.KIND_PUT, src.name, doc.toString(), shown,
                    SafPure.STATE_DONE, null, false)
            )
            resolve(reqId, JSONObject().put("transferId", id).put("ok", true).put("displayName", shown))
        } catch (e: Exception) {
            note(
                SafPure.Transfer(id, SafPure.KIND_PUT, src.name, doc?.toString(), null,
                    SafPure.STATE_FAILED, e.message ?: e.toString(), true)
            )
            resolve(
                reqId,
                JSONObject().put("transferId", id).put("ok", false)
                    .put("error", e.message ?: e.toString()).put("canRetry", true)
            )
        } finally {
            SafPure.release(SafState.inFlight, id)
        }
    }

    private fun runFetch(reqId: Double, id: String, doc: Uri, localName: String) {
        val dst = File(SafStore.outbox(activity), localName)
        val docId = doc.toString()
        try {
            SafStore.outbox(activity).mkdirs()
            SafFault.beforeCopy() // ③:把「杀在 fetch 中途」撑成一个真能踩进去的窗口
            // ⭐ 打开的是**我们从当前 tree 重建出来的**那个 doc(见 fetchFile 头上那段)。
            activity.contentResolver.openInputStream(doc).use { input ->
                if (input == null) throw java.io.IOException("这份文件读不到(可能已被删或授权没了)")
                dst.outputStream().use { input.copyTo(it) }
            }
            note(
                SafPure.Transfer(id, SafPure.KIND_FETCH, localName, docId, null,
                    SafPure.STATE_DONE, null, true)
            )
            resolve(reqId, JSONObject().put("transferId", id).put("ok", true).put("localName", localName))
        } catch (e: Exception) {
            // 回拷是**可再生**的(锚是用户那份文件,随时可再取)⇒ 半截当场删掉,重验入口留着。
            dst.delete()
            note(
                SafPure.Transfer(id, SafPure.KIND_FETCH, localName, docId, null,
                    SafPure.STATE_FAILED, e.message ?: e.toString(), true)
            )
            resolve(
                reqId,
                JSONObject().put("transferId", id).put("ok", false)
                    .put("error", e.message ?: e.toString()).put("canRetry", true)
            )
        } finally {
            SafPure.release(SafState.inFlight, id)
        }
    }

    private fun listTreeSync(all: Boolean): JSONObject {
        SafFault.beforeList() // ⑮:慢列表(不许饿死 transfer)/ 列目录抛(`listing` 必须释放)
        val out = JSONObject()
        val tree = SafStore.tree(activity) ?: return out.put("error", "还没挑落点")
        if (!treeWritable(tree)) return out.put("error", "落点没了,请重新挑一个文件夹")
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(
            tree,
            DocumentsContract.getTreeDocumentId(tree)
        )
        val known = SafStore.ledgerDocIds(activity)
        // ⛔⛔ **两个上界都要有,而且是两件事**(实现审弹 2 与它的复核轮各打了一次):
        // ①**展示的上界** = `LIST_CAP` 200 条;②**工作量的上界** = `LIST_SCAN_CAP` 2000 行。
        // ⚠ 弹 2 我把「按游标顺序取前 200」改成了「全收进 ArrayList 再排序」——那句
        // 「只显示最近 200 个」是变准了,可**内存与工作量当场变成由目录规模说了算**;
        // 而「这是用户自己的目录」**不构成上界**(整个「下载」/ 网盘根目录 / 几十万项的 provider)。
        // ⇒ 现在:流式 top-K(内存恒为 200)+ 扫描到 2000 行就停,并**如实交出这次看了多少**。
        // ⚠ 「行数据已经在 window 里,所以只是一次批量查询」那句判断**不成立**:
        // `CursorWindow` 容量有限,`moveToNext()` 跨窗口时会继续触发 provider 的工作与 IPC。
        val top = SafPure.TopK(SafPure.LIST_CAP)
        var other = 0
        var scanned = 0
        var scanTruncated = false
        activity.contentResolver.query(
            children,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            ),
            null,
            null,
            // ⚠ 请求「新在前」——**有的 provider 会遵守、有的直接忽略**(比如系统那个
            // ExternalStorageProvider)。⇒ ⛔ **绝不依赖它**:客户端照旧自己 top-K。
            // 它只在「扫描到上限被截断」那种情形里让结果更接近真相。
            DocumentsContract.Document.COLUMN_LAST_MODIFIED + " DESC",
        )?.use { cur ->
            while (cur.moveToNext()) {
                if (scanned >= SafPure.LIST_SCAN_CAP) {
                    scanTruncated = true
                    break
                }
                scanned++
                val docId = cur.getString(0)
                val name = cur.getString(1) ?: ""
                val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId).toString()
                // 默认列 = 「扩展名像 .zjbak 的」∪「产出账里记着 docId 的」(后者哪怕已被改成 .bin)。
                val mine = name.endsWith(SafPure.ARTIFACT_SUFFIX) || known.contains(uri)
                if (all || mine) {
                    top.offer(SafPure.Row(uri, name, cur.getLong(2), cur.getLong(3), known.contains(uri)))
                } else if (other <= SafPure.LIST_CAP) {
                    // 饱和计数:数到 201 就停,UI 显示「200+ 个其他文件」。
                    // ⛔ 别为了一个好看的数字去伪造精确的 N。
                    other++
                }
            }
        } ?: return out.put("error", "这个文件夹读不了(授权可能没了)")
        val items = JSONArray()
        for (r in top.sorted()) {
            items.put(
                JSONObject()
                    .put("docId", r.docId)
                    .put("name", r.name)
                    .put("bytes", r.bytes)
                    .put("ms", r.ms)
                    .put("fromLedger", r.fromLedger)
            )
        }
        val truncated = top.truncated()
        return out
            .put("items", items)
            .put("truncated", truncated)
            .put("otherCount", other)
            .put("otherSaturated", other > SafPure.LIST_CAP)
            // ⛔ 「这次只看了这个文件夹的前 N 个条目」必须交出去 —— 否则截断会被读成
            // 「你只有这些备份」,而那正是 §3.3 那条义务在**发现面**上要防的。
            .put("scanned", scanned)
            .put("scanTruncated", scanTruncated)
    }

    /**
     * ⛔⛔ **把外面递进来的那个字符串,重建成「当前 tree 底下的一份文档」**(实现审一弹 H-1)。
     *
     * 回 `null` = 它不属于当前 tree,**一趟都不许起**。四条,缺一条都算没封:
     * 1. **scheme 必须是 `content:`** —— `ContentResolver.openInputStream` **认 `file://`**,
     *    放过去就等于把「读 app 私有区任意文件」这个能力挂在了桥上
     *    (`file:///data/user/0/<pkg>/.backup.json` = **明文钥**);
     * 2. **authority 必须是当前 tree 那个 provider**(⛔ 别的 provider 也是别人的地盘);
     * 3. **它得是一个 tree 底下的文档 URI**,且它的 tree 段与我们持有授权的那棵**恰好相同**;
     * 4. ⭐ **最后用我们自己 `buildDocumentUriUsingTree` 重建的那个** —— 外面递进来的字符串
     *    只当**参数**,永远不当**权柄**(与「尺 4 落地名壳自己造」同一条纪律)。
     *
     * ⛔ **这里有一句我写过的话是错的,别再写回去**(实现审二弹当场纠正):
     * ~~「重建那一步已经把它钉回本 tree 的命名空间」~~ —— **按字面不成立**。调用方完全可以
     * 构造 `/tree/<当前TreeId>/document/<外部DocId>`,它过得了第 3 条;`buildDocumentUriUsingTree`
     * 只是**用可信的 tree 重新拼一条 URI**,⛔ 它证明不了那个 document id 真是这棵树的后代。
     * ⭐ 真正兜住越界 id 的是 **provider 自己在 open/query 时的 tree/child 强制**
     * (标准 `DocumentsProvider` 会做)—— 那也是它**不构成**上一轮那条外泄链的理由。
     * ⚠ **判定不加 `DocumentsContract.isChildDocument`**,判据两条:①它能让拒绝更早、
     * 更名副其实,但**依赖的仍是同一个 provider 的回答**,对恶意 provider 不是独立证明;
     * ②不支持该能力的 provider 上它可能把**真文档**判否 ⇒ 那是「备份搬不走」的静默失效族,
     * 比晚一点拒更糟。哪天出现「必须在起 worker 之前就拒」的理由,再回来加。
     */
    private fun docInCurrentTree(tree: Uri, raw: String): Uri? {
        val u = try {
            Uri.parse(raw)
        } catch (e: Exception) {
            return null
        }
        if (u.scheme != "content") return null
        if (u.authority == null || u.authority != tree.authority) return null
        if (!DocumentsContract.isDocumentUri(activity, u)) return null
        val docId = try {
            // ⚠ 只有「tree 派生的文档 URI」才有这两段;不是那种形就会抛 —— 抛 = 拒。
            if (DocumentsContract.getTreeDocumentId(u) != DocumentsContract.getTreeDocumentId(tree)) {
                return null
            }
            DocumentsContract.getDocumentId(u)
        } catch (e: Exception) {
            return null
        }
        return try {
            DocumentsContract.buildDocumentUriUsingTree(tree, docId)
        } catch (e: Exception) {
            null
        }
    }

    /** 那三条锚里的第一条:`docId` 现在还解析得开吗(⛔ 只解析,不产生任何副作用)。 */
    private fun docAlive(docId: String?): Boolean {
        if (docId == null) return false
        return try {
            activity.contentResolver.query(Uri.parse(docId), arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID
            ), null, null, null)?.use { it.moveToFirst() } ?: false
        } catch (e: Exception) {
            false
        }
    }

    private fun docLabel(doc: Uri): String? = try {
        activity.contentResolver.query(
            doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null
        )?.use { if (it.moveToFirst()) it.getString(0) else null }
    } catch (e: Exception) {
        null
    }

    /**
     * 落点要显示成**用户认得出的样子**(§17.9-2),⛔ 不显示 content URI 原文(用户读不懂)。
     */
    private fun treeLabel(tree: Uri): String {
        val docId = try {
            DocumentsContract.getTreeDocumentId(tree)
        } catch (e: Exception) {
            return tree.lastPathSegment ?: tree.toString()
        }
        val name = docLabel(DocumentsContract.buildDocumentUriUsingTree(tree, docId))
        if (!name.isNullOrEmpty()) return name
        // 兜底:`primary:Download/朱简` 这类 docId 的后半段就已经够认脸了。
        return docId.substringAfter(':', docId)
    }

    /** 授权还在不在 + 目录还写得进去(§17.4-3:撤销 / 目录被删 / OTG 拔了 / SD 卡卸载)。 */
    private fun treeWritable(tree: Uri): Boolean {
        val granted = activity.contentResolver.persistedUriPermissions.any {
            it.uri == tree && it.isReadPermission && it.isWritePermission
        }
        if (!granted) return false
        return try {
            androidx.documentfile.provider.DocumentFile.fromTreeUri(activity, tree)?.canWrite() == true
        } catch (e: Exception) {
            false
        }
    }

    private fun err(message: String): String = JSONObject().put("error", message).toString()

    /**
     * 应答:UI 线程上 `evaluateJavascript`。⛔ **应答只是快路,不是真相源** ——
     * JS 那侧的 `transferId` 对不上就按「不知道」处置(停止轮询、重新问整体状态、
     * **绝不兑现那个 promise**)。
     */
    private fun resolve(reqId: Double, payload: JSONObject) {
        val js = "window.__zhujianSafResolve && window.__zhujianSafResolve(" +
            "${reqId.toLong()}, ${JSONObject.quote(payload.toString())})"
        // 故障注入(⑬):应答迟到。⛔ 用 Handler 推迟**投递**,不是在这条线程上睡 ——
        // 睡在这儿会把 `finally` 里的 release 一起推迟,那样 `busy` 就不会先落下来,
        // 而「`running` + `busy=false`」正是这一格要造的那个状态。
        val delay = SafFault.replyDelayMs()
        if (delay > 0) {
            android.os.Handler(android.os.Looper.getMainLooper())
                .postDelayed({ activity.evalInWebView(js) }, delay)
            return
        }
        activity.runOnUiThread { activity.evalInWebView(js) }
    }
}

/**
 * 挑落点那条路的应答端(它由 Activity 的 launcher 回来,**不在桥实例上**)。
 *
 * ⛔ **进程可能在选择器开着的时候被杀**(§17.4-4):Activity 重建 / WebView 重载之后,
 * JS 那侧挂着的 promise 早就没了 —— 这里的 `evaluateJavascript` 因此可能什么都没接住,
 * **那是正常的**。授权与 tree URI 已经落进 SharedPreferences,面下次打开重新问一次就对了。
 */
object SafBridgeResolve {
    fun picked(activity: MainActivity, uri: Uri?) {
        if (uri == null) {
            // 用户取消:什么都不改,回到「还没落点」。⛔ 不当错误弹(§17.10 第 1 行)。
            reply(activity, JSONObject().put("ok", false).put("cancelled", true))
            return
        }
        try {
            activity.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (e: Exception) {
            // ⛔ 响亮:这个位置留不住授权(某些第三方 provider),请换一个 —— ⛔ 绝不静默
            // 回退到私有目录(那等于把备份写进一个卸载就没的地方还告诉用户「备份好了」)。
            fail(activity, "这个位置留不住授权,请换一个文件夹:${e.message}")
            return
        }
        SafStore.setTree(activity, uri)
        reply(activity, JSONObject().put("ok", true))
    }

    fun fail(activity: MainActivity, message: String) {
        reply(activity, JSONObject().put("ok", false).put("error", message))
    }

    private fun reply(activity: MainActivity, payload: JSONObject) {
        val id = SafState.pickReqId.toLong()
        SafState.pickReqId = -1.0
        activity.evalInWebView(
            "window.__zhujianSafResolve && window.__zhujianSafResolve($id, " +
                "${JSONObject.quote(payload.toString())})"
        )
    }
}

/** 挑目录那条 Intent(单独一个函数只为让 [MainActivity] 那半薄一点)。 */
fun openDocumentTreeIntent(): Intent =
    Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        )
    }
