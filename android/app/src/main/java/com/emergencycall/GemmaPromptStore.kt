package com.emergencycall

import android.content.Context
import org.json.JSONObject

object GemmaPromptStore {
  const val MODE_CHILD = "child"
  const val MODE_ADULT = "adult"

  private const val PROMPT_ASSET_ADULT = "onguard_gemma_prompts_adult.json"
  private const val PROMPT_ASSET_CHILD = "onguard_gemma_prompts_child.json"
  private const val LEGACY_PROMPT_ASSET = "onguard_gemma_prompts.json"
  private const val PREFS_NAME = "onguard_ai_prefs"
  private const val LEGACY_PREF_KEY = "gemma_prompt_overrides"
  private const val PREF_KEY_ADULT = "gemma_prompt_overrides_adult"
  private const val PREF_KEY_CHILD = "gemma_prompt_overrides_child"

  private val adultFallbackTemplates = PromptTemplates(
    system = """
      You are the automated emergency judge for OnGuard AI, an on-device emergency detection system.
      Judge Korean audio for real emergency threats while minimizing false alarms.
      Return only one valid raw JSON object. No markdown, no backticks, no introductory text.
    """.trimIndent(),
    primary = """
      [Adult primary emergency audio analysis]
      Analyze the pre-trigger audio. No STT text is provided.
      trigger_source={{triggerSource}}, sample_rate_hz={{sampleRate}}, location={{locationText}}
      Return only JSON: {"is_emergency": boolean, "confidence": "low|medium|high", "crime_type": string, "situation_summary": string, "recognized_dialogue": string, "audio_summary": string, "decision_reason": string}
    """.trimIndent(),
    secondary = """
      [Adult secondary emergency audio analysis]
      Analyze the post-trigger audio using the primary context only as reference.
      previous_context={{previousContext}}, trigger_source={{triggerSource}}, sample_rate_hz={{sampleRate}}, location={{locationText}}
      Return only JSON: {"is_emergency": boolean, "confidence": "low|medium|high", "crime_type": string, "situation_summary": string, "recognized_dialogue": string, "audio_summary": string, "decision_reason": string}
    """.trimIndent(),
  )

  private val childFallbackTemplates = PromptTemplates(
    system = """
      You are the elite automated judge for OnGuard AI, an on-device child protection and abduction prevention system.
      Detect child luring, grooming, and kidnapping attempts in Korean audio. Calm and friendly tones can still be dangerous.
      Return only one valid raw JSON object. No markdown, no backticks, no introductory text.
    """.trimIndent(),
    primary = """
      [Child primary protection audio analysis]
      Analyze pre-trigger Korean audio for child luring, parent impersonation, reward-based luring, help-request luring, forced accompaniment, or vehicle boarding attempts.
      monitoring_mode=child, trigger_source={{triggerSource}}, sample_rate_hz={{sampleRate}}, location={{locationText}}
      Return only JSON: {"is_emergency": boolean, "confidence": "low|medium|high", "crime_type": string, "situation_summary": string, "recognized_dialogue": string, "audio_summary": string, "decision_reason": string}
    """.trimIndent(),
    secondary = """
      [Child secondary protection audio analysis]
      Analyze post-trigger Korean audio for newly confirmed child luring or abduction cues. Use primary context only as reference.
      previous_context={{previousContext}}, monitoring_mode=child, trigger_source={{triggerSource}}, sample_rate_hz={{sampleRate}}, location={{locationText}}
      Return only JSON: {"is_emergency": boolean, "confidence": "low|medium|high", "crime_type": string, "situation_summary": string, "recognized_dialogue": string, "audio_summary": string, "decision_reason": string}
    """.trimIndent(),
  )

  fun loadJson(context: Context, monitoringMode: String? = MODE_ADULT): String =
    templatesToJson(loadTemplates(context, monitoringMode)).toString()

  fun loadDefaultJson(context: Context, monitoringMode: String? = MODE_ADULT): String =
    templatesToJson(loadDefaultTemplates(context, monitoringMode)).toString()

  fun saveJson(context: Context, monitoringMode: String? = MODE_ADULT, promptsJson: String) {
    val mode = normalizeMode(monitoringMode)
    val parsed = parseTemplates(promptsJson)
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(prefKeyFor(mode), templatesToJson(parsed).toString())
      .apply()
  }

