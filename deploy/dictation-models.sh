#!/bin/bash
# Installs what dictation (server/extensions/dictation.ts) runs on, only when CHANNEL's config enables it for someone:
# the whisper.cpp package (whisper-server, with the Vulkan backend for the iGPU) and the model files that file lists,
# each downloaded once into /var/lib/kenan/models/whisper and kept only if its sha256 matches.
set -euo pipefail
channel=${1:?usage: deploy/dictation-models.sh CHANNEL BUILD}; build=${2:?usage: deploy/dictation-models.sh CHANNEL BUILD}
enabled=$(node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(c.people.some(p => (p.extensions ?? []).includes("dictation")) ? "yes" : "no")' "/etc/kenan/$channel.json")
[[ $enabled == yes ]] || exit 0
if ! command -v whisper-server >/dev/null || ! command -v ffmpeg >/dev/null || [[ ! -e /usr/lib/x86_64-linux-gnu/ggml/backends0/libggml-vulkan.so ]]; then
 DEBIAN_FRONTEND=noninteractive apt-get install -y -q whisper.cpp libggml0-backend-vulkan ffmpeg >/dev/null
fi
dir=/var/lib/kenan/models/whisper
install -d -m 0755 /var/lib/kenan/models "$dir"
node --input-type=module -e 'const m = await import(process.argv[1]); for (const x of m.MODELS) console.log(`${x.file} ${x.sha256} ${x.url}`)' "$build/dist/server/extensions/dictation.js" |
while read -r file sha url; do
 [[ -f $dir/$file ]] && continue
 tmp=$(mktemp "$dir/.$file.XXXXXX")
 curl -sSfL --retry 3 --max-time 900 -o "$tmp" "$url"
 if [[ $(sha256sum "$tmp" | cut -d' ' -f1) != "$sha" ]]; then rm -f "$tmp"; echo "dictation_model_checksum: $url did not match $sha" >&2; exit 1; fi
 chmod 0644 "$tmp"; mv -f "$tmp" "$dir/$file"
done
