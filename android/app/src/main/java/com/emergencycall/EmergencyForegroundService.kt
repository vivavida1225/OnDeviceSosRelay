package com.emergencycall

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import kotlin.concurrent.thread
import kotlin.math.sqrt

class EmergencyForegroundService : Service(), SensorEventListener {
  private var sensorManager: SensorManager? = null
  private var locationManager: LocationManager? = null
  private var audioRecord: AudioRecord? = null
  private var audioThread: Thread? = null
  private var monitoring = false
  private var triggerLocked = false
  private var ringWriteIndex = 0
  private var sensorThreshold = 28.0
  private var audioRmsThreshold = 0.35
  private var sttEngine = SherpaOnnxMoonshineSttAnalyzer.ENGINE_OFF
  private var customPrompt = ""
  private var lastReadSize = 0
  private var lastReadRms = 0.0
  private var lastReadPeak = 0.0
  private var lastAudioReadAtMs = 0L
  private var totalReadSamples = 0L
  private val sampleRate = 16000
  private val ringBuffer = ShortArray(sampleRate * 10)
  private val ringLock = Object()

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> startMonitoring(intent)
      ACTION_STOP -> stopMonitoring()
      ACTION_CANCEL -> cancelPendingReport()
      ACTION_DEV_TRIGGER -> triggerEmergency("dev", DEV_TRIGGER_POST_CAPTURE_MS)
    }
    return START_STICKY
  }

  override fun onDestroy() {
    stopMonitoring()
    super.onDestroy()
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (!monitoring || triggerLocked) return
    val magnitude = sqrt(
      event.values.take(3).fold(0.0) { acc, value ->
        val component = value.toDouble()
        acc + (component * component)
      },
    )
    val isAccelerometerSpike = event.sensor.type == Sensor.TYPE_ACCELEROMETER && magnitude > sensorThreshold
    val isGyroSpike = event.sensor.type == Sensor.TYPE_GYROSCOPE && magnitude > 8.0
    if (isAccelerometerSpike || isGyroSpike) {
      triggerEmergency("sensor", 0)
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  private fun startMonitoring(intent: Intent) {
    sensorThreshold = intent.getDoubleExtra(EXTRA_SENSOR_THRESHOLD, 28.0)
    audioRmsThreshold = intent.getDoubleExtra(EXTRA_AUDIO_RMS_THRESHOLD, 0.35)
    sttEngine = intent.getStringExtra(EXTRA_STT_ENGINE)
      ?: if (intent.getBooleanExtra(EXTRA_STT_ENABLED, false)) SherpaOnnxMoonshineSttAnalyzer.ENGINE_MOONSHINE_TINY_KO else SherpaOnnxMoonshineSttAnalyzer.ENGINE_OFF
    customPrompt = intent.getStringExtra(EXTRA_CUSTOM_PROMPT) ?: ""
    Log.i(TAG, "startMonitoring: sttEngine=$sttEngine")
    val modelId = intent.getStringExtra(EXTRA_MODEL_ID) ?: "gemma-4-E4B-it"
    Log.i(TAG, "startMonitoring: warmUp requested modelId=$modelId monitoring=$monitoring")
    val warmUpResult = LiteRtGemmaAnalyzer.warmUp(this, modelId)
    Log.i(TAG, "startMonitoring: warmUp finished ready=${warmUpResult.getBoolean("ready")} mode=${warmUpResult.getString("mode")} error=${if (warmUpResult.hasKey("error")) warmUpResult.getString("error") else null}")

    if (monitoring) {
      triggerLocked = false
      val event = Arguments.createMap()
      event.putString("status", "monitoring")
      event.putString("reason", "already_monitoring_rearmed")
      event.putString("model_id", modelId)
      EmergencyEventBus.emit("serviceStatus", event)
      return
    }

    startForegroundCompat()
    monitoring = true
    triggerLocked = false
    startSensors()
    startAudioCapture()

    val event = Arguments.createMap()
    event.putString("status", "monitoring")
    event.putString("model_id", modelId)
    EmergencyEventBus.emit("serviceStatus", event)
  }

  private fun stopMonitoring() {
    monitoring = false
    triggerLocked = false
    sensorManager?.unregisterListener(this)
    audioRecord?.stopSafely()
    audioRecord?.release()
    audioRecord = null
    audioThread = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()

    val event = Arguments.createMap()
    event.putString("status", "idle")
    EmergencyEventBus.emit("serviceStatus", event)
  }

  private fun cancelPendingReport() {
    triggerLocked = false
    val event = Arguments.createMap()
    event.putString("status", "monitoring")
    EmergencyEventBus.emit("serviceStatus", event)
  }

  private fun startSensors() {
    val accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    val gyroscope = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    accelerometer?.let { sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
    gyroscope?.let { sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
  }

  private fun startAudioCapture() {
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      emitNativeError("RECORD_AUDIO_DENIED", "RECORD_AUDIO permission is not granted.")
      return
    }

    val minBuffer = AudioRecord.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val readBufferSize = maxOf(minBuffer, sampleRate / 2)
    audioRecord = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      readBufferSize,
    )
    audioRecord?.startRecording()
    audioThread = thread(name = "EmergencyAudioCapture") {
      val buffer = ShortArray(readBufferSize / 2)
      while (monitoring) {
        val read = audioRecord?.read(buffer, 0, buffer.size) ?: 0
        if (read > 0) {
          val currentRms = rms(buffer, read)
          val currentPeak = peak(buffer, read)
          lastReadSize = read
          lastReadRms = currentRms
          lastReadPeak = currentPeak
          lastAudioReadAtMs = SystemClock.elapsedRealtime()
          totalReadSamples += read
          appendAudio(buffer, read)
          if (!triggerLocked && currentRms > audioRmsThreshold) {
            triggerEmergency("audio", 0)
          }
        }
      }
    }
  }

  private fun appendAudio(buffer: ShortArray, read: Int) {
    synchronized(ringLock) {
      for (index in 0 until read) {
        ringBuffer[ringWriteIndex] = buffer[index]
        ringWriteIndex = (ringWriteIndex + 1) % ringBuffer.size
      }
    }
  }

  private fun triggerEmergency(source: String, postCaptureMs: Int) {
    if (!monitoring || triggerLocked) return
    triggerLocked = true

    val triggerEvent = Arguments.createMap()
    triggerEvent.putString("source", source)
    triggerEvent.putInt("post_capture_ms", SECONDARY_POST_CAPTURE_MS)
    EmergencyEventBus.emit("triggerDetected", triggerEvent)

    val status = Arguments.createMap()
    status.putString("status", "analyzing")
    EmergencyEventBus.emit("serviceStatus", status)

    thread(name = "EmergencyAnalysis") {
      val location = currentLocation()
      val primarySnapshot = readRingBufferSnapshot()
      saveAudioLog(source, PRIMARY_ANALYSIS_PASS, primarySnapshot)?.let {
        emitAudioLogSaved("1차 추론 오디오 로그 저장 완료", source, PRIMARY_ANALYSIS_PASS, it)
      }

      emitAnalysisDebug(
        "primary_audio_captured",
        Arguments.createMap().apply {
          putString("message", "1차 추론용 트리거 직전 음성 추출 완료")
          putString("trigger_source", source)
          putString("analysis_pass", PRIMARY_ANALYSIS_PASS)
          putString("analysis_audio_role", "primary_pre_trigger")
          putAudioSnapshotFields(primarySnapshot, location, 0)
        },
      )

      var postTriggerSnapshot: AudioSnapshot? = null
      val postCaptureThread = thread(name = "EmergencyPostCapture") {
        emitAnalysisDebug(
          "secondary_capture_started",
          Arguments.createMap().apply {
            putString("message", "2차 추론용 트리거 이후 7초 녹음 시작")
            putString("trigger_source", source)
            putString("analysis_pass", SECONDARY_ANALYSIS_PASS)
            putInt("post_capture_ms", SECONDARY_POST_CAPTURE_MS)
          },
        )
        SystemClock.sleep(SECONDARY_POST_CAPTURE_MS.toLong())
        postTriggerSnapshot = readRingBufferSnapshot((sampleRate * SECONDARY_POST_CAPTURE_MS) / 1000).also { snapshot ->
          emitAnalysisDebug(
            "secondary_audio_captured",
            Arguments.createMap().apply {
              putString("message", "2차 추론용 트리거 이후 음성 추출 완료")
              putString("trigger_source", source)
              putString("analysis_pass", SECONDARY_ANALYSIS_PASS)
              putString("analysis_audio_role", "secondary_post_trigger")
              putInt("post_capture_ms", SECONDARY_POST_CAPTURE_MS)
              putAudioSnapshotFields(snapshot, location, SECONDARY_POST_CAPTURE_MS)
            },
          )
        }
      }

      emitAnalysisDebug(
        "primary_ai_started",
        Arguments.createMap().apply {
          putString("message", "1차 추론 시작")
          putString("trigger_source", source)
          putString("analysis_pass", PRIMARY_ANALYSIS_PASS)
          putBoolean("stt_context_used", false)
        },
      )

      val primaryStartedAt = SystemClock.elapsedRealtime()
      val primaryResult = LiteRtGemmaAnalyzer.analyze(
        context = this,
        pcmBase64 = primarySnapshot.base64,
        sampleRate = sampleRate,
        location = location,
        triggerSource = source,
        sttTranscript = "",
        customPrompt = customPrompt,
        analysisPass = PRIMARY_ANALYSIS_PASS,
        previousContext = "",
      )
      val primaryEmergency = primaryResult.getBoolean("is_emergency")
      decorateAnalysisResult(primaryResult, PRIMARY_ANALYSIS_PASS, finalDecision = primaryEmergency, sttResult = null)
      val primaryElapsedMs = (SystemClock.elapsedRealtime() - primaryStartedAt).toInt()
      emitAiCompletedDebug("primary_ai_completed", "1차 추론 완료", source, PRIMARY_ANALYSIS_PASS, primaryResult, primaryElapsedMs, primaryEmergency)
      EmergencyEventBus.emit("analysisLog", cloneAnalysisResult(primaryResult))

      if (primaryEmergency) {
        EmergencyEventBus.emit("analysisResult", cloneAnalysisResult(primaryResult))
        return@thread
      }

      postCaptureThread.join()
      val secondarySnapshot = postTriggerSnapshot ?: readRingBufferSnapshot((sampleRate * SECONDARY_POST_CAPTURE_MS) / 1000)
      saveAudioLog(source, SECONDARY_ANALYSIS_PASS, secondarySnapshot)?.let {
        emitAudioLogSaved("2차 추론 오디오 로그 저장 완료", source, SECONDARY_ANALYSIS_PASS, it)
      }

      val sttResult = runExperimentalStt(source, secondarySnapshot)
      val primaryContext = summarizePrimaryContext(primaryResult)
      emitAnalysisDebug(
        "secondary_ai_started",
        Arguments.createMap().apply {
          putString("message", "2차 추론 시작")
          putString("trigger_source", source)
          putString("analysis_pass", SECONDARY_ANALYSIS_PASS)
          putString("previous_primary_context", primaryContext)
          putBoolean("stt_context_used", false)
          sttResult.error?.let { putString("stt_error", it) }
        },
      )

      val secondaryStartedAt = SystemClock.elapsedRealtime()
      val secondaryResult = LiteRtGemmaAnalyzer.analyze(
        context = this,
        pcmBase64 = secondarySnapshot.base64,
        sampleRate = sampleRate,
        location = location,
        triggerSource = source,
        sttTranscript = "",
        customPrompt = customPrompt,
        analysisPass = SECONDARY_ANALYSIS_PASS,
        previousContext = primaryContext,
      )
      decorateAnalysisResult(secondaryResult, SECONDARY_ANALYSIS_PASS, finalDecision = true, sttResult = sttResult)
      secondaryResult.putString("previous_primary_context", primaryContext)
      val secondaryElapsedMs = (SystemClock.elapsedRealtime() - secondaryStartedAt).toInt()
      val secondaryEmergency = secondaryResult.getBoolean("is_emergency")
      emitAiCompletedDebug("secondary_ai_completed", "2차 추론 완료", source, SECONDARY_ANALYSIS_PASS, secondaryResult, secondaryElapsedMs, true)
      EmergencyEventBus.emit("analysisLog", cloneAnalysisResult(secondaryResult))
      EmergencyEventBus.emit("analysisResult", cloneAnalysisResult(secondaryResult))

      if (!secondaryEmergency) {
        triggerLocked = false
        val monitoringStatus = Arguments.createMap()
        monitoringStatus.putString("status", "monitoring")
        monitoringStatus.putString("reason", "secondary_non_emergency_analysis")
        EmergencyEventBus.emit("serviceStatus", monitoringStatus)
      }
    }
  }

  private fun saveAudioLog(source: String, analysisPass: String, snapshot: AudioSnapshot): org.json.JSONObject? =
    runCatching {
      AudioLogStore.save(
        context = this,
        pcmBase64 = snapshot.fullBase64,
        sampleRate = sampleRate,
        triggerSource = source,
        sentStartOffsetMs = snapshot.sentStartOffsetMs,
        sentEndOffsetMs = snapshot.sentEndOffsetMs,
        maxRms = snapshot.maxRms,
        analysisPass = analysisPass,
      )
    }.getOrNull()

  private fun emitAudioLogSaved(message: String, source: String, analysisPass: String, audioLog: org.json.JSONObject) {
    emitAnalysisDebug(
      "audio_log_saved",
      Arguments.createMap().apply {
        putString("message", message)
        putString("audio_log_id", audioLog.optString("id"))
        putString("trigger_source", source)
        putString("analysis_pass", analysisPass)
        putDouble("duration_seconds", audioLog.optDouble("duration_seconds"))
        putDouble("max_rms", audioLog.optDouble("max_rms"))
      },
    )
  }

  private fun runExperimentalStt(source: String, snapshot: AudioSnapshot): SttResult {
    val sttEnabled = sttEngine != SherpaOnnxMoonshineSttAnalyzer.ENGINE_OFF
    emitAnalysisDebug(
      "stt_call_started",
      Arguments.createMap().apply {
        putString("message", if (sttEnabled) "실험용 STT 호출 시작" else "STT 비활성화로 호출 생략")
        putString("trigger_source", source)
        putString("analysis_pass", SECONDARY_ANALYSIS_PASS)
        putString("stt_engine", sttEngine)
        putBoolean("stt_enabled", sttEnabled)
        putBoolean("used_for_gemma_decision", false)
      },
    )

    val result = if (sttEnabled) {
      Log.i(TAG, "stt_transcribe_call_enter source=$source engine=$sttEngine postBytes=${snapshot.pcmBytes}")
      SherpaOnnxMoonshineSttAnalyzer.transcribe(this, snapshot.base64, sampleRate, sttEngine).also {
        Log.i(TAG, "stt_transcribe_call_return engine=$sttEngine transcriptLength=${it.transcript.length} error=${it.error}")
      }
    } else {
      Log.i(TAG, "stt_transcribe_skipped source=$source")
      SttResult(transcript = "", engine = SherpaOnnxMoonshineSttAnalyzer.ENGINE_OFF, error = null, elapsedMs = 0)
    }

    emitAnalysisDebug(
      if (sttEnabled) "stt_call_completed" else "stt_call_skipped",
      Arguments.createMap().apply {
        putString("message", if (sttEnabled) "실험용 STT 호출 완료" else "STT 비활성화로 호출 생략")
        putString("trigger_source", source)
        putString("analysis_pass", SECONDARY_ANALYSIS_PASS)
        putString("stt_engine", result.engine)
        putString("stt_transcript", result.transcript)
        putInt("stt_elapsed_ms", result.elapsedMs)
        putBoolean("stt_enabled", sttEnabled)
        putBoolean("used_for_gemma_decision", false)
        result.error?.let { putString("stt_error", it) }
      },
    )
    return result
  }

  private fun decorateAnalysisResult(
    result: WritableMap,
    analysisPass: String,
    finalDecision: Boolean,
    sttResult: SttResult?,
  ) {
    result.putString("analysis_pass", analysisPass)
    result.putBoolean("final_decision", finalDecision)
    result.putBoolean("stt_context_used", false)
    result.putString("stt_transcript", sttResult?.transcript ?: "")
    result.putString("stt_engine", sttResult?.engine ?: SherpaOnnxMoonshineSttAnalyzer.ENGINE_OFF)
    sttResult?.error?.let { result.putString("stt_error", it) }
  }

  private fun summarizePrimaryContext(result: WritableMap): String {
    val emergency = result.getBoolean("is_emergency")
    val confidence = if (result.hasKey("confidence")) result.getString("confidence") else "unknown"
    val crimeType = if (result.hasKey("crime_type")) result.getString("crime_type") else "unknown"
    val dialogue = if (result.hasKey("recognized_dialogue")) result.getString("recognized_dialogue") else ""
    val summary = if (result.hasKey("audio_summary")) result.getString("audio_summary") else ""
    val reason = if (result.hasKey("decision_reason")) result.getString("decision_reason") else ""
    return "1차 추론 결과: is_emergency=$emergency, confidence=$confidence, crime_type=$crimeType, recognized_dialogue=$dialogue, audio_summary=$summary, decision_reason=$reason"
  }

  private fun emitAiCompletedDebug(
    stage: String,
    message: String,
    source: String,
    analysisPass: String,
    result: WritableMap,
    elapsedMs: Int,
    finalDecision: Boolean,
  ) {
    emitAnalysisDebug(
      stage,
      Arguments.createMap().apply {
        putString("message", message)
        putString("trigger_source", source)
        putString("analysis_pass", analysisPass)
        putInt("elapsed_ms", elapsedMs)
        putBoolean("is_emergency", safeBoolean(result, "is_emergency", false))
        putBoolean("final_decision", finalDecision)
        putBoolean("stt_context_used", false)
        putString("crime_type", safeString(result, "crime_type"))
        putString("situation_summary", safeString(result, "situation_summary"))
        if (result.hasKey("confidence")) putString("confidence", safeString(result, "confidence"))
        if (result.hasKey("recognized_dialogue")) putString("recognized_dialogue", safeString(result, "recognized_dialogue"))
        if (result.hasKey("audio_summary")) putString("audio_summary", safeString(result, "audio_summary"))
        if (result.hasKey("decision_reason")) putString("decision_reason", safeString(result, "decision_reason"))
        if (result.hasKey("previous_primary_context")) putString("previous_primary_context", safeString(result, "previous_primary_context"))
        if (result.hasKey("stt_transcript")) putString("stt_transcript", safeString(result, "stt_transcript"))
        if (result.hasKey("stt_engine")) putString("stt_engine", safeString(result, "stt_engine"))
        if (result.hasKey("stt_error")) putString("stt_error", safeString(result, "stt_error"))
        if (result.hasKey("model_id")) putString("model_id", safeString(result, "model_id"))
        if (result.hasKey("analysis_mode")) putString("analysis_mode", safeString(result, "analysis_mode"))
        if (result.hasKey("litert_error")) putString("litert_error", safeString(result, "litert_error"))
        if (result.hasKey("raw_model_response")) putString("raw_model_response", safeString(result, "raw_model_response"))
      },
    )
  }


  private fun cloneAnalysisResult(result: WritableMap): WritableMap =
    Arguments.createMap().apply {
      putBoolean("is_emergency", safeBoolean(result, "is_emergency", false))
      putString("crime_type", safeString(result, "crime_type"))
      putString("situation_summary", safeString(result, "situation_summary"))
      putString("recognized_dialogue", safeString(result, "recognized_dialogue"))
      putString("confidence", safeString(result, "confidence"))
      putString("analysis_pass", safeString(result, "analysis_pass"))
      putBoolean("final_decision", safeBoolean(result, "final_decision", false))
      putString("audio_summary", safeString(result, "audio_summary"))
      putBoolean("stt_context_used", safeBoolean(result, "stt_context_used", false))
      putString("previous_primary_context", safeString(result, "previous_primary_context"))
      putString("decision_reason", safeString(result, "decision_reason"))
      putString("stt_transcript", safeString(result, "stt_transcript"))
      putString("stt_engine", safeString(result, "stt_engine"))
      putString("stt_error", safeString(result, "stt_error"))
      putString("model_id", safeString(result, "model_id"))
      putString("trigger_source", safeString(result, "trigger_source"))
      putString("analysis_mode", safeString(result, "analysis_mode"))
      putString("litert_error", safeString(result, "litert_error"))
      putString("raw_model_response", safeString(result, "raw_model_response"))
      if (result.hasKey("location")) {
        runCatching { result.getMap("location") }.getOrNull()?.let { location ->
          putMap("location", Arguments.createMap().apply {
            runCatching { putDouble("latitude", location.getDouble("latitude")) }
            runCatching { putDouble("longitude", location.getDouble("longitude")) }
          })
        }
      }
    }
  private fun safeString(map: WritableMap, key: String, fallback: String = ""): String =
    runCatching {
      if (map.hasKey(key)) map.getString(key) ?: fallback else fallback
    }.getOrDefault(fallback)

  private fun safeBoolean(map: WritableMap, key: String, fallback: Boolean): Boolean =
    runCatching {
      if (map.hasKey(key)) map.getBoolean(key) else fallback
    }.getOrDefault(fallback)
  private fun currentLocation(): LocationSnapshot? {
    if (
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
    ) {
      return null
    }

    val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    val location: Location? = providers
      .mapNotNull { provider -> runCatching { locationManager?.getLastKnownLocation(provider) }.getOrNull() }
      .maxByOrNull { it.time }
    return location?.let { LocationSnapshot(it.latitude, it.longitude) }
  }

  private fun readRingBufferSnapshot(maxSamples: Int = ringBuffer.size): AudioSnapshot {
    val cappedMaxSamples = maxOf(0, minOf(maxSamples, ringBuffer.size))
    val capturedSamples = minOf(totalReadSamples, cappedMaxSamples.toLong()).toInt()
    val snapshot = ShortArray(capturedSamples)
    val writeIndexSnapshot: Int
    synchronized(ringLock) {
      writeIndexSnapshot = ringWriteIndex
      val startIndex = (ringWriteIndex - capturedSamples + ringBuffer.size) % ringBuffer.size
      for (index in 0 until capturedSamples) {
        snapshot[index] = ringBuffer[(startIndex + index) % ringBuffer.size]
      }
    }
    val firstNonSilentIndex = nonSilentIndex(snapshot, first = true)
    val lastNonSilentIndex = nonSilentIndex(snapshot, first = false)
    val trimPaddingSamples = (sampleRate * VAD_TRIM_PADDING_MS) / 1000
    val trimStart =
      if (firstNonSilentIndex >= 0) maxOf(0, firstNonSilentIndex - trimPaddingSamples) else 0
    val trimEndExclusive =
      if (lastNonSilentIndex >= 0) minOf(snapshot.size, lastNonSilentIndex + trimPaddingSamples + 1) else snapshot.size
    val sentSamples = snapshot.copyOfRange(trimStart, trimEndExclusive)

    val fullBytes = ByteArray(snapshot.size * 2)
    snapshot.forEachIndexed { index, sample ->
      fullBytes[index * 2] = (sample.toInt() and 0xff).toByte()
      fullBytes[index * 2 + 1] = ((sample.toInt() shr 8) and 0xff).toByte()
    }

    val bytes = ByteArray(sentSamples.size * 2)
    sentSamples.forEachIndexed { index, sample ->
      bytes[index * 2] = (sample.toInt() and 0xff).toByte()
      bytes[index * 2 + 1] = ((sample.toInt() shr 8) and 0xff).toByte()
    }
    return AudioSnapshot(
      base64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
      fullBase64 = Base64.encodeToString(fullBytes, Base64.NO_WRAP),
      fullPcmBytes = fullBytes.size,
      sampleCount = capturedSamples,
      sentSampleCount = sentSamples.size,
      pcmBytes = bytes.size,
      sentStartOffsetMs = (trimStart * 1000) / sampleRate,
      sentEndOffsetMs = (trimEndExclusive * 1000) / sampleRate,
      ringWriteIndex = writeIndexSnapshot,
      nonZeroSamples = snapshot.count { it.toInt() != 0 },
      nonSilentSamples = snapshot.count { kotlin.math.abs(it.toInt()) >= AUDIO_NON_SILENT_THRESHOLD },
      rmsFullBuffer = rms(snapshot, snapshot.size),
      rmsLastOneSecond = rms(snapshot, minOf(sampleRate, snapshot.size), maxOf(0, snapshot.size - sampleRate)),
      peakFullBuffer = peak(snapshot, snapshot.size),
      maxRms = maxWindowRms(snapshot),
      firstNonSilentOffsetMs = nonSilentOffsetMs(firstNonSilentIndex),
      lastNonSilentOffsetMs = nonSilentOffsetMs(lastNonSilentIndex),
      lastAudioReadAgeMs = if (lastAudioReadAtMs == 0L) -1 else (SystemClock.elapsedRealtime() - lastAudioReadAtMs).toInt(),
    )
  }

  private fun combinePcmBase64(vararg clips: String): String {
    val decoded = clips.map { Base64.decode(it, Base64.NO_WRAP) }
    val totalSize = decoded.sumOf { it.size }
    val combined = ByteArray(totalSize)
    var offset = 0
    decoded.forEach { clip ->
      clip.copyInto(combined, offset)
      offset += clip.size
    }
    return Base64.encodeToString(combined, Base64.NO_WRAP)
  }
  private fun rms(buffer: ShortArray, read: Int, start: Int = 0): Double {
    if (read <= 0) return 0.0
    var sum = 0.0
    for (index in start until start + read) {
      val normalized = buffer[index] / 32768.0
      sum += normalized * normalized
    }
    return sqrt(sum / read)
  }

  private fun maxWindowRms(buffer: ShortArray): Double {
    if (buffer.isEmpty()) return 0.0
    val windowSize = minOf(sampleRate / 4, buffer.size)
    var maxRms = 0.0
    var start = 0
    while (start < buffer.size) {
      val read = minOf(windowSize, buffer.size - start)
      maxRms = maxOf(maxRms, rms(buffer, read, start))
      start += windowSize
    }
    return maxRms
  }

  private fun peak(buffer: ShortArray, read: Int): Double {
    if (read <= 0) return 0.0
    var peak = 0
    for (index in 0 until read) {
      peak = maxOf(peak, kotlin.math.abs(buffer[index].toInt()))
    }
    return peak / 32768.0
  }

  private fun nonSilentIndex(buffer: ShortArray, first: Boolean): Int {
    val indices = if (first) buffer.indices else buffer.indices.reversed()
    return indices.firstOrNull { kotlin.math.abs(buffer[it].toInt()) >= AUDIO_NON_SILENT_THRESHOLD } ?: -1
  }

  private fun nonSilentOffsetMs(index: Int): Int {
    if (index < 0) return -1
    return (index * 1000) / sampleRate
  }

  private fun startForegroundCompat() {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("안심 귀가 모드 실행 중")
      .setContentText("마이크, 센서, 위치를 이용해 위급 상황을 감시합니다.")
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Emergency monitoring",
      NotificationManager.IMPORTANCE_HIGH,
    )
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun WritableMap.putAudioSnapshotFields(
    audioSnapshot: AudioSnapshot,
    location: LocationSnapshot?,
    postCaptureMs: Int,
  ) {
    putInt("sample_rate", sampleRate)
    putInt("audio_seconds", ringBuffer.size / sampleRate)
    putDouble("captured_audio_seconds", audioSnapshot.sampleCount.toDouble() / sampleRate)
    putDouble("buffer_filled_ratio", audioSnapshot.sampleCount.toDouble() / ringBuffer.size)
    putInt("pcm_bytes", ringBuffer.size * 2)
    putInt("sent_pcm_bytes", audioSnapshot.pcmBytes)
    putDouble("sent_audio_seconds", audioSnapshot.sentSampleCount.toDouble() / sampleRate)
    putInt("sent_start_offset_ms", audioSnapshot.sentStartOffsetMs)
    putInt("sent_end_offset_ms", audioSnapshot.sentEndOffsetMs)
    putInt("base64_length", audioSnapshot.base64.length)
    putInt("recording_state", audioRecord?.recordingState ?: -1)
    putInt("audio_record_state", audioRecord?.state ?: -1)
    putInt("last_read_size", lastReadSize)
    putDouble("last_read_rms", lastReadRms)
    putDouble("last_read_peak", lastReadPeak)
    putInt("last_audio_read_age_ms", audioSnapshot.lastAudioReadAgeMs)
    putDouble("total_read_seconds", totalReadSamples.toDouble() / sampleRate)
    putInt("ring_write_index", audioSnapshot.ringWriteIndex)
    putInt("sent_sample_count", audioSnapshot.sentSampleCount)
    putInt("non_zero_samples", audioSnapshot.nonZeroSamples)
    putInt("non_silent_samples", audioSnapshot.nonSilentSamples)
    putInt("non_silent_threshold", AUDIO_NON_SILENT_THRESHOLD)
    putDouble("rms_full_buffer", audioSnapshot.rmsFullBuffer)
    putDouble("rms_last_1s", audioSnapshot.rmsLastOneSecond)
    putDouble("peak_full_buffer", audioSnapshot.peakFullBuffer)
    putInt("first_non_silent_offset_ms", audioSnapshot.firstNonSilentOffsetMs)
    putInt("last_non_silent_offset_ms", audioSnapshot.lastNonSilentOffsetMs)
    putInt("post_capture_ms", postCaptureMs)
    putBoolean("has_location", location != null)
    location?.let {
      putMap("location", Arguments.createMap().apply {
        putDouble("latitude", it.latitude)
        putDouble("longitude", it.longitude)
      })
    }
  }
  private fun emitNativeError(code: String, message: String) {
    val event = Arguments.createMap()
    event.putString("code", code)
    event.putString("message", message)
    EmergencyEventBus.emit("nativeError", event)
  }

  private fun emitAnalysisDebug(stage: String, details: WritableMap) {
    details.putString("stage", stage)
    details.putDouble("timestamp_ms", System.currentTimeMillis().toDouble())
    EmergencyEventBus.emit("analysisDebug", details)
  }

  private fun AudioRecord.stopSafely() {
    runCatching {
      if (recordingState == AudioRecord.RECORDSTATE_RECORDING) stop()
    }
  }

  companion object {
    const val ACTION_START = "com.emergencycall.START_MONITORING"
    const val ACTION_STOP = "com.emergencycall.STOP_MONITORING"
    const val ACTION_CANCEL = "com.emergencycall.CANCEL_PENDING_REPORT"
    const val ACTION_DEV_TRIGGER = "com.emergencycall.DEV_TRIGGER"
    const val EXTRA_SENSOR_THRESHOLD = "sensorThreshold"
    const val EXTRA_AUDIO_RMS_THRESHOLD = "audioRmsThreshold"
    const val EXTRA_MODEL_ID = "modelId"
    const val EXTRA_STT_ENABLED = "sttEnabled"
    const val EXTRA_STT_ENGINE = "sttEngine"
    const val EXTRA_CUSTOM_PROMPT = "customPrompt"
    private const val TAG = "OnGuardEmergency"
    private const val CHANNEL_ID = "emergency_monitoring"
    private const val NOTIFICATION_ID = 11201
    private const val AUDIO_NON_SILENT_THRESHOLD = 128
    private const val DEV_TRIGGER_POST_CAPTURE_MS = 0
    private const val SECONDARY_POST_CAPTURE_MS = 7000
    private const val PRIMARY_ANALYSIS_PASS = "primary"
    private const val SECONDARY_ANALYSIS_PASS = "secondary"
    private const val VAD_TRIM_PADDING_MS = 500
  }
}

private data class AudioSnapshot(
  val base64: String,
  val fullBase64: String,
  val fullPcmBytes: Int,
  val sampleCount: Int,
  val sentSampleCount: Int,
  val pcmBytes: Int,
  val sentStartOffsetMs: Int,
  val sentEndOffsetMs: Int,
  val ringWriteIndex: Int,
  val nonZeroSamples: Int,
  val nonSilentSamples: Int,
  val rmsFullBuffer: Double,
  val rmsLastOneSecond: Double,
  val peakFullBuffer: Double,
  val maxRms: Double,
  val firstNonSilentOffsetMs: Int,
  val lastNonSilentOffsetMs: Int,
  val lastAudioReadAgeMs: Int,
)
