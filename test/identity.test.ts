import {describe, expect, it} from 'vitest';
import {alignSide, parseTexts, withBaselineIds} from '../src/server/blocks';
import {buildGroups} from '../src/server/groups';
import {applyEffects, applyInverses, materialize} from '../src/server/engine';

const toBase = (text: string) => withBaselineIds(parseTexts(text));
const originsOf = (text: string) => text.split('\n').map((_, i) => `b${i + 1}`);

describe('stable identity guarantees', () => {
  it('editing preserves the baseline origin', () => {
    const baseline = toBase('A\nB');
    const side = alignSide(baseline, ['A', 'B changed'], 'local');
    const edited = side.origins[1];
    expect(edited).toBe('b2');
  });

  it('split first part keeps parent origin, other parts derive stable ids', () => {
    const baseline = toBase('A\nB');
    const side = alignSide(baseline, ['A', 'B1', 'B2'], 'local');
    expect(side.origins).toEqual(['b1', 'b2', 'split:b2:1']);
  });

  it('merge keeps the first member origin', () => {
    const baseline = toBase('A\nB\nC');
    const side = alignSide(baseline, ['A', 'B and C merged together here'], 'local');
    const merge = side.ops.find(op => op.kind === 'merge');
    expect(merge).toBeDefined();
    expect(side.origins[1]).toBe('b2');
  });

  it('repeated paragraphs get distinct origins that survive edits around them', () => {
    const baseline = toBase('X\ndup\ndup\nY');
    const side = alignSide(baseline, ['X edited harder', 'dup', 'dup', 'Y'], 'local');
    const dupOrigins = side.origins.filter((_, i) => i === 1 || i === 2);
    expect(dupOrigins).toEqual(['b2', 'b3']);
    expect(new Set(dupOrigins).size).toBe(2);
  });

  it('committed final text is stable after an unrelated later commit', () => {
    const baseline = toBase('A\nB\nC').map(b => ({origin: b.id, text: b.text}));
    const groupsB = buildGroups(
      toBase('A\nB\nC'),
      alignSide(toBase('A\nB\nC'), ['A', 'B-final', 'C'], 'local'),
      alignSide(toBase('A\nB\nC'), ['A', 'B', 'C-remote'], 'remote'),
    ).groups;
    const gB = groupsB.find(g => g.blockIds.includes('b2'))!;
    const gC = groupsB.find(g => g.blockIds.includes('b3'))!;
    const first = applyEffects(baseline, materialize(gB, 'local'));
    const second = applyEffects(first.blocks, materialize(gC, 'remote'));
    expect(second.blocks.find(b => b.origin === 'b2')?.text).toBe('B-final');
    // undo gB must restore B text without touching C or the order
    const undone = applyInverses(second.blocks, first.inverses);
    expect(undone.find(b => b.origin === 'b2')?.text).toBe('B');
    expect(undone.find(b => b.origin === 'b3')?.text).toBe('C-remote');
  });

  it('pending block keeps identity when an insert above shifts its index', () => {
    const baseline = toBase('A\nB');
    const local = alignSide(baseline, ['NEW', 'A', 'B'], 'local');
    const remote = alignSide(baseline, ['A', 'B changed remote'], 'remote');
    const groups = buildGroups(baseline, local, remote).groups;
    let blocks = baseline.map(b => ({origin: b.id, text: b.text}));
    const insert = groups.find(g => g.kind === 'insert')!;
    blocks = applyEffects(blocks, materialize(insert, 'auto')).blocks;
    // b2 still resolvable by origin despite the index shift
    expect(blocks.findIndex(b => b.origin === 'b2')).toBe(2);
    const pending = groups.find(g => g.blockIds.includes('b2'))!;
    const final = applyEffects(blocks, materialize(pending, 'remote'));
    expect(final.blocks.map(b => b.text)).toEqual([
      'NEW',
      'A',
      'B changed remote',
    ]);
  });

  it('undo of a split restores the parent at its original position even after later edits', () => {
    const baseline = toBase('A\nB\nC');
    const local = alignSide(baseline, ['A', 'B one', 'B two', 'C'], 'local');
    const remote = alignSide(baseline, ['A', 'B one', 'B two', 'C edited'], 'remote');
    const groups = buildGroups(baseline, local, remote).groups;
    let blocks = baseline.map(b => ({origin: b.id, text: b.text}));
    const split = groups.find(g => g.kind === 'split')!;
    const splitOutcome = applyEffects(blocks, materialize(split, 'auto'));
    blocks = splitOutcome.blocks;
    const editC = groups.find(g => g.blockIds.includes('b3'))!;
    const editOutcome = applyEffects(blocks, materialize(editC, 'remote'));
    blocks = editOutcome.blocks;
    // Undo the split: parent B is restored between A and the edited C.
    const restored = applyInverses(blocks, splitOutcome.inverses);
    expect(restored.map(b => b.text)).toEqual(['A', 'B', 'C edited']);
  });

  it('move + edit auto-composes to the moved, edited block', () => {
    const baseline = toBase('A\nB\nC');
    const local = alignSide(baseline, ['A', 'B edited', 'C'], 'local');
    const remote = alignSide(baseline, ['A', 'C', 'B'], 'remote');
    const groups = buildGroups(baseline, local, remote).groups;
    const group = groups.find(g => g.blockIds.includes('b2'))!;
    const outcome = applyEffects(
      baseline.map(b => ({origin: b.id, text: b.text})),
      materialize(group, 'auto'),
    );
    expect(outcome.blocks.map(b => b.origin)).toEqual(['b1', 'b3', 'b2']);
    expect(outcome.blocks.find(b => b.origin === 'b2')?.text).toBe('B edited');
  });

  it('origins cover every side block exactly once', () => {
    const baseline = toBase('A\nB\nC');
    for (const texts of [
      ['A', 'B one', 'B two', 'C'],
      ['A', 'B and C'],
      ['B', 'C', 'A'],
      ['NEW', 'A', 'B', 'C'],
    ] as string[][]) {
      const side = alignSide(baseline, texts, 'local');
      expect(side.origins).toHaveLength(texts.length);
      expect(new Set(side.origins).size).toBe(texts.length);
    }
    void originsOf;
  });
});
