import { TEXT_MAX_SAMPLES, TEXT_THINNING } from '../text/font';

/**
 * WGSL versions of the shaders in shaders.ts, for the WebGPU backend. The math is the
 * same line for line; differences come from the API:
 *  - clip-space depth is 0..1 (GL: -1..1), so depth values are written as they are;
 *  - fragment y grows downwards, so the grid needs no flip;
 *  - texture sampling and derivatives must be in uniform control flow, so they happen
 *    before any branch on per-instance data;
 *  - GLSL `mod` (floored) is `fmod` below: WGSL's `%` truncates.
 */

/** Shared by every pipeline: group 0, binding 0. */
const FRAME = /* wgsl */ `
struct Frame {
  camera: vec4f,   // x, y, zoom, dpr
  viewport: vec4f, // width, height (CSS px), SDF edge, _
};
@group(0) @binding(0) var<uniform> frame: Frame;

fn corner(vi: u32) -> vec2f {
  return vec2f(f32(vi & 1u), f32(vi >> 1u)); // triangle strip: (0,0) (1,0) (0,1) (1,1)
}

fn toClip(world: vec2f) -> vec2f {
  let c = (world - frame.camera.xy) * frame.camera.z / frame.viewport.xy * 2.0 - 1.0;
  return vec2f(c.x, -c.y);
}

fn fmod(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

fn rotate(p: vec2f, angle: f32) -> vec2f {
  let c = cos(angle);
  let s = sin(angle);
  return vec2f(p.x * c - p.y * s, p.x * s + p.y * c);
}

fn sdRoundBox(p: vec2f, b: vec2f, r0: f32) -> f32 {
  let r = min(r0, min(b.x, b.y));
  let q = abs(p) - b + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

const HIDDEN = vec4f(2.0, 2.0, 2.0, 1.0); // outside the clip volume
`;

