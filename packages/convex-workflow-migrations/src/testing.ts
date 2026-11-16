// Test-only switch for simulating an older release in convex-test. Empty, and
// so inert, unless a test calls `simulateDeploy({ without: [...] })`.
//
// Kept on a global symbol rather than in module state: a test runner can load
// two copies of this package (e.g. its build for the test helper and its
// sources for the app), and both must see the same switch.
const key = Symbol.for('@dev-marzahn/convex-workflow-migrations/unreleased');
const unreleased = ((globalThis as { [key]?: Set<string> })[key] ??= new Set<string>());

/**
 * Make the following handler runs behave like a deploy that doesn't contain
 * the listed patches: `patched(id)` returns `false` and records no marker,
 * which is what code without the `patched(id)` call does. Call
 * `simulateDeploy()` with no argument to deploy the current code.
 *
 * convex-test runs every handler in the test process, so this applies to all
 * runs until the next call.
 */
export function simulateDeploy(release: { without: string[] } = { without: [] }): void {
  unreleased.clear();
  for (const id of release.without) unreleased.add(id);
}

export function isUnreleased(id: string): boolean {
  return unreleased.has(id);
}
