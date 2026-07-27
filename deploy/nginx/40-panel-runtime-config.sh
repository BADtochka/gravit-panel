#!/bin/sh
set -eu

panel_public_path="${PANEL_PUBLIC_PATH:-}"

case "$panel_public_path" in
  '') ;;
  /*) ;;
  *)
    echo "PANEL_PUBLIC_PATH must be empty or start with /" >&2
    exit 1
    ;;
esac

case "$panel_public_path" in
  *'//'*|*'..'*|*[!A-Za-z0-9._~/-]*)
    echo "PANEL_PUBLIC_PATH contains unsupported characters" >&2
    exit 1
    ;;
esac

panel_public_path="${panel_public_path%/}"
printf "window.__GRAVIT_PANEL_CONFIG__ = { publicPath: '%s' };\n" "$panel_public_path" \
  > /usr/share/nginx/html/panel-config.js
