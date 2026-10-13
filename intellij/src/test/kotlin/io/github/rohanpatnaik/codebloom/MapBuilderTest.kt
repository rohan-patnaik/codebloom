package io.github.rohanpatnaik.codebloom

import com.intellij.openapi.application.ReadAction
import com.intellij.testFramework.fixtures.LightJavaCodeInsightFixtureTestCase

class MapBuilderTest : LightJavaCodeInsightFixtureTestCase() {
    override fun getProjectDescriptor() = JAVA_21

    private fun build(path: String): FileMap {
        val file = myFixture.findFileInTempDir(path)
        val psi = psiManager.findFile(file)!!
        return ReadAction.compute<FileMap, Throwable> { MapBuilder.build(project, psi)!! }
    }

    private fun FileMap.find(qual: String) = all.first { it.qual == qual }
    private fun FileMap.outs(qual: String) = links[find(qual).id]?.out.orEmpty().map { "${it.rel}:${it.label}" }
    private fun FileMap.callersOf(qual: String) = links[find(qual).id]?.callers.orEmpty().map { it.label }
    private fun FileMap.refsOf(qual: String) = links[find(qual).id]?.refs.orEmpty().map { it.label }

    override fun setUp() {
        super.setUp()
        myFixture.addFileToProject(
            "shop/Pricing.java",
            """
            package shop;

            public interface Pricing {
                int price(String item);
            }
            """.trimIndent(),
        )
        myFixture.addFileToProject(
            "shop/Cart.java",
            """
            package shop;

            import java.util.ArrayList;
            import java.util.List;

            /** A shopping cart. */
            public class Cart implements Pricing {
                private final List<String> items = new ArrayList<>();
                private int count;

                public Cart() {
                    reset();
                }

                @Override
                public int price(String item) {
                    return item.length();
                }

                public void add(String item) {
                    items.add(item);
                    log(item);
                }

                public int total(Pricing p) {
                    int t = 0;
                    for (String i : items) t += p.price(i);
                    return t;
                }

                public Pricing prices() {
                    return this::price;
                }

                private void reset() {
                    count = 0;
                }

                private static void log(String s) {
                    System.out.println(s);
                }

                enum Size { SMALL, LARGE }
            }
            """.trimIndent(),
        )
        myFixture.addFileToProject(
            "shop/Checkout.java",
            """
            package shop;

            public class Checkout {
                public int run() {
                    Cart cart = new Cart();
                    cart.add("apple");
                    return cart.total(cart);
                }
            }
            """.trimIndent(),
        )
    }

    fun testBlocksFollowTheStructure() {
        val m = build("shop/Cart.java")
        assertEquals(listOf("imports", "class"), m.blocks.map { it.kind })
        assertEquals("shop, java.util.ArrayList, java.util.List", m.blocks[0].detail)
        val cart = m.find("Cart")
        assertEquals("A shopping cart.", cart.detail)
        assertEquals("extends Pricing", cart.signature)
        assertEquals(
            listOf("fields:fields", "ctor:Cart", "method:price", "method:add", "method:total", "method:prices", "method:reset", "method:log", "enum:Size"),
            cart.children.map { "${it.kind}:${it.name}" },
        )
        assertEquals("items, count", cart.children[0].detail)
        assertEquals(listOf("@Override"), m.find("Cart.price").decorators)
        assertEquals("(String item) → void", m.find("Cart.add").signature)
    }

    fun testCallsLinkInsideTheFile() {
        val m = build("shop/Cart.java")
        assertEquals(listOf("shop/Cart.java:Cart.log"), m.outs("Cart.add"))
        assertEquals(listOf("shop/Cart.java:Cart.reset"), m.outs("Cart.Cart"))
        assertEquals(listOf("Cart.add"), m.callersOf("Cart.log"))
        // Library calls (List.add, println) are not project code.
        assertTrue(m.outs("Cart.log").isEmpty())
    }

    fun testMethodReferencesArePassedAsValues() {
        val m = build("shop/Cart.java")
        assertEquals(listOf("Cart.prices"), m.refsOf("Cart.price"))
        assertTrue(m.callersOf("Cart.price").isEmpty())
    }

    fun testCallsIntoOtherFiles() {
        val m = build("shop/Checkout.java")
        val outs = m.outs("Checkout.run")
        assertTrue(outs.toString(), "shop/Cart.java:Cart.Cart" in outs)
        assertTrue(outs.toString(), "shop/Cart.java:Cart.add" in outs)
        assertTrue(outs.toString(), "shop/Cart.java:Cart.total" in outs)
        val add = m.links[m.find("Checkout.run").id]!!.out.first { it.label == "Cart.add" }
        assertTrue("cross-file ids never match a block, so the map selects by line", add.id.contains("::@"))
        assertTrue(add.uri!!.endsWith("shop/Cart.java"))
    }

    fun testCallersAcrossTheProject() {
        val m = build("shop/Cart.java")
        val add = ReadAction.compute<Map<String, Any?>, Throwable> { Callers.find(project, m, m.find("Cart.add").id) }
        assertEquals("ok", add["status"])
        @Suppress("UNCHECKED_CAST")
        val callers = (add["in"] as List<Map<String, Any?>>).map { "${it["rel"]}:${it["label"]}" }
        assertEquals(listOf("shop/Checkout.java:Checkout.run"), callers)
        // `p.price(i)` calls the interface; it still reaches the override.
        val price = ReadAction.compute<Map<String, Any?>, Throwable> { Callers.find(project, m, m.find("Cart.price").id) }
        @Suppress("UNCHECKED_CAST")
        val priceCallers = (price["in"] as List<Map<String, Any?>>).map { it["label"] }
        assertTrue(priceCallers.toString(), "Cart.total" in priceCallers)
        @Suppress("UNCHECKED_CAST")
        val priceRefs = (price["refs"] as List<Map<String, Any?>>).map { it["label"] }
        assertEquals(price.toString(), listOf("Cart.prices"), priceRefs)
        // A class is called when it is instantiated.
        val ctor = ReadAction.compute<Map<String, Any?>, Throwable> { Callers.find(project, m, m.find("Cart.Cart").id) }
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("Checkout.run"), (ctor["in"] as List<Map<String, Any?>>).map { it["label"] })
    }

    fun testCopyAsContext() {
        val m = build("shop/Checkout.java")
        val text = Context.text(m, m.find("Checkout.run"), myFixture.findFileInTempDir("shop/Checkout.java").let { String(it.contentsToByteArray()) }, null)
        assertTrue(text, text.startsWith("# shop/Checkout.java :: Checkout.run"))
        assertTrue(text, "- Cart.add (shop/Cart.java:" in text)
    }

    fun testJsonRoundTrip() {
        val v = mapOf("a" to listOf(1, 2.5, true, null, "x\"</script>\n"), "b" to null, "c" to mapOf("d" to "é"))
        val text = Json.encode(v)
        assertFalse(text.contains("</"))
        assertEquals(mapOf("a" to listOf(1L, 2.5, true, null, "x\"</script>\n"), "c" to mapOf("d" to "é")), Json.decode(text))
    }
}
