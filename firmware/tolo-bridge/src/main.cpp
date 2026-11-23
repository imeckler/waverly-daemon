// Bridge between the daemon and the TOLO steam controller's serial port, in
// place of the App Box. It joins WiFi, listens on UDP 51500, and passes TOLO
// requests to the controller only when they carry the daemon's HMAC (bridge.h).
//
// While the daemon is in touch it drives the unit, as it did through the App
// Box, and on every control tick it also leaves its plan here (plan.h). If
// nothing authorised arrives for kDaemonSilenceMs the bridge takes over and
// follows that plan itself: it starts and stops the room on time and keeps the
// unit's own power timer armed, as the daemon would. It does this only while
// the plan is younger than kPlanTrustMs. After that, or with no plan in hand,
// it keeps the unit off: a plan that old may have been changed, and a unit
// nobody is supervising should not be running. The fan is left to its own
// timer throughout.
//
//   ESP32 3V3     -> module VCC
//   ESP32 GND     -> module GND
//   ESP32 GPIO16 (RX2)  <- module RXD
//   ESP32 GPIO17 (TX2)  -> module TXD
//
// The module in use labels its pins like-to-like. The controller answers at
// 9600 8N1. See ../tolo-probe/PLAN.md for the wiring to the controller.
//
// WiFi and the key come from secrets.h (copy secrets.example.h). USB serial
// carries a log, and nothing else: there is no other way in.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_task_wdt.h>
#include <mbedtls/md.h>

// This mbedTLS release's constant_time.h has no C++ linkage guard of its own.
extern "C" {
#include <mbedtls/constant_time.h>
}

#include "bridge.h"
#include "secrets.h"

static_assert(sizeof(kKey) > 32, "set kKey in secrets.h to at least 32 characters");

constexpr int kRxPin = 16;
constexpr int kTxPin = 17;
constexpr uint16_t kPort = 51500;
constexpr uint32_t kReplyMs = 300;
constexpr int kAttempts = 2;
constexpr int64_t kDaemonSilenceMs = 90 * 1000;
constexpr int64_t kPlanTrustMs = 30 * 60 * 1000;
constexpr int64_t kStandInEveryMs = 30 * 1000;
// What the unit's own power timer is armed to while the bridge keeps the room
// on, so the unit still switches itself off if the bridge dies. As in the daemon.
constexpr uint8_t kPowerTimerMinutes = 10;
constexpr int64_t kWifiRetryMs = 30 * 1000;
constexpr uint32_t kHangSeconds = 30;

WiFiUDP udp;
bridge::Challenge challenge = {};
plan::Plan held = {};
int64_t lastDaemonMs = 0;  // Boot counts as contact: the daemon gets kDaemonSilenceMs to appear.

int64_t nowMs() { return esp_timer_get_time() / 1000; }

namespace bridge {

bool hmac(const uint8_t *data, size_t len, uint8_t *mac) {
  const auto *key = reinterpret_cast<const uint8_t *>(kKey);
  return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, strlen(kKey), data, len, mac) == 0;
}

bool sameMac(const uint8_t *a, const uint8_t *b) { return mbedtls_ct_memcmp(a, b, kMacLen) == 0; }

void fillRandom(uint8_t *out, size_t len) { esp_fill_random(out, len); }

size_t askController(const uint8_t *request, uint8_t *reply) {
  const size_t want = tolo::replyLen(request[2]);
  for (int attempt = 0; attempt < kAttempts; attempt++) {
    while (Serial2.read() >= 0) {
    }
    Serial2.write(request, tolo::kRequestLen);
    if (Serial2.readBytes(reply, want) == want && reply[2] == request[2] && tolo::validFrame(reply, want)) return want;
  }
  Serial.printf("controller did not answer command %u\n", request[2]);
  return 0;
}

bool acceptPlan(const uint8_t *body, size_t len, int64_t now) { return plan::parse(body, len, now, held); }

}  // namespace bridge

void serveDaemon() {
  uint8_t in[bridge::kMaxIn];
  uint8_t out[bridge::kMaxOut];
  const int size = udp.parsePacket();
  if (size <= 0 || size > static_cast<int>(sizeof(in))) return;
  const size_t len = bridge::handle(challenge, in, udp.read(in, sizeof(in)), nowMs(), out);
  if (len == 0) return;
  if (out[3] == bridge::kReply || out[3] == bridge::kPlanAck) lastDaemonMs = nowMs();
  udp.beginPacket(udp.remoteIP(), udp.remotePort());
  udp.write(out, len);
  udp.endPacket();
}

