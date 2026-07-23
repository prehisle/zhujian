package app.zhujian.notebook

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import java.io.File

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  // 146:返回键层账本的 Kotlin 半截。真机取证(vivo/Android 16,keyevent 4 + CDP 探针):
  // TauriActivity 默认 handleBackNavigation=false 使 wry 那层从未注册;而且就算注册了
  // 也没用——**WebView.canGoBack() 对 pushState 同文档守门条目返回 false**(CDP
  // Page.getNavigationHistory 明明有 2 条),wry 的「有历史先 goBack」在此天生失效。
  // 故判定交给 JS 账本(main.ts 的 histDepth,单一真相源):有层 → 页内 history.back()
  // (走已验证的 popstate 关层路);无层/页面没应答 → 系统默认路退 app。
  // WebView 引用兜底从视图树现找(setWebView/onWebViewCreate 在本机取证中从未被调,
  // 决不允许因此吞掉返回键)。配套 manifest enableOnBackInvokedCallback=false
  // (targetSdk 35+ 新系统默认 predictive back,legacy 按键派发不保证进 dispatcher)。
  private fun findWebView(v: android.view.View): WebView? {
    if (v is WebView) return v
    if (v is android.view.ViewGroup) {
      for (i in 0 until v.childCount) {
        findWebView(v.getChildAt(i))?.let { return it }
      }
    }
    return null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    stashSharedText(intent) // 冷启动:分享拉起进程,先落文件再起 WebView。
    stashDeepLink(intent) // 冷启动:深链接拉起进程,同样先落文件(前端 take_deep_link 取走)。
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
      // single-flight(codex 补审 M3):JS 应答/超时未归前,重复返回丢弃(JS 侧对
      // back 在飞另有合并,这里挡的是「应答窗口内的连按」);应答与超时用 CAS 决出
      // 唯一赢家——renderer 卡死/回调永不到时,超时走默认返回,绝不把用户困在 app 里。
      private var inFlight = false

      override fun handleOnBackPressed() {
        val wv = webView ?: findWebView(window.decorView.rootView)?.also { webView = it }
        if (wv == null) {
          fallthrough()
          return
        }
        if (inFlight) return
        inFlight = true
        val done = java.util.concurrent.atomic.AtomicBoolean(false)
        // 问页内原子入口:true=页面已消费(关层/收扫码/合并);false/null/异常=无层,
        // 放行退出(fail-open 到「能退出 app」侧)。
        wv.evaluateJavascript(
          "window.__zhujianHandleBack?window.__zhujianHandleBack():false"
        ) { consumed ->
          if (done.compareAndSet(false, true)) {
            inFlight = false
            if (consumed != "true") fallthrough()
          }
        }
        wv.postDelayed({
          if (done.compareAndSet(false, true)) {
            inFlight = false
            fallthrough() // JS 无应答:超时放行默认返回
          }
        }, 500)
      }

      private fun fallthrough() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    })
  }

  override fun onNewIntent(intent: Intent) {
    stashSharedText(intent) // 热启动(singleTask):先落文件,再让 tauri 插件链看 intent。
    stashDeepLink(intent) // 热启动:深链接同样先落文件。
    super.onNewIntent(intent)
    // 活动可能全程前台收到分享/深链接(不触发 visibilitychange):补一记事件戳。
    // WebView 没就绪/事件丢了都无妨——文件才是真相源,回前台或下次启动照样取走。
    webView?.evaluateJavascript("window.dispatchEvent(new Event('zhujian-share'))", null)
    webView?.evaluateJavascript("window.dispatchEvent(new Event('zhujian-deeplink'))", null)
  }

  // M4 薄桥(android-plan §7):ACTION_SEND 的 EXTRA_TEXT 原生侧暂存成文件,前端经
  // take_shared_text 一次性取走——事件桥会在「WebView 尚未监听」时把分享静默丢掉,
  // 文件不会。只暂存、不入库;上限 200 KiB(预填是给人看的,不是数据面)。
  // 目录用 dataDir:tauri 的 app_data_dir 在安卓解析为 getDataDir(PathPlugin,
  // 已核 tauri 2.11.5),两侧必须同一目录,别改成 filesDir。
  private fun stashSharedText(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    // manifest 只收 text/plain;带参数形态(text/plain;charset=…)也认。这里是
    // 契约校验不是安全边界(显式 Intent 本就能伪造 MIME),null 从宽。
    val mime = intent.type
    if (mime != null && !mime.startsWith("text/plain")) return
    // 标准类型是 CharSequence(SpannedString 等富文本也合法),取字符串形态。
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() }
      ?: return
    val tmp = File(dataDir, "shared_text.pending.tmp")
    tmp.writeBytes(utf8Truncate(text, 200 * 1024))
    // tmp + rename 原子落位:取走端读不到半截文件;rename 失败别留垃圾。
    if (!tmp.renameTo(File(dataDir, "shared_text.pending"))) tmp.delete()
  }

  // 4c 深链接薄桥:ACTION_VIEW 的 zhujian:// URI 原生侧暂存成文件,前端 take_deep_link
  // 一次性取走(与分享同理:事件桥会在 WebView 未监听时把它丢掉,文件不会)。只暂存不
  // 入库;URI 短,给个宽松上限。目录同 dataDir(与 take_deep_link 的 app_data_dir 同址)。
  private fun stashDeepLink(intent: Intent?) {
    if (intent?.action != Intent.ACTION_VIEW) return
    val uri = intent.data ?: return
    if (uri.scheme != "zhujian") return // 契约校验(intent-filter 已按 scheme 过滤,双保险)
    val tmp = File(dataDir, "deep_link.pending.tmp")
    tmp.writeBytes(utf8Truncate(uri.toString(), 8 * 1024))
    if (!tmp.renameTo(File(dataDir, "deep_link.pending"))) tmp.delete()
  }

  // 截断只许落在 UTF-8 码点边界:回退跳过续字节(10xxxxxx),再把切剩的首字节去掉,
  // 否则 Rust 侧 read_to_string 会把整份暂存判成非法 UTF-8。
  private fun utf8Truncate(text: String, cap: Int): ByteArray {
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size <= cap) return bytes
    var end = cap
    while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
    return bytes.copyOf(end)
  }
}
