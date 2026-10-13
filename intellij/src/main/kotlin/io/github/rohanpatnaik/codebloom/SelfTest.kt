package io.github.rohanpatnaik.codebloom

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.wm.ToolWindowManager
import java.io.File

/**
 * Development only, inert unless `-Dcodebloom.selfTest=<file>` is set (see
 * `runIde` in build.gradle.kts): opens the file, shows the map, selects a
 * method, and reports what the page shows through the real JCEF bridge.
 */
internal object SelfTest {
    val file: String? get() = System.getProperty("codebloom.selfTest")
    private val log = logger<SelfTest>()

    /** Runs in the page once the first model is drawn. Reports back as 'selftest' messages. */
    val probe = """
        (function(){
          var C=window.__codebloom,S=C.S,send=function(o){acquireVsCodeApi().postMessage(o);};
          var all=[];(function w(bs){bs.forEach(function(b){all.push(b);w(b.children);});})(S.model.blocks);
          var t=all.find(function(b){return (b.kind==='method'||b.kind==='function')&&(b.name==='run'||b.name==='review_node');})||all.find(function(b){return b.kind==='method'||b.kind==='function';});
          send({type:'selftest',step:'model',file:document.querySelector('.crumbs .file').textContent,lang:document.querySelector('.crumbs .lang').textContent,
            stats:document.querySelector('.stats').textContent,blocks:all.map(function(b){return b.kind+':'+b.qual;}).join(' '),nodes:document.querySelectorAll('.node').length,target:t&&t.qual});
          if(t)C.select(t.id,{history:true});
          setTimeout(function(){send({type:'selftest',step:'details',details:document.querySelector('.details').innerText.slice(0,900),dom:document.documentElement.outerHTML});},4000);
        })()
    """.trimIndent()

    fun report(message: Map<*, *>) {
        val out = File(System.getProperty("codebloom.selfTestOut") ?: return)
        out.mkdirs()
        val dom = message["dom"] as? String
        if (dom != null) File(out, "page.html").writeText(dom)
        File(out, "report.txt").appendText(message.filterKeys { it != "dom" }.toString() + "\n")
        log.warn("CODEBLOOM-SELFTEST ${message.filterKeys { it != "dom" }}")
        if (message["step"] == "details") ApplicationManager.getApplication().invokeLater { ApplicationManager.getApplication().exit(true, true, false) }
    }
}

class SelfTestActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        val rel = SelfTest.file ?: return
        DumbService.getInstance(project).runWhenSmart {
            ApplicationManager.getApplication().invokeLater {
                val vf = project.guessProjectDir()?.findFileByRelativePath(rel) ?: return@invokeLater
                FileEditorManager.getInstance(project).openFile(vf, true)
                ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.activate(null)
            }
        }
    }
}
