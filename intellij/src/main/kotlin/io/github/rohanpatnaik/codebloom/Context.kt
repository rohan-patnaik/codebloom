package io.github.rohanpatnaik.codebloom

/** Text for pasting into an LLM chat: a block's code plus what it calls and what calls it. */
internal object Context {
    fun text(map: FileMap, block: Block?, text: String, callers: Map<String, Any?>?): String {
        val lang = map.lang
        if (block == null) return "# ${map.rel}\n```$lang\n$text\n```\n"
        val lines = text.split(Regex("\r?\n"))
        val code = lines.subList((block.start - 1).coerceAtLeast(0), block.end.coerceAtMost(lines.size)).joinToString("\n")
        val links = map.links[block.id]
        fun fmt(refs: List<Ref>) = refs.map { "${it.label} (${it.rel}:${it.line})" }.distinct()
        @Suppress("UNCHECKED_CAST")
        fun fromResult(key: String) = (callers?.get(key) as? List<Map<String, Any?>>)?.map { "${it["label"]} (${it["rel"]}:${it["line"]})" }?.distinct()
        val calls = fmt(links?.out.orEmpty())
        val callersList = fromResult("in") ?: fmt(links?.callers.orEmpty())
        val refs = fromResult("refs") ?: fmt(links?.refs.orEmpty())
        val sb = StringBuilder("# ${map.rel} :: ${block.qual.replace(Regex("#\\d+$"), "")}  (lines ${block.start}-${block.end})\n```$lang\n$code\n```\n")
        if (calls.isNotEmpty()) sb.append("\nCalls:\n").append(calls.joinToString("\n") { "- $it" }).append('\n')
        if (callersList.isNotEmpty()) sb.append("\nCalled by:\n").append(callersList.joinToString("\n") { "- $it" }).append('\n')
        if (refs.isNotEmpty()) sb.append("\nPassed as a value by:\n").append(refs.joinToString("\n") { "- $it" }).append('\n')
        block.decorators?.takeIf { it.isNotEmpty() }?.let { sb.append("\nAnnotations: ").append(it.joinToString(", ")).append('\n') }
        links?.ext?.takeIf { it.isNotEmpty() }?.let { sb.append("\nUnlinked calls: ").append(it.joinToString(", ")).append('\n') }
        return sb.toString()
    }
}
