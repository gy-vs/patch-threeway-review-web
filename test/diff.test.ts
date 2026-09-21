import {describe, expect, it} from 'vitest';
import {diffBlocks} from '../src/server/diff';
import type {Block, Op} from '../src/shared/model';

const base = (...texts: string[]): Block[] => texts.map((text, i) => ({id: `b${i + 1}`, text}));

const oneEdit = (ops: Op[]) => {
  expect(ops).toHaveLength(1);
  expect(ops[0].kind).toBe('edit');
  return ops[0] as Op & {kind: 'edit'};
};

describe('diffBlocks', () => {
  it('detects an edit on an unchanged block layout', () => {
    const ops = diffBlocks(base('para one', 'para two', 'para three'), ['para one', 'para two updated', 'para three'], 'l');
    const edit = oneEdit(ops);
    expect(edit.blockId).toBe('b2');
    expect(edit.from).toBe('para two');
    expect(edit.to).toBe('para two updated');
    expect(edit.moved).toBeUndefined();
  });

  it('detects a move with an identity anchor', () => {
    const ops = diffBlocks(base('alpha', 'bravo', 'charlie'), ['charlie', 'alpha', 'bravo'], 'l');
    expect(ops).toHaveLength(1);
    const move = ops[0] as Op & {kind: 'move'};
    expect(move.kind).toBe('move');
    expect(move.blockId).toBe('b3');
    expect(move.after).toBeNull(); // moved to the very beginning
  });

  it('detects a split and keeps the first part on the original id', () => {
    const ops = diffBlocks(base('Alpha Beta'), ['Alpha', 'Beta'], 'l');
    expect(ops).toHaveLength(1);
    const split = ops[0] as Op & {kind: 'split'};
    expect(split.kind).toBe('split');
    expect(split.blockId).toBe('b1');
    expect(split.parts).toEqual(['Alpha', 'Beta']);
    expect(split.partIds[0]).toBe('b1');
    expect(split.partIds[1]).toBe('l1');
  });

  it('detects a merge of consecutive blocks', () => {
    const ops = diffBlocks(base('Gamma', 'Delta'), ['Gamma Delta'], 'r');
    expect(ops).toHaveLength(1);
    const merge = ops[0] as Op & {kind: 'merge'};
    expect(merge.kind).toBe('merge');
    expect(merge.blockIds).toEqual(['b1', 'b2']);
    expect(merge.text).toBe('Gamma Delta');
  });

  it('detects deletes and adds anchored by identity', () => {
    const del = diffBlocks(base('alpha', 'bravo', 'charlie'), ['alpha', 'charlie'], 'l');
    expect(del).toEqual([{kind: 'delete', blockId: 'b2', text: 'bravo'}]);
    const add = diffBlocks(base('alpha', 'charlie'), ['alpha', 'brand new', 'charlie'], 'l');
    expect(add).toEqual([{kind: 'add', id: 'l1', text: 'brand new', after: 'b1', seq: 1}]);
  });

  it('keeps duplicate paragraph identities: edits the first occurrence', () => {
    const ops = diffBlocks(base('Intro', 'Body', 'Intro'), ['Intro updated', 'Body', 'Intro'], 'l');
    const edit = oneEdit(ops);
    expect(edit.blockId).toBe('b1'); // not b3
  });

  it('keeps duplicate paragraph identities: deletes the first occurrence', () => {
    const ops = diffBlocks(base('Intro', 'Body', 'Intro'), ['Body', 'Intro'], 'l');
    expect(ops).toEqual([{kind: 'delete', blockId: 'b1', text: 'Intro'}]);
  });

  it('keeps duplicate paragraph identities: edits the second occurrence', () => {
    const ops = diffBlocks(base('Intro', 'Body', 'Intro'), ['Intro', 'Body', 'Intro updated'], 'l');
    const edit = oneEdit(ops);
    expect(edit.blockId).toBe('b3');
  });

  it('attaches a move facet to an edited block that changed position', () => {
    const ops = diffBlocks(base('alpha', 'bravo', 'charlie'), ['charlie moved', 'alpha', 'bravo'], 'l');
    const edit = oneEdit(ops);
    expect(edit.blockId).toBe('b3');
    expect(edit.moved).toEqual({after: null, seq: 0});
  });
});
