// The daemon's side of the bridge: UDP datagrams, each request authorised by an
// HMAC-SHA256 over a fresh challenge. Only a holder of the shared key can make
// the bridge transmit to the controller or change its plan, a captured request
// cannot be replayed, and the daemon can tell an answer is the bridge's answer
// to this very request.
//
//   daemon -> bridge  hello      "TB" 1 1 | daemon nonce (16)
//   bridge -> daemon  challenge  "TB" 1 2 | daemon nonce | bridge nonce (16)
//
// then one of
//
//   daemon -> bridge  command    "TB" 1 3 | bridge nonce | TOLO request (8) | MAC (32)
//   bridge -> daemon  reply      "TB" 1 4 | bridge nonce | TOLO reply | MAC
//
//   daemon -> bridge  plan       "TB" 1 5 | bridge nonce | plan (plan.h) | MAC
//   bridge -> daemon  plan ack   "TB" 1 6 | bridge nonce | MAC
//
//   request MAC = HMAC(key, its 4-byte header | daemon nonce | bridge nonce | request body)
//   answer MAC  = HMAC(key, its 4-byte header | daemon nonce | bridge nonce | request body | answer body)
//
// The header's type byte keeps the four kinds of MAC apart, and every field
// before the last is of fixed length (a plan's answer body is empty), so no two
// messages share a MAC input. A challenge is good for one request and for
// kChallengeMs, and only the newest one is kept, so a host that floods hellos
// can keep the daemon out, though it cannot command the bridge. An empty TOLO
// reply means the controller did not answer. Anything that fails a check is
// dropped unanswered. src/tolo/bridge.ts is the other end.
#pragma once

#include <string.h>

#include "frame.h"
#include "plan.h"

namespace bridge {

constexpr size_t kNonceLen = 16;
constexpr size_t kMacLen = 32;
constexpr size_t kHeaderLen = 4;
constexpr uint8_t kHeader[] = {'T', 'B', 1};
enum Type : uint8_t { kHello = 1, kChallenge, kCommand, kReply, kPlan, kPlanAck };
constexpr size_t kHelloLen = kHeaderLen + kNonceLen;
constexpr size_t kEnvelopeLen = kHeaderLen + kNonceLen + kMacLen;
constexpr size_t kMaxIn = kEnvelopeLen + plan::kMaxLen;
constexpr size_t kMaxOut = kEnvelopeLen + tolo::kMaxReplyLen;
constexpr int64_t kChallengeMs = 5000;

// Supplied by main.cpp.
bool hmac(const uint8_t *data, size_t len, uint8_t *mac);
bool sameMac(const uint8_t *a, const uint8_t *b);
void fillRandom(uint8_t *out, size_t len);
// Sends an 8-byte request to the controller; returns the reply's length, 0 for none.
size_t askController(const uint8_t *request, uint8_t *reply);
// Takes a plan sent at `nowMs`; false if it is malformed.
bool acceptPlan(const uint8_t *body, size_t len, int64_t nowMs);

struct Challenge {
  uint8_t daemon[kNonceLen];
  uint8_t bridge[kNonceLen];
  int64_t at;
  bool open;
};

inline bool mac(Type type, const Challenge &c, const uint8_t *bodies, size_t bodiesLen, uint8_t *out) {
  uint8_t in[kHeaderLen + 2 * kNonceLen + plan::kMaxLen + tolo::kMaxReplyLen];
  size_t n = 0;
  const auto add = [&](const void *p, size_t len) {
    memcpy(in + n, p, len);
    n += len;
  };
  add(kHeader, sizeof(kHeader));
  add(&type, 1);
  add(c.daemon, kNonceLen);
  add(c.bridge, kNonceLen);
  add(bodies, bodiesLen);
  return hmac(in, n, out);
}

// Handles one datagram. Returns the length of the answer written to `out`
// (room for kMaxOut), 0 for none. An answer of type kReply or kPlanAck means an
// authorised request was carried out.
inline size_t handle(Challenge &c, const uint8_t *in, size_t n, int64_t now, uint8_t *out) {
  if (n < kHeaderLen || n > kMaxIn || memcmp(in, kHeader, sizeof(kHeader)) != 0) return 0;
  const uint8_t *nonce = in + kHeaderLen;
  uint8_t *answer = out + kHeaderLen;
  memcpy(out, kHeader, sizeof(kHeader));

  if (in[3] == kHello && n == kHelloLen) {
    memcpy(c.daemon, nonce, kNonceLen);
    fillRandom(c.bridge, kNonceLen);
    c.at = now;
    c.open = true;
    out[3] = kChallenge;
    memcpy(answer, c.daemon, kNonceLen);
    memcpy(answer + kNonceLen, c.bridge, kNonceLen);
    return kHeaderLen + 2 * kNonceLen;
  }

  const bool isPlan = in[3] == kPlan;
  if ((in[3] != kCommand && !isPlan) || n < kEnvelopeLen) return 0;
  const size_t requestLen = n - kEnvelopeLen;
  if (!isPlan && requestLen != tolo::kRequestLen) return 0;
  if (!c.open || now - c.at > kChallengeMs || memcmp(nonce, c.bridge, kNonceLen) != 0) return 0;

  // The request body, followed by the answer body once there is one.
  uint8_t bodies[plan::kMaxLen + tolo::kMaxReplyLen];
  uint8_t expected[kMacLen];
  memcpy(bodies, nonce + kNonceLen, requestLen);
  if (!mac(isPlan ? kPlan : kCommand, c, bodies, requestLen, expected)) return 0;
  if (!sameMac(expected, nonce + kNonceLen + requestLen)) return 0;
  c.open = false;

  uint8_t *reply = bodies + requestLen;
  size_t replyLen = 0;
  if (isPlan) {
    if (!acceptPlan(bodies, requestLen, now)) return 0;
  } else {
    if (!tolo::validFrame(bodies, requestLen)) return 0;
    replyLen = askController(bodies, reply);
  }
  const Type answerType = isPlan ? kPlanAck : kReply;
  out[3] = answerType;
  memcpy(answer, c.bridge, kNonceLen);
  memcpy(answer + kNonceLen, reply, replyLen);
  if (!mac(answerType, c, bodies, requestLen + replyLen, answer + kNonceLen + replyLen)) return 0;
  return kEnvelopeLen + replyLen;
}

}  // namespace bridge
