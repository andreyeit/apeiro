import type { BackendContext, FrameParams, RenderBackend } from '../backend';
import { byteRuns } from '../layers/buffer-upload';
import { INSTANCE_STRIDE, SHAPE_LAYOUT } from '../layers/instance-store';
import { GlMedia } from './gl-media';
import { bindInstanceAttributes, compileProgram, createUnitQuad, uniforms } from './gl-utils';
import { LinePass } from './line-pass';
import { GRID_FRAGMENT, GRID_VERTEX, SHAPE_FRAGMENT, SHAPE_VERTEX } from './shaders';
import { TextPass } from './text-pass';

interface Resources {
  shapeProgram: WebGLProgram;
  shapeVao: WebGLVertexArrayObject;
  quadBuffer: WebGLBuffer;
  instanceBuffer: WebGLBuffer;
  instanceCapacity: number;
  shapeUniforms: Record<'u_camera' | 'u_viewport' | 'u_depthOnly', WebGLUniformLocation | null>;
  gridProgram: WebGLProgram;
  gridVao: WebGLVertexArrayObject;
  gridUniforms: Record<
    'u_camera' | 'u_dpr' | 'u_heightPx' | 'u_spacing' | 'u_fade' | 'u_dotColor' | 'u_lines',
    WebGLUniformLocation | null
  >;
}

/** The WebGL2 backend. Throws when WebGL2 is not available. */
export function createWebGlBackend(context: BackendContext): RenderBackend {
  return new WebGlBackend(context);
}

class WebGlBackend implements RenderBackend {
  readonly kind = 'webgl';
  private readonly gl: WebGL2RenderingContext;
  private resources: Resources | null = null;
  private readonly textPass: TextPass;
  private readonly linePass: LinePass;
  private readonly media: GlMedia;
  private uploadedBytes = 0;
  private disposers: Array<() => void> = [];

