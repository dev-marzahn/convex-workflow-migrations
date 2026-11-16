// Re-vendors the @convex-dev/workflow client into
// packages/convex-workflow-migrations/src/vendor/workflow: copies the
// installed release's sources over the vendored files, re-applies
// upstream.diff, sets the version in the header comments, and regenerates the
// diff. See VENDORED.md there.
//
//   bun run vendor          copy, patch and regenerate the diff
//   bun run vendor diff     only regenerate the diff, after fixing conflicts
//
// tests/vendor.test.ts checks the result with the same FILES and
// diffVendored().
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(ROOT, 'packages/convex-workflow-migrations');
export const VENDOR = join(PACKAGE, 'src/vendor/workflow');
const DIFF = join(VENDOR, 'upstream.diff');

/**
 * Vendored file → its source in the upstream package. The copy is flat. A
 * new upstream file that a vendored one imports goes here, and in VENDORED.md's
 * table.
 */
export const FILES: Readonly<Record<string, string>> = {
  'environment.ts': 'src/client/environment.ts',
  'logging.ts': 'src/component/logging.ts',
  'publicTypes.ts': 'src/types.ts',
  'safeFunctionName.ts': 'src/client/safeFunctionName.ts',
  'shared.ts': 'src/shared.ts',
  'step.ts': 'src/client/step.ts',
  'types.ts': 'src/client/types.ts',
  'workflowContext.ts': 'src/client/workflowContext.ts',
  'workflowMutation.ts': 'src/client/workflowMutation.ts',
};

/** The installed upstream package, as the vendored package resolves it. */
export function upstreamDir(): string {
  return dirname(createRequire(join(PACKAGE, 'package.json')).resolve('@convex-dev/workflow/package.json'));
}

export function upstreamVersion(): string {
  return (JSON.parse(readFileSync(join(upstreamDir(), 'package.json'), 'utf8')) as { version: string }).version;
}

/**
 * What upstream.diff holds: `diff -u` of each upstream source against its
 * vendored file, labelled upstream/<file> and vendor/<file>, in the order of
 * the file names. Unchanged files add nothing.
 */
export function diffVendored(upstream = upstreamDir(), vendor = VENDOR): string {
  let out = '';
  for (const name of Object.keys(FILES).sort()) {
    const result = spawnSync('diff', ['-u', '--label', `upstream/${name}`, '--label', `vendor/${name}`, join(upstream, FILES[name]!), join(vendor, name)], {
      encoding: 'utf8',
    });
    if (result.status !== 0 && result.status !== 1) throw new Error(`diff of ${name} failed:\n${result.stderr}`);
    out += result.stdout;
  }
  return out;
}

/** Leftovers of a patch run, which must not stay in the vendored directory. */
const leftovers = () => readdirSync(VENDOR).filter((name) => name.endsWith('.orig') || name.endsWith('.rej'));

function regenerate(): void {
  const left = leftovers();
  if (left.length > 0) throw new Error(`Resolve and delete ${left.join(', ')} in ${VENDOR} first.`);
  writeFileSync(DIFF, diffVendored());
  console.log(`Wrote ${DIFF}.`);
}

function revendor(): number {
  const upstream = upstreamDir();
  const version = upstreamVersion();
  const patch = readFileSync(DIFF);
  // Patch a scratch copy of upstream, then copy it over the vendored files, failed hunks or not: a file is patched as
  // far as the patch got, and its .rej, copied next to it, has the hunks left to apply by hand.
  const work = mkdtempSync(join(tmpdir(), 'convex-workflow-migrations-vendor-'));
  try {
    for (const [name, source] of Object.entries(FILES)) copyFileSync(join(upstream, source), join(work, name));
    const result = spawnSync('patch', ['-p1', '-d', work], { input: patch, encoding: 'utf8' });
    console.log(result.stdout.trim());
    for (const name of Object.keys(FILES)) {
      const text = readFileSync(join(work, name), 'utf8').replace(
        /vendored from @convex-dev\/workflow [^ ]+ /g,
        `vendored from @convex-dev/workflow ${version} `,
      );
      writeFileSync(join(VENDOR, name), text);
      // Hunks that didn't apply: fix them in the vendored file by hand, delete the .rej, then `bun run vendor diff`.
      if (existsSync(join(work, `${name}.rej`))) copyFileSync(join(work, `${name}.rej`), join(VENDOR, `${name}.rej`));
    }
    const rejected = leftovers();
    if (result.status !== 0 || rejected.length > 0) {
      console.error(
        `upstream.diff didn't apply cleanly to @convex-dev/workflow ${version}. Apply the hunks in ${rejected.join(', ') || 'the output above'} by hand, delete the .rej files, then run \`bun run vendor diff\`.`,
      );
      return 1;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  regenerate();
  console.log(`Vendored @convex-dev/workflow ${version}. Update the version and commit in VENDORED.md.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2);
  if (command === 'diff') regenerate();
  else if (command === undefined) process.exitCode = revendor();
  else throw new Error(`Unknown command "${command}". Run it without arguments to re-vendor, or with "diff" to regenerate the diff.`);
}