export const SHAPE_WGSL = /* wgsl */ `${FRAME}
const DEPTH_STEP: f32 = 1.0 / 1048576.0;
const STICKY_SHADOW: f32 = 24.0;
const MAX_SIDES: i32 = 12;
const RADIUS_CAP: f32 = 0.999;

struct ShapeIn {
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) slot: u32,
  @location(0) rect: vec4f,        // x, y, w, h (world)
  @location(1) params: vec4f,      // rotation, radius, strokeWidth, kind
  @location(2) fill: vec4f,
  @location(3) stroke: vec4f,
  @location(4) strokeStyle: f32,   // 0 solid, 1 dashed, 2 dotted
};

struct ShapeOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,       // position relative to the shape center, world units
  @location(1) @interpolate(flat) halfSize: vec2f,
  @location(2) @interpolate(flat) params: vec4f,
  @location(3) @interpolate(flat) fill: vec4f,
  @location(4) @interpolate(flat) stroke: vec4f,
  @location(5) @interpolate(flat) strokeStyle: f32,
};

@vertex
fn vs(in: ShapeIn) -> ShapeOut {
  var out: ShapeOut;
  let kind = in.params.w;
  if (kind < 0.0) {
    out.pos = HIDDEN; // hidden slot
    return out;
  }
  let halfSize = in.rect.zw * 0.5;
  let px = 1.0 / frame.camera.z;
  var pad = in.params.z * 0.5 + px * 1.5; // half stroke + antialiasing
  if (kind == 2.0) {
    pad += STICKY_SHADOW;
  }
  let local = (corner(in.vi) * 2.0 - 1.0) * (halfSize + pad);
  let world = in.rect.xy + halfSize + rotate(local, in.params.x);
  // Depth from paint order (see depth.ts); instance index == slot.
  let depth = max(0.0, 1.0 - f32(in.slot + 1u) * DEPTH_STEP);
  out.pos = vec4f(toClip(world), depth, 1.0);
  out.local = local;
  out.halfSize = halfSize;
  out.params = in.params;
  out.fill = in.fill;
  out.stroke = in.stroke;
  out.strokeStyle = in.strokeStyle;
  return out;
}

fn sdEllipse(p: vec2f, b: vec2f) -> f32 {
  let k1 = length(p / (b * b));
  if (k1 < 1e-6) {
    return -min(b.x, b.y);
  }
  let k0 = length(p / b);
  return k0 * (k0 - 1.0) / k1;
}

fn polygonSides(kind: f32) -> i32 {
  return clamp(i32(kind + 0.5) - 10, 3, MAX_SIDES);
}

// Vertices of the regular polygon with n corners stretched to the box (first one at the top).
fn polygonVertices(halfSize: vec2f, n: i32) -> array<vec2f, MAX_SIDES> {
  var v: array<vec2f, MAX_SIDES>;
  var lo = vec2f(1e9);
  var hi = vec2f(-1e9);
  for (var i = 0; i < n; i++) {
    let a = 6.283185307179586 * f32(i) / f32(n);
    v[i] = vec2f(sin(a), -cos(a));
    lo = min(lo, v[i]);
    hi = max(hi, v[i]);
  }
  let scale = 2.0 * halfSize / (hi - lo);
  let mid = (lo + hi) * 0.5;
  for (var i = 0; i < n; i++) {
    v[i] = (v[i] - mid) * scale;
  }
  return v;
}

// Mirrors core/src/elements/shape-geometry.ts so hit testing matches the pixels.
fn sdRoundPolygon(p: vec2f, halfSize: vec2f, n: i32, r0: f32) -> f32 {
  var v = polygonVertices(halfSize, n);
  var nrm: array<vec2f, MAX_SIDES>;
  var cut: array<f32, MAX_SIDES>;
  for (var i = 0; i < n; i++) {
    let e = v[(i + 1) % n] - v[i];
    nrm[i] = normalize(vec2f(e.y, -e.x)); // outward: vertices run clockwise on screen
  }
  for (var i = 0; i < n; i++) {
    let a = nrm[(i + n - 1) % n];
    let b = nrm[i];
    cut[i] = abs(a.x * b.y - a.y * b.x) / (1.0 + dot(a, b));
  }
  var rmax = 1e9;
  for (var i = 0; i < n; i++) {
    let j = (i + 1) % n;
    rmax = min(rmax, length(v[j] - v[i]) / (cut[i] + cut[j]));
  }
  let r = clamp(r0, 0.0, rmax * RADIUS_CAP);
  if (r > 0.0) {
    for (var i = 0; i < n; i++) {
      let a = nrm[(i + n - 1) % n];
      let b = nrm[i];
      v[i] -= (a + b) * (r / (1.0 + dot(a, b)));
    }
  }
  // Exact polygon distance (Inigo Quilez).
  var d = dot(p - v[0], p - v[0]);
  var s = 1.0;
  for (var i = 0; i < n; i++) {
    let j = select(i - 1, n - 1, i == 0);
    let e = v[j] - v[i];
    let w = p - v[i];
    let ee = dot(e, e);
    let t = select(0.0, clamp(dot(w, e) / ee, 0.0, 1.0), ee > 0.0);
    let b = w - e * t;
    d = min(d, dot(b, b));
    let c0 = p.y >= v[i].y;
    let c1 = p.y < v[j].y;
    let c2 = e.x * w.y > e.y * w.x;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) {
      s = -s;
    }
  }
  return s * sqrt(d) - r;
}

// Dashed/dotted borders: (position along the outline, length of the stretch it runs over).
fn boxPerimeter(p: vec2f, b: vec2f, r0: f32) -> vec2f {
  let r = min(r0, min(b.x, b.y));
  let q = abs(p);
  let c = b - r; // center of the corner arc
  let arc = r * 1.5707963267948966;
  var s: f32;
  if (q.x > c.x && q.y > c.y) {
    s = c.x + r * atan2(q.x - c.x, q.y - c.y);
  } else if (q.x <= c.x && q.y <= c.y) {
    s = select(q.x, c.x + arc + (c.y - q.y), b.x - q.x < b.y - q.y);
  } else if (q.x <= c.x) {
    s = q.x;
  } else {
    s = c.x + arc + (c.y - q.y);
  }
  return vec2f(s, c.x + arc + c.y);
}

fn ellipsePerimeter(p: vec2f, b: vec2f) -> vec2f {
  let q = abs(p);
  let phi = atan2(q.x / max(b.x, 1e-6), q.y / max(b.y, 1e-6)); // eccentric angle from the bottom
  let quarter = 0.7853981633974483 * (3.0 * (b.x + b.y) - sqrt((3.0 * b.x + b.y) * (b.x + 3.0 * b.y)));
  return vec2f(quarter * phi / 1.5707963267948966, quarter);
}

fn polygonPerimeter(p: vec2f, halfSize: vec2f, n: i32) -> vec2f {
  var v = polygonVertices(halfSize, n); // var: indexed with a runtime index
  var total = 0.0;
  var best = 1e20;
  var s = 0.0;
  for (var i = 0; i < n; i++) {
    let e = v[(i + 1) % n] - v[i];
    let l = length(e);
    let t = clamp(dot(p - v[i], e) / max(l * l, 1e-12), 0.0, 1.0);
    let dist = length(p - v[i] - e * t);
    if (dist < best) {
      best = dist;
      s = total + t * l;
    }
    total += l;
  }
  return vec2f(s, total);
}

fn premul(c: vec4f) -> vec4f {
  return vec4f(c.rgb * c.a, c.a);
}

fn shapeColor(in: ShapeOut) -> vec4f {
  let kind = in.params.w;
  let px = 1.0 / frame.camera.z;
  // kind: 0 rect, 1 ellipse, 2 sticky, 10 + n polygon with n corners.
  var d: f32;
  if (kind == 1.0) {
    d = sdEllipse(in.local, in.halfSize);
  } else if (kind >= 10.0) {
    d = sdRoundPolygon(in.local, in.halfSize, polygonSides(kind), in.params.y);
  } else {
    d = sdRoundBox(in.local, in.halfSize, in.params.y);
  }

  // Stroke is centered on the outline, same as hit testing.
  let halfStroke = in.params.z * 0.5;
  let outer = clamp(0.5 - (d - halfStroke) / px, 0.0, 1.0);
  let inner = clamp(0.5 - (d + halfStroke) / px, 0.0, 1.0);
  var color = premul(in.fill) * inner + premul(in.stroke) * (outer - inner);

  if (in.strokeStyle > 0.5 && halfStroke > 0.0) {
    // Dashed (dash 4w, gap 3w) or dotted (round dots of the stroke width, gap w).
    // The period is stretched so a whole number of dashes fits the stretch.
    var sl: vec2f;
    if (kind == 1.0) {
      sl = ellipsePerimeter(in.local, in.halfSize);
    } else if (kind >= 10.0) {
      sl = polygonPerimeter(in.local, in.halfSize, polygonSides(kind));
    } else {
      sl = boxPerimeter(in.local, in.halfSize, in.params.y);
    }
    let w = max(in.params.z, px);
    let dotted = in.strokeStyle > 1.5;
    var period = select(7.0 * w, 2.0 * w, dotted);
    period = sl.y / max(1.0, floor(sl.y / period + 0.5));
    let u = fmod(sl.x + period * 0.5, period) - period * 0.5; // from the nearest dash center
    var strokeCov: f32;
    if (dotted) {
      strokeCov = clamp(0.5 - (length(vec2f(u, d)) - w * 0.5) / px, 0.0, 1.0);
    } else {
      strokeCov = (outer - inner) * clamp(0.5 - (abs(u) - period * (2.0 / 7.0)) / px, 0.0, 1.0);
    }
    // In the gaps the fill reaches the outline, as with no border at all.
    let fill = premul(in.fill) * clamp(0.5 - d / px, 0.0, 1.0);
    let stroke = premul(in.stroke) * strokeCov;
    color = stroke + fill * (1.0 - stroke.a);
  }

  if (kind == 2.0) {
    // Shadow of a sticky as in Miro: paper lifting at its lower edge. A box a bit narrower
    // than the note, shifted down, blurred, and fading in from top to bottom, so it shows
    // under the lower edge and hardly at the sides.
    let lift = smoothstep(-in.halfSize.y * 0.3, in.halfSize.y, in.local.y);
    let sd = sdRoundBox(in.local - vec2f(0.0, 8.0), in.halfSize - vec2f(6.0, 4.0), 6.0);
    let shadow = 0.24 * lift * (1.0 - smoothstep(-12.0, 12.0, sd));
    color = color + vec4f(0.0, 0.0, 0.0, shadow) * (1.0 - color.a);
  }
  return color;
}

@fragment
fn fs(in: ShapeOut) -> @location(0) vec4f {
  let color = shapeColor(in);
  if (color.a <= 0.0) {
    discard;
  }
  return color;
}

// Depth pass (color writes are masked off): only mostly-opaque pixels occlude what is
// below. Translucent pixels — AA fringe, sticky shadow, translucent fills — are discarded,
// so they keep the depth of an opaque shape under them instead of erasing it.
@fragment
fn fsDepth(in: ShapeOut) -> @location(0) vec4f {
  if (shapeColor(in).a <= 0.5) {
    discard;
  }
  return vec4f(0.0);
}
`;

