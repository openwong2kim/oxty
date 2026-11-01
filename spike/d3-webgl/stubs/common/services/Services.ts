// [oxtty 스텁] xterm.js src/common/services/Services.ts(396줄, 서비스 22개)를 대체한다.
// 복사한 렌더러 부품이 실제로 부르는 멤버만 남긴 인터페이스다. 구현은 src/services.ts.
import { IColor } from 'common/Types';

export interface IOptionsService {
  // GlyphRenderer: rescaleOverlappingGlyphs, CellColorResolver: fontSize
  readonly rawOptions: { readonly rescaleOverlappingGlyphs: boolean, readonly fontSize: number };
}

export interface IUnicodeService {
  // TextureAtlas: 밑줄·취소선 폭을 글자 칸 수로 정할 때만 쓴다
  wcwidth(codepoint: number): number;
  getStringCellWidth(s: string): number;
}

export interface IDecorationService {
  // CellColorResolver: 데코레이션 색 덮어쓰기
  forEachDecorationAtCell(x: number, y: number, layer: 'bottom' | 'top' | undefined, callback: (decoration: { backgroundColorRGB: IColor | undefined, foregroundColorRGB: IColor | undefined }) => void): void;
}
