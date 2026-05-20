package com.emergencycall

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class MlcGemmaNativeModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "MlcGemmaNative"

  @ReactMethod
  fun warmUp(modelId: String, promise: Promise) {
    promise.resolve(LiteRtGemmaAnalyzer.warmUp(reactApplicationContext, modelId))
  }

  @ReactMethod
  fun analyzeEmergencyAudio(input: ReadableMap, promise: Promise) {
    val pcmBase64 = input.getString("pcmBase64") ?: ""
    val sampleRate = if (input.hasKey("sampleRate")) input.getInt("sampleRate") else 16000
    val triggerSource = input.getString("triggerSource") ?: "manual"
    val location = LiteRtGemmaAnalyzer.locationFromReadableMap(input)
    promise.resolve(LiteRtGemmaAnalyzer.analyze(reactApplicationContext, pcmBase64, sampleRate, location, triggerSource))
  }

  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Double) = Unit
}
