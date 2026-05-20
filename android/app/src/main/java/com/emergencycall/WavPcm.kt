package com.emergencycall

import java.nio.ByteBuffer
import java.nio.ByteOrder

object WavPcm {
  fun pcm16Base64ToWavBytes(pcmBytes: ByteArray, sampleRate: Int): ByteArray {
    val header = ByteArray(44)
    val byteRate = sampleRate * 2
    val totalDataLen = pcmBytes.size + 36

    writeAscii(header, 0, "RIFF")
    writeInt(header, 4, totalDataLen)
    writeAscii(header, 8, "WAVE")
    writeAscii(header, 12, "fmt ")
    writeInt(header, 16, 16)
    writeShort(header, 20, 1)
    writeShort(header, 22, 1)
    writeInt(header, 24, sampleRate)
    writeInt(header, 28, byteRate)
    writeShort(header, 32, 2)
    writeShort(header, 34, 16)
    writeAscii(header, 36, "data")
    writeInt(header, 40, pcmBytes.size)

    return header + pcmBytes
  }

  private fun writeAscii(target: ByteArray, offset: Int, value: String) {
    value.toByteArray(Charsets.US_ASCII).copyInto(target, offset)
  }

  private fun writeInt(target: ByteArray, offset: Int, value: Int) {
    ByteBuffer.wrap(target, offset, 4).order(ByteOrder.LITTLE_ENDIAN).putInt(value)
  }

  private fun writeShort(target: ByteArray, offset: Int, value: Int) {
    ByteBuffer.wrap(target, offset, 2).order(ByteOrder.LITTLE_ENDIAN).putShort(value.toShort())
  }
}
