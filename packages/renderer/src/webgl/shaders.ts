import { TEXT_MAX_SAMPLES, TEXT_THINNING } from '../text/font';

/**
 * All shapes share one program: a unit quad instanced per element,
 * with the outline computed analytically (SDF) in the fragment shader.
 * One draw call paints every rect, ellipse and sticky on the board.
 */
export const SHAPE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;   // unit quad, 0..1
layout(location = 1) in vec4 a_rect;     // x, y, w, h (world)
layout(location = 2) in vec4 a_params;   // rotation, radius, strokeWidth, kind
layout(location = 3) in vec4 a_fill;     // normalized RGBA
layout(location = 4) in vec4 a_stroke;
layout(location = 5) in float a_strokeStyle; // 0 solid, 1 dashed, 2 dotted

uniform vec3 u_camera;    // x, y, zoom
uniform vec2 u_viewport;  // CSS pixels

const float DEPTH_STEP = 1.0 / 1048576.0;

out vec2 v_local;         // position relative to the shape center, world units
flat out vec2 v_half;
flat out vec4 v_params;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out float v_strokeStyle;

const float STICKY_SHADOW = 24.0;

void main() {
  float kind = a_params.w;
  if (kind < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // hidden slot: degenerate, clipped
    return;
  }
  vec2 halfSize = a_rect.zw * 0.5;
  float px = 1.0 / u_camera.z;              // one screen pixel in world units
  float pad = a_params.z * 0.5 + px * 1.5;  // half stroke + antialiasing
  if (kind == 2.0) pad += STICKY_SHADOW;
  vec2 local = (a_corner * 2.0 - 1.0) * (halfSize + pad);

  float c = cos(a_params.x);
  float s = sin(a_params.x);
  vec2 world = a_rect.xy + halfSize + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 screen = (world - u_camera.xy) * u_camera.z;
  vec2 clip = screen / u_viewport * 2.0 - 1.0;
  // Depth from paint order (see depth.ts); instance id == slot.
  float depth = max(0.0, 1.0 - float(gl_InstanceID + 1) * DEPTH_STEP);
  gl_Position = vec4(clip.x, -clip.y, depth * 2.0 - 1.0, 1.0);

  v_local = local;
  v_half = halfSize;
  v_params = a_params;
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_strokeStyle = a_strokeStyle;
}
`;

export const SHAPE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_local;
flat in vec2 v_half;
flat in vec4 v_params;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in float v_strokeStyle;

uniform vec3 u_camera;
uniform float u_depthOnly; // 1: depth pass (color writes are masked off)

out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Cheap ellipse distance approximation, exact on the axes and good enough for AA.
float sdEllipse(vec2 p, vec2 b) {
  float k1 = length(p / (b * b));
  if (k1 < 1e-6) return -min(b.x, b.y);
  float k0 = length(p / b);
  return k0 * (k0 - 1.0) / k1;
}

// Regular polygon stretched to the box, corners rounded by r: the polygon shrunk by r,
// then grown back by r. Mirrors core/src/elements/shape-geometry.ts (polygonVertices,
// maxCornerRadius, roundedPolygonSdf) so hit testing matches the pixels.
const int MAX_SIDES = 12;
const float RADIUS_CAP = 0.999;

// Vertices of the regular polygon with n corners stretched to the box (first one at the top).
void polygonVertices(vec2 halfSize, int n, out vec2 v[MAX_SIDES]) {
  vec2 lo = vec2(1e9);
  vec2 hi = vec2(-1e9);
  for (int i = 0; i < MAX_SIDES; i++) {
    v[i] = vec2(0.0);
    if (i >= n) continue;
    float a = 6.283185307179586 * float(i) / float(n);
    v[i] = vec2(sin(a), -cos(a));
    lo = min(lo, v[i]);
    hi = max(hi, v[i]);
  }
  vec2 scale = 2.0 * halfSize / (hi - lo);
  vec2 mid = (lo + hi) * 0.5;
  for (int i = 0; i < MAX_SIDES; i++) {
    if (i >= n) break;
    v[i] = (v[i] - mid) * scale;
  }
}

float sdRoundPolygon(vec2 p, vec2 halfSize, int n, float r) {
  vec2 v[MAX_SIDES];
  vec2 nrm[MAX_SIDES];
  float cut[MAX_SIDES];
  polygonVertices(halfSize, n, v);
  for (int i = 0; i < MAX_SIDES; i++) {
    if (i >= n) break;
    vec2 e = v[(i + 1) % n] - v[i];
    nrm[i] = normalize(vec2(e.y, -e.x)); // outward: vertices run clockwise on screen
  }
  for (int i = 0; i < MAX_SIDES; i++) {
    if (i >= n) break;
    vec2 a = nrm[(i + n - 1) % n];
    vec2 b = nrm[i];
    cut[i] = abs(a.x * b.y - a.y * b.x) / (1.0 + dot(a, b));
  }
  float rmax = 1e9;
  for (int i = 0; i < MAX_SIDES; i++) {
    if (i >= n) break;
    int j = (i + 1) % n;
    rmax = min(rmax, length(v[j] - v[i]) / (cut[i] + cut[j]));
  }
  r = clamp(r, 0.0, rmax * RADIUS_CAP);
  if (r > 0.0) {
    for (int i = 0; i < MAX_SIDES; i++) {
      if (i >= n) break;
      vec2 a = nrm[(i + n - 1) % n];
      vec2 b = nrm[i];
      v[i] -= (a + b) * (r / (1.0 + dot(a, b)));
    }
  }
  // Exact polygon distance (Inigo Quilez).
  float d = dot(p - v[0], p - v[0]);
  float s = 1.0;
  for (int i = 0; i < MAX_SIDES; i++) {
    if (i >= n) break;
    int j = i == 0 ? n - 1 : i - 1;
    vec2 e = v[j] - v[i];
    vec2 w = p - v[i];
    float ee = dot(e, e);
    vec2 b = w - e * (ee > 0.0 ? clamp(dot(w, e) / ee, 0.0, 1.0) : 0.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= v[i].y, p.y < v[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d) - r;
}

// --- Dashed/dotted borders: a coordinate along the outline -----------------------------
// Each returns (position along the outline, length of the stretch it runs over). Boxes and
// ellipses are measured per quarter from the middle of the bottom side; mirrored into
// every quarter, a pattern that fits the quarter a whole number of times has no seams.

vec2 boxPerimeter(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p);
  vec2 c = b - r;            // center of the corner arc
  float arc = r * 1.5707963267948966;
  float s;
  if (q.x > c.x && q.y > c.y) s = c.x + r * atan(q.x - c.x, q.y - c.y);
  else if (q.x <= c.x && q.y <= c.y) s = b.x - q.x < b.y - q.y ? c.x + arc + (c.y - q.y) : q.x;
  else if (q.x <= c.x) s = q.x;
  else s = c.x + arc + (c.y - q.y);
  return vec2(s, c.x + arc + c.y);
}

vec2 ellipsePerimeter(vec2 p, vec2 b) {
  vec2 q = abs(p);
  float phi = atan(q.x / max(b.x, 1e-6), q.y / max(b.y, 1e-6)); // eccentric angle from the bottom
  // Ramanujan's perimeter, a quarter of it; the angle maps to it linearly (close enough).
  float quarter = 0.7853981633974483 * (3.0 * (b.x + b.y) - sqrt((3.0 * b.x + b.y) * (b.x + 3.0 * b.y)));
  return vec2(quarter * phi / 1.5707963267948966, quarter);
}

vec2 polygonPerimeter(vec2 p, vec2 halfSize, int n) {
  vec2 v[MAX_SIDES];
  polygonVertices(halfSize, n, v);
  float total = 0.0;
  float best = 1e20;
  float s = 0.0;
  for (int i = 0; i < MAX_SIDES; i++) {
    if (i >= n) break;
    vec2 e = v[(i + 1) % n] - v[i];
    float l = length(e);
    float t = clamp(dot(p - v[i], e) / max(l * l, 1e-12), 0.0, 1.0);
    float dist = length(p - v[i] - e * t);
    if (dist < best) {
      best = dist;
      s = total + t * l;
    }
    total += l;
  }
  return vec2(s, total);
}

vec4 premul(vec4 c) { return vec4(c.rgb * c.a, c.a); }

void main() {
  float kind = v_params.w;
  float px = 1.0 / u_camera.z;
  // kind: 0 rect, 1 ellipse, 2 sticky, 10 + n polygon with n corners.
  float d = kind == 1.0
    ? sdEllipse(v_local, v_half)
    : kind >= 10.0
      ? sdRoundPolygon(v_local, v_half, int(kind + 0.5) - 10, v_params.y)
      : sdRoundBox(v_local, v_half, v_params.y);

  // Stroke is centered on the outline, same as hit testing.
  float halfStroke = v_params.z * 0.5;
  float outer = clamp(0.5 - (d - halfStroke) / px, 0.0, 1.0);
  float inner = clamp(0.5 - (d + halfStroke) / px, 0.0, 1.0);
  vec4 color = premul(v_fill) * inner + premul(v_stroke) * (outer - inner);

  if (v_strokeStyle > 0.5 && halfStroke > 0.0) {
    // Dashed (dash 4w, gap 3w) or dotted (round dots of the stroke width, gap w), like Miro.
    // The period is stretched so a whole number of dashes fits the stretch.
    vec2 sl = kind == 1.0
      ? ellipsePerimeter(v_local, v_half)
      : kind >= 10.0
        ? polygonPerimeter(v_local, v_half, int(kind + 0.5) - 10)
        : boxPerimeter(v_local, v_half, v_params.y);
    float w = max(v_params.z, px);
    bool dotted = v_strokeStyle > 1.5;
    float period = dotted ? 2.0 * w : 7.0 * w;
    period = sl.y / max(1.0, floor(sl.y / period + 0.5));
    float u = mod(sl.x + period * 0.5, period) - period * 0.5; // from the nearest dash center
    float strokeCov = dotted
      ? clamp(0.5 - (length(vec2(u, d)) - w * 0.5) / px, 0.0, 1.0)
      : (outer - inner) * clamp(0.5 - (abs(u) - period * (2.0 / 7.0)) / px, 0.0, 1.0);
    // In the gaps the fill reaches the outline, as with no border at all.
    vec4 fill = premul(v_fill) * clamp(0.5 - d / px, 0.0, 1.0);
    vec4 stroke = premul(v_stroke) * strokeCov;
    color = stroke + fill * (1.0 - stroke.a);
  }

  if (kind == 2.0) {
    // Shadow of a sticky as in Miro: paper lifting at its lower edge. A box a bit narrower
    // than the note, shifted down, blurred, and fading in from top to bottom, so it shows
    // under the lower edge and hardly at the sides.
    float lift = smoothstep(-v_half.y * 0.3, v_half.y, v_local.y);
    float sd = sdRoundBox(v_local - vec2(0.0, 8.0), v_half - vec2(6.0, 4.0), 6.0);
    float shadow = 0.24 * lift * (1.0 - smoothstep(-12.0, 12.0, sd));
    color = color + vec4(0.0, 0.0, 0.0, shadow) * (1.0 - color.a);
  }

  if (u_depthOnly > 0.5) {
    // Depth pass: only mostly-opaque pixels occlude what is below (lines, media, text of
    // lower elements). Translucent pixels — AA fringe, sticky shadow, translucent fills —
    // are discarded, so they keep the depth of an opaque shape under them instead of
    // erasing it.
    if (color.a <= 0.5) discard;
    outColor = vec4(0.0);
    return;
  }
  if (color.a <= 0.0) discard;
  outColor = color;
}
`;

