// The e2e `skip` scenario's --redact module for `convex-workflow-migrations
// histories`: replaces every grab id, in the run's args and in each step's.
type Redactable = { kind: string; name: string; args: unknown; result?: unknown; error?: string };

export default function redact(value: Redactable): Redactable {
  const args = value.args as Record<string, unknown>;
  return 'grabId' in args ? { ...value, args: { ...args, grabId: 'redacted' } } : value;
}
