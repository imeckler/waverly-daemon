#!/bin/bash
# scp config.json waverly@waverlypi.local:~/repos/waverly-daemon/config.json
ssh waverly@waverlypi.local "pushd repos/waverly-daemon; git pull; popd; sudo docker compose -f repos/docker-compose.yml down waverly-daemon; sudo docker compose -f repos/docker-compose.yml up waverly-daemon -d --build"