  fun reset(context: Context, monitoringMode: String? = MODE_ADULT) {
    val mode = normalizeMode(monitoringMode)
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(prefKeyFor(mode))
      .apply()
  }

  fun systemInstruction(context: Context, monitoringMode: String? = MODE_ADULT): String =
    loadTemplates(context, monitoringMode).system

  fun primaryPrompt(
    context: Context,
    monitoringMode: String? = MODE_ADULT,
    sampleRate: Int,
    locationText: String,
    triggerSource: String,
    customPromptText: String,
  ): String = applyTemplate(
    loadTemplates(context, monitoringMode).primary,
    mapOf(
      "sampleRate" to sampleRate.toString(),
      "locationText" to locationText,
      "triggerSource" to triggerSource,
      "previousContext" to "",
    ),
  )

  fun secondaryPrompt(
    context: Context,
    monitoringMode: String? = MODE_ADULT,
    sampleRate: Int,
    locationText: String,
    triggerSource: String,
    previousContext: String,
    customPromptText: String,
  ): String = applyTemplate(
    loadTemplates(context, monitoringMode).secondary,
    mapOf(
      "sampleRate" to sampleRate.toString(),
      "locationText" to locationText,
      "triggerSource" to triggerSource,
      "previousContext" to previousContext,
    ),
  )

  fun normalizeMode(mode: String?): String =
    if (mode == MODE_CHILD) MODE_CHILD else MODE_ADULT

  private fun loadTemplates(context: Context, monitoringMode: String?): PromptTemplates {
    val mode = normalizeMode(monitoringMode)
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val overrideJson = prefs.getString(prefKeyFor(mode), null)
      ?: if (mode == MODE_ADULT) prefs.getString(LEGACY_PREF_KEY, null) else null
    return if (overrideJson.isNullOrBlank()) {
      loadDefaultTemplates(context, mode)
    } else {
      runCatching { parseTemplates(overrideJson) }.getOrElse { loadDefaultTemplates(context, mode) }
    }
  }

  private fun loadDefaultTemplates(context: Context, monitoringMode: String?): PromptTemplates {
    val mode = normalizeMode(monitoringMode)
    return runCatching {
      context.assets.open(promptAssetFor(mode)).bufferedReader(Charsets.UTF_8).use { reader ->
        parseTemplates(reader.readText())
      }
    }.recoverCatching {
      if (mode == MODE_ADULT) {
        context.assets.open(LEGACY_PROMPT_ASSET).bufferedReader(Charsets.UTF_8).use { reader ->
          parseTemplates(reader.readText())
        }
      } else {
        throw it
      }
    }.getOrElse { fallbackTemplatesFor(mode) }
  }

  private fun parseTemplates(jsonText: String): PromptTemplates {
    val json = JSONObject(jsonText)
    val system = json.optString("system").trim()
    val primary = removeCustomPromptBlock(json.optString("primary")).trim()
    val secondary = removeCustomPromptBlock(json.optString("secondary")).trim()
    require(system.isNotBlank()) { "system prompt is blank" }
    require(primary.isNotBlank()) { "primary prompt is blank" }
    require(secondary.isNotBlank()) { "secondary prompt is blank" }
    return PromptTemplates(system, primary, secondary)
  }

  private fun removeCustomPromptBlock(prompt: String): String {
    val token = "{{customPromptText}}"
    val tokenIndex = prompt.indexOf(token)
    if (tokenIndex < 0) return prompt
    val blockStart = prompt.lastIndexOf("\n\n", startIndex = tokenIndex)
    val blockEnd = prompt.indexOf("\n\n", startIndex = tokenIndex)
    return if (blockStart >= 0 && blockEnd >= 0) {
      prompt.removeRange(blockStart, blockEnd)
    } else {
      prompt.replace(token, "")
    }
  }

  private fun promptAssetFor(mode: String): String =
    if (mode == MODE_CHILD) PROMPT_ASSET_CHILD else PROMPT_ASSET_ADULT

  private fun prefKeyFor(mode: String): String =
    if (mode == MODE_CHILD) PREF_KEY_CHILD else PREF_KEY_ADULT

  private fun fallbackTemplatesFor(mode: String): PromptTemplates =
    if (mode == MODE_CHILD) childFallbackTemplates else adultFallbackTemplates

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
