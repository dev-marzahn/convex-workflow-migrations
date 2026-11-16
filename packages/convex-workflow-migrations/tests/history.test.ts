// @vitest-environment node
import { anyApi } from 'convex/server';
import { expect, test } from 'vite-plus/test';

import { DETAIL_LIMIT } from '../src/component/schema.ts';
import { HistoryView, type RecordedStep, ReplayMismatch, ReplayPause, returnedEarly, threwEarly } from '../src/history.ts';
import { migration, OVERLAY_LIMIT, prepareHistory, recordedStep } from '../src/migrations.ts';
import { redactHistory } from '../src/redact.ts';
import type { JournalEntry } from '../src/vendor/workflow/types.ts';

const fn = anyApi.flows!;
const done = (id: string, name: string, returnValue: unknown = null, args: unknown = {}): RecordedStep => ({
  id,
  name: `flows:${name}`,
  kind: 'function',
  args,
  runResult: { kind: 'success', returnValue },
  startedAt: Number(id.slice(1)) * 10,
});
const event = (id: string, name: string, running = false): RecordedStep => ({
  id,
  name,
  kind: 'event',
  args: {},
  ...(running ? {} : { runResult: { kind: 'success' as const, returnValue: null } }),
  startedAt: Number(id.slice(1)) * 10,
});
// grab, wait (done), import
const journal = () => [done('j0', 'grab', 'grabbed'), event('j1', 'downloadDone'), done('j2', 'importFiles', null, { grabId: 'g' })];
const names = (h: HistoryView) => h.steps.map((s) => `${s.name.replace('flows:', '')}${s.status === 'done' ? '' : ` (${s.status})`}`);

test('reads the steps, has() and result()', () => {
  const h = new HistoryView(journal());
  expect(names(h)).toEqual(['grab', 'downloadDone', 'importFiles']);
  expect(h.has(fn.grab)).toBe(true);
  expect(h.has(fn.notify)).toBe(false);
  expect(h.has({ event: 'downloadDone' })).toBe(true);
  expect(h.has({ sleep: 'downloadDone' })).toBe(false);
  expect(h.result(fn.grab)).toBe('grabbed');
  expect(h.result(fn.notify)).toBeUndefined();
  expect(h.steps[0]).toEqual({ id: 'j0', name: 'flows:grab', kind: 'function', args: {}, status: 'done', result: 'grabbed' });
});

test('insertAfter and insertBefore add a stand-in with its result', () => {
  const h = new HistoryView(journal());
  h.insertAfter(fn.grab, fn.notify, { result: { at: null } });
  h.insertBefore({ event: 'downloadDone' }, fn.prepare, { result: 'ready', args: { x: 1 } });
  expect(names(h)).toEqual(['grab', 'notify', 'prepare', 'downloadDone', 'importFiles']);
  expect(h.result(fn.notify)).toEqual({ at: null });
  expect(h.steps[2]).toMatchObject({ args: { x: 1 }, status: 'done', result: 'ready' });
  expect(h.overlay().map((op) => op.op)).toEqual(['insert', 'insert']);
});

test('a stand-in without args is matched on its name and kind only, and sees the time of the step before it', () => {
  const h = new HistoryView(journal());
  h.insertAfter(fn.grab, fn.notify, { result: 1 });
  h.insertBefore(fn.grab, fn.first, { result: 0, args: {} });
  const replay = h.replay(999);
  expect(replay.map((e) => [e.step.name, e.argsKnown, e.step.startedAt])).toEqual([
    ['flows:first', true, 0], // nothing before it: the first recorded step's time
    ['flows:grab', true, 0],
    ['flows:notify', false, 0],
    ['downloadDone', true, 10],
    ['flows:importFiles', true, 20],
  ]);
  expect(replay[2]!.step.runResult).toEqual({ kind: 'success', returnValue: 1 });
});

test('remove, rename and updateArgs', () => {
  const h = new HistoryView(journal());
  h.rename(fn.importFiles, fn.ingest);
  h.updateArgs(fn.ingest, (args) => ({ ...args, notifiedAt: null }));
  h.remove(fn.grab);
  expect(names(h)).toEqual(['downloadDone', 'ingest']);
  expect(h.steps[1]!.args).toEqual({ grabId: 'g', notifiedAt: null });
  expect(h.replay(0)[1]!.step).toMatchObject({ name: 'flows:ingest', args: { grabId: 'g', notifiedAt: null } });
});

