package com.emergencycall

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.lang.reflect.Proxy
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class MlcGeneration(
  val text: String,
  val usedMlc: Boolean,
  val error: String? = null,
)

class MlcJsonRuntime {
  private var engine: Any? = null
  private var initialized = false
  private var loadedModelId: String? = null
  private var latestRequestId: String? = null
  private var responseBuilder = StringBuilder()
  private var responseLatch: CountDownLatch? = null
  private var streamError: String? = null

  @Synchronized
  fun warmUp(context: Context, modelId: String): MlcGeneration {
    val engineConfig = loadEngineConfig(context, modelId)
      ?: return MlcGeneration(
        text = "",
        usedMlc = false,
        error = "MLC engine config not found for $modelId. Expected assets/mlc/$modelId/engine-config.json or files/mlc/$modelId/engine-config.json.",
      )

    return runCatching {
      val engineClass = Class.forName("ai.mlc.mlcllm.JSONFFIEngine")
      val runtimeEngine = engine ?: engineClass.getDeclaredConstructor().newInstance().also {
        engine = it
      }

      if (!initialized) {
        val callbackInterface = Class.forName("ai.mlc.mlcllm.JSONFFIEngine\$KotlinFunction")
        val callback = Proxy.newProxyInstance(
          callbackInterface.classLoader,
          arrayOf(callbackInterface),
        ) { _, method, args ->
          if (method.name == "invoke" && args?.isNotEmpty() == true) {
            handleStreamMessage(args[0]?.toString().orEmpty())
          }
          null
        }
        engineClass.getMethod("initBackgroundEngine", callbackInterface).invoke(runtimeEngine, callback)
        Thread { engineClass.getMethod("runBackgroundLoop").invoke(runtimeEngine) }.apply {
          name = "MlcBackgroundLoop"
          isDaemon = true
          start()
        }
        Thread { engineClass.getMethod("runBackgroundStreamBackLoop").invoke(runtimeEngine) }.apply {
          name = "MlcStreamBackLoop"
          isDaemon = true
          start()
        }
        initialized = true
      }

      if (loadedModelId != modelId) {
        engineClass.getMethod("reload", String::class.java).invoke(runtimeEngine, engineConfig)
        loadedModelId = modelId
      }

      MlcGeneration(text = "", usedMlc = true)
    }.getOrElse { error ->
      MlcGeneration(text = "", usedMlc = false, error = error.message ?: error.javaClass.simpleName)
    }
  }

  @Synchronized
  fun generate(
    context: Context,
    modelId: String,
    prompt: String,
    timeoutMs: Long = 45_000,
  ): MlcGeneration {
    val warmUpResult = warmUp(context, modelId)
    if (!warmUpResult.usedMlc) return warmUpResult

    return runCatching {
      val runtimeEngine = checkNotNull(engine)
      val engineClass = Class.forName("ai.mlc.mlcllm.JSONFFIEngine")
      val requestId = UUID.randomUUID().toString()
      latestRequestId = requestId
      responseBuilder = StringBuilder()
      streamError = null
      responseLatch = CountDownLatch(1)

      engineClass.getMethod("chatCompletion", String::class.java, String::class.java)
        .invoke(runtimeEngine, buildChatCompletionRequest(modelId, prompt), requestId)

      val completed = responseLatch?.await(timeoutMs, TimeUnit.MILLISECONDS) == true
      val error = streamError
      if (!completed) {
        MlcGeneration(text = "", usedMlc = true, error = "MLC generation timed out.")
      } else if (error != null) {
        MlcGeneration(text = "", usedMlc = true, error = error)
      } else {
        MlcGeneration(text = responseBuilder.toString().trim(), usedMlc = true)
      }
    }.getOrElse { error ->
      MlcGeneration(text = "", usedMlc = false, error = error.message ?: error.javaClass.simpleName)
    }
  }

  private fun handleStreamMessage(message: String) {
    val json = runCatching { JSONObject(message) }.getOrNull() ?: return
    val requestId = json.optString("id", latestRequestId)
    if (requestId.isNotEmpty() && requestId != latestRequestId) return

    json.optJSONObject("error")?.let {
      streamError = it.optString("message", it.toString())
      responseLatch?.countDown()
      return
    }

    val choices = json.optJSONArray("choices") ?: return
    for (index in 0 until choices.length()) {
      val choice = choices.optJSONObject(index) ?: continue
      val delta = choice.optJSONObject("delta")
      val messageObject = choice.optJSONObject("message")
      val content = delta?.optString("content").orEmpty().ifEmpty {
        messageObject?.optString("content").orEmpty()
      }
      if (content.isNotEmpty()) responseBuilder.append(content)
      if (!choice.isNull("finish_reason") && choice.optString("finish_reason").isNotEmpty()) {
        responseLatch?.countDown()
      }
    }
  }

  private fun loadEngineConfig(context: Context, modelId: String): String? {
    val file = context.filesDir.resolve("mlc/$modelId/engine-config.json")
    if (file.exists()) return file.readText()

    return runCatching {
      context.assets.open("mlc/$modelId/engine-config.json").bufferedReader().use { it.readText() }
    }.getOrNull()
  }

  private fun buildChatCompletionRequest(modelId: String, prompt: String): String {
    val messages = JSONArray()
      .put(JSONObject().put("role", "system").put("content", "Return only valid JSON."))
      .put(JSONObject().put("role", "user").put("content", prompt))

    return JSONObject()
      .put("model", modelId)
      .put("messages", messages)
      .put("stream", true)
      .put("temperature", 0.0)
      .put("max_tokens", 256)
      .toString()
  }
}
