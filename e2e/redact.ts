// The e2e scenarios' --redact module for `convex-workflow-migrations
// histories`: replaces every grab id with "redacted" and every notify time
// with 0, in the steps, the run's args and the overlay. Both sides of each
// comparison change the same way, so the export still replays.
import type { Redactable } from '../packages/convex-workflow-migrations/src/index.ts';

export default function redact(value: Redactable): Redactable {
  const args = { ...(value.args as Record<string, unknown>) };
  if ('grabId' in args) args.grabId = 'redacted';
  if ('notifiedAt' in args) args.notifiedAt = 0;
  const result = value.result;
  const scrubbed = typeof result === 'object' && result !== null && 'at' in result ? { ...result, at: 0 } : result;
  return { ...value, args, ...(value.result === undefined ? {} : { result: scrubbed }) };
}
