#!/bin/sh
set -eu

config=/app/data/LaunchServer.json

if [ -f "$config" ] && [ -n "${ADDRESS:-}" ]; then
  case "$ADDRESS" in
    localhost|localhost:*|127.0.0.1|127.0.0.1:*|'[::1]'|'[::1]:'*)
      secure=false
      ;;
    *:*)
      port=${ADDRESS##*:}
      [ "$port" = 443 ] && secure=true || secure=false
      ;;
    *)
      secure=true
      ;;
  esac

  if [ "$secure" = true ]; then
    http_origin="https://$ADDRESS"
    websocket_origin="wss://$ADDRESS"
  else
    http_origin="http://$ADDRESS"
    websocket_origin="ws://$ADDRESS"
  fi

  # The nginx facades use the updates directory itself as their document root,
  # so public URLs must be root-relative to it. Read updatesDir to strip a
  # duplicated "/<updatesDir>/" prefix that would otherwise resolve to
  # "<updatesDir>/<updatesDir>/..." and 404 every artifact download.
  updates_dir=$(jq -r '.updatesProvider.updatesDir // "updates"' "$config" 2>/dev/null || printf 'updates')
  case "$updates_dir" in
    ''|*[!A-Za-z0-9._-]*|*/*) updates_dir=updates ;;
  esac
  updates_dir_escaped=$(printf '%s' "$updates_dir" | sed 's|\.|\\.|g')

  pending=$(mktemp "${config}.pending.XXXXXX")
  trap 'rm -f "$pending"' EXIT
  jq \
    --arg http_origin "$http_origin" \
    --arg websocket_origin "$websocket_origin" \
    --arg updates_dir "$updates_dir_escaped" \
    '
      def rewrite($origin):
        if type != "string" then . else
          gsub("^(https?|wss?)://[^/]+"; $origin)
        end;
      def normalize_updates_path:
        if type != "string" then . else
          if test("^(https?|wss?)://[^/]+/" + $updates_dir + "/")
          then sub("^(?<o>(https?|wss?)://[^/]+)/" + $updates_dir + "/"; "\(.o)/")
          else . end
        end;
      if (.updatesProvider.urls? | type) == "object" then
        .updatesProvider.urls |= with_entries(
          .value |= (rewrite($http_origin) | normalize_updates_path)
        )
      else . end |
      if (.netty.downloadURL? | type) == "string" then
        .netty.downloadURL |= (rewrite($http_origin) | normalize_updates_path)
      else . end |
      if (.netty.address? | type) == "string" then
        .netty.address |= rewrite($websocket_origin)
      else . end
    ' "$config" > "$pending"

  if ! cmp -s "$config" "$pending"; then
    backup="${config}.backup-address-$(date -u +%Y-%m-%dT%H-%M-%S-%NZ)"
    cp "$config" "$backup"
    mv "$pending" "$config"
    trap - EXIT
    echo "Synchronized LaunchServer public URLs to $ADDRESS" >&2
  fi
fi

exec "${LAUNCHSERVER_COMMAND:-/app/bin/launchserver}" "$@"
