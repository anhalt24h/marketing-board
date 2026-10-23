/**
 * 마케팅 보드 백엔드 (Google Apps Script 웹 앱).
 * 이 스크립트가 붙은 구글 시트에 할당 · 체크 · 수행율 · 피드백을 기록한다.
 *
 * 시트 탭 (없으면 자동 생성)
 *   items    : 날짜 | 항목키 | 항목명 | 분류 | 담당 | 완료 | 완료자 | 완료시각
 *   log      : 날짜 | 담당 | 할당 | 완료 | 수행율(%) | 갱신시각 | 업무시작 | 마지막완료 | 순작업(분)
 *   feedback : 날짜 | 받는사람 | 내용 | 작성시각
 *   quota    : 날짜 | 분류 | 담당 | 목표건수 | 갱신시각   (그날 값이 없으면 가장 최근 값을 이어서 씀)
 *
 * 접근 키: 보드 링크 끝의 #k=... 값. 관리자 키는 할당/피드백까지, 팀원 키는 본인 과업 체크만 가능.
 */
const KEYS = {
  '__MANAGER_KEY__': 'manager',
  '__MEMBER_KEY__': 'member',
};

const TABS = {
  items: ['날짜', '항목키', '항목명', '분류', '담당', '완료', '완료자', '완료시각'],
  log: ['날짜', '담당', '할당', '완료', '수행율(%)', '갱신시각', '업무시작', '마지막완료', '순작업(분)'],
  feedback: ['날짜', '받는사람', '내용', '작성시각'],
  quota: ['날짜', '분류', '담당', '목표건수', '갱신시각'],
};

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(TABS[name]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < TABS[name].length) {
    sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]);  // 열이 늘어난 경우 머리글 보강
  }
  return sh;
}

const DAY_ = c => c instanceof Date ? Utilities.formatDate(c, 'Asia/Seoul', 'yyyy-MM-dd') : c;

// 항목키에 담당이 들어 있는 경우 (kin:member:3, threads:manager:1, start:member)
function ownerFromKey_(key) {
  const m = /^(?:kin|threads|start):(manager|member)\b/.exec(key);
  return m ? m[1] : null;
}

function quotas_(date) {
  const q = { kin: { manager: 1, member: 0 }, threads: { manager: 1, member: 0 } };
  const best = {};
  rows_('quota').forEach(r => {
    const k = r[1] + '/' + r[2];
    if (r[0] <= date && (!best[k] || best[k] <= r[0]) && q[r[1]]) { best[k] = r[0]; q[r[1]][r[2]] = Number(r[3]) || 0; }
  });
  return q;
}

function rows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  values.shift();
  // 날짜 셀이 Date 로 바뀌어 있어도 문자열로 비교할 수 있게
  return values.map(r => r.map((c, i) => i === 0 && c instanceof Date
    ? Utilities.formatDate(c, 'Asia/Seoul', 'yyyy-MM-dd') : c));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function dayState_(role, date) {
  const items = {};
  rows_('items').filter(r => r[0] === date).forEach(r => {
    items[r[1]] = { label: r[2], cat: r[3], assignee: r[4] || 'manager', done: r[5] === true, doneBy: r[6], doneAt: r[7] };
  });
  const feedback = rows_('feedback')
    .filter(r => role === 'manager' || r[1] === role)
    .map(r => ({ date: r[0], to: r[1], text: r[2], at: r[3] }))
    .slice(-60);
  const log = rows_('log')
    .filter(r => role === 'manager' || r[1] === role)
    .map(r => ({ date: r[0], person: r[1], assigned: r[2], done: r[3], pct: r[4], start: r[6] || null, end: r[7] || null, workMin: r[8] === '' ? null : r[8] }));
  return { role, items, feedback, log, quotas: quotas_(date), now: new Date() };
}

// 항목 한 줄을 찾아서 고치고, 없으면 새로 추가
function upsertItem_(date, it, patch) {
  const sh = sheet_('items');
  const values = sh.getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < values.length; i++) {
    const d = values[i][0] instanceof Date ? Utilities.formatDate(values[i][0], 'Asia/Seoul', 'yyyy-MM-dd') : values[i][0];
    if (d === date && values[i][1] === it.key) {
      const row = values[i];
      if ('assignee' in patch) row[4] = patch.assignee;
      if ('done' in patch) { row[5] = patch.done; row[6] = patch.done ? patch.by : ''; row[7] = patch.done ? now : ''; }
      sh.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  sh.appendRow([date, it.key, it.label || '', it.cat || '', patch.assignee || 'manager',
    !!patch.done, patch.done ? patch.by : '', patch.done ? now : '']);
}

function doGet(e) {
  const role = KEYS[e.parameter.k];
  if (!role) return json_({ error: 'invalid key' });
  return json_(dayState_(role, e.parameter.date));
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const role = KEYS[body.k];
  if (!role) return json_({ error: 'invalid key' });
  const date = body.date;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.action === 'check') {
      // 팀원은 본인에게 할당된 항목만 체크 가능
      const cur = dayState_('manager', date).items[body.item.key];
      const owner = ownerFromKey_(body.item.key);
      const assignee = owner || (cur ? cur.assignee : 'manager');
      if (role === 'member' && assignee !== 'member') return json_({ error: 'not assigned' });
      upsertItem_(date, body.item, cur ? { done: !!body.done, by: role } : { done: !!body.done, by: role, assignee });
    } else if (body.action === 'assign') {
      if (role !== 'manager') return json_({ error: 'manager only' });
      body.items.forEach(it => upsertItem_(date, it, { assignee: body.assignee }));
    } else if (body.action === 'quota') {
      if (role !== 'manager') return json_({ error: 'manager only' });
      const sh = sheet_('quota');
      const values = sh.getDataRange().getValues();
      const row = [date, body.cat, body.person, Math.max(0, Math.min(50, Number(body.n) || 0)), new Date()];
      let found = false;
      for (let i = 1; i < values.length; i++) {
        if (DAY_(values[i][0]) === date && values[i][1] === body.cat && values[i][2] === body.person) {
          sh.getRange(i + 1, 1, 1, 5).setValues([row]); found = true; break;
        }
      }
      if (!found) sh.appendRow(row);
    } else if (body.action === 'feedback') {
      if (role !== 'manager') return json_({ error: 'manager only' });
      if (String(body.text || '').trim()) sheet_('feedback').appendRow([date, body.to, String(body.text).trim(), new Date()]);
    }
    // 화면에서 계산한 사람별 수행율을 log 에 반영 (날짜+담당 기준으로 덮어쓰기)
    if (body.summary) {
      const sh = sheet_('log');
      const values = sh.getDataRange().getValues();
      body.summary.forEach(s => {
        const row = [date, s.person, s.assigned, s.done, s.pct == null ? '' : s.pct, new Date(),
          s.start ? new Date(s.start) : '', s.end ? new Date(s.end) : '', s.workMin == null ? '' : s.workMin];
        let found = false;
        for (let i = 1; i < values.length; i++) {
          const d = values[i][0] instanceof Date ? Utilities.formatDate(values[i][0], 'Asia/Seoul', 'yyyy-MM-dd') : values[i][0];
          if (d === date && values[i][1] === s.person) { sh.getRange(i + 1, 1, 1, row.length).setValues([row]); found = true; break; }
        }
        if (!found) sh.appendRow(row);
      });
    }
  } finally {
    lock.releaseLock();
  }
  return json_(dayState_(role, date));
}
