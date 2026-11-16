// @vitest-environment node
// The history view, its edits, applying a run's pending migrations, and the throw rules.
import { anyApi } from 'convex/server';
import { expect, test } from 'vite-plus/test';

import { HistoryView, type RecordedStep } from '../src/history.ts';
import { migration, prepareHistory, prepareRun, recordedStep } from '../src/migrations.ts';
import { ReplayError, threwEarly } from '../src/replay.ts';
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
  expect(() => h.insertAfter(fn.grab, fn.other, {} as never)).toThrow('insertAfter(flows:grab, flows:other): pass { result } for the stand-in.');
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

test('remove, rename and updateArgs; updateArgs gets a copy of the recorded args', () => {
  const steps = journal();
  const h = new HistoryView(steps);
  h.rename(fn.importFiles, fn.ingest);
  h.updateArgs(fn.ingest, (args) => Object.assign(args, { notifiedAt: null }));
  h.remove(fn.grab);
  expect(names(h)).toEqual(['downloadDone', 'ingest']);
  expect(h.steps[1]!.args).toEqual({ grabId: 'g', notifiedAt: null });
  expect(steps[2]!.args).toEqual({ grabId: 'g' });
  expect(h.replay(0)[1]!.step).toMatchObject({ name: 'flows:ingest', args: { grabId: 'g', notifiedAt: null } });
});

test('a migration reads copies: changing them changes neither the history nor its replay', () => {
  const h = new HistoryView([done('j0', 'grab', { files: ['a'] }, { ids: [1] })]);
  (h.result(fn.grab) as { files: string[] }).files.push('b');
  (h.steps[0]!.args as { ids: number[] }).ids.push(2);
  (h.steps[0]!.result as { files: string[] }).files.push('c');
  expect(h.steps[0]).toMatchObject({ args: { ids: [1] }, result: { files: ['a'] } });
  expect(h.replay(0)[0]!.step).toMatchObject({ args: { ids: [1] }, runResult: { kind: 'success', returnValue: { files: ['a'] } } });
  expect(h.overlay()).toEqual([]);
});

test('an edit that leaves a value as it is stores nothing; a later edit of the same field replaces the earlier one', () => {
  const h = new HistoryView(journal(), [], { grabId: 'g' });
  h.updateResult(fn.grab, (r: unknown) => r);
  h.updateArgs(fn.importFiles, (args) => args);
  h.updateWorkflowArgs((args) => args);
  expect(h.overlay()).toEqual([]);
  h.updateArgs(fn.importFiles, () => ({ x: 1 }));
  h.rename(fn.importFiles, fn.ingest);
  h.updateArgs(fn.ingest, () => ({ x: 2 }));
  h.updateResult(fn.grab, () => 'one');
  h.updateResult(fn.grab, () => 'two');
  expect(h.overlay()).toEqual([
    { op: 'rewrite', target: 'j2', name: 'flows:ingest' },
    { op: 'rewrite', target: 'j2', args: { x: 2 } },
    { op: 'rewrite', target: 'j0', result: 'two' },
  ]);
  expect(new HistoryView(journal(), h.overlay()).replay(0).map((e) => e.step)).toEqual(h.replay(0).map((e) => e.step));
  // A stand-in inserted without args gets them even when they equal its default {}.
  h.insertAfter(fn.grab, fn.notify, { result: null });
  h.updateArgs(fn.notify, () => ({}));
  expect(h.overlay().at(-1)).toEqual({ op: 'rewrite', target: '+1', args: {} });
});

test('an edit whose step is not in the history does nothing', () => {
  const h = new HistoryView(journal());
  h.insertAfter(fn.notify, fn.other, { result: null });
  h.remove(fn.transcode);
  h.rename(fn.prepare, fn.transcode);
  h.updateArgs(fn.prepare, () => ({}));
  h.updateResult(fn.prepare, () => ({}));
  expect(names(h)).toEqual(['grab', 'downloadDone', 'importFiles']);
  expect(h.overlay()).toEqual([]);
});

