/**
 * 진료기록 / 사진 / 질의응답 / 의사 설정 저장
 *
 * 여기로 들어오는 enc_data 와 사진은 모두 브라우저에서 이미 암호화된 값이다.
 * 서버는 "누구의 데이터인지(user_id)"만 확인해서 본인 것만 읽고 쓰게 한다.
 */

const MAX_CELL_CHARS = 49000;       // 구글시트 셀 한도(50,000자) 여유분
const MAX_IMAGE_B64_CHARS = 8000000; // 암호화된 사진 1장 최대 약 6MB

/* ---------------- 진료기록 ---------------- */

function api_listRecords(token) {
  const s = requireSession_(token);
  return findRows_(SHEETS.RECORDS, 'user_id', s.userId).map(function (r) {
    return {
      recordId: String(r.record_id),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      encData: String(r.enc_data),
      imageIds: r.image_ids ? String(r.image_ids).split(',') : []
    };
  });
}

/** req: { recordId?(수정 시), encData, imageIds: [] } */
function api_saveRecord(token, req) {
  const s = requireSession_(token);
  assertEnc_(req.encData);
  const imageIds = (req.imageIds || []).map(String);
  imageIds.forEach(function (id) { assertOwnImage_(s.userId, id); });

  return withLock_(function () {
    if (req.recordId) {
      const rec = ownRecord_(s.userId, req.recordId);
      // 수정하면서 빠진 사진은 휴지통으로
      const oldIds = rec.image_ids ? String(rec.image_ids).split(',') : [];
      oldIds.filter(function (id) { return imageIds.indexOf(id) === -1; }).forEach(trashImage_);
      updateRow_(SHEETS.RECORDS, rec._row, {
        updated_at: nowIso_(),
        enc_data: req.encData,
        image_ids: imageIds.join(',')
      });
      return { recordId: String(rec.record_id) };
    }
    const recordId = newId_('r');
    const now = nowIso_();
    appendRow_(SHEETS.RECORDS, {
      record_id: recordId, user_id: s.userId, created_at: now, updated_at: now,
      enc_data: req.encData, image_ids: imageIds.join(',')
    });
    audit_(s.userId, 'record_create', recordId);
    return { recordId: recordId };
  });
}

function api_deleteRecord(token, recordId) {
  const s = requireSession_(token);
  return withLock_(function () {
    const rec = ownRecord_(s.userId, recordId);
    (rec.image_ids ? String(rec.image_ids).split(',') : []).forEach(trashImage_);
    const chatRows = readAll_(SHEETS.CHATS)
      .filter(function (c) { return String(c.user_id) === s.userId && String(c.record_id) === String(recordId); })
      .map(function (c) { return c._row; });
    deleteRows_(SHEETS.CHATS, chatRows);
    deleteRows_(SHEETS.RECORDS, [rec._row]);
    audit_(s.userId, 'record_delete', recordId);
    return { ok: true };
  });
}

/* ---------------- 사진 (암호화된 파일로 드라이브에 저장) ---------------- */

function api_uploadImage(token, encB64) {
  const s = requireSession_(token);
  if (typeof encB64 !== 'string' || !B64_RE.test(encB64) || encB64.length > MAX_IMAGE_B64_CHARS) {
    throw new Error('사진 파일이 너무 크거나 형식이 올바르지 않습니다.');
  }
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('IMAGE_FOLDER_ID'));
  const blob = Utilities.newBlob(Utilities.base64Decode(encB64), 'application/octet-stream', newId_('img') + '.enc');
  const file = folder.createFile(blob);
  file.setDescription(s.userId); // 소유자 표시 (내용은 암호문)
  return { imageId: file.getId() };
}

function api_getImage(token, imageId) {
  const s = requireSession_(token);
  const file = assertOwnImage_(s.userId, imageId);
  return { encB64: Utilities.base64Encode(file.getBlob().getBytes()) };
}

/** 저장하지 않고 버린 사진 정리 */
function api_discardImages(token, imageIds) {
  const s = requireSession_(token);
  const used = {};
  findRows_(SHEETS.RECORDS, 'user_id', s.userId).forEach(function (r) {
    (r.image_ids ? String(r.image_ids).split(',') : []).forEach(function (id) { used[id] = true; });
  });
  (imageIds || []).forEach(function (id) {
    if (used[id]) return;
    try { assertOwnImage_(s.userId, id); trashImage_(id); } catch (e) { /* 무시 */ }
  });
  return { ok: true };
}

