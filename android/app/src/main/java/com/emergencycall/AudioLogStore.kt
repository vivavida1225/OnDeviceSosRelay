package com.emergencycall

import android.content.Context
import android.media.MediaPlayer
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object AudioLogStore {
  private const val PREF_NAME = "onguard_ai_prefs"
  private const val PREF_KEY = "audio_logs"
  private const val AUDIO_DIR = "audio_logs"
  private const val MAX_LOGS = 10
  private var mediaPlayer: MediaPlayer? = null

  @Synchronized
  fun save(
    context: Context,
    pcmBase64: String,
    sampleRate: Int,
    triggerSource: String,
    sentStartOffsetMs: Int,
    sentEndOffsetMs: Int,
    maxRms: Double,
    analysisPass: String,
  ): JSONObject {
    val pcmBytes = Base64.decode(pcmBase64, Base64.NO_WRAP)
    val wavBytes = WavPcm.pcm16Base64ToWavBytes(pcmBytes, sampleRate)
    val now = System.currentTimeMillis()
    val id = "audio_$now"
    val dir = File(context.filesDir, AUDIO_DIR).apply { mkdirs() }
    val file = File(dir, "$id.wav")
    file.writeBytes(wavBytes)

    val durationSeconds = if (sampleRate > 0) pcmBytes.size.toDouble() / 2.0 / sampleRate else 0.0
    val item = JSONObject().apply {
      put("id", id)
      put("createdAt", now)
      put("trigger_source", triggerSource)
      put("analysis_pass", analysisPass)
      put("duration_seconds", durationSeconds)
      put("sample_rate", sampleRate)
      put("file_name", file.name)
      put("max_rms", maxRms)
      put("sent_start_offset_ms", sentStartOffsetMs)
      put("sent_end_offset_ms", sentEndOffsetMs)
    }

    val next = mutableListOf(item)
    val existing = readArray(context)
    for (index in 0 until existing.length()) {
      next.add(existing.getJSONObject(index))
    }

    val trimmed = next.take(MAX_LOGS)
    next.drop(MAX_LOGS).forEach { old ->
      runCatching { File(dir, old.optString("file_name")).delete() }
    }

    writeArray(context, JSONArray(trimmed))
    return item
  }

  @Synchronized
  fun load(context: Context): String = readArray(context).toString()

  @Synchronized
  fun play(context: Context, id: String): Boolean {
    val entry = find(context, id) ?: return false
    val file = File(File(context.filesDir, AUDIO_DIR), entry.optString("file_name"))
    if (!file.exists()) return false

    stop()
    mediaPlayer = MediaPlayer.create(context, Uri.fromFile(file))?.apply {
      setOnCompletionListener { stop() }
      start()
    }
    return mediaPlayer != null
  }

  @Synchronized
  fun stop(): Boolean {
    runCatching {
      mediaPlayer?.stop()
      mediaPlayer?.release()
    }
    mediaPlayer = null
    return true
  }

  private fun find(context: Context, id: String): JSONObject? {
    val logs = readArray(context)
    for (index in 0 until logs.length()) {
      val item = logs.getJSONObject(index)
      if (item.optString("id") == id) return item
    }
    return null
  }

  private fun readArray(context: Context): JSONArray {
    val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
    return runCatching { JSONArray(prefs.getString(PREF_KEY, "[]") ?: "[]") }.getOrDefault(JSONArray())
  }

  private fun writeArray(context: Context, array: JSONArray) {
    context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(PREF_KEY, array.toString())
      .apply()
  }
}





