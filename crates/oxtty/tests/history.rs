//! 압축 히스토리 차분 테스트: 같은 입력·resize·뷰 스크롤을 압축한 엔진과 압축하지 않은 엔진
//! (Alacritty 원래 배치)에 주고 화면·히스토리·damage·스냅샷이 모두 같은지 본다.
use oxtty::vt::event::VoidListener;
use oxtty::vt::grid::{Dimensions, Row};
use oxtty::vt::index::{Column, Line};
use oxtty::vt::term::cell::{Cell as AlacCell, Flags};
use oxtty::vt::term::test::TermSize;
use oxtty::vt::term::{Config, Term, TermMode};
use oxtty::vt::vte::ansi::{Color, Processor, StdSyncHandler};
use oxtty::{Cell, CellExtra, Engine, TermHistory};

/// 재현 가능한 의사 난수(xorshift64*).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len() as u64) as usize]
    }
}

/// 히스토리를 빨리 쌓고, 넓은 글자·결합 문자·링크·밑줄 색·여백·대체 화면을 섞은 출력.
fn chunk(rng: &mut Rng) -> String {
    let mut s = String::new();
    for _ in 0..rng.below(40) + 1 {
        let token = match rng.below(30) {
            0..=7 => rng
                .pick(&[
                    "hello ", "build ", "한글 ", "😀", "e\u{301}", "ab", "\t", "x",
                ])
                .to_owned(),
            8..=11 => "\r\n".to_owned(),
            12 => "\n".to_owned(),
            13 => format!(
                "\x1b[{}m",
                rng.pick(&[
                    "0",
                    "1",
                    "31",
                    "42",
                    "38;5;208",
                    "48;2;1;2;3",
                    "4:3",
                    "58:2::9:8:7",
                    "7",
                    "5",
                    "2;3"
                ])
            ),
            14 => rng
                .pick(&[
                    "\x1b]8;;https://a.example\x07",
                    "\x1b]8;id=k;https://b.example\x07",
                    "\x1b]8;;\x07",
                ])
                .to_owned(),
            15 => format!("\x1b[{};{}H", rng.below(14) + 1, rng.below(40) + 1),
            16 => rng
                .pick(&[
                    "\x1b[K", "\x1b[1K", "\x1b[2K", "\x1b[J", "\x1b[2J", "\x1b[3J",
                ])
                .to_owned(),
            17 => format!("\x1b[{}S", rng.below(6) + 1),
            18 => format!("\x1b[{}T", rng.below(3) + 1),
            19 => rng
                .pick(&["\x1bM", "\x1bD", "\x1bE", "\x1b7", "\x1b8"])
                .to_owned(),
            20 => format!("\x1b[{};{}r", rng.below(3) + 1, rng.below(6) + 4),
            21 => "\x1b[r".to_owned(),
            22 => rng
                .pick(&["\x1b[?1049h", "\x1b[?1049l", "\x1b[?47h", "\x1b[?47l"])
                .to_owned(),
            23 => format!(
                "\x1b[{}{}",
                rng.below(4) + 1,
                rng.pick(&["@", "P", "L", "M", "X"])
            ),
            24 => rng
                .pick(&["\x1b[?7l", "\x1b[?7h", "\x1b[?25l", "\x1b[?25h"])
                .to_owned(),
            25 => "가".repeat(rng.below(30) as usize),
            26 => "y".repeat(rng.below(90) as usize),
            27 => "\x1b[?2026h".to_owned(),
            28 => "\x1b[?2026l".to_owned(),
            _ => {
                if rng.below(20) == 0 {
                    "\x1bc".to_owned()
                } else {
                    "z".to_owned()
                }
            }
        };
        s.push_str(&token);
    }
    s
}

