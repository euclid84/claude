// Apps Script 서비스(SpreadsheetApp, DriveApp, CacheService ...)를 메모리로 흉내 내서
// dist/Code.gs 를 Node 에서 그대로 실행하기 위한 테스트용 가짜 환경.
const crypto = require('crypto');
const vm = require('vm');
const fs = require('fs');

function signed(buf) { return Array.from(buf, b => (b > 127 ? b - 256 : b)); }
function unsigned(arr) { return Buffer.from(arr.map(b => (b < 0 ? b + 256 : b))); }

function makeSheet(name) {
  const rows = []; // 2D array
  const norm = v => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
  const sheet = {
    name,
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(r, c, nr, nc) {
      if (typeof r === 'string') return { setWrap() {} };
      nr = nr || 1; nc = nc || 1;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (rows[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); }
          return out;
        },
        setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => { while (rows.length < r + i) rows.push([]); rows[r - 1 + i][c - 1 + j] = norm(v); })); return this; },
        setValue(v) { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = norm(v); return this; },
        setFontWeight() { return this; }
      };
    },
    appendRow(vals) { rows.push(vals.map(norm)); },
    deleteRow(r) { rows.splice(r - 1, 1); },
    setFrozenRows() {}, setColumnWidth() {},
    _rows: rows
  };
  return sheet;
}

function createGas({ geminiReply }) {
  const sheets = {};
  const ss = {
    getId: () => 'SS1',
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: s => { delete sheets[s.name]; }
  };
  const props = {}; const cache = {}; const files = {};
  let fileSeq = 0;
  const ctx = {
    console, Logger: { log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, getUi() { throw new Error('no ui'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, str) => signed(crypto.createHash('sha256').update(typeof str === 'string' ? Buffer.from(str, 'utf8') : unsigned(str)).digest()),
      computeHmacSha256Signature: (v, key) => signed(crypto.createHmac('sha256', key).update(v).digest()),
      base64Encode: arr => unsigned(arr).toString('base64'),
      base64Decode: s => signed(Buffer.from(s, 'base64')),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      formatDate: (d, tz, f) => {
        const k = new Date(d.getTime() + 9 * 3600e3);
        if (f === 'u') { const w = k.getUTCDay(); return String(w === 0 ? 7 : w); }
        return k.toISOString().slice(0, 10);
      }
    },
    DriveApp: {
      createFolder: () => ({ getId: () => 'FOLDER' }),
      getFolderById: () => ({
        createFile(blob) {
          const id = 'F' + (++fileSeq);
          const f = { id, desc: '', trashed: false, bytes: blob.bytes,
            getId: () => id, setDescription(d) { f.desc = d; }, getDescription: () => f.desc,
            isTrashed: () => f.trashed, setTrashed(t) { f.trashed = t; }, getBlob: () => ({ getBytes: () => f.bytes }) };
          files[id] = f; return f;
        }
      }),
      getFileById: id => { if (!files[id]) throw new Error('not found'); return files[id]; }
    },
    UrlFetchApp: {
      fetch(url, opts) {
        const body = JSON.parse(opts.payload);
        const text = geminiReply(body);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) };
      }
    },
    HtmlService: {}
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'dist', 'Code.gs'), 'utf8'), ctx);
  return { ctx, sheets, props, files };
}

module.exports = { createGas };
