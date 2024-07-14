#!/usr/bin/env bash

# This script deletes the iptables rule for given protocol, port, and mark.

IPTABLES="/usr/sbin/iptables"

DEST_ADDRESS="$1"
PORT="$2"
PROTO="$3" # udp or tcp
MARK="$4"  # eg. 10

if [ -z $PORT ] || [ -z $PROTO ] || [ -z $MARK ]; then
  echo "Usage: ./delete_iptable_rule.sh <destination address> <port> <protocol> <mark>"
  exit 1
fi

# just remove the iptables rule
# -n for numeric output, -L for list, -t for table, -p for protocol,
#-sport for source port, -j for jump, -A for append, -D for delete
if $IPTABLES -n -L OUTPUT -t mangle | grep -q -E "MARK.+$DEST_ADDRESS.+$PROTO.+$PORT"; then
  $IPTABLES -D OUTPUT -t mangle -p $PROTO --sport $PORT -d $DEST_ADDRESS -j MARK --set-mark $MARK
  echo "iptables rule deleted for $PROTO on destination $DEST_ADDRESS and port $PORT"
fi