/** Full-screen grid behind the content: dots at the crossings or thin lines. */
export const GRID_VERTEX = /* glsl */ `#version 300 es
const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0); }
`;

export const GRID_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_camera;        // x, y, zoom
uniform float u_dpr;
uniform float u_heightPx;     // drawing buffer height
uniform float u_spacing;      // world units between dots
uniform float u_fade;         // 0..1, fades a level in while zooming
uniform vec4 u_dotColor;
uniform float u_lines;        // 1: lines, 0: dots
out vec4 outColor;

void main() {
  vec2 css = vec2(gl_FragCoord.x, u_heightPx - gl_FragCoord.y) / u_dpr;
  vec2 world = u_camera.xy + css / u_camera.z;
  vec2 cell = (fract(world / u_spacing + 0.5) - 0.5) * u_spacing * u_camera.z; // CSS px to nearest dot
  // Lines are one device pixel wide (antialiased); dots have a ~1.6 CSS px radius.
  float coverage = u_lines > 0.5
    ? clamp(1.0 - (min(abs(cell.x), abs(cell.y)) * u_dpr - 0.5), 0.0, 1.0)
    : clamp(1.6 - length(cell), 0.0, 1.0);
  float a = coverage * u_fade * u_dotColor.a;
  if (a <= 0.0) discard;
  outColor = vec4(u_dotColor.rgb * a, a);
}
`;

/**
 * All visible text in one draw call: SDF glyphs, color glyphs (emoji) and solid
 * quads (underline, strike-through, greeking bars), selected per instance.
 */
export const TEXT_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_anchorOffset; // anchor.xy (element center), offset.xy
layout(location = 2) in vec4 a_sizeRotDepth; // w, h, rotation, depth
layout(location = 3) in vec4 a_uv;           // u0, v0, u1, v1
layout(location = 4) in float a_mode;        // 0 sdf, 1 color, 2 solid
layout(location = 5) in vec4 a_color;

uniform vec3 u_camera;
uniform vec2 u_viewport;

out vec2 v_uv;
flat out float v_mode;
flat out vec4 v_color;

void main() {
  vec2 size = a_sizeRotDepth.xy;
  vec2 offset = a_anchorOffset.zw;
  if (a_mode > 1.5) {
    // Keep thin solid quads (underlines, far-away bars) at least ~1px tall so they don't shimmer.
    float minH = 1.0 / u_camera.z;
    if (size.y < minH) {
      offset.y -= (minH - size.y) * 0.5;
      size.y = minH;
    }
  }
  vec2 local = offset + a_corner * size;
  float c = cos(a_sizeRotDepth.z);
  float s = sin(a_sizeRotDepth.z);
  vec2 world = a_anchorOffset.xy + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 clip = (world - u_camera.xy) * u_camera.z / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, a_sizeRotDepth.w * 2.0 - 1.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_mode = a_mode;
  v_color = a_color;
}
`;

