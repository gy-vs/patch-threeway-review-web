// Effect materialization.
//
// Identity rule: editing text NEVER changes a block's origin. A baseline block
// keeps its origin through edit / split-parent / merge-survivor, so committed
// text is stable and pending blocks survive index shifts as well as later
// edits of their neighbours. Only insertion creates new derived origins.
//
//   edit   -> in-place text change
//   split  -> parent origin keeps the first part; the other parts are added
//   merge  -> first member origin keeps the merged text; others are removed
//   move   -> in-place reorder
//   insert -> add with a derived origin
//
// Every apply records precise inverses (with neighbour snapshots) so undo is
// exact even when a disjoint later commit moved or deleted the anchor.

import type {
  ChangeGroup,
  DecisionChoice,
  Effect,
  Inverse,
  Neighbors,
  OriginBlock,
  SideOp,
} from './types';

function effectsForOp(op: SideOp): Effect[] {
  switch (op.kind) {
    case 'edit':
      return [{type: 'edit', origin: op.blockId, text: op.text}];
    case 'delete':
      return [{type: 'remove', origin: op.blockId}];
    case 'move':
      return [{type: 'move', origin: op.blockId, after: op.afterId, order: op.order}];
    case 'split':
      return [
        {type: 'edit', origin: op.blockId, text: op.parts[0]},
        ...op.parts.slice(1).map((text, k) => ({
          type: 'add' as const,
          origin: `split:${op.blockId}:${k + 1}`,
          text,
          after: op.blockId,
          order: k,
        })),
      ];
    case 'merge':
      return [
        {type: 'edit', origin: op.blockIds[0], text: op.text},
        ...op.blockIds.slice(1).map(origin => ({
          type: 'remove' as const,
          origin,
        })),
      ];
    case 'insert':
      return [
        {
          type: 'add',
          origin: `add:${op.side}:${op.afterId ?? 'START'}:${op.order}:${op.text}`,
          text: op.text,
          after: op.afterId,
          order: op.order,
        },
      ];
  }
}

function customMergedOrigin(group: ChangeGroup): string {
  return `resolved:${group.id}:${group.blockIds[0] ?? group.anchorId ?? 'x'}`;
}

export function materialize(
  group: ChangeGroup,
  choice: DecisionChoice | 'auto',
  customText?: string,
): Effect[] {
  const local = group.ops.local;
  const remote = group.ops.remote;

  if (choice === 'keep') return [];
  if (choice === 'local' && local) return effectsForOp(local);
  if (choice === 'remote' && remote) return effectsForOp(remote);

  if (choice === 'merged') {
    const text = (customText ?? '').trim();
    if (!text) return [];
    if (group.blockIds.length > 0) {
      const effects: Effect[] = [
        {type: 'edit', origin: group.blockIds[0], text},
      ];
      for (const extra of group.blockIds.slice(1)) {
        effects.push({type: 'remove', origin: extra});
      }
      return effects;
    }
    return [
      {
        type: 'add',
        origin: customMergedOrigin(group),
        text,
        after: group.anchorId,
        order: 0,
      },
    ];
  }

  // choice === 'auto': compose the non-conflicting sides.
  if (local && remote) {
    if (new Set([local.kind, remote.kind]).size === 1) {
      return effectsForOp(local); // equal same-kind changes
    }
    if (local.kind === 'move' || remote.kind === 'move') {
      // move + content change on the same origin: apply the content change,
      // then move the (identity-stable) block.
      const content: SideOp = local.kind === 'move' ? remote : local;
      const move = (local.kind === 'move' ? local : remote) as Extract<
        SideOp,
        {kind: 'move'}
      >;
      const effects = effectsForOp(content);
      effects.push({
        type: 'move',
        origin: move.blockId,
        after: move.afterId,
        order: move.order,
      });
      return effects;
    }
    return effectsForOp(local);
  }
  return effectsForOp((local ?? remote)!);
}

// --- effect execution --------------------------------------------------------

type MutableBlock = {origin: string; text: string};

function neighborsAt(blocks: MutableBlock[], index: number): Neighbors {
  return {
    before: index > 0 ? blocks[index - 1].origin : null,
    after: index >= 0 && index < blocks.length - 1 ? blocks[index + 1].origin : null,
  };
}

function resolveTarget(
  blocks: MutableBlock[],
  after: string | null,
  order: number,
  neighbors: Neighbors,
): number {
  if (after !== null) {
    const idx = blocks.findIndex(block => block.origin === after);
    if (idx >= 0) {
      const target = Math.min(idx + 1 + Math.max(0, order), blocks.length);
      if (neighbors.after) {
        const si = blocks.findIndex(block => block.origin === neighbors.after);
        if (si >= 0) return Math.max(idx + 1, Math.min(target, si));
      }
      return target;
    }
  }
  // anchor gone (moved/deleted by a disjoint commit): relocate from snapshots
  if (neighbors.before) {
    const bi = blocks.findIndex(block => block.origin === neighbors.before);
    if (bi >= 0) return bi + 1;
  }
  if (neighbors.after) {
    const ai = blocks.findIndex(block => block.origin === neighbors.after);
    if (ai >= 0) return ai;
  }
  if (after === null) return Math.min(Math.max(0, order), blocks.length);
  return blocks.length;
}

