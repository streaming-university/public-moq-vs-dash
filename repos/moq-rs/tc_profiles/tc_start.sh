#!/bin/bash
INTERFACE_1="en0"
PROFILE="lte_profile"

sudo bash "tc_clear.sh" $INTERFACE_1
sudo bash "tc_policy.sh" $INTERFACE_1 $PROFILE
