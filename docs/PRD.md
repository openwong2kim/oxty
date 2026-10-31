# oxty PRD — Rust 기반 xterm (터미널 엔진)

| 항목 | 내용 |
| --- | --- |
| 문서 버전 | v0.1 (초안) |
| 작성일 | 2026-10-31 |
| 저장소 | github.com/openwong2kim/oxty (비공개) |
| 현재 릴리스 | 0.0.1 — 엔진 코어, wasm, N-API, 테스트 |
| 첫 고객 | wmux |

---

## 1. 한 줄 정의

**oxty는 xterm.js의 "속"을 Rust로 대체하는 터미널 엔진이다.** 프로그램이 PTY에 쓴 바이트를 해석해 화면 상태를 들고 있고, 어떤 렌더러든 바뀐 줄만 가져가 그리게 한다. 같은 엔진이 데몬(네이티브), 브라우저·Electron 렌더러(WebAssembly), 미래의 네이티브 앱에서 똑같이 돈다.

---

## 2. 배경과 문제

### 2.1 wmux 안의 문제: 엔진이 두 개

- wmux 데몬은 이미 Rust 엔진(`core/wmux-term`, Alacritty 0.26 기반)을 쓴다. Windows에서는 기본값이다(#2806).
- 화면(렌더러)은 여전히 xterm.js 6.1 베타다.
- 엔진이 둘이라 "같은 바이트에 같은 화면"을 보장하려고 shadow 비교 장치와 픽스처를 따로 유지한다. 텍스트 31/31, ANSI 52건 일치 + 1건 의도적 거부까지 맞춰 왔다.
- 데몬 스냅샷과 화면이 어긋나면 모바일 승인·재접속 복원 같은 wmux의 핵심 기능이 흔들린다.

### 2.2 시장의 빈자리

- `@xterm/xterm`은 지난주(2026-10-23~29) npm에서 약 **861만** 회 다운로드됐다. 웹 터미널의 사실상 표준이다.
- "xterm.js API는 그대로, 속은 WASM 코어로" 바꾸는 흐름이 이미 시작됐다.
  - ghostty-web(Coder, Zig): 주 약 **31만** 회, xterm.js API 호환을 목표로 함
  - vercel-labs/wterm(Zig): DOM 렌더러, 자체 API
  - riotermjs(Rust): 0.1.8, 초기 단계
- **Rust로 된, 성숙한, xterm.js 호환 엔진은 아직 없다.** oxty가 노릴 자리다.

### 2.3 장기 방향

- wmux가 Electron을 벗어나 네이티브 Rust 앱으로 갈 때, 터미널 엔진은 어차피 필요하다. oxty는 그 길의 선행 작업이다.
- 참고: 메모리 관점에서 wmux의 가장 큰 비중은 에이전트 프로세스(실측 약 82%)다. oxty는 메모리 절감보다 **정확성(엔진 하나)과 플랫폼 독립성**이 1차 가치다.

---

## 3. 목표와 비목표

### 3.1 목표

| ID | 목표 | 판단 기준 |
| --- | --- | --- |
| G1 | **엔진 하나** — 데몬·웹·네이티브가 같은 코어를 쓴다 | wmux에서 데몬과 화면이 같은 oxty 빌드를 사용 |
| G2 | **xterm.js 호환 프런트** — import 교체 수준으로 옮길 수 있다 | 정의한 API 체크리스트 통과(§6 M3) |
| G3 | **wmux 적용** — 렌더러 엔진을 oxty로 교체 | shadow 불일치 0, 기존 wmux 테스트 통과 |
| G4 | **로직은 Rust에** — 입력 인코딩·선택·검색·링크까지 | 플랫폼별 코드는 IME·그리기·OS 입력만 |
| G5 | **오픈소스로 채택** — wmux 밖에서도 쓰인다 | 공개 후 외부 사용 사례 확보 |

### 3.2 비목표

- **터미널 앱 만들기** — 창, 탭, 분할, 설정 UI는 wmux 몫이다.
- **VT 파서를 처음부터 작성** — Alacritty 포크를 쓴다(§5 D1).
- **원조 xterm(X11, C) 호환** — 기준은 xterm.js의 동작이다.
- **1.0 이전 그래픽 프로토콜** — sixel, kitty graphics는 1.0 이후.
- **PTY·프로세스 관리** — 엔진은 바이트만 받는다. N-API 쪽 PTY 옵션은 열린 질문(§10).

---

## 4. 사용자와 사용 사례

| 사용자 | 사용 사례 | 받는 경로 |
| --- | --- | --- |
| **wmux** (첫 고객) | 데몬 스냅샷, Electron 렌더러, 웹·모바일 클라이언트를 한 엔진으로 | N-API + wasm |
| **웹 터미널 개발자** (xterm.js 사용자) | 클라우드 IDE, 웹 SSH, AI 에이전트 UI | npm |
| **Rust 앱 개발자** | 네이티브 터미널, TUI 테스트 도구, 에이전트 런타임 | crates.io |

---

## 5. 아키텍처

### 5.1 층 구조

```
┌──────────────────────────────────────────────────────────────┐
│ 프런트엔드                                                   │
│  oxty xterm 호환층 (xterm.js 포크: 렌더러·IME·선택 UI·접근성) │
│  네이티브 렌더러 (wgpu + cosmic-text, 1.0 이후)               │
├──────────────────────────────────────────────────────────────┤
│ 바인딩     npm `oxty` (wasm)   │  N-API `oxty-node`  │  Rust │
├──────────────────────────────────────────────────────────────┤
│ 엔진 `oxty`  렌더러 무관 API: feed / rows / cells / damage /  │
│              cursor / modes / replies / title / bell / sync   │
│              + (M2~) 입력 인코딩, 선택, 검색, 링크, serialize │
├──────────────────────────────────────────────────────────────┤
│ 코어 `oxty-vt`  Alacritty 0.26 포크 (vte 파서 + 그리드)       │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 설계 결정

**D1. 코어는 Alacritty 포크** (`alacritty_terminal` 0.26, Apache-2.0)
- 이유: Rust 네이티브이고, wmux에서 이미 패치·검증됐다(Unicode 11 폭, 리사이즈, blink, wasm32 빌드).
- 대안 검토: libghostty-vt는 기능이 풍부하지만 Zig·C API이고 아직 알파라 API가 안정되지 않았다. 처음부터 작성하는 건 가치 대비 비용이 크다.
- libghostty-vt는 **비교 대상이자 동작 기준점**으로 쓴다.

**D2. 렌더러 무관 API**
- 엔진은 "바뀐 줄 목록 + 셀 배열"만 내준다. xterm.js 어댑터와 미래의 네이티브 렌더러가 같은 API를 쓴다.
- 셀은 `[codepoint, fg, bg, attrs]` u32 4개. 색은 종류(named/256/RGB)를 상위 바이트에 담아, 테마는 렌더러가 결정한다.

**D3. 웹 프런트는 xterm.js 포크로 시작**
- xterm.js의 `common`(파서·버퍼)을 oxty로 바꾸고, `browser` 층(WebGL/DOM 렌더러, IME 조합, 선택 UI, 접근성)과 애드온은 살린다.
- 이유: wmux와 기존 xterm.js 사용자가 가장 적은 비용으로 옮길 수 있다. 자체 DOM 렌더러(wterm 방식)는 이후 선택지로 남긴다.
- 핵심 난제: WebGL 렌더러가 읽는 버퍼 인터페이스를 oxty 행 위에 구현하는 **어댑터**(§6 M3).

**D4. 로직은 Rust, 플랫폼 층은 얇게**
- Rust: 키보드·마우스·붙여넣기 인코딩, 선택 범위 계산, 검색, 링크 감지, serialize
- 플랫폼: IME(웹은 DOM textarea, 네이티브는 OS IME), 글자 그리기, OS 입력 이벤트 수신

**D5. 엔진에는 시계도 스레드도 없다**
- 동기 출력(`CSI ? 2026 h`) 타임아웃은 호스트가 관리한다. vte 기본 핸들러는 wasm에서 시계를 부르는 순간 죽는다는 걸 0.0.1에서 확인했다.
- 결과: 같은 입력 → 같은 화면(결정적), 테스트·재현이 쉽다.

**D6. 스크롤백 소유권은 호스트가 정한다**
- wmux: 데몬이 전체 스크롤백을 들고, 화면은 보이는 근처만 둔다. Alacritty 셀은 24바이트로 xterm.js(12바이트)의 두 배라, 화면 쪽에 다 두면 오히려 무거워진다.
- 단독 웹 사용: wasm 안에 스크롤백을 둔다(현재 기본).

**D7. 파싱을 Web Worker로 옮길 수 있게**
- wterm처럼 바쁜 패인이 많을 때 메인 스레드를 비우기 위해. 엔진 API가 이미 "바뀐 줄"만 주므로 Worker 경계를 넘기기 쉽다(M4).

---

## 6. 기능 요구사항 — 마일스톤

### M0 · 0.0.1 엔진 코어 ✅ 완료 (2026-10-31)

- 렌더러 무관 API: feed, resize, rowText, rowCells(packed), rowWrapped, cellText, cursor, modes, takeDamage, takeReplies, takeTitle, takeBells, syncPending/flushSync
- 스크롤백은 음수 줄 번호(-1이 가장 최근)
- npm `oxty`(wasm 177KB), N-API 바인딩, CI(Windows·macOS·Linux)
- 테스트: Rust 15 + 문서 예제 1, npm 11, N-API 2
- **알려진 막힘:** crates.io 배포 불가 — `cargo publish`가 원본 Alacritty를 받아 와 빌드가 깨짐(M1에서 해결)

### M1 · 0.1 기반 다지기

| 요구사항 | 수용 기준 |
| --- | --- |
| Alacritty 포크를 `oxty-vt`로 분리·배포 | `cargo publish -p oxty` 검증 통과, crates.io에 `oxty` 등록 |
| ANSI serialize (wmux-term `native_serialize` 이식) | 직렬화→복원 후 화면 지문이 원본과 일치 |
| 차분 테스트 장치: 같은 입력을 oxty와 `@xterm/headless`에 넣고 비교 | wmux 픽스처 84건 이식, 전부 일치 또는 차이를 문서화 |
| 호스트 정책 훅: OSC 52 클립보드, OSC 4/10/11 색 질의, OSC 8 하이퍼링크 | 훅 미설정 시 무시, 설정 시 응답 바이트가 xterm.js와 일치 |
| 성능 기준선 측정 (vtebench류 코퍼스, wasm·네이티브·xterm.js 비교) | 처리량·메모리 표를 README에 공개 |

### M2 · 0.2 입력을 Rust로

| 요구사항 | 수용 기준 |
| --- | --- |
| 키보드 인코딩: 기본 xterm 방식, 커서·키패드 응용 모드, kitty keyboard protocol | 키×수식키×모드 행렬에서 xterm.js와 바이트 일치(kitty는 사양 기준) |
| 마우스 인코딩: X10, normal, SGR, 드래그·모션 | 모드별 바이트 일치 |
| 붙여넣기: bracketed paste, 위험 문자 처리 | xterm.js와 일치 |
| 포커스 이벤트 | 모드 활성 시 `CSI I` / `CSI O` |

### M3 · 0.3 xterm.js 호환층 (wmux 렌더러 교체)

| 요구사항 | 수용 기준 |
| --- | --- |
| xterm.js 포크에서 `common` 층을 oxty 어댑터로 교체 | WebGL·DOM 렌더러가 oxty 버퍼로 화면을 그림 |
| API 체크리스트: `new Terminal(opts)`, `open`, `write`, `onData`, `onBinary`, `onResize`, `onTitleChange`, `onBell`, `resize`, `buffer.active.getLine().translateToString()`, `loadAddon`, `dispose` | 체크리스트 100% + 지원 범위 표를 README에 공개 |
| 애드온: fit, webgl, search, serialize, unicode11, web-links | wmux에서 쓰는 애드온 전부 동작 |
| 한글 IME 조합 | 조합 중 글자가 커서 위치에 표시되고, 확정된 글자만 PTY로 감. wmux 기존 IME·CJK 회귀 테스트 통과 |
| wmux 적용 | 설정의 Terminal engine에 "oxty" 추가, shadow 비교 불일치 0 |

### M4 · 0.4 화면 층 경량화

| 요구사항 | 수용 기준 |
| --- | --- |
| 선택·검색·링크 감지를 Rust로 | xterm.js와 같은 선택 결과(단어·줄·사각 선택) |
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
| 성능 | 처리량은 같은 코퍼스에서 xterm.js 이상. 목표값은 M1 기준선 측정 후 확정 |
| 플랫폼 | Windows·macOS·Linux 네이티브, 최신 브라우저, Node 18 이상 |
| 라이선스 | MIT OR Apache-2.0. GPL 코드는 참고만 하고 복사하지 않음 |

---

## 8. 성공 지표

| 지표 | 목표 |
| --- | --- |
| wmux shadow 비교 불일치 | 0 (7일 소크 기준) |
| wmux 렌더러 메모리 | M1 기준선 대비 감소폭 측정·공개 |
| 호환 API 체크리스트 | 100% (M3) |
| 외부 채택 | 공개 후 첫 달 npm 다운로드·스타 수를 기준으로 목표 설정 |

---

## 9. 리스크와 대응

| 리스크 | 영향 | 대응 |
| --- | --- | --- |
| xterm.js 포크 유지 부담 (6.x 베타가 계속 바뀜) | 업스트림 수정 반영이 늦어짐 | 포크 범위를 `common` 교체로 최소화, 어댑터 경계를 좁게 |
| Alacritty 업스트림과의 거리 | 버그 수정을 못 받음 | 패치를 `WMUX-PATCH.md`처럼 목록화, 버전 올릴 때 차분 테스트로 검증 |
| 동작 차이 (리플로우, IME, 폭) | wmux 화면 깨짐 | 차분 테스트 + shadow 비교를 출시 관문으로 |
| wasm 경계 비용 (프레임마다 행 복사) | 바쁜 패인에서 프레임 저하 | 바뀐 줄만 복사, Worker 옵션(M4), 측정으로 판단 |
| 경쟁 (ghostty-web이 앞서 있음) | 채택 어려움 | 차별점 명확히: Rust, 데몬·웹·네이티브 한 엔진, wmux 실사용 |
| 라이선스 오염 | 배포 불가 | Zed·COSMIC Terminal(GPL 계열)과 esctest(GPL-2.0)는 코드 복사 금지, 외부 도구로만 실행 |
| 1인 개발 | 진행 정체 | 마일스톤을 작게, wmux 실사용으로 검증 |

---

## 10. 열린 질문

1. **호환층 패키지 이름** — npm `oxty/xterm` 서브패스로 둘지, `@oxty/xterm` 스코프로 분리할지
2. **xterm.js 포크 vs 자체 프런트** — M3를 포크로 시작하되, 언제 자체 DOM 렌더러를 검토할지
3. **PTY를 oxty가 가질지** — N-API 쪽에 portable-pty 기반 PTY를 넣으면 wmux-term의 NativePty를 옮길 수 있지만, "엔진은 바이트만" 원칙과 충돌
4. **wmux-term과의 관계** — oxty가 안정되면 wmux가 `core/wmux-term` 대신 oxty를 의존성으로 쓸지
5. **공개 시점** — M1(crates.io 배포) 후 공개할지, M3(xterm.js 호환) 후 공개할지

---

## 11. 참고 오픈소스

상태·라이선스는 2026-10-31에 crates.io, npm, 각 저장소에서 확인했다.

### A. 기반 — 직접 쓰는 것

| 프로젝트 | 언어 · 라이선스 | 상태 | oxty가 가져갈 것 | 주의 |
| --- | --- | --- | --- | --- |
| [alacritty_terminal](https://github.com/alacritty/alacritty) | Rust · Apache-2.0 | 0.26.0 | 코어 그리드·상태(포크해서 사용) | 패치 목록 유지, 업그레이드 시 재검증 |
| [vte](https://github.com/alacritty/vte) | Rust · Apache-2.0 OR MIT | 0.15.0 | VT 파서 | 기본 동기 출력 핸들러는 wasm에서 사용 금지 |
| [xterm.js](https://github.com/xtermjs/xterm.js) | TS · MIT | 6.0.0 안정판 (wmux는 6.1 베타) | 포크 기반(브라우저 층·애드온), 동작 기준, Unicode 11 표 | 포크 범위 최소화 |
| [portable-pty](https://github.com/wezterm/wezterm) | Rust · MIT | 0.9.0 | N-API PTY 옵션 후보 | 열린 질문 3 |

### B. 같은 문제를 푼 프로젝트 — 웹 터미널의 코어 교체

| 프로젝트 | 언어 · 라이선스 | 상태 | 참고할 점 |
| --- | --- | --- | --- |
| [ghostty-web](https://github.com/coder/ghostty-web) (Coder) | Zig→WASM · MIT | 0.4.0, wasm 약 400KB, 주 약 31만 다운로드 | xterm.js API 호환을 어떻게 맞췄는지 → M3 체크리스트. import 교체만으로 옮기게 한 방식 |
| [riotermjs](https://github.com/raphamorim/riotermjs) | Rust→WASM · MIT | 0.1.8, 초기 | Rust 코어 + 캔버스/DOM 렌더러 구조, xterm.js 마이그레이션 가이드 |
| [vercel-labs/wterm](https://github.com/vercel-labs/wterm) | Zig→WASM · Apache-2.0 | 내장 코어 wasm 약 26KB, libghostty 백엔드 선택 가능 | Worker 파싱(D7), 바뀐 줄만 그리기, 숨은 패인 그리기 생략, IME 조합 표시, DOM 기반 접근성 |

### C. 터미널 코어 라이브러리 — 대안·비교 대상

| 프로젝트 | 언어 · 라이선스 | 상태 | 참고할 점 |
| --- | --- | --- | --- |
| [libghostty-vt](https://mitchellh.com/writing/libghostty-is-coming) | Zig + C API · 라이선스 미확인(Ghostty 저장소 확인 필요) | 알파, API 미안정 | 의존성 없는 VT 라이브러리 API 설계, kitty 키보드, 리플로우. 동작 기준점(D1) |
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
| [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) | 사양 문서 | M2 키보드 인코딩 기준 |
| [vttest](https://invisible-island.net/vttest/vttest.html) | 대화형 테스트 | VT100/220 호환 수동 점검 |
| [esctest](https://github.com/migueldeicaza/esctest) | 자동 테스트 · Python · GPL-2.0 | 셀 값·커서 위치 자동 검증. **외부 도구로만 실행, 저장소에 넣지 않음** |
| [vtebench](https://github.com/jwilm/vtebench) | 처리량 벤치마크 | M1 성능 기준선 |
| wmux 내부 자산 | 픽스처 84건 + shadow 비교 장치 | **가장 중요한 회귀 자산.** M1에서 oxty로 이식 |

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

- wmux 측정: `bench/rust-terminal-core.md`(픽스처 일치), `bench/bot-memory.md`(에이전트 비중), CHANGELOG #2806
- npm 다운로드: api.npmjs.org, 2026-10-23~29
- 패키지 버전·라이선스: crates.io(`cargo info`), npm(`npm view`), 2026-10-31
- 프로젝트 정보: 각 저장소 README, mitchellh.com(libghostty), heise(Ghostling)