export type ApplyOutcome = {
  blocks: OriginBlock[];
  inverses: Inverse[]; // forward execution order; undo iterates reversed
  finalTexts: Record<string, string>;
};

export function applyEffects(
  current: OriginBlock[],
  effects: Effect[],
  watchedOrigins: string[] = [],
): ApplyOutcome {
  const blocks: MutableBlock[] = current.map(block => ({...block}));
  const inverses: Inverse[] = [];
  const touched = new Set<string>(watchedOrigins);
  const touch = (origin: string) => touched.add(origin);

  // Stage 1: in-place edits (identity preserved).
  for (const effect of effects) {
    if (effect.type !== 'edit') continue;
    const idx = blocks.findIndex(block => block.origin === effect.origin);
    if (idx < 0) continue;
    const oldText = blocks[idx].text;
    blocks[idx] = {origin: effect.origin, text: effect.text};
    touch(effect.origin);
    inverses.push({type: 'edit', origin: effect.origin, text: oldText});
  }

  // Stage 2: removals (plain deletes and non-surviving merge members).
  for (const effect of effects) {
    if (effect.type !== 'remove') continue;
    const idx = blocks.findIndex(block => block.origin === effect.origin);
    if (idx < 0) continue;
    const neighbors = neighborsAt(blocks, idx);
    const [gone] = blocks.splice(idx, 1);
    touch(gone.origin);
    inverses.push({
      type: 'add',
      origin: gone.origin,
      text: gone.text,
      after: neighbors.before,
      siblings: neighbors,
    });
  }

  // Stage 3: insertions (split children and explicit inserts).
  for (const effect of effects) {
    if (effect.type !== 'add') continue;
    if (blocks.some(block => block.origin === effect.origin)) continue;
    const around: Neighbors = {before: effect.after, after: null};
    const anchorIdx = effect.after
      ? blocks.findIndex(block => block.origin === effect.after)
      : -1;
    if (anchorIdx >= 0) {
      const provisional = anchorIdx + 1 + Math.max(0, effect.order);
      const target = Math.min(provisional, blocks.length);
      around.after = target < blocks.length ? blocks[target].origin : null;
    }
    const target = resolveTarget(blocks, effect.after, effect.order, around);
    blocks.splice(target, 0, {origin: effect.origin, text: effect.text});
    touch(effect.origin);
    inverses.push({type: 'remove', origin: effect.origin});
  }

  // Stage 4: moves.
  for (const effect of effects) {
    if (effect.type !== 'move') continue;
    const idx = blocks.findIndex(block => block.origin === effect.origin);
    if (idx < 0) continue;
    const oldNeighbors = neighborsAt(blocks, idx);
    const [block] = blocks.splice(idx, 1);
    const target = resolveTarget(blocks, effect.after, effect.order, {
      before: effect.after,
      after: null,
    });
    blocks.splice(target, 0, block);
    touch(effect.origin);
    inverses.push({
      type: 'move',
      origin: effect.origin,
      after: oldNeighbors.before,
      order: 0,
      siblings: oldNeighbors,
    });
  }

  const finalTexts: Record<string, string> = {};
  for (const block of blocks) {
    if (touched.has(block.origin)) finalTexts[block.origin] = block.text;
  }

  return {blocks, inverses, finalTexts};
}

// --- inverse execution -------------------------------------------------------

export function applyInverses(
  current: OriginBlock[],
  inverses: Inverse[],
): OriginBlock[] {
  const blocks: MutableBlock[] = current.map(block => ({...block}));
  // Latest action first.
  for (const inverse of [...inverses].reverse()) {
    if (inverse.type === 'edit') {
      const idx = blocks.findIndex(block => block.origin === inverse.origin);
      if (idx >= 0) blocks[idx] = {origin: inverse.origin, text: inverse.text};
    } else if (inverse.type === 'remove') {
      const idx = blocks.findIndex(block => block.origin === inverse.origin);
      if (idx >= 0) blocks.splice(idx, 1);
    } else if (inverse.type === 'add') {
      if (blocks.some(block => block.origin === inverse.origin)) continue;
      const target = resolveTarget(blocks, inverse.after, 0, inverse.siblings);
      blocks.splice(target, 0, {origin: inverse.origin, text: inverse.text});
    } else {
      const idx = blocks.findIndex(block => block.origin === inverse.origin);
      if (idx < 0) continue;
      const [block] = blocks.splice(idx, 1);
      const target = resolveTarget(blocks, inverse.after, inverse.order, inverse.siblings);
      blocks.splice(target, 0, block);
    }
  }
  return blocks;
}
