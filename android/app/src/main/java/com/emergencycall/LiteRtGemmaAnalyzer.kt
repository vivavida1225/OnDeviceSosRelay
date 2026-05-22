package com.emergencycall

import android.content.Context
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import org.json.JSONObject
import java.io.File

object LiteRtGemmaAnalyzer {
  private const val DEFAULT_MODEL_ID = "gemma-4-E4B-it"
  private const val DEFAULT_MODEL_FILE = "gemma-4-E4B-it.litertlm"
  private var warmedModelId: String = DEFAULT_MODEL_ID
  private var engine: Engine? = null
  private var engineModelPath: String? = null
  private const val TAG = "OnGuardGemma"

  @Synchronized
  fun warmUp(context: Context, modelId: String): WritableMap {
    warmedModelId = modelId.ifBlank { DEFAULT_MODEL_ID }
    val modelPath = findModelPath(context, warmedModelId)
    if (modelPath == null) {
      closeEngine()
      return statusMap(
        ready = false,
        mode = "litert_missing_model",
        error = "LiteRT-LM model file not found. Expected ${context.filesDir}/models/$DEFAULT_MODEL_FILE.",
      )
    }

    return runCatching {
      if (engine == null || engineModelPath != modelPath) {
        closeEngine()
        engine = Engine(
          EngineConfig(
            modelPath = modelPath,
            backend = Backend.GPU(),
            audioBackend = Backend.CPU(),
            cacheDir = context.cacheDir.path,
          ),
        ).also {
          Log.i(TAG, "engine_initialize_enter")
          it.initialize()
          Log.i(TAG, "engine_initialize_return")
        }
        engineModelPath = modelPath
      }
      Log.i(TAG, "warmUp_ready cached=${engineModelPath == modelPath}")
      statusMap(ready = true, mode = "litert-lm", error = null)
    }.getOrElse { error ->
      closeEngine()
      statusMap(
        ready = false,
        mode = "litert_error",
        error = error.message ?: error.javaClass.simpleName,
      )
    }
  }

  fun analyze(
    context: Context,
    pcmBase64: String,
    sampleRate: Int,
    location: LocationSnapshot?,
    triggerSource: String,
    sttTranscript: String,
    customPrompt: String = "",
    analysisPass: String = "primary",
    previousContext: String = "",
  ): WritableMap {
    Log.i(TAG, "analyze_start pass=$analysisPass sampleRate=$sampleRate base64Length=${pcmBase64.length} sttContextUsed=false")
    val pcmBytes = runCatching { Base64.decode(pcmBase64, Base64.NO_WRAP) }.getOrDefault(ByteArray(0))
    val warmUpStatus = warmUp(context, warmedModelId)
    if (!warmUpStatus.getBoolean("ready")) {
      return failClosed(
        reason = warmUpStatus.getString("error") ?: "LiteRT-LM engine is not ready.",
        location = location,
        triggerSource = triggerSource,
        sttTranscript = sttTranscript,
        analysisPass = analysisPass,
        previousContext = previousContext,
      )
    }

    val prompt = buildPrompt(context, sampleRate, location, triggerSource, sttTranscript, customPrompt, analysisPass, previousContext)
    val wavBytes = WavPcm.pcm16Base64ToWavBytes(pcmBytes, sampleRate)
    Log.i(TAG, "analyze_payload_ready pcmBytes=${pcmBytes.size} wavBytes=${wavBytes.size} promptLength=${prompt.length}")

    return runCatching {
      Log.i(TAG, "create_conversation_enter")
      val response = engine!!.createConversation(
        ConversationConfig(
          systemInstruction = Contents.of(GemmaPromptStore.systemInstruction(context)),
        ),
      ).use { conversation: Conversation ->
        Log.i(TAG, "send_message_enter")
        conversation.sendMessage(
          Contents.of(
            Content.AudioBytes(wavBytes),
            Content.Text(prompt),
          ),
        ).toString().also { Log.i(TAG, "send_message_return responseLength=${it.length}") }
      }

      parseModelJson(response, location, triggerSource, sttTranscript, analysisPass, previousContext)
        ?: failClosed("LiteRT-LM response was not valid emergency JSON: $response", location, triggerSource, sttTranscript, analysisPass, previousContext)
    }.getOrElse { error ->
      failClosed(error.message ?: error.javaClass.simpleName, location, triggerSource, sttTranscript, analysisPass, previousContext)
    }
  }

  fun locationFromReadableMap(input: ReadableMap?): LocationSnapshot? {
    val location = input?.getMap("location") ?: return null
    if (!location.hasKey("latitude") || !location.hasKey("longitude")) return null
    return LocationSnapshot(location.getDouble("latitude"), location.getDouble("longitude"))
  }

  @Synchronized
  private fun closeEngine() {
    runCatching { engine?.close() }
    engine = null
    engineModelPath = null
  }

  private fun findModelPath(context: Context, modelId: String): String? {
    val candidates = listOf(
      File(context.filesDir, "models/$modelId.litertlm"),
      File(context.filesDir, "models/$DEFAULT_MODEL_FILE"),
    )
    return candidates.firstOrNull { it.exists() && it.isFile }?.absolutePath
  }

