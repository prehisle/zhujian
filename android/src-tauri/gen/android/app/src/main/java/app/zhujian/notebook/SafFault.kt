package app.zhujian.notebook

import android.content.Intent

/**
 * SAF 那条桥的**故障注入**(backup-plan §17.20 十一)。
 *
 * ⭐ 为什么要它:那份真机清单里 ⑬(终态 commit 失败 + 回调迟到)与 ⑮(慢列表 / query 异常)
 * 自己就写着「需要**故障注入**(debug 形),没有可控注入时**不许声称已覆盖**」;而 ①②③⑥⑫
 * 要的「杀在拷贝中途」「拷到一半落点没了」「文档已建、写入失败」在真机上都是**几百毫秒级的
 * 窗口**,靠掐表碰运气得到的绿是假绿(memory `race-window-must-prove-it-was-hit`)。
 *
 * ⛔ **三条纪律,别放松**:
 * 1. **编译期门控**:每个 hook 第一行就是 `if (!BuildConfig.ZJ_FAULT) return`,而
 *    `ZJ_FAULT` 由 `app/zjfault.enabled` 这个**文件在不在**决定(见 build.gradle.kts)。
 *    发版构建里它恒 false + release 开着 R8 ⇒ 这些分支是**死码**,不是「运行时默认关」。
 * 2. ⛔ **不新增任何 `@JavascriptInterface`**:旋钮只从**启动 Intent 的 extras** 读一次
 *    (`adb shell am start … --ei zjfault_copyms 4000`)。桥面的能力面一个字都不许因为
 *    测试而变宽 —— 那正是 §17.5 那条 H-1 反复在守的东西。
 * 3. ⛔ **只延时与只抛异常,不改判定**:注入进去的是「慢」和「失败」这两件真实世界会发生的
 *    事,⛔ 绝不是「跳过某道闸」。
 */
object SafFault {

    @Volatile private var copyMs: Long = 0
    @Volatile private var failWrite: Boolean = false
    @Volatile private var failCommitOnce: Boolean = false
    @Volatile private var replyMs: Long = 0
    @Volatile private var listMs: Long = 0
    @Volatile private var listThrow: Boolean = false

    /** 启动那一刻读一次。⛔ 进程级、一次性 —— 与「旋钮跟着这一趟启动走」那个形一致。 */
    fun configure(intent: Intent?) {
        if (!BuildConfig.ZJ_FAULT) return
        val i = intent ?: return
        copyMs = i.getIntExtra("zjfault_copyms", 0).toLong()
        failWrite = i.getIntExtra("zjfault_failwrite", 0) == 1
        failCommitOnce = i.getIntExtra("zjfault_failcommit", 0) == 1
        replyMs = i.getIntExtra("zjfault_replyms", 0).toLong()
        listMs = i.getIntExtra("zjfault_listms", 0).toLong()
        listThrow = i.getIntExtra("zjfault_listthrow", 0) == 1
        android.util.Log.w(
            "zhujian",
            "BACKUP_FAULT 注入已配置 copyMs=$copyMs failWrite=$failWrite " +
                "failCommitOnce=$failCommitOnce replyMs=$replyMs listMs=$listMs listThrow=$listThrow",
        )
    }

    /** 真拷贝之前的窗口(①②③⑥:杀在中途 / 拷到一半落点没了 / 旧 worker 还在跑)。 */
    fun beforeCopy() {
        if (!BuildConfig.ZJ_FAULT) return
        if (copyMs > 0) Thread.sleep(copyMs)
    }

    /**
     * ⑫:`createDocument` 已经成功、写入这一步失败 —— 那正是「保留 retry」的那个状态。
     *
     * ⛔ **一次性**:⑫ 要验的是「**同一个进程里**换到 tree B 再重试」,旋钮若一直生效,
     * 重试那一趟也会被打掉,验的就成了「失败两次」而不是「换文件夹之后重试成功」。
     */
    fun failWriteAfterCreate() {
        if (!BuildConfig.ZJ_FAULT) return
        if (!failWrite) return
        failWrite = false
        throw java.io.IOException("(注入)写入失败")
    }

    /**
     * ⑬:**终态**那次 `commit()` 失败一次。⛔ 只吃终态 —— 起头那次失败是「这一趟不起」,
     * 与本格要验的「活儿干完了、记录没落上」不是一件事。
     */
    fun swallowTerminalCommit(state: String): Boolean {
        if (!BuildConfig.ZJ_FAULT) return false
        if (!failCommitOnce || state == SafPure.STATE_RUNNING) return false
        failCommitOnce = false
        return true
    }

    /** ⑬:回调迟到(> JS 那侧 5 秒宽限)。 */
    fun replyDelayMs(): Long {
        if (!BuildConfig.ZJ_FAULT) return 0
        return replyMs
    }

    /** ⑮:慢列表(证「列目录不许把 transfer 饿死」)与列目录抛异常(证 `listing` 会释放)。 */
    fun beforeList() {
        if (!BuildConfig.ZJ_FAULT) return
        if (listMs > 0) Thread.sleep(listMs)
        if (listThrow) throw IllegalStateException("(注入)列目录失败")
    }
}
