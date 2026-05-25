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
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

class RouteCaptureForegroundService : Service(), LocationListener {
  private var locationManager: LocationManager? = null
  private var capturing = false
  private var finished = false
  private var startPoint: CapturedRoutePoint? = null
  private var lastLocation: Location? = null
  private var lastSavedAtMs = 0L
  private var lastSnapshot: WritableMap? = null
  private val waypoints = mutableListOf<CapturedRoutePoint>()

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    activeService = this
    locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> startCapture(intent)
      ACTION_STOP -> finishCapture()
    }
    return START_STICKY
  }

  override fun onDestroy() {
    finishCapture()
    if (activeService === this) {
      activeService = null
    }
    super.onDestroy()
  }

  override fun onLocationChanged(location: Location) {
    if (!capturing) return
    lastLocation = location
    if (!isUsableLocation(location)) {
      emitUpdate("ignored_low_accuracy")
      return
    }

    val now = System.currentTimeMillis()
    if (lastSavedAtMs > 0L && now - lastSavedAtMs < CAPTURE_INTERVAL_MS) {
      return
    }

    val previous = waypoints.lastOrNull()
    if (previous != null && distanceMeters(previous, location) < MIN_WAYPOINT_DISTANCE_METERS) {
      return
    }

    waypoints.add(location.toCapturedPoint())
    lastSavedAtMs = now
    emitUpdate("waypoint_added")
  }

  @Deprecated("Deprecated in Android API")
  override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

  override fun onProviderEnabled(provider: String) = Unit

  override fun onProviderDisabled(provider: String) = Unit

  private fun startCapture(intent: Intent) {
    if (!hasLocationPermission()) {
      emitNativeError("ROUTE_CAPTURE_LOCATION_DENIED", "Location permission is not granted.")
      stopSelf()
      return
    }

    startForegroundCompat()
    val start = CapturedRoutePoint(
      latitude = intent.getDoubleExtra(EXTRA_START_LATITUDE, 0.0),
      longitude = intent.getDoubleExtra(EXTRA_START_LONGITUDE, 0.0),
    )
    startPoint = start
    waypoints.clear()
    waypoints.add(start)
    lastSavedAtMs = System.currentTimeMillis()
    finished = false
    lastSnapshot = null
    capturing = true

    requestLocationUpdates()
    emitUpdate("capture_started")
  }

  private fun requestLocationUpdates() {
    val manager = locationManager ?: return
    val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    providers.forEach { provider ->
      runCatching {
        if (manager.isProviderEnabled(provider)) {
          manager.requestLocationUpdates(
            provider,
            CAPTURE_INTERVAL_MS,
            0f,
            this,
            Looper.getMainLooper(),
          )
        }
      }
    }
  }

  private fun finishCapture(): WritableMap {
    if (finished) {
      return lastSnapshot ?: snapshotMap("capture_finished")
    }
    finished = true
    capturing = false
    runCatching { locationManager?.removeUpdates(this) }
    val endPoint = lastLocation
      ?.takeIf { isUsableLocation(it) }
      ?.toCapturedPoint()
      ?: waypoints.lastOrNull()
      ?: startPoint
      ?: CapturedRoutePoint(0.0, 0.0)

    if (waypoints.isEmpty()) {
      waypoints.add(endPoint)
    } else if (waypoints.last().latitude != endPoint.latitude || waypoints.last().longitude != endPoint.longitude) {
      waypoints.add(endPoint)
    }

    val snapshot = snapshotMap("capture_finished", endPoint)
    lastSnapshot = snapshot
    emitUpdate("capture_finished", endPoint)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    return snapshot
  }

  private fun emitUpdate(status: String, endPoint: CapturedRoutePoint? = null) {
    EmergencyEventBus.emit("routeCaptureUpdate", snapshotMap(status, endPoint))
  }

  private fun snapshotMap(status: String, endPoint: CapturedRoutePoint? = null): WritableMap =
    Arguments.createMap().apply {
      putString("status", status)
      startPoint?.let { putMap("start", it.toWritableMap("자동 수집 출발지")) }
      endPoint?.let { putMap("end", it.toWritableMap("자동 수집 목적지")) }
      putArray("waypoints", waypoints.toWritableArray())
      putInt("point_count", waypoints.size)
    }

  private fun hasLocationPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

  private fun isUsableLocation(location: Location): Boolean =
    location.hasAccuracy() && location.accuracy <= MAX_ACCEPTABLE_ACCURACY_METERS

  private fun startForegroundCompat() {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("경로 자동 수집 중")
      .setContentText("10초마다 위치를 확인해 등하교 경로를 저장합니다.")
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Route capture",
      NotificationManager.IMPORTANCE_HIGH,
    )
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun emitNativeError(code: String, message: String) {
    EmergencyEventBus.emit(
      "nativeError",
      Arguments.createMap().apply {
        putString("code", code)
        putString("message", message)
      },
    )
  }

  companion object {
    const val ACTION_START = "com.emergencycall.START_ROUTE_CAPTURE"
    const val ACTION_STOP = "com.emergencycall.STOP_ROUTE_CAPTURE"
    const val EXTRA_START_LATITUDE = "startLatitude"
    const val EXTRA_START_LONGITUDE = "startLongitude"
    private const val CHANNEL_ID = "route_capture"
    private const val NOTIFICATION_ID = 11202
    private const val CAPTURE_INTERVAL_MS = 10_000L
    private const val MIN_WAYPOINT_DISTANCE_METERS = 4.0f
    private const val MAX_ACCEPTABLE_ACCURACY_METERS = 50.0f
    @Volatile private var activeService: RouteCaptureForegroundService? = null

    fun finishActiveCapture(): WritableMap? = activeService?.finishCapture()
  }
}

private data class CapturedRoutePoint(
  val latitude: Double,
  val longitude: Double,
) {
  fun toWritableMap(address: String? = null): WritableMap =
    Arguments.createMap().apply {
      putDouble("latitude", latitude)
      putDouble("longitude", longitude)
      address?.let { putString("address", it) }
    }
}

private fun Location.toCapturedPoint(): CapturedRoutePoint =
  CapturedRoutePoint(latitude, longitude)

private fun distanceMeters(point: CapturedRoutePoint, location: Location): Float {
  val previous = Location("previous").apply {
    latitude = point.latitude
    longitude = point.longitude
  }
  return previous.distanceTo(location)
}

private fun List<CapturedRoutePoint>.toWritableArray(): WritableArray =
  Arguments.createArray().apply {
    forEach { pushMap(it.toWritableMap()) }
  }