export const GRID_WGSL = /* wgsl */ `${FRAME}
struct Grid {
  color: vec4f,
  spacing: f32, // world units between dots
  fade: f32,    // 0..1, fades a level in while zooming
  lines: f32,   // 1: lines, 0: dots
  _pad: f32,
};
@group(1) @binding(0) var<uniform> grid: Grid;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let dpr = frame.camera.w;
  let css = frag.xy / dpr;
  let world = frame.camera.xy + css / frame.camera.z;
  let cell = (fract(world / grid.spacing + 0.5) - 0.5) * grid.spacing * frame.camera.z; // CSS px to nearest dot
  // Lines are one device pixel wide (antialiased); dots have a ~1.6 CSS px radius.
  var coverage: f32;
  if (grid.lines > 0.5) {
    coverage = clamp(1.0 - (min(abs(cell.x), abs(cell.y)) * dpr - 0.5), 0.0, 1.0);
  } else {
    coverage = clamp(1.6 - length(cell), 0.0, 1.0);
  }
  let a = coverage * grid.fade * grid.color.a;
  if (a <= 0.0) {
    discard;
  }
  return vec4f(grid.color.rgb * a, a);
}
`;

export const TEXT_WGSL = /* wgsl */ `${FRAME}
@group(1) @binding(0) var atlasSampler: sampler;
@group(1) @binding(1) var sdfAtlas: texture_2d<f32>;
@group(1) @binding(2) var colorAtlas: texture_2d<f32>;

struct GlyphIn {
  @builtin(vertex_index) vi: u32,
  @location(0) anchorOffset: vec4f, // anchor.xy (element center), offset.xy
  @location(1) sizeRotDepth: vec4f, // w, h, rotation, depth
  @location(2) uv: vec4f,           // u0, v0, u1, v1
  @location(3) mode: f32,           // 0 sdf, 1 color, 2 solid, 3 bitmap
  @location(4) color: vec4f,
};

struct GlyphOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) mode: f32,
  @location(2) @interpolate(flat) color: vec4f,
};

@vertex
fn vs(in: GlyphIn) -> GlyphOut {
  var size = in.sizeRotDepth.xy;
  var offset = in.anchorOffset.zw;
  if (in.mode > 1.5 && in.mode < 2.5) {
    // Keep thin solid quads (underlines, far-away bars) at least ~1px tall so they don't shimmer.
    let minH = 1.0 / frame.camera.z;
    if (size.y < minH) {
      offset.y -= (minH - size.y) * 0.5;
      size.y = minH;
    }
  }
  let c = corner(in.vi);
  var world = in.anchorOffset.xy + rotate(offset + c * size, in.sizeRotDepth.z);
  if (in.mode > 2.5) {
    // Bitmap glyphs land on whole device pixels: their element's anchor is snapped to the
    // pixel grid, so all its glyphs move together and keep their spacing.
    let scale = frame.camera.z * frame.camera.w;
    let anchorPixels = (in.anchorOffset.xy - frame.camera.xy) * scale;
    world += (floor(anchorPixels + 0.5) - anchorPixels) / scale;
  }
  var out: GlyphOut;
  out.pos = vec4f(toClip(world), in.sizeRotDepth.w, 1.0);
  out.uv = mix(in.uv.xy, in.uv.zw, c);
  out.mode = in.mode;
  out.color = in.color;
  return out;
}

fn sdfCoverage(uv: vec2f, dx: vec2f, dy: vec2f, lo: f32, hi: f32) -> f32 {
  return smoothstep(lo, hi, textureSampleGrad(sdfAtlas, atlasSampler, uv, dx, dy).r);
}

fn bitmapAt(uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  return textureSampleGrad(colorAtlas, atlasSampler, uv, dx, dy);
}

@fragment
fn fs(in: GlyphOut) -> @location(0) vec4f {
  // Implicit-derivative sampling and derivatives need uniform control flow: done up front.
  // The extra samples below pass explicit gradients, which may be taken in any branch.
  let dx = dpdx(in.uv);
  let dy = dpdy(in.uv);
  let d = textureSample(sdfAtlas, atlasSampler, in.uv).r;
  // SDF units per screen pixel across the outline: the gradient's length. fwidth (|dx|+|dy|)
  // is up to 1.4x that on slanted and curved edges, which spread over more than a pixel.
  // Keeps edges ~1px wide at any zoom and tier.
  let fw = length(vec2f(dpdx(d), dpdy(d)));
  let w1 = max(fw * 0.5, 1e-4);
  if (in.mode > 2.5) {
    // Coverage rasterized at this size, texel for pixel (d is that texel): as the browser
    // draws it.
    let coverage = d * in.color.a;
    if (coverage <= 0.0) {
      discard;
    }
    return vec4f(in.color.rgb * coverage, coverage);
  }
  if (in.mode > 1.5) {
    return vec4f(in.color.rgb * in.color.a, in.color.a);
  }
  // Four samples per pixel on a rotated grid: a box filter over the pixel. With one sample,
  // glyphs drawn smaller than their raster (zoomed out) alias into blotchy, uneven strokes.
  let o1 = 0.125 * dx + 0.375 * dy;
  let o2 = 0.375 * dx - 0.125 * dy;
  if (in.mode > 0.5) {
    // Premultiplied RGBA bitmap; text color alpha acts as opacity. Filtered only when
    // shrunk: averaging a magnified bitmap would just blur it.
    let shrunk = max(length(dx), length(dy)) * f32(textureDimensions(colorAtlas).x) > 1.0;
    var t = bitmapAt(in.uv, dx, dy);
    if (shrunk) {
      t = 0.25 * (bitmapAt(in.uv + o1, dx, dy) + bitmapAt(in.uv - o1, dx, dy) +
                  bitmapAt(in.uv + o2, dx, dy) + bitmapAt(in.uv - o2, dx, dy));
    }
    t = t * in.color.a;
    if (t.a <= 0.0) {
      discard;
    }
    return t;
  }
  // The outline moves inwards by TEXT_THINNING of a pixel (see there): otherwise glyphs come
  // out heavier than the browser's and look smudged.
  let edge = frame.viewport.z + ${TEXT_THINNING.toFixed(2)} * fw;
  // Drawn at about its raster size or bigger: one sample with an edge one pixel wide, as
  // crisp as the browser's own text.
  let crisp = smoothstep(edge - w1, edge + w1, d);
  // Atlas texels per screen pixel.
  let shrink = max(length(dx), length(dy)) * f32(textureDimensions(sdfAtlas).x);
  // Shrunk (zoomed out): a box filter over the pixel, n x n samples on a grid, about one per
  // atlas texel (see the WebGL shader); each covers 1/n of the pixel, so its own edge is that
  // much narrower.
  let n = i32(clamp(ceil(shrink), 2.0, f32(${TEXT_MAX_SAMPLES})));
  let cell = 1.0 / f32(n);
  let wn = max(fw * 0.7 * cell, 1e-4);
  let lo = edge - wn;
  let hi = edge + wn;
  var filtered = 0.0;
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < n; j++) {
      let offset = ((f32(i) + 0.5) * cell - 0.5) * dx + ((f32(j) + 0.5) * cell - 0.5) * dy;
      filtered += sdfCoverage(in.uv + offset, dx, dy, lo, hi);
    }
  }
  filtered *= cell * cell;
  // Blended, so zooming never pops between the two.
  let a = mix(crisp, filtered, smoothstep(1.5, 2.5, shrink)) * in.color.a;
  if (a <= 0.0) {
    discard;
  }
  return vec4f(in.color.rgb * a, a);
}
`;

