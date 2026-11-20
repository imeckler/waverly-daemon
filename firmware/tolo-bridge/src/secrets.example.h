// Copy to secrets.h, which is not committed, and fill in.
#pragma once

constexpr char kWifiName[] = "";
constexpr char kWifiPassword[] = "";

// Shared with the daemon, as tolo_key in its config.json. Generate with:
//   openssl rand -hex 32
constexpr char kKey[] = "";