test('updateArgs gets a copy of the recorded args', () => {
  const steps = journal();
  const h = new HistoryView(steps);
  h.updateArgs(fn.importFiles, (args) => {
    args.grabId = 'changed';
    return args;
  });
  expect(steps[2]!.args).toEqual({ grabId: 'g' });
});

test('an edit whose step is not in the history does nothing', () => {
  const h = new HistoryView(journal());
  h.insertAfter(fn.notify, fn.other, { result: null });
  h.remove(fn.transcode);
  h.rename(fn.prepare, fn.transcode);
  h.updateArgs(fn.prepare, () => ({}));
  expect(names(h)).toEqual(['grab', 'downloadDone', 'importFiles']);
  expect(h.overlay()).toEqual([]);
});

test('a reference that matches several steps throws; pass one of h.steps instead', () => {
  const h = new HistoryView([done('j0', 'grab'), done('j1', 'grab'), event('j2', 'downloadDone')]);
  expect(() => h.remove(fn.grab)).toThrow('remove(flows:grab): 2 steps match. Pass the one you mean from h.steps.');
  expect(() => h.result(fn.grab)).toThrow('2 steps match');
  h.insertAfter(h.steps[1]!, fn.notify, { result: null });
  h.remove(h.steps[0]!);
  expect(names(h)).toEqual(['grab', 'notify', 'downloadDone']);
  const gone = h.steps[0]!;
  h.remove(gone);
  expect(() => h.remove(gone)).toThrow("that step isn't in the history any more");
});

test('a running step can be inserted around, but not removed, renamed or given other args', () => {
  const h = new HistoryView([done('j0', 'grab'), event('j1', 'downloadDone', true)]);
  expect(h.steps[1]!.status).toBe('running');
  expect(() => h.remove({ event: 'downloadDone' })).toThrow('the step is still running');
  expect(() => h.rename({ event: 'downloadDone' }, { event: 'done' })).toThrow('still running');
  expect(() => h.updateArgs(h.steps[1]!, () => ({}))).toThrow('still running');
  h.insertBefore({ event: 'downloadDone' }, fn.notify, { result: null });
  h.insertAfter({ event: 'downloadDone' }, fn.after, { result: null });
  expect(names(h)).toEqual(['grab', 'notify', 'downloadDone (running)', 'after']);
});

test('rename keeps the kind of step', () => {
  const h = new HistoryView(journal());
  expect(() => h.rename({ event: 'downloadDone' }, fn.grab)).toThrow("rename(event downloadDone, flows:grab): the step's kind (event) must stay the same.");
  expect(() => h.rename(fn.grab, { sleep: 'nap' })).toThrow("the step's kind (function) must stay the same");
  expect(() => h.rename(fn.grab, { workflow: fn.child })).toThrow("the step's kind (function) must stay the same");
  h.rename({ event: 'downloadDone' }, { event: 'filesReady' });
  expect(h.has({ event: 'filesReady' })).toBe(true);
});

test('insert needs a result', () => {
  const h = new HistoryView(journal());
  expect(() => h.insertAfter(fn.grab, fn.notify, {} as never)).toThrow('insertAfter(flows:grab, flows:notify): pass { result } for the stand-in.');
});

test('later edits see earlier ones, and edit steps that earlier ones inserted', () => {
  const h = new HistoryView(journal());
  h.insertAfter(fn.grab, fn.notify, { result: { at: null } });
  h.updateArgs(fn.notify, () => ({ to: 'me' }));
  h.insertAfter(fn.notify, fn.log, { result: null });
  h.rename(fn.notify, fn.alert);
  const stored = h.overlay();
  const reloaded = new HistoryView(journal(), stored);
  expect(names(reloaded)).toEqual(['grab', 'alert', 'log', 'downloadDone', 'importFiles']);
  expect(reloaded.steps[1]).toMatchObject({ args: { to: 'me' }, result: { at: null } });
  // New inserts don't reuse ids.
  reloaded.insertAfter(fn.log, fn.more, { result: null });
  const ids = reloaded.overlay().flatMap((op) => ('id' in op ? [op.id] : []));
  expect(new Set(ids).size).toBe(ids.length);
});

