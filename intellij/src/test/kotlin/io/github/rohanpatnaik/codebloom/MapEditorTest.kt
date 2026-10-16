package io.github.rohanpatnaik.codebloom

import com.intellij.testFramework.fixtures.BasePlatformTestCase

class MapEditorTest : BasePlatformTestCase() {
    fun testProviderOnlyOpensThisProjectsMapFile() {
        val provider = MapEditorProvider()
        val code = myFixture.addFileToProject("a/Main.java", "class Main {}").virtualFile
        assertTrue(provider.accept(project, CodebloomMapFile(project)))
        assertFalse(provider.accept(project, code))
    }

    fun testTabTitleNamesTheMap() {
        val titles = MapTabTitleProvider()
        assertEquals("Codebloom", titles.getEditorTabTitle(project, CodebloomMapFile(project)))
        val code = myFixture.addFileToProject("a/Main.java", "class Main {}").virtualFile
        assertNull(titles.getEditorTabTitle(project, code))
    }

    fun testEditorHostsTheMapAndLetsGoOnDispose() {
        val file = CodebloomMapFile(project)
        val editor = MapEditorProvider().createEditor(project, file)
        try {
            assertSame(file, editor.file)
            if (com.intellij.ui.jcef.JBCefApp.isSupported()) {
                assertNotNull("the tab's map is reachable for actions", file.panel)
                assertSame(file.panel!!.component, editor.component)
                // A map tab is never mapped as code itself.
                file.panel!!.open(file)
                assertNull(file.panel!!.fileName)
            } else {
                assertTrue((editor.component as javax.swing.JLabel).text.contains("JCEF"))
            }
        } finally {
            com.intellij.openapi.util.Disposer.dispose(editor)
        }
        assertNull(file.panel)
    }
}
