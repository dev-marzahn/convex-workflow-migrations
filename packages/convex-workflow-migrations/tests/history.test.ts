// @vitest-environment node
import { anyApi } from 'convex/server';
import { expect, test } from 'vite-plus/test';

import { HistoryView, type RecordedStep } from '../src/history.ts';
import { recordedStep } from '../src/migrations.ts';
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

test('a runLate step is pending until replay issues it, then takes its journal entry', () => {
  const h = new HistoryView(journal());
  h.insertAfter(fn.grab, fn.audit, { runLate: true, args: { why: 'backfill' } });
  expect(names(h)).toEqual(['grab', 'audit (pending)', 'downloadDone', 'importFiles']);
  const entry = h.replay(500)[1]!;
  expect(entry.step).toMatchObject({ name: 'flows:audit', args: { why: 'backfill' }, inProgress: false, startedAt: 500 });
  entry.late!('j3');
  expect(h.lateStepRan).toBe(true);

  // The next handler run: the entry was appended to the journal, and sits where the step was inserted.
  const again = new HistoryView([...journal(), done('j3', 'audit', 'audited', { why: 'backfill' })], h.overlay());
  expect(names(again)).toEqual(['grab', 'audit', 'downloadDone', 'importFiles']);
  expect(again.result(fn.audit)).toBe('audited');
  expect(again.replay(0)[1]!.late).toBeUndefined();
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

test('insert needs a result or runLate with args', () => {
  const h = new HistoryView(journal());
  expect(() => h.insertAfter(fn.grab, fn.notify, {} as never)).toThrow('pass { result } for a stand-in, or { runLate: true, args }');
  expect(() => h.insertAfter(fn.grab, fn.notify, { runLate: true } as never)).toThrow('needs its args');
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

test('a late step whose entry a restart deleted runs again', () => {
  const overlay = [
    { op: 'insertLate' as const, id: '+1', where: 'after' as const, anchor: 'j0', name: 'flows:audit', kind: 'function' as const, args: {}, executedAs: 'j9' },
  ];
  const h = new HistoryView(journal(), overlay);
  expect(names(h)).toEqual(['grab', 'audit (pending)', 'downloadDone', 'importFiles']);
  expect(h.overlay()[0]).not.toHaveProperty('executedAs');
});

test('truncate removes every step from a position on', () => {
  const h = new HistoryView(journal());
  h.insertAfter({ event: 'downloadDone' }, fn.check, { result: null });
  h.truncate(1);
  expect(names(h)).toEqual(['grab']);
  const running = new HistoryView([done('j0', 'grab'), event('j1', 'downloadDone', true)]);
  expect(() => running.truncate(0)).toThrow("Can't restart from step 0: downloadDone (j1) is still running.");
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
