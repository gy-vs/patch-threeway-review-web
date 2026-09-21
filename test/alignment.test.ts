import {describe, expect, it} from 'vitest';
import {alignSide, lcsAlign, opGroupKey, parseTexts, withBaselineIds} from '../src/server/blocks';
import {buildGroups} from '../src/server/groups';
import {applyEffects, applyInverses, materialize} from '../src/server/engine';

const base = (texts: string[]) => withBaselineIds(texts);

function analyze(baselineText: string, localText: string, remoteText: string) {
  const baseline = base(parseTexts(baselineText));
  const local = alignSide(baseline, parseTexts(localText), 'local');
  const remote = alignSide(baseline, parseTexts(remoteText), 'remote');
  const {groups} = buildGroups(baseline, local, remote);
  return {baseline, local, remote, groups};
}

describe('alignment', () => {
  it('classifies edit, delete, insert, move', () => {
    const baseline = base(['A', 'B', 'C', 'D']);
    // side: A moves to the very end; NEW is inserted before it
    const side = alignSide(
      baseline,
      ['B', 'C', 'D', 'NEW', 'A'],
      'local',
    );
    const kinds = side.ops.map(op => op.kind).sort();
    expect(kinds).toEqual(['insert', 'move'].sort());
    const move = side.ops.find(op => op.kind === 'move')!;
    expect(move.blockId).toBe('b1');
    const insert = side.ops.find(op => op.kind === 'insert')!;
    expect(insert).toMatchObject({text: 'NEW'});
    // origins cover every side block exactly once
    expect(side.origins).toHaveLength(5);
    expect(new Set(side.origins).size).toBe(5);
  });

  it('classifies edit and delete as distinct ops', () => {
    const baseline = base(['A', 'B', 'C']);
    const side = alignSide(baseline, ['A edited', 'C'], 'local');
    expect(side.ops.find(op => op.kind === 'edit')).toMatchObject({blockId: 'b1'});
    expect(side.ops.find(op => op.kind === 'delete')).toMatchObject({blockId: 'b2'});
  });

  it('detects a split of one block into two', () => {
    const baseline = base(['A', 'B']);
    const side = alignSide(baseline, ['A', 'B1', 'B2'], 'local');
    const split = side.ops.find(op => op.kind === 'split');
    expect(split).toMatchObject({kind: 'split', blockId: 'b2', parts: ['B1', 'B2']});
  });

  it('detects a merge of two blocks into one', () => {
    const baseline = base(['A', 'B', 'C']);
    const side = alignSide(baseline, ['A', 'B+C'], 'local');
    const merge = side.ops.find(op => op.kind === 'merge');
    expect(merge).toMatchObject({kind: 'merge', blockIds: ['b2', 'b3'], text: 'B+C'});
  });

  it('handles repeated paragraphs without merging identities', () => {
    const baseline = base(['X', 'dup', 'dup', 'Y']);
    const side = alignSide(baseline, ['X', 'dup', 'dup', 'dup', 'Y'], 'local');
    // exactly one insertion, the three dup blocks remain individually aligned
    const inserts = side.ops.filter(op => op.kind === 'insert');
    expect(inserts).toHaveLength(1);
    const origins = side.origins.filter(origin => origin === 'b2' || origin === 'b3');
    expect(origins).toHaveLength(2);
  });

  it('edit + delete next door is not classified as a merge', () => {
    const baseline = base(['the quick brown fox', 'contact dev team by email']);
    const side = alignSide(
      baseline,
      ['the quick brown fox jumps high'],
      'local',
    );
    expect(side.ops.find(op => op.kind === 'merge')).toBeUndefined();
    expect(side.ops.find(op => op.kind === 'edit')?.blockId).toBe('b1');
    expect(side.ops.find(op => op.kind === 'delete')?.blockId).toBe('b2');
  });

  it('lcs keeps multiplicity for duplicates', () => {
    const pairs = lcsAlign(['d', 'd'], ['d', 'd', 'd']);
    expect(pairs.filter(p => p.type === 'match')).toHaveLength(2);
    expect(pairs.filter(p => p.type === 'ins')).toHaveLength(1);
  });
});

