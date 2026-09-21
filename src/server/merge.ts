import type {Block, Change, Op} from '../shared/model';

// Three-way combination. Ops from both sides are grouped into topics by the
// baseline block ids they touch; disjoint topics auto-combine, overlapping
// ones become conflicts unless the two sides agree or compose (move+edit).

function opBlockIds(op: Op): string[] {
  switch (op.kind) {
    case 'merge':
      return op.blockIds;
    case 'add':
      return [];
    default:
      return [op.blockId];
  }
}

function sameMoved(a: {after: string | null} | undefined, b: {after: string | null} | undefined): boolean {
  return (a?.after ?? null) === (b?.after ?? null);
}

function sameOp(a: Op, b: Op): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'edit':
      return b.kind === 'edit' && a.from === b.from && a.to === b.to && sameMoved(a.moved, b.moved);
    case 'move':
      return b.kind === 'move' && a.after === b.after;
    case 'split':
      return (
        b.kind === 'split' &&
        a.blockId === b.blockId &&
        a.parts.length === b.parts.length &&
        a.parts.every((p, i) => p === b.parts[i]) &&
        sameMoved(a.moved, b.moved)
      );
    case 'merge':
      return (
        b.kind === 'merge' &&
        a.text === b.text &&
        a.blockIds.length === b.blockIds.length &&
        a.blockIds.every((id, i) => id === b.blockIds[i]) &&
        sameMoved(a.moved, b.moved)
      );
    case 'delete':
      return b.kind === 'delete' && a.blockId === b.blockId;
    case 'add':
      return false; // adds carry fresh ids, never equal across sides
  }
}

// Both sides rewrote the same block to the same text: auto-apply, keeping
// whichever move facet exists. Returns null when no agreement holds.
function editAgreement(local: Op, remote: Op): Op[] | null {
  if (local.kind !== 'edit' || remote.kind !== 'edit') return null;
  if (local.from !== remote.from || local.to !== remote.to) return null;
  if (local.moved && remote.moved && local.moved.after !== remote.moved.after) return null;
  const moved = local.moved ?? remote.moved;
  return [{...local, moved}];
}

