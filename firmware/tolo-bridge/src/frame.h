// TOLO frame format, as in src/tolo/message.ts:
//   AA AA | command | value | extra | 55 55 | XOR of all preceding bytes
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace tolo {

constexpr size_t kRequestLen = 8;
constexpr size_t kMaxReplyLen = 24;
constexpr uint8_t kSetTargetTemperature = 4;
constexpr uint8_t kSetPowerTimer = 8;
constexpr uint8_t kSetPowerOn = 14;
constexpr uint8_t kGetStatus = 97;
constexpr uint8_t kGetSettings = 99;
constexpr size_t kStatusPowerOffset = 4;

inline uint8_t xorOf(const uint8_t *b, size_t n) {
  uint8_t x = 0;
  for (size_t i = 0; i < n; i++) x ^= b[i];
  return x;
}

inline bool validFrame(const uint8_t *b, size_t n) {
  return n >= 7 && b[0] == 0xAA && b[1] == 0xAA && b[n - 3] == 0x55 && b[n - 2] == 0x55 && xorOf(b, n) == 0;
}

inline void buildRequest(uint8_t command, uint8_t value, uint8_t *out) {
  const uint8_t frame[] = {0xAA, 0xAA, command, value, 0xFF, 0x55, 0x55};
  for (size_t i = 0; i < sizeof(frame); i++) out[i] = frame[i];
  out[sizeof(frame)] = xorOf(frame, sizeof(frame));
}

// Frames carry no length, and a status payload can itself contain 55 55, so
// the reply's length comes from the command.
inline size_t replyLen(uint8_t command) { return command == kGetStatus ? 24 : command == kGetSettings ? 15 : 8; }

}  // namespace tolo
