#!/bin/zsh
# 더블클릭하면: 보드 + 네이버 지식인 + 스레드 + 시트를 크롬에 띄움
# (보드는 매일 9시에 자동 생성됨. 오늘 보드가 아직 없을 때만 여기서 생성)
cd "$(dirname "$0")"
if [[ ! -f board.html || $(date -r board.html +%F) != $(date +%F) ]]; then
  python3 generate_board.py || exit 1
fi

KIN=$(python3 -c 'import json;print(json.load(open("keywords.json")).get("naver_kin_url","https://kin.naver.com/qna/questionList.naver"))')
THREADS=$(python3 -c 'import json;print(json.load(open("keywords.json"))["threads_url"])')
SHEET=$(python3 -c 'import json;print(json.load(open("keywords.json"))["sheet_url"])')

# 보드 서버가 꺼져 있으면 다시 켬
curl -s -o /dev/null http://localhost:8765/ || launchctl kickstart gui/$(id -u)/com.jun.marketing-board-server
open -a "Google Chrome" "http://localhost:8765/" "$KIN" "$THREADS" "$SHEET"
