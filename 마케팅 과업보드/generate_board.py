#!/usr/bin/env python3
"""하루 마케팅 과업 보드 생성기.

keywords.json 의 키워드로 유튜브를 검색해 영상 링크를 모으고,
네이버 지식인 / 스레드 링크와 함께 docs/index.html 로 만든다 (GitHub Pages 로 공개).
댓글 완료로 체크된 영상은 구글 시트 기록에서 읽어 done_videos.json 에 모아 두고 다시 추천하지 않는다.
체크하지 못한 영상은 그날 검색 결과와 기준을 통과하면 다시 나올 수 있다.
(시트를 읽지 못한 날은 안전하게 예전처럼 한 번 보여준 영상을 모두 제외한다.)

급상승 판단: 하루 평균 조회수(조회수 / 업로드 후 경과 시간)로 순위를 매긴다.
검색에 걸린 영상의 조회수는 view_history.json 에 날짜별로 쌓아 두고,
전날 기록이 있는 영상은 실제 하루 증가량을 대신 사용한다.

환경변수 YT_API_KEY 가 있으면 YouTube Data API 를, 없으면 검색 페이지를 직접 읽는다.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "keywords.json"
SEEN = ROOT / "seen_videos.json"
DONE = ROOT / "done_videos.json"
DONE_LOOKBACK_DAYS = 7  # 며칠 전 보드까지 시트에서 완료 체크를 다시 읽을지
HISTORY = ROOT / "view_history.json"
OUT = ROOT.parent / "docs" / "index.html"  # GitHub Pages 는 저장소 루트의 docs 만 서비스한다
KST = dt.timezone(dt.timedelta(hours=9))

# sp 파라미터: 업로드 기간 필터 (week=이번 주, month=이번 달, relevance=기간 제한 없이 관련도순)
SORT_PARAMS = {"week": "EgQIAxAB", "month": "EgQIBBAB", "relevance": ""}
SORT_DAYS = {"week": 7, "month": 30, "relevance": None}
# "3일 전" 같은 업로드 시기 → 시간 단위
AGE_UNITS = {"초": 1 / 3600, "분": 1 / 60, "시간": 1, "일": 24, "주": 24 * 7, "개월": 24 * 30, "년": 24 * 365}
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"


def curl(url, timeout=20, tries=1):
    # macOS 기본 python 은 SSL 인증서가 없는 경우가 많아 시스템 curl 로 받아온다
    for i in range(tries):
        try:
            return _curl_once(url, timeout)
        except subprocess.CalledProcessError:
            if i == tries - 1:
                raise
            time.sleep(5)


def _curl_once(url, timeout):
    return subprocess.run(
        ["curl", "-sL", "--fail", "--max-time", str(timeout), "-A", UA, "-H", "Accept-Language: ko-KR,ko;q=0.9", url],
        capture_output=True, check=True).stdout.decode("utf-8", "replace")


def post_json(url, obj):
    # Apps Script 웹 앱은 text/plain 본문을 받는다 (응답 전에 302로 넘기므로 -L 로 따라간다)
    return subprocess.run(
        ["curl", "-sL", "--fail", "--max-time", "60", "-H", "Content-Type: text/plain;charset=utf-8",
         "--data-binary", "@-", url],
        input=json.dumps(obj, ensure_ascii=False).encode("utf-8"), capture_output=True, check=True
    ).stdout.decode("utf-8", "replace")


def parse_views(text):
    digits = re.sub(r"[^0-9]", "", text or "")
    return int(digits) if digits else None


def parse_age_hours(text):
    m = re.search(r"(\d+)\s*(초|분|시간|일|주|개월|년)", text or "")
    return int(m.group(1)) * AGE_UNITS[m.group(2)] if m else None


def korean_ago(hours):
    for unit, h in (("년", 24 * 365), ("개월", 24 * 30), ("주", 24 * 7), ("일", 24), ("시간", 1)):
        if hours >= h:
            return f"{int(hours // h)}{unit} 전"
    return "방금 전"


def iso_duration(s):
    m = re.fullmatch(r"P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return ""
    h, mi, se = (int(x or 0) for x in m.groups())
    return f"{h}:{mi:02d}:{se:02d}" if h else f"{mi}:{se:02d}"


def views_per_day(v, history, today):
    """하루 조회수 증가량. 전날 이후 기록이 있으면 실측값, 없으면 업로드 이후 평균."""
    past = {d: n for d, n in history.get(v["id"], {}).items() if d < today}
    if past and v["view_count"] is not None:
        last_day = max(past)
        days = (dt.date.fromisoformat(today) - dt.date.fromisoformat(last_day)).days
        return (v["view_count"] - past[last_day]) / days, "measured"
    if v["view_count"] is None or v["age_hours"] is None:
        return 0, None
    # 막 올라온 영상의 과대평가를 막기 위해 최소 6시간으로 본다
    return v["view_count"] / max(v["age_hours"], 6) * 24, "average"


def fetch_done_videos(api_url, key, today):
    """최근 며칠 보드에서 댓글 완료로 체크된 영상 ID. 하루라도 못 읽으면 None."""
    done = set()
    for back in range(DONE_LOOKBACK_DAYS + 1):
        day = (dt.date.fromisoformat(today) - dt.timedelta(days=back)).isoformat()
        # Apps Script 웹 앱은 한동안 안 쓰면 첫 응답이 20초를 넘기기도 해서 넉넉히 기다리고 한 번 더 시도한다
        res = json.loads(curl(f"{api_url}?k={urllib.parse.quote(key)}&date={day}", timeout=60, tries=2))
        if "error" in res:
            raise RuntimeError(res["error"])
        done |= {k[3:] for k, it in res.get("items", {}).items() if k.startswith("yt:") and it.get("done")}
    return done


def fetch_top_comments(vid, key, n=10):
    """인기 댓글 n개 ("좋아요 수 · 내용"). 댓글이 막힌 영상은 빈 목록."""
    try:
        res = json.loads(curl("https://www.googleapis.com/youtube/v3/commentThreads?" + urllib.parse.urlencode(
            {"part": "snippet", "videoId": vid, "order": "relevance", "maxResults": n, "textFormat": "plainText", "key": key})))
    except Exception:
        return []
    out = []
    for it in res.get("items", []):
        c = it["snippet"]["topLevelComment"]["snippet"]
        out.append(f"{c.get('likeCount', 0)} · " + re.sub(r"\s+", " ", c.get("textDisplay", "")).strip()[:300])
    return out


def send_video_info(api_url, key, today, videos, api_key):
    """오늘 영상의 설명란 · 인기 댓글을 비공개 기록 시트(yt 탭)로 보낸다. 댓글안은 클라우드 루틴이 채운다."""
    info = []
    now = dt.datetime.now(KST)
    for v in videos:
        # 업로드 시각은 설명란 맨 앞에 붙여 보낸다 (루틴이 영상 나이에 맞춰 사용 기간을 쓰게, 시트 열은 그대로)
        uploaded = ""
        if v.get("age_hours") is not None:
            uploaded = f"[업로드 {(now - dt.timedelta(hours=v['age_hours'])):%Y-%m-%d %H:%M} KST]\n"
        info.append({"id": v["id"], "title": v["title"], "channel": v.get("channel", ""), "length": v.get("length", ""),
                     "views": v.get("views", ""), "description": (uploaded + v.get("description", ""))[:3000],
                     "comments": "\n".join(fetch_top_comments(v["id"], api_key)) if api_key else ""})
    res = json.loads(post_json(api_url, {"k": key, "date": today, "action": "ytInfo", "videos": info}))
    if "error" in res:
        raise RuntimeError(res["error"])
    print(f"영상 정보 {len(info)}개를 기록 시트로 보냄 (댓글안은 8시 루틴이 작성)")


def fetch_videos_scrape(keyword, sort):
    url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(keyword)
    if SORT_PARAMS.get(sort):
        url += "&sp=" + SORT_PARAMS[sort]
    page = curl(url)
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", page, re.S)
    if not m:
        return []
    data = json.loads(m.group(1))

    def walk(o):
        if isinstance(o, dict):
            if "videoRenderer" in o:
                yield o["videoRenderer"]
            for v in o.values():
                yield from walk(v)
        elif isinstance(o, list):
            for v in o:
                yield from walk(v)

    videos = []
    for v in walk(data):
        text = lambda k: v.get(k, {}).get("simpleText") or "".join(r.get("text", "") for r in v.get(k, {}).get("runs", []))
        videos.append({
            "id": v["videoId"],
            "title": text("title"),
            "channel": text("ownerText"),
            "published": text("publishedTimeText"),
            "views": text("viewCountText"),
            "length": text("lengthText"),
            "view_count": parse_views(text("viewCountText")),
            "age_hours": parse_age_hours(text("publishedTimeText")),
        })
    return videos


def fetch_videos_api(keyword, sort, key):
    params = {"part": "snippet", "q": keyword, "type": "video", "maxResults": 20,
              "regionCode": "KR", "relevanceLanguage": "ko", "key": key}
    if SORT_DAYS.get(sort):
        since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=SORT_DAYS[sort])
        params["publishedAfter"] = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    search = json.loads(curl("https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode(params)))
    ids = [it["id"]["videoId"] for it in search.get("items", [])]
    if not ids:
        return []
    detail = json.loads(curl("https://www.googleapis.com/youtube/v3/videos?" + urllib.parse.urlencode(
        {"part": "snippet,statistics,contentDetails", "id": ",".join(ids), "key": key})))
    now = dt.datetime.now(dt.timezone.utc)
    by_id = {it["id"]: it for it in detail.get("items", [])}
    videos = []
    for vid in ids:  # 검색 순서 유지
        it = by_id.get(vid)
        if not it:
            continue
        sn, st = it["snippet"], it.get("statistics", {})
        age = (now - dt.datetime.fromisoformat(sn["publishedAt"].replace("Z", "+00:00"))).total_seconds() / 3600
        count = int(st["viewCount"]) if "viewCount" in st else None
        videos.append({
            "id": vid,
            "title": sn["title"],
            "channel": sn["channelTitle"],
            "published": korean_ago(age),
            "views": f"조회수 {count:,}회" if count is not None else "",
            "length": iso_duration(it.get("contentDetails", {}).get("duration")),
            "view_count": count,
            "age_hours": age,
            "description": sn.get("description", ""),
        })
    return videos


def main():
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    seen = json.loads(SEEN.read_text(encoding="utf-8")) if SEEN.exists() else {}
    history = json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else {}
    today = dt.datetime.now(KST).date().isoformat()
    per_kw = cfg.get("videos_per_keyword", 4)
    sort = cfg.get("sort", "month")
    hot_count = cfg.get("trending_count", 8)
    hot_min = cfg.get("trending_min_views_per_day", 500)
    topic = cfg.get("trending_topic_words", [])
    api_key = os.environ.get("YT_API_KEY")
    print("유튜브 수집:", "YouTube Data API" if api_key else "검색 페이지")

    # 오늘 이미 생성했다면 같은 영상 목록을 유지 (재실행해도 바뀌지 않게)
    todays_ids = {vid for vid, day in seen.items() if day == today}

    # 댓글 완료 영상 목록 (시트 기록 + 지난 실행까지 모아 둔 것)
    done = set(json.loads(DONE.read_text(encoding="utf-8"))) if DONE.exists() else set()
    read_key = os.environ.get("BOARD_READ_KEY")
    try:
        if not (cfg.get("api_url") and read_key):
            raise RuntimeError("BOARD_READ_KEY 없음")
        done |= fetch_done_videos(cfg["api_url"], read_key, today)
        exclude = lambda vid: vid in done
        print(f"댓글 완료 영상 {len(done)}개 제외 (미완료 영상은 다시 추천 가능)")
    except Exception as e:
        exclude = lambda vid: vid in seen
        print(f"[경고] 완료 기록을 읽지 못해 이전에 보여준 영상을 모두 제외합니다: {e}", file=sys.stderr)
    DONE.write_text(json.dumps(sorted(done), indent=0), encoding="utf-8")

    # 1) 키워드별 검색 결과 수집 + 조회수 기록
    searches = []
    for kind, key in (("타겟 검색 키워드", "search_keywords"), ("타겟 시청 콘텐츠", "content_keywords")):
        for kw in cfg.get(key, []):
            try:
                found = fetch_videos_api(kw, sort, api_key) if api_key else fetch_videos_scrape(kw, sort)
            except Exception as e:  # 네트워크 오류 등은 해당 키워드만 건너뜀
                print(f"[경고] '{kw}' 검색 실패: {e}", file=sys.stderr)
                found = []
            for v in found:
                v["keyword"] = kw
                v["rate"], v["rate_kind"] = views_per_day(v, history, today)
                if v["view_count"] is not None:
                    history.setdefault(v["id"], {})[today] = v["view_count"]
            searches.append((kind, kw, found))

    fresh = lambda v: not exclude(v["id"]) or v["id"] in todays_ids

    # 2) 전체 후보 중 하루 조회수 상위 → 급상승 그룹 (맨 위에 노출)
    candidates = {}
    for _, _, found in searches:
        for v in found:
            # 검색어와 느슨하게만 엮인 인기 영상이 끼지 않도록 제목에 주제어가 있어야 함
            on_topic = not topic or any(t in v["title"] for t in topic)
            if fresh(v) and on_topic and v["rate"] >= hot_min:
                candidates.setdefault(v["id"], v)
    hot = sorted(candidates.values(), key=lambda v: v["rate"], reverse=True)[:hot_count]
    used = {v["id"] for v in hot}
    groups = [{"kind": "급상승", "keyword": "🔥 조회수 급상승 영상", "videos": hot, "hot": True}]
    print(f"  급상승: {len(hot)}개")

    # 3) 나머지는 키워드별로 (그룹 안에서도 하루 조회수 높은 순)
    for kind, kw, found in searches:
        picked = []
        for v in sorted(found, key=lambda v: v["rate"], reverse=True):
            if v["id"] in used or not fresh(v):
                continue
            picked.append(v)
            used.add(v["id"])
            if len(picked) >= per_kw:
                break
        groups.append({"kind": kind, "keyword": kw, "videos": picked,
                       "search_url": "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(kw)})
        print(f"  {kw}: {len(picked)}개")

    if not used:
        sys.exit("영상을 하나도 가져오지 못했어요. 기존 보드를 유지합니다.")

    # 오늘 보드에 올린 영상 정보를 기록 시트로 (실패해도 보드는 그대로 만든다)
    if cfg.get("api_url") and read_key:
        by_id = {v["id"]: v for _, _, found in searches for v in found}
        try:
            send_video_info(cfg["api_url"], read_key, today, [by_id[vid] for vid in by_id if vid in used], api_key)
        except Exception as e:
            print(f"[경고] 영상 정보를 기록 시트로 보내지 못했어요: {e}", file=sys.stderr)

    for vid in used:
        seen.setdefault(vid, today)
    SEEN.write_text(json.dumps(seen, ensure_ascii=False, indent=1), encoding="utf-8")
    # 30일 지난 조회수 기록은 정리
    cutoff = (dt.date.fromisoformat(today) - dt.timedelta(days=30)).isoformat()
    history = {vid: kept for vid, days in history.items() if (kept := {d: n for d, n in days.items() if d >= cutoff})}
    HISTORY.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")

    data = {
        "date": today,
        "groups": groups,
        "kin_url": cfg.get("naver_kin_url", "https://kin.naver.com/qna/questionList.naver"),
        "kin_search_url": "https://kin.naver.com/search/list.naver?query="
                          + urllib.parse.quote(cfg.get("naver_kin_query", "허벅지")) + "&sort=date",
        "kin_query": cfg.get("naver_kin_query", "허벅지"),
        "threads_url": cfg["threads_url"],
        "sheet_url": cfg["sheet_url"],
        "api_url": cfg.get("api_url", ""),
        "members": cfg.get("members", {"manager": "팀장", "member": "규태"}),
    }
    template = (ROOT / "board_template.html").read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(template.replace("/*__DATA__*/null", payload), encoding="utf-8")
    print(f"보드 생성 완료: {OUT}  (영상 {len(used)}개)")


if __name__ == "__main__":
    main()
