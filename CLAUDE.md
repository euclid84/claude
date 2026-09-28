# 작업 규칙

## 버전과 업데이트 이력 (고칠 때마다 반드시)
사용자가 보는 변경을 할 때마다:
1. `apps-script/Code.gs`와 `apps-script/App.html`의 `APP_VERSION`을 **같은 값으로** 올린다 (예: `1.3` → `1.4`).
2. `apps-script/App.html`의 `CHANGELOG` 맨 위에 새 항목을 추가한다. 가족(어르신)이 읽는 글이라 **개발 용어 없이 쉬운 말**로 쓴다.
3. 저장소의 `CHANGELOG.md`에도 같은 내용을 추가한다.
4. `scripts/build.sh`로 `dist/`를 다시 만든다. 두 파일의 버전이 다르면 빌드가 멈춘다.

## 개발
- 검사 설명·정상 기준·병원별 다른 이름은 `apps-script/TestInfo.html` (정상 기준은 성인 국가건강검진 판정 기준을 따름).
- 원본은 `apps-script/`, 붙여넣기용 묶음은 `dist/` (`scripts/build.sh`로 생성, 원본과 함께 커밋).
- 테스트: `./scripts/build.sh && cd tests && npm install && npm test` (Chromium 경로는 `CHROMIUM_PATH` 환경변수로 바꿀 수 있음).
- 업데이트 이력 화면 맨 아래 하트(♡)를 누르면 나오는 "어머님, 아버님 항상 건강하세요"는 사용자가 넣어 달라고 한 숨은 인사다. 지우지 않는다.
