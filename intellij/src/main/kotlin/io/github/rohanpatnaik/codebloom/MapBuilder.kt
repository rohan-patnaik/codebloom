package io.github.rohanpatnaik.codebloom

import com.intellij.ide.structureView.StructureViewTreeElement
import com.intellij.ide.structureView.TreeBasedStructureViewBuilder
import com.intellij.ide.util.treeView.smartTree.TreeElement
import com.intellij.lang.LanguageStructureViewBuilder
import com.intellij.openapi.editor.Document
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.PsiPolyVariantReference
import com.intellij.psi.PsiRecursiveElementWalkingVisitor

/** One branch of the map. Same fields as the VS Code ViewBlock, plus the PSI it came from. */
class Block(
    val id: String,
    val kind: String,
    val name: String,
    val qual: String,
    val start: Int,
    var end: Int,
    val defLine: Int,
    val psi: PsiElement?,
    val parent: Block?,
    val startOffset: Int,
    var endOffset: Int,
) {
    var signature: String? = null
    var detail: String? = null
    var tag: String? = null
    var decorators: List<String>? = null
    val children = mutableListOf<Block>()

    val isGroup get() = kind in GROUP_KINDS
    val isCallable get() = kind == "function" || kind == "method" || kind == "ctor"
    val isContainer get() = kind == "class" || kind == "interface" || kind == "enum" || kind == "namespace"

    fun toJson(): Map<String, Any?> = mapOf(
        "id" to id, "kind" to kind, "name" to name, "qual" to qual, "start" to start, "end" to end, "defLine" to defLine,
        "signature" to signature, "detail" to detail, "tag" to tag, "decorators" to decorators,
        "children" to children.map { it.toJson() },
    )

    companion object {
        val GROUP_KINDS = setOf("imports", "globals", "fields", "script", "doc", "main")
    }
}

/** A call or reference to another block. `id` matches a block when the target is in a mapped file. */
data class Ref(val id: String, val label: String, val rel: String, val line: Int, val kind: String, val at: Int, val uri: String?) {
    fun toJson() = mapOf("id" to id, "label" to label, "rel" to rel, "line" to line, "kind" to kind, "at" to at, "uri" to uri)
}

class Links {
    val out = mutableListOf<Ref>()
    val callers = mutableListOf<Ref>()
    val refs = mutableListOf<Ref>()
    val ext = mutableListOf<String>()
    val isEmpty get() = out.isEmpty() && callers.isEmpty() && refs.isEmpty() && ext.isEmpty()
    fun toJson() = mapOf("out" to out.map { it.toJson() }, "in" to callers.map { it.toJson() }, "ext" to ext, "refs" to refs.map { it.toJson() })
}

class FileMap(
    val file: PsiFile,
    val rel: String,
    val lang: String,
    val lineCount: Int,
    val blocks: List<Block>,
    val links: Map<String, Links>,
    private val byPsi: Map<PsiElement, Block>,
) {
    val all: List<Block> = buildList { fun add(bs: List<Block>) { for (b in bs) { add(b); add(b.children) } }; add(blocks) }
    private val byId = all.associateBy { it.id }

    fun block(id: String) = byId[id]
    fun blockOf(psi: PsiElement) = byPsi[psi]

    /** Innermost block containing a text offset. */
    fun ownerAt(offset: Int): Block? {
        var list = blocks
        var found: Block? = null
        while (true) {
            val hit = list.firstOrNull { offset >= it.startOffset && offset < it.endOffset } ?: return found
            found = hit
            list = hit.children
        }
    }

    fun toJson(engineStats: Map<String, Any?>) = mapOf(
        "rel" to rel, "lang" to lang, "engine" to "symbols", "lineCount" to lineCount,
        "blocks" to blocks.map { it.toJson() },
        "links" to links.filterValues { !it.isEmpty }.mapValues { it.value.toJson() },
        "stats" to engineStats,
    )
}

/**
 * Builds a file's map from IntelliJ's own code model: blocks from the
 * Structure view (so every language the IDE understands works), and calls by
 * resolving the references inside each block. Call inside a read action.
 */
internal object MapBuilder {
    private val IMPORT_LINE = Regex("""^\s*(?:import\b|from\s+\S+\s+import\b|use\s|using\s|require\b|#\s*include\b|#import\b|@import\b|package\s|library\s|open\s|extern\s+crate\b)""")
    private val FN_TEXT = Regex("""=>|\bfunction\b|\bfunc\b|\blambda\b|\bfn\b|\bdef\b|\bfun\b""")

    /** Whether a file has a structure the map can be built from. */
    fun canMap(file: PsiFile) = LanguageStructureViewBuilder.getInstance().getStructureViewBuilder(file) is TreeBasedStructureViewBuilder

