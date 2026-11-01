use oxtty::{Cell, Damage, Engine, SnapshotRefusal};

fn snapshot(t: &mut Engine) -> Vec<u8> {
    t.ansi_snapshot().expect("snapshot")
}

fn find(payload: &[u8], needle: &[u8]) -> usize {
    payload
        .windows(needle.len())
        .position(|w| w == needle)
        .unwrap_or_else(|| panic!("{needle:?} not in payload"))
}

/// Whether cells, cursor, modes and history match after feeding the snapshot to a new engine of the same size.
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
fn refuses_wide_glyph_missing_a_half_mid_row() {
    // Cut by a shrink, then widened: the left half is followed by a plain blank (fuzz seed 7660).
    let mut t = Engine::new(4, 1, 0);
    t.feed("🚀𘀄".as_bytes());
    t.resize(3, 1);
    t.resize(4, 1);
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::WideEdge));
    // ICH at a right half moves it away from its blanked left half.
    let mut t = Engine::new(6, 2, 0);
    t.feed("a가b\x1b[1;3H\x1b[@".as_bytes());
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::WideEdge));
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
    assert!(payload.ends_with(b"\x1b[31;"));
    t.feed(b"4mX");
    assert!(snapshot(&mut t).ends_with(b"\x1b[?25h"));
}

#[test]
fn keeps_split_utf8_raw() {
    let mut t = Engine::new(10, 4, 0);
    t.feed(b"ready\xf0");
    t.feed(b"\x9f");
    assert!(snapshot(&mut t).ends_with(b"\x1b[?25h\xf0\x9f"));
    let mut copy = assert_round_trip(&mut t, 0);
    t.feed(b"\x98\x80");
    copy.feed(b"\x98\x80");
    assert_eq!(copy.row_text(0).unwrap(), "ready😀");
    assert_same_screen(&t, &copy);
}

#[test]
fn held_sync_is_carried_raw_and_repeatable() {
    let mut t = Engine::new(20, 4, 0);
    t.feed(b"\x1b[?2026hhello");
    let first = snapshot(&mut t);
    assert!(t.sync_pending());
    assert_eq!(snapshot(&mut t), first);
    assert!(first.ends_with(b"\x1b[?2026hhello"));
    t.feed(b" world\x1b[?2026l");
    assert!(!t.sync_pending());
    assert_eq!(t.row_text(0).unwrap(), "hello world");
}

#[test]
fn held_sync_is_judged_on_the_screen_before_it() {
    let mut t = Engine::new(10, 4, 0);
    // Even if the update clears the margins, it has not been applied yet, so reject.
    t.feed(b"\x1b[2;3r\x1b[?2026h\x1b[r");
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::Margins));
    assert!(t.sync_pending());
    // Conversely, margins and long incomplete sequences inside the update are carried over as raw bytes, so they are not grounds for rejection.
    t.feed(b"\x1b[?2026l\x1b[?2026h\x1b[2;3rX\x1b]0;");
    t.feed(&[b'a'; 5000]);
    t.feed(b"\x07\x1b[3");
    let first = snapshot(&mut t);
    assert_eq!(snapshot(&mut t), first);
    assert!(first.ends_with(b"\x07\x1b[3"));
    let mut copy = Engine::new(10, 4, 0);
    copy.feed(&first);
    for e in [&mut t, &mut copy] {
        e.feed(b"1mY\x1b[?2026l");
    }
    let mut cells = Vec::new();
    t.row_cells(0, &mut cells);
    assert_eq!((cells[1].ch, cells[1].fg), ('Y', oxtty::color::NAMED | 1));
    assert_same_screen(&t, &copy);
}

#[test]
fn snapshot_between_split_esu_lets_the_update_end() {
    let mut t = Engine::new(20, 4, 0);
    t.feed(b"\x1b[?2026hframe\x1b[?2026");
    snapshot(&mut t);
    t.feed(b"l");
    assert_eq!(
        (t.sync_pending(), t.row_text(0).unwrap()),
        (false, "frame".into())
    );
}

#[test]
fn snapshot_leaves_the_live_engine_untouched() {
    let mut t = Engine::new(20, 4, 0);
    t.feed(b"before\x1b[?2026h\x1b[2Hframe");
    t.take_damage();
    let first = snapshot(&mut t);
    // vt always reports the cursor line (0) as damaged.
    let none = Damage::Lines {
        scroll: 0,
        lines: vec![0],
    };
    assert_eq!(
        (t.take_damage(), t.row_text(1).unwrap(), t.sync_pending()),
        (none, "".into(), true)
    );
    assert_eq!(snapshot(&mut t), first);
}

