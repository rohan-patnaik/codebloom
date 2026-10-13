package io.github.rohanpatnaik.codebloom

import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiReference
import com.intellij.psi.search.SearchScope
import com.intellij.util.Query

/**
 * Exact answers for one language where Codebloom's generic, class-name based
 * rules would guess. Every method returns null for elements it doesn't know.
 */
interface LanguageSupport {
    /** Block kind and chip tag; a [JavaKind] with a null kind means "a value to group". */
    fun kindOf(psi: PsiElement): JavaKind? = null

    /** Fill in signature, docs and annotations. */
    fun describe(psi: PsiElement, blk: Block) {}

    /** true for a call, false for a reference that passes the target around. */
    fun isCallSite(e: PsiElement): Boolean? = null

    /** The declaration a call really reaches, e.g. the constructor behind `new Foo()`. */
    fun constructorFor(site: PsiElement, target: PsiElement): PsiElement? = null

    /** A better reference search than the generic one, e.g. including calls through super methods. */
    fun references(psi: PsiElement, scope: SearchScope): Query<PsiReference>? = null

    companion object {
        val EP = ExtensionPointName.create<LanguageSupport>("io.github.rohanpatnaik.codebloom.languageSupport")

        private val all get() = EP.extensionList

        fun kindOf(psi: PsiElement) = all.firstNotNullOfOrNull { it.kindOf(psi) }
        fun describe(psi: PsiElement, blk: Block) = all.forEach { it.describe(psi, blk) }
        fun isCallSite(e: PsiElement) = all.firstNotNullOfOrNull { it.isCallSite(e) }
        fun constructorFor(site: PsiElement, target: PsiElement) = all.firstNotNullOfOrNull { it.constructorFor(site, target) }
        fun references(psi: PsiElement, scope: SearchScope) = all.firstNotNullOfOrNull { it.references(psi, scope) }
    }
}

/** kind null means "a value to group". */
class JavaKind(val kind: String?, val tag: String? = null)
