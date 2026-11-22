import type {
  BackendContext,
  BackendFactory,
  FrameParams,
  MediaSource,
  MediaTextures,
  RenderBackend,
  TextureHandle,
} from '../backend';
import { byteRuns, type BufferUpload } from '../layers/buffer-upload';
import type { InstanceLayout } from '../layers/instance-layout';
import { INSTANCE_STRIDE, SHAPE_LAYOUT } from '../layers/instance-store';
import { LINE_LAYOUT, LINE_STRIDE } from '../layers/line-layer';
import { GLYPH_LAYOUT, GLYPH_STRIDE } from '../layers/text-layer';
import type { GlyphAtlas } from '../text/glyph-atlas';
import { GRID_WGSL, LINE_WGSL, MEDIA_WGSL, MIPMAP_WGSL, SHAPE_WGSL, TEXT_WGSL } from './shaders';

// The usage flags of the WebGPU spec (TypeScript's DOM types don't declare the globals).
const BUFFER_COPY_DST = 0x8;
const BUFFER_VERTEX = 0x20;
const BUFFER_UNIFORM = 0x40;
const TEXTURE_COPY_DST = 0x2;
const TEXTURE_BINDING = 0x4;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const STAGE_VERTEX = 0x1;
const STAGE_FRAGMENT = 0x2;

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
const MEDIA_FORMAT: GPUTextureFormat = 'rgba8unorm';
/** Per-draw uniforms (grid levels, media quads) live at offsets of this alignment. */
const DRAW_UNIFORM_ALIGN = 256;
const FRAME_UNIFORM_BYTES = 32;

/** Premultiplied alpha, like the WebGL backend's blendFunc(ONE, ONE_MINUS_SRC_ALPHA). */
const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

/**
 * Asks for a WebGPU device and prepares everything that doesn't depend on the scene
 * (pipelines are compiled and validated here). Resolves to null when WebGPU isn't
 * available or anything fails: the caller then falls back to WebGL. The canvas is
 * only claimed for WebGPU once the device and pipelines are known to work.
 */
export async function requestWebGpuBackend(
  canvas: HTMLCanvasElement,
): Promise<BackendFactory | null> {
  try {
    const core = await createCore();
    if (!core) return null;
    const canvasContext = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!canvasContext) {
      core.device.destroy();
      return null;
    }
    return (context) => new WebGpuBackend(context, canvasContext, core);
  } catch (error) {
    console.warn('apeiro: WebGPU is unavailable, falling back to WebGL', error);
    return null;
  }
}

/** Device-level objects: they live as long as the device. */
interface Core {
  device: GPUDevice;
  format: GPUTextureFormat;
  frameLayout: GPUBindGroupLayout;
  drawLayout: GPUBindGroupLayout;
  textureLayout: GPUBindGroupLayout;
  textLayout: GPUBindGroupLayout;
  grid: GPURenderPipeline;
  shape: GPURenderPipeline;
  shapeDepth: GPURenderPipeline;
  media: GPURenderPipeline;
  line: GPURenderPipeline;
  lineDepth: GPURenderPipeline;
  text: GPURenderPipeline;
  mipmap: GPURenderPipeline;
  linearSampler: GPUSampler;
  mipSampler: GPUSampler;
}

