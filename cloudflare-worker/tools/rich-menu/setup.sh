#!/usr/bin/env bash
# Creates the DM rich menu on the LINE OA, uploads the image and makes it the
# default for every 1:1 chat. Rich menus never show in groups.
#   bash tools/rich-menu/setup.sh            create + set default
#   bash tools/rich-menu/setup.sh list       show rich menus on the OA
#   bash tools/rich-menu/setup.sh off        remove the default (chips only)
#   bash tools/rich-menu/setup.sh delete ID  delete an old rich menu
# Token comes from System/.env (LINE_CHANNEL_ACCESS_TOKEN). Rich menu calls
# do not count against the monthly message quota.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/../../../.env"
TOKEN="$(grep -E '^LINE_CHANNEL_ACCESS_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
[ -n "$TOKEN" ] || { echo "LINE_CHANNEL_ACCESS_TOKEN not found in $ENV_FILE"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"
API=https://api.line.me/v2/bot

case "${1:-create}" in
  list)
    curl -sS -H "$AUTH" "$API/richmenu/list"; echo
    echo "default:"; curl -sS -H "$AUTH" "$API/user/all/richmenu"; echo
    exit 0 ;;
  delete)
    [ -n "${2:-}" ] || { echo "usage: setup.sh delete richmenu-..."; exit 1; }
    curl -sS -f -X DELETE -H "$AUTH" "$API/richmenu/$2" >/dev/null; echo "deleted $2"
    exit 0 ;;
  off)
    curl -sS -X DELETE -H "$AUTH" "$API/user/all/richmenu"; echo "default rich menu removed"
    exit 0 ;;
esac

curl -sS -H "$AUTH" -H 'Content-Type: application/json' \
  -d @"$HERE/richmenu.json" "$API/richmenu/validate" | grep -q '{}' \
  || { echo "LINE rejected richmenu.json"; exit 1; }

ID="$(curl -sS -H "$AUTH" -H 'Content-Type: application/json' \
  -d @"$HERE/richmenu.json" "$API/richmenu" | sed -n 's/.*"richMenuId":"\([^"]*\)".*/\1/p')"
[ -n "$ID" ] || { echo "create failed"; exit 1; }
echo "created $ID"

curl -sS -f -H "$AUTH" -H 'Content-Type: image/jpeg' \
  --data-binary @"$HERE/richmenu.jpg" "https://api-data.line.me/v2/bot/richmenu/$ID/content" >/dev/null
echo "image uploaded"

curl -sS -f -X POST -H "$AUTH" -H 'Content-Length: 0' "$API/user/all/richmenu/$ID" >/dev/null
echo "set as default for all users: $ID"
echo "Older menus stay on the OA; remove one with: bash $0 delete <id>"