export const TEXT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
#define TEXT_THINNING ${TEXT_THINNING.toFixed(2)}
#define TEXT_MAX_SAMPLES ${TEXT_MAX_SAMPLES}
in vec2 v_uv;
flat in float v_mode;
flat in vec4 v_color;
uniform sampler2D u_sdf;
uniform sampler2D u_colorAtlas;
uniform float u_edge;   // SDF value at the glyph outline (1 - cutoff)
out vec4 outColor;

void main() {
  if (v_mode > 1.5) {
    outColor = vec4(v_color.rgb * v_color.a, v_color.a);
    return;
  }
  // Four samples per pixel on a rotated grid: a box filter over the pixel. With one sample,
  // glyphs drawn smaller than their raster (zoomed out) alias into blotchy, uneven strokes.
  vec2 dx = dFdx(v_uv);
  vec2 dy = dFdy(v_uv);
  vec2 o1 = 0.125 * dx + 0.375 * dy;
  vec2 o2 = 0.375 * dx - 0.125 * dy;
  if (v_mode > 0.5) {
    // Premultiplied RGBA bitmap; text color alpha acts as opacity. Filtered only when
    // shrunk: averaging a magnified bitmap would just blur it.
    bool shrunk = max(length(dx), length(dy)) * float(textureSize(u_colorAtlas, 0).x) > 1.0;
    vec4 t = shrunk
      ? 0.25 * (texture(u_colorAtlas, v_uv + o1) + texture(u_colorAtlas, v_uv - o1) +
                texture(u_colorAtlas, v_uv + o2) + texture(u_colorAtlas, v_uv - o2))
      : texture(u_colorAtlas, v_uv);
    t *= v_color.a;
    if (t.a <= 0.0) discard;
    outColor = t;
    return;
  }
  float d = texture(u_sdf, v_uv).r;
  // SDF units per screen pixel across the outline: the gradient's length. fwidth (|dx|+|dy|)
  // is up to 1.4x that on slanted and curved edges, which spread over more than a pixel.
  float fw = length(vec2(dFdx(d), dFdy(d)));
  // The outline moves inwards by TEXT_THINNING of a pixel (see there): otherwise glyphs come
  // out heavier than the browser's and look smudged.
  float edge = u_edge + TEXT_THINNING * fw;
  // Drawn at about its raster size or bigger: one sample with an edge one pixel wide, as
  // crisp as the browser's own text.
  float w1 = max(fw * 0.5, 1e-4);
  float crisp = smoothstep(edge - w1, edge + w1, d);
  // Atlas texels per screen pixel.
  float shrink = max(length(dx), length(dy)) * float(textureSize(u_sdf, 0).x);
  // Shrunk (zoomed out): a box filter over the pixel, n x n samples on a grid. One sample
  // aliases into blotchy, uneven strokes; a fixed few are not enough either: zoomed far out,
  // a pixel covers several atlas texels and thin strokes fall between the samples, so the
  // text flickers and seems to jump from frame to frame. About one sample per two texels
  // keeps every stroke in; each covers 1/n of the pixel, so its own edge is that much
  // narrower. Small text covers few pixels: the extra samples cost little.
  int n = int(clamp(ceil(shrink), 2.0, float(TEXT_MAX_SAMPLES)));
  float cell = 1.0 / float(n);
  float wn = max(fw * 0.7 * cell, 1e-4);
  float lo = edge - wn;
  float hi = edge + wn;
  float filtered = 0.0;
  for (int i = 0; i < TEXT_MAX_SAMPLES; i++) {
    if (i >= n) break;
    for (int j = 0; j < TEXT_MAX_SAMPLES; j++) {
      if (j >= n) break;
      vec2 offset = ((float(i) + 0.5) * cell - 0.5) * dx + ((float(j) + 0.5) * cell - 0.5) * dy;
      // Explicit level: implicit derivatives are undefined inside this non-uniform loop.
      filtered += smoothstep(lo, hi, textureLod(u_sdf, v_uv + offset, 0.0).r);
    }
  }
  filtered *= cell * cell;
  // Blended, so zooming never pops between the two.
  float a = mix(crisp, filtered, smoothstep(1.5, 2.5, shrink)) * v_color.a;
  if (a <= 0.0) discard;
  outColor = vec4(v_color.rgb * a, a);
}
`;

/**
 * Connector segments and caps. Segments are capsules (round ends give round joins);
 * dashes are computed per pixel from the distance along the whole polyline, so the
 * pattern continues across bends. Caps are SDF shapes behind the line's tip.
 */
export const LINE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_points;   // x0, y0, x1, y1
layout(location = 2) in vec4 a_params;   // halfWidth, mode, dash, gap
layout(location = 3) in vec4 a_extra;    // dashOffset, depth, capSize, joins (see line-layer.ts)
layout(location = 4) in vec4 a_color;

uniform vec3 u_camera;
uniform vec2 u_viewport;

out vec2 v_local;          // (along, across) in world units
flat out vec4 v_params;    // halfWidth (effective), mode, dash, gap
flat out vec3 v_extra;     // dashOffset, length, capSize (arcs: dashOffset, radius, sweep)
flat out vec4 v_color;
flat out float v_arcStart; // arcs: start angle
flat out vec4 v_join;      // normals of the lines splitting the start and end joints; 0: free end

// One end of the packed joins: 0, or the flag (2048) + the split line's angle in 11 bits.
vec2 joinNormal(int bits) {
  if (bits < 2048) return vec2(0.0);
  float a = (float(bits - 2048) / 2047.0 * 2.0 - 1.0) * 1.5707963267948966;
  return vec2(cos(a), sin(a));
}

void main() {
  int joins = int(a_extra.w + 0.5);
  v_join = vec4(joinNormal(joins & 4095), joinNormal(joins >> 12));
  float mode = a_params.y;
  if (mode < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float px = 1.0 / u_camera.z;
  vec2 p0 = a_points.xy;
  vec2 d = a_points.zw - p0;
  float len = length(d);
  vec2 t = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);

  // Lines thinner than a pixel stay one pixel wide but fade, so far-away lines keep their weight.
  float hw = a_params.x;
  float minHw = 0.5 * px;
  float fade = hw < minHw ? hw / minHw : 1.0;
  hw = max(hw, minHw);

  float pad = hw + 1.5 * px;
  v_arcStart = 0.0;
  if (mode > 4.5) {
    // Rounded bend: a quad over the arc's bounding box (its ends, plus the axis extremes
    // it passes through), padded for the stroke.
    vec2 c = a_points.xy;
    float r = a_points.z;
    float a0 = a_points.w;
    float sweep = a_extra.z;
    vec2 e0 = c + r * vec2(cos(a0), sin(a0));
    vec2 e1 = c + r * vec2(cos(a0 + sweep), sin(a0 + sweep));
    vec2 lo = min(e0, e1);
    vec2 hi = max(e0, e1);
    float turn = sweep < 0.0 ? -1.0 : 1.0;
    for (int k = 0; k < 4; k++) {
      float ang = float(k) * 1.5707963267948966;
      if (mod((ang - a0) * turn, 6.283185307179586) <= abs(sweep)) {
        vec2 q = c + r * vec2(cos(ang), sin(ang));
        lo = min(lo, q);
        hi = max(hi, q);
      }
    }
    vec2 world = mix(lo - pad, hi + pad, a_corner);
    vec2 clip = (world - u_camera.xy) * u_camera.z / u_viewport * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, a_extra.y * 2.0 - 1.0, 1.0);
    v_local = world - c;
    v_params = vec4(hw, mode, a_params.z, a_params.w);
    v_extra = vec3(a_extra.x, r, sweep);
    v_arcStart = a0;
    v_color = vec4(a_color.rgb, a_color.a * fade);
    return;
  }
  float size = a_extra.z;
  vec2 u = mode < 0.5 ? vec2(-pad, len + pad) : vec2(-pad, size + pad);
  float across = mode < 0.5 ? pad : size * 0.5 + pad;
  float along = mix(u.x, u.y, a_corner.x);
  float side = mix(-across, across, a_corner.y);

  vec2 world = p0 + t * along + n * side;
  vec2 clip = (world - u_camera.xy) * u_camera.z / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, a_extra.y * 2.0 - 1.0, 1.0);

  v_local = vec2(along, side);
  v_params = vec4(hw, mode, a_params.z, a_params.w);
  v_extra = vec3(a_extra.x, len, size);
  v_color = vec4(a_color.rgb, a_color.a * fade);
}
`;

