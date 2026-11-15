#!/usr/bin/env node
// convex-workflow-patches check: refuses a release that removes code a running
// workflow still needs. Run it from the app's directory before deploying. Apps
// deployed with convex-release don't need it: convex-release runs the same
// check (src/predeploy.ts) on every deploy.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { blockedMessage, collect, COMPONENT_NOT_DEPLOYED, convexDirOf, describeBlocker, inspect, type Query } from './predeploy.ts';

const USAGE = `Usage: convex-workflow-patches check [--page-size <n>] [-- <convex options>]

Reads which patches this checkout's convex/patches.ts deprecates or retires,
and lists the running workflows that still need their old branches. Exits 1 if
there are any. Run it from your app's directory, against the deployment you're
about to deploy to. Where the components are mounted comes from componentPaths
in convex/patches.ts.

  --page-size  Workflows read per \`convex run\`. Default: 100

Options after -- go to every \`convex\` command the check runs (\`convex run\`
and \`convex data\`), e.g. -- --prod.
Exit codes: 0 nothing blocks, 1 running workflows block, 2 usage or deployment error.`;

class UsageError extends Error {}

/** The app's installed `convex` CLI, so `convex run` uses its deployment config. */
function convexBin(): string {
  try {
    return join(dirname(createRequire(join(process.cwd(), 'package.json')).resolve('convex/package.json')), 'bin', 'main.js');
  } catch {
    throw new Error("The `convex` package isn't installed here. Run this from your app's directory.");
  }
}

function convex(args: string[], convexArgs: string[]) {
  const result = spawnSync(process.execPath, [convexBin(), ...args, ...convexArgs], { encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout, output: `${result.stdout}\n${result.stderr}`.trim() };
}

/**
 * Queries through `convex run`. `convex run` against a missing component fails
 * with a generic server error, so each component is first looked up with
 * `convex data`, which names the cause. convex-release tells the same case
 * apart from `convex run`'s output instead (`classifyCliFailure`); if one of
 * them changes, check the other.
 */
function cliQuery(convexArgs: string[]): Query {
  const deployed = new Map<string, boolean>();
  const isDeployed = (component: string) => {
    if (!deployed.has(component)) {
      const result = convex(['data', '--component', component], convexArgs);
      if (!result.ok && !/Component path '[^']*' not found/.test(result.output))
        throw new Error(`convex data --component ${component} failed:\n${result.output}`);
      deployed.set(component, result.ok);
    }
    return deployed.get(component)!;
  };
  return async <T>({ componentPath, path }: { componentPath?: string; path: string }, args: object = {}) => {
    const component = componentPath === undefined ? [] : ['--component', componentPath];
    const what = ['convex run', ...component, path].join(' ');
    if (componentPath !== undefined && !isDeployed(componentPath)) {
      throw Object.assign(new Error(`${componentPath} isn't deployed`), { code: COMPONENT_NOT_DEPLOYED });
    }
    const result = convex(['run', ...component, path, JSON.stringify(args)], convexArgs);
    if (!result.ok) throw new Error(`${what} failed:\n${result.output}`);
    try {
      // `convex run` prints nothing for a null result.
      return (result.stdout.trim() ? JSON.parse(result.stdout) : null) as T;
    } catch {
      throw new Error(`${what} didn't print JSON:\n${result.stdout.trim()}`);
    }
  };
}

async function check(argv: string[]): Promise<number> {
  const split = argv.indexOf('--');
  const { values } = parseArgs({
    args: split < 0 ? argv : argv.slice(0, split),
    options: {
      'page-size': { type: 'string', default: '100' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const pageSize = Number(values['page-size']);
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new UsageError('--page-size must be a positive whole number.');

  const projectRoot = process.cwd();
  const facts = await collect({ projectRoot, convexDir: convexDirOf(projectRoot) });
  const result = await inspect(facts, cliQuery(split < 0 ? [] : argv.slice(split + 1)), pageSize);
  if (!result) {
    console.log(`The deployment has no ${facts.componentPaths.patches} component yet, so no running workflow can need a removed patch.`);
    return 0;
  }
  if (result.blockers.length === 0) {
    console.log('No running workflow needs code this release removes.');
    return 0;
  }
  console.log(`${blockedMessage(result.blockers)}:`);
  for (const blocker of result.blockers) console.log(`  ${describeBlocker(blocker)}`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  try {
    if (command !== 'check') throw new UsageError(`Unknown command "${command}".`);
    return await check(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) console.error(`\n${USAGE}`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
