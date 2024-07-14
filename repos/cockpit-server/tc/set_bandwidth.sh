#!/usr/bin/env bash

usage() {
  echo "Usage: ./set_bandwidth.sh <mode> <rate (bps)> <client_ip> <op>"
  echo "mode can be dash or moq"
  echo "op can be set or del"
  exit 1
}

SCRIPT=$(realpath "$0")
CURRENT_DIR=$(dirname "$SCRIPT")

echo "Current dir: $CURRENT_DIR"

# load environment variables like INTERFACE
if [ -f "$CURRENT_DIR/.env" ]; then
  source $CURRENT_DIR/.env
fi

if [ -z "$INTERFACE" ]; then
  echo "Please set the INTERFACE variable in .env file"
  exit 1
fi

TC="/sbin/tc"
IPTABLES="/usr/sbin/iptables"

MODE="$1"
RATE="$2" # Bps
DEST_ADDRESS="$3"
OP=${4:-"set"}

if [ -z "$MODE" ] || [ -z "$RATE" ]; then
  usage
fi

if [[ $MODE == "dash" ]]; then
  INTERFACE_1=$INTERFACE # change this according to your interface used for dash streaming
  PORT="8080"
  PROTO="tcp"
  FLOW_ID="1:11"
  MARK="11"
elif [[ $MODE == "moq" ]]; then
  INTERFACE_1=$INTERFACE # change this according to your interface used for moq streaming
  PORT="4443"
  PROTO="udp"
  FLOW_ID="1:10"
  MARK="10"
else
  usage
fi

if [[ $OP == "set" ]]; then
  echo "Setting bandwidth limit"
  # call tc_qdisc.sh with the given rate and ceiling
  $CURRENT_DIR/tc_qdisc.sh $RATE $INTERFACE_1 $DEST_ADDRESS $PORT $PROTO $FLOW_ID $MARK
elif [[ $OP == "del" ]]; then
  echo "Deleting bandwidth limit"
  $CURRENT_DIR/delete_iptable_rule.sh $DEST_ADDRESS $PORT $PROTO $MARK
else
  usage
fi
