package com.emergencycall

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Address
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.UiThreadUtil
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

class EmergencyNativeModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "EmergencyNative"

  private val preferences by lazy {
    reactContext.getSharedPreferences("onguard_ai_prefs", Context.MODE_PRIVATE)
  }
  private val mainHandler = Handler(Looper.getMainLooper())
  private var routeStatusLocationManager: LocationManager? = null
  private var routeStatusLocationListener: LocationListener? = null
  private var routeStatusSensorManager: SensorManager? = null
  private var routeStatusSensorListener: SensorEventListener? = null
  private var routeStatusLastLocation: Location? = null
  private var routeStatusHeading: Double? = null
  private var routeStatusLastHeadingEmitAt = 0L

  init {
    SherpaOnnxMoonshineSttAnalyzer.ensureModelDirectories(reactContext)
  }

  @ReactMethod
  fun startMonitoring(config: ReadableMap, promise: Promise) {
    SherpaOnnxMoonshineSttAnalyzer.ensureModelDirectories(reactContext)
    val intent = Intent(reactContext, EmergencyForegroundService::class.java).apply {
      action = EmergencyForegroundService.ACTION_START
      putExtra(
        EmergencyForegroundService.EXTRA_SENSOR_THRESHOLD,
        if (config.hasKey("sensorThreshold")) config.getDouble("sensorThreshold") else 28.0,
      )
      putExtra(
        EmergencyForegroundService.EXTRA_GYRO_THRESHOLD,
        if (config.hasKey("gyroThreshold")) config.getDouble("gyroThreshold") else 8.0,
      )
      putExtra(
        EmergencyForegroundService.EXTRA_AUDIO_RMS_THRESHOLD,
        if (config.hasKey("audioRmsThreshold")) config.getDouble("audioRmsThreshold") else 0.35,
      )
      putExtra(
        EmergencyForegroundService.EXTRA_PRE_TRIGGER_SECONDS,
        analysisWindowSeconds(config, "preTriggerSeconds", 10),
      )
      putExtra(
        EmergencyForegroundService.EXTRA_POST_TRIGGER_SECONDS,
        analysisWindowSeconds(config, "postTriggerSeconds", 7),
      )
      putExtra(
        EmergencyForegroundService.EXTRA_ROUTE_DEVIATION_DISTANCE_METERS,
        positiveInt(config, "routeDeviationDistanceMeters", 50),
      )
      putExtra(
        EmergencyForegroundService.EXTRA_ROUTE_DEVIATION_DURATION_SECONDS,
        positiveInt(config, "routeDeviationDurationSeconds", 20),
      )
      putExtra(
        EmergencyForegroundService.EXTRA_ROUTE_PATH_JSON,
        routePathJson(config),
      )
      putExtra(
        EmergencyForegroundService.EXTRA_MODEL_ID,
        config.getString("modelId") ?: "gemma-4-E4B-it",
      )
      putExtra(
        EmergencyForegroundService.EXTRA_STT_ENABLED,
        if (config.hasKey("sttEnabled")) config.getBoolean("sttEnabled") else false,
      )
      putExtra(
        EmergencyForegroundService.EXTRA_STT_ENGINE,
        if (config.hasKey("sttEngine")) config.getString("sttEngine") ?: SherpaOnnxMoonshineSttAnalyzer.ENGINE_OFF else SherpaOnnxMoonshineSttAnalyzer.ENGINE_OFF,
      )
      putExtra(
        EmergencyForegroundService.EXTRA_CUSTOM_PROMPT,
        if (config.hasKey("customPrompt")) config.getString("customPrompt") ?: "" else "",
      )
      putExtra(
        EmergencyForegroundService.EXTRA_MONITORING_MODE,
        GemmaPromptStore.normalizeMode(if (config.hasKey("monitoringMode")) config.getString("monitoringMode") else null),
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
  fun getCurrentLocation(promise: Promise) {
    if (!hasLocationPermission()) {
      promise.reject("LOCATION_DENIED", "Location permission is not granted.")
      return
    }

    val locationManager = reactContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val lastKnown = bestLastKnownLocation(locationManager)
    if (lastKnown != null) {
      promise.resolve(locationMap(lastKnown))
      return
    }

    val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
      .filter { provider -> runCatching { locationManager.isProviderEnabled(provider) }.getOrDefault(false) }
    if (providers.isEmpty()) {
      promise.reject("LOCATION_PROVIDER_DISABLED", "No location provider is enabled.")
      return
    }

    val resolved = booleanArrayOf(false)
    val handler = Handler(Looper.getMainLooper())
    val listener = object : LocationListener {
      override fun onLocationChanged(location: Location) {
        if (resolved[0]) return
        resolved[0] = true
        runCatching { locationManager.removeUpdates(this) }
        promise.resolve(locationMap(location))
      }

      @Deprecated("Deprecated in Android API")
      override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

      override fun onProviderEnabled(provider: String) = Unit

      override fun onProviderDisabled(provider: String) = Unit
    }

    handler.postDelayed({
      if (!resolved[0]) {
        resolved[0] = true
        runCatching { locationManager.removeUpdates(listener) }
        promise.reject("LOCATION_TIMEOUT", "Timed out while waiting for current location.")
      }
    }, 10_000L)

    providers.forEach { provider ->
      runCatching {
        locationManager.requestLocationUpdates(
          provider,
          0L,
          0f,
          listener,
          Looper.getMainLooper(),
        )
      }
    }
  }

  @ReactMethod
  fun getCurrentHeading(promise: Promise) {
    val sensorManager = reactContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    if (rotationSensor == null) {
      promise.reject("HEADING_UNAVAILABLE", "Rotation vector sensor is not available.")
      return
    }

    val resolved = booleanArrayOf(false)
    val handler = Handler(Looper.getMainLooper())
    lateinit var listener: SensorEventListener
    listener = object : SensorEventListener {
      override fun onSensorChanged(event: SensorEvent) {
        if (resolved[0]) return
        resolved[0] = true
        sensorManager.unregisterListener(this)
        val rotationMatrix = FloatArray(9)
        val orientation = FloatArray(3)
        SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
        SensorManager.getOrientation(rotationMatrix, orientation)
        var heading = Math.toDegrees(orientation[0].toDouble())
        if (heading < 0) {
          heading += 360.0
        }
        promise.resolve(
          Arguments.createMap().apply {
            putDouble("heading", heading)
          },
        )
      }

      override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }

    handler.postDelayed({
      if (!resolved[0]) {
        resolved[0] = true
        sensorManager.unregisterListener(listener)
        promise.reject("HEADING_TIMEOUT", "Timed out while waiting for current heading.")
      }
    }, 2_000L)

    sensorManager.registerListener(
      listener,
      rotationSensor,
      SensorManager.SENSOR_DELAY_UI,
      handler,
    )
  }

  @ReactMethod
  fun startRouteStatusUpdates(promise: Promise) {
    if (!hasLocationPermission()) {
      promise.reject("LOCATION_DENIED", "Location permission is not granted.")
      return
    }

    stopRouteStatusUpdatesInternal()

    val locationManager = reactContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
      .filter { provider -> runCatching { locationManager.isProviderEnabled(provider) }.getOrDefault(false) }
    if (providers.isEmpty()) {
      promise.reject("LOCATION_PROVIDER_DISABLED", "No location provider is enabled.")
      return
    }

    routeStatusLocationManager = locationManager
    routeStatusLastLocation = bestLastKnownLocation(locationManager)
    routeStatusLastLocation?.let { emitRouteStatusLocation(it) }

    val locationListener = object : LocationListener {
      override fun onLocationChanged(location: Location) {
        routeStatusLastLocation = location
        if (routeStatusHeading == null && location.hasBearing()) {
          routeStatusHeading = location.bearing.toDouble()
        }
        emitRouteStatusLocation(location)
      }

      @Deprecated("Deprecated in Android API")
      override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

      override fun onProviderEnabled(provider: String) = Unit

      override fun onProviderDisabled(provider: String) = Unit
    }
    routeStatusLocationListener = locationListener

    providers.forEach { provider ->
      runCatching {
        locationManager.requestLocationUpdates(
          provider,
          500L,
          0.5f,
          locationListener,
          Looper.getMainLooper(),
        )
      }
    }

    val sensorManager = reactContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    if (rotationSensor != null) {
      val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
          routeStatusHeading = headingFromRotationVector(event.values)
          val now = System.currentTimeMillis()
          if (now - routeStatusLastHeadingEmitAt >= 250L) {
            routeStatusLastHeadingEmitAt = now
            routeStatusLastLocation?.let { emitRouteStatusLocation(it) }
          }
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
      }
      routeStatusSensorManager = sensorManager
      routeStatusSensorListener = sensorListener
      sensorManager.registerListener(
        sensorListener,
        rotationSensor,
        SensorManager.SENSOR_DELAY_UI,
        mainHandler,
      )
    }

    promise.resolve(true)
  }

  @ReactMethod
  fun stopRouteStatusUpdates(promise: Promise) {
    stopRouteStatusUpdatesInternal()
    promise.resolve(true)
  }

  @ReactMethod
  fun startRouteCapture(start: ReadableMap, promise: Promise) {
    if (!hasLocationPermission()) {
      promise.reject("LOCATION_DENIED", "Location permission is not granted.")
      return
    }
    if (!start.hasKey("latitude") || !start.hasKey("longitude")) {
      promise.reject("ROUTE_CAPTURE_INVALID_START", "Start location is missing.")
      return
    }

    val intent = Intent(reactContext, RouteCaptureForegroundService::class.java).apply {
      action = RouteCaptureForegroundService.ACTION_START
      putExtra(RouteCaptureForegroundService.EXTRA_START_LATITUDE, start.getDouble("latitude"))
      putExtra(RouteCaptureForegroundService.EXTRA_START_LONGITUDE, start.getDouble("longitude"))
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      reactContext.startForegroundService(intent)
    } else {
      reactContext.startService(intent)
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun stopRouteCapture(promise: Promise) {
    val snapshot = RouteCaptureForegroundService.finishActiveCapture()
    if (snapshot == null) {
      promise.reject("ROUTE_CAPTURE_NOT_RUNNING", "Route capture service is not running.")
      return
    }
    promise.resolve(snapshot)
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
  fun geocodeAddress(address: String, promise: Promise) {
    val query = address.trim()
    if (query.isEmpty()) {
      promise.reject("GEOCODE_EMPTY", "Address is empty.")
      return
    }

    if (!Geocoder.isPresent()) {
      promise.reject("GEOCODER_UNAVAILABLE", "Android Geocoder is not available on this device.")
      return
    }

    val geocoder = Geocoder(reactContext, Locale.KOREA)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      geocoder.getFromLocationName(query, 5, object : Geocoder.GeocodeListener {
        override fun onGeocode(addresses: MutableList<Address>) {
          resolveGeocodeAddresses(query, addresses, promise)
        }

        override fun onError(errorMessage: String?) {
          rejectGeocode(promise, "GEOCODE_FAILED", errorMessage ?: "Failed to geocode address.")
        }
      })
      return
    }

    Thread {
      try {
        @Suppress("DEPRECATION")
        val addresses = geocoder.getFromLocationName(query, 5).orEmpty()
        resolveGeocodeAddresses(query, addresses, promise)
      } catch (error: Exception) {
        rejectGeocode(promise, "GEOCODE_FAILED", error.message ?: "Failed to geocode address.")
      }
    }.start()
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

  private fun analysisWindowSeconds(config: ReadableMap, key: String, fallback: Int): Int {
    if (!config.hasKey(key)) return fallback
    return runCatching { config.getDouble(key).toInt().coerceIn(1, 30) }.getOrDefault(fallback)
  }

  private fun positiveInt(config: ReadableMap, key: String, fallback: Int): Int {
    if (!config.hasKey(key)) return fallback
    return runCatching { config.getDouble(key).toInt().coerceAtLeast(1) }.getOrDefault(fallback)
  }

  private fun routePathJson(config: ReadableMap): String {
    if (!config.hasKey("routePath")) return "[]"
    val routePath = config.getArray("routePath") ?: return "[]"
    val json = JSONArray()
    for (index in 0 until routePath.size()) {
      val point = routePath.getMap(index) ?: continue
      if (!point.hasKey("latitude") || !point.hasKey("longitude")) continue
      json.put(
        JSONObject()
          .put("latitude", point.getDouble("latitude"))
          .put("longitude", point.getDouble("longitude")),
      )
    }
    return json.toString()
  }

  @ReactMethod
  fun loadAppSettings(promise: Promise) {
    promise.resolve(preferences.getString("app_settings", """{"sttEngine":"off","sirenEnabled":false,"customPrompt":"","sensorThreshold":28,"gyroThreshold":8,"audioRmsThreshold":0.35,"preTriggerSeconds":10,"postTriggerSeconds":7,"routeDeviationDistanceMeters":50,"routeDeviationDurationSeconds":20}"""))
  }

  @ReactMethod
  fun saveAppSettings(settingsJson: String, promise: Promise) {
    preferences.edit().putString("app_settings", settingsJson).apply()
    promise.resolve(true)
  }


  @ReactMethod
  fun loadGemmaPrompts(monitoringMode: String, promise: Promise) {
    promise.resolve(GemmaPromptStore.loadJson(reactContext, monitoringMode))
  }

  @ReactMethod
  fun saveGemmaPrompts(monitoringMode: String, promptsJson: String, promise: Promise) {
    runCatching {
      GemmaPromptStore.saveJson(reactContext, monitoringMode, promptsJson)
    }.onSuccess {
      promise.resolve(true)
    }.onFailure { error ->
      promise.reject("PROMPT_SAVE_FAILED", error.message ?: "Failed to save Gemma prompts.")
    }
  }

  @ReactMethod
  fun resetGemmaPrompts(monitoringMode: String, promise: Promise) {
    GemmaPromptStore.reset(reactContext, monitoringMode)
    promise.resolve(GemmaPromptStore.loadDefaultJson(reactContext, monitoringMode))
  }

  @ReactMethod
  fun loadAudioLogs(promise: Promise) {
    promise.resolve(AudioLogStore.load(reactContext))
  }

  @ReactMethod
  fun playAudioLog(id: String, promise: Promise) {
    promise.resolve(AudioLogStore.play(reactContext, id))
  }

  @ReactMethod
  fun stopAudioLog(promise: Promise) {
    promise.resolve(AudioLogStore.stop())
  }
  @ReactMethod
  fun sendEmergencySms(payload: ReadableMap, promise: Promise) {
    if (ContextCompat.checkSelfPermission(reactContext, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
      promise.reject("SEND_SMS_DENIED", "SEND_SMS permission is not granted.")
      return
    }

    val destination = payload.getString("destination")?.trim().orEmpty()
    if (destination.isEmpty()) {
      promise.reject("SMS_DESTINATION_EMPTY", "Emergency phone number is empty.")
      return
    }
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

  private fun hasLocationPermission(): Boolean =
    ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

  private fun bestLastKnownLocation(locationManager: LocationManager): Location? {
    val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    return providers
      .mapNotNull { provider -> runCatching { locationManager.getLastKnownLocation(provider) }.getOrNull() }
      .maxByOrNull { it.time }
  }

  private fun locationMap(location: Location) =
    Arguments.createMap().apply {
      putDouble("latitude", location.latitude)
      putDouble("longitude", location.longitude)
      if (location.hasAccuracy()) {
        putDouble("accuracy", location.accuracy.toDouble())
      }
      if (location.hasBearing()) {
        putDouble("heading", location.bearing.toDouble())
      }
      putDouble("timestamp", location.time.toDouble())
    }

  private fun stopRouteStatusUpdatesInternal() {
    routeStatusLocationListener?.let { listener ->
      runCatching { routeStatusLocationManager?.removeUpdates(listener) }
    }
    routeStatusSensorListener?.let { listener ->
      runCatching { routeStatusSensorManager?.unregisterListener(listener) }
    }
    routeStatusLocationManager = null
    routeStatusLocationListener = null
    routeStatusSensorManager = null
    routeStatusSensorListener = null
    routeStatusLastLocation = null
    routeStatusHeading = null
    routeStatusLastHeadingEmitAt = 0L
  }

  private fun emitRouteStatusLocation(location: Location) {
    val event = locationMap(location)
    routeStatusHeading?.let { heading ->
      event.putDouble("heading", heading)
    }
    EmergencyEventBus.emit("routeStatusLocation", event)
  }

  private fun headingFromRotationVector(values: FloatArray): Double {
    val rotationMatrix = FloatArray(9)
    val orientation = FloatArray(3)
    SensorManager.getRotationMatrixFromVector(rotationMatrix, values)
    SensorManager.getOrientation(rotationMatrix, orientation)
    var heading = Math.toDegrees(orientation[0].toDouble())
    if (heading < 0) {
      heading += 360.0
    }
    return heading
  }

  private fun smsStatusMap(destination: String, parts: Int) =
    Arguments.createMap().apply {
      putString("status", "queued")
      putString("destination", destination)
      putInt("parts", parts)
    }

  private fun resolveGeocodeAddresses(query: String, addresses: List<Address>, promise: Promise) {
    val resultAddress = addresses.firstOrNull { it.hasLatitude() && it.hasLongitude() }
    if (resultAddress == null) {
      rejectGeocode(promise, "GEOCODE_EMPTY", "No coordinates returned for address.")
      return
    }

    val result = Arguments.createMap().apply {
      putDouble("latitude", resultAddress.latitude)
      putDouble("longitude", resultAddress.longitude)
      putString("address", resultAddress.getAddressLine(0) ?: query)
    }

    UiThreadUtil.runOnUiThread {
      promise.resolve(result)
    }
  }

  private fun rejectGeocode(promise: Promise, code: String, message: String) {
    UiThreadUtil.runOnUiThread {
      promise.reject(code, message)
    }
  }
}