export function combineChanges(base: Block[], localOps: Op[], remoteOps: Op[]): Change[] {
  // Union-find over baseline block ids to build topics.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    if (root !== x) {
      root = find(root);
      parent.set(x, root);
    }
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const topics = new Map<string, {ids: string[]; local: Op[]; remote: Op[]}>();
  const topicOf = (key: string) => {
    let topic = topics.get(key);
    if (!topic) {
      topic = {ids: [], local: [], remote: []};
      topics.set(key, topic);
    }
    return topic;
  };
  for (const op of [...localOps, ...remoteOps]) {
    const ids = opBlockIds(op);
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }
  for (const [side, ops] of [['local', localOps], ['remote', remoteOps]] as const) {
    for (const op of ops) {
      const ids = opBlockIds(op);
      const key = ids.length > 0 ? find(ids[0]) : `add:${op.kind === 'add' ? op.id : ''}`;
      const topic = topicOf(key);
      for (const id of ids) if (!topic.ids.includes(id)) topic.ids.push(id);
      topic[side].push(op);
    }
  }

  const changes: Change[] = [];
  for (const topic of topics.values()) {
    const {ids, local, remote} = topic;
    const first = local[0] ?? remote[0];
    const key = ids.length > 0 ? [...ids].sort().join('+') : `add:${first.kind === 'add' ? first.id : ''}`;
    const id = `chg:${key}`;
    const push = (kind: Change['kind'], l: Op[], r: Op[], conflict: boolean, agreed = false) =>
      changes.push({id, kind, blockIds: ids, conflict, agreed, local: l, remote: r});

    if (remote.length === 0) {
      push(local[0].kind, local, [], false);
      continue;
    }
    if (local.length === 0) {
      push(remote[0].kind, [], remote, false);
      continue;
    }
    const [l, r] = [local[0], remote[0]];
    if (local.length === 1 && remote.length === 1) {
      if (sameOp(l, r)) {
        // Identical outcome: apply one side only (split part ids differ).
        push(l.kind, [l], [], false, true);
        continue;
      }
      const agreed = editAgreement(l, r);
      if (agreed) {
        push('edit', agreed, [], false, true);
        continue;
      }
      // Move and edit on the same block compose: both facets apply.
      if (l.kind === 'move' && r.kind === 'edit' && !r.moved) {
        push('move-edit', [l], [r], false);
        continue;
      }
      if (r.kind === 'move' && l.kind === 'edit' && !l.moved) {
        push('move-edit', [l], [r], false);
        continue;
      }
      // One side moved+edited, the other moved to the same anchor.
      if (l.kind === 'edit' && l.moved && r.kind === 'move' && l.moved.after === r.after) {
        push('edit', [l], [], false, true);
        continue;
      }
      if (r.kind === 'edit' && r.moved && l.kind === 'move' && r.moved.after === l.after) {
        push('edit', [r], [], false, true);
        continue;
      }
    }
    push(l.kind, local, remote, true);
  }

  // Deterministic review order: baseline position of the first touched block,
  // adds anchored after their position, ties broken by change id.
  const baseIndex = new Map(base.map((b, i) => [b.id, i]));
  const position = (change: Change): number => {
    const idx = change.blockIds.map(id => baseIndex.get(id) ?? Number.MAX_SAFE_INTEGER);
    if (idx.length > 0) return Math.min(...idx);
    const op = [...change.local, ...change.remote][0];
    if (op.kind === 'add') {
      const anchor = op.after === null ? -1 : baseIndex.get(op.after) ?? Number.MAX_SAFE_INTEGER;
      return anchor === Number.MAX_SAFE_INTEGER ? anchor : anchor + 0.5;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return changes.sort((a, b) => position(a) - position(b) || a.id.localeCompare(b.id));
}

// Apply a set of ops to the baseline and produce the resulting document.
// Pending conflicts contribute no ops, so their blocks keep the baseline text.
export function buildResult(base: Block[], ops: Op[]): {blocks: Block[]; text: string} {
  const baseOrder = base.map(b => b.id);
  const text = new Map(base.map(b => [b.id, b.text]));
  let order = [...baseOrder];

  const remove = (id: string) => {
    order = order.filter(x => x !== id);
    text.delete(id);
  };

  for (const op of ops) if (op.kind === 'delete') remove(op.blockId);
  for (const op of ops) {
    if (op.kind === 'merge') {
      text.set(op.blockIds[0], op.text);
      op.blockIds.slice(1).forEach(remove);
    }
  }
  for (const op of ops) {
    if (op.kind === 'split') {
      op.partIds.forEach((id, i) => text.set(id, op.parts[i]));
      const at = order.indexOf(op.blockId);
      if (at >= 0) order.splice(at, 1, ...op.partIds);
      else order.push(...op.partIds);
    }
  }
  for (const op of ops) if (op.kind === 'edit') text.set(op.blockId, op.to);

  // Position of the slot right after `after`, with fallback walks so anchors
  // that were themselves removed never strand a block.
  const resolvePos = (after: string | null): number => {
    if (after === null) return 0;
    const idx = order.indexOf(after);
    if (idx >= 0) return idx + 1;
    const bi = baseOrder.indexOf(after);
    if (bi >= 0) {
      for (let k = bi - 1; k >= 0; k--) {
        const j = order.indexOf(baseOrder[k]);
        if (j >= 0) return j + 1;
      }
      return 0;
    }
    return order.length; // anchor is a fresh id that does not exist (yet)
  };

  const lastInserted = new Map<string, string>();
  const insertAfter = (after: string | null, id: string) => {
    const key = after ?? '';
    const effective = lastInserted.has(key) ? lastInserted.get(key)! : after;
    order.splice(resolvePos(effective), 0, id);
    lastInserted.set(key, id);
  };

  const adds = ops.filter((op): op is Op & {kind: 'add'} => op.kind === 'add').sort((a, b) => a.seq - b.seq);
  for (const op of adds) {
    text.set(op.id, op.text);
    insertAfter(op.after, op.id);
  }

  const moves: {id: string; after: string | null; seq: number}[] = [];
  for (const op of ops) {
    if (op.kind === 'move') moves.push({id: op.blockId, after: op.after, seq: op.seq});
    else if ((op.kind === 'edit' || op.kind === 'split' || op.kind === 'merge') && op.moved) {
      moves.push({id: op.kind === 'merge' ? op.blockIds[0] : op.blockId, after: op.moved.after, seq: op.moved.seq});
    }
  }
  moves.sort((a, b) => a.seq - b.seq);
  for (const move of moves) {
    order = order.filter(id => id !== move.id);
    insertAfter(move.after, move.id);
  }

  const blocks = order.map(id => ({id, text: text.get(id)!}));
  return {blocks, text: blocks.map(b => b.text).join('\n\n')};
}
