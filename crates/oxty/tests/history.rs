//! 압축 히스토리 차분 테스트: 같은 입력·resize·뷰 스크롤을 압축한 엔진과 압축하지 않은 엔진
//! (Alacritty 원래 배치)에 주고 화면·히스토리·damage·스냅샷이 모두 같은지 본다.
use oxty::{Cell, CellExtra, Engine};

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
    let trace = std::env::var_os("OXTY_TRACE").is_some();
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
    let seed: u64 = std::env::var("OXTY_SEED").unwrap().parse().unwrap();
    let scrollback: usize = std::env::var("OXTY_SB").unwrap().parse().unwrap();
    let steps: usize = std::env::var("OXTY_STEPS").unwrap().parse().unwrap();
    run(seed, steps, scrollback);
}

#[test]
fn compressed_history_matches_uncompressed() {
    // OXTY_SEEDS로 더 많이 돌릴 수 있다.
    let seeds: u64 = std::env::var("OXTY_SEEDS")
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
