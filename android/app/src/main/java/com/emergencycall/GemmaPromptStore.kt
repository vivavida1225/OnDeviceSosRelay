package com.emergencycall

import android.content.Context
import org.json.JSONObject

object GemmaPromptStore {
  private const val PROMPT_ASSET = "onguard_gemma_prompts.json"
  private const val PREFS_NAME = "onguard_ai_prefs"
  private const val PREF_KEY = "gemma_prompt_overrides"

  private val fallbackTemplates = PromptTemplates(
    system = """
      You are the automated emergency judge for OnGuard AI, an on-device emergency detection system.
      Your objective is to minimize false alarms while accurately detecting real crimes and urgent threats in Korean audio.
      Judge strictly from the attached audio only: speech content, vocal tone, urgency, impact sounds, background context, and acoustic characteristics.
      If the audio is media playback, laughing, playing kids, casual street noise, ordinary conversation, or unclear noise, is_emergency MUST be false.
      Return only one valid raw JSON object. No markdown, no backticks, no introductory text, no explanation outside JSON.
      Transcribe Korean speech in Korean. Keep recognized_dialogue and situation_summary clearly separate.
    """.trimIndent(),
    primary = """
      [위급 상황 오디오 분석 지침 - 1차 추론]
      트리거 직전 최대 10초 오디오를 분석하십시오. STT 텍스트는 제공되지 않습니다.
      trigger_source={{triggerSource}}, sample_rate_hz={{sampleRate}}, location={{locationText}}
      사용자 개인화 지침: {{customPromptText}}
      JSON만 반환하십시오.
      {"is_emergency": boolean, "confidence": "low|medium|high", "crime_type": string, "situation_summary": string, "recognized_dialogue": string, "audio_summary": string, "decision_reason": string}
    """.trimIndent(),
    secondary = """
      [위급 상황 오디오 분석 지침 - 2차 심층 추론]
      트리거 이후 추가 7초 오디오를 분석하십시오. STT 텍스트는 제공되지 않습니다.
      1차 추론 히스토리: {{previousContext}}
      trigger_source={{triggerSource}}, sample_rate_hz={{sampleRate}}, location={{locationText}}
      사용자 개인화 지침: {{customPromptText}}
      JSON만 반환하십시오.
      {"is_emergency": boolean, "confidence": "low|medium|high", "crime_type": string, "situation_summary": string, "recognized_dialogue": string, "audio_summary": string, "decision_reason": string}
    """.trimIndent(),
  )

  fun loadJson(context: Context): String = templatesToJson(loadTemplates(context)).toString()

  fun loadDefaultJson(context: Context): String = templatesToJson(loadDefaultTemplates(context)).toString()

  fun saveJson(context: Context, promptsJson: String) {
    val parsed = parseTemplates(promptsJson)
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(PREF_KEY, templatesToJson(parsed).toString())
      .apply()
  }

  fun reset(context: Context) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(PREF_KEY)
      .apply()
  }

  fun systemInstruction(context: Context): String = loadTemplates(context).system

  fun primaryPrompt(
    context: Context,
    sampleRate: Int,
    locationText: String,
    triggerSource: String,
    customPromptText: String,
  ): String = applyTemplate(
    loadTemplates(context).primary,
    mapOf(
      "sampleRate" to sampleRate.toString(),
      "locationText" to locationText,
      "triggerSource" to triggerSource,
      "customPromptText" to customPromptText,
      "previousContext" to "",
    ),
  )

  fun secondaryPrompt(
    context: Context,
    sampleRate: Int,
    locationText: String,
    triggerSource: String,
    previousContext: String,
    customPromptText: String,
  ): String = applyTemplate(
    loadTemplates(context).secondary,
    mapOf(
      "sampleRate" to sampleRate.toString(),
      "locationText" to locationText,
      "triggerSource" to triggerSource,
      "customPromptText" to customPromptText,
      "previousContext" to previousContext,
    ),
  )

  private fun loadTemplates(context: Context): PromptTemplates {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val overrideJson = prefs.getString(PREF_KEY, null)
    return if (overrideJson.isNullOrBlank()) {
      loadDefaultTemplates(context)
    } else {
      runCatching { parseTemplates(overrideJson) }.getOrElse { loadDefaultTemplates(context) }
    }
  }

  private fun loadDefaultTemplates(context: Context): PromptTemplates =
    runCatching {
      context.assets.open(PROMPT_ASSET).bufferedReader(Charsets.UTF_8).use { reader ->
        parseTemplates(reader.readText())
      }
    }.getOrElse { fallbackTemplates }

  private fun parseTemplates(jsonText: String): PromptTemplates {
    val json = JSONObject(jsonText)
    val system = json.optString("system").trim()
    val primary = json.optString("primary").trim()
    val secondary = json.optString("secondary").trim()
    require(system.isNotBlank()) { "system prompt is blank" }
    require(primary.isNotBlank()) { "primary prompt is blank" }
    require(secondary.isNotBlank()) { "secondary prompt is blank" }
    return PromptTemplates(system, primary, secondary)
  }

  private fun templatesToJson(templates: PromptTemplates): JSONObject =
    JSONObject()
      .put("system", templates.system)
      .put("primary", templates.primary)
      .put("secondary", templates.secondary)

  private fun applyTemplate(template: String, values: Map<String, String>): String =
    values.entries.fold(template) { current, entry ->
      current.replace("{{${entry.key}}}", entry.value)
    }
}

data class PromptTemplates(
  val system: String,
  val primary: String,
  val secondary: String,
)
