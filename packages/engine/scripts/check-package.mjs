// Checks the built package before publishing: every export resolves to a file, nothing
// refers to the private workspace packages, the React entry is a client module and the
// main entry loads without a DOM (server rendering). A separate TypeScript consumer checks
// all public entries with both bundler and NodeNext module resolution.
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];

if (!existsSync(join(root, 'README.md')))
  problems.push('README.md is missing (the build copies the root one)');

for (const [subpath, target] of Object.entries(pkg.exports)) {
  const files = typeof target === 'string' ? [target] : Object.values(target);
  for (const file of files)
    if (!existsSync(join(root, file))) problems.push(`${subpath}: ${file} is missing`);
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
for (const file of walk(join(root, 'dist'))) {
  if (!/\.(js|d\.ts)$/.test(file)) continue;
  if (/from ["']@apeiro\//.test(readFileSync(file, 'utf8')))
    problems.push(`${file} imports a private @apeiro/* package`);
}

for (const entry of ['dist/react.js']) {
  if (!readFileSync(join(root, entry), 'utf8').startsWith('"use client"'))
    problems.push(`${entry} does not start with "use client"`);
}
for (const entry of ['dist/index.js']) {
  if (readFileSync(join(root, entry), 'utf8').includes('use client'))
    problems.push(`${entry} must not be a client module`);
}

// Compile a consumer of the shipped files in isolation: no workspace source paths or
// tsconfig aliases can hide missing public declarations or broken package exports.
const consumer = mkdtempSync(join(tmpdir(), 'apeiro-consumer-'));
try {
  const modules = join(consumer, 'node_modules');
  const installed = join(modules, pkg.name);
  mkdirSync(installed, { recursive: true });
  cpSync(join(root, 'dist'), join(installed, 'dist'), { recursive: true });
  cpSync(join(root, 'package.json'), join(installed, 'package.json'));
  cpSync(join(root, 'scripts/consumer.tsx'), join(consumer, 'consumer.tsx'));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const dependency of ['react', '@mapbox']) {
    symlinkSync(join(root, 'node_modules', dependency), join(modules, dependency), 'junction');
  }
  mkdirSync(join(modules, '@types'));
  symlinkSync(
    realpathSync(join(root, 'node_modules', '@types', 'react')),
    join(modules, '@types', 'react'),
    'junction',
  );
  // The framework-free entry must work in a consumer without optional Yjs installed.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { BoardEditor } = await import(${JSON.stringify(pathToFileURL(join(installed, 'dist/index.js')).href)}); new BoardEditor().destroy(); await import(${JSON.stringify(pathToFileURL(join(installed, 'dist/react.js')).href)});`,
    ],
    { cwd: consumer },
  );
  // Even type-checking a plain React consumer must not require optional network peers.
  const plainConsumer = join(consumer, 'plain.tsx');
  writeFileSync(
    plainConsumer,
    `import { Board } from 'apeiro/react';
export const local = <Board config={{ grid: 'dots' }} />;
export const shared = <Board collaboration={{ url: 'http://localhost:3001', roomId: 'demo', socketOptions: { auth: { token: 'test' } } }} />;
`,
  );
  const plainProgram = ts.createProgram([plainConsumer], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    types: [],
  });
  const plainDiagnostics = ts.getPreEmitDiagnostics(plainProgram);
  if (plainDiagnostics.length)
    problems.push(
      ts.formatDiagnostics(plainDiagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => consumer,
        getNewLine: () => '\n',
      }),
    );
  // The collaboration entry needs only Yjs; presence types are structural.
  symlinkSync(join(root, 'node_modules', 'yjs'), join(modules, 'yjs'), 'junction');
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(join(installed, 'dist/yjs.js')).href)});`,
    ],
    { cwd: consumer },
  );
  for (const dependency of ['y-protocols', 'socket.io', 'socket.io-client']) {
    symlinkSync(join(root, 'node_modules', dependency), join(modules, dependency), 'junction');
  }
  for (const [name, module, moduleResolution] of [
    ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
    ['NodeNext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
  ]) {
    const program = ts.createProgram([join(consumer, 'consumer.tsx')], {
      target: ts.ScriptTarget.ES2022,
      module,
      moduleResolution,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      noEmit: true,
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      problems.push(
        `TypeScript consumer (${name}):\n${ts.formatDiagnostics(diagnostics, {
          getCanonicalFileName: (file) => file,
          getCurrentDirectory: () => consumer,
          getNewLine: () => '\n',
        })}`,
      );
    }
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

// Importing must not touch window/document (Next.js imports modules on the server).
try {
  const core = await import(pathToFileURL(join(root, 'dist/index.js')).href);
  const editor = new core.BoardEditor();
  editor.elements.add([
    {
      id: 'a',
      type: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      z: 0,
      fill: 0,
      stroke: 0,
      strokeWidth: 0,
      radius: 0,
    },
  ]);
  if (editor.selection.ids[0] !== 'a') problems.push('BoardEditor does not work without a DOM');
  editor.destroy();
} catch (e) {
  problems.push(`dist/index.js fails without a DOM: ${e}`);
}

if (problems.length > 0) {
  console.error(`Package check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`${pkg.name}@${pkg.version}: package check passed`);
