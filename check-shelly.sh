#!/bin/bash
# Query a Shelly device's memory + script state via the Pi.
# Usage: ./check-shelly.sh [IP]
#   IP defaults to the big sauna heater (10.0.0.224).
# Requires:
#   - config.json next to this script (for the Shelly admin password)
#   - SSH access to waverly@waverlypi.local (the host on the bathhouse LAN)
set -euo pipefail

IP="${1:-10.0.0.224}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASSWORD=$(awk -F\" '/"password"[[:space:]]*:/{print $4; exit}' "$SCRIPT_DIR/config.json")
if [ -z "$PASSWORD" ]; then
  echo "Could not find shelly.password in $SCRIPT_DIR/config.json" >&2
  exit 1
fi

run() {
  local endpoint="$1"
  echo "=== $endpoint ==="
  ssh waverly@waverlypi.local "curl -s --max-time 10 --digest -u admin:$PASSWORD \"http://$IP/rpc/$endpoint\""
  echo
  echo
}

run "Shelly.GetDeviceInfo"
run "Sys.GetStatus"
run "Script.List"
run "Script.GetStatus?id=1"

echo "=== Script.GetCode?id=1 (size in bytes, including JSON envelope) ==="
ssh waverly@waverlypi.local "curl -s --max-time 10 --digest -u admin:$PASSWORD \"http://$IP/rpc/Script.GetCode?id=1\" | wc -c"
