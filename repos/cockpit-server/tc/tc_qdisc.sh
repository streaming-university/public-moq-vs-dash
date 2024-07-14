#!/usr/bin/env bash

# This script uses tc to set up a qdisc for a given interface and port.
# It also sets up iptables rules to mark packets for the qdisc.
# The qdisc is set up with a rate and a ceiling.
# The rate is the guaranteed bandwidth for the qdisc.
# The ceiling is the maximum bandwidth for the qdisc.
# The qdisc is set up with a flow id.

# To configure iptables to count incoming and outgoing traffic from/to given IP
# iptables -I INPUT 1 -s <IP> -j ACCEPT
# iptables -I OUTPUT 1 -d <IP> -j ACCEPT

TC="/sbin/tc"
IPTABLES="/usr/sbin/iptables"

RATE="$1" # bps
INTERFACE_1="$2"
DEST_ADDRESS="$3"
PORT="$4"
PROTO="$5"   # udp or tcp
FLOW_ID="$6" # eg. 1:10
MARK="$7"    # eg. 10

CEIL=$(echo "$RATE*1.1" | bc) # bps

if [ -z $INTERFACE_1 ] || [ -z $DEST_ADDRESS ] || [ -z $PORT ] || [ -z $RATE ] || [ -z $CEIL ]; then
  echo "Usage: ./tc_qdisc.sh <interface name> <dest address> <port> <protocol> <rate (bps)> <ceiling (bps) <flow id> <mark>"
  exit 1
fi

# create a new queuing discipline
if $TC qdisc show dev $INTERFACE_1 | grep -q "qdisc htb 1:"; then
  echo "qdisc already exists"
else
  echo "adding qdisc"
  echo "$TC qdisc add dev $INTERFACE_1 root handle 1: htb"
  $TC qdisc add dev $INTERFACE_1 root handle 1: htb
fi

if $TC class show dev $INTERFACE_1 | grep -q "class htb $FLOW_ID"; then
  echo "class already exists, updating rate and ceiling"
  echo "$TC class change dev $INTERFACE_1 parent 1: classid $FLOW_ID htb rate $RATE ceil $CEIL prio 0 burst 15k quantum 1514"
  $TC class change dev $INTERFACE_1 parent 1: classid $FLOW_ID htb rate $RATE ceil $CEIL prio 0 burst 15k quantum 1514
else
  echo "adding class"
  echo "$TC class add dev $INTERFACE_1 parent 1: classid $FLOW_ID htb rate $RATE ceil $CEIL prio 0 burst 15k quantum 1514"
  $TC class add dev $INTERFACE_1 parent 1: classid $FLOW_ID htb rate $RATE ceil $CEIL prio 0 burst 15k quantum 1514
  # for stochastic fair queueing the following can be created as well
  # echo $TC qdisc add dev $INTERFACE_1 parent $FLOW_ID handle 10: sfq perturb 10
  # $TC qdisc add dev $INTERFACE_1 parent $FLOW_ID handle 10: sfq perturb 10
fi
if $TC filter show dev $INTERFACE_1 | grep -q "classid $FLOW_ID"; then
  echo "filter already exists"
else
  echo "adding filter"
  echo "$TC filter add dev $INTERFACE_1 parent 1: prio 0 protocol ip handle $MARK fw flowid $FLOW_ID"
  $TC filter add dev $INTERFACE_1 parent 1: prio 0 protocol ip handle $MARK fw flowid $FLOW_ID

fi

# -n for numeric output, -L for list, -t for table, -p for protocol,
#-sport for source port, -j for jump, -A for append, -D for delete
if $IPTABLES -n -L OUTPUT -t mangle | grep -q -E "MARK.+$DEST_ADDRESS.+$PROTO.+$PORT"; then
  echo "iptables rule already exists for $PROTO on destination $DEST_ADDRESS and port $PORT"
else
  echo "adding iptables rule"
  echo "$IPTABLES -A OUTPUT -t mangle -p $PROTO --sport $PORT -d $DEST_ADDRESS -j MARK --set-mark $MARK"
  $IPTABLES -A OUTPUT -t mangle -p $PROTO --sport $PORT -d $DEST_ADDRESS -j MARK --set-mark $MARK
fi
