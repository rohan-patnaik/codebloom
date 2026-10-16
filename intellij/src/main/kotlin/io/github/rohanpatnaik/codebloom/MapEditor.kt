package io.github.rohanpatnaik.codebloom

import com.intellij.ide.FileIconProvider
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.ex.FileEditorManagerEx
import com.intellij.openapi.fileEditor.impl.EditorTabTitleProvider
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.SwingConstants

private val ICON by lazy { IconLoader.getIcon("/icons/codebloom.svg", CodebloomMapFile::class.java) }

/** The file type of the map tab, so it gets Codebloom's name and icon instead of plain text's. */
object CodebloomMapFileType : FileType {
    override fun getName() = "Codebloom Map"
    override fun getDescription() = "Codebloom mind map"
    override fun getDefaultExtension() = ""
    override fun getIcon() = ICON
    override fun isBinary() = true
    override fun isReadOnly() = true
}

/**
 * Stands in for the map in the editor area, so it opens as a tab that can be
 * split, dragged to another window or given the whole editor like any file.
 * One per project; it isn't saved with the project.
 */
class CodebloomMapFile(val project: Project) : LightVirtualFile("Codebloom", CodebloomMapFileType, "") {
    init {
        isWritable = false
    }

    /** The map shown in this tab, once its editor exists. */
    var panel: MapPanel? = null
}

class MapEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile) = file is CodebloomMapFile && file.project == project
    override fun acceptRequiresReadAction() = false
    override fun createEditor(project: Project, file: VirtualFile): FileEditor = MapFileEditor(project, file as CodebloomMapFile)
    override fun getEditorTypeId() = "codebloom-map"
    override fun getPolicy() = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

class MapFileEditor(private val project: Project, private val file: CodebloomMapFile) : UserDataHolderBase(), FileEditor {
    private val panel: MapPanel? = if (JBCefApp.isSupported()) MapPanel(project, EditorHost(project, file)) else null
    private val fallback by lazy { JBLabel("Codebloom needs the IDE's built-in browser (JCEF), which isn't available in this runtime.", SwingConstants.CENTER) }

    init {
        if (panel != null) {
            Disposer.register(this, panel)
            file.panel = panel
        }
    }

    override fun getComponent(): JComponent = panel?.component ?: fallback
    override fun getPreferredFocusedComponent(): JComponent? = panel?.component
    override fun getName() = "Codebloom"
    override fun getFile(): VirtualFile = file
    override fun setState(state: FileEditorState) {}
    override fun isModified() = false
    override fun isValid() = true
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}
    override fun dispose() {
        if (file.panel === panel) file.panel = null
    }
}

private class EditorHost(private val project: Project, private val file: CodebloomMapFile) : MapHost {
    override val isVisible get() = !project.isDisposed && file in FileEditorManager.getInstance(project).selectedFiles
    override val inEditor get() = true
    override fun fileChanged() = FileEditorManagerEx.getInstanceEx(project).updateFilePresentation(file)

    /** Tool windows hidden by the last maximize, shown again by the next one. */
    private var hidden: List<String> = emptyList()

    /** Hide every tool window (and back), so the map gets the whole IDE window. */
    override fun toggleMaximize() {
        val windows = ToolWindowManager.getInstance(project)
        if (hidden.isNotEmpty()) {
            hidden.forEach { windows.getToolWindow(it)?.show() }
            hidden = emptyList()
        } else {
            hidden = windows.toolWindowIds.filter { windows.getToolWindow(it)?.isVisible == true }
            hidden.forEach { windows.getToolWindow(it)?.hide() }
        }
    }
}

class MapTabTitleProvider : EditorTabTitleProvider, DumbAware {
    override fun getEditorTabTitle(project: Project, file: VirtualFile): String? {
        if (file !is CodebloomMapFile) return null
        val shown = file.panel?.fileName
        return if (shown != null) "Map · $shown" else "Codebloom"
    }
}

class MapFileIconProvider : FileIconProvider {
    override fun getIcon(file: VirtualFile, flags: Int, project: Project?) = if (file is CodebloomMapFile) ICON else null
}

/** Opens the project's map tab (or brings it back), showing [target] if given. */
object MapTabs {
    fun open(project: Project, target: VirtualFile?) {
        val service = project.getService(CodebloomService::class.java)
        val file = service.mapFile ?: CodebloomMapFile(project).also { service.mapFile = it }
        FileEditorManager.getInstance(project).openFile(file, true)
        if (target != null && target !is CodebloomMapFile) file.panel?.open(target)
    }
}

/** Show the map for the file in an editor tab, like any other file, with the whole editor area. */
class OpenMapInTabAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.VIRTUAL_FILE)?.isDirectory != true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        MapTabs.open(project, e.getData(CommonDataKeys.VIRTUAL_FILE))
    }
}
