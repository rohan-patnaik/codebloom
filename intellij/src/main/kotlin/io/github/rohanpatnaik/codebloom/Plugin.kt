package io.github.rohanpatnaik.codebloom

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.util.concurrency.AppExecutorUtil
import java.awt.datatransfer.StringSelection
import javax.swing.SwingConstants

/** Holds the project's map panel so actions can reach it. */
@Service(Service.Level.PROJECT)
class CodebloomService {
    /** The map in the Codebloom tool window. */
    var panel: MapPanel? = null
    /** The project's map tab, once opened. */
    var mapFile: CodebloomMapFile? = null
}

class CodebloomToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        if (!JBCefApp.isSupported()) {
            val label = JBLabel("Codebloom needs the IDE's built-in browser (JCEF), which isn't available in this runtime.", SwingConstants.CENTER)
            toolWindow.contentManager.addContent(factory.createContent(label, "", false))
            return
        }
        val panel = MapPanel(project, ToolWindowHost(project, toolWindow))
        val content = factory.createContent(panel.component, "", false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
        project.getService(CodebloomService::class.java).panel = panel
    }
}

const val TOOL_WINDOW_ID = "Codebloom"

/** Show the map for the file in the editor (or the one picked in the Project view). */
class OpenMapAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.VIRTUAL_FILE)?.isDirectory != true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val window = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID) ?: return
        window.activate {
            val panel = project.getService(CodebloomService::class.java).panel
            if (vf != null) panel?.open(vf)
        }
    }
}

/** Copy the block at the caret with what it calls and what calls it, for an AI chat. */
class CopyContextAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null && e.getData(CommonDataKeys.PSI_FILE) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val psi = e.getData(CommonDataKeys.PSI_FILE) ?: return
        val offset = editor.caretModel.offset
        val text = editor.document.text
        ReadAction.nonBlocking<String?> {
            val map = MapBuilder.build(project, psi) ?: return@nonBlocking null
            val block = map.ownerAt(offset)
            val callers = block?.let { Callers.find(project, map, it.id) }
            Context.text(map, block, text, callers)
        }
            .inSmartMode(project)
            .finishOnUiThread(ModalityState.defaultModalityState()) { copied ->
                if (copied == null) return@finishOnUiThread
                CopyPasteManager.getInstance().setContents(StringSelection(copied))
                StatusBar.Info.set("Codebloom: copied block as context", project)
            }
            .submit(AppExecutorUtil.getAppExecutorService())
    }
}
