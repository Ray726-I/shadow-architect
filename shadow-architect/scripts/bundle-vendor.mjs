import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = resolve(rootDir, 'media', 'vendor');

async function bundleFile(outputFile, contents) {
  await build({
    stdin: {
      contents,
      resolveDir: rootDir,
      sourcefile: `${outputFile}.entry.js`
    },
    bundle: true,
    format: 'iife',
    minify: true,
    platform: 'browser',
    target: ['es2020'],
    outfile: resolve(vendorDir, outputFile),
    logLevel: 'silent'
  });
}

async function main() {
  await mkdir(vendorDir, { recursive: true });

  await bundleFile('marked.min.js', "import { marked } from 'marked';window.marked=marked;");
  await bundleFile('highlight.min.js', "import hljs from 'highlight.js/lib/common';window.hljs=hljs;");
  await bundleFile('dompurify.min.js', "import DOMPurify from 'dompurify';window.DOMPurify=DOMPurify;");

  process.stdout.write('Bundled vendor assets\n');
}

main().catch(error => {
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
