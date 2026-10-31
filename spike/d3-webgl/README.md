# D3 검증 스파이크: xterm.js WebGL 부품으로 oxty 행 그리기

PRD §5 D3("얇은 자체 프런트 + xterm.js 부품 차용")가 실제로 되는지 판정하는 스파이크다. xterm.js의 WebGL 렌더러 부품(글리프 텍스처 아틀라스, 글리프·사각형 렌더러, 렌더 모델, 셀 색 해석기)을 떼어 와서, oxty wasm 엔진의 `rowCells(y)` 출력으로 캔버스에 화면을 그린다.

## 판정: **D3 확정**

- 렌더러 부품 22개 파일(4,646줄)을 복사했고, **19개는 한 글자도 고치지 않았다**. 나머지 3개는 타입 선언 파일에서 필요한 인터페이스만 원문 그대로 잘라 온 발췌본이다. 복사한 코드의 로직은 하나도 고치지 않았다.
- 딸려 나온 내부 서비스는 5개이고, 각각 실제로 쓰는 멤버가 1~2개였다. 스텁 전체가 112줄이고, 이 중 서비스 인터페이스 스텁은 35줄이다.
- 버퍼 쪽(`IBufferService`, `BufferLine`, `CellData`, `ICoreService`)과 렌더 서비스 쪽(`IRenderService`, `ICharSizeService`, `ICharacterJoinerService`, `ILinkifier2`)은 **하나도 딸려 오지 않았다**. 경계가 "렌더 모델(`Uint32Array` 셀당 4워드)"에서 깔끔하게 끊긴다.
- 그래서 xterm.js `WebglRenderer.ts`(679줄)를 대신하는 오케스트레이터 179줄과 셀 변환기 108줄만으로 한글·16/256/RGB 색·속성·넓은 글자 이모지·결합 문자·박스 문자·커서를 그렸다. damage를 읽어 바뀐 줄만 다시 그리는 경로도 확인했다.

## 실행

```sh
cd spike/d3-webgl
npm install
npm run build        # tsc --noEmit → esbuild 번들 → dist/ (oxty.wasm이 없으면 scripts/build-wasm.sh 실행)
npm run screenshot   # 로컬 서버 + 시스템 Chrome(headless) → screenshot.png, 콘솔 에러가 있으면 exit 1
```

![screenshot](screenshot.png)

육안 확인 결과:
- 한글은 2칸에 맞춰 그려지고, 16색 전경·배경, 256색(큐브·회색조), RGB 배경 그라데이션, RGB·256색 전경 모두 정상이다.
- bold, italic, underline(한글 2칸 폭 포함), inverse, dim, strike, curly 밑줄이 정상이다. bold+파랑은 `drawBoldTextInBrightColors`에 따라 밝은 파랑으로 그려진다.
- 😀🎉👍는 2칸에 그려지고 앞뒤 칸 경계가 깨지지 않는다. 결합 문자(é ä ñ)와 박스·블록 문자(CustomGlyphs)도 정상이다.
- 커서는 블록으로 그려진다. 2차 write 뒤 마지막 줄로 옮겨졌고, 이전 커서 칸은 지워졌다.
- 예상한 차이: curly 밑줄을 빨강(SGR 58)으로 지정했지만 전경색으로 그려진다. oxty 셀 형식에 밑줄 색이 없기 때문이다(아래 "엔진 API에 부족했던 점" 1).

## xterm.js 출처

- 저장소: https://github.com/xtermjs/xterm.js
- 태그 `6.0.0`, 커밋 `f447274f430fd22513f6adbf9862d19524471c04`
- 라이선스: MIT, 사본은 [`vendor-xterm/LICENSE`](vendor-xterm/LICENSE)
- 파일마다 맨 위 2줄에 출처 경로·커밋과 "원문 그대로/발췌" 여부를 적었다. 디렉터리 구조는 원본 경로를 그대로 따른다.

## 복사한 파일 (22개, 4,646줄. 머리 주석 2줄 제외)