test('a reference matches at most one step; pass one of h.steps for repeated steps', () => {
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

test('a running step, which only a test history has, takes every edit but updateResult, which leaves it as it is', () => {
  const h = new HistoryView([done('j0', 'grab'), event('j1', 'downloadDone', true), done('j2', 'prepare'), event('j3', 'later', true)]);
  expect(h.steps[1]!.status).toBe('running');
  h.updateResult(h.steps[1]!, () => ({}));
  expect(h.overlay()).toEqual([]);
  h.rename({ event: 'downloadDone' }, { event: 'done' });
  h.updateArgs(h.steps[1]!, () => ({ x: 1 }));
  h.insertBefore({ event: 'done' }, fn.notify, { result: null });
  h.remove({ event: 'later' });
  expect(names(h)).toEqual(['grab', 'notify', 'done (running)', 'prepare']);
  expect(h.steps[2]!.args).toEqual({ x: 1 });
});

test('an insert where no journal entry or stand-in follows does nothing, so the run makes the call; atEnd inserts it anyway', () => {
  // grab ran across the deploy: its result came in, and the run hasn't got further.
  const h = new HistoryView([done('j0', 'grab')]);
  h.insertAfter(fn.grab, fn.notify, { result: null });
  expect(names(h)).toEqual(['grab']);
  h.insertAfter(fn.grab, fn.log, { result: null, atEnd: true });
  expect(names(h)).toEqual(['grab', 'log']);
  // A stand-in follows now, which replay gets before any new call: a call in front of it needs one too.
  h.insertAfter(fn.grab, fn.notify, { result: null });
  h.insertBefore(fn.log, fn.check, { result: null });
  expect(names(h)).toEqual(['grab', 'notify', 'check', 'log']);
  h.insertAfter(fn.log, fn.publish, { result: null });
  expect(names(h)).toEqual(['grab', 'notify', 'check', 'log']);
  expect(h.overlay().map((op) => (op.op === 'insert' ? op.id : op.op))).toEqual(['+1', '+2', '+3']);
});

test('rename keeps the kind of step, and takes a custom name', () => {
  const h = new HistoryView(journal());
  expect(() => h.rename({ event: 'downloadDone' }, fn.grab)).toThrow("rename(event downloadDone, flows:grab): the step's kind (event) must stay the same.");
  expect(() => h.rename(fn.grab, { sleep: 'nap' })).toThrow("the step's kind (function) must stay the same");
  expect(() => h.rename(fn.grab, { workflow: fn.child })).toThrow("the step's kind (function) must stay the same");
  h.rename({ event: 'downloadDone' }, { event: 'filesReady' });
  expect(h.has({ event: 'filesReady' })).toBe(true);
  h.rename(fn.grab, fn.fetch, { name: 'fetch the files' });
  expect(h.steps[0]).toMatchObject({ name: 'fetch the files', kind: 'function' });
});

test('the overlay reloads: later edits see earlier ones, ids stay unique, and an edit of a step gone from the journal throws', () => {
  const h = new HistoryView(journal());
  h.insertAfter(fn.grab, fn.notify, { result: { at: null } });
  h.updateArgs(fn.notify, () => ({ to: 'me' }));
  h.insertAfter(fn.notify, fn.log, { result: null });
  h.rename(fn.notify, fn.alert);
  h.updateArgs(fn.importFiles, () => ({ x: 1 }));
  const reloaded = new HistoryView(journal(), h.overlay());
  expect(names(reloaded)).toEqual(['grab', 'alert', 'log', 'downloadDone', 'importFiles']);
  expect(reloaded.steps[1]).toMatchObject({ args: { to: 'me' }, result: { at: null } });
  reloaded.insertAfter(fn.log, fn.more, { result: null });
  const ids = reloaded.overlay().flatMap((op) => (op.op === 'insert' ? [op.id] : []));
  expect(ids).toEqual(['+1', '+2', '+3']);
  // Upstream's restart({ from: 1 }), called around the manager, deleted the wait and import.
  const gone = () => new HistoryView(journal().slice(0, 1), h.overlay());
  expect(gone).toThrow(ReplayError);
  expect(gone).toThrow("The run's record edits journal entry j2, which was deleted outside the WorkflowManager.");
  expect(() => prepareHistory(journal().slice(0, 1), { applied: [], overlay: h.overlay() }, [], {})).toThrow(expect.objectContaining({ reason: 'record' }));
});

test('updateResult changes what replay gives a call, for a recorded step or a stand-in', () => {
  const h = new HistoryView(journal());
  h.updateResult(fn.grab, (result) => ({ was: result }));
  h.insertAfter(fn.grab, fn.notify, { result: null });
  h.updateResult(fn.notify, () => ({ at: null }));
  const replay = new HistoryView(journal(), h.overlay()).replay(0);
  expect(replay[0]!.step.runResult).toEqual({ kind: 'success', returnValue: { was: 'grabbed' } });
  expect(replay[1]!.step.runResult).toEqual({ kind: 'success', returnValue: { at: null } });
  const failed = new HistoryView([{ ...done('j0', 'grab'), runResult: { kind: 'failed', error: 'no' } }]);
  expect(() => failed.updateResult(fn.grab, () => 1)).toThrow("updateResult(flows:grab): the step didn't succeed");
  expect(() => h.updateResult(fn.grab, () => undefined)).toThrow('the update must return the new result');
});

test('strict, as the /replay helpers run it, an updateResult must leave its own output as it is; at runtime it runs once', () => {
  const wraps = (h: HistoryView) => h.updateResult(fn.grab, (r: unknown) => ({ value: r }));
  expect(() => wraps(new HistoryView(journal(), [], {}, { strict: true }))).toThrow(
    'updateResult(flows:grab): run again on its own output, the update changed it ({"value":"grabbed"} became {"value":{"value":"grabbed"}}).',
  );
  const strict = new HistoryView(journal(), [], {}, { strict: true });
  strict.updateResult(fn.grab, (r: unknown) => (typeof r === 'object' && r !== null && 'value' in r ? r : { value: r }));
  expect(strict.result(fn.grab)).toEqual({ value: 'grabbed' });
  let calls = 0;
  const runtime = new HistoryView(journal());
  runtime.updateResult(fn.grab, (r: unknown) => (calls++, { value: r }));
  expect([calls, runtime.result(fn.grab)]).toEqual([1, { value: 'grabbed' }]);
  // So must an updateWorkflowArgs.
  expect(() => new HistoryView(journal(), [], { n: 1 }, { strict: true }).updateWorkflowArgs((a: { n: number }) => ({ n: a.n + 1 }))).toThrow(
    'updateWorkflowArgs: run again on its own output, the update changed it ({"n":2} became {"n":3}).',
  );
  const args = new HistoryView(journal(), [], { n: 1 }, { strict: true });
  args.updateWorkflowArgs((a: object) => ({ channel: 'default', ...a }));
  expect(args.workflowArgs).toEqual({ n: 1, channel: 'default' });
  new HistoryView(journal(), [], { n: 1 }).updateWorkflowArgs((a: { n: number }) => (calls++, { n: a.n + 1 }));
  expect(calls).toBe(2);
});

test('updateWorkflowArgs gives replay new workflow args; the latest wins, and replaces the earlier one', () => {
  const h = new HistoryView(journal(), [], { grabId: 'g' });
  h.updateWorkflowArgs((args) => ({ ...args, quality: 'sd' }));
  h.updateWorkflowArgs((args) => ({ ...args, quality: 'hd' }));
  expect(h.workflowArgs).toEqual({ grabId: 'g', quality: 'hd' });
  expect(h.overlay()).toEqual([{ op: 'workflowArgs', args: { grabId: 'g', quality: 'hd' } }]);
  expect(new HistoryView(journal(), h.overlay(), { grabId: 'g' }).workflowArgs).toEqual({ grabId: 'g', quality: 'hd' });
  expect(() => h.updateWorkflowArgs(() => undefined)).toThrow('updateWorkflowArgs: the update must return the new args.');
});

test('journal entries from old upstream versions without a kind count as functions', () => {
  const entry = { _id: 'j0', step: { name: 'flows:grab', args: {}, inProgress: false, runResult: { kind: 'success', returnValue: null }, startedAt: 5 } };
  expect(recordedStep(entry as unknown as JournalEntry)).toMatchObject({ id: 'j0', kind: 'function', startedAt: 5 });
});

test('prepareHistory applies the pending migrations, and refuses what it cannot apply', () => {
  const notify = migration('notify', (h) => h.insertAfter(fn.grab, fn.notify, { result: null }));
  const none = migration('none', (h) => h.remove(fn.missing));
  const prepared = prepareHistory(journal(), { applied: ['notify'], overlay: [] }, [notify, none], {});
  expect([prepared.applied, prepared.ran]).toEqual([['notify', 'none'], ['none']]);
  const all = prepareHistory(journal(), { applied: [], overlay: [] }, [notify, none], {});
  expect([all.ran, names(all.history)]).toEqual([
    ['notify', 'none'],
    ['grab', 'notify', 'downloadDone', 'importFiles'],
  ]);
  // Applied ids that aren't a prefix of the list: removed, reordered, or a rollback.
  expect(() => prepareHistory(journal(), { applied: ['none'], overlay: [] }, [notify, none], {})).toThrow(
    'The run has migrations "none" applied, but this code lists "notify", "none". Its applied ids must start the list',
  );
  expect(() => prepareHistory(journal(), { applied: ['notify', 'none', 'later'], overlay: [] }, [notify, none], {})).toThrow(
    'The run has migrations "notify", "none", "later" applied',
  );
  const broken = migration('broken', (h) => {
    const grab = h.steps[0]!;
    h.remove(grab);
    h.remove(grab);
  });
  expect(() => prepareHistory(journal(), { applied: [], overlay: [] }, [broken], {})).toThrow(
    'Migration "broken" threw: remove(flows:grab (j0)): that step isn\'t in the history any more.',
  );
});

test('prepareRun: applied ids are used; without them, the journal or the args decide', () => {
  const notify = migration('notify', (h) => h.insertAfter(fn.grab, fn.notify, { result: null }));
  const channel = migration('channel', (h) => h.updateWorkflowArgs((args) => ({ ...args, channel: 'default' })));
  const hasChannel = (args: unknown) => typeof (args as { channel?: unknown }).channel === 'string';
  const list = [notify, channel];
  // Applied ids: the pending ones apply, to an empty history too (a queued run).
  expect(prepareRun([], { applied: ['notify'], overlay: [] }, list, { grabId: 'g' }, hasChannel).history.workflowArgs).toEqual({
    grabId: 'g',
    channel: 'default',
  });
  // None, with journal entries: from before the first migration, so every migration applies.
  expect(prepareRun(journal(), { overlay: [] }, list, {}, hasChannel).ran).toEqual(['notify', 'channel']);
  // None, and an empty journal (a queued child): args that pass mean the code that started it is this one.
  const current = prepareRun([], { overlay: [] }, list, { channel: 'main' }, hasChannel);
  expect([current.applied, current.ran, current.history.workflowArgs]).toEqual([['notify', 'channel'], [], { channel: 'main' }]);
  // Args that don't pass: the list runs from the start, where only updateWorkflowArgs does anything.
  const old = prepareRun([], { overlay: [] }, list, { grabId: 'g' }, hasChannel);
  expect([old.applied, old.history.workflowArgs, old.history.steps]).toEqual([['notify', 'channel'], { grabId: 'g', channel: 'default' }, []]);
});

const failed = (step: RecordedStep): RecordedStep => ({ ...step, runResult: { kind: 'failed', error: 'it broke' } });
const atEnd = (h: HistoryView) => h.insertAfter(fn.importFiles, fn.publish, { result: null, atEnd: true });
test.each([
  ['1: a step past the history started', journal(), () => {}, { started: true }, [], undefined],
  ['2: a recorded step is left', journal(), () => {}, { next: { position: 1 }, started: false }, [], 'before step 1 of its history'],
  ['3: the last step it got is a stand-in', journal(), atEnd, { started: false }, ['m'], 'after step 3 of its history, which a migration'],
  [
    '3: the last step it got has a changed result',
    journal(),
    (h: HistoryView) => h.updateResult(fn.importFiles, () => 1),
    { started: false },
    [],
    'after step 2',
  ],
  [
    '4: the newest steps include a failure',
    [...journal().slice(0, 2), failed(journal()[2]!)],
    atEnd,
    { next: { position: 3 }, started: false },
    ['m'],
    undefined,
  ],
  [
    '5, not 4: a migration rewrote the failure',
    [...journal().slice(0, 2), failed(journal()[2]!)],
    (h: HistoryView) => h.rename(fn.importFiles, fn.load),
    { started: false },
    ['m'],
    'after migrations "m" changed',
  ],
  [
    '5, not 4: the failure is last only because a migration removed the steps after it',
    [journal()[0]!, failed(journal()[1]!), journal()[2]!],
    (h: HistoryView) => h.remove(fn.importFiles),
    { started: false },
    ['m'],
    'after migrations "m" changed',
  ],
  ['5: migrations edited the history in this handler run', journal(), () => {}, { started: false }, ['m'], 'after migrations "m" changed its history: oops'],
  ['6: otherwise', journal(), () => {}, { started: false }, [], undefined],
] as const)('throw rule %s', (_, steps, edit, progress, edited, detail) => {
  const h = new HistoryView(steps);
  edit(h);
  const pause = threwEarly(h, progress, new Error('oops'), edited);
  if (detail === undefined) expect(pause).toBeUndefined();
  else expect(pause).toMatchObject({ reason: 'threw', message: expect.stringContaining(detail) });
});
