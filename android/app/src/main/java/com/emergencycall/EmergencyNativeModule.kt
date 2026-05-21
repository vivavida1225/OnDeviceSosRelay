package com.emergencycall

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class EmergencyNativeModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "EmergencyNative"

  private val preferences by lazy {
    reactContext.getSharedPreferences("onguard_ai_prefs", Context.MODE_PRIVATE)
  }

  init {
    SherpaOnnxWhisperSttAnalyzer.ensureModelDirectories(reactContext)
  }

  @ReactMethod
  fun startMonitoring(config: ReadableMap, promise: Promise) {
    SherpaOnnxWhisperSttAnalyzer.ensureModelDirectories(reactContext)
    val intent = Intent(reactContext, EmergencyForegroundService::class.java).apply {
      action = EmergencyForegroundService.ACTION_START
      putExtra(
        EmergencyForegroundService.EXTRA_SENSOR_THRESHOLD,
        if (config.hasKey("sensorThreshold")) config.getDouble("sensorThreshold") else 28.0,
      )
      putExtra(
        EmergencyForegroundService.EXTRA_AUDIO_RMS_THRESHOLD,
        if (config.hasKey("audioRmsThreshold")) config.getDouble("audioRmsThreshold") else 0.35,
      )
      putExtra(
        EmergencyForegroundService.EXTRA_MODEL_ID,
        config.getString("modelId") ?: "gemma-4-E4B-it",
      )
      putExtra(
        EmergencyForegroundService.EXTRA_STT_ENABLED,
        if (config.hasKey("sttEnabled")) config.getBoolean("sttEnabled") else true,
      )
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      reactContext.startForegroundService(intent)
    } else {
      reactContext.startService(intent)
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun stopMonitoring(promise: Promise) {
    reactContext.startService(Intent(reactContext, EmergencyForegroundService::class.java).apply {
      action = EmergencyForegroundService.ACTION_STOP
    })
    promise.resolve(true)
  }

  @ReactMethod
  fun cancelPendingReport(promise: Promise) {
    reactContext.startService(Intent(reactContext, EmergencyForegroundService::class.java).apply {
      action = EmergencyForegroundService.ACTION_CANCEL
    })
    promise.resolve(true)
  }

  @ReactMethod
  fun triggerDevEmergency(promise: Promise) {
    reactContext.startService(Intent(reactContext, EmergencyForegroundService::class.java).apply {
      action = EmergencyForegroundService.ACTION_DEV_TRIGGER
    })
    promise.resolve(true)
  }

  @ReactMethod
  fun startSiren(durationMs: Double, promise: Promise) {
    SirenAlarm.start(durationMs.toInt())
    promise.resolve(true)
  }

  @ReactMethod
  fun stopSiren(promise: Promise) {
    SirenAlarm.stop()
    promise.resolve(true)
  }

  @ReactMethod
  fun loadAnalysisLogs(promise: Promise) {
    promise.resolve(preferences.getString("analysis_logs", "[]"))
  }

  @ReactMethod
  fun saveAnalysisLogs(logsJson: String, promise: Promise) {
    preferences.edit().putString("analysis_logs", logsJson).apply()
    promise.resolve(true)
  }

  @ReactMethod
  fun sendEmergencySms(payload: ReadableMap, promise: Promise) {
    if (ContextCompat.checkSelfPermission(reactContext, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
      promise.reject("SEND_SMS_DENIED", "SEND_SMS permission is not granted.")
      return
    }

    val destination = payload.getString("destination") ?: "01082014333"
    val summary = payload.getString("situation_summary") ?: "위급 상황이 감지되었습니다."
    val location = payload.getMap("location")
    val mapLink =
      if (location != null && location.hasKey("latitude") && location.hasKey("longitude")) {
        val lat = location.getDouble("latitude")
        val lng = location.getDouble("longitude")
        "https://maps.google.com/?q=$lat,$lng"
      } else {
        "위치 정보 없음"
      }
    val message = "[안심귀가 자동신고]\n$summary\n위치: $mapLink"

    try {
      val smsManager =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          reactContext.getSystemService(SmsManager::class.java)
        } else {
          @Suppress("DEPRECATION")
          SmsManager.getDefault()
        }
      val parts = smsManager.divideMessage(message)
      if (parts.size > 1) {
        smsManager.sendMultipartTextMessage(destination, null, parts, null, null)
      } else {
        smsManager.sendTextMessage(destination, null, message, null, null)
      }

      EmergencyEventBus.emit("smsStatus", smsStatusMap(destination, parts.size))
      promise.resolve(smsStatusMap(destination, parts.size))
    } catch (error: Exception) {
      val event = Arguments.createMap()
      event.putString("code", "SMS_SEND_FAILED")
      event.putString("message", error.message ?: "Failed to send emergency SMS.")
      EmergencyEventBus.emit("nativeError", event)
      promise.reject("SMS_SEND_FAILED", error)
    }
  }

  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Double) = Unit

  private fun smsStatusMap(destination: String, parts: Int) =
    Arguments.createMap().apply {
      putString("status", "queued")
      putString("destination", destination)
      putInt("parts", parts)
    }
}


