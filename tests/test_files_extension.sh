#!/bin/sh
# Builds the Files extension with a test harness and runs it on a private bus
# without activatable services, so neither Files nor GNOME Shell is involved.
set -eu
repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
build="$(mktemp -d /tmp/gnome-assistant-files-test.XXXXXX)"
trap 'rm -rf "$build"' EXIT
flags="$(pkg-config --cflags --libs libnautilus-extension-4)"
# shellcheck disable=SC2086
cc -g -Wall -Wextra -Werror -Wno-unused-parameter -o "$build/test" \
    "$repo/tests/test_files_extension.c" "$repo/nautilus/gnome-assistant-files.c" $flags
# Settings come from the repository schema and an in-memory backend, and the
# data folder is empty, so the user's own settings are never read.
mkdir -p "$build/schemas" "$build/data"
cp "$repo"/schemas/*.xml "$build/schemas/"
glib-compile-schemas --strict "$build/schemas"
env -u WAYLAND_DISPLAY -u DISPLAY GSETTINGS_SCHEMA_DIR="$build/schemas" GSETTINGS_BACKEND=memory \
    XDG_DATA_HOME="$build/data" dbus-run-session --config-file="$repo/tests/private-bus.conf" -- "$build/test"
