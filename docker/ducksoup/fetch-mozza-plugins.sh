#!/usr/bin/env bash
# Fetch the Mozza GStreamer plugin + models into ./plugins so DuckSoup can do
# real-time, face-only smile manipulation (videoFx: "mozza deform=smile10 alpha=... name=video_fx").
#
# These artifacts are gitignored (binaries/models), so run this once per machine
# before `npm run media:up` / `docker compose up`. Requires Docker running.
#
# Source of truth: ../../../ducksoup-upstream/tutorials/run_in_local.md
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p plugins

# Intel/AMD64 -> :latest ; Apple Silicon -> :arm_latest
TAG="latest"
case "$(uname -m)" in
  arm64 | aarch64) TAG="arm_latest" ;;
esac
IMAGE="ducksouplab/mozza:${TAG}"

echo "==> Pulling ${IMAGE}"
docker pull "${IMAGE}"

echo "==> Extracting plugin + deform model from a throwaway container"
docker rm -f mozza_runner >/dev/null 2>&1 || true
docker create --name mozza_runner "${IMAGE}" >/dev/null
docker cp mozza_runner:gstmozza/build/libgstmozza.so          plugins/libgstmozza.so
docker cp mozza_runner:gstmozza/build/lib/imgwarp/libimgwarp.so plugins/libimgwarp.so
docker cp mozza_runner:gstmozza/data/in/smile10.dfm           plugins/smile10.dfm
docker rm -f mozza_runner >/dev/null

DAT="plugins/shape_predictor_68_face_landmarks.dat"
if [ ! -f "${DAT}" ]; then
  echo "==> Downloading dlib shape predictor"
  curl -L -o "${DAT}.bz2" http://dlib.net/files/shape_predictor_68_face_landmarks.dat.bz2
  if command -v bzip2 >/dev/null 2>&1; then
    bzip2 -d "${DAT}.bz2"
  else
    echo "!! bzip2 not found. Decompress ${DAT}.bz2 manually so you have ${DAT}."
  fi
else
  echo "==> ${DAT} already present, skipping download"
fi

echo "==> Done. plugins/ now contains:"
ls -1 plugins/
