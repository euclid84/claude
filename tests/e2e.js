// 관리자(나)와 가족(어머니·아내·아빠)을 실제 브라우저 화면으로 움직여 가족 공유 전체 흐름을 검증한다.
// 실행: ./scripts/build.sh && cd tests && npm install && npm test
//   (Chromium 경로는 CHROMIUM_PATH 환경변수로 바꿀 수 있다)
const { chromium } = require('playwright-core');
const fs = require('fs');
const { createGas } = require('./fakegas');

const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'Index.html'), 'utf8');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const gas = createGas({
  geminiReply: body => body.systemInstruction
    ? '(가짜 AI 답변) 보호자 모드=' + /보호자\)이 하고 있습니다/.test(body.systemInstruction.parts[0].text)
    : JSON.stringify({ records: [] })
});
gas.ctx.setup();
gas.props.GEMINI_API_KEY = 'test-key';
const invite = gas.ctx.getConfig_('INVITE_CODE');

let failures = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; }

const mock = `
function makeRunner(){ let ok=function(){}, fail=function(){};
  const r = new Proxy({}, { get(_, p){
    if (p==='withSuccessHandler') return f=>{ok=f;return r};
    if (p==='withFailureHandler') return f=>{fail=f;return r};
    return (...a)=>{ window.__gas(p, JSON.stringify(a)).then(res => { const o = JSON.parse(res); if (o.error) fail(new Error(o.error)); else ok(o.value); }); };
  }}); return r; }
window.google = { script: {} };
Object.defineProperty(window.google.script, 'run', { get: makeRunner });
// google.script.history 흉내: 실제로는 바깥 브라우저 기록을 다룬다
['pointerup', 'keydown'].forEach(t => window.addEventListener(t, () => { window.__taps = (window.__taps || 0) + 1; }, true));
window.google.script.history = {
  push(st) { (window.__pushes = window.__pushes || []).push(navigator.userActivation ? navigator.userActivation.isActive : null); (window.__pushTaps = window.__pushTaps || []).push(window.__taps || 0); history.pushState(st, ''); }, replace(st) { history.replaceState(st, ''); },
  setChangeHandler(f) { window.addEventListener('popstate', e => f({ state: e.state })); }
};`;

async function newUserPage(browser, userAgent) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }, userAgent ? { userAgent } : {}));
  const calls = []; // 서버 호출 기록 (로그인 속도 검사용)
  await ctx.exposeFunction('__gas', (fn, argsJson) => {
    calls.push(fn);
    try {
      const v = gas.ctx[fn].apply(null, JSON.parse(argsJson));
      return JSON.stringify({ value: v === undefined ? null : v });
    } catch (e) { return JSON.stringify({ error: e.message }); }
  });
  await ctx.addInitScript(mock);
  await ctx.route('https://app.local/**', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  const page = await ctx.newPage();
  page.gasCalls = calls;
  page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
  await page.goto('https://app.local/');
  return page;
}

