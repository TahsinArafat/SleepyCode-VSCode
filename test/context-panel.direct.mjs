import test from 'node:test';
import assert from 'node:assert/strict';
import * as ctx from '../src/context-panel.ts';

/*
 * The classic composer had a context panel: what is going into the request, with a
 * switch per source, the attachments listed, and a reindex action. The React
 * composer sends attachments and nothing else — `ComposerContext` supports
 * project intelligence, the active file and the current selection, and no control
 * has ever set them.
 *
 * So this module owns the switches and the count the composer button shows. The
 * defaults matter: a source that is on by default must send nothing (the host
 * treats absent as on), because sending an explicit `true` for everything would
 * make the request carry a context block the user never asked for.
 */

test('every switch maps to a field the host reads', () => {
  for (const toggle of ctx.CONTEXT_TOGGLES) {
    assert.ok(toggle.id, 'a toggle needs an id');
    assert.ok(toggle.label, `${toggle.id} needs a label`);
    assert.ok(toggle.hint.length > 10, `${toggle.id} needs a hint`);
    assert.ok(toggle.field, `${toggle.id} must name the ComposerContext field it drives`);
  }
  assert.deepEqual(ctx.CONTEXT_TOGGLES.map(t => t.field).sort(), ['includeActiveFile', 'includeProjectIndex', 'includeSelection']);
});

test('the defaults include every source, which means sending nothing', () => {
  // Absent means on, host-side. Emitting `true` for a default would bloat every
  // request with a context block nobody asked for.
  assert.deepEqual(ctx.contextFor(ctx.DEFAULT_CONTEXT), {});
});

test('turning a source off sends the field as false', () => {
  assert.deepEqual(ctx.contextFor({ ...ctx.DEFAULT_CONTEXT, project: false }), { includeProjectIndex: false });
  assert.deepEqual(ctx.contextFor({ ...ctx.DEFAULT_CONTEXT, activeFile: false }), { includeActiveFile: false });
  assert.deepEqual(ctx.contextFor({ ...ctx.DEFAULT_CONTEXT, selection: false }), { includeSelection: false });
});

test('turning one source off does not disturb the others', () => {
  // A patch that emitted every field would flip the others to their defaults.
  assert.deepEqual(
    ctx.contextFor({ project: true, activeFile: false, selection: true }),
    { includeActiveFile: false },
  );
});

test('turning a source back on removes the field rather than sending true', () => {
  const off = ctx.contextFor({ ...ctx.DEFAULT_CONTEXT, selection: false });
  assert.deepEqual(off, { includeSelection: false });
  // Back to default: the key goes away entirely.
  assert.deepEqual(ctx.contextFor({ ...ctx.DEFAULT_CONTEXT, selection: true }), {});
});

test('a toggle can be flipped by id', () => {
  assert.deepEqual(ctx.toggleContext(ctx.DEFAULT_CONTEXT, 'project', false), { ...ctx.DEFAULT_CONTEXT, project: false });
  assert.deepEqual(ctx.toggleContext(ctx.DEFAULT_CONTEXT, 'selection', false), { ...ctx.DEFAULT_CONTEXT, selection: false });
  // An unknown id leaves the state alone instead of inventing a key.
  assert.deepEqual(ctx.toggleContext(ctx.DEFAULT_CONTEXT, 'nope', false), ctx.DEFAULT_CONTEXT);
});

test('the composer button counts what will actually be sent', () => {
  // The number is a promise about the request. Counting a source that is off, or
  // an attachment that was removed, would make it a decoration.
  assert.equal(ctx.contextCount({ ...ctx.DEFAULT_CONTEXT, attachments: 0 }), 3);
  assert.equal(ctx.contextCount({ project: false, activeFile: true, selection: true, attachments: 0 }), 2);
  assert.equal(ctx.contextCount({ project: false, activeFile: false, selection: false, attachments: 0 }), 0);
  assert.equal(ctx.contextCount({ project: false, activeFile: false, selection: false, attachments: 2 }), 2);
  assert.equal(ctx.contextCount({ ...ctx.DEFAULT_CONTEXT, attachments: 4 }), 7);
});

test('a count of zero is stated rather than hidden', () => {
  // The button has to say something; "Context 0" tells a user their sources are
  // off, which is the one case where the number matters most.
  assert.equal(ctx.contextCountLabel(0), 'Context 0');
  assert.equal(ctx.contextCountLabel(3), 'Context 3');
});

test('the empty state appears only when nothing is going in', () => {
  assert.equal(ctx.contextIsEmpty({ project: false, activeFile: false, selection: false, attachments: 0 }), true);
  assert.equal(ctx.contextIsEmpty({ ...ctx.DEFAULT_CONTEXT, attachments: 0 }), false);
  assert.equal(ctx.contextIsEmpty({ project: false, activeFile: false, selection: false, attachments: 1 }), false);
});

test('a stored preference that is not a boolean is normalised, not trusted', () => {
  // These come from persisted workspace state and can be junk.
  const state = ctx.normalizeContext({ project: 'yes', activeFile: 0, selection: null, attachments: 2 });
  assert.equal(state.project, ctx.DEFAULT_CONTEXT.project);
  assert.equal(state.activeFile, ctx.DEFAULT_CONTEXT.activeFile);
  assert.equal(state.selection, ctx.DEFAULT_CONTEXT.selection);
  // Attachments are a count, so a real one is kept…
  assert.equal(state.attachments, 2);
  // …and only a nonsense one becomes 0 rather than NaN.
  assert.equal(ctx.normalizeContext({ attachments: 'many' }).attachments, 0);
  assert.equal(ctx.normalizeContext({ attachments: -3 }).attachments, 0);
  assert.equal(ctx.normalizeContext({ attachments: Number.NaN }).attachments, 0);
  assert.equal(ctx.normalizeContext(undefined).project, ctx.DEFAULT_CONTEXT.project);
});