live=$1

if [[ $live == "live" ]]; then
	echo "live"
	ffmpeg -hide_banner -v quiet -framerate 30 -f avfoundation -i "0" -vf scale=320:-1  -an -f mp4 -movflags empty_moov+frag_every_frame+separate_moof+omit_tfhd_offset - | RUST_LOG=moq_pub=info cargo run -- -n zafer.video/live_stream_cam  -i -
else
	echo "not live"
	ffmpeg -hide_banner -v quiet -stream_loop 100 -re -i ../media/bbb_source.mp4 -an -f mp4 -movflags empty_moov+frag_every_frame+separate_moof+omit_tfhd_offset - | RUST_LOG=moq_pub=info cargo run -- -n zafer.video/vod  -i -
	exit 0
fi
