package com.emergencycall

import android.content.Context
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import java.io.File

object SherpaOnnxWhisperSttAnalyzer {
  private const val ENGINE = "sherpa-onnx-whisper-tiny-int8"
  private const val MODEL_DIR = "models/sherpa-onnx-whisper-tiny"
  private const val ENCODER = "tiny-encoder.int8.onnx"
  private const val DECODER = "tiny-decoder.int8.onnx"
  private const val TOKENS = "tiny-tokens.txt"
  private const val TAG = "OnGuardSherpaStt"
  private var recognizer: OfflineRecognizer? = null
  private var recognizerKey: String? = null

  @Synchronized
  fun ensureModelDirectories(context: Context): List<String> = modelRoots(context).map { dir ->
    val created = runCatching { dir.mkdirs() }.getOrDefault(false)
    Log.i(TAG, "ensureModelDirectories path=${dir.absolutePath} exists=${dir.exists()} isDir=${dir.isDirectory} mkdirsResult=$created")
    dir.absolutePath
  }

  @Synchronized
  fun transcribe(context: Context, pcmBase64: String, sampleRate: Int): SttResult {
    val startedAt = SystemClock.elapsedRealtime()
    Log.i(TAG, "transcribe_start sampleRate=$sampleRate base64Length=${pcmBase64.length}")
    val modelFiles = findModelFiles(context)
      ?: return SttResult(
        transcript = "",
        engine = ENGINE,
        error = "Sherpa-ONNX Whisper 모델 파일을 찾을 수 없습니다. files/$MODEL_DIR 아래에 $ENCODER, $DECODER, $TOKENS 파일이 필요합니다.",
        elapsedMs = elapsedSince(startedAt),
      )

    Log.i(TAG, "transcribe_model_files encoder=${modelFiles.encoder} decoder=${modelFiles.decoder} tokens=${modelFiles.tokens}")
    val pcmBytes = runCatching { Base64.decode(pcmBase64, Base64.NO_WRAP) }.getOrDefault(ByteArray(0))
    if (pcmBytes.isEmpty()) {
      Log.i(TAG, "transcribe_empty_pcm")
      return SttResult("", ENGINE, "STT에 전달할 PCM 오디오가 비어 있습니다.", elapsedSince(startedAt))
    }

    return runCatching {
      Log.i(TAG, "recognizer_request_enter pcmBytes=${pcmBytes.size}")
      val recognizer = recognizerFor(context, modelFiles)
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
        SttResult(transcript, ENGINE, null, elapsedSince(startedAt))
      } finally {
        Log.i(TAG, "stream_release_enter")
        stream.release()
        Log.i(TAG, "stream_release_return")
      }
    }.getOrElse { error ->
      Log.e(TAG, "transcribe_failed ${error.javaClass.simpleName}: ${error.message}", error)
      SttResult(
        transcript = "",
        engine = ENGINE,
        error = error.message ?: error.javaClass.simpleName,
        elapsedMs = elapsedSince(startedAt),
      )
    }
  }

  @Synchronized
  private fun recognizerFor(context: Context, modelFiles: ModelFiles): OfflineRecognizer {
    val key = listOf(modelFiles.encoder, modelFiles.decoder, modelFiles.tokens).joinToString("|")
    Log.i(TAG, "recognizerFor keyChanged=${recognizerKey != key} cached=${recognizer != null}")
    if (recognizer != null && recognizerKey == key) {
      Log.i(TAG, "recognizerFor_return_cached")
      return recognizer!!
    }

    runCatching { recognizer?.release() }
    Log.i(TAG, "recognizer_config_create provider=cpu threads=2 language=ko")
    val config = OfflineRecognizerConfig(
      featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
      modelConfig = OfflineModelConfig(
        whisper = OfflineWhisperModelConfig(
          encoder = modelFiles.encoder,
          decoder = modelFiles.decoder,
          language = "ko",
          task = "transcribe",
          tailPaddings = 0,
        ),
        tokens = modelFiles.tokens,
        numThreads = 2,
        debug = false,
        provider = "cpu",
      ),
    )
    Log.i(TAG, "offline_recognizer_constructor_enter assetManager=null absolutePath=true")
    return OfflineRecognizer(null, config).also {
      Log.i(TAG, "offline_recognizer_constructor_return")
      recognizer = it
      recognizerKey = key
    }
  }

  private fun findModelFiles(context: Context): ModelFiles? {
    return modelRoots(context).mapNotNull { dir ->
      val mkdirsResult = runCatching { dir.mkdirs() }.getOrDefault(false)
      val encoder = File(dir, ENCODER)
      val decoder = File(dir, DECODER)
      val tokens = File(dir, TOKENS)
      Log.i(TAG, "model_dir_check path=${dir.absolutePath} exists=${dir.exists()} isDir=${dir.isDirectory} mkdirsResult=$mkdirsResult encoder=${encoder.isFile} decoder=${decoder.isFile} tokens=${tokens.isFile}")
      if (encoder.isFile && decoder.isFile && tokens.isFile) {
        ModelFiles(encoder.absolutePath, decoder.absolutePath, tokens.absolutePath)
      } else {
        null
      }
    }.firstOrNull()
  }

  private fun modelRoots(context: Context): List<File> = buildList {
    add(File(context.filesDir, MODEL_DIR))
    context.getExternalFilesDir(null)?.let { add(File(it, MODEL_DIR)) }
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
  val encoder: String,
  val decoder: String,
  val tokens: String,
)
data class SttResult(
  val transcript: String,
  val engine: String,
  val error: String?,
  val elapsedMs: Int,
)

