#!/bin/sh
set -eu

# PANEL_PUBLIC_URL is the single source of truth. publicPath is derived from
# its path component. PANEL_PUBLIC_PATH can still be set as an explicit override
# for edge cases where the path in the URL does not match the reverse-proxy
# prefix that gets stripped before reaching this container.
derive_path_from_url() {
  url="$1"
  path=$(printf '%s' "$url" | sed -n 's|^[a-z][a-z0-9+.-]*://[^/]*||p')
  if [ -z "$path" ]; then
    echo ""
  else
    echo "$path" | sed 's|/*$||'
  fi
}

panel_public_path="${PANEL_PUBLIC_PATH:-}"
if [ -z "$panel_public_path" ] && [ -n "${PANEL_PUBLIC_URL:-}" ]; then
  panel_public_path=$(derive_path_from_url "$PANEL_PUBLIC_URL")
fi

case "$panel_public_path" in
  ''|/) ;;
  /*) ;;
  *)
    echo "publicPath must be empty, '/', or start with /" >&2
    exit 1
    ;;
esac

case "$panel_public_path" in
  *'//'*|*'..'*|*[!A-Za-z0-9._~/-]*)
    echo "publicPath contains unsupported characters" >&2
    exit 1
    ;;
esac

panel_public_path="${panel_public_path%/}"
panel_base_href="${panel_public_path:-/}/"
if [ "$panel_public_path" = "" ]; then
  panel_base_href="/"
fi

printf "window.__GRAVIT_PANEL_CONFIG__ = { publicPath: '%s' };\n" "$panel_public_path" \
  > /usr/share/nginx/html/panel-config.js
sed -i "s|__GRAVIT_PANEL_BASE_HREF__|$panel_base_href|g" /usr/share/nginx/html/index.html