fn assert_same(a: &Engine, b: &Engine, step: usize) {
    assert_eq!(a.history_len(), b.history_len(), "history_len, step {step}");
    assert_eq!(
        a.display_offset(),
        b.display_offset(),
        "display_offset, step {step}"
    );
    assert_eq!(a.cursor(), b.cursor(), "cursor, step {step}");
    assert_eq!(a.modes(), b.modes(), "modes, step {step}");
    assert_eq!(
        (a.cols(), a.rows()),
        (b.cols(), b.rows()),
        "size, step {step}"
    );
    let (mut x, mut y): (Vec<Cell>, Vec<Cell>) = (Vec::new(), Vec::new());
    let (mut ex, mut ey): (Vec<CellExtra>, Vec<CellExtra>) = (Vec::new(), Vec::new());
    for line in -(a.history_len() as i32) - 1..a.rows() as i32 + 1 {
        assert_eq!(
            a.row_cells(line, &mut x),
            b.row_cells(line, &mut y),
            "in range {line}, step {step}"
        );
        assert_eq!(x, y, "cells of line {line}, step {step}");
        assert_eq!(a.row_extras(line, &mut ex), b.row_extras(line, &mut ey));
        // 만들어 붙인 링크 id는 프로세스 전역 카운터라 엔진마다 다르다.
        for e in ex.iter_mut().chain(ey.iter_mut()) {
            if let Some(link) = &mut e.hyperlink {
                if link.id.ends_with("_alacritty") {
                    link.id.clear();
                }
            }
        }
        assert_eq!(ex, ey, "extras of line {line}, step {step}");
        assert_eq!(
            a.row_wrapped(line),
            b.row_wrapped(line),
            "wrapped {line}, step {step}"
        );
        assert_eq!(
            a.row_text(line),
            b.row_text(line),
            "text {line}, step {step}"
        );
    }
}

fn run(seed: u64, steps: usize, scrollback: usize) {
    let mut rng = Rng(seed);
    let (cols, rows) = (rng.below(70) as u16 + 10, rng.below(10) as u16 + 4);
    let mut packed = Engine::new(cols, rows, scrollback);
    let mut plain = Engine::new_uncompressed(cols, rows, scrollback);
    let trace = std::env::var_os("OXTTY_TRACE").is_some();
    for step in 0..steps {
        let op = rng.below(20);
        if trace {
            eprintln!(
                "step {step} op {op} offset {} hist {}",
                plain.display_offset(),
                plain.history_len()
            );
        }
        match op {
            0 => {
                let (c, r) = (rng.below(110) as u16 + 2, rng.below(16) as u16 + 1);
                if trace {
                    eprintln!("  resize {c}x{r}");
                }
                packed.resize(c, r);
                plain.resize(c, r);
            }
            1 | 2 => {
                let delta = rng.below(40) as i32 - 15;
                if trace {
                    eprintln!("  scroll {delta}");
                }
                packed.scroll_display(delta);
                plain.scroll_display(delta);
            }
            3 => {
                packed.scroll_to_bottom();
                plain.scroll_to_bottom();
            }
            4 => {
                packed.flush_sync();
                plain.flush_sync();
            }
            5 => assert_eq!(
                packed.ansi_snapshot(),
                plain.ansi_snapshot(),
                "snapshot, step {step}"
            ),
            _ => {
                let bytes = chunk(&mut rng).into_bytes();
                // 바이트 단위로 갈라도 같아야 한다.
                let cut = rng.below(bytes.len() as u64 + 1) as usize;
                if trace {
                    eprintln!("  feed {:?}", String::from_utf8_lossy(&bytes));
                }
                for part in [&bytes[..cut], &bytes[cut..]] {
                    packed.feed(part);
                    plain.feed(part);
                }
            }
        }
        if rng.below(3) == 0 {
            assert_eq!(
                packed.take_damage(),
                plain.take_damage(),
                "damage, step {step}"
            );
        }
        assert_same(&packed, &plain, step);
    }
    assert_eq!(
        packed.ansi_snapshot(),
        plain.ansi_snapshot(),
        "final snapshot"
    );
}

