package com.emergencycall

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import java.io.File

object SherpaOnnxMoonshineSttAnalyzer {
  const val ENGINE_OFF = "off"
  const val ENGINE_MOONSHINE_TINY_KO = "sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27"

  private const val TAG = "OnGuardSherpaStt"
  private const val MODEL_DIR = "models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27"
  private const val ENCODER = "encoder_model.ort"
  private const val DECODER = "decoder_model_merged.ort"
  private const val TOKENS = "tokens.txt"
  private const val MOONSHINE_MAX_AUDIO_SECONDS = 5

  private var recognizer: OfflineRecognizer? = null
  private var recognizerKey: String? = null

  @Synchronized
  fun ensureModelDirectories(context: Context): List<String> = modelRoots(context).map { dir ->
    val created = runCatching { dir.mkdirs() }.getOrDefault(false)
    Log.i(TAG, "ensureModelDirectories engine=$ENGINE_MOONSHINE_TINY_KO path=${dir.absolutePath} exists=${dir.exists()} isDir=${dir.isDirectory} mkdirsResult=$created")
    dir.absolutePath
  }

  @Synchronized
  fun transcribe(context: Context, pcmBase64: String, sampleRate: Int, engine: String): SttResult {
    val startedAt = SystemClock.elapsedRealtime()
    val activeEngine = if (engine == ENGINE_OFF) ENGINE_OFF else ENGINE_MOONSHINE_TINY_KO
    Log.i(TAG, "transcribe_start engine=$activeEngine sampleRate=$sampleRate base64Length=${pcmBase64.length}")

    if (activeEngine == ENGINE_OFF) {
      return SttResult("", ENGINE_OFF, null, elapsedSince(startedAt))
    }

    val modelFiles = findModelFiles(context)
      ?: return SttResult(
        transcript = "",
        engine = ENGINE_MOONSHINE_TINY_KO,
        error = "Moonshine tiny-ko 모델 파일을 찾을 수 없습니다. files/$MODEL_DIR 아래에 $ENCODER, $DECODER, $TOKENS 파일이 필요합니다.",
        elapsedMs = elapsedSince(startedAt),
      )

    Log.i(TAG, "transcribe_model_files engine=$ENGINE_MOONSHINE_TINY_KO files=${modelFiles.files.joinToString(",")}")
    val decodedPcmBytes = runCatching { Base64.decode(pcmBase64, Base64.NO_WRAP) }.getOrDefault(ByteArray(0))
    val pcmBytes = preparePcmForMoonshine(decodedPcmBytes, sampleRate)
    if (pcmBytes.isEmpty()) {
      Log.i(TAG, "transcribe_empty_pcm")
      return SttResult("", ENGINE_MOONSHINE_TINY_KO, "STT에 전달할 PCM 오디오가 비어 있습니다.", elapsedSince(startedAt))
    }

    return runCatching {
      Log.i(TAG, "recognizer_request_enter engine=$ENGINE_MOONSHINE_TINY_KO pcmBytes=${pcmBytes.size}")
      val recognizer = recognizerFor(modelFiles)
      Log.i(TAG, "recognizer_ready create_stream_enter")
      val stream = recognizer.createStream()
      try {
        val pcmFloat = pcm16leToFloatArray(pcmBytes)
        Log.i(TAG, "stream_accept_waveform_enter samples=${pcmFloat.size}")
        stream.acceptWaveform(pcmFloat, sampleRate)
        Log.i(TAG, "recognizer_decode_enter")
        recognizer.decode(stream)
        Log.i(TAG, "recognizer_get_result_enter")
        val transcript = recognizer.getResult(stream).text.trim()
        Log.i(TAG, "recognizer_get_result_return transcriptLength=${transcript.length}")
        SttResult(transcript, ENGINE_MOONSHINE_TINY_KO, null, elapsedSince(startedAt))
      } finally {
        Log.i(TAG, "stream_release_enter")
        stream.release()
        Log.i(TAG, "stream_release_return")
      }
    }.getOrElse { error ->
      Log.e(TAG, "transcribe_failed ${error.javaClass.simpleName}: ${error.message}", error)
      SttResult(
        transcript = "",
        engine = ENGINE_MOONSHINE_TINY_KO,
        error = error.message ?: error.javaClass.simpleName,
        elapsedMs = elapsedSince(startedAt),
      )
    }
  }

