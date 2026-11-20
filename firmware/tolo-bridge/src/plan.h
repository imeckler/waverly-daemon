// The plan the daemon leaves with the bridge: the periods the room should be
// powered for, and the temperature to hold. The daemon sends it on every control
// tick, with its override already folded in, and the bridge follows it by itself
// while the daemon is out of reach (main.cpp).
//
// On the wire, times are seconds from the moment of sending, so the bridge needs
// no clock of its own:
//   target temperature (1, Celsius) | count (1) | count x (start in (4) | stop in (4)), big-endian
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace plan {

constexpr size_t kMaxPeriods = 8;
constexpr size_t kMaxLen = 2 + 8 * kMaxPeriods;
constexpr uint8_t kMinTargetC = 35;
constexpr uint8_t kMaxTargetC = 60;

struct Plan {
  int64_t sentMs;
  uint8_t targetC;
  size_t count;
  int64_t startMs[kMaxPeriods];
  int64_t stopMs[kMaxPeriods];
};

inline uint32_t u32(const uint8_t *b) {
  return static_cast<uint32_t>(b[0]) << 24 | static_cast<uint32_t>(b[1]) << 16 | static_cast<uint32_t>(b[2]) << 8 | b[3];
}

// Reads a plan sent at `nowMs`. Returns false, leaving `out` alone, if it is malformed.
inline bool parse(const uint8_t *b, size_t n, int64_t nowMs, Plan &out) {
  if (n < 2 || b[0] < kMinTargetC || b[0] > kMaxTargetC || b[1] > kMaxPeriods || n != 2 + 8 * static_cast<size_t>(b[1])) {
    return false;
  }
  Plan parsed = {nowMs, b[0], b[1], {}, {}};
  for (size_t i = 0; i < parsed.count; i++) {
    const uint8_t *period = b + 2 + 8 * i;
    if (u32(period) >= u32(period + 4)) return false;
    parsed.startMs[i] = nowMs + 1000 * static_cast<int64_t>(u32(period));
    parsed.stopMs[i] = nowMs + 1000 * static_cast<int64_t>(u32(period + 4));
  }
  out = parsed;
  return true;
}

inline bool wantsOn(const Plan &p, int64_t nowMs) {
  for (size_t i = 0; i < p.count; i++) {
    if (nowMs >= p.startMs[i] && nowMs < p.stopMs[i]) return true;
  }
  return false;
}

}  // namespace plan
