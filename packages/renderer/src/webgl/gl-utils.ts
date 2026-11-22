import { byteRuns, type BufferUpload } from '../layers/buffer-upload';
import type { InstanceLayout } from '../layers/instance-layout';

export function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program');
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

export function uniforms<K extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly K[],
): Record<K, WebGLUniformLocation | null> {
  const out = {} as Record<K, WebGLUniformLocation | null>;
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  return out;
}

/** The unit quad (0..1, a triangle strip) every instanced pass draws, at attribute location 0. */
export function createUnitQuad(gl: WebGL2RenderingContext): WebGLBuffer {
  const quad = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return quad;
}

/**
 * Points the bound vertex array's per-instance attributes (locations 1, 2, …) at the
 * buffer bound to ARRAY_BUFFER, as `layout` describes them.
 */
export function bindInstanceAttributes(gl: WebGL2RenderingContext, layout: InstanceLayout): void {
  layout.attributes.forEach((attribute, index) => {
    const location = index + 1;
    const bytes = attribute.format === 'unorm8';
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      attribute.components,
      bytes ? gl.UNSIGNED_BYTE : gl.FLOAT,
      bytes,
      layout.stride,
      attribute.offset,
    );
    gl.vertexAttribDivisor(location, 1);
  });
}

/** A growable GPU buffer of instances. */
export interface InstanceBuffer {
  instances: WebGLBuffer;
  instanceBytes: number;
}

/**
 * Uploads a CPU layer to its GPU buffer and returns bytes transferred (not allocated).
 * Growth invalidates the old contents, so even a partial update must upload all instances.
 * Spare capacity avoids reallocating when the visible text or a connector grows slightly.
 */
export function uploadInstances(
  gl: WebGL2RenderingContext,
  target: InstanceBuffer,
  data: ArrayBuffer,
  count: number,
  stride: number,
  upload: BufferUpload,
): number {
  if (upload.kind === 'none' || count === 0) return 0;
  const bytes = count * stride;
  const grow = bytes > target.instanceBytes;
  gl.bindBuffer(gl.ARRAY_BUFFER, target.instances);
  if (grow) {
    target.instanceBytes = Math.ceil(Math.max(bytes * 1.5, 64 * 1024));
    gl.bufferData(gl.ARRAY_BUFFER, target.instanceBytes, gl.DYNAMIC_DRAW);
  }
  let uploaded = 0;
  for (const [offset, length] of byteRuns(upload, grow, count, stride)) {
    gl.bufferSubData(gl.ARRAY_BUFFER, offset, new Uint8Array(data, offset, length));
    uploaded += length;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return uploaded;
}
