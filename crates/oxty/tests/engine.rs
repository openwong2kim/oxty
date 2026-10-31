use oxty::{Cell, CellExtra, CursorShape, Damage, Engine, Hyperlink, attr, color, mode};

fn term() -> Engine {
    Engine::new(80, 24, 1000)
}

#[test]
fn korean_and_ascii_share_a_row() {
    let mut t = term();
    t.feed("안녕 hello\r\n".as_bytes());
    assert_eq!(t.row_text(0).unwrap(), "안녕 hello");
    let mut cells = Vec::new();
    assert!(t.row_cells(0, &mut cells));
    assert_eq!(cells[0].ch, '안');
    assert_ne!(cells[0].attrs & attr::WIDE, 0);
    assert_ne!(cells[1].attrs & attr::WIDE_SPACER, 0);
    assert_eq!(cells[4].ch, ' ');
    assert_eq!((t.cursor().line, t.cursor().col), (1, 0));
}

#[test]
fn split_utf8_and_escape_across_feeds() {
    let mut t = term();
    let bytes = "한\x1b[31mX".as_bytes();
    for b in bytes {
        t.feed(std::slice::from_ref(b));
    }
    assert_eq!(t.row_text(0).unwrap(), "한X");
    let mut cells = Vec::new();
    t.row_cells(0, &mut cells);
    assert_eq!(cells[2].fg, color::NAMED | 1);
}

#[test]
fn sgr_colors_and_attributes() {
    let mut t = term();
    t.feed(b"\x1b[31mR\x1b[38;5;208mO\x1b[38;2;10;20;30mT\x1b[1;3;4;7mS\x1b[0mN");
    let mut c: Vec<Cell> = Vec::new();
    t.row_cells(0, &mut c);
    assert_eq!(c[0].fg, color::NAMED | 1);
    assert_eq!(c[1].fg, color::INDEXED | 208);
    assert_eq!(c[2].fg, color::RGB | 0x0a141e);
    assert_eq!(
        c[3].attrs & (attr::BOLD | attr::ITALIC | attr::UNDERLINE | attr::INVERSE),
        attr::BOLD | attr::ITALIC | attr::UNDERLINE | attr::INVERSE
    );
    assert_eq!(
        (c[4].fg, c[4].bg, c[4].attrs),
        (color::DEFAULT_FG, color::DEFAULT_BG, 0)
    );
}

#[test]
fn cursor_addressing_and_wrap() {
    let mut t = term();
    t.feed(b"\x1b[5;10HX");
    assert_eq!(t.row_text(4).unwrap(), "         X");
    assert_eq!((t.cursor().line, t.cursor().col), (4, 10));
    t.feed(b"\x1b[7;1H");
    t.feed("a".repeat(85).as_bytes());
    assert_eq!(t.row_text(6).unwrap().len(), 80);
    assert!(t.row_wrapped(6));
    assert_eq!(t.row_text(7).unwrap(), "aaaaa");
}

#[test]
fn alternate_screen_round_trip() {
    let mut t = term();
    t.feed(b"main");
    t.feed(b"\x1b[?1049h\x1b[H\x1b[2Jalt");
    assert_ne!(t.modes() & mode::ALT_SCREEN, 0);
    assert_eq!(t.row_text(0).unwrap(), "alt");
    t.feed(b"\x1b[?1049l");
    assert_eq!(t.modes() & mode::ALT_SCREEN, 0);
    assert_eq!(t.row_text(0).unwrap(), "main");
}

#[test]
fn scrollback_is_addressed_with_negative_lines() {
    let mut t = Engine::new(20, 5, 100);
    for i in 0..12 {
        t.feed(format!("line {i}\r\n").as_bytes());
    }
    assert_eq!(t.history_len(), 8);
    assert_eq!(t.row_text(-8).unwrap(), "line 0");
    assert_eq!(t.row_text(-1).unwrap(), "line 7");
    assert_eq!(t.row_text(0).unwrap(), "line 8");
    assert!(t.row_text(-9).is_none());
    assert!(t.row_text(5).is_none());
}

#[test]
fn scrollback_limit_is_respected() {
    let mut t = Engine::new(20, 5, 3);
    for i in 0..50 {
        t.feed(format!("{i}\r\n").as_bytes());
    }
    assert_eq!(t.history_len(), 3);
}

#[test]
fn damage_reports_only_changed_lines() {
    let mut t = term();
    assert_eq!(t.take_damage(), Damage::Full);
    t.feed(b"\x1b[3;1Hhello");
    match t.take_damage() {
        Damage::Lines { lines, .. } => assert!(lines.contains(&2) && lines.len() <= 2, "{lines:?}"),
        Damage::Full => panic!("expected partial damage"),
    }
    match t.take_damage() {
        Damage::Lines { lines, .. } => assert!(
            lines.iter().all(|&l| l == 2),
            "only the cursor line: {lines:?}"
        ),
        Damage::Full => panic!("expected partial damage"),
    }
    t.resize(100, 30);
    assert_eq!(t.take_damage(), Damage::Full);
}