| 파일 | 줄 수 | 상태 | 역할 |
|---|---:|---|---|
| `addons/addon-webgl/src/TextureAtlas.ts` | 1138 | 원문 | 글리프 래스터화·아틀라스 페이지 관리 |
| `addons/addon-webgl/src/CustomGlyphs.ts` | 693 | 원문 | 박스·블록·파워라인 문자 직접 그리기 |
| `addons/addon-webgl/src/GlyphRenderer.ts` | 390 | 원문 | 글리프 인스턴스 셰이더 |
| `addons/addon-webgl/src/RectangleRenderer.ts` | 382 | 원문 | 배경·커서 사각형 셰이더 |
| `addons/addon-webgl/src/CellColorResolver.ts` | 236 | 원문 | inverse·선택·데코레이션 색 해석 |
| `addons/addon-webgl/src/Types.ts` | 126 | 원문 | 렌더 모델·아틀라스 타입 |
| `addons/addon-webgl/src/CharAtlasUtils.ts` | 80 | 원문 | 아틀라스 설정 생성 |
| `addons/addon-webgl/src/WebglUtils.ts` | 63 | 원문 | 셰이더 컴파일 유틸 |
| `addons/addon-webgl/src/RenderModel.ts` | 41 | 원문 | 렌더 모델(셀당 code·bg·fg·ext) |
| `addons/addon-webgl/src/Constants.ts` | 12 | 원문 | |
| `src/common/Color.ts` | 376 | 원문 | 색 변환·대비 |
| `src/common/buffer/AttributeData.ts` | 211 | 원문 | fg·bg·ext 비트 해석 |
| `src/common/TaskQueue.ts` | 166 | 원문 | 아틀라스 예열용 idle 큐 |
| `src/common/buffer/Constants.ts` | 157 | 원문 | 속성 비트 상수 |
| `src/common/Platform.ts` | 44 | 원문 | |
| `src/common/MultiKeyMap.ts` | 42 | 원문 | 글리프 캐시 키 |
| `src/browser/renderer/shared/RendererUtils.ts` | 95 | 원문 | |
| `src/browser/renderer/shared/SelectionRenderModel.ts` | 93 | 원문 | 선택 범위 렌더 모델 |
| `src/browser/ColorContrastCache.ts` | 34 | 원문 | |
| `src/common/Types.ts` | 119 (원본 552) | 발췌 | `IColor`·`IAttributeData`·`ICellData` 등 |
| `src/browser/Types.ts` | 95 (원본 226) | 발췌 | `IColorSet`·`DEFAULT_ANSI_COLORS`, `ITerminal` 스텁 포함 |
| `src/browser/renderer/shared/Types.ts` | 53 (원본 84) | 발췌 | `IRenderDimensions`·`ISelectionRenderModel` |

가져오지 않은 것: `WebglRenderer`·`WebglAddon`(oxty 오케스트레이터로 대체), `CharAtlasCache`(터미널 간 아틀라스 공유), `CursorBlinkStateManager`, `DevicePixelObserver`, `renderLayer/LinkRenderLayer`, `common/buffer/CellData`·`BufferLine`, 서비스 구현 전부.

## 스텁 목록 (인터페이스별 구현한 멤버 수)

복사한 부품이 실제로 부르는 멤버만 남겼다. 인터페이스는 `stubs/`, 구현은 `src/services.ts`.

| 스텁 | 원본 | 남긴 멤버 | 구현 |
|---|---|---|---|
| `IOptionsService` | `common/services/Services.ts` (396줄, 서비스 22개) | 1: `rawOptions`(`rescaleOverlappingGlyphs`, `fontSize`) | 상수 객체 |
| `IUnicodeService` | 〃 | 2: `wcwidth`, `getStringCellWidth` | oxty `WIDE` 비트로 채운 집합 조회(유니코드 폭 표를 가져오지 않음) |
| `IDecorationService` | 〃 | 1: `forEachDecorationAtCell` | 빈 함수 |
| `IThemeService` | `browser/services/Services.ts` (158줄, 서비스 9개) | 2: `colors`, `onChangeColors` | `DEFAULT_ANSI_COLORS`로 만든 색 집합 |
| `ICoreBrowserService` | 〃 | 2: `dpr`, `isFocused` | 상수 |
| `@xterm/xterm` `Terminal` | `typings/xterm.d.ts` (1957줄) | 4: `cols`, `rows`, `element`, `buffer.active.viewportY` | oxty `Terminal`을 감싼 객체 |
| `@xterm/xterm` `ITerminalOptions` | 〃 | 10개 필드(타입만) | `terminalOptions` |
| `browser/Types` `ITerminal` | `browser/Types.ts` | 2: `rows`, `buffers.active.ydisp` | 타입만. 선택 갱신(`SelectionRenderModel.update`)에서만 쓰고, 이 스파이크는 부르지 않음 |
| `vs/base/common/lifecycle` | 801줄 (VS Code 유래) | `Disposable`(`_register`, `dispose`), `toDisposable` | 23줄 |
| `vs/base/common/event` | 1778줄 (VS Code 유래) | `Emitter`(`event`, `fire`, `dispose`), `Event` 타입 | 22줄 |

`ICharSizeService`는 스텁하지 않았다. 대신 렌더러 안에서 xterm.js `TextMetricsMeasureStrategy`와 같은 방식으로 글자 크기를 잰다(10줄).

## oxty 셀 → xterm 렌더 모델 변환 (`src/convert.ts`, `src/OxtyWebglRenderer.ts`)

xterm.js는 `BufferLine.loadCell(x, CellData)`로 셀을 읽고, `CellColorResolver.resolve()`로 색을 확정해 렌더 모델(`Uint32Array`, 셀당 `[code, bg, fg, ext]`)에 넣는다. 스파이크는 `loadCell` 자리에 `OxtyCellData.load()`를 넣고, 나머지(`CellColorResolver` → `RenderModel` → `GlyphRenderer.updateCell` → `RectangleRenderer.updateBackgrounds`)는 원본을 그대로 탄다.

