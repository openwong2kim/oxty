use oxty::{Cell, Engine, SnapshotRefusal};

fn snapshot(t: &mut Engine) -> Vec<u8> {
    t.ansi_snapshot().expect("snapshot")
}

fn ends_with(payload: &[u8], tail: &[u8]) -> bool {
    payload.ends_with(tail)
}

fn find(payload: &[u8], needle: &[u8]) -> usize {
    payload
        .windows(needle.len())
        .position(|w| w == needle)
        .unwrap_or_else(|| panic!("{needle:?} not in payload"))
}

/// 스냅샷을 같은 크기의 새 엔진에 넣었을 때 셀·커서·모드·히스토리가 같은지.
fn assert_round_trip(t: &mut Engine, scrollback: usize) -> Engine {
    let payload = snapshot(t);
    let mut copy = Engine::new(t.cols(), t.rows(), scrollback);
    copy.feed(&payload);
    assert_same_screen(t, &copy);
    copy
}

fn assert_same_screen(a: &Engine, b: &Engine) {
    assert_eq!(a.history_len(), b.history_len(), "history");
    assert_eq!(a.cursor(), b.cursor(), "cursor");
    assert_eq!(a.modes(), b.modes(), "modes");
    let (mut x, mut y): (Vec<Cell>, Vec<Cell>) = (Vec::new(), Vec::new());
    for line in -(a.history_len() as i32)..a.rows() as i32 {
        a.row_cells(line, &mut x);
        b.row_cells(line, &mut y);
        assert_eq!(x, y, "row {line}");
        assert_eq!(a.row_wrapped(line), b.row_wrapped(line), "wrap {line}");
    }
}

#[test]
fn refuses_wide_glyph_clipped_to_last_column() {
    let mut t = Engine::new(4, 2, 0);
    t.feed("a한".as_bytes());
    t.resize(2, 2);
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::WideEdge));
    assert_eq!(SnapshotRefusal::WideEdge.as_str(), "unsupported-wide-edge");
}

#[test]
fn refuses_narrow_margins_but_not_full_screen_ones() {
    let mut t = Engine::new(10, 6, 0);
    t.feed(b"\x1b[2;4rhello");
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::Margins));
    assert_eq!(SnapshotRefusal::Margins.as_str(), "margins");
    t.feed(b"\x1b[1;6r");
    assert!(t.ansi_snapshot().is_ok());
}

#[test]
fn refuses_overlong_unfinished_sequence_until_it_ends() {
    let mut t = Engine::new(10, 4, 0);
    t.feed(b"\x1b]0;");
    t.feed("a".repeat(5000).as_bytes());
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::TailOverflow));
    assert_eq!(
        SnapshotRefusal::TailOverflow.as_str(),
        "partial-tail-overflow"
    );
    t.feed(b"\x07");
    assert!(t.ansi_snapshot().is_ok());
}

#[test]
fn keeps_unfinished_escape_raw_across_feeds() {
    let mut t = Engine::new(10, 4, 0);
    t.feed(b"hello\x1b[3");
    t.feed(b"1;");
    let payload = snapshot(&mut t);
    assert!(ends_with(&payload, b"\x1b[31;"));
    t.feed(b"4mX");
    assert!(ends_with(&snapshot(&mut t), b"\x1b[?25h"));
}

#[test]
fn keeps_split_utf8_raw() {
    let mut t = Engine::new(10, 4, 0);
    t.feed(b"ready\xf0");
    t.feed(b"\x9f");
    assert!(ends_with(&snapshot(&mut t), b"\x1b[?25h\xf0\x9f"));
    let mut copy = assert_round_trip(&mut t, 0);
    t.feed(b"\x98\x80");
    copy.feed(b"\x98\x80");
    assert_eq!(copy.row_text(0).unwrap(), "ready😀");
    assert_same_screen(&t, &copy);
}

#[test]
fn held_sync_is_applied_reopened_and_repeatable() {
    let mut t = Engine::new(20, 4, 0);
    t.feed(b"\x1b[?2026hhello");
    let first = snapshot(&mut t);
    assert!(t.sync_pending());
    assert_eq!(snapshot(&mut t), first);
    assert!(find(&first, b"hello") < find(&first, b"\x1b[?2026h"));
    assert!(ends_with(&first, b"\x1b[?2026h"));
    t.feed(b" world\x1b[?2026l");
    assert!(!t.sync_pending());
    assert_eq!(t.row_text(0).unwrap(), "hello world");
}

#[test]
fn held_sync_survives_refusal_and_unfinished_tail() {
    let mut t = Engine::new(10, 4, 0);
    t.feed(b"\x1b[?2026h\x1b[2;3rX");
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::Margins));
    assert!(t.sync_pending());
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::Margins));
    assert!(t.sync_pending());
    t.feed(b"\x1b[r\x1b[3");
    let first = snapshot(&mut t);
    assert_eq!(snapshot(&mut t), first);
    assert!(ends_with(&first, b"\x1b[?2026h\x1b[3"));
    // 재진입이 파서의 미완 CSI를 깨지 않았다.
    t.feed(b"1mY\x1b[?2026l");
    let mut cells = Vec::new();
    t.row_cells(0, &mut cells);
    assert_eq!((cells[0].ch, cells[0].fg), ('Y', oxty::color::NAMED | 1));
}

#[test]
fn primary_screen_comes_before_alternate() {
    let mut t = Engine::new(10, 4, 0);
    t.feed(b"normal\x1b[?1049halt");
    let payload = snapshot(&mut t);
    let normal = find(&payload, b"normal");
    let swap = find(&payload, b"\x1b[?1049h");
    assert!(normal < swap && swap < find(&payload, b"alt"));
    let mut copy = assert_round_trip(&mut t, 0);
    t.feed(b"\x1b[?1049l");
    copy.feed(b"\x1b[?1049l");
    assert_same_screen(&t, &copy);
}

#[test]
fn round_trip_in_oxty() {
    let inputs: [&[u8]; 4] = [
        "\x1b[31mred\x1b[0m 한글 e\u{301}\r\n\x1b[1;3;4:3;7;58;5;196mX\x1b[0m\r\nabcdefghijklmn\r\n1\r\n2\r\n3"
            .as_bytes(),
        b"\x1b[44m\x1b[2J\x1b[2;3H\x1b[38;2;1;2;3mrgb\x1b[?1h\x1b=\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[4h",
        b"abcdefghij",
        b"\x1b[?25l\x1b[?7lzz\x1b[?1004h",
    ];
    for input in inputs {
        let mut t = Engine::new(10, 4, 50);
        t.feed(input);
        assert_round_trip(&mut t, 50);
    }
}
