use tiny_skia::{FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform};

use super::{Region, ShapeDraft, Tool, ToolSettings, place_raster};
use crate::engine::{EngineResult, State, validate_size};

const OVAL_CONTROL: f32 = 0.552_284_8;
const TILE_SIZE: u32 = 512;

pub(super) fn apply(
    draft: &ShapeDraft,
    settings: &ToolSettings,
    state: &mut State,
) -> EngineResult<()> {
    let Some(first) = draft.points.first() else {
        return Ok(());
    };
    let Some(last) = draft.points.last() else {
        return Ok(());
    };
    let (ax, ay) = (first.x as f32, first.y as f32);
    let (bx, by) = (last.x as f32, last.y as f32);
    let (left, top, right, bottom) = (ax.min(bx), ay.min(by), ax.max(bx), ay.max(by));
    let width = right - left;
    let height = bottom - top;
    let mut path = PathBuilder::new();
    match draft.tool {
        Tool::Line => {
            path.move_to(ax, ay);
            path.line_to(bx, by);
        }
        Tool::Curve => {
            let first_control = draft.controls.first().unwrap_or(first);
            let second_control = draft.controls.get(1).unwrap_or(last);
            path.move_to(ax, ay);
            path.cubic_to(
                first_control.x as f32,
                first_control.y as f32,
                second_control.x as f32,
                second_control.y as f32,
                bx,
                by,
            );
        }
        Tool::Polygon => {
            if draft.points.len() < 2 {
                return Ok(());
            }
            path.move_to(ax, ay);
            for point in &draft.points[1..] {
                path.line_to(point.x as f32, point.y as f32);
            }
            if draft.points.len() >= 3 {
                path.close();
            }
        }
        Tool::Ellipse => {
            let radius_x = (width / 2.0).max(0.01);
            let radius_y = (height / 2.0).max(0.01);
            let (cx, cy) = (left + width / 2.0, top + height / 2.0);
            let (dx, dy) = (radius_x * OVAL_CONTROL, radius_y * OVAL_CONTROL);
            path.move_to(cx + radius_x, cy);
            path.cubic_to(
                cx + radius_x,
                cy + dy,
                cx + dx,
                cy + radius_y,
                cx,
                cy + radius_y,
            );
            path.cubic_to(
                cx - dx,
                cy + radius_y,
                cx - radius_x,
                cy + dy,
                cx - radius_x,
                cy,
            );
            path.cubic_to(
                cx - radius_x,
                cy - dy,
                cx - dx,
                cy - radius_y,
                cx,
                cy - radius_y,
            );
            path.cubic_to(
                cx + dx,
                cy - radius_y,
                cx + radius_x,
                cy - dy,
                cx + radius_x,
                cy,
            );
            path.close();
        }
        Tool::RoundRect if width > 0.0 && height > 0.0 => {
            let radius_x = (width / 2.0).min(12.0);
            let radius_y = (height / 2.0).min(12.0);
            let dx = radius_x * (1.0 - OVAL_CONTROL);
            let dy = radius_y * (1.0 - OVAL_CONTROL);
            path.move_to(left + radius_x, top);
            path.line_to(right - radius_x, top);
            path.cubic_to(right - dx, top, right, top + dy, right, top + radius_y);
            path.line_to(right, bottom - radius_y);
            path.cubic_to(
                right,
                bottom - dy,
                right - dx,
                bottom,
                right - radius_x,
                bottom,
            );
            path.line_to(left + radius_x, bottom);
            path.cubic_to(
                left + dx,
                bottom,
                left,
                bottom - dy,
                left,
                bottom - radius_y,
            );
            path.line_to(left, top + radius_y);
            path.cubic_to(left, top + dy, left + dx, top, left + radius_x, top);
            path.close();
        }
        Tool::Rectangle | Tool::RoundRect => {
            path.move_to(left, top);
            path.line_to(right, top);
            path.line_to(right, bottom);
            path.line_to(left, bottom);
            path.close();
        }
        _ => return Ok(()),
    }
    let Some(path) = path.finish() else {
        return Ok(());
    };
    let line = matches!(draft.tool, Tool::Line | Tool::Curve);
    let fill =
        settings.fill_shape && !line && (draft.tool != Tool::Polygon || draft.points.len() >= 3);
    let outline = settings.outline_shape || line;
    if !fill && !outline {
        return Ok(());
    }
    let bounds = path.bounds();
    let brush_width = settings.size.clamp(1.0, 100.0);
    let pad = brush_width + 2.0;
    let Some(region) = Region::clipped(
        f64::from(bounds.left()) - pad,
        f64::from(bounds.top()) - pad,
        f64::from(bounds.right()) + pad,
        f64::from(bounds.bottom()) + pad,
        state,
    ) else {
        return Ok(());
    };
    validate_size(region.width, region.height, 1)?;
    let (outline_color, interior_color) = if draft.secondary {
        (settings.secondary, settings.foreground)
    } else {
        (settings.foreground, settings.secondary)
    };
    let mut interior = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    interior.set_color_rgba8(
        interior_color[0],
        interior_color[1],
        interior_color[2],
        interior_color[3],
    );
    let mut line_paint = Paint {
        anti_alias: true,
        ..Paint::default()
    };
    line_paint.set_color_rgba8(
        outline_color[0],
        outline_color[1],
        outline_color[2],
        outline_color[3],
    );
    let stroke = Stroke {
        width: brush_width as f32,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Stroke::default()
    };
    let capacity = TILE_SIZE as usize * TILE_SIZE as usize * 4;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(capacity)
        .map_err(|_| "도형을 만들 메모리가 부족합니다.")?;
    for y in (0..region.height).step_by(TILE_SIZE as usize) {
        for x in (0..region.width).step_by(TILE_SIZE as usize) {
            let tile = Region {
                x: region.x + x as i32,
                y: region.y + y as i32,
                width: TILE_SIZE.min(region.width - x),
                height: TILE_SIZE.min(region.height - y),
            };
            let mut pixmap =
                Pixmap::new(tile.width, tile.height).ok_or("도형 타일을 만들 수 없습니다.")?;
            let transform = Transform::from_translate(-tile.x as f32, -tile.y as f32);
            if fill {
                pixmap.fill_path(&path, &interior, FillRule::Winding, transform, None);
            }
            if outline {
                pixmap.stroke_path(&path, &line_paint, &stroke, transform, None);
            }
            if !pixmap.pixels().iter().any(|pixel| pixel.alpha() != 0) {
                continue;
            }
            pixels.clear();
            for pixel in pixmap.pixels() {
                let color = pixel.demultiply();
                pixels.extend_from_slice(&[
                    color.red(),
                    color.green(),
                    color.blue(),
                    color.alpha(),
                ]);
            }
            place_raster(state, tile, &pixels)?;
        }
    }
    Ok(())
}
