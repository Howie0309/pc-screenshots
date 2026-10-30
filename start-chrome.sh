#!/bin/sh
# 用独立的用户目录启动本机 Chrome，并开启本地调试端口供脚本连接。
# 首次启动后在这个窗口里手动登录 chatgpt.com，登录态会保存在 .chrome-profile 中。
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${CDP_PORT:-9222}"

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$DIR/.chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1440,900 \
  "https://chatgpt.com/" >/dev/null 2>&1 &

echo "Chrome 已启动（调试端口 127.0.0.1:$PORT）。首次使用请在窗口中登录 ChatGPT，然后运行：npm run shot -- queries.txt"
