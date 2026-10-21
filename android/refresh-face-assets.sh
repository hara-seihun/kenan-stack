#!/usr/bin/env bash
# Preserve the original face pixels. Production launcher assets are the source of truth.
set -euo pipefail
cd "$(dirname "$0")"
for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  for name in ic_launcher ic_launcher_foreground; do
    magick "app/src/production/res/mipmap-$density/$name.png" \
      -channel R -fx 'u<=0.05?u:0.05+0.95*pow((u-0.05)/0.95,0.55)' +channel \
      -channel GB -evaluate set 0 +channel \
      "app/src/beta/res/mipmap-$density/$name.png"
  done
done
# Adaptive bitmaps show the central two-thirds. Frame the head in that area,
# using black bleed instead of passing the already padded launcher as a plain bitmap.
for channel in beta production; do
  mkdir -p "app/src/$channel/res/drawable-nodpi"
  magick "app/src/$channel/res/mipmap-xxxhdpi/ic_launcher_foreground.png" \
    -crop 256x256+112+96 +repage -resize 266x266 \
    -background black -gravity center -extent 432x432 \
    "app/src/$channel/res/drawable-nodpi/kenaznia_face.png"
done
