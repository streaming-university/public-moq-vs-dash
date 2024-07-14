#!/bin/bash
set -euo pipefail

ADDR=${ADDR:-"https://relay.quic.video"}
NAME=${NAME:-"bbb"}
URL=${URL:-"http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"}

# Download the funny bunny
wget -nv "${URL}" -O "${NAME}.mp4"

# ffmpeg
#   -hide_banner: Hide the banner
#   -v quiet: and any other output
#   -stats: But we still want some stats on stderr
#   -stream_loop -1: Loop the broadcast an infinite number of times
#   -re: Output in real-time
#   -i "${INPUT}": Read from a file on disk
#   -vf "drawtext": Render the current time in the corner of the video
#   -an: Disable audio for now
#   -b:v 3M: Output video at 3Mbps
#   -preset ultrafast: Don't use much CPU at the cost of quality
#   -tune zerolatency: Optimize for latency at the cost of quality
#   -f mp4: Output to mp4 format
#   -movflags: Build a fMP4 file with a frame per fragment
# - | moq-pub: Output to stdout and moq-pub to publish

# Run ffmpeg
ffmpeg \
	-stream_loop -1 \
	-hide_banner \
	-v quiet \
	-re \
    -i "${NAME}.mp4" \
	-vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf:text='%{gmtime\: %H\\\\\:%M\\\\\:%S.%3N}':x=(W-tw)-24:y=24:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.5" \
	-an \
	-b:v 3M \
	-preset ultrafast \
	-tune zerolatency \
    -f mp4 \
	-movflags empty_moov+frag_every_frame+separate_moof+omit_tfhd_offset \
	- | moq-pub "${ADDR}/${NAME}"