- **색**: oxty 상위 바이트 종류 → xterm `Attributes.CM_*`
  - RGB → `CM_RGB | 0xRRGGBB`
  - INDEXED n → n < 16이면 `CM_P16 | n`, 아니면 `CM_P256 | n`
  - NAMED 0~15 → `CM_P16 | n`, Dim 계열(259~266) → `CM_P16 | (n-259)`, 256·257·258·267·268(기본 전경·배경·커서 등) → `CM_DEFAULT`
- **속성**: BOLD·INVERSE·HIDDEN·STRIKEOUT·BLINK·UNDERLINE → `fg`의 `FgFlags`, DIM·ITALIC → `bg`의 `BgFlags`. 이중·물결·점선·파선 밑줄은 `bg |= HAS_EXTENDED`, `ext`에 `UnderlineStyle`.
- **넓은 글자**: `WIDE`면 폭 2, `WIDE_SPACER`는 xterm.js와 같이 코드 0·폭 0으로 두고 색은 유지한다(배경 사각형이 이어지게). `WIDE` 코드포인트는 `IUnicodeService` 스텁에 기록해 아틀라스가 밑줄 폭을 2칸으로 그리게 한다.
- **결합 문자**: `COMBINING`이면 `cellText(y, x)`로 전체 문자열을 받아 xterm.js의 combined 경로(`COMBINED_CHAR_BIT_MASK`, `getRasterizedGlyphCombinedChar`)로 보낸다. 아스트랄 문자(이모지)도 xterm.js처럼 JS 문자열 길이가 2라서 같은 경로를 탄다.
- **커서**: `cursor()`의 line·col·visible로 블록 커서 칸 색을 덮어쓴다(`WebglRenderer._updateModel`과 같은 방식).
- **갱신**: `takeDamage()`가 `full`이면 전체를, 아니면 `lines`만 모델에 반영한다. 모델에 이미 같은 값이 있는 칸은 건너뛴다(원본 로직 그대로).

## oxty 엔진 API에 부족했던 점

1. **밑줄 색(SGR 58) 없음**: 셀 4워드에 자리가 없어 curly 밑줄이 전경색으로 그려진다. PRD D2의 행별 확장 테이블이 필요하다. xterm 쪽은 `ext` 하위 26비트(`underlineColor`)에 바로 넣으면 된다.
2. **결합 문자 문자열을 칸마다 따로 가져와야 함**: `rowCells`에는 `COMBINING` 플래그만 있고, 문자열은 `cellText(y, x)`를 칸마다 불러야 한다. 결합 문자가 많은 줄(데바나가리·한글 자모 조합 등)에서는 wasm 경계 호출이 칸 수만큼 늘어난다. 행 단위로 받는 API(예: 열 → 문자열 확장 테이블)가 있으면 좋다. D2 확장 테이블에 함께 넣는 것을 권한다.
3. **커서 모양 없음**: `cursor()`는 line·col·visible만 준다. DECSCUSR(블록·밑줄·막대, 깜빡임)를 그리려면 모양과 깜빡임 여부가 필요하다. 지금은 블록으로 고정했다.
4. **패키징**: `packages/oxty/src/index.js`의 `await import('node:fs/promises')` 분기 때문에 esbuild로 브라우저 번들을 만들 때 `external: ['node:*']`를 지정해야 했다. 다른 번들러도 경고나 오류를 낼 수 있다.

넓은 글자 폭은 `WIDE`·`WIDE_SPACER` 비트로 충분했다. 아틀라스가 쓰던 xterm.js 유니코드 폭 판정을 엔진 결과로 바꿀 수 있었다.

## 남은 위험

- **범위 밖이라 검증하지 않음**: 선택·IME·키 입력·스크롤·링크·접근성. 선택은 `SelectionRenderModel`과 `CellColorResolver`의 선택 색 처리를 이미 복사해 두어서, 선택 범위(Rust, D4)만 받으면 연결된다.
- **아직 붙이지 않은 부품**: WebGL 컨텍스트 손실 복구, DPR 변화 감지(`DevicePixelObserver` 40줄), 커서 깜빡임(`CursorBlinkStateManager` 146줄. `ICoreBrowserService`에 멤버가 몇 개 더 필요), 리거처(`ICharacterJoinerService`), 테마·글꼴 변경 시 아틀라스 재생성. 모두 원본 `WebglRenderer`에 패턴이 있어서 옮길 수 있다고 보지만, 스텁 멤버가 몇 개 더 늘어난다.
- **성능은 재지 않음**: `rowCells`가 줄마다 `slice()`로 복사하는 비용, `cellText` 호출 비용, 큰 화면(200×60)에서 전체를 갱신하는 프레임 시간.
- **실행 환경**: macOS headless Chrome 한 곳에서만 확인했다. 한글은 Menlo에 없어 시스템 대체 글꼴(Apple SD Gothic Neo)로 그려졌다. 다른 OS의 글꼴 대체와 폭 맞춤은 확인하지 않았다.
- **업스트림 추적**: 복사본은 6.0.0에 고정했다. 업스트림을 따라갈 의무는 없지만, 아틀라스 버그 수정을 가져오려면 손으로 비교해야 한다. 원문을 그대로 두었으므로 `diff`로 비교할 수 있다.