test('operations on steps a restart deleted are dropped', () => {
  const h = new HistoryView(journal());
  h.insertAfter(fn.grab, fn.notify, { result: null });
  h.insertAfter({ event: 'downloadDone' }, fn.check, { result: null });
  h.insertAfter(fn.check, fn.after, { result: null });
  h.updateArgs(fn.importFiles, () => ({ x: 1 }));
  // restart({ from: 1 }) deleted the wait and import.
  const restarted = new HistoryView(journal().slice(0, 1), h.overlay());
  expect(names(restarted)).toEqual(['grab', 'notify']);
  expect(restarted.overlay().map((op) => op.op)).toEqual(['insert']);
});

test('truncate removes every step from a position on, in one operation that spares steps recorded later', () => {
  const h = new HistoryView(journal());
  h.insertAfter({ event: 'downloadDone' }, fn.check, { result: null });
  h.truncate(1);
  expect(names(h)).toEqual(['grab']);
  expect(h.overlay().slice(1)).toEqual([
    { op: 'truncate', from: 'j1', through: 'j2' },
    { op: 'remove', target: '+1' },
  ]);
  // The steps that run again are appended to the journal, and stay.
  const later = new HistoryView([...journal(), done('j3', 'notify'), event('j4', 'downloadDone')], h.overlay());
  expect(names(later)).toEqual(['grab', 'notify', 'downloadDone']);
  const running = new HistoryView([done('j0', 'grab'), event('j1', 'downloadDone', true)]);
  expect(() => running.truncate(0)).toThrow("Can't restart from step 0: downloadDone (j1) is still running.");
});

test('updateResult changes what replay gives a call, for a recorded step or a stand-in', () => {
  const h = new HistoryView(journal());
  h.updateResult(fn.grab, (result) => ({ was: result }));
  h.insertAfter(fn.grab, fn.notify, { result: null });
  h.updateResult(fn.notify, () => ({ at: null }));
  expect(h.result(fn.grab)).toEqual({ was: 'grabbed' });
  expect(h.result(fn.notify)).toEqual({ at: null });
  const replay = new HistoryView(journal(), h.overlay()).replay(0);
  expect(replay[0]!.step.runResult).toEqual({ kind: 'success', returnValue: { was: 'grabbed' } });
  expect(replay[1]!.step.runResult).toEqual({ kind: 'success', returnValue: { at: null } });
  expect(h.fromMigration(0)).toBe(true);
  expect(h.fromMigration(2)).toBe(false);

  const failed = new HistoryView([{ ...done('j0', 'grab'), runResult: { kind: 'failed', error: 'no' } }]);
  expect(() => failed.updateResult(fn.grab, () => 1)).toThrow("updateResult(flows:grab): the step didn't succeed");
  const running = new HistoryView([event('j0', 'downloadDone', true)]);
  expect(() => running.updateResult({ event: 'downloadDone' }, () => 1)).toThrow('still running');
  expect(() => h.updateResult(fn.grab, () => undefined)).toThrow('the update must return the new result');
});

test('updateWorkflowArgs gives replay new workflow args, and keeps one operation', () => {
  const h = new HistoryView(journal(), [], { grabId: 'g' });
  expect(h.workflowArgs).toEqual({ grabId: 'g' });
  h.updateWorkflowArgs((args) => ({ ...args, quality: 'sd' }));
  h.updateWorkflowArgs((args) => ({ ...args, quality: 'hd' }));
  expect(h.workflowArgs).toEqual({ grabId: 'g', quality: 'hd' });
  expect(h.overlay()).toEqual([{ op: 'workflowArgs', args: { grabId: 'g', quality: 'hd' } }]);
  expect(new HistoryView(journal(), h.overlay(), { grabId: 'g' }).workflowArgs).toEqual({ grabId: 'g', quality: 'hd' });
  expect(() => h.updateWorkflowArgs(() => undefined)).toThrow('updateWorkflowArgs: the update must return the new args.');
});