async function createCore(): Promise<Core | null> {
  const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const format = gpu.getPreferredCanvasFormat();

  device.pushErrorScope('validation');
  device.pushErrorScope('internal');
  const modules = [SHAPE_WGSL, GRID_WGSL, TEXT_WGSL, LINE_WGSL, MEDIA_WGSL, MIPMAP_WGSL].map(
    (code) => device.createShaderModule({ code }),
  );
  const [shapeModule, gridModule, textModule, lineModule, mediaModule, mipModule] = modules as [
    GPUShaderModule,
    GPUShaderModule,
    GPUShaderModule,
    GPUShaderModule,
    GPUShaderModule,
    GPUShaderModule,
  ];

  const both = STAGE_VERTEX | STAGE_FRAGMENT;
  const frameLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: both, buffer: { type: 'uniform' } }],
  });
  const drawLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ],
  });
  const textureLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: STAGE_FRAGMENT, sampler: {} },
      { binding: 1, visibility: STAGE_FRAGMENT, texture: {} },
    ],
  });
  const textLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: STAGE_FRAGMENT, sampler: {} },
      { binding: 1, visibility: STAGE_FRAGMENT, texture: {} },
      { binding: 2, visibility: STAGE_FRAGMENT, texture: {} },
    ],
  });
  const layout = (...groups: GPUBindGroupLayout[]) =>
    device.createPipelineLayout({ bindGroupLayouts: groups });

  /** depthCompare/depthWrite as the WebGL backend sets them for that pass. */
  const pipeline = (
    module: GPUShaderModule,
    pipelineLayout: GPUPipelineLayout,
    depth: { compare: GPUCompareFunction; write: boolean },
    options: {
      buffers?: GPUVertexBufferLayout[];
      fragment?: string;
      colorWrites?: boolean;
      topology?: GPUPrimitiveTopology;
    } = {},
  ) =>
    device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs', buffers: options.buffers ?? [] },
      fragment: {
        module,
        entryPoint: options.fragment ?? 'fs',
        targets: [
          {
            format,
            blend: PREMULTIPLIED,
            writeMask: options.colorWrites === false ? 0 : 0xf,
          },
        ],
      },
      primitive: { topology: options.topology ?? 'triangle-strip' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: depth.compare,
        depthWriteEnabled: depth.write,
      },
    });

  const shapeBuffers = vertexBuffers(SHAPE_LAYOUT);
  const lineBuffers = vertexBuffers(LINE_LAYOUT);
  const textBuffers = vertexBuffers(GLYPH_LAYOUT);

  const frameOnly = layout(frameLayout);
  const core: Core = {
    device,
    format,
    frameLayout,
    drawLayout,
    textureLayout,
    textLayout,
    grid: pipeline(
      gridModule,
      layout(frameLayout, drawLayout),
      { compare: 'always', write: false },
      { topology: 'triangle-list' },
    ),
    shape: pipeline(
      shapeModule,
      frameOnly,
      { compare: 'always', write: false },
      { buffers: shapeBuffers },
    ),
    shapeDepth: pipeline(
      shapeModule,
      frameOnly,
      { compare: 'always', write: true },
      { buffers: shapeBuffers, fragment: 'fsDepth', colorWrites: false },
    ),
    media: pipeline(mediaModule, layout(frameLayout, drawLayout, textureLayout), {
      compare: 'less-equal',
      write: true,
    }),
    line: pipeline(
      lineModule,
      frameOnly,
      { compare: 'less-equal', write: false },
      { buffers: lineBuffers },
    ),
    lineDepth: pipeline(
      lineModule,
      frameOnly,
      { compare: 'less-equal', write: true },
      { buffers: lineBuffers, fragment: 'fsDepth', colorWrites: false },
    ),
    text: pipeline(
      textModule,
      layout(frameLayout, textLayout),
      { compare: 'less', write: false },
      { buffers: textBuffers },
    ),
    mipmap: device.createRenderPipeline({
      layout: layout(textureLayout),
      vertex: { module: mipModule, entryPoint: 'vs' },
      fragment: { module: mipModule, entryPoint: 'fs', targets: [{ format: MEDIA_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    }),
    linearSampler: device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
    mipSampler: device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
  };

  const internal = await device.popErrorScope();
  const validation = await device.popErrorScope();
  const error = validation ?? internal;
  if (error) {
    for (const module of modules) {
      const compilation = await module.getCompilationInfo();
      for (const message of compilation.messages)
        if (message.type === 'error') console.error('WGSL:', message.message);
    }
    device.destroy();
    throw new Error(`WebGPU pipeline setup failed: ${error.message}`);
  }
  return core;
}

/** The instance buffer of a CPU layer, as WebGPU reads it (shader locations 0, 1, …). */
function vertexBuffers(layout: InstanceLayout): GPUVertexBufferLayout[] {
  return [
    {
      arrayStride: layout.stride,
      stepMode: 'instance',
      attributes: layout.attributes.map((attribute, shaderLocation) => ({
        format: (attribute.components === 1
          ? attribute.format
          : `${attribute.format}x${attribute.components}`) as GPUVertexFormat,
        offset: attribute.offset,
        shaderLocation,
      })),
    },
  ];
}

/** A media texture of this backend. */
interface GpuTexture {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  width: number;
  height: number;
  mipmaps: boolean;
}

interface GrowableBuffer {
  buffer: GPUBuffer | null;
  bytes: number;
}

interface AtlasTexture {
  texture: GPUTexture;
  size: number;
}

/** Objects that belong to the current device; recreated after a device loss. */
interface State {
  core: Core;
  frameBuffer: GPUBuffer;
  frameGroup: GPUBindGroup;
  draw: GrowableBuffer;
  drawGroup: GPUBindGroup | null;
  shapes: GrowableBuffer;
  shapeCapacity: number;
  lines: GrowableBuffer;
  glyphs: GrowableBuffer;
  sdf: AtlasTexture;
  color: AtlasTexture;
  textGroup: GPUBindGroup | null;
  /** Bound for the loading placeholder, which samples nothing it uses. */
  emptyTexture: GpuTexture;
  depth: GPUTexture | null;
}

class WebGpuBackend implements RenderBackend, MediaTextures {
  readonly kind = 'webgpu';
  private state: State | null;
  private uploadedBytes = 0;
  private destroyed = false;
  private errorLogged = false;
  /** Reused every frame for the per-draw uniforms. */
  private drawStaging = new ArrayBuffer(DRAW_UNIFORM_ALIGN * 16);

  constructor(
    private readonly context: BackendContext,
    private readonly canvasContext: GPUCanvasContext,
    core: Core,
  ) {
    this.state = this.initialize(core);
  }

  get ready(): boolean {
    return this.state !== null;
  }

  get textures(): MediaTextures {
    return this;
  }

  get maxTextureSize(): number {
    return this.state?.core.device.limits.maxTextureDimension2D ?? 8192;
  }

  takeUploadedBytes(): number {
    const total = this.uploadedBytes;
    this.uploadedBytes = 0;
    return total;
  }

  render(frame: FrameParams): void {
    const state = this.state;
    if (!state) return;
    const { device } = state.core;
    const { store, lineLayer, textLayer } = this.context;

    this.uploadShapes(state);
    this.uploadedBytes += uploadInstances(
      device,
      state.lines,
      lineLayer.data,
      lineLayer.count,
      LINE_STRIDE,
      lineLayer.takeUpload(),
    );
    if (frame.drawText) {
      if (this.uploadAtlas(state, this.context.sdfAtlas, state.sdf, 'r8unorm'))
        state.textGroup = null;
      if (this.uploadAtlas(state, this.context.colorAtlas, state.color, 'rgba8unorm'))
        state.textGroup = null;
      this.uploadedBytes += uploadInstances(
        device,
        state.glyphs,
        textLayer.data,
        textLayer.count,
        GLYPH_STRIDE,
        textLayer.takeUpload(),
      );
    }

    const width = this.context.canvas.width;
    const height = this.context.canvas.height;
    if (!state.depth || state.depth.width !== width || state.depth.height !== height) {
      state.depth?.destroy();
      state.depth = device.createTexture({
        size: [width, height],
        format: DEPTH_FORMAT,
        usage: TEXTURE_RENDER_ATTACHMENT,
      });
    }

    device.queue.writeBuffer(
      state.frameBuffer,
      0,
      new Float32Array([
        frame.x,
        frame.y,
        frame.zoom,
        frame.pixelRatio,
        frame.viewportWidth,
        frame.viewportHeight,
        this.context.sdfEdge,
        0,
      ]),
    );
    const offsets = this.writeDrawUniforms(state, frame);

    const encoder = device.createCommandEncoder();
    const [red, green, blue, alpha] = frame.background;
    // Premultiplied, like everything drawn over it.
    const clearValue = this.context.transparent
      ? { r: red * alpha, g: green * alpha, b: blue * alpha, a: alpha }
      : { r: red, g: green, b: blue, a: 1 };
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.canvasContext.getCurrentTexture().createView(),
          clearValue,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: state.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setBindGroup(0, state.frameGroup);
    let next = 0;

    if (frame.grid && state.drawGroup) {
      pass.setPipeline(state.core.grid);
      for (let i = 0; i < frame.grid.levels.length; i++) {
        pass.setBindGroup(1, state.drawGroup, [offsets[next++]!]);
        pass.draw(3);
      }
    }

    // Shapes: color without depth writes, then depth only for mostly-opaque pixels (see
    // the WebGL backend for why).
    if (store.count > 0 && state.shapes.buffer) {
      pass.setVertexBuffer(0, state.shapes.buffer);
      pass.setPipeline(state.core.shape);
      pass.draw(4, store.count);
      pass.setPipeline(state.core.shapeDepth);
      pass.draw(4, store.count);
    }

    if (frame.media.length > 0 && state.drawGroup) {
      pass.setPipeline(state.core.media);
      for (const quad of frame.media) {
        pass.setBindGroup(1, state.drawGroup, [offsets[next++]!]);
        const texture = (quad.texture as GpuTexture | null) ?? state.emptyTexture;
        pass.setBindGroup(2, texture.bindGroup);
        pass.draw(4);
      }
    }

    // Lines: depth of their opaque pixels first, then color without depth writes (see the
    // WebGL backend for why).
    if (lineLayer.count > 0 && state.lines.buffer) {
      pass.setVertexBuffer(0, state.lines.buffer);
      pass.setPipeline(state.core.lineDepth);
      pass.draw(4, lineLayer.count);
      pass.setPipeline(state.core.line);
      pass.draw(4, lineLayer.count);
    }

    if (frame.drawText && textLayer.count > 0 && state.glyphs.buffer) {
      state.textGroup ??= device.createBindGroup({
        layout: state.core.textLayout,
        entries: [
          { binding: 0, resource: state.core.linearSampler },
          { binding: 1, resource: state.sdf.texture.createView() },
          { binding: 2, resource: state.color.texture.createView() },
        ],
      });
      pass.setPipeline(state.core.text);
      pass.setBindGroup(1, state.textGroup);
      pass.setVertexBuffer(0, state.glyphs.buffer);
      pass.draw(4, textLayer.count);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.destroyed = true;
    const state = this.state;
    this.state = null;
    if (!state) return;
    this.canvasContext.unconfigure();
    state.core.device.destroy(); // frees every buffer and texture of the device
  }

  // --- Media textures -------------------------------------------------------------

  upload(source: MediaSource, mipmaps: boolean, previous?: TextureHandle): TextureHandle {
    const state = this.state!;
    const { device } = state.core;
    const width = Math.max(1, source.width);
    const height = Math.max(1, source.height);
    let texture = previous as GpuTexture | undefined;
    if (
      texture &&
      (texture.width !== width || texture.height !== height || texture.mipmaps !== mipmaps)
    ) {
      this.release(texture);
      texture = undefined;
    }
    texture ??= this.createMediaTexture(state, width, height, mipmaps);
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: texture.texture, premultipliedAlpha: true },
      [width, height],
    );
    if (mipmaps) this.generateMipmaps(state, texture.texture);
    return texture;
  }

  release(texture: TextureHandle): void {
    (texture as GpuTexture).texture.destroy();
  }

  private createMediaTexture(
    state: State,
    width: number,
    height: number,
    mipmaps: boolean,
  ): GpuTexture {
    const texture = state.core.device.createTexture({
      size: [width, height],
      format: MEDIA_FORMAT,
      mipLevelCount: mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1,
      usage: TEXTURE_BINDING | TEXTURE_COPY_DST | TEXTURE_RENDER_ATTACHMENT,
    });
    const bindGroup = state.core.device.createBindGroup({
      layout: state.core.textureLayout,
      entries: [
        { binding: 0, resource: mipmaps ? state.core.mipSampler : state.core.linearSampler },
        { binding: 1, resource: texture.createView() },
      ],
    });
    return { texture, bindGroup, width, height, mipmaps };
  }

  /** Each level is the previous one downsampled with linear filtering (a 2x2 box). */
  private generateMipmaps(state: State, texture: GPUTexture): void {
    const { device } = state.core;
    const encoder = device.createCommandEncoder();
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const group = device.createBindGroup({
        layout: state.core.textureLayout,
        entries: [
          { binding: 0, resource: state.core.linearSampler },
          {
            binding: 1,
            resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
          },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(state.core.mipmap);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }

  // --- Setup and loss ---------------------------------------------------------------

  private initialize(core: Core): State {
    const { device } = core;
    this.canvasContext.configure({
      device,
      format: core.format,
      alphaMode: this.context.transparent ? 'premultiplied' : 'opaque',
    });
    device.addEventListener('uncapturederror', (event) => {
      if (this.errorLogged) return;
      this.errorLogged = true;
      console.error('apeiro: WebGPU error', (event as GPUUncapturedErrorEvent).error.message);
    });
    void device.lost.then((reason) => this.onDeviceLost(device, reason));

    const frameBuffer = device.createBuffer({
      size: FRAME_UNIFORM_BYTES,
      usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
    });
    const atlas = (format: GPUTextureFormat): AtlasTexture => ({
      texture: device.createTexture({
        size: [1, 1],
        format,
        usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
      }),
      size: 0,
    });
    const state: State = {
      core,
      frameBuffer,
      frameGroup: device.createBindGroup({
        layout: core.frameLayout,
        entries: [{ binding: 0, resource: { buffer: frameBuffer } }],
      }),
      draw: { buffer: null, bytes: 0 },
      drawGroup: null,
      shapes: { buffer: null, bytes: 0 },
      shapeCapacity: -1,
      lines: { buffer: null, bytes: 0 },
      glyphs: { buffer: null, bytes: 0 },
      sdf: atlas('r8unorm'),
      color: atlas('rgba8unorm'),
      textGroup: null,
      emptyTexture: null as unknown as GpuTexture,
      depth: null,
    };
    state.emptyTexture = this.createMediaTexture(state, 1, 1, false);
    // Everything must go to the new GPU objects.
    this.context.store.markFull();
    this.context.lineLayer.markUploadAll();
    this.context.textLayer.markUploadAll();
    this.context.sdfAtlas.markFullUpload();
    this.context.colorAtlas.markFullUpload();
    return state;
  }

  private onDeviceLost(device: GPUDevice, reason: GPUDeviceLostInfo): void {
    if (this.destroyed || this.state?.core.device !== device) return;
    console.warn('apeiro: WebGPU device lost, recreating it', reason.message);
    this.state = null;
    this.context.onLost();
    void this.recover();
  }

  private async recover(): Promise<void> {
    for (let attempt = 0; attempt < 3 && !this.destroyed; attempt++) {
      try {
        const core = await createCore();
        if (!core) break;
        if (this.destroyed) {
          core.device.destroy();
          return;
        }
        this.state = this.initialize(core);
        this.context.onRestored();
        return;
      } catch (error) {
        console.error('apeiro: WebGPU device could not be recreated', error);
      }
    }
  }

  // --- Uploads ----------------------------------------------------------------------

  private uploadShapes(state: State): void {
    const store = this.context.store;
    const dirty = store.takeDirty();
    if (dirty.kind === 'none') return;
    const { device } = state.core;
    const data = store.data;
    if (dirty.kind === 'all' || store.capacity !== state.shapeCapacity || !state.shapes.buffer) {
      const size = Math.max(4, data.byteLength);
      if (!state.shapes.buffer || state.shapes.bytes < size) {
        state.shapes.buffer?.destroy();
        state.shapes.buffer = device.createBuffer({ size, usage: BUFFER_VERTEX | BUFFER_COPY_DST });
        state.shapes.bytes = size;
      }
      if (data.byteLength > 0) device.queue.writeBuffer(state.shapes.buffer, 0, data);
      state.shapeCapacity = store.capacity;
      this.uploadedBytes += data.byteLength;
      return;
    }
    for (const [offset, length] of byteRuns(dirty, false, store.count, INSTANCE_STRIDE)) {
      device.queue.writeBuffer(state.shapes.buffer, offset, data, offset, length);
      this.uploadedBytes += length;
    }
  }

  /** Returns true when the texture was replaced (its bind group must be recreated). */
  private uploadAtlas(
    state: State,
    atlas: GlyphAtlas,
    texture: AtlasTexture,
    format: GPUTextureFormat,
  ): boolean {
    const uploads = atlas.takeUploads();
    const size = atlas.size;
    const resized = texture.size !== size;
    if (!resized && !uploads.full && uploads.rectangles.length === 0) return false;
    const { device } = state.core;
    if (resized) {
      texture.texture.destroy();
      texture.texture = device.createTexture({
        size: [size, size],
        format,
        usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
      });
      texture.size = size;
    }
    const channels = atlas.channels;
    if (resized || uploads.full) {
      device.queue.writeTexture(
        { texture: texture.texture },
        atlas.data,
        { bytesPerRow: size * channels },
        [size, size],
      );
      this.uploadedBytes += atlas.data.byteLength;
    } else {
      for (const upload of uploads.rectangles) {
        device.queue.writeTexture(
          { texture: texture.texture, origin: [upload.x, upload.y] },
          upload.data,
          { bytesPerRow: upload.width * channels },
          [upload.width, upload.height],
        );
        this.uploadedBytes += upload.data.byteLength;
      }
    }
    return resized;
  }

  /**
   * Grid levels and media quads each get a slot of per-draw uniforms (one buffer, dynamic
   * offsets): writes to a buffer all land before the frame's commands run, so one shared
   * uniform would leave every draw with the last value.
   */
  private writeDrawUniforms(state: State, frame: FrameParams): number[] {
    const levels = frame.grid?.levels ?? [];
    const count = levels.length + frame.media.length;
    if (count === 0) return [];
    const bytes = count * DRAW_UNIFORM_ALIGN;
    if (this.drawStaging.byteLength < bytes) this.drawStaging = new ArrayBuffer(bytes * 2);
    const floats = new Float32Array(this.drawStaging);
    const offsets: number[] = [];
    let at = 0;
    const put = (values: number[]) => {
      floats.set(values, at / 4);
      offsets.push(at);
      at += DRAW_UNIFORM_ALIGN;
    };
    for (const { spacing, fade } of levels) {
      put([...frame.grid!.color, spacing, fade, frame.grid!.lines ? 1 : 0, 0]);
    }
    for (const quad of frame.media) {
      put([
        ...quad.box,
        ...quad.textureCoordinates,
        quad.rotation,
        quad.depth,
        quad.radius,
        quad.texture ? 0 : 1,
      ]);
    }

    const { device } = state.core;
    if (!state.draw.buffer || state.draw.bytes < bytes) {
      state.draw.buffer?.destroy();
      state.draw.bytes = Math.max(bytes * 2, DRAW_UNIFORM_ALIGN * 16);
      state.draw.buffer = device.createBuffer({
        size: state.draw.bytes,
        usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
      });
      state.drawGroup = device.createBindGroup({
        layout: state.core.drawLayout,
        // Each draw sees one slot of the buffer.
        entries: [
          { binding: 0, resource: { buffer: state.draw.buffer, size: DRAW_UNIFORM_ALIGN } },
        ],
      });
    }
    device.queue.writeBuffer(state.draw.buffer, 0, this.drawStaging, 0, bytes);
    return offsets;
  }
}

/**
 * Like the WebGL `uploadInstances`: grows the buffer with spare room (growth needs a new
 * buffer, so it gets everything), otherwise writes only the dirty runs.
 */
function uploadInstances(
  device: GPUDevice,
  target: GrowableBuffer,
  data: ArrayBuffer,
  count: number,
  stride: number,
  upload: BufferUpload,
): number {
  if (upload.kind === 'none' || count === 0) return 0;
  const bytes = count * stride;
  const grow = !target.buffer || bytes > target.bytes;
  if (grow) {
    target.buffer?.destroy();
    target.bytes = Math.ceil(Math.max(bytes * 1.5, 64 * 1024) / 4) * 4;
    target.buffer = device.createBuffer({
      size: target.bytes,
      usage: BUFFER_VERTEX | BUFFER_COPY_DST,
    });
  }
  let uploaded = 0;
  for (const [offset, length] of byteRuns(upload, grow, count, stride)) {
    device.queue.writeBuffer(target.buffer!, offset, data, offset, length);
    uploaded += length;
  }
  return uploaded;
}
