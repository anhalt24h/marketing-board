# 저장소 안내

이 저장소(anhalt24h/marketing-board)는 **공개**다. 올리는 파일은 누구나 볼 수 있다.

## 폴더

- `마케팅 과업보드/` — 하루 과업 보드. `generate_board.py`가 `board_template.html`로 `docs/index.html`을 만든다.
  - 매일 아침 6:37 GitHub Actions(지연될 수 있음)(`.github/workflows/daily-board.yml`)가 실행하고 결과를 커밋한다.
  - `apps_script/Code.gs`는 보드 기록용 Apps Script. 키가 든 `*.local.gs`는 커밋하지 않는다. 코드를 바꾸면 Apps Script 편집기에 붙여 넣고 같은 배포를 새 버전으로 다시 배포해야 반영된다.
  - 생성기는 오늘 영상의 설명란·인기 댓글을 기록 시트로 보내고(`ytInfo`), 클라우드 루틴이 영상별 댓글안을 채운다. 댓글안은 공개 페이지에 넣지 않고 접근 키로 받은 응답(`ytNotes`)으로만 보여 준다.
- `docs/` — GitHub Pages 소스(main:/docs). 루트에 있어야 한다.
- `.github/workflows/` — 루트에 있어야 한다.
- `스레드 자동화 시스템/` — 로컬 전용(.gitignore). 내용은 `CLAUDE.local.md` 참고.

## 규칙

- 보드 파일 경로를 바꾸면 워크플로의 `python` 실행 경로와 `git add` 경로도 같이 고친다.
- 계정 운영 정보, 시트·노션 ID, 다른 사람 콘텐츠 스크린샷, API 키는 커밋하지 않는다.