    fun relOf(project: Project, vf: VirtualFile?): String {
        if (vf == null) return "?"
        val base = project.guessProjectDir()
        return (base?.let { VfsUtilCore.getRelativePath(vf, it, '/') }) ?: vf.name
    }

    fun langId(file: PsiFile): String = when (val id = file.language.id.lowercase()) {
        "ecmascript 6", "javascript", "jsx harmony", "flow js" -> "javascript"
        "typescript jsx" -> "typescriptreact"
        else -> id
    }

    fun build(project: Project, file: PsiFile): FileMap? {
        val doc = PsiDocumentManager.getInstance(project).getDocument(file) ?: return null
        val rel = relOf(project, file.virtualFile)
        val builder = LanguageStructureViewBuilder.getInstance().getStructureViewBuilder(file) as? TreeBasedStructureViewBuilder
        val quals = HashSet<String>()
        val byPsi = HashMap<PsiElement, Block>()
        val blocks = mutableListOf<Block>()
        if (builder != null) {
            val model = builder.createStructureViewModel(null)
            try {
                Structure(file, doc, rel, quals, byPsi).build(model.root.children.toList(), null, blocks)
            } finally {
                Disposer.dispose(model)
            }
        }
        addImports(doc, rel, quals, blocks)
        val map = FileMap(file, rel, langId(file), doc.lineCount.coerceAtLeast(1), blocks, HashMap(), byPsi)
        Calls(project, map, doc).link()
        return map
    }

    fun lineOf(doc: Document, offset: Int) = doc.getLineNumber(offset.coerceIn(0, doc.textLength)) + 1

    fun oneLine(s: String, max: Int = 90): String {
        val t = s.replace(Regex("\\s+"), " ").trim()
        return if (t.length > max) t.take(max - 1) + "…" else t
    }

    private fun unique(quals: MutableSet<String>, q: String): String {
        var c = q
        var i = 2
        while (!quals.add(c)) c = "$q#${i++}"
        return c
    }

    private class Structure(
        val file: PsiFile,
        val doc: Document,
        val rel: String,
        val quals: MutableSet<String>,
        val byPsi: MutableMap<PsiElement, Block>,
    ) {
        fun build(elements: List<TreeElement>, parent: Block?, out: MutableList<Block>) {
            val items = elements.mapNotNull { te ->
                val psi = (te as? StructureViewTreeElement)?.value as? PsiElement
                if (psi == null || !psi.isValid || psi.containingFile != file || psi.textRange == null) null else te to psi
            }.sortedBy { it.second.textRange.startOffset }
            var group: Block? = null
            val names = mutableListOf<String>()
            fun flush() {
                group?.detail = if (names.size > 6) names.take(6).joinToString(", ") + ", +${names.size - 6}" else names.joinToString(", ")
                group = null
                names.clear()
            }
            for ((te, psi) in items) {
                val range = psi.textRange
                val start = lineOf(doc, range.startOffset)
                val end = lineOf(doc, (range.endOffset - 1).coerceAtLeast(range.startOffset))
                val name = (psi as? PsiNamedElement)?.name ?: te.presentation.presentableText ?: "?"
                val children = te.children.toList()
                val kind = kindOf(psi, children.isNotEmpty(), parent, start, end)
                if (kind == null) {
                    // Locals inside a function are noise; elsewhere group consecutive values.
                    if (parent?.isCallable == true) continue
                    val gk = if (parent != null) "fields" else "globals"
                    val g = group
                    if (g != null) {
                        g.end = maxOf(g.end, end)
                        g.endOffset = maxOf(g.endOffset, range.endOffset)
                    } else {
                        val q = unique(quals, "${parent?.qual?.plus(".") ?: ""}#$gk@$start")
                        Block("$rel::$q", gk, gk, q, start, end, start, null, parent, range.startOffset, range.endOffset).also { group = it; out.add(it) }
                    }
                    if (name !in names) names.add(name)
                    continue
                }
                flush()
                val nameEl = (psi as? PsiNameIdentifierOwner)?.nameIdentifier ?: psi
                val q = unique(quals, parent?.let { "${it.qual}.$name" } ?: name)
                val blk = Block("$rel::$q", kind.first, name, q, start, end, lineOf(doc, nameEl.textOffset), psi, parent, range.startOffset, range.endOffset)
                blk.tag = kind.second
                LanguageSupport.describe(psi, blk)
                if (blk.signature == null && blk.isCallable) blk.signature = signatureAfterName(doc, blk.defLine, name)
                byPsi[psi] = blk
                out.add(blk)
                if (children.isNotEmpty()) build(children, blk, blk.children)
            }
            flush()
        }

        /** (kind, chip tag), or null for a plain value that gets grouped. */
        private fun kindOf(psi: PsiElement, hasChildren: Boolean, parent: Block?, start: Int, end: Int): Pair<String, String?>? {
            LanguageSupport.kindOf(psi)?.let { return it.kind?.let { k -> k to it.tag } }
            return genericKind(psi, hasChildren, parent?.isContainer == true) ?: run {
                // A value whose definition is a function expression: `const f = () => {}`.
                val head = doc.getText(com.intellij.openapi.util.TextRange(doc.getLineStartOffset(start - 1), doc.getLineEndOffset(start - 1)))
                if (end > start && FN_TEXT.containsMatchIn(head)) "function" to null else null
            }
        }
    }

