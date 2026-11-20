// Bench probe for the TOLO controller's serial port, through a MAX3232 module.
// Join the "tolo-probe" WiFi network and open http://192.168.4.1, or use the
// same one-letter commands over USB serial.
//
//   ESP32 3V3     -> module VCC
//   ESP32 GND     -> module GND
//   ESP32 GPIO16 (RX2)  <- module RXD
//   ESP32 GPIO17 (TX2)  -> module TXD
//
// The module in use labels its pins like-to-like. See PLAN.md.
//
// Nothing is transmitted to the controller until `p` is requested, and
// GET_STATUS is the only thing this firmware can send it.
#include <Arduino.h>
#include <WebServer.h>
#include <WiFi.h>

#include "frame.h"

constexpr char kWifiName[] = "tolo-probe";
constexpr char kWifiPassword[] = "steam-probe";
constexpr int kRxPin = 16;
constexpr int kTxPin = 17;
constexpr uint32_t kListenMs = 2000;
constexpr uint32_t kReplyMs = 300;
constexpr int kAttempts = 3;
constexpr size_t kHexPreview = 32;
constexpr size_t kLogMax = 12000;
constexpr uint32_t kBauds[] = {9600, 19200, 38400, 57600, 115200, 4800, 2400, 230400};

struct Format {
  uint32_t config;
  const char *name;
};
constexpr Format kFormats[] = {{SERIAL_8N1, "8N1"}, {SERIAL_8E1, "8E1"}, {SERIAL_8O1, "8O1"}};

const char kPage[] PROGMEM = R"html(<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TOLO probe</title>
<style>
body{font:16px system-ui;margin:16px;background:#111;color:#eee}
button{font:inherit;padding:12px;margin:0 8px 8px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
</style>
<h3>TOLO probe</h3>
<button onclick="run('w')">Check wiring</button>
<button onclick="run('l')">Listen</button>
<button onclick="confirm('Send GET_STATUS to the controller?')&&run('p')">Probe</button>
<pre id="log"></pre>
<script>
const log = document.getElementById('log');
async function run(c) {
  const r = await fetch('/run?c=' + c, {method: 'POST'});
  if (!r.ok) alert(await r.text());
}
setInterval(async () => {
  const text = await (await fetch('/log')).text();
  if (text === log.textContent) return;
  log.textContent = text;
  scrollTo(0, document.body.scrollHeight);
}, 1000);
</script>
)html";

class Log : public Print {
 public:
  String text;

  size_t write(uint8_t c) override {
    Serial.write(c);
    text += static_cast<char>(c);
    if (text.length() > kLogMax) text.remove(0, kLogMax / 2);
    return 1;
  }
};

Log out;
WebServer server(80);
uint8_t buffer[512];
char pending = 0;  // The requested command, held until it has finished running.

void printHex(const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) out.printf("%02X ", data[i]);
  out.println();
}

// Drives the transmit line to its idle level. A pull-up is not enough: this
// MAX3232 module loads the pin, and its RS-232 output then sat at +6V (a break)
// instead of the idle -6V.
void idleTx() {
  digitalWrite(kTxPin, HIGH);
  pinMode(kTxPin, OUTPUT);
}

void releaseLine() {
  Serial2.end();
  idleTx();
}

size_t capture(uint32_t ms) {
  size_t n = 0;
  const uint32_t start = millis();
  while (millis() - start < ms) {
    while (Serial2.available() && n < sizeof(buffer)) buffer[n++] = Serial2.read();
    server.handleClient();
    delay(1);
  }
  return n;
}

void printStatus(const uint8_t *frame) {
  const uint8_t *s = frame + tolo::kStatusExtraOffset;
  out.printf("  power=%u temp=%uC humidity=%u%% fan=%u heating=%u water=%u model=%u\n", s[0], s[1], s[11], s[9],
             s[3] & 3, s[8], s[14]);
}

