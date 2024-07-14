#!/bin/bash
# This script is the entrypoint for the Docker container.
# If DEVELOPMENT is set to true, file changes will be monitored and the binary will be recompiled.
#
# ./entrypoint.sh <binary> <...args>

set -e

# Check if DEVELOPMENT is set to true
IS_DEVELOPMENT=${DEVELOPMENT:-false}
BIN=$1
shift
ARGS=$@
CARGO_ARGS="--config profile.dev.debug-assertions=false"

trigger_init() {
	sleep 1
	touch .trigger
	rm .trigger
}

if [ "$IS_DEVELOPMENT" = "true" ]; then
	# Run the binary in development mode
	echo "Running in development mode"
	# Change to the project directory
	cd /project
	# Trigger the initial build
	trigger_init &
	# Run the binary in development mode
	exec cargo $CARGO_ARGS watch -x "run --bin $BIN -- $ARGS"
else
	# Run the binary in production mode
	echo "Running in production mode"
	exec $BIN $ARGS
fi
