#!/bin/zsh
# 더블클릭하면: 보드 + 네이버 지식인 + 스레드 + 시트를 크롬에 띄움 (보드는 매일 9시 클라우드에서 자동 갱신)
cd "$(dirname "$0")"
open -a "Google Chrome" "https://anhalt24h.github.io/marketing-board/" \
  "$(python3 -c 'import json;print(json.load(open("keywords.json"))["naver_kin_url"])')" \
  "$(python3 -c 'import json;print(json.load(open("keywords.json"))["threads_url"])')" \
  "$(python3 -c 'import json;print(json.load(open("keywords.json"))["sheet_url"])')"