    /** Classify PSI from languages Codebloom has no special support for, by their class names. */
    fun genericKind(psi: PsiElement, hasChildren: Boolean, inContainer: Boolean): Pair<String, String?>? {
        val n = psi.javaClass.simpleName.lowercase()
        return when {
            "constructor" in n -> "ctor" to null
            "initializer" in n || "body" in n -> null
            "interface" in n -> "interface" to null
            "trait" in n -> "interface" to "trait"
            "enum" in n && "entry" !in n && "constant" !in n && "member" !in n -> "enum" to null
            "function" in n || "method" in n -> (if (inContainer) "method" else "function") to null
            "struct" in n -> "class" to "struct"
            "objectdeclaration" in n -> "class" to "object"
            "class" in n -> "class" to null
            "module" in n || "namespace" in n || "package" in n -> "namespace" to "module"
            "header" in n || "heading" in n -> "section" to "heading"
            hasChildren -> "section" to null
            else -> null
        }
    }

    fun isCallableKind(kind: String?) = kind == "function" || kind == "method" || kind == "ctor"
    fun isContainerKind(kind: String?) = kind == "class" || kind == "interface" || kind == "enum" || kind == "namespace"

    /** Whatever follows the name on its line: "(a: String): Int". */
    private fun signatureAfterName(doc: Document, line: Int, name: String): String? {
        val text = doc.getText(com.intellij.openapi.util.TextRange(doc.getLineStartOffset(line - 1), doc.getLineEndOffset(line - 1)))
        val at = text.indexOf(name)
        if (at < 0) return null
        val after = text.substring(at + name.length)
        if (!Regex("""^\s*[(<\[]""").containsMatchIn(after)) return null
        return oneLine(after.replace(Regex("""\s*\{.*$"""), "").replace(Regex("""\s*(=>|=|:)?\s*$"""), ""), 140).ifEmpty { null }
    }

    /** Imports are rarely in the Structure view, so find them as leading lines before the first block. */
    private fun addImports(doc: Document, rel: String, quals: MutableSet<String>, blocks: MutableList<Block>) {
        val firstStart = blocks.firstOrNull()?.start ?: (doc.lineCount + 1)
        var first = 0
        var last = 0
        val mods = mutableListOf<String>()
        var i = 0
        val lines = doc.lineCount
        fun line(n: Int) = doc.getText(com.intellij.openapi.util.TextRange(doc.getLineStartOffset(n), doc.getLineEndOffset(n)))
        while (i < firstStart - 1 && i < lines) {
            val l = line(i)
            if (IMPORT_LINE.containsMatchIn(l)) {
                if (first == 0) first = i + 1
                last = i + 1
                if (Regex("""\(\s*$""").containsMatchIn(l)) {
                    // Go-style grouped imports.
                    while (last < firstStart - 1 && last < lines && !Regex("""^\s*\)""").containsMatchIn(line(last))) {
                        Regex("""["'`]([^"'`]+)["'`]""").find(line(last))?.groupValues?.get(1)?.let { if (it !in mods) mods.add(it) }
                        last++
                    }
                    last = minOf(last + 1, firstStart - 1)
                    i = last
                    continue
                }
                val m = Regex("""["'`<]([^"'`>]+)["'`>]""").find(l)
                    ?: Regex("""^\s*(?:import|from|use|using|package|library|open)\s+(?:static\s+)?([\w.:/@*-]+)""").find(l)
                m?.groupValues?.get(1)?.trimEnd(';')?.let { if (it !in mods) mods.add(it) }
            }
            i++
        }
        if (first == 0) return
        val q = unique(quals, "#imports@$first")
        val start = doc.getLineStartOffset(first - 1)
        val imp = Block("$rel::$q", "imports", "imports", q, first, last, first, null, null, start, doc.getLineEndOffset(last - 1))
        imp.detail = (if (mods.size > 6) mods.take(6).joinToString(", ") + ", +${mods.size - 6}" else mods.joinToString(", ")).ifEmpty { "imports" }
        blocks.add(0, imp)
    }

    /** Links each block to what it calls or passes around, by resolving its references. */
    private class Calls(val project: Project, val map: FileMap, val doc: Document) {
        private val index = ProjectFileIndex.getInstance(project)
        // owner id -> target id -> (ref, isCall)
        private val found = LinkedHashMap<String, LinkedHashMap<String, Pair<Ref, Boolean>>>()
        private val ext = LinkedHashMap<String, LinkedHashSet<String>>()