#[test]
#[ignore]
fn one_seed() {
    let seed: u64 = std::env::var("OXTTY_SEED").unwrap().parse().unwrap();
    let scrollback: usize = std::env::var("OXTTY_SB").unwrap().parse().unwrap();
    let steps: usize = std::env::var("OXTTY_STEPS").unwrap().parse().unwrap();
    run(seed, steps, scrollback);
}

#[test]
fn compressed_history_matches_uncompressed() {
    // OXTTY_SEEDS로 더 많이 돌릴 수 있다.
    let seeds: u64 = std::env::var("OXTTY_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    for seed in 1..=seeds {
        let (seed, scrollback) = (
            seed.wrapping_mul(0x9e37_79b9_7f4a_7c15),
            [20, 50, 200][seed as usize % 3],
        );
        println!("seed {seed} scrollback {scrollback}");
        run(seed, 400, scrollback);
    }
}

#[test]
fn compressed_history_keeps_long_scrollback() {
    // 블록 경계와 오래된 줄 버리기가 여러 번 일어나도록 길게 돌린다.
    run(7, 4000, 3000);
}

/// 칸 비교용 값. 링크는 URI만 본다(ID 없는 링크에 Alacritty가 프로세스 전역 번호를 붙인다).
type CellKey = (
    char,
    Color,
    Color,
    Flags,
    Vec<char>,
    Option<Color>,
    Option<String>,
);

/// 주 화면의 히스토리와 화면 줄 전체(오래된 줄부터)를 칸 단위로 꺼낸다.
fn primary_rows(term: &Term<VoidListener>, older: Option<&TermHistory>) -> Vec<Vec<CellKey>> {
    let grid = if term.mode().contains(TermMode::ALT_SCREEN) {
        term.inactive_grid()
    } else {
        term.grid()
    };
    let cells = |row: &Row<AlacCell>| {
        (0..grid.columns())
            .map(|x| {
                let c = &row[Column(x)];
                let link = c.hyperlink().map(|h| h.uri().to_owned());
                let zerowidth = c.zerowidth().unwrap_or_default().to_vec();
                (
                    c.c,
                    c.fg,
                    c.bg,
                    c.flags,
                    zerowidth,
                    c.underline_color(),
                    link,
                )
            })
            .collect()
    };
    let mut rows: Vec<_> = (0..older.map_or(0, TermHistory::len))
        .map(|i| cells(&older.unwrap().row(i)))
        .collect();
    for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
        rows.push(cells(&grid[Line(y)]));
    }
    rows
}

#[test]
fn term_history_matches_plain_term() {
    // Engine 없이 Term을 직접 쓰는 쪽(wmux 스냅샷)도 압축 히스토리로 같은 줄을 얻는다.
    // 기본 Config라 ED2가 화면을 히스토리로 미는 경로도 탄다.
    for seed in 1..=20u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let (cols, rows) = (rng.below(70) as usize + 10, rng.below(10) as usize + 4);
        let scrollback = [20, 200, 2000][seed as usize % 3];
        let config = |history| Config {
            scrolling_history: history,
            reflow_cursor_line: false,
            ..Config::default()
        };
        let size = |cols, rows| TermSize::new(cols, rows);
        let mut packed = Term::new(config(TermHistory::RECENT), &size(cols, rows), VoidListener);
        let history = TermHistory::attach(&mut packed, scrollback);
        let mut plain = Term::new(config(scrollback), &size(cols, rows), VoidListener);
        let (mut a, mut b) = (
            Processor::<StdSyncHandler>::new(),
            Processor::<StdSyncHandler>::new(),
        );
        for step in 0..600 {
            if rng.below(15) == 0 {
                let (c, r) = (rng.below(110) as usize + 2, rng.below(16) as usize + 1);
                history.resize(&mut packed, size(c, r));
                plain.resize(size(c, r));
            } else {
                let bytes = chunk(&mut rng).into_bytes();
                a.advance(&mut packed, &bytes);
                b.advance(&mut plain, &bytes);
            }
            assert_eq!(
                primary_rows(&packed, Some(&history)),
                primary_rows(&plain, None),
                "seed {seed} step {step}"
            );
        }
    }
}