  private fun buildPrompt(
    context: Context,
    sampleRate: Int,
    location: LocationSnapshot?,
    triggerSource: String,
    sttTranscript: String,
    customPrompt: String,
    analysisPass: String,
    previousContext: String,
  ): String {
    val locationText = location?.let { "${it.latitude}, ${it.longitude}" } ?: "unknown"
    val customPromptText = customPrompt.trim().ifBlank { "개인화 추가 지침 없음" }
    return if (analysisPass == "secondary") {
      GemmaPromptStore.secondaryPrompt(
        context = context,
        sampleRate = sampleRate,
        locationText = locationText,
        triggerSource = triggerSource,
        previousContext = previousContext,
        customPromptText = customPromptText,
      )
    } else {
      GemmaPromptStore.primaryPrompt(
        context = context,
        sampleRate = sampleRate,
        locationText = locationText,
        triggerSource = triggerSource,
        customPromptText = customPromptText,
      )
    }
  }

  private fun parseModelJson(
    response: String,
    location: LocationSnapshot?,
    triggerSource: String,
    sttTranscript: String,
    analysisPass: String,
    previousContext: String,
  ): WritableMap? {
    val jsonText = response.substringAfter('{', "").substringBeforeLast('}', "")
    if (jsonText.isBlank()) return null
    val json = runCatching { JSONObject("{$jsonText}") }.getOrNull() ?: return null

    return Arguments.createMap().apply {
      putBoolean("is_emergency", json.optBoolean("is_emergency", false))
      putString("crime_type", sanitizeModelField(json.optString("crime_type", "unknown")))
      putString("situation_summary", sanitizeModelField(json.optString("situation_summary", "상황 요약 없음")))
      putString("recognized_dialogue", sanitizeModelField(json.optString("recognized_dialogue", "음성 인식 불가")))
      putString("confidence", sanitizeModelField(json.optString("confidence", "low")))
      putString("audio_summary", sanitizeModelField(json.optString("audio_summary", "오디오 요약 없음")))
      putString("decision_reason", sanitizeModelField(json.optString("decision_reason", "판단 근거 없음")))
      putString("analysis_pass", analysisPass)
      putBoolean("stt_context_used", false)
      if (previousContext.isNotBlank()) putString("previous_primary_context", previousContext)
      putString("stt_transcript", sttTranscript)
      putString("model_id", warmedModelId)
      putString("analysis_mode", "litert-lm")
      putString("trigger_source", triggerSource)
      putString("raw_model_response", response.take(4000))
      location?.let {
        putMap("location", Arguments.createMap().apply {
          putDouble("latitude", it.latitude)
          putDouble("longitude", it.longitude)
        })
      }
    }
  }


  private fun sanitizeModelField(value: String): String {
    val sentinels = listOf(
      "[위급 상황 오디오 분석 지침 - 1차 추론]",
      "[위급 상황 오디오 분석 지침 - 2차 심층 추론]",
      "분석 컨텍스트:",
      "판정 기준:",
      "출력 규칙:",
      "출력 JSON 양식:",
      "오신고 방지",
      "사용자 개인화 지침:",
      "아래 JSON",
      "{\"is_emergency\"",
    )
    var cleaned = value.trim()
    sentinels.forEach { sentinel ->
      val index = cleaned.indexOf(sentinel)
      if (index > 0) {
        cleaned = cleaned.substring(0, index).trim()
      }
    }
    return cleaned.take(1200)
  }
  private fun failClosed(
    reason: String,
    location: LocationSnapshot?,
    triggerSource: String,
    sttTranscript: String = "",
    analysisPass: String = "primary",
    previousContext: String = "",
  ): WritableMap =
    Arguments.createMap().apply {
      putBoolean("is_emergency", false)
      putString("crime_type", "unknown")
      putString("situation_summary", "LiteRT-LM 분석을 완료하지 못했습니다: $reason")
      putString("recognized_dialogue", "analysis_failed")
      putString("confidence", "low")
      putString("audio_summary", "분석 실패")
      putString("decision_reason", "LiteRT-LM 분석 실패: $reason")
      putString("analysis_pass", analysisPass)
      putBoolean("stt_context_used", false)
      if (previousContext.isNotBlank()) putString("previous_primary_context", previousContext)
      putString("stt_transcript", sttTranscript)
      putString("model_id", warmedModelId)
      putString("analysis_mode", "litert-lm_unavailable")
      putString("trigger_source", triggerSource)
      putString("litert_error", reason)
      location?.let {
        putMap("location", Arguments.createMap().apply {
          putDouble("latitude", it.latitude)
          putDouble("longitude", it.longitude)
        })
      }
    }

  private fun statusMap(ready: Boolean, mode: String, error: String?): WritableMap =
    Arguments.createMap().apply {
      putBoolean("ready", ready)
      putString("model_id", warmedModelId)
      putString("mode", mode)
      error?.let { putString("error", it) }
    }
}


