# oxty PRD — Rust 기반 xterm (터미널 엔진)

| 항목 | 내용 |
| --- | --- |
| 문서 버전 | v0.3 |
| 작성일 | 2026-10-31 (v0.1·v0.2·v0.3) |
| 저장소 | github.com/openwong2kim/oxty (비공개) |
| 현재 릴리스 | 0.0.1 — 엔진 코어, wasm, N-API, 테스트 (레지스트리 미배포) |
| 첫 고객 | wmux |

### v0.3 변경 요약

- **이름 하나**: 공개 이름은 `oxty` 하나다. Alacritty 포크는 별도 크레이트(`oxty-vt`) 대신 `oxty` 크레이트 안의 `vt` 모듈로 내장하고, 웹 프런트는 `oxty/xterm` 하위 경로로 낸다.
- **대상 재평가**: Orca가 wmux와 같은 xterm.js 스택을 쓴다(§2.2). herdr·t3code는 이미 libghostty-vt를 골랐다. 경쟁자 평가를 실사용 기준으로 고쳤다.

### v0.2 변경 요약

- **D3 변경**: xterm.js 포크 → 얇은 자체 프런트 + xterm.js 부품 차용. M1 스파이크로 확정하고, 실패하면 포크로 돌아간다.
- **D8 추가**: oxty 저장소에서 개발하고, wmux는 처음부터 git 의존성으로 쓴다. "wmux 안에서 만들고 나중에 떼어내기"는 하지 않는다.
- **마일스톤 순서**: 웹 프런트·wmux 렌더러 교체(M2)를 입력 인코딩(M3)보다 앞으로 당긴다.
- **M1 추가**: wmux-term의 Alacritty 포크 통합, M2에 필요한 엔진 API 공백 메우기, D3 검증 스파이크, 스크롤 damage 개선.
- **출시 관문 교체**: 교체 후에는 shadow 비교가 아무것도 검증하지 못하므로, 차분 테스트와 wmux e2e로 바꾼다.
- **사실 정정**: 레지스트리 미배포, libghostty 라이선스(MIT), 메모리 비중이 피크 샘플 기준이라는 점, wasm32 패치 위치.
- **열린 질문**: v0.1의 1~5번을 결정하고 §10 결정 기록으로 옮겼다. 새로 나온 질문을 남겼다.

---

## 1. 한 줄 정의

**oxty는 xterm.js의 "속"을 Rust로 대체하는 터미널 엔진이다.** 프로그램이 PTY에 쓴 바이트를 해석해 화면 상태를 들고 있고, 어떤 렌더러든 바뀐 줄만 가져가 그리게 한다. 같은 엔진이 데몬(네이티브), 브라우저·Electron 렌더러(WebAssembly), 미래의 네이티브 앱에서 똑같이 돈다.

xterm.js는 **엔진 층**(`common`: 바이트 해석 → 화면 상태)과 **화면 층**(`browser`: 그리기·키 입력·IME·선택·접근성)으로 나뉜다. `@xterm/headless`는 엔진 층만 Node에서 돌리는 패키지다. oxty는 엔진 층을 Rust로 대체하고, 화면 층은 얇게 새로 만든다(§5 D3).

---

## 2. 배경과 문제

### 2.1 wmux 안의 문제: 엔진이 두 개

