package io.github.rohanpatnaik.codebloom

import com.intellij.psi.PsiAnonymousClass
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiClassInitializer
import com.intellij.psi.PsiDocCommentOwner
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiField
import com.intellij.psi.PsiJavaCodeReferenceElement
import com.intellij.psi.PsiMethod
import com.intellij.psi.PsiMethodCallExpression
import com.intellij.psi.PsiMethodReferenceExpression
import com.intellij.psi.PsiModifierListOwner
import com.intellij.psi.PsiNewExpression
import com.intellij.psi.PsiReference
import com.intellij.psi.PsiReferenceExpression
import com.intellij.psi.search.SearchScope
import com.intellij.psi.search.searches.MethodReferencesSearch
import com.intellij.util.MergeQuery
import com.intellij.util.Query

/**
 * Exact Java answers where the generic rules would guess. Registered from
 * codebloom-java.xml, so it only loads when the Java plugin is present.
 */
class JavaSupport : LanguageSupport {
    override fun kindOf(psi: PsiElement): JavaKind? = when (psi) {
        is PsiAnonymousClass -> JavaKind(null)
        is PsiClass -> when {
            psi.isAnnotationType -> JavaKind("interface", "@interface")
            psi.isInterface -> JavaKind("interface")
            psi.isEnum -> JavaKind("enum")
            psi.isRecord -> JavaKind("class", "record")
            else -> JavaKind("class")
        }
        is PsiMethod -> JavaKind(if (psi.isConstructor) "ctor" else "method")
        is PsiField, is PsiClassInitializer -> JavaKind(null)
        else -> null
    }

    override fun describe(psi: PsiElement, blk: Block) {
        if (psi is PsiModifierListOwner) {
            val anns = psi.modifierList?.annotations.orEmpty().map { MapBuilder.oneLine(it.text, 60) }
            if (anns.isNotEmpty()) blk.decorators = anns
        }
        if (psi is PsiDocCommentOwner) {
            val doc = psi.docComment?.descriptionElements?.joinToString("") { it.text }?.trim()
            if (!doc.isNullOrEmpty()) blk.detail = MapBuilder.oneLine(doc, 80)
        }
        when (psi) {
            is PsiMethod -> {
                val ret = psi.returnTypeElement?.text
                blk.signature = MapBuilder.oneLine(psi.parameterList.text + (ret?.let { " → $it" } ?: ""), 140)
            }
            is PsiClass -> {
                val bases = (psi.extendsListTypes + psi.implementsListTypes).map { it.presentableText }
                if (bases.isNotEmpty()) blk.signature = MapBuilder.oneLine("extends ${bases.joinToString(", ")}", 140)
            }
        }
    }

    override fun isCallSite(e: PsiElement): Boolean? = when {
        e is PsiNewExpression || e is PsiMethodCallExpression -> true
        e is PsiMethodReferenceExpression -> false
        e is PsiReferenceExpression -> (e.parent as? PsiMethodCallExpression)?.methodExpression == e
        e is PsiJavaCodeReferenceElement -> e.parent is PsiNewExpression
        else -> null
    }

    /** `new Foo()` resolves to the class; point at the constructor it actually calls. */
    override fun constructorFor(site: PsiElement, target: PsiElement): PsiElement? {
        val newExpr = site.parent as? PsiNewExpression ?: return null
        return if (target is PsiClass) newExpr.resolveConstructor() else null
    }

    /**
     * References to a method, including calls through the interface or base
     * method it overrides. The generic search misses those, and even misses
     * direct references to an override. Null when not a Java method.
     */
    override fun references(psi: PsiElement, scope: SearchScope): Query<PsiReference>? {
        val method = psi as? PsiMethod ?: return null
        val supers = method.findDeepestSuperMethods()
        val queries = (listOf(method) + supers).map { MethodReferencesSearch.search(it, scope, false) }
        return queries.reduce { a, b -> MergeQuery(a, b) }
    }
}
