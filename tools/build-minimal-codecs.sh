#!/usr/bin/env bash
set -euo pipefail
export PATH="/ucrt64/bin:/usr/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.build-tools/minimal-codecs"
PREFIX="$WORK/prefix"
PREFIX_WIN="$(cygpath -m "$PREFIX")"
mkdir -p "$PREFIX" "$WORK/ffmpeg-build"
tar -xf "$WORK/sources/mingw-w64-ffmpeg/ffmpeg-9.0.2.tar.xz" -C "$WORK"
tar -xf "$WORK/sources/mingw-w64-gst-libav/gst-libav-1.28.9.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-build"
if [[ ! -f ffbuild/config.mak ]]; then
"$WORK/ffmpeg-9.0.2/configure" --prefix="$PREFIX_WIN" --target-os=mingw32 --arch=x86_64 \
  --cc=gcc --cxx=g++ --disable-autodetect --disable-everything --disable-programs --disable-doc \
  --enable-shared --disable-static --disable-debug --disable-network --disable-gpl --disable-nonfree \
  --disable-x86asm --enable-small --enable-decoder=aac,alac --enable-parser=aac
fi
make -j"${NUMBER_OF_PROCESSORS:-4}"
make install
cd "$ROOT"
export PKG_CONFIG_PATH="$PREFIX_WIN/lib/pkgconfig"
export PATH="$PREFIX/bin:$PATH"
if [[ ! -f "$WORK/gst-libav-build/build.ninja" ]]; then
  meson setup "$WORK/gst-libav-build" "$WORK/gst-libav-1.28.9" \
    --prefix="$PREFIX_WIN" --buildtype=release --wrap-mode=nofallback \
    -Dauto_features=disabled -Ddoc=disabled -Dtests=disabled
fi
meson compile -C "$WORK/gst-libav-build"
meson install -C "$WORK/gst-libav-build"
