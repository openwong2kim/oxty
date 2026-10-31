#!/usr/bin/env bash
# 패치가 적용된 alacritty_terminal 소스 트리를 oxty 크레이트의 `vt` 모듈로 옮긴다.
# Alacritty를 올릴 때의 절차는 crates/oxty/src/vt/PATCHES.md의 "Upgrading"을 따른다.
#
#   scripts/vendor-vt.sh <alacritty_terminal 디렉터리> [출력 디렉터리]
#
# 출력 디렉터리를 주면 crates/oxty 대신 그곳에 만든다(우리 패치를 diff로 뽑을 때 — PATCHES.md 참고).
#
# 하는 일
# - PTY·이벤트 루프 모듈(tty, event_loop, sync, thread)은 옮기지 않는다 — 엔진은 바이트만 받는다.
# - lib.rs → mod.rs, Alacritty 크레이트 전체 린트 정책(#![...])과 위 모듈 선언을 뺀다.
# - 내부 경로 `crate::` → `crate::vt::`, 문서 예제의 `alacritty_terminal::` → `oxty::vt::`
# - DA2 응답 버전: `CARGO_PKG_VERSION`이 oxty 버전이 되지 않도록 Alacritty 버전으로 고정
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="${1:?alacritty_terminal 디렉터리를 지정하세요}"
out="${2:-$root/crates/oxty}"
dst="$out/src/vt"
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$src/Cargo.toml" | head -1)"

if [ -e "$dst" ]; then
  echo "$dst 가 이미 있습니다. 지운 뒤 다시 실행하세요." >&2
  exit 1
fi

mkdir -p "$dst"
rsync -a \
  --exclude tty --exclude event_loop.rs --exclude sync.rs --exclude thread.rs \
  "$src/src/" "$dst/"
mv "$dst/lib.rs" "$dst/mod.rs"
cp "$src/README.md" "$dst/UPSTREAM-README.md"
# 아래 둘은 패치된 트리(옛 vendor/)에만 있다. 원본 Alacritty에는 없으므로 있을 때만 옮긴다.
if [ -f "$src/WMUX-PATCH.md" ]; then cp "$src/WMUX-PATCH.md" "$dst/PATCHES.md"; fi
if [ -f "$src/LICENSE-XTERM" ]; then cp "$src/LICENSE-XTERM" "$out/LICENSE-XTERM"; fi

find "$dst" -name '*.rs' -exec perl -pi -e 's/\bcrate::/crate::vt::/g; s/\balacritty_terminal::/oxty::vt::/g; s/env!\("CARGO_PKG_VERSION"\)/"'"$version"'"/g' {} +

perl -0pi -e '
  s{\A//! Alacritty - The GPU Enhanced Terminal\.\n}{//! Alacritty `alacritty_terminal` 0.26 포크 (Apache-2.0). 변경 내역은 `PATCHES.md`.\n//!\n//! 저수준 API이며 oxty의 버전 안정성 약속 밖이다. 렌더러는 [`crate::Engine`]을 쓴다.\n};
  s{^#!\[.*\]\n}{}mg;
  s{^#\[cfg\(not\(target_arch = "wasm32"\)\)\]\n(?=pub mod (event_loop|tty);)}{}mg;
  s{^pub mod (event_loop|sync|thread|tty);\n}{}mg;
  s{\n{3,}}{\n\n}g;
' "$dst/mod.rs"

echo "vt 모듈: $(find "$dst" -name '*.rs' | wc -l | tr -d ' ')개 파일 → $dst"