        fun link() {
            map.file.accept(object : PsiRecursiveElementWalkingVisitor() {
                override fun visitElement(element: PsiElement) {
                    visit(element)
                    super.visitElement(element)
                }
            })
            val links = map.links as MutableMap<String, Links>
            fun linksOf(id: String) = links.getOrPut(id) { Links() }
            for ((ownerId, targets) in found) {
                val owner = map.block(ownerId) ?: continue
                for ((targetId, pair) in targets) {
                    val (ref, isCall) = pair
                    if (isCall) linksOf(ownerId).out.add(ref)
                    // Inside this file we know the other direction too.
                    if (map.block(targetId) != null) {
                        val back = Ref(owner.id, owner.qual.replace(Regex("#\\d+$"), ""), map.rel, owner.defLine, owner.kind, ref.at, null)
                        if (isCall) linksOf(targetId).callers.add(back) else linksOf(targetId).refs.add(back)
                    }
                }
            }
            for ((ownerId, names) in ext) linksOf(ownerId).ext.addAll(names.take(40))
        }

        private fun visit(e: PsiElement) {
            val refs = e.references
            if (refs.isEmpty()) return
            val owner = map.ownerAt(e.textOffset) ?: return
            val call = MapBuilder.callSite(e)
            for (ref in refs) {
                val targets = when (ref) {
                    is PsiPolyVariantReference -> ref.multiResolve(false).mapNotNull { it.element }.take(3)
                    else -> listOfNotNull(ref.resolve())
                }
                if (targets.isEmpty()) {
                    if (call && ref.rangeInElement.length > 0) ext.getOrPut(owner.id) { LinkedHashSet() }.add(oneLine(e.text, 40))
                    continue
                }
                for (t in targets) add(owner, e, t, call)
            }
        }

        private fun add(owner: Block, site: PsiElement, target0: PsiElement, call: Boolean) {
            val target = (if (call) LanguageSupport.constructorFor(site, target0) else null) ?: target0
            val kind = kindOfTarget(target) ?: return
            // Classes only count when instantiated; a type mention isn't a call.
            if (isContainerKind(kind) && !call) return
            if (!isCallableKind(kind) && !isContainerKind(kind)) return
            val vf = target.containingFile?.virtualFile ?: return
            if (!index.isInContent(vf)) return
            val at = lineOf(doc, site.textOffset)
            val ref = if (target.containingFile == map.file) {
                val blk = map.blockOf(target) ?: return
                if (blk.id == owner.id) return
                Ref(blk.id, blk.qual.replace(Regex("#\\d+$"), ""), map.rel, blk.defLine, blk.kind, at, null)
            } else {
                refTo(project, target, kind, at) ?: return
            }
            val targets = found.getOrPut(owner.id) { LinkedHashMap() }
            val prev = targets[ref.id]
            if (prev == null || (call && !prev.second)) targets[ref.id] = ref to (call || prev?.second == true)
        }
    }

    /** Whether a reference is the callee of a call, rather than a function passed around as a value. */
    fun callSite(e: PsiElement): Boolean {
        LanguageSupport.isCallSite(e)?.let { return it }
        val p = e.parent ?: return false
        return "call" in p.javaClass.simpleName.lowercase() && p.firstChild == e
    }

    fun kindOfTarget(psi: PsiElement): String? {
        LanguageSupport.kindOf(psi)?.let { return it.kind }
        return genericKind(psi, false, psi.parent?.let { p -> genericKind(p, true, false)?.first?.let(::isContainerKind) } == true)?.first
    }

    /** A Ref to a declaration in another file. The id never matches a block, so the map selects by line. */
    fun refTo(project: Project, target: PsiElement, kind: String, at: Int): Ref? {
        val file = target.containingFile ?: return null
        val vf = file.virtualFile ?: return null
        val doc = PsiDocumentManager.getInstance(project).getDocument(file) ?: return null
        val nameEl = (target as? PsiNameIdentifierOwner)?.nameIdentifier ?: target
        val line = lineOf(doc, nameEl.textOffset)
        val rel = relOf(project, vf)
        return Ref("$rel::@$line:${labelOf(target)}", labelOf(target), rel, line, kind, at, vf.url)
    }

    /** "Outer.Inner.method" for a declaration, from its named containers. */
    fun labelOf(psi: PsiElement): String {
        val parts = mutableListOf<String>()
        var e: PsiElement? = psi
        while (e != null && e !is PsiFile) {
            if (e is PsiNamedElement && e.name != null && (e === psi || isContainerKind(kindOfTarget(e)))) parts.add(0, e.name!!)
            e = e.parent
        }
        return parts.joinToString(".").ifEmpty { psi.text.take(30) }
    }
}
