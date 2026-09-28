#!/bin/sh
# apps-script/ 의 여러 파일을 Apps Script에 붙여넣기 쉬운 2개 파일로 합친다.
#   dist/Code.gs    : 모든 .gs 파일
#   dist/Index.html : Styles/Crypto/App 을 끼워 넣은 화면 파일
set -e
cd "$(dirname "$0")/.."
# 화면(App.html)과 서버(Code.gs)의 버전이 같아야 한다
v_app=$(sed -n "s/^const APP_VERSION = '\(.*\)';/\1/p" apps-script/App.html)
v_gs=$(sed -n "s/^const APP_VERSION = '\(.*\)';/\1/p" apps-script/Code.gs)
if [ -z "$v_app" ] || [ "$v_app" != "$v_gs" ]; then
  echo "버전이 다릅니다: App.html=$v_app Code.gs=$v_gs" >&2; exit 1
fi
mkdir -p dist
{
  echo "// 자동 생성 파일 — 원본은 apps-script/*.gs (scripts/build.sh 로 생성)"
  for f in Code Db Auth Records Shares Access Admin Gemini; do
    echo ""
    echo "// ===================== $f.gs ====================="
    cat "apps-script/$f.gs"
  done
} > dist/Code.gs
python3 - <<'PY'
src = open('apps-script/Index.html', encoding='utf-8').read()
for name in ['Styles', 'Crypto', 'TestInfo', 'App']:
    part = open('apps-script/%s.html' % name, encoding='utf-8').read()
    src = src.replace("<?!= include('%s'); ?>" % name, part.strip())
assert '<?' not in src, 'template tag left in bundle'
open('dist/Index.html', 'w', encoding='utf-8').write(src)
PY
echo "dist/Code.gs, dist/Index.html 생성 완료"
