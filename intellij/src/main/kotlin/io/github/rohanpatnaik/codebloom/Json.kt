package io.github.rohanpatnaik.codebloom

/**
 * The little JSON the webview bridge needs, without pulling a library into the
 * plugin. Maps with null values drop those keys, like JSON.stringify.
 */
internal object Json {
    fun encode(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    fun decode(text: String): Any? = Reader(text).run { value().also { skip(); check(i == s.length) { "trailing JSON" } } }

    private fun write(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is String -> string(sb, v)
            is Boolean -> sb.append(v)
            is Int, is Long, is Short, is Byte -> sb.append(v)
            is Number -> v.toDouble().let { if (it.isFinite()) sb.append(v) else sb.append("null") }
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, x) in v) {
                    if (x == null) continue
                    if (!first) sb.append(',')
                    first = false
                    string(sb, k.toString())
                    sb.append(':')
                    write(sb, x)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (x in v) {
                    if (!first) sb.append(',')
                    first = false
                    write(sb, x)
                }
                sb.append(']')
            }
            is Array<*> -> write(sb, v.asList())
            else -> string(sb, v.toString())
        }
    }

    private fun string(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                // Safe to embed in a <script> or a JS string literal.
                '<' -> sb.append("\\u003c")
                ' ' -> sb.append("\\u2028")
                ' ' -> sb.append("\\u2029")
                else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    private class Reader(val s: String) {
        var i = 0

        fun skip() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        fun value(): Any? {
            skip()
            check(i < s.length) { "unexpected end of JSON" }
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> if (c == '-' || c.isDigit()) num() else error("bad JSON at $i")
            }
        }

        private fun word(w: String, v: Any?): Any? {
            check(s.startsWith(w, i)) { "bad JSON at $i" }
            i += w.length
            return v
        }

        private fun num(): Number {
            val start = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            val t = s.substring(start, i)
            return t.toLongOrNull() ?: t.toDouble()
        }

        private fun str(): String {
            val sb = StringBuilder()
            i++
            while (true) {
                check(i < s.length) { "unterminated JSON string" }
                val c = s[i++]
                when (c) {
                    '"' -> return sb.toString()
                    '\\' -> when (val e = s[i++]) {
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000c')
                        'u' -> {
                            sb.append(s.substring(i, i + 4).toInt(16).toChar())
                            i += 4
                        }
                        else -> sb.append(e)
                    }
                    else -> sb.append(c)
                }
            }
        }

        private fun obj(): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            i++
            skip()
            if (s[i] == '}') return m.also { i++ }
            while (true) {
                skip()
                val k = str()
                skip()
                check(s[i++] == ':') { "expected : at $i" }
                m[k] = value()
                skip()
                when (s[i++]) {
                    ',' -> continue
                    '}' -> return m
                    else -> error("expected , or } at $i")
                }
            }
        }

        private fun arr(): List<Any?> {
            val l = ArrayList<Any?>()
            i++
            skip()
            if (s[i] == ']') return l.also { i++ }
            while (true) {
                l.add(value())
                skip()
                when (s[i++]) {
                    ',' -> continue
                    ']' -> return l
                    else -> error("expected , or ] at $i")
                }
            }
        }
    }
}