async function waitIdle(page) {
  await page.waitForFunction(() => !document.getElementById('loading').classList.contains('on'), null, { timeout: 60000 });
  await page.waitForTimeout(150);
}
async function signupAndLogin(page, user, pw) {
  await page.click('#toSignup'); await waitIdle(page);
  await page.fill('#inv', invite); await page.fill('#u', user); await page.fill('#p', pw); await page.fill('#p2', pw);
  await page.click('#go'); await waitIdle(page);
  await page.check('#ok'); await page.click('#go');
  await login(page, user, pw);
}
async function login(page, user, pw, keep) {
  await page.fill('#u', user); await page.fill('#p', pw);
  if (!keep) await page.uncheck('#keep'); // 기본 흐름은 자동 로그인 없이 (자동 로그인은 따로 검사)
  await page.click('#login'); await waitIdle(page);
  if (await page.$('#skip')) { await page.click('#skip'); await waitIdle(page); }
}
async function addManualRecord(page, title) {
  await page.click('#add'); await waitIdle(page);
  await page.click('#manual'); await waitIdle(page);
  await page.fill('[data-bind="title"]', title);
  await page.click('#save'); await waitIdle(page);
  await page.click('#back'); await waitIdle(page); // 기록 상세 → 결과지 모아보기
  await page.click('#back'); await waitIdle(page); // → 홈
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const tryCall = (page, fn, args) => page.evaluate(([fn, args]) => new Promise(res => {
    const r = google.script.run.withSuccessHandler(v => res({ ok: v })).withFailureHandler(e => res({ err: e.message }));
    r[fn].apply(r, args);
  }), [fn, args]);
  const listAs = (page, recordId, ownerId) => page.evaluate(([id, o]) => new Promise(res =>
    google.script.run.withSuccessHandler(res).withFailureHandler(e => res('ERR ' + e.message)).api_listChats(S.token, id, o)), [recordId, ownerId]);
  const tok = page => page.evaluate(() => S.token);
  const uid = page => page.evaluate(() => S.me.userId);
  const userIdOf = name => gas.sheets.Users._rows.find(r => r[1] === name || r[17] === name)[0];
  const openConsole = async tab => {
    await me.evaluate(() => viewSettings()); await waitIdle(me); await me.click('#console'); await waitIdle(me);
    if (tab) { await me.click('[data-cx="' + tab + '"]'); await waitIdle(me); }
  };
  const setPerm = async (ownerId, viewerId, perm) => {
    await openConsole('perms');
    await me.selectOption('#ownerSel', ownerId); await waitIdle(me);
    await me.selectOption('select[data-v="' + viewerId + '"]', perm); await waitIdle(me);
  };
  const bodyText = page => page.evaluate(() => document.body.innerText);

  // 1) 관리자(나) 첫 가입 → 자동으로 관리자
  var me = await newUserPage(browser);
  await signupAndLogin(me, 'admin', 'admin-pass-123');
  check(gas.ctx.getConfig_('ADMIN_USERNAMES') === 'admin', '첫 가입자가 관리자로 지정됨');
  check(await me.evaluate(() => S.me.isAdmin === true), '관리자 로그인 시 관리자 표시');
  await addManualRecord(me, '내 간기능 검사');

  // 2) 어머니 가입 → 가입 화면에 관리자 안내 → 로그인하면 관리자에게 자동 연결
  const mom = await newUserPage(browser);
  await mom.click('#toSignup'); await waitIdle(mom);
  check(await mom.evaluate(() => document.body.innerText.includes('관리자(admin)')), '가입 화면에 "관리자가 함께 본다" 안내');
  await mom.click('#back'); await waitIdle(mom);
  await signupAndLogin(mom, '어머니', 'mom-pass-456');
  await addManualRecord(mom, '어머니 혈액검사');
  const momId = await uid(mom), meId = await uid(me);
  const shareRow = gas.sheets.Shares._rows.find(r => r[1] === momId && r[2] === meId);
  check(!!shareRow && shareRow[4] === 'write', '어머니 로그인 시 관리자에게 자동 연결 (등록·수정 권한)');
  check(typeof shareRow[3] === 'string' && shareRow[3].length > 300, '연결에 쓰인 데이터키는 암호문');
  check(await mom.evaluate(() => S.people.length === 1), '어머니 화면에는 다른 가족 선택지가 없음');
  await mom.click('#settings'); await waitIdle(mom); await mom.click('#guard'); await waitIdle(mom);
  check(await mom.evaluate(() => document.body.innerText.includes('👑 admin') && !document.querySelector('[data-rm]')), '어머니: 관리자 연결은 해제 버튼 없음');
  await mom.screenshot({ path: OUT + '/member_sharing.png' });
  const rmTry = await tryCall(mom, 'api_removeShare', [await tok(mom), shareRow[0]]);
  check(rmTry.err && rmTry.err.includes('관리자와의 연결'), '어머니가 관리자 연결 해제 시도 → 거부');
  const peek = await tryCall(mom, 'api_listRecords', [await tok(mom), meId]);
  check(peek.err && peek.err.includes('권한이 없습니다'), '어머니가 관리자 기록 열람 시도 → 거부');

  // 3) 아내 가입 → 관리자 연결, 어머니 기록은 못 봄
  const wife = await newUserPage(browser);
  await signupAndLogin(wife, 'wife', 'wife-pass-789');
  check(await wife.evaluate(() => S.people.length === 1), '아내 화면에는 어머니 기록이 없음 (가족끼리는 서로 안 보임)');
  const wifePeek = await tryCall(wife, 'api_listRecords', [await tok(wife), momId]);
  check(wifePeek.err && wifePeek.err.includes('권한이 없습니다'), '아내가 어머니 기록 열람 시도 → 거부');

  // 4) 관리자 다시 로그인 → 가족 전체 보기
  await me.reload(); await login(me, 'admin', 'admin-pass-123');
  check(await me.evaluate(() => S.people.map(p => p.username).sort().join(',') === ['admin', 'wife', '어머니'].sort().join(',')), '관리자: 나 + 어머니 + 아내 모두 보임');
  await openConsole('overview');
  check(await me.evaluate(() => !!document.querySelector('body.console .cx-kpis')), '관리자 콘솔: 전문가용 레이아웃(KPI·탭)');
  check((await bodyText(me)).includes('모든 권한 정책이 적용되어 있습니다'), '현황: 권한 동기화 정상');
  check(await me.evaluate(() => [...document.querySelectorAll('[data-who]')].some(tr => tr.innerText.includes('어머니') && tr.querySelector('.num').innerText === '1')), '현황: 어머니 기록 1건 표시');
  await me.screenshot({ path: OUT + '/admin_overview.png', fullPage: true });
  await me.click('[data-who="' + (await me.evaluate(() => S.people.findIndex(p => p.username === '어머니'))) + '"]'); await waitIdle(me);
  check(await me.evaluate(() => S.viewName === '어머니' && S.records[0].data.title === '어머니 혈액검사'), '현황에서 어머니 선택 → 어머니 기록 화면');
  await me.screenshot({ path: OUT + '/admin_views_mom.png' });
  await addManualRecord(me, '관리자가 대신 올린 어머니 기록');
  check(await me.evaluate(() => S.records.length === 2), '관리자가 어머니 기록 대신 등록');

  // 5) 상담: 어머니 질문 → 관리자가 봄 / 관리자 질문 → 보내기 전엔 어머니에게 안 보임 → 보내기
  const momRecordId = await mom.evaluate(() => S.records[0].recordId);
  await mom.click('#back'); await waitIdle(mom); await mom.click('#back'); await waitIdle(mom);
  await mom.click('#records'); await waitIdle(mom);
  await mom.click('.card[data-id]'); await waitIdle(mom); await mom.click('#ask'); await waitIdle(mom);
  await mom.fill('#q', '제가 물어봐요'); await mom.click('#send'); await waitIdle(mom);
  check(await mom.evaluate(() => document.body.innerText.includes('보호자 모드=false')), '어머니 본인 질문은 가족 대신 묻는 모드 아님');
  await me.evaluate(id => viewDetail(id), momRecordId); await waitIdle(me);
  await me.click('#ask'); await waitIdle(me);
  await me.fill('#q', '어머니 결과 괜찮나요?'); await me.click('#send'); await waitIdle(me);
  check(await me.evaluate(() => document.body.innerText.includes('보호자 모드=true')), '관리자 질문 시 AI에 "가족이 대신 묻는 중" 전달');
  check((await listAs(mom, momRecordId, null)).filter(m => !m.fromOwner).length === 0, '보내기 전: 어머니에게 관리자 질문 안 보임');
  await me.click('.chip[data-tab="owner"]'); await waitIdle(me);
  check(await me.evaluate(() => document.body.innerText.includes('제가 물어봐요')), '관리자: 어머니 상담 탭에서 어머니 질문 보기');
  await me.click('.chip[data-tab="team"]'); await waitIdle(me);
  await me.click('[data-share]'); await me.waitForSelector('[data-a="yes"]'); await me.click('[data-a="yes"]'); await waitIdle(me);
  await me.screenshot({ path: OUT + '/admin_shared.png' });
  check((await listAs(mom, momRecordId, null)).filter(m => !m.fromOwner && m.shared).length === 2, '보낸 뒤: 어머니가 질문·답변을 받음');
  await mom.reload(); await login(mom, '어머니', 'mom-pass-456');
  check(!!(await mom.$('#notes')), '어머니 홈에 "가족이 보내준 설명" 카드');
  await mom.screenshot({ path: OUT + '/member_home_notes.png' });
  await mom.click('#records'); await waitIdle(mom);
  await mom.click('.card[data-id="' + momRecordId + '"]'); await waitIdle(mom); await mom.click('#ask'); await waitIdle(mom);
  check(await mom.evaluate(() => document.body.innerText.includes('admin님이 보내준 답변')), '어머니 상담 화면에 보내준 답변 표시');
  await mom.screenshot({ path: OUT + '/member_chat_shared.png' });
  await mom.click('#clear'); await mom.waitForSelector('[data-a="yes"]'); await mom.click('[data-a="yes"]'); await waitIdle(mom);
  check((await listAs(mom, momRecordId, null)).filter(m => m.fromOwner).length === 0, '어머니 상담 지우기 → 본인 상담만 삭제');
  await me.click('[data-unshare]'); await waitIdle(me);
  check((await listAs(mom, momRecordId, null)).length === 0, '보내기 취소 → 어머니 화면에서 사라짐');
  check((await listAs(me, momRecordId, momId)).length === 2, '관리자 상담은 그대로 남음');

  // 6) 대신 관리하는 가족 프로필 (아빠) → 아내와 함께 보기 → 본인 계정으로 넘겨주기
  await me.reload(); await login(me, 'admin', 'admin-pass-123');
  await openConsole('members');
  await me.screenshot({ path: OUT + '/admin_members.png', fullPage: true });
  await me.fill('#pname', '아빠'); await me.click('#addP'); await waitIdle(me);
  const dadId = userIdOf('아빠');
  await me.click('[data-manage="' + dadId + '"]'); await waitIdle(me);
  await me.click('#openRec'); await waitIdle(me);
  check(await me.evaluate(() => S.viewName === '아빠' && S.managed === true && canWrite()), '구성원 "아빠"(대신 관리) 생성 후 아빠 기록 화면');
  await me.screenshot({ path: OUT + '/dad_home.png' });
  await addManualRecord(me, '아빠 건강검진');
  const dadUsername = gas.sheets.Users._rows.find(r => r[0] === dadId)[1];
  check(!!(await tryCall(mom, 'api_login', [dadUsername, 'AAAA'])).err, '관리 프로필은 로그인할 수 없음');
  const wifeId = await uid(wife);
  await setPerm(dadId, wifeId, 'write');
  await wife.reload(); await login(wife, 'wife', 'wife-pass-789');
  check(await wife.evaluate(() => S.people.some(p => p.username === '아빠' && p.perm === 'write') && !S.people.some(p => p.username === '어머니')), '아내: 아빠 기록만 추가로 보임 (어머니는 여전히 안 보임)');
  await openConsole('members'); await me.click('[data-manage="' + dadId + '"]'); await waitIdle(me);
  await me.fill('#cu', 'dad'); await me.fill('#cp', 'dad-pass-000'); await me.fill('#cp2', 'dad-pass-000');
  await me.click('#claim'); await me.waitForSelector('[data-a="yes"]'); await me.click('[data-a="yes"]'); await waitIdle(me);
  check(await me.evaluate(() => /[A-Z0-9]{4}-/.test(document.querySelector('.code').textContent)), '넘겨주기 후 복구코드 표시');
  const dad = await newUserPage(browser);
  await login(dad, 'dad', 'dad-pass-000');
  check(await dad.evaluate(() => S.records.length === 1 && S.records[0].data.title === '아빠 건강검진'), '아빠: 본인 아이디로 로그인해서 기존 기록 보기');
  check(await dad.evaluate(() => S.people.length === 1), '아빠 화면에는 다른 가족이 안 보임');

  // 8) 부부끼리 서로 보기: 장인어른 가입 직후(첫 로그인 전)에 관리자가 미리 정책을 정해두면 로그인 시 자동 적용
  const fil = await newUserPage(browser);
  await fil.click('#toSignup'); await waitIdle(fil);
  await fil.fill('#inv', invite); await fil.fill('#u', '장인어른'); await fil.fill('#p', 'fil-pass-321'); await fil.fill('#p2', 'fil-pass-321');
  await fil.click('#go'); await waitIdle(fil); await fil.check('#ok'); await fil.click('#go');
  const filId = userIdOf('장인어른');
  await me.reload(); await login(me, 'admin', 'admin-pass-123');
  await setPerm(momId, filId, 'read');
  await setPerm(filId, momId, 'read');
  check((await bodyText(me)).includes('첫 로그인 후 자동 적용'), '첫 로그인 전 구성원에게 준 권한은 "대기"로 표시');
  await me.screenshot({ path: OUT + '/admin_perms_pending.png', fullPage: true });
  await login(fil, '장인어른', 'fil-pass-321');
  await addManualRecord(fil, '장인어른 혈압 기록');
  check(!!gas.sheets.Shares._rows.find(r => r[1] === filId && r[2] === meId), '장인어른 첫 로그인 → 관리자에게 자동 연결');
  check(!!gas.sheets.Shares._rows.find(r => r[1] === filId && r[2] === momId && r[4] === 'read'), '장인어른 첫 로그인 → 미리 정한 "장모님이 장인어른 기록 조회" 자동 적용');
  await openConsole('perms'); // 콘솔을 열면 관리자가 가진 어머니 열쇠로 장인어른 몫을 자동 발급
  await me.screenshot({ path: OUT + '/admin_perms.png', fullPage: true });
  check(await me.evaluate(() => !document.querySelector('.cx-badge.pending')), '관리자 콘솔 동기화 후 대기 항목 없음');
  await fil.reload(); await login(fil, '장인어른', 'fil-pass-321');
  check(await fil.evaluate(() => S.people.some(p => p.username === '어머니') && !S.people.some(p => p.username === 'wife')), '장인어른: 장모님(어머니) 기록 보임, 아내 기록은 안 보임');
  await mom.reload(); await login(mom, '어머니', 'mom-pass-456');
  check(await mom.evaluate(() => S.people.some(p => p.username === '장인어른')), '장모님(어머니): 장인어른 기록 보임');
  const filSelf = await fil.evaluate(() => S.people.find(p => p.username === '어머니').perm);
  check(filSelf === 'read', '부부끼리는 기본 "보기만" 권한');
  const memberTry = await tryCall(mom, 'api_listGuardians', [await tok(mom), await uid(fil)]);
  check(memberTry.err && memberTry.err.includes('관리'), '가족(어머니)은 다른 가족 설정을 바꿀 수 없음');

  // 9) 관리자 콘솔 (시트를 고치지 않고 앱에서 설정)
  // 9-1) 조회 권한: 장인어른 기록을 아내가 "조회" → 다시 "없음"
  await setPerm(filId, wifeId, 'read');
  await wife.reload(); await login(wife, 'wife', 'wife-pass-789');
  check(await wife.evaluate(() => { const p = S.people.find(x => x.username === '장인어른'); return p && p.perm === 'read'; }), '콘솔: 아내에게 장인어른 기록 "조회" 권한 부여');
  await setPerm(filId, wifeId, 'none');
  const denied = await tryCall(wife, 'api_listRecords', [await tok(wife), filId]);
  check(denied.err && denied.err.includes('권한이 없습니다'), '콘솔: "없음"으로 바꾸면 즉시 열람 거부');
  const forged = await tryCall(wife, 'api_fulfillAccess', [await tok(wife), [{ ownerId: momId, viewerId: wifeId, encDek: 'QUFBQQ==' }]]);
  check(forged.err && forged.err.includes('정책에 없는'), '정책에 없는 열쇠를 스스로 발급하려 하면 거부');
  // 9-2) 관리자 지정: 대신 관리 구성원(할머니) 먼저 만들고 → 아내를 관리자로 지정 → 가족 전체가 바로 보임
  await openConsole('members');
  await me.fill('#pname', '할머니'); await me.click('#addP'); await waitIdle(me);
  await me.click('[data-role="' + wifeId + '"]'); await me.waitForSelector('[data-a="yes"]'); await me.click('[data-a="yes"]'); await waitIdle(me);
  check(gas.ctx.getConfig_('ADMIN_USERNAMES').split(',').includes('wife'), '콘솔: 아내를 관리자로 지정 (Config에 반영)');
  await wife.reload(); await login(wife, 'wife', 'wife-pass-789');
  const wifeSees = await wife.evaluate(() => S.people.map(p => p.username));
  check(['admin', '어머니', '장인어른', '할머니', '아빠'].every(n => wifeSees.includes(n)), '지정 즉시 공동 관리자(아내)가 가족 전체를 봄 (가족 재로그인 불필요) → ' + wifeSees.join(','));
  check(await wife.evaluate(() => S.me.isAdmin === true && S.people.find(p => p.username === '어머니').perm === 'write'), '아내: 관리자 표시 + 조회·등록 권한');
  // 9-3) 관리자 해제 → 역할로 받은 열쇠는 즉시 회수, 따로 받은 권한(아빠 조회·등록)은 유지
  await openConsole('members');
  await me.click('[data-role="' + wifeId + '"]'); await me.waitForSelector('[data-a="yes"]'); await me.click('[data-a="yes"]'); await waitIdle(me);
  check(!gas.ctx.getConfig_('ADMIN_USERNAMES').split(',').includes('wife'), '콘솔: 아내 관리자 해제');
  const afterRevoke = await tryCall(wife, 'api_listRecords', [await tok(wife), momId]);
  check(afterRevoke.err && afterRevoke.err.includes('권한이 없습니다'), '해제 즉시 역할로 받은 열쇠 회수 (어머니 기록 거부)');
  check(!!(await tryCall(wife, 'api_listRecords', [await tok(wife), dadId])).ok, '따로 받은 권한(아빠 기록)은 유지');
  const lastAdmin = await tryCall(me, 'api_adminSetRole', [await tok(me), await uid(me), false]);
  check(lastAdmin.err && lastAdmin.err.includes('최소 1명'), '마지막 관리자는 해제할 수 없음');
  const notAdmin = await tryCall(mom, 'api_adminState', [await tok(mom)]);
  check(notAdmin.err && notAdmin.err.includes('관리자만'), '가족은 관리자 콘솔을 쓸 수 없음');
  // 9-4) 가입 설정: 가입 막기 → 새 가입 거부
  await openConsole('audit');
  check((await bodyText(me)).includes('권한 정책 변경') && (await bodyText(me)).includes('열쇠 자동 발급'), '활동 기록: 정책 변경·자동 발급 내역');
  await me.screenshot({ path: OUT + '/admin_audit.png', fullPage: true });
  await openConsole('signup');
  await me.screenshot({ path: OUT + '/admin_signup.png', fullPage: true });
  await me.uncheck('#allow'); await waitIdle(me);
  const stranger = await newUserPage(browser);
  await stranger.click('#toSignup'); await waitIdle(stranger);
  check(await stranger.evaluate(() => document.body.innerText.includes('지금은 새 계정을 만들 수 없습니다')), '콘솔: 가입 막기 → 가입 화면에서 차단 안내');
  await me.check('#allow'); await waitIdle(me);

  // 10) 수치 변화: 같은 검사를 여러 번 받은 기록 → 홈 버튼, 지켜볼 항목, 정상 범위 띠, 단위가 다른 기록 제외
  const tr = await newUserPage(browser);
  await signupAndLogin(tr, '수치', '1234');
  check(await tr.evaluate(() => !!S.token), '비밀번호: 숫자 4자리로 가입·로그인');
  check(!(await tr.$('.tcard')) && (await bodyText(tr)).includes('결과지를 올리면 여기에서'), '홈: 기록이 없으면 수치 변화 안내');
  check(await tr.evaluate(() => JSON.stringify([parseRange('70-99'), parseRange('70~99'), parseRange('130 미만'), parseRange('≥60'), parseRange('40 이하'), parseRange('음성')])) ===
    JSON.stringify([{ lo: 70, hi: 99 }, { lo: 70, hi: 99 }, { lo: null, hi: 130 }, { lo: 60, hi: null }, { lo: null, hi: 40 }, null]), '수치 변화: 참고치 글자 읽기');
  const T = (name, value, unit, ref, flag) => ({ name, value, unit, reference_range: ref, flag });
  const trendRecs = [
    ['2024-04-10', [T('LDL 콜레스테롤', '142', 'mg/dL', '130 미만', '높음'), T('eGFR', '95', 'mL/min', '60 이상', '정상'), T('혈색소', '14.5', 'g/dL', '13-17', '정상'), T('요단백', '음성', '', '음성', '판정없음'), T('SGOT', '28', 'U/L', '', '정상')]],
    ['2024-10-10', [T('LDL 콜레스테롤', '151', 'mg/dL', '130 미만', '높음'), T('eGFR', '92', 'mL/min', '60 이상', '정상'), T('혈색소', '14.9', 'g/dL', '13-17', '정상'), T('공복혈당', '98', 'mg/dL', '70~99', '정상')]],
    ['2025-04-10', [T('LDL 콜레스테롤', '139', 'mg/dL', '130 미만', '높음'), T('eGFR', '90', 'mL/min', '60 이상', '정상'), T('혈색소', '8.8', 'mmol/L', '', '정상')]],
    ['2025-10-10', [T('LDL-콜레스테롤(계산)', '124', 'mg/dL', '130 미만', '정상'), T('eGFR', '87', 'mL/min', '60 이상', '정상'), T('혈색소', '14.6', 'g/dL', '13-17', '정상'), T('AST(SGOT)', '32', 'IU/L', '', '정상')]]
  ];
  for (const [date, tests] of trendRecs) {
    await tr.evaluate(([date, tests]) => viewEdit(null, { title: date + ' 검진', date, record_type: '정기건강검진', hospital: '○○병원', tests }), [date, tests]);
    await tr.click('#save'); await waitIdle(tr);
  }
  await tr.evaluate(() => viewHome()); await waitIdle(tr);
  check(await tr.evaluate(() => [...document.querySelectorAll('.hero .actions button')].map(b => b.id).join(',')) === 'add,records,askAll', '홈 메뉴: 결과지 올리기 | 결과지 보기, 선생님께 묻기');
  check(!(await tr.$('.card[data-id]')), '홈: 결과지 카드 목록은 홈에 없음 (결과지 모아보기로)');
  await tr.screenshot({ path: OUT + '/trend_home.png', fullPage: true });
  const trText = await bodyText(tr);
  check(trText.includes('지켜볼 항목 1') && trText.includes('정상 범위지만 3번 연속 내리고 있어요'), '수치 변화: 정상이어도 계속 내려가는 항목을 지켜볼 항목으로');
  check(trText.includes('안정적인 항목 3') && trText.includes('한 번만 검사한 항목 2개'), '수치 변화: 안정적인 항목 / 한 번만 검사한 항목 분리');
  check(await tr.evaluate(() => document.querySelectorAll('.tcard').length === 4 && document.querySelectorAll('.tcard svg.hchart').length === 4), '홈: 여러 번 검사한 항목마다 날짜별 그래프 카드');
  const ldlChart = await tr.evaluate(() => {
    const c = [...document.querySelectorAll('.tcard')].find(x => x.innerText.includes('LDL'));
    const texts = [...c.querySelectorAll('svg text')].map(t => ({ x: +t.getAttribute('x'), s: t.textContent }));
    const dates = texts.filter(t => /^\d\d\.\d\d\.\d\d$/.test(t.s));
    return { order: dates.sort((a, b) => a.x - b.x).map(t => t.s).join(','), values: texts.filter(t => /^\d+$/.test(t.s)).map(t => t.s).join(',') };
  });
  check(ldlChart.order === '24.04.10,24.10.10,25.04.10,25.10.10' && ldlChart.values === '142,151,139,124', '홈 그래프: 점마다 수치, 오른쪽 끝이 최신 → ' + ldlChart.order + ' / ' + ldlChart.values);
  check(await tr.evaluate(() => document.querySelectorAll('[data-series="AST(SGOT)"], [data-series="SGOT"]').length === 1), '정리: 병원마다 다른 이름(SGOT / AST(SGOT))을 한 항목으로 묶음');
  check(trText.includes('나쁜 콜레스테롤') && trText.includes('정상 130 미만'), '설명: 목록에 짧은 설명과 정상 기준');
  check(await tr.evaluate(() => document.querySelectorAll('[data-series^="LDL"]').length === 1), '수치 변화: 이름이 조금 달라도(하이픈·괄호) 같은 항목으로 묶음');
  await tr.screenshot({ path: OUT + '/trend_list.png', fullPage: true });
  await tr.click('[data-series="혈색소"]'); await waitIdle(tr);
  check((await bodyText(tr)).includes('단위가 다른 기록 1건은 그래프에서 뺐어요'), '수치 변화: 단위가 다른 기록은 그래프에서 제외');
  await tr.click('#back'); await waitIdle(tr);
  check((await bodyText(tr)).includes('지켜볼 항목 1'), '수치 변화: 항목 그래프에서 뒤로 → 목록');
  await tr.click('[data-series^="LDL"]'); await waitIdle(tr);
  check(await tr.evaluate(() => !!document.querySelector('svg rect[fill="#E6F4EA"]') && document.body.innerText.includes('▼ 15 내렸어요')), '수치 변화: 항목 그래프에 정상 범위 띠 + 지난번 대비');
  check(await tr.evaluate(() => { const now = document.querySelector('.levels li.now'); return !!now && now.innerText.includes('정상') && now.innerText.includes('지금 124'); }), '설명: 정상 기준 단계표에서 지금 위치 표시');
  check((await bodyText(tr)).includes('나쁜 콜레스테롤') && (await bodyText(tr)).includes('높으면'), '설명: 쉬운 설명과 높을 때 의미');
  await tr.screenshot({ path: OUT + '/trend_item.png', fullPage: true });
  await tr.click('[data-rec]'); await waitIdle(tr);
  check((await bodyText(tr)).includes('2025-10-10 검진'), '수치 변화: 날짜별 기록을 누르면 그날 기록으로');
  check((await bodyText(tr)).includes('정상 130 미만') && (await bodyText(tr)).includes('나쁜 콜레스테롤'), '설명: 기록 상세 검사 목록에도 짧은 설명·정상 기준');
  await tr.click('[data-test]'); await waitIdle(tr);
  await tr.click('#back'); await waitIdle(tr);
  check((await bodyText(tr)).includes('2025-10-10 검진'), '기록 상세 → 항목 그래프 → 뒤로 → 기록 상세');

  // 10-1) 결과지 모아보기: 결과지 카드는 따로, 누르면 상세, 뒤로 → 모아보기 → 홈
  await tr.evaluate(() => viewHome()); await waitIdle(tr);
  await tr.click('#records'); await waitIdle(tr);
  check(await tr.evaluate(() => document.querySelectorAll('.card[data-id]').length === 4 && document.body.innerText.includes('결과지 모아보기')), '결과지 모아보기: 결과지 카드 4건');
  await tr.click('.card[data-id]'); await waitIdle(tr);
  await tr.click('#back'); await waitIdle(tr);
  check(!!(await tr.$('.card[data-id]')), '결과지 모아보기: 상세에서 뒤로 → 모아보기');
  await tr.click('#back'); await waitIdle(tr);
  check(!!(await tr.$('.tcard')), '결과지 모아보기: 뒤로 → 홈(수치 변화)');
  // 10-2) 결과지에 참고치가 없어도 사전의 정상 기준으로 띠 표시 (단위 IU/L = U/L)
  await tr.evaluate(() => viewTrend('AST(SGOT)', viewHome)); await waitIdle(tr);
  check(await tr.evaluate(() => !!document.querySelector('svg rect[fill="#E6F4EA"]') && document.body.innerText.includes('정상 40 이하')), '설명: 참고치가 없으면 사전 기준으로 정상 범위 표시');
  // 10-3) 검사일별 전체 표
  await tr.click('#back'); await waitIdle(tr);
  await tr.click('[data-mode="table"]'); await waitIdle(tr);
  const mx = await tr.evaluate(() => ({
    firstDate: document.querySelector('.mx thead th:nth-child(2)').innerText.replace(/\s/g, ''),
    lastDate: document.querySelector('.mx thead th:last-child').innerText.replace(/\s/g, ''),
    atRight: (w => w.scrollLeft >= w.scrollWidth - w.clientWidth - 1)(document.querySelector('.mxwrap')),
    cols: document.querySelectorAll('.mx thead th').length,
    rows: document.querySelectorAll('.mx tbody th.rowh').length,
    groups: [...document.querySelectorAll('.mx tr.grp')].map(r => r.innerText.trim()),
    ldl151: [...document.querySelectorAll('.mx td.bad')].some(td => td.innerText.startsWith('151'))
  }));
  check(mx.firstDate === '202404.10' && mx.lastDate === '202510.10' && mx.cols === 5 && mx.atRight, '전체 표: 그래프처럼 오른쪽 끝이 최신, 처음에 오른쪽 끝 → ' + mx.firstDate + '~' + mx.lastDate + ' / ' + mx.atRight);
  check(mx.rows === 6, '전체 표: 검사마다 한 줄 (이름이 달라도 묶음) → ' + mx.rows);
  check(JSON.stringify(mx.groups) === JSON.stringify(['혈당', '콜레스테롤', '간', '콩팥', '혈액', '소변']), '전체 표: 분류별로 묶음 → ' + mx.groups.join(','));
  check(mx.ldl151, '전체 표: 범위 밖 칸은 색 표시');
  await tr.screenshot({ path: OUT + '/trend_table.png', fullPage: true });
  await tr.click('.mx td.bad'); await waitIdle(tr);
  check((await bodyText(tr)).includes('검진'), '전체 표: 숫자를 누르면 그날 기록');

  // 10-4) 로그인 속도: 서버 왕복 수, 이 휴대폰에서 자동 로그인
  await tr.evaluate(() => viewSettings()); await waitIdle(tr);
  await tr.click('#logout'); await waitIdle(tr);
  tr.gasCalls.length = 0;
  await login(tr, '수치', '1234', true);
  check(JSON.stringify(tr.gasCalls) === JSON.stringify(['api_prelogin', 'api_login']), '로그인 속도: 비밀번호 로그인은 서버 왕복 2번 → ' + tr.gasCalls.join(','));
  check((await tr.innerText('#records')).includes('(4)') && !!(await tr.$('.tcard, .mx')), '로그인 속도: 한 번에 받은 데이터로 홈 표시');
  const tr2 = await tr.context().newPage();
  tr2.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
  tr.gasCalls.length = 0;
  await tr2.goto('https://app.local/'); await waitIdle(tr2);
  check(await tr2.evaluate(() => !!S.token && S.records.length === 4 && !document.querySelector('#login')) && JSON.stringify(tr.gasCalls) === JSON.stringify(['api_login']),
    '자동 로그인: 앱을 다시 열면 비밀번호 없이 바로 기록까지 (서버 왕복 1번) → ' + tr.gasCalls.join(','));
  await tr2.evaluate(() => viewSettings()); await waitIdle(tr2);
  await tr2.click('#logout'); await waitIdle(tr2);
  const tr3 = await tr.context().newPage();
  await tr3.goto('https://app.local/'); await waitIdle(tr3);
  check(!!(await tr3.$('#login')) && !(await tr3.$('#resume')), '자동 로그인: 로그아웃하면 저장한 로그인 정보도 지움');
  await tr2.close(); await tr3.close();

  // 10-5) 지난 상담 모아보기: 전체 상담 + 기록 상담을 한곳에, 누르면 그 대화로, 뒤로 가면 모아보기
  await tr.evaluate(() => viewHome()); await waitIdle(tr);
  await tr.click('#askAll'); await waitIdle(tr);
  await tr.fill('#q', '전체 질문입니다'); await tr.click('#send'); await waitIdle(tr);
  await tr.evaluate(() => viewDetail(S.records[0].recordId)); await waitIdle(tr);
  await tr.click('#ask'); await waitIdle(tr);
  await tr.fill('#q', '기록 질문입니다'); await tr.click('#send'); await waitIdle(tr);
  await tr.evaluate(() => viewHome()); await waitIdle(tr);
  await tr.click('#history'); await waitIdle(tr);
  const hist = await tr.evaluate(() => [...document.querySelectorAll('.hist h3')].map(h => h.innerText));
  check(hist.length === 2 && hist[0].includes('2025-10-10 검진') && hist[1].includes('전체 기록 상담'), '지난 상담: 전체·기록 상담을 최근 순으로 모아 보기 → ' + hist.join(' | '));
  check((await bodyText(tr)).includes('전체 질문입니다') && (await bodyText(tr)).includes('기록 질문입니다') && (await bodyText(tr)).includes('가짜 AI 답변'), '지난 상담: 질문과 답 미리보기');
  await tr.screenshot({ path: OUT + '/chat_history.png', fullPage: true });
  await tr.click('[data-thread]'); await waitIdle(tr);
  check(await tr.evaluate(() => !!document.querySelector('#q') && document.body.innerText.includes('기록 질문입니다')), '지난 상담: 누르면 그 대화로 (이어서 질문 가능)');
  await tr.click('#back'); await waitIdle(tr);
  check((await bodyText(tr)).includes('지난 상담') && !!(await tr.$('.hist')), '지난 상담: 대화에서 뒤로 → 모아보기');

  // 10-6) 하단 메뉴바 · 휴대폰 뒤로 버튼 · 건강 요약
  await tr.evaluate(() => viewHome()); await waitIdle(tr);
  const tabs = await tr.evaluate(() => [...document.querySelectorAll('.tabbar [data-go]')].map(b => b.getAttribute('data-go') + (b.classList.contains('on') ? '*' : '')).join(','));
  check(tabs === 'home*,records,add,chat,me', '메뉴바: 로그인하면 하단 메뉴 항상 (홈 선택됨) → ' + tabs);
  await tr.click('.tabbar [data-go="records"]'); await waitIdle(tr);
  check(!!(await tr.$('.card[data-id]')) && !!(await tr.$('.tabbar [data-go="records"].on')), '메뉴바: 결과지 → 결과지 모아보기');
  await tr.click('.card[data-id]'); await waitIdle(tr);
  check(!!(await tr.$('.tabbar')), '메뉴바: 기록 상세에서도 보임');
  await tr.goBack(); await waitIdle(tr);
  check(!!(await tr.$('.card[data-id]')), '뒤로 버튼: 기록 상세 → 결과지 모아보기 (앱 안에서)');
  await tr.goBack(); await waitIdle(tr);
  check(!!(await tr.$('.tabbar [data-go="home"].on')), '뒤로 버튼: 다른 메뉴 첫 화면 → 홈');
  await tr.goBack(); await tr.waitForTimeout(300);
  check((await tr.innerText('#toast')).includes('한 번 더') && !!(await tr.$('.tabbar')), '뒤로 버튼: 홈에서는 "한 번 더 누르면 나가요" 안내 (바로 나가지 않음)');
  check(await tr.evaluate(() => (window.__pushes || []).length > 0 && window.__pushes.every(a => a === true)), '뒤로 버튼(안드로이드): 화면을 누를 때만 칸을 끼움 (크롬이 건너뛰지 않게)');
  check(await tr.evaluate(() => { const t = window.__pushTaps || []; return t.length > 1 && new Set(t).size === t.length; }), '뒤로 버튼(안드로이드): 한 번 누를 때 칸은 하나만 (크롬이 앞 칸을 건너뛰지 않게)');
  await tr.waitForTimeout(3200);
  await tr.click('.tabbar [data-go="chat"]'); await waitIdle(tr);
  check((await bodyText(tr)).includes('선생님께 새로 묻기') && (await bodyText(tr)).includes('지난 상담'), '메뉴바: 상담 → 새로 묻기 + 지난 상담');
  await tr.click('.tabbar [data-go="home"]'); await waitIdle(tr);
  await tr.click('#me'); await waitIdle(tr);
  let meText = await bodyText(tr);
  check(meText.includes('건강 요약') && meText.includes('지켜볼 수치') && meText.includes('eGFR') && meText.includes('올린 결과지 4건'), '건강 요약: 이름을 누르면 요약 (지켜볼 수치·결과지)');
  await tr.click('#editInfo'); await waitIdle(tr);
  await tr.fill('#conditions', '고혈압'); await tr.fill('#surgeries', '2019 담낭 절제술'); await tr.fill('#medications', '혈압약 아침 1알');
  await tr.click('#save'); await waitIdle(tr);
  meText = await bodyText(tr);
  check(meText.includes('건강 요약') && meText.includes('고혈압') && meText.includes('2019 담낭 절제술') && meText.includes('혈압약 아침 1알'), '건강 요약: 건강 정보(병력·수술·약) 입력 후 바로 요약에 표시');
  check(await tr.evaluate(() => S.doctor.surgeries === '2019 담낭 절제술'), '건강 정보: 수술·입원 기록 저장');
  await tr.screenshot({ path: OUT + '/me_summary.png', fullPage: true });
  // 10-7) 혈액형: 글자 읽기 → 결과지에서 찾기 → 직접 입력이 우선
  const bp = await tr.evaluate(() => ['A형 Rh+', 'AB', 'O형(Rh+)', 'A+', 'Rh(-)', 'B형', 'ab형 rh(-)'].map(x => { const p = parseBlood(x); return p.abo + p.rh; }).join(','));
  check(bp === 'A+,AB,O+,A+,-,B,AB-', '혈액형: 여러 표기 읽기 → ' + bp);
  await tr.evaluate(() => viewEdit(null, { title: '2023 건강검진', date: '2023-05-02', record_type: '정기건강검진', tests: [{ name: '혈액형', value: 'A형', flag: '판정없음' }, { name: 'Rh', value: '+', flag: '판정없음' }] }));
  await tr.click('#save'); await waitIdle(tr);
  await tr.evaluate(() => viewMe()); await waitIdle(tr);
  check((await bodyText(tr)).includes('A형 Rh+ (결과지 2023.05.02에서 찾음)'), '혈액형: 직접 안 적어도 결과지에서 찾아 요약에 표시');
  check(await tr.evaluate(() => stripDoctor(S.doctor).bloodType === 'A형 Rh+ (결과지에서 확인)'), '혈액형: AI 선생님에게도 결과지 혈액형 전달');
  await tr.click('#editInfo'); await waitIdle(tr);
  check((await bodyText(tr)).includes('결과지에서 찾은 혈액형: A형 Rh+'), '혈액형: 입력 화면에 결과지에서 찾은 혈액형 안내');
  await tr.selectOption('#abo', 'B'); await tr.selectOption('#rh', '-');
  await tr.click('#save'); await waitIdle(tr);
  check((await bodyText(tr)).includes('B형 Rh-') && !(await bodyText(tr)).includes('에서 찾음'), '혈액형: 직접 적으면 그게 우선');

  // 10-8) 아이폰: 뒤로 처리 직후 바로 칸을 다시 끼워, 화면을 안 눌러도 계속 앱 안에서 뒤로
  const ip = await newUserPage(browser, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  await login(ip, '수치', '1234');
  await ip.click('.tabbar [data-go="records"]'); await waitIdle(ip);
  await ip.click('.card[data-id]'); await waitIdle(ip);
  await ip.click('[data-test]'); await waitIdle(ip);          // 항목 그래프
  await ip.click('[data-rec]'); await waitIdle(ip);           // 그날 기록 (4단계 깊이)
  const ipBefore = await ip.evaluate(() => window.__pushes.length);
  for (let i = 0; i < 4; i++) { await ip.goBack(); await waitIdle(ip); }
  check(!!(await ip.$('.tabbar [data-go="home"].on')) || !!(await ip.$('.card[data-id]')), '뒤로 버튼(아이폰): 화면을 안 눌러도 4번 연속 뒤로 → 앱 안');
  check(await ip.evaluate(() => IOS === true) && (await ip.evaluate(() => window.__pushes.length)) > ipBefore, '뒤로 버튼(아이폰): 아이폰으로 알아보고, 뒤로 직후 칸을 다시 끼움 (기존 동작 유지)');
  await ip.close();

  // 11) 버전 표시·업데이트 이력·숨은 인사
  const ver = await tr.evaluate(() => APP_VERSION);
  check(ver === gas.ctx.api_version(), '버전: 화면 코드와 서버 코드 버전이 같음 (v' + ver + ')');
  await tr.evaluate(() => viewHome()); await waitIdle(tr);
  check((await tr.innerText('#ver')).includes('v' + ver), '버전: 홈 맨 아래에 버전 표시');
  await tr.click('#ver'); await waitIdle(tr);
  check((await bodyText(tr)).includes('업데이트 이력') && (await bodyText(tr)).includes('지금 버전'), '버전: 누르면 업데이트 이력');
  check(!(await tr.isVisible('#secret')), '숨은 인사: 처음에는 안 보임');
  await tr.click('#heart');
  check((await tr.innerText('#secret')).includes('어머님, 아버님') && (await tr.innerText('#secret')).includes('항상 건강하세요'), '숨은 인사: 하트를 누르면 "어머님, 아버님 항상 건강하세요"');
  await tr.screenshot({ path: OUT + '/changelog.png', fullPage: true });
  await me.evaluate(() => viewChangelog()); await me.waitForTimeout(300);
  check(!(await me.$('#verWarn .notice')), '버전: 관리자 화면에서 서버 버전이 같으면 경고 없음');
  await stranger.goto('https://app.local/'); await waitIdle(stranger);
  check((await bodyText(stranger)).includes('v' + ver), '버전: 로그인 화면에도 버전 표시');

  // 7) 시트에는 평문이 없음
  const allText = JSON.stringify(gas.sheets);
  check(!allText.includes('어머니 혈액검사') && !allText.includes('내 간기능 검사') && !allText.includes('아빠 건강검진'), '시트 어디에도 기록 제목(평문)이 없음');

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
