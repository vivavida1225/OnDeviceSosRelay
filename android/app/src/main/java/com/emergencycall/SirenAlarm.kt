package com.emergencycall

import android.media.AudioManager
import android.media.ToneGenerator
import kotlin.concurrent.thread

object SirenAlarm {
  @Volatile private var playing = false
  private var toneGenerator: ToneGenerator? = null

  fun start(durationMs: Int) {
    stop()
    playing = true
    toneGenerator = ToneGenerator(AudioManager.STREAM_ALARM, 100)
    thread(name = "EmergencySiren") {
      val startedAt = System.currentTimeMillis()
      while (playing && System.currentTimeMillis() - startedAt < durationMs) {
        toneGenerator?.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 350)
        Thread.sleep(450)
      }
      stop()
    }
  }

  fun stop() {
    playing = false
    toneGenerator?.release()
    toneGenerator = null
  }
}
