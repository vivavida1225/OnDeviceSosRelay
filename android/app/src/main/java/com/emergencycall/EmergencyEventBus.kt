package com.emergencycall

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

object EmergencyEventBus {
  private var reactContext: ReactApplicationContext? = null

  fun register(context: ReactApplicationContext) {
    reactContext = context
  }

  fun emit(eventName: String, payload: WritableMap = Arguments.createMap()) {
    reactContext
      ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      ?.emit(eventName, payload)
  }
}
