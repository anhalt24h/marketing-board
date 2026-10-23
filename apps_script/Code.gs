/**
 * 마케팅 보드 백엔드 (Google Apps Script 웹 앱).
 * 이 스크립트가 붙은 구글 시트에 할당 · 체크 · 수행율 · 피드백을 기록한다.
 *
 * 시트 탭 (없으면 자동 생성)
 *   items    : 날짜 | 항목키 | 항목명 | 분류 | 담당 | 완료 | 완료자 | 완료시각
 *   log      : 날짜 | 담당 | 할당 | 완료 | 수행율(%) | 갱신시각 | 업무시작 | 마지막완료 | 순작업(분)
 *   feedback : 날짜 | 받는사람 | 내용 | 작성시각
 *   quota    : 날짜 | 분류 | 담당 | 목표건수 | 갱신시각   (그날 값이 없으면 가장 최근 값을 이어서 씀)
 *   worklog  : 날짜 | 담당 | 분류 | 과업 | 시작 | 완료 | 소요(분) | 비고   (과업 1건마다 1줄, 체크할 때마다 그날 분량을 다시 씀)
 *   notice   : ID | 분류 | 종류 | 대상 | 내용 | 작성시각 | 사용   (과업별 공지 · 피드백, 지울 때는 사용=FALSE)
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
  worklog: ['날짜', '담당', '분류', '과업', '시작', '완료', '소요(분)', '비고'],
  notice: ['ID', '분류', '종류', '대상', '내용', '작성시각', '사용'],
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
  const worklog = rows_('worklog')
    .filter(r => r[0] === date && (role === 'manager' || r[1] === role))
    .map(r => ({ person: r[1], cat: r[2], label: r[3], from: r[4] || null, at: r[5] || null, min: r[6] === '' ? null : r[6], note: r[7] }));
  const notices = sheet_('notice').getDataRange().getValues().slice(1)
    .filter(r => r[6] !== false && (role === 'manager' || r[3] === 'all' || r[3] === role))
    .map(r => ({ id: String(r[0]), cat: r[1], kind: r[2], target: r[3], text: r[4], at: r[5] }));
  return { role, items, feedback, log, quotas: quotas_(date), worklog, notices, now: new Date() };
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
    } else if (body.action === 'noticeAdd') {
      if (role !== 'manager') return json_({ error: 'manager only' });
      const text = String(body.text || '').trim();
      if (text) sheet_('notice').appendRow([Utilities.getUuid().slice(0, 8), body.cat, body.kind, body.target, text, new Date(), true]);
    } else if (body.action === 'noticeRemove') {
      if (role !== 'manager') return json_({ error: 'manager only' });
      const sh = sheet_('notice');
      const values = sh.getDataRange().getValues();
      for (let i = 1; i < values.length; i++) if (String(values[i][0]) === body.id) sh.getRange(i + 1, 7).setValue(false);
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
    // 그날의 과업별 소요시간을 worklog 에 통째로 다시 씀 (보통 맨 아래에 모여 있어 그 구간만 지우고 다시 추가)
    if (body.worklog) {
      const sh = sheet_('worklog');
      const values = sh.getDataRange().getValues();
      const idx = [];
      for (let i = 1; i < values.length; i++) if (DAY_(values[i][0]) === date) idx.push(i + 1);
      const contiguous = idx.length && idx[idx.length - 1] - idx[0] === idx.length - 1;
      // 맨 아래 구간이면 내용만 지움 (머리글 아래 행을 전부 삭제하는 건 시트가 허용하지 않음)
      if (contiguous && idx[idx.length - 1] === values.length) sh.getRange(idx[0], 1, idx.length, values[0].length).clearContent();
      else if (contiguous) sh.deleteRows(idx[0], idx.length);
      else for (let j = idx.length - 1; j >= 0; j--) sh.deleteRow(idx[j]);
      const rows = body.worklog.map(w => [date, w.person, w.cat, w.label, w.from ? new Date(w.from) : '',
        w.at ? new Date(w.at) : '', w.min == null ? '' : w.min, w.note || '']);
      if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    }
  } finally {
    lock.releaseLock();
  }
  return json_(dayState_(role, date));
}
