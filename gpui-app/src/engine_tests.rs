use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Cases<T> {
    cases: Vec<T>,
}

#[derive(Deserialize)]
struct SquareThin {
    name: String,
    from: [f64; 2],
    to: [f64; 2],
    spans: Vec<[usize; 3]>,
}

#[derive(Deserialize)]
struct SquareWide {
    name: String,
    width: u32,
    height: u32,
    size: f64,
    from: [f64; 2],
    to: [f64; 2],
    expected: Vec<SquareAlpha>,
}

#[derive(Deserialize)]
struct SquareAlpha {
    alpha: u8,
    spans: Vec<[usize; 3]>,
}

fn square_gesture(
    (width, height): (u32, u32),
    fill: Color,
    color: Color,
    size: f64,
    from: [f64; 2],
    to: [f64; 2],
    spans: &[[usize; 3]],
) {
    let mut doc = PaintDocument::new(State::new(width, height, fill).unwrap()).unwrap();
    let original = doc.state().clone();
    let mut expected = original.clone();
    for &[row, left, right] in spans {
        let offset = (row * width as usize + left) * 4;
        fill_pixels(
            &mut expected.try_pixels_mut(0).unwrap()[offset..offset + (right - left) * 4],
            color,
        );
        if color == [0; 4] {
            expected.try_pixels_mut(0).unwrap()[offset..offset + (right - left) * 4].fill(0);
        }
    }
    let options = BrushSettings {
        color,
        size,
        opacity: 0.,
        hardness: 0.,
        stabilization: 75.,
        pressure: true,
        square: true,
        eraser: true,
        ..BrushSettings::default()
    };
    doc.begin_stroke(from[0], from[1], options, 0.01).unwrap();
    doc.move_stroke(to[0], to[1], 0.01, false).unwrap();
    let changed = doc.end_stroke(to[0], to[1]).unwrap();
    assert_eq!(doc.state(), &expected);
    assert_eq!(doc.can_undo(), changed);
    if changed {
        assert!(doc.undo());
        assert_eq!(doc.state(), &original);
        assert!(doc.redo());
        assert_eq!(doc.state(), &expected);
    }
}

#[test]
fn legacy_one_pixel_square_strokes_match_independent_clip_fixtures() {
    let cases: Cases<SquareThin> = serde_json::from_str(include_str!(
        "../../web-app/tests/fixtures/square-thin-qt.json"
    ))
    .unwrap();
    assert_eq!(cases.cases.len(), 4543);
    for case in cases.cases {
        let run = std::panic::catch_unwind(|| {
            square_gesture(
                (24, 24),
                [255, 0, 0, 255],
                [0, 0, 255, 255],
                1.,
                case.from,
                case.to,
                &case.spans,
            )
        });
        assert!(run.is_ok(), "{}", case.name);
    }
}

