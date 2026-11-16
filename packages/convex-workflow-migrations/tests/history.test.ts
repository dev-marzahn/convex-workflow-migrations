// @vitest-environment node
import { anyApi } from 'convex/server';
import { expect, test } from 'vite-plus/test';

import { capDetail, DETAIL_LIMIT } from '../src/component/schema.ts';
import { HistoryView, type OverlayOp, type RecordedStep, ReplayMismatch, ReplayPause } from '../src/history.ts';
import { migration, OVERLAY_LIMIT, prepareHistory, recordedStep } from '../src/migrations.ts';
import { redactHistory } from '../src/redact.ts';
import { returnedEarly, threwEarly } from '../src/replay.ts';
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
  // Nothing follows the running step, so this one needs atEnd.
  h.insertAfter({ event: 'downloadDone' }, fn.after, { result: null, atEnd: true });
  expect(names(h)).toEqual(['grab', 'notify', 'downloadDone (running)', 'after']);
});

test('an insert where no journal entry follows does nothing, so the run makes the call; atEnd inserts it anyway', () => {
  // grab ran across the deploy: its result came in, and the run hasn't got further.
  const h = new HistoryView([done('j0', 'grab')]);
  h.insertAfter(fn.grab, fn.notify, { result: null });
  expect(names(h)).toEqual(['grab']);
  // Only stand-ins after the anchor count as nothing.
  h.insertAfter(fn.grab, fn.log, { result: null, atEnd: true });
  h.insertAfter(fn.grab, fn.notify, { result: null });
  h.insertBefore(fn.log, fn.check, { result: null });
  expect(names(h)).toEqual(['grab', 'log']);
  h.insertBefore(fn.log, fn.check, { result: null, atEnd: true });
  expect(names(h)).toEqual(['grab', 'check', 'log']);
  expect(h.overlay().map((op) => (op.op === 'insert' ? op.id : op.op))).toEqual(['+1', '+2']);
  // insertBefore a journal entry always has one after it.
  const waiting = new HistoryView([done('j0', 'grab'), event('j1', 'downloadDone', true)]);
  waiting.insertAfter(fn.grab, fn.notify, { result: null });
  waiting.insertBefore({ event: 'downloadDone' }, fn.log, { result: null });
  expect(names(waiting)).toEqual(['grab', 'notify', 'log', 'downloadDone (running)']);
});

test('rename keeps the kind of step', () => {
  const h = new HistoryView(journal());
  expect(() => h.rename({ event: 'downloadDone' }, fn.grab)).toThrow("rename(event downloadDone, flows:grab): the step's kind (event) must stay the same.");
  expect(() => h.rename(fn.grab, { sleep: 'nap' })).toThrow("the step's kind (function) must stay the same");
  expect(() => h.rename(fn.grab, { workflow: fn.child })).toThrow("the step's kind (function) must stay the same");
  h.rename({ event: 'downloadDone' }, { event: 'filesReady' });
  expect(h.has({ event: 'filesReady' })).toBe(true);
  // To a call made with a custom name option: matched by that name, of the reference's kind.
  h.rename(fn.grab, fn.fetch, { name: 'fetch the files' });
  expect(h.steps[0]).toMatchObject({ name: 'fetch the files', kind: 'function' });
  expect(h.replay(0)[0]!.step.name).toBe('fetch the files');
});