/* ---------------- 질의응답 기록 ---------------- */

/** recordId 가 'ALL' 이면 전체 기록 대상 대화 */
function api_listChats(token, recordId) {
  const s = requireSession_(token);
  return readAll_(SHEETS.CHATS)
    .filter(function (c) { return String(c.user_id) === s.userId && String(c.record_id) === String(recordId); })
    .map(function (c) { return { messageId: String(c.message_id), createdAt: String(c.created_at), encData: String(c.enc_data) }; });
}

function api_saveChat(token, recordId, encData) {
  const s = requireSession_(token);
  assertEnc_(encData);
  if (recordId !== 'ALL') ownRecord_(s.userId, recordId);
  const messageId = newId_('m');
  withLock_(function () {
    appendRow_(SHEETS.CHATS, {
      message_id: messageId, user_id: s.userId, record_id: recordId, created_at: nowIso_(), enc_data: encData
    });
  });
  return { messageId: messageId };
}

function api_clearChats(token, recordId) {
  const s = requireSession_(token);
  return withLock_(function () {
    const rows = readAll_(SHEETS.CHATS)
      .filter(function (c) { return String(c.user_id) === s.userId && String(c.record_id) === String(recordId); })
      .map(function (c) { return c._row; });
    deleteRows_(SHEETS.CHATS, rows);
    return { ok: true };
  });
}

/* ---------------- 의사 선생님 설정 ---------------- */

function api_getDoctorProfile(token) {
  const s = requireSession_(token);
  const row = findRows_(SHEETS.PROFILES, 'user_id', s.userId)[0];
  return { encData: row ? String(row.enc_data) : '', presets: listPresets_() };
}

function api_saveDoctorProfile(token, encData) {
  const s = requireSession_(token);
  assertEnc_(encData);
  return withLock_(function () {
    const row = findRows_(SHEETS.PROFILES, 'user_id', s.userId)[0];
    if (row) updateRow_(SHEETS.PROFILES, row._row, { updated_at: nowIso_(), enc_data: encData });
    else appendRow_(SHEETS.PROFILES, { user_id: s.userId, updated_at: nowIso_(), enc_data: encData });
    return { ok: true };
  });
}

/** 관리자가 DoctorPresets 시트에 적어둔 의사 선생님 프리셋 (이름만 앱에 보여준다) */
function listPresets_() {
  return readAll_(SHEETS.PRESETS)
    .filter(function (p) { return String(p.active).toUpperCase() !== 'FALSE' && p.preset_id; })
    .map(function (p) { return { id: String(p.preset_id), name: String(p.name) }; });
}

function getPresetPrompt_(presetId) {
  if (!presetId) return '';
  const p = findRows_(SHEETS.PRESETS, 'preset_id', presetId)[0];
  return p && String(p.active).toUpperCase() !== 'FALSE' ? String(p.prompt) : '';
}

/* ---------------- 내부 함수 ---------------- */

function ownRecord_(userId, recordId) {
  const rec = findRows_(SHEETS.RECORDS, 'record_id', recordId)[0];
  if (!rec || String(rec.user_id) !== userId) throw new Error('기록을 찾을 수 없습니다.');
  return rec;
}

function assertOwnImage_(userId, imageId) {
  let file;
  try { file = DriveApp.getFileById(imageId); } catch (e) { throw new Error('사진을 찾을 수 없습니다.'); }
  if (file.getDescription() !== userId || file.isTrashed()) throw new Error('사진을 찾을 수 없습니다.');
  return file;
}

function trashImage_(imageId) {
  try { DriveApp.getFileById(imageId).setTrashed(true); } catch (e) { /* 이미 없음 */ }
}

function assertEnc_(encData) {
  if (typeof encData !== 'string' || encData.indexOf('v1:') !== 0) throw new Error('잘못된 데이터 형식입니다.');
  if (encData.length > MAX_CELL_CHARS) {
    throw new Error('내용이 너무 깁니다. 원문 텍스트를 줄이거나 기록을 나눠서 저장해 주세요.');
  }
}