test('cut gives the journal entry a restart deletes from, and an overlay for the steps before it', () => {
  const h = new HistoryView(journal(), [], { grabId: 'g' });
  h.updateWorkflowArgs(() => ({ grabId: 'g', quality: 'hd' }));
  h.insertBefore({ event: 'downloadDone' }, fn.notify, { result: { at: null } }); // anchored to the wait
  h.rename(fn.grab, fn.fetch);
  h.insertAfter({ event: 'downloadDone' }, fn.check, { result: 1, args: { x: 1 } });

  // From the wait: it and import are deleted, so notify is anchored again, after fetch.
  const cut = h.cut(2);
  expect(cut.from).toBe('j1');
  const kept = new HistoryView(journal().slice(0, 1), cut.overlay, { grabId: 'g' });
  expect(names(kept)).toEqual(['fetch', 'notify']);
  expect(kept.result(fn.notify)).toEqual({ at: null });
  expect(kept.workflowArgs).toEqual({ grabId: 'g', quality: 'hd' });

  // From the stand-in after the wait: import is deleted, and the stand-in goes.
  const late = h.cut(3);
  expect(late.from).toBe('j2');
  expect(names(new HistoryView(journal().slice(0, 2), late.overlay))).toEqual(['fetch', 'notify', 'downloadDone']);

  // Past the end: nothing is deleted, and the overlay gives the same history.
  const all = h.cut(h.length);
  expect(all.from).toBeUndefined();
  expect(names(new HistoryView(journal(), all.overlay))).toEqual(names(h));
});

test('cut keeps journal entries the history hides hidden, as ranges', () => {
  const steps = [done('j0', 'grab'), done('j1', 'a'), done('j2', 'b'), done('j3', 'c'), done('j4', 'd'), done('j5', 'e')];
  const h = new HistoryView(steps);
  h.truncate(1); // hides j1..j5
  const later = new HistoryView([...steps, done('j6', 'f'), done('j7', 'g')], h.overlay());
  expect(names(later)).toEqual(['grab', 'f', 'g']);
  later.remove(later.steps[1]!);
  const cut = later.cut(1); // from g
  expect(cut.from).toBe('j7');
  expect(cut.overlay).toEqual([{ op: 'truncate', from: 'j1', through: 'j6' }]);
  expect(names(new HistoryView([...steps, done('j6', 'f')], cut.overlay))).toEqual(['grab']);
});

test('cut throws when every step before the position is a stand-in', () => {
  const h = new HistoryView(journal());
  h.insertBefore(fn.grab, fn.first, { result: null });
  expect(h.cut(0)).toEqual({ from: 'j0', overlay: [] });
  expect(() => h.cut(1)).toThrow("Can't restart from step 1: every step before it was inserted by a migration.");
});

test('lastPosition finds the last step by name or reference', () => {
  const h = new HistoryView([done('j0', 'grab'), event('j1', 'downloadDone'), done('j2', 'grab')]);
  expect(h.lastPosition(fn.grab)).toBe(2);
  expect(h.lastPosition('downloadDone')).toBe(1);
  expect(h.lastPosition({ event: 'downloadDone' })).toBe(1);
  expect(h.lastPosition('missing')).toBe(-1);
});

test('migrateAs counts each migration’s edits, and size attributes the overlay to them', () => {
  const h = new HistoryView(journal());
  expect(h.migrateAs('small', () => h.insertAfter(fn.grab, fn.notify, { result: null }))).toBe(1);
  expect(h.migrateAs('none', () => h.remove(fn.missing))).toBe(0);
  expect(h.migrateAs('big', () => h.updateArgs(fn.importFiles, () => ({ blob: 'x'.repeat(1000) })))).toBe(1);
  expect([...h.editsBy()]).toEqual([
    ['small', 1],
    ['none', 0],
    ['big', 1],
  ]);
  const { bytes, largest } = h.size();
  expect(largest?.id).toBe('big');
  expect(largest!.bytes).toBeGreaterThan(1000);
  expect(bytes).toBeGreaterThan(largest!.bytes);
});

test('a mismatch on a stand-in inserted as a function and called as a workflow says so', () => {
  const call = '{"args":{},"kind":"workflow","name":"flows:child"}';
  const step = '{"args":{},"kind":"function","name":"flows:child"}';
  expect(new ReplayMismatch(1, call, step, true).message).toContain('It was inserted as a function, and called as a workflow');
  expect(new ReplayMismatch(1, call, step, false).message).not.toContain('inserted');
  expect(new ReplayMismatch(1, call, step).reason).toBe('mismatch');
});

