// D3 스파이크 데모: 하드코딩한 ANSI 문자열을 oxtty 엔진에 넣고, 차용한 xterm.js WebGL 부품으로 그린다.
import { init, Terminal } from '../../../packages/oxtty/dist/index.js';
import { OxttyWebglRenderer } from './OxttyWebglRenderer';

const ESC = '\x1b[';
const reset = `${ESC}0m`;

function demoText(cols: number): string {
  const lines: string[] = [];
  lines.push(`${ESC}1;38;2;120;200;255moxtty D3 spike${reset} — xterm.js 6.0.0 WebGL 부품 + oxtty rowCells()`);
  lines.push('한글: 안녕하세요, 터미널 엔진 oxtty입니다. (가나다라마바사)');

  // 16색 전경·배경
  let fg16 = '16색 fg: ';
  for (let i = 0; i < 8; i++) fg16 += `${ESC}${30 + i}m색${i}${reset} `;
  for (let i = 0; i < 8; i++) fg16 += `${ESC}${90 + i}m${8 + i}${reset} `;
  lines.push(fg16);
  let bg16 = '16색 bg: ';
  for (let i = 0; i < 8; i++) bg16 += `${ESC}${40 + i}m  ${reset}`;
  for (let i = 0; i < 8; i++) bg16 += `${ESC}${100 + i}m  ${reset}`;
  lines.push(bg16);

  // 256색: 색 큐브 16~231을 3줄, 회색조 232~255를 1줄
  for (let row = 0; row < 3; row++) {
    let s = '';
    for (let i = 0; i < 72; i++) s += `${ESC}48;5;${16 + row * 72 + i}m ${reset}`;
    lines.push(s);
  }
  let grey = '';
  for (let i = 232; i < 256; i++) grey += `${ESC}48;5;${i}m   ${reset}`;
  lines.push(grey);

  // RGB 그라데이션(배경) + RGB 전경 글자
  let rgb = '';
  for (let i = 0; i < cols; i++) {
    const t = i / (cols - 1);
    rgb += `${ESC}48;2;${Math.round(255 * (1 - t))};${Math.round(80 + 100 * t)};${Math.round(255 * t)}m ${reset}`;
  }
  lines.push(rgb);
  lines.push(`RGB fg: ${ESC}38;2;255;140;0m주황 #ff8c00${reset} ${ESC}38;2;0;200;120m초록 #00c878${reset} ${ESC}38;5;201m256색 201${reset}`);

  // 글자 속성
  lines.push(`속성: ${ESC}1mbold 굵게${reset} ${ESC}3mitalic 기울임${reset} ${ESC}4munderline 밑줄${reset} ${ESC}7minverse 반전${reset} ${ESC}2mdim${reset} ${ESC}9mstrike${reset} ${ESC}4:3;58;2;255;0;0mcurly${reset}`);
  lines.push(`조합: ${ESC}1;3;4;31mbold+italic+underline 빨강${reset} ${ESC}7;32m inverse 초록 ${reset} ${ESC}1;34m굵은 파랑(밝게)${reset}`);

  // 넓은 글자 이모지와 결합 문자
  lines.push('이모지: 😀 🎉 👍 |경계| 한😀글  결합: é ä ñ');
  lines.push(`박스: ┌──┬──┐ ▁▂▃▄▅▆▇█ ${ESC}36m❯${reset} 커서 →`);
  return lines.join('\r\n');
}

async function main(): Promise<void> {
  await init();
  const term = new Terminal({ cols: 80, rows: 16, scrollback: 0 });
  term.write(demoText(term.cols));
  // 커서를 마지막 줄 "커서 →" 뒤 한 칸에 둔다
  term.write(' ');

  const container = document.getElementById('terminal')!;
  const renderer = new OxttyWebglRenderer(term, container);
  renderer.render();

  // 2차 write: takeDamage()의 바뀐 줄만 다시 그리는 경로를 확인한다(이전 커서 줄도 지워져야 한다)
  term.write(`${ESC}16;1H${ESC}32m2차 write:${reset} damage 줄만 갱신, 막대 커서 → ${ESC}6 q`);
  renderer.render();

  const c = term.cursor();
  (window as unknown as { __oxtty: unknown }).__oxtty = { ready: true, cursor: c, rows: Array.from({ length: term.rows }, (_, y) => term.rowText(y)) };
}

main().catch(err => {
  console.error(err);
  (window as unknown as { __oxtty: unknown }).__oxtty = { ready: true, error: String(err) };
});