test('capDetail never cuts inside a surrogate pair', () => {
  const emoji = '\u{1F4E6}'; // two UTF-16 code units
  expect(capDetail(`ab${emoji}cd`, 4)).toBe('ab…');
  expect(capDetail(`abc${emoji}`, 4)).toBe('abc…');
  expect(capDetail(`a${emoji}bc`, 4)).toBe(`a${emoji}…`);
  expect(capDetail('abcd', 4)).toBe('abcd');
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

test('truncate from a stand-in that leads the history, and position and idAt find steps by id', () => {
  const h = new HistoryView(journal());
  h.insertBefore(fn.grab, fn.first, { result: null });
  expect(h.idAt(0)).toBe('+1');
  expect(h.idAt(4)).toBeUndefined();
  expect(h.position('j1')).toBe(2);
  expect(h.position('gone')).toBe(-1);
  h.truncate(0);
  expect(names(h)).toEqual([]);
  expect(h.overlay().slice(1)).toEqual([
    { op: 'truncate', from: 'j0', through: 'j2' },
    { op: 'remove', target: '+1' },
  ]);
});

test('lastPosition finds the last step by name or reference', () => {
  const h = new HistoryView([done('j0', 'grab'), event('j1', 'downloadDone'), done('j2', 'grab')]);
  expect(h.lastPosition(fn.grab)).toBe(2);
  expect(h.lastPosition('downloadDone')).toBe(1);
  expect(h.lastPosition({ event: 'downloadDone' })).toBe(1);
  expect(h.lastPosition('missing')).toBe(-1);
});

test('migrateAs counts the edits a migration makes, and size is the stored overlay’s', () => {
  const h = new HistoryView(journal());
  expect(h.size()).toBe(0);
  expect(h.migrateAs(() => h.insertAfter(fn.grab, fn.notify, { result: null }))).toBe(1);
  expect(h.migrateAs(() => h.remove(fn.missing))).toBe(0);
  const small = h.size();
  expect(h.migrateAs(() => h.updateArgs(fn.importFiles, () => ({ blob: 'x'.repeat(1000) })))).toBe(1);
  expect(h.size() - small).toBeGreaterThan(1000);
  // A restart's cut is no migration's edit.
  expect(h.migrateAs(() => h.truncate(1))).toBe(0);
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
  standIns.insertAfter(fn.grab, fn.notify, { result: null, atEnd: true });
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
  // Nor does one that is last only because a migration removed the steps after it: the newest steps are the journal's.
  const caught = new HistoryView([done('j0', 'grab'), { ...done('j1', 'notify'), runResult: { kind: 'failed', error: 'no' } }, event('j2', 'downloadDone')]);
  caught.remove({ event: 'downloadDone' });
  expect(threwEarly(caught, { started: false }, error, { ...ctx, editedNow: ['m'] })).toMatchObject({ reason: 'threw' });
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
  const none = migration('none', (h) => h.remove(fn.missing));
  const prepared = prepareHistory(journal(), stored, [small, none, huge], {});
  expect(prepared.blocked).toMatchObject({ reason: 'overlay' });
  expect(prepared.blocked?.detail).toMatch(
    /^The run's overlay would be \d+ KiB, over the 512 KiB limit\. This handler run added to it: migration "small", migration "huge"\.$/,
  );
  expect(prepareHistory(journal(), stored, [small, none], {}).ran).toEqual([
    { id: 'small', edits: 1 },
    { id: 'none', edits: 0 },
  ]);

  // An overlay that was just under the limit, and a restart's truncate that takes it over.
  const empty = new HistoryView(journal());
  empty.insertAfter(fn.grab, fn.notify, { result: '' });
  const full = new HistoryView(journal());
  full.insertAfter(fn.grab, fn.notify, { result: 'x'.repeat(OVERLAY_LIMIT - empty.size() - 10) });
  expect(full.size()).toBeLessThan(OVERLAY_LIMIT);
  const restarted = prepareHistory(journal(), { applied: [], overlay: full.overlay(), restartFrom: 2 }, [], {});
  expect(restarted.blocked?.detail).toMatch(/ KiB limit\. This handler run added to it: the restart\.$/);
});

test("prepareHistory's restartFrom checks the position still means what the pause saw", () => {
  const notify = migration('notify', (h) => h.insertAfter(fn.grab, fn.notify, { result: null }));
  const log = migration('log', (h) => h.insertAfter({ event: 'downloadDone' }, fn.log, { result: null }));
  const stored = { applied: [], overlay: [] };
  // Paused at the stand-in, position 1, with one migration applied.
  const pause = { step: 1, stepId: '+1', appliedCount: 1 };
  expect(names(prepareHistory(journal(), { ...stored, restartFrom: 1, pause }, [notify], {}).history)).toEqual(['grab']);
  // A release added a migration: the count changed.
  expect(() => prepareHistory(journal(), { ...stored, restartFrom: 1, pause }, [notify, log], {})).toThrow(
    'restartFrom: the history changed since the run paused',
  );
  // The paused step moved: another step is at its position.
  const moved = { step: 1, stepId: 'j1', appliedCount: 1 };
  expect(() => prepareHistory(journal(), { ...stored, restartFrom: 2, pause: moved }, [notify], {})).toThrow('the history changed since the run paused');
  // A pause without a step only checks the count.
  expect(names(prepareHistory(journal(), { ...stored, restartFrom: 2, pause: { appliedCount: 1 } }, [notify], {}).history)).toEqual(['grab', 'notify']);
  expect(() => prepareHistory(journal(), { ...stored, restartFrom: 4 }, [notify], {})).toThrow('step must be below 4, got 4');
});

test("prepareHistory's restart: a step upstream deleted leaves nothing to cut, a step a migration removed pauses", () => {
  const drop = migration('drop-wait', (h) => h.remove({ event: 'downloadDone' }));
  // Upstream's restart deleted the wait and import; the stand-in after the wait went with them.
  const overlay: OverlayOp[] = [
    { op: 'insert', id: '+1', where: 'after', anchor: 'j0', name: 'flows:notify', kind: 'function', result: null },
    { op: 'insert', id: '+2', where: 'after', anchor: 'j1', name: 'flows:check', kind: 'function', result: null },
  ];
  const kept = journal().slice(0, 1);
  for (const restart of ['j1', '+2']) {
    const prepared = prepareHistory(kept, { applied: [], overlay, restart }, [], {});
    expect(prepared.blocked).toBeUndefined();
    expect(names(prepared.history)).toEqual(['grab', 'notify']);
  }
  expect(prepareHistory(journal(), { applied: [], overlay: [], restart: 'j1' }, [drop], {}).blocked?.detail).toContain('a migration removed it');
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

test('redactHistory passes the overlay’s stand-ins, rewrites and workflow args through redact', async () => {
  const overlay: OverlayOp[] = [
    { op: 'insert', id: '+1', where: 'after', anchor: 'j0', name: 'flows:notify', kind: 'function', result: { to: 'a@b.c' } },
    { op: 'insert', id: '+2', where: 'after', anchor: '+1', name: 'flows:log', kind: 'function', args: { email: 'a@b.c' }, result: null },
    { op: 'rewrite', target: 'j0', name: 'flows:fetch' },
    { op: 'rewrite', target: 'j0', args: { email: 'a@b.c', quality: 'hd' } },
    { op: 'rewrite', target: '+1', result: { to: 'a@b.c', at: 1 } },
    { op: 'workflowArgs', args: { email: 'a@b.c', quality: 'hd' } },
    { op: 'remove', target: 'j1' },
  ];
  const recorded = {
    workflow: 'flows:pipeline',
    args: { email: 'a@b.c' },
    steps: [done('j0', 'grab', null, { email: 'a@b.c' }), event('j1', 'downloadDone')],
    overlay,
  };
  const seen: string[] = [];
  const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).replaceAll('a@b.c', 'x'));
  const scrubbed = await redactHistory(recorded, (value) => {
    seen.push(`${value.kind} ${value.name}${'result' in value ? ' with result' : ''}`);
    return { ...value, args: scrub(value.args), ...('result' in value ? { result: scrub(value.result) } : {}) };
  });
  expect(seen).toEqual([
    'function flows:grab with result',
    'event downloadDone with result',
    'run flows:pipeline',
    'function flows:notify with result',
    'function flows:log with result',
    'function flows:fetch', // renamed by the rewrite before it
    'function flows:notify with result',
    'run flows:pipeline',
  ]);
  expect(JSON.stringify(scrubbed)).not.toContain('a@b.c');
  // Only the data changes: a stand-in without args stays without them, and a rename-only rewrite stays as it was.
  expect(scrubbed.overlay).toEqual([
    { ...overlay[0], result: { to: 'x' } },
    { ...overlay[1], args: { email: 'x' } },
    overlay[2],
    { ...overlay[3], args: { email: 'x', quality: 'hd' } },
    { ...overlay[4], result: { to: 'x', at: 1 } },
    { op: 'workflowArgs', args: { email: 'x', quality: 'hd' } },
    overlay[6],
  ]);
  expect(JSON.stringify(recorded)).toContain('a@b.c');
});