test("a pause's detail is cut to DETAIL_LIMIT, and each call of a mismatch on its own", () => {
  const long = 'x'.repeat(DETAIL_LIMIT * 2);
  const pause = new ReplayPause('threw', long);
  expect(pause.detail).toHaveLength(DETAIL_LIMIT);
  expect(pause.detail.endsWith('x…')).toBe(true);
  expect(pause.message).toBe(pause.detail);
  expect(new ReplayPause('threw', 'short').detail).toBe('short');
  const mismatch = new ReplayMismatch(3, `{"args":"${long}"}`, `{"args":"${long}","kind":"event"}`);
  expect(mismatch.expected).toHaveLength(DETAIL_LIMIT);
  expect(mismatch.recorded).toHaveLength(DETAIL_LIMIT);
  expect(mismatch.detail).toBe(`Journal entry mismatch at step 3: the code calls ${mismatch.expected}, the history has ${mismatch.recorded}`);
});

test('returnedEarly: returning before the end of the history is a mismatch', () => {
  const h = new HistoryView(journal());
  expect(returnedEarly(h, { started: false })).toBeUndefined();
  expect(returnedEarly(h, { next: { position: 1 }, started: false })?.detail).toBe(
    'Journal entry mismatch at step 1: the code returned before it, the history has {"args":{},"kind":"event","name":"downloadDone"}',
  );
});

test('threwEarly: which throws pause the run and which fail it', () => {
  const ctx = { validated: true, hasHistory: true, editedNow: [] as string[] };
  const error = new Error('boom');
  const h = new HistoryView(journal());
  // Before a recorded step: pause.
  expect(threwEarly(h, { next: { position: 1 }, started: false }, error, ctx)).toMatchObject({ reason: 'threw', position: 1 });
  // After the last recorded step: a real failure.
  expect(threwEarly(h, { started: false }, error, ctx)).toBeUndefined();
  // After it, but this handler run's migrations edited the history: pause.
  expect(threwEarly(h, { started: false }, error, { ...ctx, editedNow: ['m'] })?.detail).toBe(
    'The handler threw after migrations "m" changed its history: boom',
  );
  // After a step past the history started: fail, since that step is committed.
  expect(threwEarly(h, { next: { position: 1 }, started: true }, error, ctx)).toBeUndefined();
  // Right after a stand-in, with only stand-ins left: pause; before them, after a recorded step: fail.
  const standIns = new HistoryView([done('j0', 'grab')]);
  standIns.insertAfter(fn.grab, fn.notify, { result: null });
  expect(threwEarly(standIns, { started: false }, error, ctx)).toMatchObject({ reason: 'threw', position: 1 });
  expect(threwEarly(standIns, { next: { position: 1 }, started: false }, error, ctx)).toBeUndefined();
  // For a run that failed, only a recorded step left counts.
  expect(threwEarly(standIns, { started: false }, error, { ...ctx, recordedOnly: true, editedNow: ['m'] })).toBeUndefined();
  // The newest recorded step failed, and the handler passes that on: fail, though migrations edited the history now.
  const failedWait = new HistoryView([done('j0', 'grab'), { ...event('j1', 'downloadDone'), runResult: { kind: 'failed', error: 'no' } }]);
  failedWait.insertAfter(fn.grab, fn.notify, { result: null });
  expect(threwEarly(failedWait, { started: false }, error, { ...ctx, editedNow: ['m'] })).toBeUndefined();
  // Unless a migration rewrote that step.
  failedWait.rename({ event: 'downloadDone' }, { event: 'filesReady' });
  expect(threwEarly(failedWait, { started: false }, error, { ...ctx, editedNow: ['m'] })).toMatchObject({ reason: 'threw' });
  // Steps started together count as the newest: one failed, the other, last, succeeded.
  const parallel = new HistoryView([done('j0', 'grab'), { ...done('j1', 'a'), runResult: { kind: 'canceled' } }, { ...done('j2', 'b'), startedAt: 10 }]);
  expect(threwEarly(parallel, { started: false }, error, { ...ctx, editedNow: ['m'] })).toBeUndefined();
  // An older failure, which the handler caught then, doesn't count.
  const older = new HistoryView([{ ...done('j0', 'grab'), runResult: { kind: 'failed', error: 'no' } }, done('j1', 'retry')]);
  expect(threwEarly(older, { started: false }, error, { ...ctx, editedNow: ['m'] })).toMatchObject({ reason: 'threw' });
  // Args that don't validate: pause a run with history, fail a new one.
  expect(threwEarly(h, { next: { position: 0 }, started: false }, error, { ...ctx, validated: false })).toMatchObject({ reason: 'args' });
  expect(threwEarly(new HistoryView([]), { started: false }, error, { ...ctx, validated: false, hasHistory: false })).toBeUndefined();
  // A pause passes through.
  const pause = new ReplayPause('mismatch', 'x');
  expect(threwEarly(h, { started: false }, pause, ctx)).toBe(pause);
});

