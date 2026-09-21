import {describe, expect, it} from 'vitest';
import {diffBlocks} from '../src/server/diff';
import {buildResult, combineChanges} from '../src/server/merge';
import type {Block, Change, Op} from '../src/shared/model';

const base = (...texts: string[]): Block[] => texts.map((text, i) => ({id: `b${i + 1}`, text}));

function review(baseTexts: string[], localTexts: string[], remoteTexts: string[]) {
  const b = base(...baseTexts);
  const changes = combineChanges(b, diffBlocks(b, localTexts, 'l'), diffBlocks(b, remoteTexts, 'r'));
  const applied = (change: Change): Op[] => [...change.local, ...change.remote];
  return {b, changes, applied};
}

describe('combineChanges', () => {
  it('merges non-conflicting edits from both sides automatically', () => {
    const {changes} = review(
      ['one', 'two', 'three'],
      ['one L', 'two', 'three'],
      ['one', 'two', 'three R'],
    );
    expect(changes).toHaveLength(2);
    expect(changes.every(c => !c.conflict)).toBe(true);
    const ops = changes.flatMap(c => [...c.local, ...c.remote]);
    const result = buildResult(base('one', 'two', 'three'), ops);
    expect(result.text).toBe('one L\n\ntwo\n\nthree R');
  });

  it('flags a same-block double edit as a conflict with both variants', () => {
    const {changes} = review(
      ['one', 'two', 'three'],
      ['one', 'two local', 'three'],
      ['one', 'two remote', 'three'],
    );
    expect(changes).toHaveLength(1);
    const change = changes[0];
    expect(change.conflict).toBe(true);
    expect(change.kind).toBe('edit');
    expect(change.blockIds).toEqual(['b2']);
    expect((change.local[0] as Op & {kind: 'edit'}).to).toBe('two local');
    expect((change.remote[0] as Op & {kind: 'edit'}).to).toBe('two remote');
  });

  it('merges identical edits from both sides as agreed', () => {
    const {changes} = review(
      ['one', 'two', 'three'],
      ['one', 'two same', 'three'],
      ['one', 'two same', 'three'],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].conflict).toBe(false);
    expect(changes[0].agreed).toBe(true);
    const result = buildResult(base('one', 'two', 'three'), changes.flatMap(c => [...c.local, ...c.remote]));
    expect(result.text).toBe('one\n\ntwo same\n\nthree');
  });

  it('composes a move from one side with an edit from the other', () => {
    const baseTexts = ['alpha', 'bravo', 'charlie'];
    const {b, changes} = review(
      baseTexts,
      ['charlie', 'alpha', 'bravo'],
      ['alpha', 'bravo', 'charlie updated'],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('move-edit');
    expect(changes[0].conflict).toBe(false);
    const result = buildResult(b, [...changes[0].local, ...changes[0].remote]);
    expect(result.text).toBe('charlie updated\n\nalpha\n\nbravo');
  });

  it('flags delete versus edit on the same block as a conflict', () => {
    const {changes} = review(
      ['keep one', 'remove me please', 'keep three'],
      ['keep one', 'keep three'],
      ['keep one', 'remove me please updated', 'keep three'],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].conflict).toBe(true);
    expect(changes[0].local[0].kind).toBe('delete');
    expect(changes[0].remote[0].kind).toBe('edit');
  });

  it('auto-combines a split on one side with a merge on the other', () => {
    const baseTexts = ['Alpha Beta', 'mid', 'Gamma', 'Delta'];
    const {b, changes} = review(
      baseTexts,
      ['Alpha', 'Beta', 'mid', 'Gamma', 'Delta'],
      ['Alpha Beta', 'mid', 'Gamma Delta'],
    );
    expect(changes).toHaveLength(2);
    expect(changes.map(c => c.kind).sort()).toEqual(['merge', 'split']);
    expect(changes.every(c => !c.conflict)).toBe(true);
    const result = buildResult(b, changes.flatMap(c => [...c.local, ...c.remote]));
    expect(result.text).toBe('Alpha\n\nBeta\n\nmid\n\nGamma Delta');
  });

  it('keeps duplicate paragraphs apart across both sides', () => {
    const baseTexts = ['Intro', 'Body', 'Intro'];
    const {b, changes} = review(
      baseTexts,
      ['Intro updated', 'Body', 'Intro'],
      ['Intro', 'Body', 'Intro updated'],
    );
    expect(changes).toHaveLength(2);
    expect(changes[0].blockIds).toEqual(['b1']);
    expect(changes[1].blockIds).toEqual(['b3']);
    const result = buildResult(b, changes.flatMap(c => [...c.local, ...c.remote]));
    expect(result.text).toBe('Intro updated\n\nBody\n\nIntro updated');
  });

  it('moves a block after its anchor even when the anchor moved too', () => {
    const baseTexts = ['alpha', 'bravo', 'charlie', 'delta'];
    const {b, changes} = review(
      baseTexts,
      ['alpha', 'charlie', 'delta', 'bravo'], // bravo moves after delta
      ['alpha', 'bravo', 'charlie', 'delta'],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('move');
    const result = buildResult(b, [...changes[0].local, ...changes[0].remote]);
    expect(result.text).toBe('alpha\n\ncharlie\n\ndelta\n\nbravo');
  });
});

describe('buildResult', () => {
  it('applies only the ops it is given (pending conflicts stay baseline)', () => {
    const b = base('one', 'two', 'three');
    const result = buildResult(b, [{kind: 'edit', blockId: 'b2', from: 'two', to: 'two decided'}]);
    expect(result.text).toBe('one\n\ntwo decided\n\nthree');
  });

  it('keeps block identities stable under deletes (no index shift)', () => {
    const b = base('alpha', 'bravo', 'charlie', 'delta', 'echo');
    const result = buildResult(b, [
      {kind: 'delete', blockId: 'b1', text: 'alpha'},
      {kind: 'edit', blockId: 'b4', from: 'delta', to: 'delta updated'},
    ]);
    expect(result.text).toBe('bravo\n\ncharlie\n\ndelta updated\n\necho');
    expect(result.blocks.map(block => block.id)).toEqual(['b2', 'b3', 'b4', 'b5']);
  });
});
