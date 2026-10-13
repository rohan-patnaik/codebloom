package io.github.rohanpatnaik.codebloom

import com.intellij.ide.ui.LafManagerListener
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationNamesInfo
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.ex.ToolWindowManagerListener
import com.intellij.psi.PsiManager
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.UIUtil
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefContextMenuParams
import org.cef.callback.CefMenuModel
import org.cef.handler.CefContextMenuHandlerAdapter
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.Color
import java.awt.datatransfer.StringSelection
import javax.swing.JComponent

/**
 * The Codebloom tool window: the same mind-map webview the VS Code extension
 * uses, running in JCEF. It follows the selected editor and mirrors its caret.
 */
class MapPanel(private val project: Project, private val toolWindow: ToolWindow) : Disposable {
    private val browser = JBCefBrowser()
    private val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val rebuildAlarm = Alarm(this)
    private var file: VirtualFile? = null
    private var map: FileMap? = null
    private var ready = false
    private var sentText: String? = null
    private var ignoreCaretUntil = 0L
    /** Callers found on demand, by block id, for the current version of the file. */
    private val callers = HashMap<String, Map<String, Any?>>()

    val component: JComponent get() = browser.component

    init {
        Disposer.register(this, query)
        Disposer.register(this, browser)
        query.addHandler { text ->
            ApplicationManager.getApplication().invokeLater({ onMessage(text) }, ModalityState.any(), project.disposed)
            null
        }
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (!frame.isMain) return
                // The bridge exists only after load; messages sent before it are queued in the page.
                cefBrowser.executeJavaScript("window.__cbSend=function(s){${query.inject("s")}};window.__cbFlush&&window.__cbFlush();", cefBrowser.url, 0)
            }
        }, browser.cefBrowser)
        browser.jbCefClient.addContextMenuHandler(object : CefContextMenuHandlerAdapter() {
            override fun onBeforeContextMenu(b: CefBrowser, f: CefFrame, params: CefContextMenuParams, model: CefMenuModel) {
                model.clear()
            }
        }, browser.cefBrowser)
        browser.loadHTML(html())

        val bus = project.messageBus.connect(this)
        bus.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun selectionChanged(event: FileEditorManagerEvent) {
                val f = event.newFile ?: return
                if (f == file) post(mapOf("type" to "notice", "notice" to null)) else open(f)
            }
        })
        bus.subscribe(DumbService.DUMB_MODE, object : DumbService.DumbModeListener {
            override fun exitDumbMode() = scheduleRebuild(0)
        })
        bus.subscribe(ToolWindowManagerListener.TOPIC, object : ToolWindowManagerListener {
            override fun stateChanged(manager: ToolWindowManager) {
                if (stale && toolWindow.isVisible) {
                    stale = false
                    scheduleRebuild(0)
                }
            }
        })
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(LafManagerListener.TOPIC, LafManagerListener { applyTheme() })
        val multicaster = EditorFactory.getInstance().eventMulticaster
        multicaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (file != null && FileDocumentManager.getInstance().getFile(event.document) == file) scheduleRebuild(300)
            }
        }, this)
        multicaster.addCaretListener(object : CaretListener {
            override fun caretPositionChanged(event: CaretEvent) {
                if (System.currentTimeMillis() < ignoreCaretUntil) return
                if (FileDocumentManager.getInstance().getFile(event.editor.document) != file) return
                post(mapOf("type" to "cursor", "line" to event.newPosition.line + 1))
            }
        }, this)
    }

    /** Show a file on the map, or explain why it can't be. */
    fun open(vf: VirtualFile) {
        val psi = PsiManager.getInstance(project).findFile(vf)
        if (psi == null || !MapBuilder.canMap(psi)) {
            if (file != null) {
                val lang = psi?.language?.displayName ?: vf.fileType.name
                post(mapOf("type" to "notice", "notice" to mapOf("kind" to "unsupported", "file" to vf.name, "languageId" to (psi?.language?.id ?: ""), "language" to lang)))
            }
            return
        }
        if (vf != file) {
            file = vf
            map = null
            sentText = null
            callers.clear()
        }
        rebuild()
    }

    /** Set when the file changed while the tool window was hidden. */
    private var stale = false

    private fun scheduleRebuild(delay: Int) {
        // A hidden map costs nothing; catch up when it's shown again.
        if (!toolWindow.isVisible) {
            stale = true
            return
        }
        rebuildAlarm.cancelAllRequests()
        rebuildAlarm.addRequest({ rebuild() }, delay)
    }

    private fun rebuild() {
        val vf = file ?: return
        if (DumbService.isDumb(project) && map == null) postWaiting(vf)
        ReadAction.nonBlocking<FileMap?> { PsiManager.getInstance(project).findFile(vf)?.let { MapBuilder.build(project, it) } }
            .inSmartMode(project)
            .withDocumentsCommitted(project)
            .expireWith(this)
            .coalesceBy(this)
            .finishOnUiThread(ModalityState.any()) { m ->
                if (m == null || vf != file) return@finishOnUiThread
                if (map != null) callers.clear()
                map = m
                postModel(m)
            }
            .submit(AppExecutorUtil.getAppExecutorService())
    }

    private fun languageOf(m: FileMap) = mapOf(
        "id" to m.lang,
        "name" to m.file.language.displayName,
        "builtIn" to true,
        "provider" to ApplicationNamesInfo.getInstance().fullProductName,
    )

    private fun config() = mapOf(
        "mode" to PropertiesComponent.getInstance().getValue("codebloom.mode", "names"),
        "maxCardLines" to 24,
        "indexWorkspace" to true,
    )

    private fun postModel(m: FileMap) {
        if (!ready) return
        val vf = file ?: return
        val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return
        val text = doc.text
        val sendText = text != sentText
        if (sendText) sentText = text
        val editor = FileEditorManager.getInstance(project).selectedTextEditor?.takeIf { it.document == doc }
        val links = m.links.values.sumOf { it.out.size }
        post(mapOf(
            "type" to "model",
            "model" to m.toJson(mapOf("files" to 1, "lines" to m.lineCount, "links" to links, "indexing" to false)),
            "uri" to vf.url,
            "text" to if (sendText) text else null,
            "cursor" to editor?.caretModel?.logicalPosition?.line?.plus(1),
            "language" to languageOf(m),
            "outline" to "ok",
            "config" to config(),
        ))
        if (SelfTest.file != null && !probed) {
            probed = true
            rebuildAlarm.addRequest({ browser.cefBrowser.executeJavaScript(SelfTest.probe, browser.cefBrowser.url, 0) }, 2500)
        }
    }

    private var probed = false

    /** While IntelliJ indexes, show the file as one block with a note. */
    private fun postWaiting(vf: VirtualFile) {
        if (!ready) return
        val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return
        val rel = MapBuilder.relOf(project, vf)
        val block = mapOf("id" to "$rel::#file", "kind" to "script", "name" to vf.name, "qual" to "#file", "start" to 1, "end" to doc.lineCount.coerceAtLeast(1), "defLine" to 1, "detail" to "whole file", "children" to emptyList<Any>())
        sentText = doc.text
        post(mapOf(
            "type" to "model",
            "model" to mapOf("rel" to rel, "lang" to vf.extension.orEmpty(), "engine" to "symbols", "lineCount" to doc.lineCount, "blocks" to listOf(block), "links" to emptyMap<String, Any>(), "stats" to mapOf("files" to 0, "lines" to 0, "links" to 0, "indexing" to true)),
            "uri" to vf.url,
            "text" to doc.text,
            "language" to mapOf("id" to vf.extension.orEmpty(), "name" to vf.fileType.name, "builtIn" to true, "provider" to ApplicationNamesInfo.getInstance().fullProductName),
            "outline" to "waiting",
            "config" to config(),
        ))
    }

    private fun post(message: Map<String, Any?>) {
        if (!ready && message["type"] != "theme") return
        browser.cefBrowser.executeJavaScript("window.postMessage(${Json.encode(message)},'*')", browser.cefBrowser.url, 0)
    }

    private fun onMessage(text: String) {
        val m = runCatching { Json.decode(text) as? Map<*, *> }.getOrNull() ?: return
        when (m["type"]) {
            "ready" -> {
                ready = true
                sentText = null
                applyTheme()
                val m0 = map
                if (m0 != null) postModel(m0) else FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.let(::open)
            }
            "reveal" -> reveal(m)
            "copyContext" -> copyContext(m["id"] as? String)
            "mode" -> (m["mode"] as? String)?.let { PropertiesComponent.getInstance().setValue("codebloom.mode", it) }
            "calls" -> (m["id"] as? String)?.let(::findCallers)
            "selftest" -> SelfTest.report(m)
            "maximize" -> ToolWindowManager.getInstance(project).let { it.setMaximized(toolWindow, !it.isMaximized(toolWindow)) }
        }
    }

    private fun reveal(m: Map<*, *>) {
        val uri = m["uri"] as? String
        val rel = m["rel"] as? String
        val target = uri?.let { VirtualFileManager.getInstance().findFileByUrl(it) }
            ?: if (rel == map?.rel) file else rel?.let { project.guessProjectDir()?.findFileByRelativePath(it) }
        target ?: return
        val line = ((m["line"] as? Number)?.toInt() ?: 1) - 1
        val focus = m["focus"] == true
        ignoreCaretUntil = System.currentTimeMillis() + 500
        val descriptor = OpenFileDescriptor(project, target, line.coerceAtLeast(0), 0)
        if (focus) descriptor.navigate(true)
        else FileEditorManager.getInstance(project).openTextEditor(descriptor, false)?.scrollingModel?.scrollToCaret(ScrollType.CENTER_UP)
        if (target != file) open(target)
    }

    private fun findCallers(id: String) {
        val m = map ?: return
        callers[id]?.let { post(it); return }
        val vf = file
        ReadAction.nonBlocking<Map<String, Any?>> { Callers.find(project, m, id) }
            .inSmartMode(project)
            .expireWith(this)
            .finishOnUiThread(ModalityState.any()) { result ->
                if (vf != file || map !== m) return@finishOnUiThread
                callers[id] = result
                post(result)
            }
            .submit(AppExecutorUtil.getAppExecutorService())
    }

    private fun copyContext(id: String?) {
        val m = map ?: return
        val vf = file ?: return
        val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return
        val text = Context.text(m, id?.let(m::block), doc.text, id?.let { callers[it] })
        CopyPasteManager.getInstance().setContents(StringSelection(text))
        StatusBar.Info.set("Codebloom: copied block as context", project)
    }

    // ------------------------------------------------------------- page

    private fun hex(c: Color) = "#%02x%02x%02x".format(c.red, c.green, c.blue)

    private fun themeVars(): Pair<Boolean, Map<String, String>> {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val dark = !JBColor.isBright()
        return dark to mapOf(
            "--vscode-editor-background" to hex(scheme.defaultBackground),
            "--vscode-editor-foreground" to hex(scheme.defaultForeground),
            "--vscode-font-family" to "'${UIUtil.getLabelFont().family}', system-ui, sans-serif",
            "--vscode-editor-font-family" to "'${scheme.editorFontName}', ui-monospace, monospace",
            "--vscode-button-background" to if (dark) "#b8a9f0" else "#6a55c4",
            "--vscode-button-foreground" to if (dark) "#1e1e24" else "#ffffff",
            "--vscode-focusBorder" to if (dark) "#b8a9f0" else "#6a55c4",
            "--vscode-input-background" to hex(UIUtil.getTextFieldBackground()),
        )
    }

    /** Follow the IDE theme; the page re-lays out when its body class changes. */
    private fun applyTheme() {
        val (dark, vars) = themeVars()
        val js = buildString {
            append("(function(){var s=document.documentElement.style;")
            for ((k, v) in vars) append("s.setProperty(${Json.encode(k)},${Json.encode(v)});")
            append("document.body.className=${Json.encode(if (dark) "vscode-dark" else "vscode-light")};})()")
        }
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    private fun resource(name: String) = MapPanel::class.java.getResource("/webview/$name")?.readText()
        ?: error("Codebloom webview asset $name is missing from the plugin")

    private fun html(): String {
        val (dark, vars) = themeVars()
        val style = vars.entries.joinToString(";") { "${it.key}:${it.value}" }
        // The webview talks to `acquireVsCodeApi()`; this stands in for it.
        val shim = """
            window.__cbQueue=[];
            window.__cbFlush=function(){var q=window.__cbQueue;window.__cbQueue=[];q.forEach(function(s){window.__cbSend(s);});};
            function acquireVsCodeApi(){return{
              postMessage:function(m){var s=JSON.stringify(m);if(window.__cbSend)window.__cbSend(s);else window.__cbQueue.push(s);},
              getState:function(){try{return JSON.parse(localStorage.getItem('codebloom')||'null');}catch(e){return null;}},
              setState:function(v){try{localStorage.setItem('codebloom',JSON.stringify(v));}catch(e){}}
            };}
        """.trimIndent()
        val js = resource("webview.js").replace("</script", "<\\/script")
        val css = resource("webview.css").replace("</style", "<\\/style")
        return """<!DOCTYPE html>
<html lang="en" style="$style"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>$css</style><script>$shim</script><title>Codebloom</title></head>
<body class="${if (dark) "vscode-dark" else "vscode-light"}"><div id="app"></div><script>$js</script></body></html>"""
    }

    override fun dispose() {
        project.getService(CodebloomService::class.java)?.let { if (it.panel === this) it.panel = null }
    }
}
