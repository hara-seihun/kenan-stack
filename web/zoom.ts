/** Pinch, pan and double-tap geometry for the image viewer, as pure functions of the view so they test without a DOM.
 * A view places the image (laid out at its fit size, origin top-left) at `scale` and offset (`x`, `y`) inside the port. */
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type View = { scale: number; x: number; y: number };
export type Pinch = { view: View; mid: Point; distance: number };

export const MAX_SCALE = 8;
export const DOUBLE_TAP_SCALE = 2.5;
/** A live pinch may overshoot fit and the maximum by this much; release springs back. */
const OVERSHOOT = 1.5;

export const zoomed = (view: View): boolean => view.scale > 1.01;

/** The image at scale 1: whole and never enlarged; one so tall that it would show as a sliver fills the width and pans. */
export function fitSize(natural: Size, port: Size): Size {
  const contain = Math.min(1, port.width / natural.width, port.height / natural.height);
  const sliver = contain * natural.width < 0.6 * Math.min(port.width, natural.width);
  const scale = sliver ? Math.min(1, port.width / natural.width) : contain;
  return { width: natural.width * scale, height: natural.height * scale };
}

/** Whether the image at fit is taller than the port, so a vertical drag pans instead of dismissing. */
export const tall = (content: Size, port: Size): boolean => content.height > port.height + 1;

export function zoomAt(view: View, scale: number, at: Point): View {
  const k = scale / view.scale;
  return { scale, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k };
}

const axis = (offset: number, length: number, port: number) =>
  length <= port ? (port - length) / 2 : Math.min(0, Math.max(port - length, offset));

/** The nearest valid view: scale within [1, MAX_SCALE] (about `at`), image centred where it is smaller than the port
 * and otherwise covering it edge to edge. */
export function settle(view: View, content: Size, port: Size, at: Point = { x: port.width / 2, y: port.height / 2 }): View {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale));
  const v = scale === view.scale ? view : zoomAt(view, scale, at);
  return { scale, x: axis(v.x, content.width * scale, port.width), y: axis(v.y, content.height * scale, port.height) };
}

/** The view while two fingers move: the image point first under their midpoint stays under it, and it follows the midpoint. */
export function pinch(start: Pinch, mid: Point, distance: number): View {
  const scale = Math.min(MAX_SCALE * OVERSHOOT, Math.max(1 / OVERSHOOT, start.view.scale * distance / start.distance));
  const k = scale / start.view.scale;
  return { scale, x: mid.x - (start.mid.x - start.view.x) * k, y: mid.y - (start.mid.y - start.view.y) * k };
}

/** Double tap: back to fit when zoomed, otherwise DOUBLE_TAP_SCALE around the tapped point. */
export function toggleZoom(view: View, at: Point, content: Size, port: Size): View {
  return settle(zoomAt(view, zoomed(view) ? 1 : DOUBLE_TAP_SCALE, at), content, port, at);
}
