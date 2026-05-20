package com.emergencycall

import android.content.Context
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject

data class LocationSnapshot(val latitude: Double, val longitude: Double)

object MlcGemmaAnalyzer {
  private const val DEFAULT_MODEL_ID = "gemma-4-e4b"
  private var warmedModelId: String? = null
  private val runtime = MlcJsonRuntime()

  fun warmUp(context: Context, modelId: String): WritableMap {
    warmedModelId = modelId
    val result = runtime.warmUp(context, modelId)
    return Arguments.createMap().apply {
      putBoolean("ready", result.usedMlc)
      putString("model_id", modelId)
      putString("mode", if (result.usedMlc) "mlc" else "stub")
      result.error?.let { putString("error", it) }
    }
  }

  fun analyze(
    context: Context,
    pcmBase64: String,
    sampleRate: Int,
    location: LocationSnapshot?,
    triggerSource: String,
  ): WritableMap {
    val bytes = runCatching { Base64.decode(pcmBase64, Base64.NO_WRAP) }.getOrDefault(ByteArray(0))
    val modelId = warmedModelId ?: DEFAULT_MODEL_ID
    val prompt = buildEmergencyPrompt(bytes.size, sampleRate, location, triggerSource)
    val generation = runtime.generate(context, modelId, prompt)
    if (generation.usedMlc && generation.text.isNotBlank()) {
      parseModelJson(generation.text)?.let { return it }
    }

    val map = Arguments.createMap()
    val hasAudioContext = bytes.isNotEmpty() && sampleRate > 0

    map.putBoolean("is_emergency", hasAudioContext || triggerSource == "dev")
    map.putString(
      "crime_type",
      when (triggerSource) {
        "audio" -> "acoustic_distress"
        "sensor" -> "physical_distress"
        "dev" -> "manual_test"
        else -> "unknown"
      },
    )
    map.putString("situation_summary", buildSummary(triggerSource, location, warmedModelId))
    location?.let {
      val locationMap = Arguments.createMap()
      locationMap.putDouble("latitude", it.latitude)
      locationMap.putDouble("longitude", it.longitude)
      map.putMap("location", locationMap)
    }
    map.putString("model_id", modelId)
    map.putString("trigger_source", triggerSource)
    map.putString("analysis_mode", if (generation.usedMlc) "mlc_parse_fallback" else "stub")
    generation.error?.let { map.putString("mlc_error", it) }
    return map
  }

  fun locationFromReadableMap(input: ReadableMap?): LocationSnapshot? {
    val location = input?.getMap("location") ?: return null
    if (!location.hasKey("latitude") || !location.hasKey("longitude")) return null
    return LocationSnapshot(location.getDouble("latitude"), location.getDouble("longitude"))
  }

  private fun buildSummary(
    triggerSource: String,
    location: LocationSnapshot?,
    modelId: String?,
  ): String {
    val sourceText =
      when (triggerSource) {
        "audio" -> "날카로운 음향 이벤트"
        "sensor" -> "급격한 움직임"
        "dev" -> "개발자 테스트 트리거"
        else -> "위급 의심 신호"
      }
    val locationText =
      location?.let { "현재 좌표는 ${it.latitude}, ${it.longitude}입니다." } ?: "현재 좌표를 확보하지 못했습니다."
    return "온디바이스 AI(${modelId ?: DEFAULT_MODEL_ID})가 $sourceText 기반 위급 상황 가능성을 감지했습니다. $locationText"
  }

  private fun buildEmergencyPrompt(
    audioBytes: Int,
    sampleRate: Int,
    location: LocationSnapshot?,
    triggerSource: String,
  ): String {
    val locationText = location?.let { "${it.latitude}, ${it.longitude}" } ?: "unknown"
    return """
      You are an on-device emergency classifier.
      Context:
      - trigger_source: $triggerSource
      - audio_format: PCM16 mono
      - sample_rate_hz: $sampleRate
      - audio_bytes_captured: $audioBytes
      - location: $locationText

      MLC Android JSONFFI chat completion currently receives text prompts here.
      Classify the emergency risk from the trigger metadata conservatively.
      Return only this JSON shape:
      {"is_emergency": boolean, "crime_type": string, "situation_summary": string}
    """.trimIndent()
  }

  private fun parseModelJson(text: String): WritableMap? {
    val jsonText = text.substringAfter('{', "").substringBeforeLast('}', "")
    if (jsonText.isBlank()) return null
    val json = runCatching { JSONObject("{$jsonText}") }.getOrNull() ?: return null

    return Arguments.createMap().apply {
      putBoolean("is_emergency", json.optBoolean("is_emergency", false))
      putString("crime_type", json.optString("crime_type", "unknown"))
      putString("situation_summary", json.optString("situation_summary", "상황 요약 없음"))
      putString("model_id", warmedModelId ?: DEFAULT_MODEL_ID)
      putString("analysis_mode", "mlc")
    }
  }
}
