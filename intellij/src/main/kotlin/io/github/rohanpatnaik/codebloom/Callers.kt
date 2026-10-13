package io.github.rohanpatnaik.codebloom

import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.util.Processor

/** Who calls a block, or passes it around, anywhere in the project. Run in a read action. */
internal object Callers {
    private const val LIMIT = 200

    fun find(project: Project, map: FileMap, id: String): Map<String, Any?> {
        val blk = map.block(id)
        val target = blk?.psi?.takeIf { it.isValid }
        val out = map.links[id]?.out.orEmpty()
        if (blk == null || target == null) return result(id, "unavailable", out, emptyList(), emptyList())
        val calls = LinkedHashMap<String, Ref>()
        val refs = LinkedHashMap<String, Ref>()
        val scope = GlobalSearchScope.projectScope(project)
        val query = LanguageSupport.references(target, scope) ?: ReferencesSearch.search(target, scope)
        query.forEach(Processor { r ->
            add(project, map, blk, r.element, calls, refs)
            calls.size + refs.size < LIMIT
        })
        for (k in calls.keys) refs.remove(k)
        return result(id, "ok", out, calls.values.toList(), refs.values.toList())
    }

    private fun add(project: Project, map: FileMap, blk: Block, e: PsiElement, calls: MutableMap<String, Ref>, refs: MutableMap<String, Ref>) {
        val call = MapBuilder.callSite(e)
        // A class is "called" when instantiated; type mentions are not callers.
        if (blk.isContainer && !call) return
        val file = e.containingFile ?: return
        val doc = PsiDocumentManager.getInstance(project).getDocument(file) ?: return
        val at = MapBuilder.lineOf(doc, e.textOffset)
        val ref = if (file == map.file) {
            val owner = map.ownerAt(e.textOffset) ?: return
            if (owner.id == blk.id) return
            Ref(owner.id, owner.qual.replace(Regex("#\\d+$"), ""), map.rel, owner.defLine, owner.kind, at, null)
        } else {
            val decl = enclosingDeclaration(e) ?: return
            MapBuilder.refTo(project, decl, MapBuilder.kindOfTarget(decl) ?: return, at) ?: return
        }
        (if (call) calls else refs).putIfAbsent(ref.id, ref)
    }

    /** The function or class a reference sits in. */
    private fun enclosingDeclaration(e: PsiElement): PsiElement? {
        var p: PsiElement? = e.parent
        while (p != null && p !is PsiFile) {
            if (p is PsiNamedElement) {
                val k = MapBuilder.kindOfTarget(p)
                if (MapBuilder.isCallableKind(k) || MapBuilder.isContainerKind(k)) return p
            }
            p = p.parent
        }
        return null
    }

    private fun result(id: String, status: String, out: List<Ref>, calls: List<Ref>, refs: List<Ref>) = mapOf(
        "type" to "calls", "id" to id, "status" to status,
        "out" to out.map { it.toJson() }, "in" to calls.map { it.toJson() }, "refs" to refs.map { it.toJson() },
    )
}
