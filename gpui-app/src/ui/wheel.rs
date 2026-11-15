use std::{f64::consts::TAU, sync::Arc};

use gpui::{
    App, Bounds, Context, Corners, DispatchPhase, HitboxBehavior, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, Pixels, Point, RenderImage, WeakEntity, Window, canvas, div,
    point, prelude::*, px, size,
};
use image::{Frame, RgbaImage};

use crate::engine::Color;

use super::Studio;

const WHEEL_WIDTH: f64 = 220.;
const WHEEL_HEIGHT: f64 = 210.;
const CENTER_X: f64 = 110.;
const CENTER_Y: f64 = 105.;
const RING_RADIUS: f64 = 94.;
const SQUARE_X: f64 = 54.;
const SQUARE_Y: f64 = 49.;
const SQUARE_EDGE: f64 = 112.;
const MARKER_EDGE: f64 = 12.;

#[derive(Clone, Copy)]
enum Pick {
    Hue,
    SaturationValue,
}

pub(super) struct ColorWheel {
    hue: f64,
    pick: Option<Pick>,
    ring: Option<Arc<RenderImage>>,
    marker: Option<Arc<RenderImage>>,
    square: Option<(Color, Arc<RenderImage>)>,
}

impl Default for ColorWheel {
    fn default() -> Self {
        Self {
            hue: 0.58,
            pick: None,
            ring: None,
            marker: None,
            square: None,
        }
    }
}

impl ColorWheel {
    pub(super) fn view(
        &mut self,
        foreground: Color,
        height: Pixels,
        window: &mut Window,
        cx: &mut Context<Studio>,
    ) -> gpui::Stateful<gpui::Div> {
        let (hue, saturation, value) = hsv(foreground);
        self.hue = hue.unwrap_or(self.hue);
        let ring = self.ring.get_or_insert_with(ring_image).clone();
        let marker = self.marker.get_or_insert_with(marker_image).clone();
        let shade = color(self.hue, 1., 1.);
        if self.square.as_ref().is_none_or(|(key, _)| *key != shade) {
            let previous = self.square.replace((shade, square_image(shade)));
            if let Some((_, image)) = previous {
                let _ = window.drop_image(image);
            }
        }
        let square = self
            .square
            .as_ref()
            .expect("square image prepared")
            .1
            .clone();
        let angle = self.hue * TAU;
        let view = cx.weak_entity();
        div()
            .id("foreground-wheel")
            .role(gpui::Role::Image)
            .aria_label("색상환과 채도·명도 선택. HEX 입력으로도 색상을 선택할 수 있습니다.")
            .w_full()
            .h(height)
            .flex_none()
            .child(
                canvas(
                    |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                    move |bounds, hitbox, window, _| {
                        let _ =
                            window.paint_image(bounds, bounds, Corners::default(), ring, 0, false);
                        let square_bounds = Bounds::new(
                            position(bounds, SQUARE_X, SQUARE_Y),
                            size(
                                bounds.size.width * (SQUARE_EDGE / WHEEL_WIDTH) as f32,
                                bounds.size.height * (SQUARE_EDGE / WHEEL_HEIGHT) as f32,
                            ),
                        );
                        let _ = window.paint_image(
                            bounds,
                            square_bounds,
                            Corners::default(),
                            square,
                            0,
                            false,
                        );
                        paint_marker(
                            bounds,
                            SQUARE_X + saturation * SQUARE_EDGE,
                            SQUARE_Y + (1. - value) * SQUARE_EDGE,
                            marker.clone(),
                            window,
                        );
                        paint_marker(
                            bounds,
                            CENTER_X + angle.cos() * RING_RADIUS,
                            CENTER_Y + angle.sin() * RING_RADIUS,
                            marker,
                            window,
                        );

                        let down = view.clone();
                        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                            if phase == DispatchPhase::Bubble
                                && event.button == MouseButton::Left
                                && hitbox.is_hovered_at(event.position, window)
                            {
                                apply(&down, bounds, event.position, true, false, cx);
                            }
                        });
                        let movement = view.clone();
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                            if phase == DispatchPhase::Capture {
                                if event.dragging() {
                                    apply(&movement, bounds, event.position, false, false, cx);
                                } else if let Some(view) = movement.upgrade()
                                    && view.read(cx).color_wheel.pick.is_some()
                                {
                                    view.update(cx, |studio, _| studio.color_wheel.pick = None);
                                }
                            }
                        });
                        window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                            if phase == DispatchPhase::Capture && event.button == MouseButton::Left
                            {
                                apply(&view, bounds, event.position, false, true, cx);
                            }
                        });
                    },
                )
                .size_full(),
            )
    }

    fn select(&mut self, x: f64, y: f64, start: bool, foreground: Color) -> Option<Color> {
        let dx = x - CENTER_X;
        let dy = y - CENTER_Y;
        if start {
            self.pick = if (82. ..=105.).contains(&dx.hypot(dy)) {
                Some(Pick::Hue)
            } else if (SQUARE_X..=SQUARE_X + SQUARE_EDGE).contains(&x)
                && (SQUARE_Y..=SQUARE_Y + SQUARE_EDGE).contains(&y)
            {
                Some(Pick::SaturationValue)
            } else {
                None
            };
        }
        let (_, mut saturation, mut value) = hsv(foreground);
        match self.pick? {
            Pick::Hue => self.hue = (dy.atan2(dx) / TAU).rem_euclid(1.),
            Pick::SaturationValue => {
                saturation = ((x - SQUARE_X) / SQUARE_EDGE).clamp(0., 1.);
                value = (1. - (y - SQUARE_Y) / SQUARE_EDGE).clamp(0., 1.);
            }
        }
        Some(color(self.hue, saturation, value))
    }
}