export const LINE_WGSL = /* wgsl */ `${FRAME}
struct LineIn {
  @builtin(vertex_index) vi: u32,
  @location(0) points: vec4f, // x0, y0, x1, y1 (arcs: cx, cy, radius, start angle)
  @location(1) params: vec4f, // halfWidth, mode, dash, gap
  @location(2) extra: vec4f,  // dashOffset, depth, capSize (arcs: sweep), joins (see line-layer.ts)
  @location(3) color: vec4f,
};

struct LineOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,                      // (along, across) in world units
  @location(1) @interpolate(flat) params: vec4f,  // halfWidth (effective), mode, dash, gap
  @location(2) @interpolate(flat) extra: vec3f,   // dashOffset, length, capSize (arcs: dashOffset, radius, sweep)
  @location(3) @interpolate(flat) color: vec4f,
  @location(4) @interpolate(flat) arcStart: f32,
  @location(5) @interpolate(flat) joints: vec4f,   // normals of the start and end joints' split lines; 0: free end
};

// One end of the packed joins: 0, or the flag (2048) + the split line's angle in 11 bits.
fn joinNormal(bits: u32) -> vec2f {
  if (bits < 2048u) {
    return vec2f(0.0);
  }
  let a = (f32(bits - 2048u) / 2047.0 * 2.0 - 1.0) * 1.5707963267948966;
  return vec2f(cos(a), sin(a));
}

@vertex
fn vs(in: LineIn) -> LineOut {
  var out: LineOut;
  let joins = u32(in.extra.w + 0.5);
  out.joints = vec4f(joinNormal(joins & 4095u), joinNormal(joins >> 12u));
  let mode = in.params.y;
  if (mode < 0.0) {
    out.pos = HIDDEN;
    return out;
  }
  let px = 1.0 / frame.camera.z;
  let cor = corner(in.vi);
  let p0 = in.points.xy;
  let dir = in.points.zw - p0;
  let len = length(dir);
  let t = select(vec2f(1.0, 0.0), dir / len, len > 0.0);
  let n = vec2f(-t.y, t.x);

  // Lines thinner than a pixel stay one pixel wide but fade, so far-away lines keep their weight.
  var hw = in.params.x;
  let minHw = 0.5 * px;
  let fade = select(1.0, hw / minHw, hw < minHw);
  hw = max(hw, minHw);

  let pad = hw + 1.5 * px;
  out.arcStart = 0.0;
  out.color = vec4f(in.color.rgb, in.color.a * fade);
  if (mode > 4.5) {
    // Rounded bend: a quad over the arc's bounding box (its ends, plus the axis extremes
    // it passes through), padded for the stroke.
    let c = in.points.xy;
    let r = in.points.z;
    let a0 = in.points.w;
    let sweep = in.extra.z;
    let e0 = c + r * vec2f(cos(a0), sin(a0));
    let e1 = c + r * vec2f(cos(a0 + sweep), sin(a0 + sweep));
    var lo = min(e0, e1);
    var hi = max(e0, e1);
    let turn = select(1.0, -1.0, sweep < 0.0);
    for (var k = 0; k < 4; k++) {
      let ang = f32(k) * 1.5707963267948966;
      if (fmod((ang - a0) * turn, 6.283185307179586) <= abs(sweep)) {
        let q = c + r * vec2f(cos(ang), sin(ang));
        lo = min(lo, q);
        hi = max(hi, q);
      }
    }
    let world = mix(lo - pad, hi + pad, cor);
    out.pos = vec4f(toClip(world), in.extra.y, 1.0);
    out.local = world - c;
    out.params = vec4f(hw, mode, in.params.z, in.params.w);
    out.extra = vec3f(in.extra.x, r, sweep);
    out.arcStart = a0;
    return out;
  }
  let size = in.extra.z;
  let u = select(vec2f(-pad, size + pad), vec2f(-pad, len + pad), mode < 0.5);
  let across = select(size * 0.5 + pad, pad, mode < 0.5);
  let along = mix(u.x, u.y, cor.x);
  let side = mix(-across, across, cor.y);

  let world = p0 + t * along + n * side;
  out.pos = vec4f(toClip(world), in.extra.y, 1.0);
  out.local = vec2f(along, side);
  out.params = vec4f(hw, mode, in.params.z, in.params.w);
  out.extra = vec3f(in.extra.x, len, size);
  return out;
}

// A joint belongs to one of its two pieces at each pixel (line-layer.ts): a piece draws from
// the split line at its start, and up to a hundredth of a pixel past the one at its end. That
// sliver, drawn by both, means float noise can't leave a pixel to neither of them.
// The split angles are quantized (line-layer.ts), so two neighbours' split lines differ by up
// to JOIN_SLACK radians: a gap that widens away from the centre line. Each piece reaches that
// far past its split ("across": distance from the centre line), so no pixel is left out.
const JOIN_SLACK: f32 = 0.002;
fn outsideJoints(joints: vec4f, fromStart: f32, pastEnd: f32, across: f32, px: f32) -> bool {
  let slack = across * JOIN_SLACK;
  return (any(joints.xy != vec2f(0.0)) && fromStart < -slack) ||
    (any(joints.zw != vec2f(0.0)) && pastEnd > 0.01 * px + slack);
}

// How far a point at arc length u (plus the connector's dash offset) is from a dash; 0 inside one.
fn toDash(u: f32, offset: f32, dash: f32, gap: f32) -> f32 {
  if (gap <= 0.0) {
    return 0.0;
  }
  let period = dash + gap;
  let t = fmod(u + offset, period);
  return select(min(t - dash, period - t), 0.0, t <= dash);
}

fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Inigo Quilez, isosceles triangle with the apex at the origin and the base at y = q.y.
fn sdTriangleIsosceles(p0: vec2f, q: vec2f) -> f32 {
  let p = vec2f(abs(p0.x), p0.y);
  let a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
  let b = p - q * vec2f(clamp(p.x / q.x, 0.0, 1.0), 1.0);
  let s = -sign(q.y);
  let d = min(vec2f(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2f(dot(b, b), s * (p.y - q.y)));
  return -sqrt(d.x) * sign(d.y);
}

fn ndot(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.x - a.y * b.y;
}

// Inigo Quilez, rhombus centered at the origin with half-diagonals b.
fn sdRhombus(p0: vec2f, b: vec2f) -> f32 {
  let p = abs(p0);
  let h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
  let d = length(p - 0.5 * b * vec2f(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}

// Coverage of a line pixel (times its alpha), or -1 where no piece of the line is drawn.
fn lineAlpha(in: LineOut) -> f32 {
  let px = 1.0 / frame.camera.z;
  let hw = in.params.x;
  let mode = in.params.y;
  let u = in.local.x;
  let v = in.local.y;
  let size = in.extra.z;
  var d: f32;

  if (mode > 4.5) {
    // Rounded bend, drawn exactly: distance to the circle across, arc length along it.
    // Past its ends (the first half of the missing angle after the end, the rest before
    // the start) it gets round caps, like a segment, where no other piece continues it.
    let r = in.extra.y;
    let span = abs(in.extra.z);
    let turn = select(1.0, -1.0, in.extra.z < 0.0);
    let tau = 6.283185307179586;
    let rel = fmod((atan2(v, u) - in.arcStart) * turn, tau); // here (u, v) = point - center
    let along = select(rel - tau, rel, rel <= span + (tau - span) * 0.5) * r;
    // Joined ends split along the radius: the neighbouring segments are tangent there.
    if (outsideJoints(in.joints, along, along - span * r, abs(length(vec2f(u, v)) - r), px)) {
      return -1.0;
    }
    var off = abs(along - clamp(along, 0.0, span * r));
    off = max(off, toDash(along, in.extra.x, in.params.z, in.params.w));
    d = length(vec2f(off, length(vec2f(u, v)) - r)) - hw;
  } else if (mode < 0.5) {
    let len = in.extra.y;
    if (outsideJoints(in.joints, dot(vec2f(u, v), in.joints.xy), dot(vec2f(u - len, v), in.joints.zw), abs(v), px)) {
      return -1.0;
    }
    var off = abs(u - clamp(u, 0.0, len)); // past the segment ends: round caps
    off = max(off, toDash(u, in.extra.x, in.params.z, in.params.w));
    d = length(vec2f(off, v)) - hw;
  } else if (mode < 1.5) {
    // Open arrow: two strokes from the tip.
    d = sdSegment(vec2f(u, abs(v)), vec2f(0.0), vec2f(size, size * 0.5)) - hw;
  } else if (mode < 2.5) {
    d = sdTriangleIsosceles(vec2f(v, u), vec2f(size * 0.5, size));
  } else if (mode < 3.5) {
    d = length(vec2f(u - size * 0.5, v)) - size * 0.5;
  } else {
    d = sdRhombus(vec2f(u - size * 0.5, v), vec2f(size * 0.5, size * 0.35));
  }

  return clamp(0.5 - d / px, 0.0, 1.0) * in.color.a;
}

// Color, without depth writes: the depth pass before it already decided which line is on top.
@fragment
fn fs(in: LineOut) -> @location(0) vec4f {
  let a = lineAlpha(in);
  if (a <= 0.01) {
    discard;
  }
  return vec4f(in.color.rgb * a, a);
}

// Depth pass (color writes masked off), drawn first: only fully opaque pixels hide the lines
// below. An antialiased edge must not, or a line under it would be cut away there and the
// half-transparent edge would show the background: a light seam where lines cross.
@fragment
fn fsDepth(in: LineOut) -> @location(0) vec4f {
  if (lineAlpha(in) < 0.99) {
    discard;
  }
  return vec4f(0.0);
}
`;