- wmux 데몬(Node/TypeScript)은 스냅샷을 만들 때 N-API로 Rust 엔진(`core/wmux-term`, Alacritty 0.26 기반)을 쓸 수 있다. 기본값은 `@xterm/headless`이고, Windows 기본값을 Rust로 바꾸는 변경(#2806)은 별도 브랜치에 있다. 릴리스 반영 여부는 확인이 필요하다.
- 화면(Electron 렌더러)은 전부 xterm.js 6.1 베타다.
- 엔진이 둘이라 "같은 바이트에 같은 화면"을 보장하려고 shadow 비교 장치와 픽스처를 따로 유지한다. 텍스트 31/31, ANSI 52건 일치 + 1건 의도적 거부까지 맞춰 왔다.
- 데몬 스냅샷과 화면이 어긋나면 모바일 승인·재접속 복원 같은 wmux의 핵심 기능이 흔들린다.
- Alacritty 포크도 이미 두 벌이다. `wmux-term/vendor`와 `oxty/vendor`는 3개 파일(`Cargo.toml`, `src/lib.rs`, `WMUX-PATCH.md`)이 다르고, wasm32 빌드 패치는 oxty에만 있다.

### 2.2 시장의 빈자리

- `@xterm/xterm`은 지난주(2026-10-23~29) npm에서 **8,608,088**회 다운로드됐다. 웹 터미널의 사실상 표준이다.
- "xterm.js API는 그대로, 속은 WASM 코어로" 바꾸는 흐름이 이미 시작됐다. 셋 모두 xterm.js를 포크하지 않고 자체 렌더러를 쓴다.
  - ghostty-web(Coder, Zig): 같은 기간 **314,582**회, xterm.js API 호환을 목표로 함
  - vercel-labs/wterm(Zig): DOM 렌더러, 자체 API
  - riotermjs(Rust): 0.1.8, 초기 단계
- 에이전트 터미널 앱의 엔진 선택 (2026-10-31, 각 저장소 의존성 파일 확인)
  - **Orca**(stablyai, ★111k, MIT, Electron): xterm.js `6.1.0-beta.304` + `@xterm/headless` + serialize — wmux와 버전까지 같다. oxty가 wmux에 붙으면 거의 그대로 붙일 수 있는 1순위 외부 대상이다.
  - **herdr**(★47k, Apache-2.0, Rust TUI): libghostty-vt를 저장소에 넣어 FFI로 쓴다.
  - **t3code**(pingdotgg, ★33k, MIT, Electron + 웹): libghostty를 직접 wasm으로 빌드해 쓴다.
  - 즉 실제 경쟁자는 libghostty-vt다. oxty는 "이미 xterm.js를 쓰는 앱"(wmux, Orca)이 import 교체로 옮겨 오는 자리를 노린다.
- **Rust로 된, 성숙한, xterm.js 호환 엔진은 아직 없다.** oxty가 노릴 자리다.

### 2.3 장기 방향

- wmux가 Electron을 벗어나 네이티브 Rust 앱으로 갈 때, 터미널 엔진은 어차피 필요하다. oxty는 그 길의 선행 작업이다.
- 참고: 메모리 관점에서 wmux의 가장 큰 비중은 에이전트 프로세스다(피크 순간 1회 샘플 기준 약 82%, 2,309 / 2,819 MiB). oxty는 메모리 절감보다 **정확성(엔진 하나)과 플랫폼 독립성**이 1차 가치다.

---

## 3. 목표와 비목표

### 3.1 목표

| ID | 목표 | 판단 기준 |
| --- | --- | --- |
| G1 | **엔진 하나** — 데몬·웹·네이티브가 같은 코어를 쓴다 | wmux-term이 `oxty`에 의존(M1), wmux의 데몬과 화면이 같은 oxty 빌드를 사용(M2) |
| G2 | **xterm.js 호환 프런트** — import 교체 수준으로 옮길 수 있다 | 정의한 API 체크리스트 통과(§6 M2) |
| G3 | **wmux 적용** — 렌더러 엔진을 oxty로 교체 | 교체 전: `@xterm/headless` 차분 불일치 0. 교체 후: wmux e2e·IME 회귀·화면 스냅샷 회귀 0 |
| G4 | **로직은 Rust에** — 입력 인코딩·선택·검색·링크까지 | 플랫폼별 코드는 IME·그리기·OS 입력만 |
| G5 | **오픈소스로 채택** — wmux 밖에서도 쓰인다 | 공개 후 외부 사용 사례 확보 |

### 3.2 비목표

- **터미널 앱 만들기** — 창, 탭, 분할, 설정 UI는 wmux 몫이다.
- **VT 파서를 처음부터 작성** — Alacritty 포크를 쓴다(§5 D1).
- **xterm.js 전체 포크** — 화면 층은 필요한 부품만 차용한다(§5 D3).
- **원조 xterm(X11, C) 호환** — 기준은 xterm.js의 동작이다.
- **1.0 이전 그래픽 프로토콜** — sixel, kitty graphics는 1.0 이후.
- **엔진 안의 PTY·프로세스 관리** — 엔진은 바이트만 받는다. PTY가 필요해지면 별도 크레이트 `oxty-pty`로 둔다.

---

## 4. 사용자와 사용 사례

| 사용자 | 사용 사례 | 받는 경로 |
| --- | --- | --- |
| **wmux** (첫 고객) | 데몬 스냅샷, Electron 렌더러, 웹·모바일 클라이언트를 한 엔진으로 | N-API + wasm, git 의존성(D8) |
| **xterm.js를 쓰는 에이전트 터미널** (Orca 등) | wmux와 같은 "엔진 둘" 문제 해소 | npm `oxty`, `oxty/xterm` |
| **웹 터미널 개발자** (xterm.js 사용자) | 클라우드 IDE, 웹 SSH, AI 에이전트 UI | npm `oxty/xterm` |
| **Rust 앱 개발자** | 네이티브 터미널, TUI 테스트 도구, 에이전트 런타임 | crates.io |

---

## 5. 아키텍처

### 5.1 층 구조

```
┌──────────────────────────────────────────────────────────────┐
│ 프런트엔드                                                   │
│  `oxty/xterm` 얇은 자체 웹 프런트 + xterm.js 호환 API         │
│    (xterm.js에서 차용: WebGL 글리프 아틀라스·IME 조합·키 입력) │
│  네이티브 렌더러 (wgpu + cosmic-text, 1.0 이후)               │
├──────────────────────────────────────────────────────────────┤
│ 바인딩     npm `oxty` (wasm)   │  N-API `oxty-node`  │  Rust │
├──────────────────────────────────────────────────────────────┤
│ 엔진 `oxty`  렌더러 무관 API: feed / rows / cells / damage /  │
│              cursor / modes / replies / title / bell / sync   │
│              + (M1) 뷰포트, 커서 모양, 셀 확장(밑줄 색·링크)  │
│              + (M1~) serialize, 검색 / (M3~) 입력 인코딩 /     │
│                (M4~) 선택, 링크 감지                          │
├──────────────────────────────────────────────────────────────┤
│ 코어 `oxty::vt`  Alacritty 0.26 포크 내장 (vte 파서 + 그리드) │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 설계 결정

**D1. 코어는 Alacritty 포크** (`alacritty_terminal` 0.26, Apache-2.0)
- 이유: Rust 네이티브이고 이미 패치·검증됐다. Unicode 11 폭·리사이즈·blink는 wmux에서, wasm32 빌드는 oxty 0.0.1에서 패치했다.
- 대안 검토: libghostty-vt는 기능이 풍부하고 herdr·t3code가 실제로 쓰지만, Zig 도구가 함께 필요하고 C API라 Rust·N-API 연결이 번거롭다. wmux가 Alacritty 기반으로 맞춰 놓은 픽스처 91건(고유 입력 85)을 다시 검증해야 하는 비용도 크다. 처음부터 작성하는 건 가치 대비 비용이 크다.
- libghostty-vt는 **비교 대상이자 동작 기준점**으로 쓴다.
- 포크는 한 벌만 둔다. 별도 크레이트로 내지 않고 `oxty` 크레이트 안의 `vt` 모듈로 내장한다. crates.io는 의존성도 전부 레지스트리에 있어야 하므로, 내장하면 공개 이름이 `oxty` 하나로 끝난다. 내부 경로(`crate::`) 89곳은 스크립트로 바꾸고, Alacritty를 올릴 때 같은 스크립트를 다시 돌린다.
- wmux-term은 M1에서 vendor 포크 대신 `oxty`를 의존성으로 쓰도록 바꾼다(D8).

**D2. 렌더러 무관 API**
- 엔진은 "바뀐 줄 목록 + 셀 배열"만 내준다. 웹 프런트와 미래의 네이티브 렌더러가 같은 API를 쓴다.
- 셀은 `[codepoint, fg, bg, attrs]` u32 4개다. 색은 종류(named/256/RGB)를 상위 바이트에 담고, 테마는 렌더러가 결정한다.
- u32 4개에 담을 수 없는 밑줄 색(SGR 58)과 OSC 8 하이퍼링크는 **행별 확장 테이블**(열 → 밑줄 색·링크 ID)로 따로 낸다. 셀 형식은 이 결정 후(M1)에 고정한다.
- damage는 스크롤된 줄 수를 함께 낸다. Alacritty는 스크롤마다 화면 전체를 damage로 표시하므로(`mark_fully_damaged`), 그대로 두면 로그가 흘러나오는 패인이 매 프레임 화면 전체를 복사한다.

**D3. 웹 프런트는 얇은 자체 프런트 + xterm.js 부품 차용**
- xterm.js(MIT)에서 WebGL 글리프 아틀라스·렌더 모델, IME 조합(`CompositionHelper`), 키 입력(`Keyboard.ts`)만 가져와 oxty 행에 맞춘다. 공개 API만 xterm.js와 호환시킨다.
- 이유
  - 포크하면 화면 층이 물려 있는 xterm.js 내부 인터페이스(`IBufferLine.loadCell`, `CellData`, `BufferService`)를 oxty 위에 흉내 내야 하고, 6.x 베타가 바뀔 때마다 따라가야 한다. 1인 개발에서 가장 무거운 비용이다.
  - 차용한 부품은 업스트림을 따라갈 의무가 없고, 경계를 oxty의 "바뀐 줄" API에 맞춰 설계할 수 있다(D7과 자연스럽게 맞물림).
  - 같은 문제를 푼 ghostty-web·riotermjs·wterm 모두 포크하지 않았다.
- 비용: 차용 모듈을 xterm.js 내부 서비스에서 떼어내는 작업(한 번), 선택 UI·접근성 직접 구현, wmux의 xterm.js 내부 우회 코드 19곳(4개 파일) 재작성.
- 검증: M1 스파이크 → **확정 (2026-10-31, `spike/d3-webgl/README.md`)**. xterm.js 6.0.0(`f447274`)에서 22개 파일·4,646줄을 복사했고 19개는 원문 그대로다. 딸려 온 내부 서비스는 5개, 서비스마다 쓰는 멤버는 1~2개(스텁 전체 112줄)다. 버퍼 쪽(BufferService·BufferLine·CellData)은 하나도 따라오지 않았고, 경계가 RenderModel(셀당 u32 4개)에서 끊긴다. WebglRenderer는 자체 오케스트레이터(179줄)와 셀 변환기(108줄)로 대체했다.

**D4. 로직은 Rust, 플랫폼 층은 얇게**
- Rust: 키보드·마우스·붙여넣기 인코딩, 선택 범위 계산, 검색, 링크 감지, serialize
- 플랫폼: IME(웹은 DOM textarea, 네이티브는 OS IME), 글자 그리기, OS 입력 이벤트 수신

**D5. 엔진에는 시계도 스레드도 없다**
- 동기 출력(`CSI ? 2026 h`) 타임아웃은 호스트가 관리한다. vte 기본 핸들러는 wasm에서 시계를 부르는 순간 죽는다는 걸 0.0.1에서 확인했다.
- 결과: 같은 입력 → 같은 화면(결정적), 테스트·재현이 쉽다.

**D6. 스크롤백 소유권은 호스트가 정한다**
- wmux: 데몬이 전체 스크롤백을 들고, 화면은 보이는 근처만 둔다. Alacritty 셀은 24바이트로 xterm.js(12바이트)의 두 배라, 화면 쪽에 다 두면 오히려 무거워진다.
- 단독 웹 사용: wasm 안에 스크롤백을 둔다(현재 기본). 5000줄 × 80열이면 패인당 약 9.6MB로 xterm.js(약 4.8MB)보다 무겁다. 이 수치는 README에 공개하고, 스크롤백 셀 압축 저장을 1.0 전에 검토한다.

**D7. 파싱을 Web Worker로 옮길 수 있게**
- wterm처럼 바쁜 패인이 많을 때 메인 스레드를 비우기 위해. 엔진 API가 이미 "바뀐 줄"만 주므로 Worker 경계를 넘기기 쉽다(M4).

**D8. oxty 저장소에서 개발하고, wmux는 처음부터 의존성으로 쓴다**
- "wmux 안에서 만들고 나중에 떼어내기"는 하지 않는다. 안에서 키우면 wmux 정책이 엔진에 섞인다. 이미 데몬 API(`textSnapshot`, `feedFrozen`)가 wmux 모양이다.
- wmux는 `oxty`를 git rev로 의존한다. 로컬 개발은 Cargo `[patch]`와 `npm link`로 바로 연결한다.
- wmux 전용 코드(스냅샷 형식, frozen ring, 패키징·서명)는 wmux-term에 남기고, 엔진만 oxty로 옮긴다.
- wmux 전용 동작은 엔진 옵션으로 열고, 기본값은 업스트림 동작으로 둔다. wmux가 옵션을 골라 기존 픽스처를 맞춘다.

---

## 6. 기능 요구사항 — 마일스톤

### M0 · 0.0.1 엔진 코어 ✅ 완료 (2026-10-31)

- 렌더러 무관 API: feed, resize, rowText, rowCells(packed), rowWrapped, cellText, cursor, modes, takeDamage, takeReplies, takeTitle, takeBells, syncPending/flushSync
- 스크롤백은 음수 줄 번호(-1이 가장 최근)
- npm 패키지 `oxty`(wasm 177KB, **미배포**), N-API 바인딩, CI(Windows·macOS·Linux)
- 테스트: Rust 15 + 문서 예제 1, npm 11, N-API 2
- **알려진 막힘:** crates.io 배포 불가 — `cargo publish`가 원본 Alacritty를 받아 와 빌드가 깨짐(M1에서 해결)

### M1 · 0.1 기반 다지기

| 요구사항 | 수용 기준 |
| --- | --- |
| 이름 선점: npm `oxty`, crates.io `oxty` | 각 레지스트리에 등록됨 |
| ✅ Alacritty 포크를 `oxty` 크레이트 안 `vt` 모듈로 내장 (D1) | 경로 변환 스크립트로 재현 가능, `cargo test`·wasm 빌드·`cargo publish --dry-run -p oxty` 통과 — `d321607`, PTY·이벤트 루프 모듈 제거 |
| **wmux-term이 vendor 포크 대신 `oxty`에 의존** (D8) | wmux의 기존 Rust 테스트·픽스처 91건(고유 입력 85) 통과, wmux 쪽 vendor 사본 제거 |
| ✅ 커서 문단 reflow 보존 패치를 옵션으로 — wmux 정책이 아니라 xterm.js 기본값(`reflowCursorLine: false`)이었다 | `vt::term::Config::reflow_cursor_line`(기본 `true` = Alacritty 동작), `oxty::Engine`은 xterm.js 동작 유지. Alacritty 원본 테스트 130건 통과 — `d321607` |
| ✅ ANSI serialize (wmux-term `native_serialize` 이식) | 직렬화→복원 후 화면 지문이 원본과 일치 — `Engine::ansi_snapshot`·JS/N-API `ansiSnapshot()`(`439cae5`·`0be743c`·`a077379`). wmux ANSI 60건이 59 같음 + `seed/14` 거부(wide edge)로 재현, 케이스마다 assert |
| ✅ 차분 테스트 장치: 같은 입력을 oxty와 `@xterm/headless`에 넣고 비교 | wmux 픽스처 91건(텍스트 31 + ANSI 60, 고유 입력 85) 이식, 전부 일치 또는 차이를 문서화 — `packages/oxty/test/xterm.test.mjs`, `npm ci && npm test`(`2aaf6b4`·`cf6d63f`·`209e531`). 입력 85건: 증명 A(셀 직접) 82 같음·3 차이, 증명 B(xterm 복원) 82 같음·1 차이·2 거부(`seed/14`, `text/scroll-margins`). 차이·거부는 전부 [known-differences.json](../packages/oxty/test/xterm/known-differences.json)에 이유와 `blocksSwap`으로 |
| 🟡 M2용 API 공백: 뷰포트(스크롤 위치·`scrollLines`), 커서 모양·깜빡임(DECSCUSR), 셀 확장 테이블(밑줄 색 SGR 58, OSC 8 링크), 행 단위 결합 문자 텍스트(지금은 칸마다 `cellText`), npm 패키지의 `node:fs` 분기가 브라우저 번들을 막지 않게 (D2, D3 스파이크) | 각 항목이 차분 테스트에서 xterm.js와 일치. 셀 형식 고정 — **구현 완료**: `displayOffset`·`scrollDisplay`·`scrollToBottom`, `cursor().shape/blink`, `rowExtras()`(결합 문자·밑줄 색·링크, attrs 비트 15·16), 번들 수정, wasm ABI 2. 셀 4워드 형식은 그대로 두고 확장은 행 단위 테이블로 고정. **차분 비교 완료**: 밑줄 색·OSC 8·결합 문자는 차분 장치 A·B에서 xterm.js와 비교, 커서 모양·깜빡임은 xterm 공개 API 밖이라 엔진 테스트(`cursor_shape_follows_decscusr`)로 고정. **남음**: 뷰포트 스크롤 위치(`displayOffset`)는 화면 레코드 밖이라 xterm.js와 비교하지 않았다 |
| ✅ 스크롤 damage: 스크롤된 줄 수를 함께 냄 (D2) — `vt::term::Config::scroll_damage`(기본 꺼짐 = Alacritty 동작), `oxty::Engine`이 켬 | 연속 출력 시 `Full` 대신 스크롤 줄 수 + 새 줄만 보고 |
| 호스트 정책 훅: OSC 52 클립보드, OSC 4/10/11 색 질의 | 훅 미설정 시 무시, 설정 시 응답 바이트가 xterm.js와 일치 |
| ✅ **D3 검증 스파이크**: xterm.js WebGL 아틀라스·렌더 모델을 떼어 oxty `rowPacked`로 한글·SGR·이모지 화면을 그림 | **D3 확정** — `spike/d3-webgl/`, `d3e84b7`·`afecf53`. 한글·16/256/RGB·속성·이모지·결합 문자·damage 갱신 정상, 콘솔 에러 0 |
| 성능 기준선 측정 (vtebench류 코퍼스, wasm·네이티브·xterm.js 비교) | 처리량·메모리 표를 README에 공개. 파서 단독과 `write`→프레임 end-to-end, 스크롤 연속 출력 케이스를 따로 측정 |

**G3 교체 게이트 현황** — `blocksSwap: true` 8건(목록 원본은 [known-differences.json](../packages/oxty/test/xterm/known-differences.json), `OXTY_SWAP_GATE=1 npm test`가 이 항목들로 실패한다): `reflow-shrink-scrolls-history`, `wide-leader-keeps-fg`, `sgr-21`, `ed2-pushes-history`, `tab-stored-as-tab`, `alt-47-1047-unsupported`, `save-cursor-1048-unsupported`, `decstr-unsupported`. 모두 엔진 동작 차이이고 직렬화기만의 차이는 없다. 0건이 되면 G3 "차분 불일치 0"을 충족한다.

### M2 · 0.2 웹 프런트 (wmux 렌더러 교체)

| 요구사항 | 수용 기준 |
| --- | --- |
| `oxty/xterm`: 차용한 WebGL 렌더러가 oxty 행을 그림 (D3) | 바뀐 줄만 갱신, WebGL 컨텍스트 손실 시 복구 |
| API 체크리스트: `new Terminal(opts)`, `open`, `write`, `onData`, `onBinary`, `onResize`, `onTitleChange`, `onBell`, `resize`, `buffer.active.getLine().translateToString()`, `loadAddon`, `dispose` | 체크리스트 100% + 지원 범위 표를 README에 공개 |
| 키 입력: xterm.js에서 차용한 `Keyboard.ts`가 oxty 모드 값을 읽음 | 기존 xterm.js와 키 입력 바이트 일치 |
| wmux 애드온 대체: fit·webgl은 내장, unicode11은 엔진 표, search·serialize는 oxty를 직접 호출, web-links는 OSC 8 + 정규식 감지 | wmux에서 쓰는 기능 전부 동작 (image는 §10 열린 질문) |
| 한글 IME 조합 | 조합 중 글자가 커서 위치에 표시되고, 확정된 글자만 PTY로 감. wmux 기존 IME·CJK 회귀 테스트 통과 |
| 선택 UI: 드래그 선택·복사 (계산은 M4에서 Rust로 이전) | 단어·줄 선택이 xterm.js와 같은 범위 |
| wmux 적용: 설정의 Terminal engine에 "oxty" 추가, xterm.js 내부 우회 코드 19곳(4개 파일) 대체 | 교체 전 차분 불일치 0, 교체 후 wmux e2e·IME 회귀·화면 스냅샷 회귀 0 |

### M3 · 0.3 입력을 Rust로

M2는 xterm.js에서 차용한 키 입력 코드로 동작한다. M3에서 인코딩을 Rust로 옮긴다.

| 요구사항 | 수용 기준 |
| --- | --- |
| 키보드 인코딩: 기본 xterm 방식, 커서·키패드 응용 모드, kitty keyboard protocol | 키×수식키×모드 행렬에서 xterm.js와 바이트 일치(kitty는 사양 기준) |
| 마우스 인코딩: X10, normal, SGR, 드래그·모션 | 모드별 바이트 일치 |
| 붙여넣기: bracketed paste, 위험 문자 처리 | xterm.js와 일치 |
| 포커스 이벤트 | 모드 활성 시 `CSI I` / `CSI O` |

### M4 · 0.4 화면 층 경량화

| 요구사항 | 수용 기준 |
| --- | --- |
| 선택 범위 계산·링크 감지를 Rust로 | xterm.js와 같은 선택 결과(단어·줄·사각 선택) |
| 뷰포트 전용 모드: 화면은 보이는 줄 ± 여유분만, 스크롤 시 호스트에서 가져옴 | 패인당 렌더러 메모리를 M1 기준선 대비 측정·공개 |
| Web Worker 파싱 옵션 | 패인 20개 동시 출력에서 메인 스레드 점유 감소를 측정 |
| 비활성 패인 그리기 생략 | 숨은 패인은 출력만 받고 그리지 않음 |

### M5 · 1.0 공개

- wmux 전 플랫폼 기본 엔진
- API 동결, 문서 사이트, 마이그레이션 가이드(xterm.js → oxty)
- 퍼징(파서·직렬화) 상시 운영, panic 0

### 1.0 이후

- 네이티브 렌더러(wgpu + cosmic-text) — wmux가 Electron을 벗어날 때
- 그래픽 프로토콜(kitty graphics, sixel)
- 셸 통합(OSC 133 프롬프트 구간)

---

## 7. 비기능 요구사항

| 영역 | 요구사항 |
| --- | --- |
| 정확성 | 기준은 xterm.js 동작. 차이는 모두 문서화하고 의도적인 것만 남김 |
| 유니코드 | 글자 폭은 xterm.js Unicode 11 프로바이더와 같은 표를 사용 |
| 결정성 | 엔진에 시계·스레드·난수 없음. 같은 입력 → 같은 화면 |
| 안정성 | wasm에서 panic 0(퍼징으로 확인), 잘못된 입력은 무시하고 계속 |
| 크기 | npm wasm 300KB 이하 유지(현재 177KB) |
| 성능 | `write`→프레임 end-to-end 처리량이 같은 코퍼스에서 xterm.js 이상. 목표값은 M1 기준선 측정 후 확정 |
| 메모리 | 셀 크기(24B)로 인한 스크롤백 메모리를 README에 공개, 압축 저장은 1.0 전 검토(D6) |
| 플랫폼 | Windows·macOS·Linux 네이티브, 최신 브라우저, Node 18 이상 |
| 라이선스 | oxty 코드는 MIT OR Apache-2.0. 내장한 `vt` 모듈(Alacritty 포크)은 Apache-2.0 + `LICENSE-XTERM`(Unicode 11 표)으로 MIT 재라이선스 불가 — 크레이트 라이선스 표기와 NOTICE에 반영. xterm.js 차용 모듈은 출처·커밋을 `THIRD_PARTY_NOTICES.md`에 기록. GPL 코드는 참고만 하고 복사하지 않음 |

---

## 8. 성공 지표

| 지표 | 목표 |
| --- | --- |
| 교체 전 차분 불일치 (`@xterm/headless` 대비) | 0, 또는 의도적 차이만 문서화 |
| 교체 후 wmux 회귀 (e2e·IME·화면 스냅샷) | 0 (7일 소크 기준) |
| wmux 렌더러 메모리 | M1 기준선 대비 감소폭 측정·공개 |
| 호환 API 체크리스트 | 100% (M2) |
| 외부 채택 | 공개 후 첫 달 npm 다운로드·스타 수를 기준으로 목표 설정 |

---

## 9. 리스크와 대응

| 리스크 | 영향 | 대응 |
| --- | --- | --- |
| 자체 프런트 범위 과다 (선택 UI·접근성 직접 구현) | M2 지연 | 렌더링 차용은 스파이크로 확인됨(D3). 선택·IME·키 입력·링크·접근성, 컨텍스트 손실 복구·DPR 변화·리거처는 아직 미검증 |
| 한글 대체 글꼴 폭 불균일 | 스파이크 화면에서 "안 녕 하 세 요"는 벌어지고 "입니다"는 붙음 | M2에서 글꼴 대체·글리프 폭 처리를 xterm.js와 비교 |
| 스냅샷이 엔진의 동기화 업데이트를 반영함 (코드 리뷰 2026-10-31) | 렌더러가 그리는 엔진에서 `ansiSnapshot()`을 부르면 반쯤 그린 프레임이 보이고, ESU가 스냅샷 경계에서 쪼개지면 타임아웃까지 동기화가 풀리지 않는다 | 지금은 스냅샷 전용(재생) 엔진에서만 쓰도록 문서화. 근본 해결은 동기화 전 화면 + 대기 바이트 원문을 싣는 설계(엔진이 대기 바이트를 직접 보관, vte는 개수만 공개) |
| 스냅샷이 싣지 않는 상태 (코드 리뷰) | 문자셋(ESC ( 0, SO/SI), DECSC 저장 커서, 탭 정지, 커서 모양, OSC 8 링크가 복원 터미널에서 사라져 이후 출력이 달라진다 | README에 명시. 엔진 상태로 거부하거나 직렬화에 싣는 것은 후속. 91건 픽스처에는 해당 시퀀스 없음 |
| 스냅샷 꼬리 스캐너가 vte와 다른 경우 (코드 리뷰·엔진 워커) | ESC 뒤 C0/DEL, DCS 안 BEL, ESC 직후 미완 멀티바이트에서 꼬리를 잃거나 잘못 끊는다(wmux 트래커와 같은 동작) | 재현 케이스를 붙여 후속 수정 |
| 스냅샷 성능 (코드 리뷰) | 셀마다 SGR 문자열을 새로 만들어 히스토리 10k×200열이면 할당 200만 회 | M1 성능 기준선에서 측정 후 이전 셀 속성 비교로 교체 |
| xterm.js 차용 모듈이 업스트림 수정을 못 받음 | IME·렌더링 버그 잔존 | 차용 모듈 목록과 출처 커밋을 기록하고, 업스트림 릴리스 노트를 분기마다 확인 |
| Alacritty 포크가 wmux와 oxty로 갈라짐 | "엔진 하나"가 "포크 둘"로 바뀔 뿐 | M1에서 wmux-term을 `oxty`로 통합(D8) |
| Alacritty 업스트림과의 거리 | 버그 수정을 못 받음 | 패치를 `WMUX-PATCH.md`처럼 목록화, 버전 올릴 때 차분 테스트로 검증. M1 이후 wasm 빌드용 feature(`tty`·`event_loop` 끄기)를 업스트림에 제안 |
| wmux 정책이 엔진에 섞임 | 외부 사용자에게 wmux 동작이 강제됨 | wmux 전용 동작은 엔진 옵션, 기본값은 업스트림(D8) |
| 동작 차이 (리플로우, IME, 폭) | wmux 화면 깨짐 | 교체 전 차분 테스트, 교체 후 wmux e2e·IME 회귀를 출시 관문으로 |
| wasm 경계 비용 (프레임마다 행 복사) | 바쁜 패인에서 프레임 저하 | 스크롤 줄 수 damage(M1)로 새 줄만 복사, Worker 옵션(M4), 측정으로 판단 |
| 스크롤백 메모리 (셀 24B) | 단독 웹 사용에서 xterm.js보다 무거움 | 수치 공개, 압축 저장 검토(D6) |
| 경쟁 (libghostty-vt 기반: ghostty-web·herdr·t3code) | 채택 어려움 | 차별점 명확히: Rust, 데몬·웹·네이티브 한 엔진, wmux 실사용. 이름 선점(M1) |
| 라이선스 오염 | 배포 불가 | Zed·COSMIC Terminal(GPL 계열)과 esctest(GPL-2.0)는 코드 복사 금지, 외부 도구로만 실행 |
| 1인 개발 | 진행 정체 | 마일스톤을 작게, wmux 실사용으로 검증 |

---

## 10. 결정 기록과 열린 질문

### 10.1 결정 (v0.2)

| v0.1 질문 | 결정 | 이유 |
| --- | --- | --- |
| 1. 호환층 패키지 이름 | `oxty/xterm` 하위 경로 (v0.3에서 변경) | 공개 이름을 `oxty` 하나로. 부품 차용(D3)이라 xterm.js 패키지 의존성이 없어 엔진 패키지가 무거워지지 않음 |
| 2. xterm.js 포크 vs 자체 프런트 | 자체 프런트 + 부품 차용, M1 스파이크로 확정 | D3 |
| 3. PTY를 oxty가 가질지 | 엔진에는 넣지 않음. 필요해지면 별도 크레이트 `oxty-pty` | "엔진은 바이트만" 원칙 유지 |
| 4. wmux-term과의 관계 | M1에서 wmux-term이 `oxty`에 의존 | G1의 전제. D8 |
| 5. 공개 시점 | M1(crates.io 배포) 후 공개 | Rust TUI 테스트 용도로는 그 시점에도 쓸 만하고, 경쟁 공간이라 일찍 자리 잡음 |

### 10.2 열린 질문

1. **wmux의 `@xterm/addon-image` 사용처** — 1.0 전 그래픽 프로토콜은 비목표인데 wmux가 image 애드온을 쓴다. M2에서 해당 기능만 xterm.js 경로로 남길지, 기능을 내릴지
2. **접근성 수준** — 자체 프런트가 스크린리더 지원을 어디까지 할지(xterm.js `AccessibilityManager` 차용 여부 포함)
3. **WebGL 불가 환경** — DOM 렌더러 대체 경로가 필요한지(wmux는 WebGL 전제)

---

## 11. 참고 오픈소스

상태·라이선스는 2026-10-31에 crates.io, npm, 각 저장소에서 확인했다.

### A. 기반 — 직접 쓰는 것

| 프로젝트 | 언어 · 라이선스 | 상태 | oxty가 가져갈 것 | 주의 |
| --- | --- | --- | --- | --- |
| [alacritty_terminal](https://github.com/alacritty/alacritty) | Rust · Apache-2.0 | 0.26.0 | 코어 그리드·상태(포크해서 사용) | 패치 목록 유지, 업그레이드 시 재검증 |
| [vte](https://github.com/alacritty/vte) | Rust · Apache-2.0 OR MIT | 0.15.0 | VT 파서 | 기본 동기 출력 핸들러는 wasm에서 사용 금지 |
| [xterm.js](https://github.com/xtermjs/xterm.js) | TS · MIT | 6.0.0 안정판 (wmux는 6.1 베타) | 부품 차용(WebGL 아틀라스·렌더 모델, IME 조합, 키 입력), 동작 기준, Unicode 11 표 | 차용 모듈의 출처·커밋 기록 |
| [portable-pty](https://github.com/wezterm/wezterm) | Rust · MIT | 0.9.0 | `oxty-pty` 후보 | 엔진과 분리 |

### B. 같은 문제를 푼 프로젝트 — 웹 터미널의 코어 교체

| 프로젝트 | 언어 · 라이선스 | 상태 | 참고할 점 |
| --- | --- | --- | --- |
| [ghostty-web](https://github.com/coder/ghostty-web) (Coder) | Zig→WASM · MIT | 0.4.0, wasm 약 400KB, 주 314,582 다운로드 | xterm.js API 호환을 어떻게 맞췄는지 → M2 체크리스트. 포크 없이 import 교체만으로 옮기게 한 방식 |
| [riotermjs](https://github.com/raphamorim/riotermjs) | Rust→WASM · MIT | 0.1.8, 초기 | Rust 코어 + 캔버스/DOM 렌더러 구조, xterm.js 마이그레이션 가이드 |
| [vercel-labs/wterm](https://github.com/vercel-labs/wterm) | Zig→WASM · Apache-2.0 | 내장 코어 wasm 약 26KB, libghostty 백엔드 선택 가능 | Worker 파싱(D7), 바뀐 줄만 그리기, 숨은 패인 그리기 생략, IME 조합 표시, DOM 기반 접근성 |

### C. 터미널 코어 라이브러리 — 대안·비교 대상

| 프로젝트 | 언어 · 라이선스 | 상태 | 참고할 점 |
| --- | --- | --- | --- |
| [libghostty-vt](https://mitchellh.com/writing/libghostty-is-coming) | Zig + C API · MIT(Ghostty 저장소) | 알파, API 미안정. 그래도 herdr가 vendor로, t3code가 wasm으로 실사용 | **실제 경쟁자.** 의존성 없는 VT 라이브러리 API 설계, kitty 키보드, 리플로우. 동작 기준점(D1) |
| [termwiz](https://github.com/wezterm/wezterm) (WezTerm) | Rust · MIT | 0.23.3 | 키 입력 인코딩, 화면 diff 모델, 하이퍼링크·이미지 모델 |
| [rio-backend](https://github.com/raphamorim/rio) | Rust · MIT | 0.5.28 | Alacritty 계열 그리드를 자체 발전시킨 사례 |

### D. 네이티브 렌더링 — Electron 이후

| 프로젝트 | 언어 · 라이선스 | 상태 | 참고할 점 |
| --- | --- | --- | --- |
| [wgpu](https://github.com/gfx-rs/wgpu) | Rust · MIT OR Apache-2.0 | 30.0.1 | GPU 렌더링 기반 |
| [cosmic-text](https://github.com/pop-os/cosmic-text) | Rust · MIT OR Apache-2.0 | 0.19.0 | 텍스트 셰이핑, 폰트 대체(한글·이모지) |
| [swash](https://github.com/dfrg/swash) / [glyphon](https://github.com/grovesNL/glyphon) | Rust · MIT/Apache 계열 | 0.2.10 / 0.12.0 | 글리프 래스터화, wgpu 텍스트 렌더링 |
| [sugarloaf](https://github.com/raphamorim/sugarloaf) (Rio) | Rust · MIT | 0.5.28 | 터미널 전용 wgpu 렌더러 구조 |
| [Zed](https://github.com/zed-industries/zed) 터미널 | Rust · GPL/AGPL 계열 | — | alacritty_terminal + 자체 GPU UI 연결 방식. **구조만 참고, 코드 복사 금지** |
| COSMIC Terminal | Rust · GPL-3 | — | Alacritty 엔진 + 자체 텍스트 렌더러. **구조만 참고** |

### E. 사양 · 적합성 테스트 · 벤치마크

| 자료 | 형태 | 쓰임 |
| --- | --- | --- |
| [xterm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) (Thomas Dickey) | 사양 문서 | 이스케이프 시퀀스 기준 |
| [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) | 사양 문서 | M3 키보드 인코딩 기준 |
| [vttest](https://invisible-island.net/vttest/vttest.html) | 대화형 테스트 | VT100/220 호환 수동 점검 |
| [esctest](https://github.com/migueldeicaza/esctest) | 자동 테스트 · Python · GPL-2.0 | 셀 값·커서 위치 자동 검증. **외부 도구로만 실행, 저장소에 넣지 않음** |
| [vtebench](https://github.com/jwilm/vtebench) | 처리량 벤치마크 | M1 성능 기준선 |
| wmux 내부 자산 | 픽스처 91건(고유 입력 85) + shadow 비교 장치 + IME·CJK 회귀 테스트 | **가장 중요한 회귀 자산.** 픽스처는 M1에서 oxty 차분 테스트로 이식, IME 회귀는 wmux e2e에서 계속 실행 |

---

## 부록 A. 0.0.1 API 요약 (npm)

```js
import { init, Terminal, Attr, Mode, decodeColor } from 'oxty';
await init();
const t = new Terminal({ cols: 80, rows: 24, scrollback: 5000, onSyncFlush });
t.write(bytesOrString);
t.takeDamage();      // { full, lines }
t.rowCells(y);       // Uint32Array [cp, fg, bg, attrs] × cols
t.rowText(-1);       // 스크롤백의 가장 최근 줄
t.takeReplies();     // PTY로 돌려보낼 바이트
t.cursor(); t.modes(); t.takeTitle(); t.takeBells();
```

## 부록 B. 이 문서의 수치 출처

- wmux 측정: `bench/rust-terminal-core.md`(픽스처 일치), `bench/bot-memory.md`(에이전트 비중, Run C 피크 샘플), 커밋 `dc6047dcd`(#2806, 별도 브랜치)
- npm 다운로드: api.npmjs.org, 2026-10-23~29
- 패키지 버전·라이선스: crates.io(`cargo info`), npm(`npm view`), GitHub API(Ghostty 라이선스), 2026-10-31
- 프로젝트 정보: 각 저장소 README, mitchellh.com(libghostty), heise(Ghostling)
- v0.2 검증 (2026-10-31)
  - Alacritty 포크 차이: `diff -rq`로 `wmux-term/vendor`와 `oxty/vendor` 비교, 3개 파일 다름
  - 스크롤 전체 damage: `vendor/alacritty_terminal/src/term/mod.rs`의 `scroll_up_relative`·`scroll_down_relative`가 `mark_fully_damaged` 호출
  - 셀 확장 데이터: `vendor/alacritty_terminal/src/term/cell.rs`의 `underline_color`·`hyperlink`
  - wmux의 xterm.js 내부 접근: `src/renderer/terminal/` 아래 4개 파일, 19곳(`_core`, `_renderService`, `_compositionHelper`, `_charSizeService`)
  - 레지스트리: npm `oxty`, crates.io `oxty` 모두 미등록(404)
