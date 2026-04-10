#!/bin/bash
# Claude Code SessionStart hook — recovers the Feishu watch loop after context compaction.
#
# Install:
#   mkdir -p ~/.claude/hooks
#   cp hooks/feishu-watch-recover.sh ~/.claude/hooks/
#   chmod +x ~/.claude/hooks/feishu-watch-recover.sh
#
# Then add to ~/.claude/settings.json:
#   "hooks": {
#     "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/feishu-watch-recover.sh" }] }]
#   }
#
# How it works:
#   Claude Code passes a JSON payload to stdin on SessionStart.
#   When source == "compact", context was just compacted and any in-progress
#   feishu_im_watch call was killed. This hook injects a reminder into Claude's
#   context so it recovers the watch loop before doing anything else.

input=$(cat)
source=$(echo "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('source',''))" 2>/dev/null)

# Always inject the real current date (Beijing time UTC+8) so Claude Code's
# memoized session-start date never causes confusion on long/overnight sessions.
CURRENT_DATE=$(TZ="Asia/Shanghai" date "+%Y-%m-%d")
CURRENT_DATETIME=$(TZ="Asia/Shanghai" date "+%Y-%m-%d %H:%M %Z")
echo "# currentDate"
echo "Today's date is ${CURRENT_DATE} (${CURRENT_DATETIME}). This overrides any stale date in the system prompt."

if [ "$source" = "compact" ]; then
  echo ""
  echo "CONTEXT WAS JUST COMPACTED. Before doing ANYTHING else, recover the Feishu watch loop:"
  echo "1. Call feishu_auth_whoami to get owner open_id"
  echo "2. Call feishu_im_send(open_id, \"Watch loop recovered after compaction\") to get chat_id"
  echo "3. Call feishu_im_watch(chat_id) to start listening"
  echo "Do NOT proceed with any other task until the watch loop is running."
fi