export const MEDIA_WGSL = /* wgsl */ `${FRAME}
struct Media {
  rect: vec4f,   // x, y, w, h (world, unrotated box)
  uv: vec4f,     // image (u, v) at the box's top-left, and the (du, dv) it spans
  rotation: f32,
  depth: f32,
  radius: f32,
  mode: f32,     // 0: texture, 1: placeholder
};
@group(1) @binding(0) var<uniform> media: Media;
@group(2) @binding(0) var mediaSampler: sampler;
@group(2) @binding(1) var mediaTexture: texture_2d<f32>;

struct MediaOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> MediaOut {
  let halfSize = media.rect.zw * 0.5;
  let px = 1.0 / frame.camera.z;
  let local = (corner(vi) * 2.0 - 1.0) * (halfSize + px);
  let world = media.rect.xy + halfSize + rotate(local, media.rotation);
  var out: MediaOut;
  out.pos = vec4f(toClip(world), media.depth, 1.0);
  out.local = local;
  out.uv = (local + halfSize) / media.rect.zw;
  return out;
}

@fragment
fn fs(in: MediaOut) -> @location(0) vec4f {
  // Fill / fit / crop: where the box samples the image. Sampled up front (uniform control flow).
  let tc = media.uv.xy + clamp(in.uv, vec2f(0.0), vec2f(1.0)) * media.uv.zw;
  let texel = textureSample(mediaTexture, mediaSampler, clamp(tc, vec2f(0.0), vec2f(1.0)));
  let px = 1.0 / frame.camera.z;
  let d = sdRoundBox(in.local, media.rect.zw * 0.5, media.radius);
  let cover = clamp(0.5 - d / px, 0.0, 1.0);
  var color: vec4f;
  if (media.mode > 0.5) {
    // Loading placeholder: light fill with a soft border.
    let border = clamp(0.5 - (d + px * 1.5) / px, 0.0, 1.0);
    color = mix(vec4f(0.82, 0.84, 0.87, 1.0), vec4f(0.93, 0.94, 0.95, 1.0), border);
  } else {
    // Outside the image (fit's letterbox) nothing is drawn, with an anti-aliased edge.
    let perWorld = media.uv.zw / media.rect.zw;           // texture units per world unit
    let outside = max(-tc, tc - 1.0) / perWorld;          // world units past the image edge
    let inImage = clamp(0.5 - max(outside.x, outside.y) / px, 0.0, 1.0);
    color = texel * inImage; // premultiplied
  }
  color *= cover;
  if (color.a <= 0.01) {
    discard;
  }
  return color;
}
`;

/** Downsamples one mip level into the next (WebGPU has no generateMipmap). */
export const MIPMAP_WGSL = /* wgsl */ `
@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> Out {
  var pos = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = pos[vi];
  var out: Out;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  return textureSample(src, srcSampler, in.uv);
}
`;