#[test]
fn device_reports_are_returned_as_replies() {
    let mut t = term();
    t.feed(b"\x1b[3;7H\x1b[6n");
    assert_eq!(t.take_replies(), b"\x1b[3;7R");
    assert!(t.take_replies().is_empty());
    t.feed(b"\x1b[c");
    assert!(t.take_replies().starts_with(b"\x1b[?"));
}

#[test]
fn title_and_bell() {
    let mut t = term();
    t.feed(b"\x1b]0;my shell\x07\x07");
    assert_eq!(t.take_title().as_deref(), Some("my shell"));
    assert_eq!(t.take_title(), None);
    assert_eq!(t.take_bells(), 1);
}

#[test]
fn synchronized_output_waits_for_end_or_host_flush() {
    let mut t = term();
    t.feed(b"\x1b[?2026hSYNC");
    assert!(t.sync_pending());
    assert_eq!(t.row_text(0).unwrap(), "");
    t.feed(b"\x1b[?2026l");
    assert!(!t.sync_pending());
    assert_eq!(t.row_text(0).unwrap(), "SYNC");
    t.feed(b"\x1b[?2026hLATE");
    t.flush_sync();
    assert!(!t.sync_pending());
    assert_eq!(t.row_text(0).unwrap(), "SYNCLATE");
}

#[test]
fn reset_keeps_cursor_hidden_like_xterm() {
    let mut t = term();
    t.feed(b"\x1b[?25l\x1b[?2004hX\x1bc");
    assert!(!t.cursor().visible);
    assert_eq!(t.modes() & mode::BRACKETED_PASTE, 0);
    assert_eq!(t.row_text(0).unwrap(), "");
    t.feed(b"\x1b[?25h\x1bc");
    assert!(t.cursor().visible);
}

#[test]
fn combining_marks_are_kept() {
    let mut t = term();
    t.feed("e\u{301}x".as_bytes());
    assert_eq!(t.row_text(0).unwrap(), "e\u{301}x");
    let mut cells = Vec::new();
    t.row_cells(0, &mut cells);
    assert_ne!(cells[0].attrs & attr::COMBINING, 0);
    assert_eq!(t.cell_text(0, 0).unwrap(), "e\u{301}");
    assert!(t.cell_text(0, 80).is_none());
}

#[test]
fn modes_track_common_private_modes() {
    let mut t = term();
    assert_ne!(t.modes() & mode::SHOW_CURSOR, 0);
    t.feed(b"\x1b[?25l\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h");
    let m = t.modes();
    assert_eq!(m & mode::SHOW_CURSOR, 0);
    assert!(!t.cursor().visible);
    for bit in [
        mode::BRACKETED_PASTE,
        mode::APP_CURSOR,
        mode::MOUSE_CLICK,
        mode::SGR_MOUSE,
    ] {
        assert_ne!(m & bit, 0, "mode bit {bit:#x}");
    }
}

#[test]
fn resize_keeps_content_and_clamps() {
    let mut t = term();
    t.feed(b"keep me");
    t.resize(40, 10);
    assert_eq!((t.cols(), t.rows()), (40, 10));
    assert_eq!(t.row_text(0).unwrap(), "keep me");
    t.resize(0, 0);
    assert_eq!((t.cols(), t.rows()), (oxty::MIN_COLS, oxty::MIN_ROWS));
}

#[test]
fn resize_reflows_all_but_the_cursor_paragraph() {
    // xterm.js reflowCursorLine: false — 커서가 있는 문단만 줄을 다시 나누지 않는다.
    let mut t = Engine::new(10, 5, 100);
    t.feed(b"0123456789ab\r\nXXXXXXXXXXyy");
    t.resize(20, 5);
    let rows: Vec<String> = (0..3).map(|y| t.row_text(y).unwrap()).collect();
    assert_eq!(rows, ["0123456789ab", "XXXXXXXXXX", "yy"]);
}

#[test]
fn secondary_device_attributes_report_alacritty_version() {
    // 내장 후에도 DA2 응답은 oxty 버전이 아니라 Alacritty 0.26.0(2600)이다.
    let mut t = term();
    t.feed(b"\x1b[>c");
    assert_eq!(t.take_replies(), b"\x1b[>0;2600;1c");
}

#[test]
fn packed_rows_match_cells() {
    let mut t = term();
    t.feed("가\x1b[32mb".as_bytes());
    let (mut cells, mut packed) = (Vec::new(), Vec::new());
    t.row_cells(0, &mut cells);
    t.row_packed(0, &mut packed);
    assert_eq!(packed.len(), 80 * Cell::PACKED_WORDS);
    for (i, c) in cells.iter().enumerate() {
        assert_eq!(
            &packed[i * 4..i * 4 + 4],
            &[c.ch as u32, c.fg, c.bg, c.attrs]
        );
    }
}

