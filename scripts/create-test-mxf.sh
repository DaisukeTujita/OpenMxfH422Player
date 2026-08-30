#!/usr/bin/env bash
set -euo pipefail
OUT="${1:-public/samples/h422-test.mxf}"
mkdir -p "$(dirname "$OUT")"
ffmpeg -hide_banner -y -f lavfi -i 'testsrc2=size=1920x1080:rate=30000/1001' -f lavfi -i 'sine=frequency=1000:sample_rate=48000' -t 5 \
  -c:v mpeg2video -profile:v 0 -level:v 2 -pix_fmt yuv422p -b:v 50M -minrate 50M -maxrate 50M -bufsize 17825792 \
  -flags +ildct+ilme -top 1 -c:a pcm_s24le -ar 48000 -ac 2 -f mxf "$OUT"
printf 'Created %s\n' "$OUT"
