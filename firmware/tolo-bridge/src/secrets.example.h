// Copy to secrets.h, which is not committed, and fill in.
#pragma once

#include <cstdint>

constexpr char kWifiName[] = "";
constexpr char kWifiPassword[] = "";

// A fixed address, set on the bridge itself, for a network whose router cannot
// reserve one: a range extender puts its own MAC on every device behind it.
// All zeros takes an address from DHCP instead. The mask is 255.255.255.0.
constexpr uint8_t kIp[4] = {0, 0, 0, 0};
constexpr uint8_t kGateway[4] = {0, 0, 0, 0};

// Shared with the daemon, as tolo_key in its config.json. Generate with:
//   openssl rand -hex 32
constexpr char kKey[] = "";