describe('three-way groups', () => {
  it('same block edited on both sides -> edit_edit conflict', () => {
    const {groups} = analyze(
      'A\nB\nC',
      'A\nB local change\nC',
      'A\nB remote change\nC',
    );
    const group = groups.find(g => g.blockIds.includes('b2'))!;
    expect(group.auto).toBe(false);
    expect(group.conflict).toBe('edit_edit');
  });

  it('identical edits on both sides auto-compose', () => {
    const {groups} = analyze('A\nB', 'A\nB!', 'A\nB!');
    const group = groups.find(g => g.blockIds.includes('b2'))!;
    expect(group.auto).toBe(true);
  });

  it('move on one side + edit on the other auto-composes', () => {
    const {groups} = analyze(
      'A\nB\nC',
      'A\nB edited text\nC',
      'A\nC\nB',
    );
    const group = groups.find(g => g.blockIds.includes('b2'))!;
    expect(group.kind).toBe('dual');
    expect(group.auto).toBe(true);
    const outcome = applyEffects(
      base(['A', 'B', 'C']).map(b => ({origin: b.id, text: b.text})),
      materialize(group, 'auto'),
    );
    expect(outcome.blocks.map(b => b.text)).toEqual(['A', 'C', 'B edited text']);
  });

  it('split vs merge on overlapping block -> split_vs_merge conflict', () => {
    const {groups} = analyze(
      'A\nB\nC',
      'A\nB1\nB2\nC', // split B
      'A\nA+B+C', // merge A,B,C (LCS anchors on A, residual merges B,C)
    );
    const conflict = groups.find(g => !g.auto);
    expect(conflict?.conflict).toBe('split_vs_merge');
    expect(conflict?.blockIds.sort()).toEqual(['b2', 'b3']);
  });

  it('delete on one side + edit on the other -> delete_vs_change', () => {
    const {groups} = analyze(
      'A\nB\nC',
      'A\nB changed locally\nC',
      'A\nC',
    );
    const group = groups.find(g => g.blockIds.includes('b2'))!;
    expect(group.auto).toBe(false);
    expect(group.conflict).toBe('delete_vs_change');
  });

  it('both sides delete the same block -> auto', () => {
    const {groups} = analyze('A\nB', 'A', 'A');
    const group = groups.find(g => g.blockIds.includes('b2'))!;
    expect(group.auto).toBe(true);
  });

  it('disjoint changes on the same blocks never collide group-wise', () => {
    const {groups} = analyze(
      'A\nB\nC',
      'A\nBl\nC',
      'A\nB\nCr',
    );
    const ids = groups.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('group keys are stable origin-derived strings', () => {
    const {groups} = analyze('A\nB', 'A\nB2', 'A\nB3');
    expect(groups[0].id).toMatch(/^grp:/);
    // rebuilding gives the same id
    const again = analyze('A\nB', 'A\nB2', 'A\nB3');
    expect(again.groups[0].id).toBe(groups[0].id);
  });
});

describe('effect materialization', () => {
  it('applies a local decision', () => {
    const {groups} = analyze('A\nB', 'A\nB-local', 'A\nB-remote');
    const group = groups.find(g => g.blockIds.includes('b2'))!;
    const current = base(['A', 'B']).map(b => ({origin: b.id, text: b.text}));
    const outcome = applyEffects(current, materialize(group, 'local'));
    expect(outcome.blocks.map(b => b.text)).toEqual(['A', 'B-local']);
  });

  it('merged custom text replaces multi-block groups', () => {
    const {groups} = analyze(
      'A\nB\nC',
      'A\nB1\nB2\nC',
      'A\nA+B+C',
    );
    const group = groups.find(g => g.conflict === 'split_vs_merge')!;
    const current = base(['A', 'B', 'C']).map(b => ({origin: b.id, text: b.text}));
    const outcome = applyEffects(current, materialize(group, 'merged', 'hand made text'));
    // A sits outside the merged footprint (b2,b3) and is left untouched.
    expect(outcome.blocks.map(b => b.text)).toEqual(['A', 'hand made text']);
  });

  it('undo restores the pre-commit document exactly', () => {
    const {groups} = analyze('A\nB\nC', 'A\nB2\nC', 'A\nB\nC3');
    const current = base(['A', 'B', 'C']).map(b => ({origin: b.id, text: b.text}));
    const editGroup = groups.find(g => g.blockIds.includes('b2'))!;
    const first = applyEffects(current, materialize(editGroup, 'local'));
    const otherGroup = groups.find(g => g.blockIds.includes('b3'))!;
    const second = applyEffects(first.blocks, materialize(otherGroup, 'remote'));
    expect(second.blocks.map(b => b.text)).toEqual(['A', 'B2', 'C3']);
    const undone = applyInverses(second.blocks, second.inverses);
    expect(undone.map(b => b.text)).toEqual(first.blocks.map(b => b.text));
    const allUndone = applyInverses(undone, first.inverses);
    expect(allUndone.map(b => b.text)).toEqual(['A', 'B', 'C']);
  });

  it('pending blocks keep identity after unrelated index shifts', () => {
    // Commit an insert above; a pending edit's block origin must remain valid.
    const {groups} = analyze(
      'A\nB',
      'NEW\nA\nB',
      'A\nB changed remote',
    );
    const insert = groups.find(g => g.kind === 'insert')!;
    const pending = groups.find(g => g.blockIds.includes('b2'))!;
    let blocks = base(['A', 'B']).map(b => ({origin: b.id, text: b.text}));
    const afterInsert = applyEffects(blocks, materialize(insert, 'auto'));
    blocks = afterInsert.blocks;
    // the pending group still references baseline origin b2, which exists
    expect(blocks.some(b => b.origin === 'b2')).toBe(true);
    // applying the pending decision later lands on the same identity
    const final = applyEffects(blocks, materialize(pending, 'remote'));
    expect(final.blocks.map(b => b.text)).toEqual(['NEW', 'A', 'B changed remote']);
  });

  it('materialize key for every op kind is defined', () => {
    const baseline = base(['A', 'B']);
    const side = alignSide(baseline, ['A2', 'B'], 'local');
    for (const op of side.ops) expect(opGroupKey(op)).toBeTruthy();
  });
});
