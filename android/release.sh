#!/usr/bin/env bash
# Build, sign, stage and publish the next Android release of a channel from this checkout: android/release.sh beta|production
# Run as kenan (sudo is used for the root-owned release directories). Commit native source first; publication records HEAD.
set -euo pipefail
channel=${1:?Usage: android/release.sh beta|production}
[[ $channel == beta || $channel == production ]] || exit 2
cd "$(dirname "$0")/.."
git diff --quiet HEAD -- android || { echo 'Commit android/ before releasing it' >&2; exit 1; }
# One release per channel at a time: the version is read, built and published under the lock, so concurrent agents can't both take the same version.
mkdir -p "$HOME/.cache/kenan"
exec 9>"$HOME/.cache/kenan/android-release-$channel.lock"
flock 9
current=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).versionCode)' "/var/lib/kenan/android/$channel/manifest.json")
version=$((current + 1)); name="1.3.$version"
./android/build.sh -PkenanChannel="$channel" -PkenanVersionCode="$version" -PkenanVersionName="$name" assembleRelease testReleaseUnitTest --max-workers=4
signer=$(node -e 'console.log(require("./android/channels.json")[process.argv[1]].signerCertificateSha256)' "$channel")
root="/var/lib/kenan/android-build/$channel-$version"
sudo install -d "$root"
sudo install -m 0644 android/app/build/outputs/apk/release/app-release.apk "$root.apk"
sudo node android/stage.mjs "$root.apk" "$root" "$signer" "$channel"
sha=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).sha256)' "$root/android/manifest.json")
live="/var/lib/kenan/android/$channel"
sudo cp "$root/android/$sha.apk" "$live/"
for file in manifest.sig signer.der manifest.json; do sudo cp "$root/android/$file" "$live/$file.new"; sudo mv "$live/$file.new" "$live/$file"; done
sudo node deploy/publish-android.mjs "$channel"
echo "$channel Android $version ($sha) published"
