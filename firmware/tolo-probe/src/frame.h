// TOLO frame format, as in src/tolo/message.ts:
//   AA AA | command | value | extra | 55 55 | XOR of all preceding bytes
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace tolo {

constexpr uint8_t kGetStatus[] = {0xAA, 0xAA, 0x61, 0x11, 0xFF, 0x55, 0x55, 0x8F};
constexpr uint8_t kGetStatusCommand = 0x61;
constexpr size_t kStatusFrameLen = 24;
constexpr size_t kStatusExtraOffset = 4;
constexpr size_t kMinFrameLen = 7;

enum class FrameKind { None, Echo, Status, Other };

struct Found {
  FrameKind kind;
  const uint8_t *data;
  size_t len;
};

inline size_t validFrameLenAt(const uint8_t *b, size_t n) {
  if (n < kMinFrameLen || b[0] != 0xAA || b[1] != 0xAA) return 0;
  uint8_t crc = b[0] ^ b[1] ^ b[2] ^ b[3];
  for (size_t i = 4; i + 2 < n; i++) {
    const uint8_t afterFirst = crc ^ b[i];
    const uint8_t afterSecond = afterFirst ^ b[i + 1];
    if (b[i] == 0x55 && b[i + 1] == 0x55 && b[i + 2] == afterSecond) return i + 3;
    crc = afterFirst;
  }
  return 0;
}

// Returns the first frame that is not our own request. A copy of the request
// alone is reported as Echo: it means TX is reaching RX, not that anything replied.
inline Found findFrame(const uint8_t *b, size_t n) {
  Found echo = {FrameKind::None, nullptr, 0};
  for (size_t i = 0; i < n;) {
    const size_t len = validFrameLenAt(b + i, n - i);
    if (len == 0) {
      i++;
      continue;
    }
    const uint8_t *frame = b + i;
    if (len == sizeof(kGetStatus) && memcmp(frame, kGetStatus, len) == 0) {
      echo = {FrameKind::Echo, frame, len};
    } else {
      const bool status = frame[2] == kGetStatusCommand && len == kStatusFrameLen;
      return {status ? FrameKind::Status : FrameKind::Other, frame, len};
    }
    i += len;
  }
  return echo;
}

}  // namespace tolo
