#!/usr/bin/env node
/**
 * UI-1 / UI-2 渲染验收运行器（零新增依赖）：
 *  1) 用 apps/api 已有的 esbuild 把 ui-check-entry.tsx 打包到 apps/web/.ui-check/；
 *  2) 注入 next/link 与 next/navigation 的最小替身（组件在 Node 中可渲染）；
 *  3) 由 react-dom/server 渲染并断言。
 * 用法：node scripts/ui-render-check.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(WEB, '..', '..');
const requireFromApi = createRequire(path.join(REPO, 'apps', 'api', 'package.json'));
const esbuild = requireFromApi('esbuild');

const stubs = {
  'next/link': path.join(WEB, 'scripts', 'ui-check-stubs', 'next-link.tsx'),
  'next/navigation': path.join(WEB, 'scripts', 'ui-check-stubs', 'next-navigation.ts'),
};

const outdir = path.join(WEB, '.ui-check');
fs.mkdirSync(outdir, { recursive: true });
const outfile = path.join(outdir, 'bundle.mjs');

await esbuild.build({
  entryPoints: [path.join(WEB, 'scripts', 'ui-check-entry.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  target: 'node20',
  outfile,
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  logLevel: 'warning',
  plugins: [
    {
      name: 'next-stubs',
      setup(build) {
        build.onResolve({ filter: /^next\/(link|navigation)$/ }, (args) => ({ path: stubs[args.path] }));
      },
    },
  ],
});

await import(pathToFileURL(outfile).href);