  @Synchronized
  private fun recognizerFor(modelFiles: ModelFiles): OfflineRecognizer {
    val key = modelFiles.files.joinToString("|") { it.absolutePath }
    Log.i(TAG, "recognizerFor keyChanged=${recognizerKey != key} cached=${recognizer != null}")
    if (recognizer != null && recognizerKey == key) {
      Log.i(TAG, "recognizerFor_return_cached")
      return recognizer!!
    }

    runCatching { recognizer?.release() }
    Log.i(TAG, "recognizer_config_create engine=$ENGINE_MOONSHINE_TINY_KO provider=cpu threads=2 language=ko")
    val config = OfflineRecognizerConfig(
      featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
      modelConfig = OfflineModelConfig(
        moonshine = OfflineMoonshineModelConfig(
          encoder = modelFiles.file(ENCODER),
          mergedDecoder = modelFiles.file(DECODER),
        ),
        tokens = modelFiles.file(TOKENS),
        numThreads = 2,
        debug = false,
        provider = "cpu",
      ),
    )
    Log.i(TAG, "offline_recognizer_constructor_enter assetManager=null absolutePath=true engine=$ENGINE_MOONSHINE_TINY_KO")
    return OfflineRecognizer(null, config).also {
      Log.i(TAG, "offline_recognizer_constructor_return")
      recognizer = it
      recognizerKey = key
    }
  }

  private fun findModelFiles(context: Context): ModelFiles? {
    return modelRoots(context).mapNotNull { dir ->
      val mkdirsResult = runCatching { dir.mkdirs() }.getOrDefault(false)
      val files = listOf(File(dir, ENCODER), File(dir, DECODER), File(dir, TOKENS))
      Log.i(
        TAG,
        "model_dir_check engine=$ENGINE_MOONSHINE_TINY_KO path=${dir.absolutePath} exists=${dir.exists()} isDir=${dir.isDirectory} mkdirsResult=$mkdirsResult $ENCODER=${files[0].isFile} $DECODER=${files[1].isFile} $TOKENS=${files[2].isFile}",
      )
      if (files.all { it.isFile }) ModelFiles(files) else null
    }.firstOrNull()
  }

  private fun modelRoots(context: Context): List<File> = buildList {
    add(File(context.filesDir, MODEL_DIR))
    context.getExternalFilesDir(null)?.let { add(File(it, MODEL_DIR)) }
  }

  private fun preparePcmForMoonshine(bytes: ByteArray, sampleRate: Int): ByteArray {
    val sampleCount = bytes.size / 2
    val maxSamples = sampleRate * MOONSHINE_MAX_AUDIO_SECONDS
    if (sampleCount <= maxSamples) {
      Log.i(TAG, "moonshine_window_keep samples=$sampleCount")
      return bytes
    }

    val startSample = loudestWindowStart(bytes, sampleCount, maxSamples, sampleRate)
    val endSample = startSample + maxSamples
    val selected = bytes.copyOfRange(startSample * 2, endSample * 2)
    Log.i(
      TAG,
      "moonshine_window_trim originalSamples=$sampleCount selectedStart=$startSample selectedSamples=$maxSamples selectedStartMs=${startSample * 1000 / sampleRate}",
    )
    return selected
  }

  private fun loudestWindowStart(bytes: ByteArray, sampleCount: Int, windowSamples: Int, sampleRate: Int): Int {
    val stepSamples = maxOf(sampleRate / 4, 1)
    var bestStart = 0
    var bestScore = Long.MIN_VALUE
    var start = 0
    while (start + windowSamples <= sampleCount) {
      val score = absoluteAmplitudeScore(bytes, start, windowSamples)
      if (score > bestScore) {
        bestScore = score
        bestStart = start
      }
      start += stepSamples
    }

    val finalStart = sampleCount - windowSamples
    val finalScore = absoluteAmplitudeScore(bytes, finalStart, windowSamples)
    if (finalScore > bestScore) {
      bestStart = finalStart
    }
    return bestStart
  }

  private fun absoluteAmplitudeScore(bytes: ByteArray, startSample: Int, sampleCount: Int): Long {
    var score = 0L
    var i = startSample
    val end = startSample + sampleCount
    while (i < end) {
      val byteIndex = i * 2
      val low = bytes[byteIndex].toInt() and 0xff
      val high = bytes[byteIndex + 1].toInt()
      val value = ((high shl 8) or low).toShort().toInt()
      score += kotlin.math.abs(value).toLong()
      i += 1
    }
    return score
  }

  private fun pcm16leToFloatArray(bytes: ByteArray): FloatArray {
    val samples = FloatArray(bytes.size / 2)
    for (i in samples.indices) {
      val low = bytes[i * 2].toInt() and 0xff
      val high = bytes[i * 2 + 1].toInt()
      val value = (high shl 8) or low
      samples[i] = value.toShort() / 32768.0f
    }
    return samples
  }

  private fun elapsedSince(startedAt: Long): Int = (SystemClock.elapsedRealtime() - startedAt).toInt()
}

private data class ModelFiles(
  val files: List<File>,
) {
  fun file(name: String): String = files.first { it.name == name }.absolutePath
}

data class SttResult(
  val transcript: String,
  val engine: String,
  val error: String?,
  val elapsedMs: Int,
)