  constructor(private readonly context: BackendContext) {
    const gl = context.canvas.getContext('webgl2', {
      antialias: false, // shapes are antialiased analytically in the shader
      alpha: context.transparent,
      depth: true, // keeps text behind shapes that are above its element
      premultipliedAlpha: true,
      preserveDrawingBuffer: context.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not supported');
    this.gl = gl;
    this.textPass = new TextPass(
      gl,
      context.sdfAtlas,
      context.colorAtlas,
      context.textLayer,
      context.sdfEdge,
    );
    this.linePass = new LinePass(gl, context.lineLayer);
    this.media = new GlMedia(gl);
    this.initialize();

    const lost = (event: Event) => {
      event.preventDefault(); // allows the browser to restore the context
      this.resources = null;
      this.textPass.lose();
      this.linePass.lose();
      this.media.lose();
      context.onLost();
    };
    const restored = () => {
      this.initialize();
      context.onRestored();
    };
    context.canvas.addEventListener('webglcontextlost', lost);
    context.canvas.addEventListener('webglcontextrestored', restored);
    this.disposers.push(
      () => context.canvas.removeEventListener('webglcontextlost', lost),
      () => context.canvas.removeEventListener('webglcontextrestored', restored),
    );
  }

  get ready(): boolean {
    return this.resources !== null;
  }

  get textures(): GlMedia {
    return this.media;
  }

  takeUploadedBytes(): number {
    const total = this.uploadedBytes + this.linePass.uploadedBytes + this.textPass.uploadedBytes;
    this.uploadedBytes = this.linePass.uploadedBytes = this.textPass.uploadedBytes = 0;
    return total;
  }

  render(frame: FrameParams): void {
    const resources = this.resources;
    if (!resources) return;
    const gl = this.gl;
    const store = this.context.store;
    this.uploadShapes(resources);

    gl.viewport(0, 0, this.context.canvas.width, this.context.canvas.height);
    const [red, green, blue, alpha] = frame.background;
    // Premultiplied, like everything drawn over it.
    if (this.context.transparent) gl.clearColor(red * alpha, green * alpha, blue * alpha, alpha);
    else gl.clearColor(red, green, blue, 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.disable(gl.DEPTH_TEST);
    if (frame.grid) this.drawGrid(resources, frame, frame.grid);

    // Shapes: painter's order from the buffer, in two passes. Color first, without
    // touching depth; then depth only, for mostly-opaque pixels. A translucent pixel of
    // a higher shape thus never erases the depth of an opaque shape below it, which
    // would let lines/text hidden by that shape show through.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    if (store.count > 0) {
      gl.useProgram(resources.shapeProgram);
      gl.uniform3f(resources.shapeUniforms.u_camera, frame.x, frame.y, frame.zoom);
      gl.uniform2f(resources.shapeUniforms.u_viewport, frame.viewportWidth, frame.viewportHeight);
      gl.bindVertexArray(resources.shapeVao);
      gl.depthMask(false);
      gl.uniform1f(resources.shapeUniforms.u_depthOnly, 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, store.count);
      gl.depthMask(true);
      gl.colorMask(false, false, false, false);
      gl.uniform1f(resources.shapeUniforms.u_depthOnly, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, store.count);
      gl.colorMask(true, true, true, true);
      gl.bindVertexArray(null);
    }

    // Images and audio players: same depth rules as shapes, drawn on top of the shape pass.
    gl.depthFunc(gl.LEQUAL);
    this.media.draw(
      frame.media,
      frame.x,
      frame.y,
      frame.zoom,
      frame.viewportWidth,
      frame.viewportHeight,
    );

    // Connectors: hidden under shapes above them, drawn over shapes below. LEQUAL lets
    // segments of the same connector overlap at joints without seams. Depth of their opaque
    // pixels first, then color (see LinePass): lines cross without seams too.
    gl.depthFunc(gl.LEQUAL);
    this.linePass.draw(frame.x, frame.y, frame.zoom, frame.viewportWidth, frame.viewportHeight);

    // Text: hidden wherever a shape or connector above its element was drawn.
    if (frame.drawText) {
      gl.depthFunc(gl.LESS);
      gl.depthMask(false);
      this.textPass.draw(frame.x, frame.y, frame.zoom, frame.viewportWidth, frame.viewportHeight);
      gl.depthMask(true);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    const resources = this.resources;
    this.resources = null; // not ready: a late requestRender must not draw with deleted objects
    if (resources) {
      const gl = this.gl;
      gl.deleteBuffer(resources.instanceBuffer);
      gl.deleteBuffer(resources.quadBuffer);
      gl.deleteVertexArray(resources.shapeVao);
      gl.deleteVertexArray(resources.gridVao);
      gl.deleteProgram(resources.shapeProgram);
      gl.deleteProgram(resources.gridProgram);
    }
    this.textPass.dispose();
    this.linePass.dispose();
    this.media.dispose();
    this.resources = null;
  }

  /** (Re)creates every GL object and marks all CPU data for upload. */
  private initialize(): void {
    this.resources = this.createResources();
    this.textPass.initialize();
    this.linePass.initialize();
    this.media.initialize();
    this.context.store.markFull();
  }

  private uploadShapes(resources: Resources): void {
    const store = this.context.store;
    const dirty = store.takeDirty();
    if (dirty.kind === 'none') return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.instanceBuffer);
    const data = store.data;

    if (dirty.kind === 'all' || store.capacity !== resources.instanceCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      resources.instanceCapacity = store.capacity;
      this.uploadedBytes += data.byteLength;
    } else {
      const bytes = new Uint8Array(data);
      for (const [offset, length] of byteRuns(dirty, false, store.count, INSTANCE_STRIDE)) {
        gl.bufferSubData(gl.ARRAY_BUFFER, offset, bytes, offset, length);
        this.uploadedBytes += length;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private drawGrid(
    resources: Resources,
    frame: FrameParams,
    grid: NonNullable<FrameParams['grid']>,
  ): void {
    const gl = this.gl;
    gl.useProgram(resources.gridProgram);
    gl.bindVertexArray(resources.gridVao);
    gl.uniform3f(resources.gridUniforms.u_camera, frame.x, frame.y, frame.zoom);
    gl.uniform1f(resources.gridUniforms.u_dpr, frame.pixelRatio);
    gl.uniform1f(resources.gridUniforms.u_heightPx, this.context.canvas.height);
    gl.uniform4f(resources.gridUniforms.u_dotColor, ...grid.color);
    gl.uniform1f(resources.gridUniforms.u_lines, grid.lines ? 1 : 0);
    for (const { spacing, fade } of grid.levels) {
      gl.uniform1f(resources.gridUniforms.u_spacing, spacing);
      gl.uniform1f(resources.gridUniforms.u_fade, fade);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindVertexArray(null);
  }

  private createResources(): Resources {
    const gl = this.gl;
    const shapeProgram = compileProgram(gl, SHAPE_VERTEX, SHAPE_FRAGMENT);
    const gridProgram = compileProgram(gl, GRID_VERTEX, GRID_FRAGMENT);

    const shapeVao = gl.createVertexArray()!;
    gl.bindVertexArray(shapeVao);

    const quad = createUnitQuad(gl);
    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    bindInstanceAttributes(gl, SHAPE_LAYOUT);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const gridVao = gl.createVertexArray()!;

    return {
      shapeProgram,
      shapeVao,
      quadBuffer: quad,
      instanceBuffer,
      instanceCapacity: -1, // forces the first upload to allocate
      shapeUniforms: uniforms(gl, shapeProgram, ['u_camera', 'u_viewport', 'u_depthOnly'] as const),
      gridProgram,
      gridVao,
      gridUniforms: uniforms(gl, gridProgram, [
        'u_camera',
        'u_dpr',
        'u_heightPx',
        'u_spacing',
        'u_fade',
        'u_dotColor',
        'u_lines',
      ] as const),
    };
  }
}