#[test]
fn cursor_shape_follows_decscusr() {
    let mut t = term();
    assert_eq!(
        (t.cursor().shape, t.cursor().blinking),
        (CursorShape::Block, false)
    );
    t.feed(b"\x1b[5 q");
    assert_eq!(
        (t.cursor().shape, t.cursor().blinking),
        (CursorShape::Bar, true)
    );
    t.feed(b"\x1b[4 q");
    assert_eq!(
        (t.cursor().shape, t.cursor().blinking),
        (CursorShape::Underline, false)
    );
    t.feed(b"\x1b[0 q");
    assert_eq!(t.cursor().shape, CursorShape::Block);
}

#[test]
fn row_extras_carry_combining_underline_colour_and_links() {
    let mut t = term();
    t.feed("e\u{301}\x1b[4:3;58;2;255;0;0mX\x1b[0m".as_bytes());
    t.feed(b"\x1b]8;id=a;https://oxty.dev\x1b\\LN\x1b]8;;\x1b\\Z");
    let mut cells = Vec::new();
    t.row_cells(0, &mut cells);
    assert_ne!(cells[1].attrs & attr::UNDERLINE_COLOR, 0);
    assert_ne!(cells[2].attrs & attr::HYPERLINK, 0);
    assert_eq!(
        cells[4].attrs & (attr::HYPERLINK | attr::UNDERLINE_COLOR),
        0
    );

    let mut extras = Vec::new();
    assert!(t.row_extras(0, &mut extras));
    let link = Some(Hyperlink {
        id: "a".into(),
        uri: "https://oxty.dev".into(),
    });
    assert_eq!(
        extras,
        [
            CellExtra {
                col: 0,
                text: Some("e\u{301}".into()),
                underline_color: None,
                hyperlink: None
            },
            CellExtra {
                col: 1,
                text: None,
                underline_color: Some(color::RGB | 0xff0000),
                hyperlink: None
            },
            CellExtra {
                col: 2,
                text: None,
                underline_color: None,
                hyperlink: link.clone()
            },
            CellExtra {
                col: 3,
                text: None,
                underline_color: None,
                hyperlink: link
            },
        ]
    );
    assert!(!t.row_extras(24, &mut extras));
}

#[test]
fn view_scrolls_into_history_and_back() {
    let mut t = Engine::new(20, 3, 100);
    for i in 0..10 {
        t.feed(format!("line{i}\r\n").as_bytes());
    }
    t.take_damage();
    t.scroll_display(2);
    assert_eq!(t.display_offset(), 2);
    assert_eq!(t.take_damage(), Damage::Full);
    // 뷰포트 0번 줄 = line(0 - 2)
    assert_eq!(t.row_text(-2).unwrap(), "line6");
    t.scroll_display(1000);
    assert_eq!(t.display_offset(), t.history_len());
    t.scroll_to_bottom();
    assert_eq!(t.display_offset(), 0);
}

#[test]
fn scrolling_output_reports_scroll_and_new_lines() {
    let mut t = Engine::new(20, 5, 100);
    t.feed(b"a\r\nb\r\nc\r\nd\r\ne");
    t.take_damage();
    t.feed(b"\r\nf");
    // 화면이 한 줄 올라갔다: 옛 커서 줄(3으로 이동)과 새 줄 4만 다시 그린다.
    assert_eq!(
        t.take_damage(),
        Damage::Lines {
            scroll: 1,
            lines: vec![3, 4]
        }
    );
    t.feed(b"\r\ng\r\nh");
    assert_eq!(
        t.take_damage(),
        Damage::Lines {
            scroll: 2,
            lines: vec![2, 3, 4]
        }
    );
    // 화면 높이 이상 스크롤되면 전체를 다시 그린다.
    t.feed(b"\r\n1\r\n2\r\n3\r\n4\r\n5");
    assert_eq!(t.take_damage(), Damage::Full);
    // 스크롤 영역(vim 등)이 화면 일부면 전체로 처리한다.
    t.feed(b"\x1b[2;4r\x1b[4;1H\n");
    assert_eq!(t.take_damage(), Damage::Full);
}

#[test]
fn erase_display_keeps_history_like_xterm() {
    // xterm.js scrollOnEraseInDisplay: false — 주 화면 ED2는 화면만 지우고 히스토리로 밀지 않는다.
    let mut t = Engine::new(20, 6, 100);
    t.feed(b"a\r\nb\r\nc\x1b[2J");
    assert_eq!(t.history_len(), 0);
    assert!((0..6).all(|y| t.row_text(y).unwrap().is_empty()));
    assert_eq!((t.cursor().line, t.cursor().col), (2, 1));
}