fn apply(
    view: &WeakEntity<Studio>,
    bounds: Bounds<Pixels>,
    mouse: Point<Pixels>,
    start: bool,
    end: bool,
    cx: &mut App,
) {
    let Some(view) = view.upgrade() else {
        return;
    };
    if (!start && view.read(cx).color_wheel.pick.is_none())
        || bounds.size.width <= px(0.)
        || bounds.size.height <= px(0.)
    {
        return;
    }
    let x = f64::from((mouse.x - bounds.origin.x) / bounds.size.width) * WHEEL_WIDTH;
    let y = f64::from((mouse.y - bounds.origin.y) / bounds.size.height) * WHEEL_HEIGHT;
    let captured = view.update(cx, |studio, cx| {
        if studio.panel.is_some() {
            studio.color_wheel.pick = None;
            return false;
        }
        let foreground = studio.editor.settings.foreground;
        let picked = studio.color_wheel.select(x, y, start, foreground);
        if end {
            studio.color_wheel.pick = None;
        }
        if let Some(color) = picked {
            studio.editor.settings.foreground = color;
            studio.refresh(cx);
        }
        picked.is_some()
    });
    if captured {
        cx.stop_propagation();
    }
}

fn position(bounds: Bounds<Pixels>, x: f64, y: f64) -> Point<Pixels> {
    point(
        bounds.origin.x + bounds.size.width * (x / WHEEL_WIDTH) as f32,
        bounds.origin.y + bounds.size.height * (y / WHEEL_HEIGHT) as f32,
    )
}

fn paint_marker(
    bounds: Bounds<Pixels>,
    x: f64,
    y: f64,
    marker: Arc<RenderImage>,
    window: &mut Window,
) {
    let target = Bounds::new(
        position(bounds, x - MARKER_EDGE / 2., y - MARKER_EDGE / 2.),
        size(
            bounds.size.width * (MARKER_EDGE / WHEEL_WIDTH) as f32,
            bounds.size.height * (MARKER_EDGE / WHEEL_HEIGHT) as f32,
        ),
    );
    let _ = window.paint_image(bounds, target, Corners::default(), marker, 0, false);
}

fn hsv([r, g, b, _]: Color) -> (Option<f64>, f64, f64) {
    let [r, g, b] = [r, g, b].map(|value| f64::from(value) / 255.);
    let value = r.max(g).max(b);
    let delta = value - r.min(g).min(b);
    let hue = (delta != 0.).then(|| {
        let sector = if value == r {
            (g - b) / delta
        } else if value == g {
            (b - r) / delta + 2.
        } else {
            (r - g) / delta + 4.
        };
        (sector / 6.).rem_euclid(1.)
    });
    (hue, if value == 0. { 0. } else { delta / value }, value)
}

