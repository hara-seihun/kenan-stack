#!/bin/bash
# Installs kenan-image (deploy/kenan-image): its Python environment in /opt/kenan-image-<inputs hash> behind the
# /opt/kenan-image symlink (the previous one is kept for rollback), the SD-Turbo weights pinned in model.txt in
# /var/lib/kenan/models/image (kept only if their sha256 matches), the lock every caller shares, the command and its guide.
# Torch comes from the CPU-only wheel index, so nothing it installs can touch the iGPU that dictation uses.
set -euo pipefail
umask 022
src=deploy/kenan-image
inputs=$(cat "$src/requirements.txt" | sha256sum | cut -c1-16)
env_dir=/opt/kenan-image-$inputs
export UV_CACHE_DIR=/var/cache/kenan-image-uv
# uv venvs record absolute paths, so the environment is built where it stays; .complete marks a finished build.
if [[ ! -f $env_dir/.complete ]]; then
 rm -rf "$env_dir"
 UV_PYTHON_INSTALL_DIR="$env_dir/python" uv venv -q --python-preference only-managed --python 3.12 "$env_dir/venv"
 uv pip install -q --python "$env_dir/venv/bin/python" --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match -r "$src/requirements.txt"
 "$env_dir/venv/bin/python" -c 'import torch, diffusers, vtracer; assert not torch.cuda.is_available()'
 touch "$env_dir/.complete"
fi
ln -sfn "$env_dir" /opt/kenan-image.new && mv -T /opt/kenan-image.new /opt/kenan-image
for old in $(ls -dt /opt/kenan-image-* 2>/dev/null | grep -v -x -e "$env_dir" | tail -n +2); do rm -rf "$old"; done

read -r repo revision < "$src/model.txt"
models=/var/lib/kenan/models/image
dest=$models/sd-turbo
if [[ $(cat "$dest/.revision" 2>/dev/null) != "$revision" ]]; then
 install -d -m 0755 /var/lib/kenan/models "$models"
 rm -rf "$dest.partial"
 HF_HUB_DISABLE_TELEMETRY=1 /opt/kenan-image/venv/bin/python -c 'import sys; from huggingface_hub import snapshot_download as s; s(sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3], allow_patterns=["*.json", "*.txt", "*fp16.safetensors"])' "$repo" "$revision" "$dest.partial"
 tail -n +2 "$src/model.txt" | while read -r file sha; do
  if [[ $(sha256sum "$dest.partial/$file" | cut -d' ' -f1) != "$sha" ]]; then echo "image_model_checksum: $file did not match $sha" >&2; rm -rf "$dest.partial"; exit 1; fi
 done
 rm -rf "$dest.partial/.cache"
 echo "$revision" > "$dest.partial/.revision"
 chmod -R a+rX "$dest.partial"
 rm -rf "$dest" && mv "$dest.partial" "$dest"
fi

install -d -m 0755 /var/lib/kenan/image-gen
[[ -f /var/lib/kenan/image-gen/lock ]] || install -m 0444 /dev/null /var/lib/kenan/image-gen/lock
install -d -m 0755 /usr/local/share/kenan/skills/image
install -m 0644 "$src/SKILL.md" /usr/local/share/kenan/skills/image/SKILL.md
install -D -m 0755 "$src/kenan-image" /usr/local/bin/kenan-image