export const LINE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
flat in vec4 v_params;
flat in vec3 v_extra;
flat in vec4 v_color;
flat in float v_arcStart;
flat in vec4 v_join;
uniform vec3 u_camera;
uniform float u_depthOnly; // 1: depth pass, drawn first (color writes are masked off)
out vec4 outColor;

// A joint belongs to one of its two pieces at each pixel (line-layer.ts): a piece draws from
// the split line at its start, and up to a hundredth of a pixel past the one at its end. That
// sliver, drawn by both, means float noise can't leave a pixel to neither of them.
// The split angles are quantized (line-layer.ts), so two neighbours' split lines differ by up
// to JOIN_SLACK radians: a gap that widens away from the centre line. Each piece reaches that
// far past its split ("across": distance from the centre line), so no pixel is left out.
const float JOIN_SLACK = 0.002;
bool outsideJoints(float fromStart, float pastEnd, float across, float px) {
  float slack = across * JOIN_SLACK;
  return (v_join.xy != vec2(0.0) && fromStart < -slack) ||
         (v_join.zw != vec2(0.0) && pastEnd > 0.01 * px + slack);
}

// How far a point at arc length u (plus the connector's dash offset) is from a dash; 0 inside one.
float toDash(float u, float offset, float dash, float gap) {
  if (gap <= 0.0) return 0.0;
  float period = dash + gap;
  float t = mod(u + offset, period);
  return t <= dash ? 0.0 : min(t - dash, period - t);
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Inigo Quilez, isosceles triangle with the apex at the origin and the base at y = q.y.
float sdTriangleIsosceles(vec2 p, vec2 q) {
  p.x = abs(p.x);
  vec2 a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
  vec2 b = p - q * vec2(clamp(p.x / q.x, 0.0, 1.0), 1.0);
  float s = -sign(q.y);
  vec2 d = min(vec2(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2(dot(b, b), s * (p.y - q.y)));
  return -sqrt(d.x) * sign(d.y);
}

float ndot(vec2 a, vec2 b) { return a.x * b.x - a.y * b.y; }

// Inigo Quilez, rhombus centered at the origin with half-diagonals b.
float sdRhombus(vec2 p, vec2 b) {
  p = abs(p);
  float h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
  float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}

void main() {
  float px = 1.0 / u_camera.z;
  float hw = v_params.x;
  float mode = v_params.y;
  float u = v_local.x;
  float v = v_local.y;
  float size = v_extra.z;
  float d;

  if (mode > 4.5) {
    // Rounded bend, drawn exactly: distance to the circle across, arc length along it.
    // Past its ends (the first half of the missing angle after the end, the rest before
    // the start) it gets round caps, like a segment, where no other piece continues it.
    float r = v_extra.y;
    float span = abs(v_extra.z);
    float turn = v_extra.z < 0.0 ? -1.0 : 1.0;
    float tau = 6.283185307179586;
    float rel = mod((atan(v, u) - v_arcStart) * turn, tau); // here (u, v) = point - center
    float along = (rel <= span + (tau - span) * 0.5 ? rel : rel - tau) * r;
    // Joined ends split along the radius: the neighbouring segments are tangent there.
    if (outsideJoints(along, along - span * r, abs(length(vec2(u, v)) - r), px)) discard;
    float off = abs(along - clamp(along, 0.0, span * r));
    off = max(off, toDash(along, v_extra.x, v_params.z, v_params.w));
    d = length(vec2(off, length(vec2(u, v)) - r)) - hw;
  } else if (mode < 0.5) {
    float len = v_extra.y;
    if (outsideJoints(dot(vec2(u, v), v_join.xy), dot(vec2(u - len, v), v_join.zw), abs(v), px)) discard;
    float off = abs(u - clamp(u, 0.0, len)); // past the segment ends: round caps
    off = max(off, toDash(u, v_extra.x, v_params.z, v_params.w));
    d = length(vec2(off, v)) - hw;
  } else if (mode < 1.5) {
    // Open arrow: two strokes from the tip.
    vec2 p = vec2(u, abs(v));
    d = sdSegment(p, vec2(0.0), vec2(size, size * 0.5)) - hw;
  } else if (mode < 2.5) {
    d = sdTriangleIsosceles(vec2(v, u), vec2(size * 0.5, size));
  } else if (mode < 3.5) {
    d = length(vec2(u - size * 0.5, v)) - size * 0.5;
  } else {
    d = sdRhombus(vec2(u - size * 0.5, v), vec2(size * 0.5, size * 0.35));
  }

  float a = clamp(0.5 - d / px, 0.0, 1.0) * v_color.a;
  if (u_depthOnly > 0.5) {
    // Only fully opaque pixels hide the lines below. An antialiased edge must not, or a
    // line under it would be cut away there and the half-transparent edge would show the
    // background: a light seam where lines cross.
    if (a < 0.99) discard;
    outColor = vec4(0.0);
    return;
  }
  if (a <= 0.01) discard;
  outColor = vec4(v_color.rgb * a, a);
}
`;

/**
 * Images and audio players: one textured quad per element, rounded corners with an
 * analytic AA edge, depth from the element's slot. Mode 1 draws a loading placeholder.
 */
export const MEDIA_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec3 u_camera;
uniform vec2 u_viewport;
uniform vec4 u_rect;      // x, y, w, h (world, unrotated box)
uniform float u_rotation;
uniform float u_depth;
out vec2 v_local;
out vec2 v_uv;

void main() {
  vec2 halfSize = u_rect.zw * 0.5;
  float px = 1.0 / u_camera.z;
  vec2 local = (a_corner * 2.0 - 1.0) * (halfSize + px);
  float c = cos(u_rotation);
  float s = sin(u_rotation);
  vec2 world = u_rect.xy + halfSize + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 clip = (world - u_camera.xy) * u_camera.z / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, u_depth * 2.0 - 1.0, 1.0);
  v_local = local;
  v_uv = (local + halfSize) / u_rect.zw;
}
`;

export const MEDIA_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_uv;
uniform vec3 u_camera;
uniform vec4 u_rect;
uniform float u_radius;
uniform float u_mode;     // 0: texture, 1: placeholder
uniform vec4 u_uv;        // image (u, v) at the box's top-left, and the (du, dv) it spans
uniform sampler2D u_tex;
out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float px = 1.0 / u_camera.z;
  vec2 halfSize = u_rect.zw * 0.5;
  float d = sdRoundBox(v_local, halfSize, u_radius);
  float cover = clamp(0.5 - d / px, 0.0, 1.0);
  vec4 color;
  if (u_mode > 0.5) {
    // Loading placeholder: light fill with a soft border.
    float border = clamp(0.5 - (d + px * 1.5) / px, 0.0, 1.0);
    color = mix(vec4(0.82, 0.84, 0.87, 1.0), vec4(0.93, 0.94, 0.95, 1.0), border);
  } else {
    // Fill / fit / crop: where the box samples the image. Outside the image (fit's
    // letterbox) nothing is drawn, with an anti-aliased edge.
    vec2 tc = u_uv.xy + clamp(v_uv, 0.0, 1.0) * u_uv.zw;
    vec2 perWorld = u_uv.zw / u_rect.zw;               // texture units per world unit
    vec2 outside = max(-tc, tc - 1.0) / perWorld;      // world units past the image edge
    float inImage = clamp(0.5 - max(outside.x, outside.y) / px, 0.0, 1.0);
    color = texture(u_tex, clamp(tc, 0.0, 1.0)) * inImage; // premultiplied
  }
  color *= cover;
  if (color.a <= 0.01) discard;
  outColor = color;
}
`;
