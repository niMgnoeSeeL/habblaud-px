#!/bin/sh
# 휴대폰 점검: 네 프로필(iPhone 15, iPhone SE, 각각 가로)을 동시에 찍고 OUT/index.html로 모은다.
# 사용: tools/phone/run.sh OUT [단계 ...]   (단계 목록: python3 tools/phone/shoot.py --list)
# 환경 변수: HABBLAUD_URL(기본 http://localhost:4747), PROFILES(기본 네 프로필, 공백으로 구분)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${1:?사용: tools/phone/run.sh OUT [단계 ...]}
shift
mkdir -p "$OUT"
URL=${HABBLAUD_URL:-http://localhost:4747}
if ! curl -sf -m 5 "$URL/api/health" > /dev/null; then
  echo "Habblaud가 $URL에서 응답하지 않습니다(npm start)." >&2
  exit 1
fi
# login 단계가 쓰는 원격 로그인 화면(server/http/remote.ts의 loginPage)을 파일로 만든다.
if ! (cd "$ROOT" && node_modules/.bin/tsx -e "import('./server/http/remote.ts').then((m) => process.stdout.write(m.loginPage({ caDownload: true })))") > "$OUT/login.html" 2> "$OUT/login.err"; then
  rm -f "$OUT/login.html"
fi
pids=""
for p in ${PROFILES:-iphone-15 iphone-se iphone-15-land iphone-se-land}; do
  python3 -u "$HERE/shoot.py" "$OUT" --profile "$p" "$@" > "$OUT/log-$p.txt" 2>&1 &
  pids="$pids $!"
done
st=0
for pid in $pids; do wait "$pid" || st=1; done
cat "$OUT"/log-*.txt
python3 "$HERE/shoot.py" "$OUT" --gallery
exit $st
