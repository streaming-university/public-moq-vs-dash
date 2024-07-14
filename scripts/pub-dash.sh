#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source $DIR/common.sh

# Change directory to the root of the project
cd "$(dirname "$0")/.."

SERVER="${server:-localhost}"
PORT="${port:-8079}"
FF="${ffmpeg:-ffmpeg}"
TESTSRC="${testsrc:-1}"
USE_HTTPS="${use_https:-0}"
PUT_TIMESTAMP="${put_timestamp:-0}"
FONT_PATH="${font_path:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
# N-> millisecond. It may not work.
TS_FORMAT="${ts_format:-%T.%N}"

if [ "${TESTSRC}" == "1" ]; then
    INPUT="-f lavfi -re -i testsrc=s=1280x720:r=30"
else
    INPUT="-f avfoundation -framerate 30 -video_size 1280x720 -i 0"
fi

ID=live
ACODEC=aac
VCODEC=libx264
COLOR=bt709
TARGET_LATENCY="1.5"

# construct video filter
VIDEO_FILTER="null"
if [[ $PUT_TIMESTAMP == "1" ]]; then
	if [[ ! -f $FONT_PATH ]]; then
		echo "WARNING: Font does not exist at $FONT_PATH. Timestamp embedding will not work!"
	else
		VIDEO_FILTER="drawtext=fontfile=$FONT_PATH:fontsize=32:box=1:boxborderw=4:boxcolor=black@0.6:fontcolor=white:x=32:y=H-32:text='T0\: %{localtime\:$TS_FORMAT}'[time];"
	fi
fi

# Add bitrates and resolutions from MoQ script
video_size="1280x720"

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

if [ "${USE_HTTPS}" == "1" ]; then
    PROTO=https
    TLS_KEY=${tls_key:-repos/dash-origin/certs/tls.key}
    TLS_CRT=${tls_crt:-repos/dash-origin/certs/cert.crt}

    HTTP_OPTS="-http_opts key_file=${TLS_KEY}:cert_file=${TLS_CRT}:tls_verify=0"
else
    PROTO=http
    HTTP_OPTS=""
fi

echo "Ingesting to: ${PROTO}://${SERVER}:${PORT}/${ID}/${ID}.mpd"

# TODO: What is this for?
# if [ "${TS_OUT}" != "" ]; then
#     TS_OUT_FILE="${TS_OUT}/${ID}.ts"
#     TS_OUT_CMD="-map 0:v:0 -y ${TS_OUT_FILE}"
#     echo "Storing input TS to: ${TS_OUT_FILE}"
# fi

$FF $INPUT \
    -c:v $VCODEC \
    -b:v:0 $bitrate_0 -s:v:0 $res_0 -minrate:v:0 $bitrate_0 -maxrate:v:0 $bitrate_0 -bufsize:v:0 $bufsize_0 \
    -b:v:1 $bitrate_1 -s:v:1 $res_1 -minrate:v:1 $bitrate_1 -maxrate:v:1 $bitrate_1 -bufsize:v:1 $bufsize_1 \
    -b:v:2 $bitrate_2 -s:v:2 $res_2 -minrate:v:2 $bitrate_2 -maxrate:v:2 $bitrate_2 -bufsize:v:2 $bufsize_2 \
    -b:v:3 $bitrate_3 -s:v:3 $res_3 -minrate:v:3 $bitrate_3 -maxrate:v:3 $bitrate_3 -bufsize:v:3 $bufsize_3 \
    -map 0:v:0 \
    -map 0:v:0 \
    -map 0:v:0 \
    -map 0:v:0 \
    -preset veryfast \
    -use_timeline 0 \
    -utc_timing_url "https://time.akamai.com" \
    -format_options "movflags=cmaf" \
    -frag_type every_frame \
    -adaptation_sets "id=0,streams=0,1,2,3" \
    -streaming 1 \
    -ldash 1 \
    -write_prft 1 \
    -export_side_data prft \
    -g:v 30 -keyint_min:v 30 \
    -sc_threshold:v 0 \
    -tune zerolatency \
    -target_latency ${TARGET_LATENCY} \
    -remove_at_exit 1 \
    -color_primaries ${COLOR} -color_trc ${COLOR} -colorspace ${COLOR} \
    -vf "$VIDEO_FILTER" \
    -f dash \
    ${HTTP_OPTS} \
    ${PROTO}://${SERVER}:${PORT}/${ID}/${ID}.mpd

