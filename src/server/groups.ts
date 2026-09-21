// Change groups: pair the local and remote ops into review groups and decide
// which groups compose automatically and which need a human decision.
//
// Ops are keyed by stable origin-derived keys; ops whose baseline block sets
// intersect (e.g. a split vs a merge) are unioned into one group, so every
// block is owned by at most one group. Groups therefore never silently
// conflict with each other.

import {opGroupKey} from './blocks';
import type {
  ChangeGroup,
  ConflictReason,
  Proposal,
  SideAlignment,
  SideName,
  SideOp,
} from './types';
import type {Block} from './types';

type OpEntry = {op: SideOp; side: SideName};

const KIND_LABEL: Record<SideOp['kind'], string> = {
  edit: '编辑',
  delete: '删除',
  move: '移动',
  split: '拆分',
  merge: '合并',
  insert: '插入',
};

export function opBlockIds(op: SideOp): string[] {
  if (op.kind === 'insert') return [];
  if (op.kind === 'merge') return op.blockIds;
  return [op.blockId];
}

function proposalFor(op: SideOp): Proposal {
  switch (op.kind) {
    case 'edit':
      return {side: op.side, detail: '改写段落文本', text: op.text};
    case 'delete':
      return {side: op.side, detail: '删除段落'};
    case 'move':
      return {
        side: op.side,
        detail:
          op.afterId === null
            ? '移动到文档开头'
            : `移动到 ${op.afterId} 之后`,
      };
    case 'split':
      return {
        side: op.side,
        detail: `拆分为 ${op.parts.length} 段`,
        text: op.parts.join('\n'),
      };
    case 'merge':
      return {
        side: op.side,
        detail: `合并 ${op.blockIds.length} 段`,
        text: op.text,
      };
    case 'insert':
      return {side: op.side, detail: '插入新段落', text: op.text};
  }
}

