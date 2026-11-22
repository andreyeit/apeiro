import type { MediaQuad, MediaSource, MediaTextures, TextureHandle } from '../backend';
import { compileProgram, createUnitQuad, uniforms } from './gl-utils';
import { MEDIA_FRAGMENT, MEDIA_VERTEX } from './shaders';

type Uniforms = Record<
  | 'u_camera'
  | 'u_viewport'
  | 'u_rect'
  | 'u_rotation'
  | 'u_depth'
  | 'u_radius'
  | 'u_mode'
  | 'u_uv'
  | 'u_tex',
  WebGLUniformLocation | null
>;

interface Resources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  quad: WebGLBuffer;
  uniforms: Uniforms;
}

/** WebGL side of images and audio players: their textures and one draw call per quad. */
export class GlMedia implements MediaTextures {
  private resources: Resources | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  initialize(): void {
    const gl = this.gl;
    const program = compileProgram(gl, MEDIA_VERTEX, MEDIA_FRAGMENT);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const quad = createUnitQuad(gl);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.resources = {
      program,
      vao,
      quad,
      uniforms: uniforms(gl, program, [
        'u_camera',
        'u_viewport',
        'u_rect',
        'u_rotation',
        'u_depth',
        'u_radius',
        'u_mode',
        'u_uv',
        'u_tex',
      ] as const),
    };
  }

  lose(): void {
    this.resources = null;
  }

  dispose(): void {
    const resources = this.resources;
    if (!resources) return;
    const gl = this.gl;
    gl.deleteProgram(resources.program);
    gl.deleteVertexArray(resources.vao);
    gl.deleteBuffer(resources.quad);
    this.resources = null;
  }

  draw(
    quads: MediaQuad[],
    x: number,
    y: number,
    zoom: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    const resources = this.resources;
    if (!resources || quads.length === 0) return;
    const gl = this.gl;
    const uniforms = resources.uniforms;
    gl.useProgram(resources.program);
    gl.bindVertexArray(resources.vao);
    gl.uniform3f(uniforms.u_camera, x, y, zoom);
    gl.uniform2f(uniforms.u_viewport, viewportWidth, viewportHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uniforms.u_tex, 0);
    for (const quad of quads) {
      gl.uniform4f(uniforms.u_rect, ...quad.box);
      gl.uniform4f(uniforms.u_uv, ...quad.textureCoordinates);
      gl.uniform1f(uniforms.u_rotation, quad.rotation);
      gl.uniform1f(uniforms.u_depth, quad.depth);
      gl.uniform1f(uniforms.u_radius, quad.radius);
      if (quad.texture) gl.bindTexture(gl.TEXTURE_2D, quad.texture as WebGLTexture);
      gl.uniform1f(uniforms.u_mode, quad.texture ? 0 : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  upload(source: MediaSource, mipmaps: boolean, previous?: TextureHandle): TextureHandle {
    const gl = this.gl;
    let texture = previous as WebGLTexture | undefined;
    if (!texture) {
      texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
      );
    } else {
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  release(texture: TextureHandle): void {
    this.gl.deleteTexture(texture as WebGLTexture);
  }
}