test('journal entries from old upstream versions without a kind count as functions', () => {
  const entry = { _id: 'j0', step: { name: 'flows:grab', args: {}, inProgress: false, runResult: { kind: 'success', returnValue: null }, startedAt: 5 } };
  expect(recordedStep(entry as unknown as JournalEntry)).toEqual({
    id: 'j0',
    name: 'flows:grab',
    kind: 'function',
    args: {},
    runResult: { kind: 'success', returnValue: null },
    startedAt: 5,
  });
});

test('prepareHistory refuses a record from a newer format, and an overlay over the limit', () => {
  const stored = { applied: [], overlay: [] };
  const newer = prepareHistory(journal(), { ...stored, format: 2 }, [], {});
  expect(newer.blocked).toMatchObject({ reason: 'migrations' });
  expect(newer.blocked?.detail).toContain('format 2, from a newer version');
  expect(prepareHistory(journal(), { ...stored, format: 1 }, [], {}).blocked).toBeUndefined();

  const huge = migration('huge', (h) => h.insertAfter(fn.grab, fn.notify, { result: 'x'.repeat(OVERLAY_LIMIT) }));
  const small = migration('small', (h) => h.insertAfter(fn.grab, fn.log, { result: null }));
  const prepared = prepareHistory(journal(), stored, [small, huge], {});
  expect(prepared.blocked).toMatchObject({ reason: 'overlay' });
  expect(prepared.blocked?.detail).toContain('Migration "huge" added the most');
  expect(prepareHistory(journal(), stored, [small], {}).ran).toEqual([{ id: 'small', edits: 1 }]);

  // An overlay that was just under the limit, and a restart's truncate that takes it over.
  const empty = new HistoryView(journal());
  empty.insertAfter(fn.grab, fn.notify, { result: '' });
  const full = new HistoryView(journal());
  full.insertAfter(fn.grab, fn.notify, { result: 'x'.repeat(OVERLAY_LIMIT - empty.size().bytes - 10) });
  expect(full.size().bytes).toBeLessThan(OVERLAY_LIMIT);
  const restarted = prepareHistory(journal(), { applied: [], overlay: full.overlay(), restart: 2 }, [], {});
  expect(restarted.blocked?.detail).toMatch(/ KiB limit\. The restart added the most, 1 KiB\. Most of it was stored before, \d+ KiB\.$/);
});

test('redactHistory passes every step and the run args through redact', async () => {
  const recorded = {
    workflow: 'flows:pipeline',
    args: { email: 'a@b.c' },
    steps: [
      done('j0', 'grab', { secret: 1 }, { email: 'a@b.c' }),
      { ...done('j1', 'notify'), runResult: { kind: 'failed' as const, error: 'mail to a@b.c bounced' } },
      event('j2', 'downloadDone', true),
    ],
  };
  const seen: string[] = [];
  const scrubbed = await redactHistory(recorded, (value) => {
    seen.push(`${value.kind} ${value.name}`);
    return { ...value, args: { email: 'x' }, ...(value.result === undefined ? {} : { result: 'r' }), ...(value.error === undefined ? {} : { error: 'e' }) };
  });
  expect(seen).toEqual(['function flows:grab', 'function flows:notify', 'event downloadDone', 'run flows:pipeline']);
  expect(scrubbed.args).toEqual({ email: 'x' });
  expect(scrubbed.steps[0]).toMatchObject({ args: { email: 'x' }, runResult: { kind: 'success', returnValue: 'r' } });
  expect(scrubbed.steps[1]!.runResult).toEqual({ kind: 'failed', error: 'e' });
  expect(scrubbed.steps[2]).not.toHaveProperty('runResult');
  expect(recorded.args).toEqual({ email: 'a@b.c' });
});
