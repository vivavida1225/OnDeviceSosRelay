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
  ): WritableMap {
    Log.i(TAG, "analyze_start sampleRate=$sampleRate base64Length=${pcmBase64.length} sttLength=${sttTranscript.length}")
    val pcmBytes = runCatching { Base64.decode(pcmBase64, Base64.NO_WRAP) }.getOrDefault(ByteArray(0))
    val warmUpStatus = warmUp(context, warmedModelId)
    if (!warmUpStatus.getBoolean("ready")) {
      return failClosed(
        reason = warmUpStatus.getString("error") ?: "LiteRT-LM engine is not ready.",
        location = location,
        triggerSource = triggerSource,
        sttTranscript = sttTranscript,
      )
    }

    val prompt = buildPrompt(sampleRate, pcmBytes.size, location, triggerSource, sttTranscript)
    val wavBytes = WavPcm.pcm16Base64ToWavBytes(pcmBytes, sampleRate)
    Log.i(TAG, "analyze_payload_ready pcmBytes=${pcmBytes.size} wavBytes=${wavBytes.size} promptLength=${prompt.length}")

    return runCatching {
      Log.i(TAG, "create_conversation_enter")
      val response = engine!!.createConversation(
        ConversationConfig(
          systemInstruction = Contents.of(
            """
              You are analyzing Korean emergency audio for a Korean 112 police SMS report.
              The user is expected to speak Korean. Transcribe Korean speech in Korean.
              Keep recognized_dialogue and situation_summary clearly separate.
              recognized_dialogue is what was heard. situation_summary is a police-report summary inferred from it.
              Return only valid JSON. No markdown. No explanation.
            """.trimIndent(),
          ),
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

      parseModelJson(response, location, triggerSource, sttTranscript)
        ?: failClosed("LiteRT-LM response was not valid emergency JSON: $response", location, triggerSource, sttTranscript)
    }.getOrElse { error ->
      failClosed(error.message ?: error.javaClass.simpleName, location, triggerSource, sttTranscript)
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
    sampleRate: Int,
    pcmBytes: Int,
    location: LocationSnapshot?,
    triggerSource: String,
    sttTranscript: String,
  ): String {
    val locationText = location?.let { "${it.latitude}, ${it.longitude}" } ?: "unknown"
    val sttText = sttTranscript.ifBlank { "STT 인식 결과 없음" }
    return """
      첨부된 오디오는 한국어 사용자가 밤길 귀가 중 큰 소리 또는 갑작스러운 큰 움직임 트리거로 녹음된 소리입니다.
      이 트리거는 위급 상황 가능성을 알리는 신호일 뿐, 녹음이 실제 위급 상황임을 보장하지 않습니다.
      주어진 녹음 속 대화 내용, 비명, 반복적인 거부 표현, 위협 발언, 충격음, 유리창 깨지는 소리, 폭발음 같은 객관적 단서를 근거로 실제 위험 상황인지 신중하게 판단하세요.
      위험 단서가 부족하거나 일반 대화/생활 소음/우발적인 큰 소리로 보이면 is_emergency를 false로 판단하세요.
      한국어 표현 중 "도와주세요", "살려주세요", "따라오지 마세요", "가까이 오지 마세요", "신고해 주세요" 같은 도움 요청 또는 거부 표현은 위험 단서로 고려하세요.
      가해자로 추정되는 사람이 "죽여버리겠다", "죽고 싶냐", "가만 안 둔다", "따라와", "입 다물어" 같은 협박성 발언을 하면 강한 위험 단서로 고려하세요.
      한국어 음성이 들리면 반드시 한국어로 전사하고, 신고 문자에 바로 쓸 수 있도록 한국어로 요약하세요.

      분석 컨텍스트:
      - trigger_source: $triggerSource
      - audio_format: WAV PCM16 mono
      - sample_rate_hz: $sampleRate
      - pcm_bytes_before_wav_header: $pcmBytes
      - location: $locationText
      - stt_transcript: $sttText

      당신에게는 두 가지 단서가 동시에 주어집니다:
      1. <stt_transcript>: 폰 내장 STT 엔진이 오디오에서 받아 적은 1차 텍스트
      2. <audio_input>: 실제 녹음된 10초 안팎의 오디오 파형, 톤, 비명, 배경 소음

      판정 지침:
      - STT 결과에 "죽겠다", "살려줘", "미쳤나 봐" 같은 자극적인 단어가 있더라도, 오디오의 톤이 웃고 있거나, 장난치거나, 친구 간의 일상적인 대화 또는 슬랭 톤이거나, 미디어 소리라면 절대로 is_emergency를 true로 주지 마세요.
      - STT 텍스트와 실제 오디오의 톤, 배경 소음, 긴급성이 서로 맞는지 반드시 교차 확인하세요.
      - STT가 비어 있거나 부정확해 보여도 실제 오디오에서 비명, 협박, 추격, 폭행 정황이 명확하면 오디오 단서를 우선 고려하세요.

      판단 기준:
      - 명확한 도움 요청, 비명, 협박, 폭행/추격/스토킹/성범죄/납치 정황, 위험한 충격음이 있으면 is_emergency를 true로 판단하세요.
      - 단순 생활 소음, 일반 대화, 웃음, 음악, 문 닫는 소리, 불명확한 음성, 긴급성이 낮은 말이면 false로 판단하세요.
      - 위험 단서가 애매하면 false로 판단하고, situation_summary에는 "위급 상황으로 판단할 객관적 단서가 부족합니다."라고 작성하세요.
      - recognized_dialogue에는 들린 한국어 발화 또는 주요 소리를 간결하게 적으세요.
      - 말이 알아들을 수 없으면 recognized_dialogue는 "음성 인식 불가"로 적으세요.
      - stt_transcript는 참고 단서일 뿐이며, recognized_dialogue와 다를 수 있습니다.
      - situation_summary에는 들린 말을 그대로 복사하지 마세요.
      - situation_summary는 한국 경찰 112 문자 신고에 넣을 수 있도록 사용자가 처한 상황을 추정해 한 문장으로 서술하세요.
      - 예: "따라오지 마세요"가 들리면 "사용자가 누군가에게 따라오지 말라고 반복적으로 말하고 있어 스토킹 또는 접근 위협 상황으로 보입니다."처럼 작성하세요.
      - 예: "도와주세요"가 들리면 "사용자가 도움을 요청하고 있어 신체적 위협 또는 긴급 구조가 필요한 상황으로 보입니다."처럼 작성하세요.
      - 예: "가까이 오지 마세요"가 들리면 "사용자가 상대에게 접근하지 말라고 말하고 있어 대면 위협 상황으로 보입니다."처럼 작성하세요.
      - 충분히 확실하지 않으면 단정하지 말고 "~으로 보입니다", "~가능성이 있습니다"처럼 표현하세요.

      아래 JSON만 반환하세요:
      {"is_emergency": boolean, "crime_type": string, "situation_summary": string, "recognized_dialogue": string}
    """.trimIndent()
  }

  private fun parseModelJson(
    response: String,
    location: LocationSnapshot?,
    triggerSource: String,
    sttTranscript: String,
  ): WritableMap? {
    val jsonText = response.substringAfter('{', "").substringBeforeLast('}', "")
    if (jsonText.isBlank()) return null
    val json = runCatching { JSONObject("{$jsonText}") }.getOrNull() ?: return null

    return Arguments.createMap().apply {
      putBoolean("is_emergency", json.optBoolean("is_emergency", false))
      putString("crime_type", json.optString("crime_type", "unknown"))
      putString("situation_summary", json.optString("situation_summary", "상황 요약 없음"))
      putString("recognized_dialogue", json.optString("recognized_dialogue", "음성 인식 불가"))
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

  private fun failClosed(
    reason: String,
    location: LocationSnapshot?,
    triggerSource: String,
    sttTranscript: String = "",
  ): WritableMap =
    Arguments.createMap().apply {
      putBoolean("is_emergency", false)
      putString("crime_type", "unknown")
      putString("situation_summary", "LiteRT-LM 분석을 완료하지 못했습니다: $reason")
      putString("recognized_dialogue", "analysis_failed")
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