#[test]
fn legacy_wide_square_eraser_writes_exact_straight_channels() {
    let cases: Cases<SquareWide> = serde_json::from_str(include_str!(
        "../../web-app/tests/fixtures/square-wide-qt.json"
    ))
    .unwrap();
    assert_eq!(cases.cases.len(), 231);
    for case in cases.cases {
        for alpha in case.expected {
            let run = std::panic::catch_unwind(|| {
                square_gesture(
                    (case.width, case.height),
                    [210, 80, 30, 255],
                    [17, 91, 203, alpha.alpha],
                    case.size,
                    case.from,
                    case.to,
                    &alpha.spans,
                )
            });
            assert!(run.is_ok(), "{} / alpha {}", case.name, alpha.alpha);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaskCase {
    name: String,
    #[serde(default)]
    left: i32,
    #[serde(default)]
    top: i32,
    width: u32,
    height: u32,
    raw_points: Vec<(f64, f64)>,
    mask_rows: Vec<String>,
}

#[test]
fn free_select_matches_883_recorded_fixed_point_masks() {
    let sources = [
        (
            871,
            include_str!("../../web-app/tests/fixtures/polygon-mask-qt.json"),
        ),
        (
            12,
            include_str!("../../web-app/tests/fixtures/polygon-mask-dense-qt.json"),
        ),
    ];
    for (count, fixture) in sources {
        let cases: Cases<MaskCase> = serde_json::from_str(fixture).unwrap();
        assert_eq!(cases.cases.len(), count);
        for case in cases.cases {
            let expected: Vec<_> = case
                .mask_rows
                .iter()
                .flat_map(|row| row.bytes().map(|mark| if mark == b'#' { 255 } else { 0 }))
                .collect();
            let result = polygon_mask(
                &case.raw_points,
                case.left,
                case.top,
                case.width,
                case.height,
            )
            .unwrap();
            assert_eq!(result, expected, "{}", case.name);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AxisMaps {
    maps_by_source: Vec<Vec<String>>,
}

#[test]
fn nearest_scale_matches_legacy_pixel_boundaries_and_keeps_hidden_channels() {
    let fixtures: AxisMaps =
        serde_json::from_str(include_str!("../../web-app/tests/fixtures/nearest-qt.json")).unwrap();
    assert_eq!(fixtures.maps_by_source.len(), 32);
    for (source_index, maps) in fixtures.maps_by_source.into_iter().enumerate() {
        assert_eq!(maps.len(), 32);
        let count = source_index + 1;
        for vertical in [false, true] {
            let (w, h) = if vertical { (1, count) } else { (count, 1) };
            let mut state = State::new(w as u32, h as u32, [0; 4]).unwrap();
            state.layers[0].visible = false;
            for (index, pixel) in state
                .try_pixels_mut(0)
                .unwrap()
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .enumerate()
            {
                pixel.copy_from_slice(&[
                    (index * 7) as u8,
                    (index * 5 + 9) as u8,
                    (index * 3 + 11) as u8,
                    [0, 1, 128, 255][index % 4],
                ]);
            }
            for (target_index, map) in maps.iter().enumerate() {
                let target = (target_index + 1) as u32;
                let (w, h) = if vertical { (1, target) } else { (target, 1) };
                let actual = resize_state(&state, w, h, true, false).unwrap();
                assert!(!actual.layers[0].visible);
                assert_eq!(actual.layers[0].pixels.len(), target as usize * 4);
                for (index, origin) in map
                    .split(',')
                    .map(|value| value.parse::<usize>().unwrap())
                    .enumerate()
                {
                    assert_eq!(
                        &actual.layers[0].pixels[index * 4..index * 4 + 4],
                        &state.layers[0].pixels[origin * 4..origin * 4 + 4],
                        "{count} to {target}, vertical {vertical}"
                    );
                }
            }
        }
    }
}

#[test]
fn canceled_and_stale_candidates_preserve_pixels_and_redo() {
    let original = State::new(16, 16, [82, 92, 102, 0]).unwrap();
    let mut doc = PaintDocument::new(original.clone()).unwrap();
    let patch = PixelPatch {
        left: 4,
        top: 4,
        width: 1,
        height: 1,
        pixels: vec![80, 40, 180, 255],
    };
    assert!(doc.replace_pixels("seed", 0, &patch, false).unwrap());
    let saved = doc.revision();
    doc.mark_saved(saved);
    assert!(doc.undo());
    assert!(doc.can_redo());
    assert_eq!(doc.state(), &original);
    let mut candidate = original.clone();
    candidate.layers[0].name = "candidate".into();
    let prepared = doc.prepare_state("rename", candidate).unwrap().unwrap();
    doc.begin_stroke(1.5, 1.5, BrushSettings::default(), 1.)
        .unwrap();
    assert!(doc.cancel_stroke());
    assert!(doc.apply_prepared(prepared).is_err());
    assert_eq!(doc.state(), &original);
    assert!(doc.redo());
    assert!(!doc.dirty());
    assert_eq!(doc.revision(), saved);
    assert_eq!(
        &doc.state().layers[0].pixels[(4 * 16 + 4) * 4..(4 * 16 + 5) * 4],
        patch.pixels
    );
}

#[test]
fn invalid_patch_and_stroke_outputs_are_atomic() {
    let original = State::new(16, 16, [0; 4]).unwrap();
    let mut doc = PaintDocument::new(original.clone()).unwrap();
    let patch = PixelPatch {
        left: -1,
        top: 0,
        width: 2,
        height: 1,
        pixels: vec![1, 2, 3],
    };
    assert!(doc.replace_pixels("invalid", 0, &patch, true).is_err());
    assert_eq!(doc.state(), &original);
    assert!(!doc.can_undo());
    doc.begin_stroke(10.5, 10.5, BrushSettings::default(), 1.)
        .unwrap();
    assert_ne!(doc.state(), &original);
    assert!(doc.move_stroke(f64::NAN, 12., 0.5, false).is_err());
    assert_eq!(doc.state(), &original);
    assert!(!doc.can_undo());
}

#[test]
fn partial_composite_and_dirty_extents_follow_actual_pixels() {
    let mut state = State::new(8, 8, [255, 0, 0, 128]).unwrap();
    state
        .layers
        .push(Layer::new("top".into(), true, [0, 0, 255, 128].repeat(64)));
    assert_eq!(
        state.composite_region(6, 5, 2, 2).unwrap(),
        [85, 0, 170, 192].repeat(4)
    );
    let whole = state.composite().unwrap();
    assert_eq!(
        &whole[(5 * 8 + 6) * 4..(5 * 8 + 8) * 4],
        &[85, 0, 170, 192].repeat(2)
    );
    let mut doc = PaintDocument::new(state).unwrap();
    assert_eq!(doc.take_visual_dirty(), None);
    let settings = BrushSettings {
        size: 1.,
        pixel: true,
        ..BrushSettings::default()
    };
    doc.begin_stroke(2., 3., settings, 1.).unwrap();
    doc.move_stroke(5., 3., 1., false).unwrap();
    assert_eq!(
        doc.take_visual_dirty(),
        Some(Region {
            left: 2,
            top: 3,
            width: 4,
            height: 1
        })
    );
    assert_eq!(doc.take_visual_dirty(), Some(Region::EMPTY));
    assert!(doc.end_stroke(5., 3.).unwrap());
    assert!(doc.undo());
    assert_eq!(doc.state().composite().unwrap(), whole);
}

#[test]
fn flood_uses_legacy_premultiplied_keys_and_keeps_unfilled_transparent_rgb() {
    let channels = [
        [23, 15, 62, 0],
        [45, 0, 23, 0],
        [2, 3, 4, 255],
        [2, 3, 4, 255],
        [7, 8, 9, 0],
        [2, 3, 4, 255],
        [2, 3, 4, 255],
        [2, 3, 4, 255],
        [80, 9, 8, 0],
    ]
    .concat();
    assert!(
        flood(&channels, 3, 3, 0., 0., [0, 0, 0, 0])
            .unwrap()
            .is_none()
    );
    let patch = flood(&channels, 3, 3, 0., 0., [1, 1, 1, 42])
        .unwrap()
        .unwrap();
    assert_eq!(
        (patch.left, patch.top, patch.width, patch.height),
        (0, 0, 2, 2)
    );
    assert_eq!(
        patch.pixels,
        [1, 1, 1, 42, 1, 1, 1, 42, 2, 3, 4, 255, 1, 1, 1, 42]
    );
    assert_eq!(&channels[32..36], [80, 9, 8, 0]);
}

#[test]
fn buffer_id_advances_on_in_place_mutation_without_cloning_unique_arc() {
    let mut state = State::new(8, 8, [0; 4]).unwrap();
    let cached_buffer_id = state.layers[0].buffer_id;
    let original_ptr = Arc::as_ptr(&state.layers[0].pixels);

    // Without Weak caches holding the pixel buffer, try_pixels_mut mutates in place.
    state.try_pixels_mut(0).unwrap()[..4].copy_from_slice(&[10, 20, 30, 255]);
    assert_eq!(Arc::as_ptr(&state.layers[0].pixels), original_ptr);
    assert_ne!(state.layers[0].buffer_id, cached_buffer_id);

    // A shared clone preserves buffer_id until mutation, when it clones on write and advances.
    let shared = state.clone();
    let shared_id = shared.layers[0].buffer_id;
    assert_eq!(state.layers[0].buffer_id, shared_id);
    assert!(Arc::ptr_eq(
        &state.layers[0].pixels,
        &shared.layers[0].pixels
    ));

    state.try_pixels_mut(0).unwrap()[4..8].copy_from_slice(&[40, 50, 60, 255]);
    assert!(!Arc::ptr_eq(
        &state.layers[0].pixels,
        &shared.layers[0].pixels
    ));
    assert_ne!(state.layers[0].buffer_id, shared_id);
    assert_eq!(shared.layers[0].buffer_id, shared_id);
}