class UnionFind {
  parent = new Map<string, string>();
  key(key: string): string {
    if (!this.parent.has(key)) this.parent.set(key, key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = key;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.key(a);
    const rb = this.key(b);
    if (ra !== rb) this.parent.set(rb, ra);
    this.key(b);
  }
}

export type BuiltGroups = {
  groups: ChangeGroup[];
};

export function buildGroups(
  baseline: Block[],
  local: SideAlignment,
  remote: SideAlignment,
): BuiltGroups {
  const entries = new Map<string, {local?: SideOp; remote?: SideOp}>();
  const all: OpEntry[] = [
    ...local.ops.map(op => ({op, side: 'local' as const})),
    ...remote.ops.map(op => ({op, side: 'remote' as const})),
  ];
  for (const {op, side} of all) {
    const key = opGroupKey(op);
    const slot = entries.get(key) ?? {};
    slot[side] = op;
    entries.set(key, slot);
  }

  // Union keys that touch the same baseline block (split/merge overlap etc.).
  const uf = new UnionFind();
  const blockToKey = new Map<string, string>();
  for (const key of entries.keys()) {
    uf.key(key);
    const slot = entries.get(key)!;
    for (const op of [slot.local, slot.remote].filter(Boolean) as SideOp[]) {
      for (const id of opBlockIds(op)) {
        const other = blockToKey.get(id);
        if (other) uf.union(other, key);
        blockToKey.set(id, uf.key(key));
      }
    }
  }

  const components = new Map<string, string[]>();
  for (const key of entries.keys()) {
    const root = uf.key(key);
    const list = components.get(root) ?? [];
    list.push(key);
    components.set(root, list);
  }

  const baselineTextById = new Map(baseline.map(block => [block.id, block.text]));

  const groups: ChangeGroup[] = [];
  for (const keys of components.values()) {
    let localOp: SideOp | undefined;
    let remoteOp: SideOp | undefined;
    const blockSet: string[] = [];
    const anchorSet: (string | null)[] = [];
    for (const key of keys) {
      const slot = entries.get(key)!;
      if (slot.local && !localOp) localOp = slot.local;
      if (slot.remote && !remoteOp) remoteOp = slot.remote;
      for (const op of [slot.local, slot.remote].filter(Boolean) as SideOp[]) {
        for (const id of opBlockIds(op)) if (!blockSet.includes(id)) blockSet.push(id);
        const anchor =
          'afterId' in op ? (op.afterId as string | null) : blockSet[0] ?? null;
        if (!anchorSet.includes(anchor)) anchorSet.push(anchor);
      }
    }

    const proposals: Proposal[] = [];
    if (localOp) proposals.push(proposalFor(localOp));
    if (remoteOp) proposals.push(proposalFor(remoteOp));

    const opsPair = {local: localOp, remote: remoteOp};
    const kinds = new Set(
      [localOp, remoteOp].filter(Boolean).map(op => (op as SideOp).kind),
    );
    const anchorId =
      anchorSet.find(value => value !== null && value !== undefined) ??
      (anchorSet.includes(null) ? null : blockSet[0] ?? null);

    let auto = true;
    let conflict: ConflictReason | undefined;
    let kind: ChangeGroup['kind'];
    let title: string;

    const only = localOp ?? remoteOp!;
    if (!localOp || !remoteOp) {
      kind = only.kind;
      const sideLabel = localOp ? '本地' : '远端';
      title = `${sideLabel}${KIND_LABEL[only.kind]}`;
      auto = true;
    } else if (kinds.size === 1) {
      kind = localOp.kind;
      title = `双方${KIND_LABEL[localOp.kind]}`;
      const same = JSON.stringify(localOp) === JSON.stringify({...remoteOp, side: localOp.side});
      switch (localOp.kind) {
        case 'delete':
          auto = true;
          title = '双方删除同一段';
          break;
        case 'edit':
          auto = (localOp as {text: string}).text === (remoteOp as {text: string}).text;
          conflict = auto ? undefined : 'edit_edit';
          break;
        case 'move': {
          const lm = localOp as Extract<SideOp, {kind: 'move'}>;
          const rm = remoteOp as Extract<SideOp, {kind: 'move'}>;
          auto = lm.afterId === rm.afterId && lm.order === rm.order;
          conflict = auto ? undefined : 'incompatible_structure';
          break;
        }
        case 'split': {
          const ls = localOp as Extract<SideOp, {kind: 'split'}>;
          const rs = remoteOp as Extract<SideOp, {kind: 'split'}>;
          auto = JSON.stringify(ls.parts) === JSON.stringify(rs.parts);
          conflict = auto ? undefined : 'incompatible_structure';
          break;
        }
        case 'merge': {
          const lmg = localOp as Extract<SideOp, {kind: 'merge'}>;
          const rmg = remoteOp as Extract<SideOp, {kind: 'merge'}>;
          auto = lmg.text === rmg.text && JSON.stringify(lmg.blockIds) === JSON.stringify(rmg.blockIds);
          conflict = auto ? undefined : 'incompatible_structure';
          break;
        }
        case 'insert': {
          const li = localOp as Extract<SideOp, {kind: 'insert'}>;
          const ri = remoteOp as Extract<SideOp, {kind: 'insert'}>;
          auto = li.text === ri.text;
          conflict = auto ? undefined : 'incompatible_structure';
          break;
        }
        default:
          void same;
      }
    } else {
      kind = 'dual';
      title = `本地${KIND_LABEL[localOp.kind]} × 远端${KIND_LABEL[remoteOp.kind]}`;
      const kindsPair = new Set([localOp.kind, remoteOp.kind]);
      if (kindsPair.has('delete')) {
        auto = false;
        conflict = 'delete_vs_change';
      } else if (kindsPair.has('split') && kindsPair.has('merge')) {
        auto = false;
        conflict = 'split_vs_merge';
      } else if (kindsPair.has('move')) {
        // A move composes with any content change the other side made.
        auto = true;
      } else {
        auto = false;
        conflict = 'incompatible_structure';
      }
    }

    const baselineText = blockSet.length
      ? baselineTextById.get(blockSet[0])
      : undefined;

    groups.push({
      id: groupIdOf(keys),
      kind,
      title,
      blockIds: blockSet,
      anchorId,
      proposals,
      auto,
      conflict,
      ops: opsPair,
      status: 'pending',
      baselineText,
    });
  }

  // Deterministic order: by first baseline block position, inserts last by
  // anchor. Stable for the whole review session.
  const orderOf = new Map(baseline.map((block, i) => [block.id, i]));
  groups.sort((a, b) => {
    const ai = a.blockIds.length ? orderOf.get(a.blockIds[0]) : undefined;
    const bi = b.blockIds.length ? orderOf.get(b.blockIds[0]) : undefined;
    if (ai === undefined && bi === undefined) {
      const aa = a.anchorId ? orderOf.get(a.anchorId) ?? -1 : -1;
      const bb = b.anchorId ? orderOf.get(b.anchorId) ?? -1 : -1;
      return aa - bb || a.id.localeCompare(b.id);
    }
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });

  return {groups};
}

export function groupIdOf(keys: string[]): string {
  return 'grp:' + [...keys].sort().join('~').slice(0, 120);
}

// Origins that remain/result in the document for an op. Editing preserves the
// baseline origin; a split adds derived children after the parent; a merge
// keeps the first member; inserts get a derived id.
export function resultingOrigins(op: SideOp): string[] {
  switch (op.kind) {
    case 'edit':
    case 'move':
      return [op.blockId];
    case 'delete':
      return [];
    case 'split':
      return [
        op.blockId,
        ...op.parts.slice(1).map((_, k) => `split:${op.blockId}:${k + 1}`),
      ];
    case 'merge':
      return [op.blockIds[0]];
    case 'insert':
      return [
        `add:${op.side}:${op.afterId ?? 'START'}:${op.order}:${op.text}`,
      ];
  }
}