// Returns true when a valid status reply was received.
bool report(uint32_t baud, const char *format, size_t n) {
  const tolo::Found found = tolo::findFrame(buffer, n);
  out.printf("%6u %s: %u bytes: ", baud, format, n);
  printHex(buffer, min(n, kHexPreview));
  switch (found.kind) {
    case tolo::FrameKind::Status:
      out.print("  VALID STATUS REPLY: ");
      printHex(found.data, found.len);
      printStatus(found.data);
      return true;
    case tolo::FrameKind::Other:
      out.print("  valid TOLO frame: ");
      printHex(found.data, found.len);
      return false;
    case tolo::FrameKind::Echo:
      out.println("  ECHO: our own request came back, so TX is reaching RX. This is not a reply.");
      out.println("  Check for a short between the controller's data pins.");
      return false;
    case tolo::FrameKind::None:
      return false;
  }
  return false;
}

void listen() {
  out.println("Listening only, nothing is sent. Use the wall panel during this scan.");
  bool heard = false;
  for (const uint32_t baud : kBauds) {
    for (const Format &format : kFormats) {
      Serial2.begin(baud, format.config, kRxPin, -1);
      const size_t n = capture(kListenMs);
      releaseLine();
      if (n == 0) continue;
      heard = true;
      report(baud, format.name, n);
    }
  }
  out.println(heard ? "Listen done." : "Listen done: no bytes at any setting.");
}

void probe() {
  out.print("Sending GET_STATUS: ");
  printHex(tolo::kGetStatus, sizeof(tolo::kGetStatus));
  for (const uint32_t baud : kBauds) {
    for (const Format &format : kFormats) {
      Serial2.begin(baud, format.config, kRxPin, kTxPin);
      for (int attempt = 0; attempt < kAttempts; attempt++) {
        while (Serial2.available()) Serial2.read();
        Serial2.write(tolo::kGetStatus, sizeof(tolo::kGetStatus));
        Serial2.flush();
        const size_t n = capture(kReplyMs);
        if (n > 0 && report(baud, format.name, n)) {
          releaseLine();
          out.printf("FOUND: %u %s\n", baud, format.name);
          return;
        }
      }
      releaseLine();
    }
  }
  out.println("Probe done: no valid status reply.");
}

void checkWiring() {
  pinMode(kRxPin, INPUT_PULLDOWN);
  delay(5);
  out.println(digitalRead(kRxPin) == HIGH ? "GPIO16 is high: the module looks powered and its TXD is connected."
                                          : "GPIO16 is low: check module VCC and GND, or swap the TXD and RXD jumpers.");
  pinMode(kRxPin, INPUT);
}

bool isCommand(char c) { return c == 'w' || c == 'l' || c == 'p'; }

void handleRun() {
  const String c = server.arg("c");
  if (pending) return server.send(409, "text/plain", "A scan is still running.");
  if (c.length() != 1 || !isCommand(c[0])) return server.send(400, "text/plain", "Unknown command.");
  pending = c[0];
  server.send(200, "text/plain", "ok");
}

void setup() {
  Serial.begin(115200);
  idleTx();
  Serial2.setRxBufferSize(sizeof(buffer));
  WiFi.softAP(kWifiName, kWifiPassword);
  server.on("/", HTTP_GET, [] { server.send_P(200, "text/html", kPage); });
  server.on("/log", HTTP_GET, [] { server.send(200, "text/plain", out.text); });
  server.on("/run", HTTP_POST, handleRun);
  server.begin();
  delay(500);
  out.printf("WiFi %s, page at http://%s\n", kWifiName, WiFi.softAPIP().toString().c_str());
  out.println("w = check wiring  l = listen only  p = send GET_STATUS at each setting");
}

void loop() {
  server.handleClient();
  if (!pending && Serial.available()) {
    const char c = Serial.read();
    if (isCommand(c)) pending = c;
  }
  if (pending == 'w') checkWiring();
  if (pending == 'l') listen();
  if (pending == 'p') probe();
  pending = 0;
  delay(1);
}