#[test]
fn snapshot_during_sync_replays_into_the_same_update() {
    let mut t = Engine::new(20, 4, 0);
    t.feed(b"before\r\n\x1b[?2026hframe\x1b[31");
    let mut copy = Engine::new(20, 4, 0);
    copy.feed(&snapshot(&mut t));
    assert_eq!(
        (
            copy.sync_pending(),
            copy.row_text(0).unwrap(),
            copy.row_text(1).unwrap()
        ),
        (true, "before".into(), "".into())
    );
    for e in [&mut t, &mut copy] {
        e.feed(b"mX\x1b[?2026l");
    }
    assert!(!copy.sync_pending());
    assert_same_screen(&t, &copy);
}

fn rows(e: &Engine) -> Vec<String> {
    (0..e.rows() as i32)
        .map(|l| e.row_text(l).unwrap())
        .collect()
}

/// Taking a snapshot at every split point across sync boundaries leaves the engine unchanged, and the receiver is inside the same update.
#[test]
fn snapshot_at_every_split_of_synchronized_output() {
    // BSU right after ESU (fed at once, vte keeps everything from the new BSU in its buffer), a wide character and an incomplete CSI inside sync.
    let input =
        "pre\r\n\x1b[?2026hA\x1b[31mB\x1b[?2026l\x1b[?2026hC한\x1b[4\x1b[?2026lD\x1b[?2026hE"
            .as_bytes();
    for at in 0..=input.len() {
        for bytewise in [false, true] {
            let mut t = Engine::new(20, 4, 0);
            if bytewise {
                input[..at].iter().for_each(|b| t.feed(&[*b]));
            } else {
                t.feed(&input[..at]);
            }
            let mut untouched = Engine::new(20, 4, 0);
            untouched.feed(&input[..at]);
            let mut copy = Engine::new(20, 4, 0);
            copy.feed(&snapshot(&mut t));
            let at = (at, bytewise);
            assert_eq!(
                (rows(&t), t.sync_pending()),
                (rows(&untouched), untouched.sync_pending()),
                "{at:?}"
            );
            assert_eq!(
                (rows(&copy), copy.sync_pending()),
                (rows(&t), t.sync_pending()),
                "{at:?}"
            );
            assert_same_screen(&t, &copy);
            for e in [&mut t, &mut copy, &mut untouched] {
                e.feed(&input[at.0..]);
                e.flush_sync();
            }
            assert_eq!(rows(&t), rows(&untouched), "{at:?}");
            assert_same_screen(&t, &untouched);
            assert_same_screen(&t, &copy);
        }
    }
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
fn round_trip_in_oxtty() {
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

#[test]
fn tab_cell_is_written_as_space() {
    let mut t = Engine::new(20, 4, 0);
    t.feed(b"a\tb");
    let payload = snapshot(&mut t);
    assert!(!payload.contains(&b'\t'));
    // The engine stores '\t' in tab cells (a known difference), so check character positions and the cursor instead of cells.
    let mut copy = Engine::new(20, 4, 0);
    copy.feed(&payload);
    assert_eq!(copy.row_text(0).unwrap(), "a       b");
    assert_eq!(copy.cursor(), t.cursor());
}

#[test]
fn origin_mode_comes_before_cursor() {
    let mut t = Engine::new(20, 6, 0);
    t.feed(b"\x1b[?6h\x1b[3;5HX");
    assert_round_trip(&mut t, 0);
}

#[test]
fn control_inside_unfinished_sequence_is_not_replayed() {
    let mut t = Engine::new(20, 4, 0);
    t.feed(b"ab\x1b[31\n");
    let mut copy = assert_round_trip(&mut t, 0);
    t.feed(b"mX");
    copy.feed(b"mX");
    assert_same_screen(&t, &copy);
}

#[test]
fn leftover_alt_screen_does_not_refuse_after_exit() {
    // Even if a cut wide character remains on the alternate screen, only the primary screen is serialized after leaving, so it must not be rejected.
    let mut t = Engine::new(4, 3, 10);
    t.feed("\x1b[?1049hab한".as_bytes());
    t.resize(3, 3);
    assert_eq!(t.ansi_snapshot(), Err(SnapshotRefusal::WideEdge));
    t.feed(b"\x1b[?1049lok");
    assert_round_trip(&mut t, 10);
}
