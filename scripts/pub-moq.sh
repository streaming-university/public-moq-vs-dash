#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source $DIR/common.sh

# Change directory to the root of the project
cd "$(dirname "$0")/.."

# Use debug logging by default
export RUST_LOG="${RUST_LOG:-debug}"

ACODEC=aac
VCODEC=libx264
COLOR=bt709

video_size="1280x720"

FF="${ffmpeg:-ffmpeg}"

# Decide whether to use testsrc or avfoundation
TESTSRC="${testsrc:-1}"
if [ "${TESTSRC}" == "1" ]; then
	INPUT="-f lavfi -re -i testsrc=s=$video_size:r=30"
else
	INPUT="-f avfoundation -framerate 30 -video_size $video_size -i '0:none'"
fi

# Decide whether to use docker or not
USE_DOCKER="${docker:-0}"
if [ "${USE_DOCKER}" == "1" ]; then
	ENVS="-e RUST_LOG=${RUST_LOG}"
	VOLUMES="-v $(realpath ./repos/moq-rs):/project"
	ARGS="--build --name publish-moq --rm -T publish-moq"

	MOQ_EXEC="docker compose run ${ENVS} ${VOLUMES} ${ARGS} moq-pub"
	echo "Using docker to run moq-pub with: ${MOQ_EXEC}"
	HOST=localhost
else
	MOQ_EXEC="cargo run --bin moq-pub --"
	cd repos/moq-rs
fi

# Connect to localhost by default.
HOST="${HOST:-localhost}"
PORT="${PORT:-4443}"
ADDR="${ADDR:-$HOST:$PORT}"
PUT_TIMESTAMP="${put_timestamp:-0}"
FONT_PATH="${font_path:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
# timestamp format: T -> time N->millisecond
# use millisecond with caution, it may not work all the time!
TS_FORMAT="${ts_format:-%T.%N}"
# construct video filter
VIDEO_FILTER="null"
if [[ $PUT_TIMESTAMP == "1" ]]; then
	if [[ ! -f $FONT_PATH ]]; then
		echo "WARNING: Font does not exist at $FONT_PATH. Timestamp embedding will not work!"
	else
		VIDEO_FILTER="drawtext=fontfile='$FONT_PATH':fontsize=32:box=1:boxborderw=4:boxcolor=black@0.6:fontcolor=white:x=32:y=H-32:text='T0\: %{localtime\:$ts_format}'[time];"
		echo "VIDEO_FILTER: $VIDEO_FILTER"
	fi
fi

# Generate a random 16 character name by default.
#NAME="${NAME:-$(head /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | head -c 16)}"

# JK use the name "dev" instead
# TODO use that random name if the host is not localhost
NAME="${name:-dev}"

# Combine the host and name into a URL.
URL="${URL:-"https://$ADDR/$NAME"}"

res_0="640x360"
res_1="768x432"
res_2="960x540"
res_3="1280x720"

bitrate_0="360000"
bitrate_1="1100000"
bitrate_2="2000000"
bitrate_3="3000000"

bufsize_0="720K"
bufsize_1="2.2M"
bufsize_2="4M"
bufsize_3="6M"

bitrates="${bitrate_0},${bitrate_1},${bitrate_2},${bitrate_3}"

# for higher quality, use greater GOP size. But this time switching happens more slowly.
gop_size=30

execute() {
	 $FF -hide_banner -probesize 10M $INPUT -an -fflags nobuffer \
		-f mp4 -c $VCODEC -movflags cmaf+separate_moof+delay_moov+skip_trailer -x264-params "nal-hrd=cbr" \
		-map 0 -map 0 -map 0 -map 0 \
		-s:v:0 ${res_0} -b:v:0 ${bitrate_0} -minrate ${bitrate_0} -maxrate ${bitrate_0} -bufsize ${bufsize_0} \
		-s:v:1 ${res_1} -b:v:1 ${bitrate_1} -minrate ${bitrate_1} -maxrate ${bitrate_1} -bufsize ${bufsize_1} \
		-s:v:2 ${res_2} -b:v:2 ${bitrate_2} -minrate ${bitrate_2} -maxrate ${bitrate_2} -bufsize ${bufsize_2} \
		-s:v:3 ${res_3} -b:v:3 ${bitrate_3} -minrate ${bitrate_3} -maxrate ${bitrate_3} -bufsize ${bufsize_3} \
		-write_prft wallclock \
		-vf "$VIDEO_FILTER" \
		-g:v $gop_size -keyint_min:v $gop_size -sc_threshold:v 0 -streaming 1 -tune zerolatency \
		-color_primaries ${COLOR} -color_trc ${COLOR} -colorspace ${COLOR} \
		-frag_type duration -frag_duration 1 - | $MOQ_EXEC "$URL" --bitrates $bitrates --tls-disable-verify
}

# Signal handler to stop the stream
terminate() {
	echo "Stopping stream..."
	kill $PID

	# Kill the docker container if it was used
	if [ "${USE_DOCKER}" == "1" ]; then
		docker kill publish-moq
	fi

	# Exit the script
	exit 0
}

trap 'terminate' INT TERM

#while true; do
	# Start the stream
	execute
	PID=$!

	# Wait for the stream to finish
#	wait $PID || true
#done
