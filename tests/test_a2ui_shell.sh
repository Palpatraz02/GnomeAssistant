#!/bin/sh
# Runs an isolated native renderer + ACP fixture; does not change desktop settings.
set -eu
repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
root="$(mktemp -d /tmp/gnome-assistant-a2ui.XXXXXX)"
printf 'Native test artifacts: %s\n' "$root"
export GNOME_ASSISTANT_SOURCE="$repo" GNOME_ASSISTANT_TEST_ROOT="$root"
export XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime" XDG_CONFIG_HOME="$root/config"
export XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache"
export LIBGL_ALWAYS_SOFTWARE=1 GDK_BACKEND=wayland WAYLAND_DISPLAY=a2ui-test
extension="$XDG_DATA_HOME/gnome-shell/extensions/a2ui-test@local"
mkdir -p "$extension/schemas" "$XDG_RUNTIME_DIR" "$root/workspace"
chmod 700 "$XDG_RUNTIME_DIR"
cp "$repo"/schemas/*.xml "$extension/schemas/"
cp "$repo/ai-search-symbolic.svg" "$extension/"
glib-compile-schemas --strict "$extension/schemas"
python3 - <<'PY'
import json, os, struct, zlib, wave
from pathlib import Path
source=Path(os.environ['GNOME_ASSISTANT_SOURCE'])
target=Path(os.environ['XDG_DATA_HOME'])/'gnome-shell/extensions/a2ui-test@local'
(target/'extension.js').write_text('export {default} from '+json.dumps((source/'tests/test_a2ui_shell.js').as_uri())+';\n')
(target/'metadata.json').write_text(json.dumps({'uuid':'a2ui-test@local','name':'A2UI test','description':'Isolated test','shell-version':['45','46','47','48','49','50','51']}))
def chunk(kind, data):
 return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data))
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',2,2,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0'+b'\x30\x80\xff'*2+b'\0'+b'\x30\x80\xff'*2))+chunk(b'IEND',b'')
(Path(os.environ['GNOME_ASSISTANT_TEST_ROOT'])/'workspace/preview.png').write_bytes(png)
with wave.open(str(Path(os.environ['GNOME_ASSISTANT_TEST_ROOT'])/'workspace/tone.wav'),'wb') as sound:
 sound.setparams((1,2,8000,0,'NONE','none'));sound.writeframes(b'\0'*(8000*2*3))
PY
gst-launch-1.0 -q videotestsrc num-buffers=90 ! video/x-raw,width=160,height=90,framerate=30/1 ! vp8enc deadline=1 ! webmmux ! filesink location="$root/workspace/video.webm"
# Keep artifacts (screenshots, logs) only when the run fails, or when asked:
# they are large and /tmp is often memory-backed.
result=0
timeout 130s dbus-run-session -- sh -c '
gsettings set org.gnome.shell enabled-extensions "[\"a2ui-test@local\"]"
# The virtual pointer can trip the top-left hot corner on its way to the
# prompt, which closes the overview mid-test. Pointer tests target the prompt.
gsettings set org.gnome.desktop.interface enable-hot-corners false
gnome-shell --headless --wayland --no-x11 --wayland-display a2ui-test --virtual-monitor 1280x900 > "$1/shell.log" 2>&1 &
pid=$!
trap "kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true" EXIT
for i in $(seq 1 480); do
    if rg -q "JS ERROR|already disposed" "$1/shell.log"; then cat "$1/shell.log"; exit 1; fi
    if rg -q "A2UI TEST PASSED" "$1/shell.log"; then cat "$1/shell.log"; exit 0; fi
    if rg -q "A2UI TEST FAILED" "$1/shell.log"; then cat "$1/shell.log"; exit 1; fi
    sleep .25
done
cat "$1/shell.log"
exit 1
' sh "$root" || result=$?
if [ "$result" -eq 0 ] && [ -z "${GNOME_ASSISTANT_KEEP_ARTIFACTS:-}" ]; then
    rm -rf "$root"
else
    printf 'Native test artifacts kept: %s\n' "$root"
fi
exit "$result"
