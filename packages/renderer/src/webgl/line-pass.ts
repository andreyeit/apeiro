import { LINE_LAYOUT, LINE_STRIDE, type LineLayer } from '../layers/line-layer';
import {
  bindInstanceAttributes,
  compileProgram,
  createUnitQuad,
  uniforms,
  uploadInstances,
} from './gl-utils';
import { LINE_FRAGMENT, LINE_VERTEX } from './shaders';

interface Resources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  quad: WebGLBuffer;
  instances: WebGLBuffer;
  instanceBytes: number;
  uniforms: Record<'u_camera' | 'u_viewport' | 'u_depthOnly', WebGLUniformLocation | null>;
}

/**
 * GL side of connectors: all segments and caps in two instanced draws. First depth only, for
 * fully opaque pixels, so the line on top hides those below; then color without depth
 * writes, so an antialiased edge never cuts a hole into a line under it.
 */
export class LinePass {
  private resources: Resources | null = null;
  uploadedBytes = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly layer: LineLayer,
  ) {}

  initialize(): void {
    const gl = this.gl;
    const program = compileProgram(gl, LINE_VERTEX, LINE_FRAGMENT);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const quad = createUnitQuad(gl);
    const instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    bindInstanceAttributes(gl, LINE_LAYOUT);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.resources = {
      program,
      vao,
      quad,
      instances,
      instanceBytes: 0,
      uniforms: uniforms(gl, program, ['u_camera', 'u_viewport', 'u_depthOnly'] as const),
    };
    this.layer.markUploadAll();
  }

  lose(): void {
    this.resources = null;
  }

  draw(x: number, y: number, zoom: number, viewportWidth: number, viewportHeight: number): void {
    const resources = this.resources;
    if (!resources) return;
    this.upload(resources);
    if (this.layer.count === 0) return;
    const gl = this.gl;
    gl.useProgram(resources.program);
    gl.uniform3f(resources.uniforms.u_camera, x, y, zoom);
    gl.uniform2f(resources.uniforms.u_viewport, viewportWidth, viewportHeight);
    gl.bindVertexArray(resources.vao);
    gl.colorMask(false, false, false, false);
    gl.uniform1f(resources.uniforms.u_depthOnly, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.layer.count);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.uniform1f(resources.uniforms.u_depthOnly, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.layer.count);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const resources = this.resources;
    if (!resources) return;
    const gl = this.gl;
    gl.deleteProgram(resources.program);
    gl.deleteVertexArray(resources.vao);
    gl.deleteBuffer(resources.quad);
    gl.deleteBuffer(resources.instances);
    this.resources = null;
  }

  private upload(resources: Resources): void {
    this.uploadedBytes += uploadInstances(
      this.gl,
      resources,
      this.layer.data,
      this.layer.count,
      LINE_STRIDE,
      this.layer.takeUpload(),
    );
  }
}
