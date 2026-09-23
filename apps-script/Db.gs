/**
 * 스프레드시트를 간단한 테이블(DB)처럼 쓰기 위한 도우미 함수
 */

function getSs_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = getSs_().getSheetByName(name);
  if (!sh) throw new Error('시트 "' + name + '"가 없습니다. 관리자에게 초기 설정을 요청하세요.');
  return sh;
}

/** 시트 전체를 [{헤더: 값, _row: 행번호}] 배열로 읽는다 */
function readAll_(name) {
  const sh = sheet_(name);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const obj = { _row: i + 1 };
    for (let j = 0; j < headers.length; j++) {
      const v = values[i][j];
      obj[headers[j]] = v instanceof Date ? v.toISOString() : v;
    }
    out.push(obj);
  }
  return out;
}

function findRows_(name, column, value) {
  return readAll_(name).filter(function (r) { return String(r[column]) === String(value); });
}

/**
 * 문자열 앞에 작은따옴표를 붙여서 시트가 수식/숫자/날짜로 자동 변환하지 않게 한다.
 * (읽을 때는 작은따옴표 없이 원래 문자열이 돌아온다)
 */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v === '' ? '' : "'" + v;
  return v;
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  const headers = HEADERS[name];
  const row = headers.map(function (h) { return cell_(obj[h]); });
  sh.getRange(sh.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
}

/** 지정한 열만 부분 수정 */
function updateRow_(name, rowIndex, patch) {
  const sh = sheet_(name);
  const headers = HEADERS[name];
  Object.keys(patch).forEach(function (key) {
    const col = headers.indexOf(key);
    if (col === -1) throw new Error('알 수 없는 열: ' + key);
    sh.getRange(rowIndex, col + 1).setValue(cell_(patch[key]));
  });
}

/** 여러 행 삭제 (아래쪽부터 지워야 행번호가 밀리지 않는다) */
function deleteRows_(name, rowIndexes) {
  const sh = sheet_(name);
  rowIndexes.slice().sort(function (a, b) { return b - a; })
    .forEach(function (r) { sh.deleteRow(r); });
}

/** 동시 쓰기 충돌 방지용 잠금 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nowIso_() { return new Date().toISOString(); }

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '');
}