size_t tell(uint8_t command, uint8_t value, uint8_t *reply) {
  uint8_t request[tolo::kRequestLen];
  tolo::buildRequest(command, value, request);
  return bridge::askController(request, reply);
}

// Stands in for the daemon while it is silent. When the room should be off the
// unit is switched off unless it is known to be off already, so a status read
// that fails still ends in the off command.
void standIn() {
  static int64_t lastMs = 0;
  const int64_t now = nowMs();
  if (now - lastDaemonMs < kDaemonSilenceMs || now - lastMs < kStandInEveryMs) return;
  lastMs = now;
  uint8_t reply[tolo::kMaxReplyLen];
  uint8_t status[tolo::kMaxReplyLen];
  // The plan's own age, not the daemon's last word: a daemon whose commands get
  // through while its plans do not leaves an old plan here.
  const int64_t trustLeftMs = held.sentMs + kPlanTrustMs - now;
  const bool wantOn = trustLeftMs > 0 && plan::wantsOn(held, now);
  if (wantOn) {
    // Never armed past the end of the plan's trust, so the unit switches itself
    // off by then even if the bridge dies after this.
    const int64_t trustLeftMinutes = (trustLeftMs + 59999) / 60000;
    tell(tolo::kSetPowerTimer, min<int64_t>(kPowerTimerMinutes, trustLeftMinutes), reply);
    tell(tolo::kSetTargetTemperature, held.targetC, reply);
  }
  const bool answered = tell(tolo::kGetStatus, 0x11, status) > 0;
  const bool running = answered && status[tolo::kStatusPowerOffset] != 0;
  if (wantOn && answered && !running) {
    Serial.println("daemon silent: the plan has the room on, powering the unit on");
    tell(tolo::kSetPowerOn, 1, reply);
  } else if (!wantOn && (!answered || running)) {
    Serial.println("daemon silent: no current plan has the room on, powering the unit off");
    tell(tolo::kSetPowerOn, 0, reply);
  }
}

// The framework reconnects by itself after most drops, but not all of them.
void keepWifi() {
  static int64_t lastTryMs = 0;
  if (WiFi.isConnected() || nowMs() - lastTryMs < kWifiRetryMs) return;
  lastTryMs = nowMs();
  WiFi.reconnect();
}

void setup() {
  // The transmit line is driven to idle before anything else. Left to a
  // pull-up, this MAX3232 module's RS-232 output sits at +6V (a break).
  digitalWrite(kTxPin, HIGH);
  pinMode(kTxPin, OUTPUT);
  Serial.begin(115200);
  Serial2.begin(9600, SERIAL_8N1, kRxPin, kTxPin);
  Serial2.setTimeout(kReplyMs);

  WiFi.onEvent(
      [](arduino_event_id_t, arduino_event_info_t) {
        Serial.printf("WiFi up: %s, UDP port %u\n", WiFi.localIP().toString().c_str(), kPort);
      },
      ARDUINO_EVENT_WIFI_STA_GOT_IP);
  WiFi.onEvent(
      [](arduino_event_id_t, arduino_event_info_t info) {
        Serial.printf("WiFi down, reason %u\n", info.wifi_sta_disconnected.reason);
      },
      ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("tolo-bridge");
  const IPAddress ip(kIp[0], kIp[1], kIp[2], kIp[3]);
  if (uint32_t(ip) != 0) {
    WiFi.config(ip, IPAddress(kGateway[0], kGateway[1], kGateway[2], kGateway[3]), IPAddress(255, 255, 255, 0));
  }
  Serial.printf("tolo-bridge, MAC %s, joining %s\n", WiFi.macAddress().c_str(), kWifiName);
  WiFi.begin(kWifiName, kWifiPassword);
  udp.begin(kPort);

  // Reboots the bridge if the loop ever stops turning.
  esp_task_wdt_init(kHangSeconds, true);
  esp_task_wdt_add(nullptr);
}

void loop() {
  esp_task_wdt_reset();
  keepWifi();
  serveDaemon();
  standIn();
  delay(1);
}
