import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import groovy.json.JsonSlurper

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "io.github.rohanpatnaik"
// Both editor packages share the release version in package.json.
val releaseVersion = providers.fileContents(layout.projectDirectory.file("../package.json")).asText.map {
    (JsonSlurper().parseText(it) as Map<*, *>)["version"] as String
}
version = releaseVersion.get()

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // No compatibility stubs for interface defaults; they look like overrides of internal IntelliJ API.
        jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
    }
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
        bundledPlugin("com.intellij.java")
        testFramework(TestFrameworkType.Platform)
        testFramework(TestFrameworkType.Plugin.Java)
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
}

intellijPlatform {
    pluginConfiguration {
        version = releaseVersion
        ideaVersion {
            sinceBuild = "243"
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ignoredProblemsFile = layout.projectDirectory.file("verifier-ignored-problems.txt")
        ides {
            // Oldest supported, newest release, and an IDE without Java.
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3.7")
            create(IntelliJPlatformType.IntellijIdea, "2026.2.3")
            create(IntelliJPlatformType.PyCharm, "2025.3")
        }
    }
}

// The map UI is the same webview the VS Code extension ships. Build it with
// `npm run build` in the repository root first.
val webview = layout.projectDirectory.dir("../dist")
check(webview.file("webview.js").asFile.exists()) { "Run `npm run build` in the repository root to build the webview first." }
tasks.processResources {
    from(webview) {
        include("webview.js", "webview.css")
        into("webview")
    }
}

// Development: `./gradlew runIde -Pcodebloom.selfTestProject=<dir> -Pcodebloom.selfTestFile=<rel path> -Pcodebloom.selfTestOut=<dir>`
// opens the project, maps the file, reports what the page shows, and exits.
tasks.runIde {
    val selfTestProject = providers.gradleProperty("codebloom.selfTestProject")
    val selfTestFile = providers.gradleProperty("codebloom.selfTestFile")
    val selfTestOut = providers.gradleProperty("codebloom.selfTestOut")
    argumentProviders += CommandLineArgumentProvider { selfTestProject.map { listOf(it) }.getOrElse(emptyList()) }
    jvmArgumentProviders += CommandLineArgumentProvider {
        if (!selfTestProject.isPresent) emptyList()
        else listOf(
            "-Dcodebloom.selfTest=${selfTestFile.get()}",
            "-Dcodebloom.selfTestOut=${selfTestOut.get()}",
            "-Didea.trust.all.projects=true",
            "-Djb.consents.confirmation.enabled=false",
            "-Djb.privacy.policy.text=<!--999.999-->",
            "-Dide.show.tips.on.startup.default.value=false",
            "-Didea.is.internal=false",
        )
    }
}

// Development: the same self-test in PyCharm, for the generic (non-Java) path.
intellijPlatformTesting.runIde.register("runPyCharm") {
    type = IntelliJPlatformType.PyCharm
    version = "2025.3"
    task {
        val selfTestProject = providers.gradleProperty("codebloom.selfTestProject")
        val selfTestFile = providers.gradleProperty("codebloom.selfTestFile")
        val selfTestOut = providers.gradleProperty("codebloom.selfTestOut")
        argumentProviders += CommandLineArgumentProvider { selfTestProject.map { listOf(it) }.getOrElse(emptyList()) }
        jvmArgumentProviders += CommandLineArgumentProvider {
            if (!selfTestProject.isPresent) emptyList()
            else listOf(
                "-Dcodebloom.selfTest=${selfTestFile.get()}",
                "-Dcodebloom.selfTestOut=${selfTestOut.get()}",
                "-Didea.trust.all.projects=true",
                "-Djb.consents.confirmation.enabled=false",
                "-Djb.privacy.policy.text=<!--999.999-->",
                "-Dide.show.tips.on.startup.default.value=false",
            )
        }
    }
}
