import { GLYPH_LAYOUT, GLYPH_STRIDE, type TextLayer } from '../layers/text-layer';
import type { GlyphAtlas } from '../text/glyph-atlas';
import {
  bindInstanceAttributes,
  compileProgram,
  createUnitQuad,
  uniforms,
  uploadInstances,
} from './gl-utils';
import { TEXT_FRAGMENT, TEXT_VERTEX } from './shaders';

interface AtlasTexture {
  texture: WebGLTexture;
  size: number;
}

interface Resources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  quad: WebGLBuffer;
  instances: WebGLBuffer;
  instanceBytes: number;
  sdf: AtlasTexture;
  color: AtlasTexture;
  uniforms: Record<
    'u_camera' | 'u_viewport' | 'u_pixelRatio' | 'u_sdf' | 'u_colorAtlas' | 'u_edge',
    WebGLUniformLocation | null
  >;
}

/** GL side of text: owns the atlas textures and the quad instance buffer. */
export class TextPass {
  private resources: Resources | null = null;
  uploadedBytes = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly sdfAtlas: GlyphAtlas,
    private readonly colorAtlas: GlyphAtlas,
    private readonly layer: TextLayer,
    /** SDF value at the outline: 1 - cutoff of the rasterizer. */
    private readonly edge: number,
  ) {}

  /** (Re)creates GL objects; safe to call after a context restore. */
  initialize(): void {
    const gl = this.gl;
    const program = compileProgram(gl, TEXT_VERTEX, TEXT_FRAGMENT);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const quad = createUnitQuad(gl);
    const instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    bindInstanceAttributes(gl, GLYPH_LAYOUT);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.resources = {
      program,
      vao,
      quad,
      instances,
      instanceBytes: 0,
      sdf: { texture: this.createTexture(), size: 0 },
      color: { texture: this.createTexture(), size: 0 },
      uniforms: uniforms(gl, program, [
        'u_camera',
        'u_viewport',
        'u_pixelRatio',
        'u_sdf',
        'u_colorAtlas',
        'u_edge',
      ] as const),
    };
    // Everything must go to the new GL objects.
    this.sdfAtlas.markFullUpload();
    this.colorAtlas.markFullUpload();
    this.layer.markUploadAll();
  }

  /** Forget GL objects without deleting them (they died with a lost context). */
  lose(): void {
    this.resources = null;
  }

  draw(
    x: number,
    y: number,
    zoom: number,
    viewportWidth: number,
    viewportHeight: number,
    pixelRatio: number,
  ): void {
    const resources = this.resources;
    if (!resources) return;
    const gl = this.gl;
    this.uploadAtlas(this.sdfAtlas, resources.sdf);
    this.uploadAtlas(this.colorAtlas, resources.color);
    this.uploadInstances(resources);
    if (this.layer.count === 0) return;

    gl.useProgram(resources.program);
    gl.uniform3f(resources.uniforms.u_camera, x, y, zoom);
    gl.uniform2f(resources.uniforms.u_viewport, viewportWidth, viewportHeight);
    gl.uniform1f(resources.uniforms.u_pixelRatio, pixelRatio);
    gl.uniform1f(resources.uniforms.u_edge, this.edge);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.sdf.texture);
    gl.uniform1i(resources.uniforms.u_sdf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, resources.color.texture);
    gl.uniform1i(resources.uniforms.u_colorAtlas, 1);
    gl.bindVertexArray(resources.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.layer.count);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    const resources = this.resources;
    if (!resources) return;
    const gl = this.gl;
    gl.deleteProgram(resources.program);
    gl.deleteVertexArray(resources.vao);
    gl.deleteBuffer(resources.quad);
    gl.deleteBuffer(resources.instances);
    gl.deleteTexture(resources.sdf.texture);
    gl.deleteTexture(resources.color.texture);
    this.resources = null;
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 1x1 placeholder so sampling an unused atlas is valid.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  private uploadAtlas(atlas: GlyphAtlas, texture: AtlasTexture): void {
    const gl = this.gl;
    const uploads = atlas.takeUploads();
    const full = uploads.full || texture.size !== atlas.size;
    if (!full && uploads.rectangles.length === 0) return;
    const isColor = atlas.channels === 4;
    const internal = isColor ? gl.RGBA8 : gl.R8;
    const format = isColor ? gl.RGBA : gl.RED;
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (full) {
      const size = atlas.size;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internal,
        size,
        size,
        0,
        format,
        gl.UNSIGNED_BYTE,
        atlas.data,
      );
      texture.size = size;
      this.uploadedBytes += atlas.data.byteLength;
    } else {
      for (const upload of uploads.rectangles) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          upload.x,
          upload.y,
          upload.width,
          upload.height,
          format,
          gl.UNSIGNED_BYTE,
          upload.data,
        );
        this.uploadedBytes += upload.data.byteLength;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private uploadInstances(resources: Resources): void {
    this.uploadedBytes += uploadInstances(
      this.gl,
      resources,
      this.layer.data,
      this.layer.count,
      GLYPH_STRIDE,
      this.layer.takeUpload(),
    );
  }
}
