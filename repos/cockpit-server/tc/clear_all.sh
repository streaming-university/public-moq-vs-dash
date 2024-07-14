#!/usr/bin/env bash
TC='/sbin/tc'
IPTABLES="/usr/sbin/iptables"

SCRIPT=$(realpath "$0")
CURRENT_DIR=$(dirname "$SCRIPT")

# read interface from command line argument
INTERFACE_1=$1

if [ -z $INTERFACE_1 ]; then
  # if no interface is provided, read from .env file
  if [ -f "$CURRENT_DIR/.env" ]; then
    source $CURRENT_DIR/.env
  fi
  INTERFACE_1=$INTERFACE

  if [ -z $INTERFACE_1 ]; then
    echo "interface has to be specified"
    exit 1
  fi
fi

killall sleep 1>/dev/null 2>&1
killall tc 1>/dev/null 2>&1

$TC qdisc del dev $INTERFACE_1 root 1:0 1>/dev/null 2>&1
$TC qdisc del dev $INTERFACE_1 root 1>/dev/null 2>&1

$IPTABLES -F OUTPUT -t mangle 1>/dev/null 2>&1
