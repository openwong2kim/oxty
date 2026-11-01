// [oxtty 스텁] xterm.js src/browser/services/Services.ts(158줄, 서비스 9개)를 대체한다.
// 복사한 렌더러 부품이 실제로 부르는 멤버만 남긴 인터페이스다. 구현은 src/services.ts.
import { ReadonlyColorSet } from 'browser/Types';
import type { Event } from 'vs/base/common/event';

export interface IThemeService {
  // RectangleRenderer·CellColorResolver
  readonly colors: ReadonlyColorSet;
  readonly onChangeColors: Event<ReadonlyColorSet>;
}

export interface ICoreBrowserService {
  // CellColorResolver: 점선 밑줄 위상(dpr), 선택 색(isFocused)
  readonly dpr: number;
  readonly isFocused: boolean;
}