fn color(hue: f64, saturation: f64, value: f64) -> Color {
    let sector = hue * 6.;
    let k = sector.floor();
    let fraction = sector - k;
    let p = value * (1. - saturation);
    let q = value * (1. - fraction * saturation);
    let t = value * (1. - (1. - fraction) * saturation);
    let [r, g, b] = [
        [value, t, p],
        [q, value, p],
        [p, value, t],
        [p, q, value],
        [t, p, value],
        [value, p, q],
    ][k as usize % 6]
        .map(|value| (value * 255.).round() as u8);
    [r, g, b, 255]
}

fn ring_image() -> Arc<RenderImage> {
    let width = WHEEL_WIDTH as u32 * 2;
    let height = WHEEL_HEIGHT as u32 * 2;
    let rgba = RgbaImage::from_fn(width, height, |x, y| {
        let dx = (f64::from(x) + 0.5) / 2. - CENTER_X;
        let dy = (f64::from(y) + 0.5) / 2. - CENTER_Y;
        let coverage = ((7.75 - (dx.hypot(dy) - RING_RADIUS).abs()) * 2.).clamp(0., 1.);
        if coverage == 0. {
            return image::Rgba([0; 4]);
        }
        let [r, g, b, _] = color((dy.atan2(dx) / TAU).rem_euclid(1.), 1., 1.);
        image::Rgba([b, g, r, (coverage * 255.).round() as u8])
    });
    Arc::new(RenderImage::new(smallvec::smallvec![Frame::new(rgba)]))
}

fn square_image([r, g, b, _]: Color) -> Arc<RenderImage> {
    let edge = SQUARE_EDGE as u32 * 2;
    let rgba = RgbaImage::from_fn(edge, edge, |x, y| {
        let saturation = (f64::from(x) + 0.5) / f64::from(edge);
        let value = 1. - (f64::from(y) + 0.5) / f64::from(edge);
        let [b, g, r] = [b, g, r].map(|channel| {
            ((255. * (1. - saturation) + f64::from(channel) * saturation) * value).round() as u8
        });
        image::Rgba([b, g, r, 255])
    });
    Arc::new(RenderImage::new(smallvec::smallvec![Frame::new(rgba)]))
}

fn marker_image() -> Arc<RenderImage> {
    let edge = MARKER_EDGE as u32 * 2;
    let rgba = RgbaImage::from_fn(edge, edge, |x, y| {
        let dx = (f64::from(x) + 0.5 - MARKER_EDGE) / 2.;
        let dy = (f64::from(y) + 0.5 - MARKER_EDGE) / 2.;
        let distance = (dx.hypot(dy) - 4.).abs();
        let coverage = ((1.75 - distance) * 2.).clamp(0., 1.);
        let shade = (((0.75 - distance) * 2.).clamp(0., 1.) * 255.).round() as u8;
        image::Rgba([shade, shade, shade, (coverage * 255.).round() as u8])
    });
    Arc::new(RenderImage::new(smallvec::smallvec![Frame::new(rgba)]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wheel_matches_hue_segments_and_keeps_gray_hue_for_the_square() {
        let mut wheel = ColorWheel::default();
        let white = [255; 4];
        assert_eq!(wheel.select(204., 105., true, white), Some(white));
        assert_eq!(wheel.select(166., 49., true, white), Some([255, 0, 0, 255]));
        assert_eq!(
            wheel.select(190., 20., false, white),
            Some([255, 0, 0, 255])
        );
        assert_eq!(wheel.select(40., 220., false, white), Some([0, 0, 0, 255]));
        assert_eq!(wheel.select(0., 0., true, white), None);
        assert_eq!(
            wheel.select(16., 105., true, [255, 0, 0, 255]),
            Some([0, 255, 255, 255])
        );
        assert_eq!(hsv([10, 10, 10, 255]).0, None);
        assert_eq!(hsv([0, 255, 255, 255]), (Some(0.5), 1., 1.));
    }
}
