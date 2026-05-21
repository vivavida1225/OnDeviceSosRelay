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
  private var sttEnabled = true
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
    sttEnabled = intent.getBooleanExtra(EXTRA_STT_ENABLED, true)
    Log.i(TAG, "startMonitoring: sttEnabled=$sttEnabled")
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
    triggerEvent.putInt("post_capture_ms", postCaptureMs)
    EmergencyEventBus.emit("triggerDetected", triggerEvent)

    val status = Arguments.createMap()
    status.putString("status", "analyzing")
    EmergencyEventBus.emit("serviceStatus", status)

    thread(name = "EmergencyAnalysis") {
      if (postCaptureMs > 0) {
        emitAnalysisDebug(
          "post_capture_wait_started",
          Arguments.createMap().apply {
            putString("message", "트리거 후 추가 녹음 시작")
            putString("trigger_source", source)
            putInt("post_capture_ms", postCaptureMs)
          },
        )
        SystemClock.sleep(postCaptureMs.toLong())
      }

      val location = currentLocation()
      val audioSnapshot = readRingBufferSnapshot()

      emitAnalysisDebug(
        "audio_extracted",
        Arguments.createMap().apply {
          putString("message", "음성 추출 완료")
          putString("trigger_source", source)
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
        },
      )

      emitAnalysisDebug(
        "stt_call_started",
        Arguments.createMap().apply {
          putString("message", "STT 호출 시작")
          putString("trigger_source", source)
          putString("stt_engine", "sherpa-onnx-whisper-tiny-int8")
        },
      )

      val sttResult = if (sttEnabled) {
        Log.i(TAG, "stt_transcribe_call_enter source=$source")
        SherpaOnnxWhisperSttAnalyzer.transcribe(this, audioSnapshot.base64, sampleRate).also {
          Log.i(TAG, "stt_transcribe_call_return transcriptLength=${it.transcript.length} error=${it.error}")
        }
      } else {
        Log.i(TAG, "stt_transcribe_skipped source=$source")
        SttResult(transcript = "", engine = "disabled", error = null, elapsedMs = 0)
      }
      emitAnalysisDebug(
        if (sttEnabled) "stt_call_completed" else "stt_call_skipped",
        Arguments.createMap().apply {
          putString("message", if (sttEnabled) "STT 호출 완료" else "STT 비활성화로 호출 생략")
          putString("trigger_source", source)
          putString("stt_engine", sttResult.engine)
          putString("stt_transcript", sttResult.transcript)
          putInt("stt_elapsed_ms", sttResult.elapsedMs)
          putBoolean("stt_enabled", sttEnabled)
          sttResult.error?.let { putString("stt_error", it) }
        },
      )

      emitAnalysisDebug(
        "ai_call_started",
        Arguments.createMap().apply {
          putString("message", "AI 호출 시작")
          putString("trigger_source", source)
          putString("stt_transcript", sttResult.transcript)
          sttResult.error?.let { putString("stt_error", it) }
        },
      )

      val startedAt = SystemClock.elapsedRealtime()
      val result = LiteRtGemmaAnalyzer.analyze(this, audioSnapshot.base64, sampleRate, location, source, sttResult.transcript)
      result.putString("stt_transcript", sttResult.transcript)
      result.putString("stt_engine", sttResult.engine)
      sttResult.error?.let { result.putString("stt_error", it) }
      val elapsedMs = (SystemClock.elapsedRealtime() - startedAt).toInt()
      val isEmergency = result.getBoolean("is_emergency")

      emitAnalysisDebug(
        "ai_call_completed",
        Arguments.createMap().apply {
          putString("message", "AI 호출 완료")
          putInt("elapsed_ms", elapsedMs)
          putBoolean("is_emergency", isEmergency)
          putString("crime_type", result.getString("crime_type"))
          putString("situation_summary", result.getString("situation_summary"))
          if (result.hasKey("recognized_dialogue")) {
            putString("recognized_dialogue", result.getString("recognized_dialogue"))
          }
          if (result.hasKey("stt_transcript")) putString("stt_transcript", result.getString("stt_transcript"))
          if (result.hasKey("stt_engine")) putString("stt_engine", result.getString("stt_engine"))
          if (result.hasKey("stt_error")) putString("stt_error", result.getString("stt_error"))
          if (result.hasKey("model_id")) putString("model_id", result.getString("model_id"))
          if (result.hasKey("analysis_mode")) putString("analysis_mode", result.getString("analysis_mode"))
          if (result.hasKey("trigger_source")) putString("trigger_source", result.getString("trigger_source"))
          if (result.hasKey("litert_error")) putString("litert_error", result.getString("litert_error"))
          if (result.hasKey("raw_model_response")) putString("raw_model_response", result.getString("raw_model_response"))
        },
      )

      EmergencyEventBus.emit("analysisResult", result)
      if (!isEmergency) {
        triggerLocked = false
        val monitoringStatus = Arguments.createMap()
        monitoringStatus.putString("status", "monitoring")
        monitoringStatus.putString("reason", "non_emergency_analysis")
        EmergencyEventBus.emit("serviceStatus", monitoringStatus)
      }
    }
  }

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

  private fun readRingBufferSnapshot(): AudioSnapshot {
    val capturedSamples = minOf(totalReadSamples, ringBuffer.size.toLong()).toInt()
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

    val bytes = ByteArray(sentSamples.size * 2)
    sentSamples.forEachIndexed { index, sample ->
      bytes[index * 2] = (sample.toInt() and 0xff).toByte()
      bytes[index * 2 + 1] = ((sample.toInt() shr 8) and 0xff).toByte()
    }
    return AudioSnapshot(
      base64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
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
      firstNonSilentOffsetMs = nonSilentOffsetMs(firstNonSilentIndex),
      lastNonSilentOffsetMs = nonSilentOffsetMs(lastNonSilentIndex),
      lastAudioReadAgeMs = if (lastAudioReadAtMs == 0L) -1 else (SystemClock.elapsedRealtime() - lastAudioReadAtMs).toInt(),
    )
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
    private const val TAG = "OnGuardEmergency"
    private const val CHANNEL_ID = "emergency_monitoring"
    private const val NOTIFICATION_ID = 11201
    private const val AUDIO_NON_SILENT_THRESHOLD = 128
    private const val DEV_TRIGGER_POST_CAPTURE_MS = 3000
    private const val VAD_TRIM_PADDING_MS = 500
  }
}

private data class AudioSnapshot(
  val base64: String,
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
  val firstNonSilentOffsetMs: Int,
  val lastNonSilentOffsetMs: Int,
  val lastAudioReadAgeMs: Int,
)


