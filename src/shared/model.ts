// Shared domain model for the three-way document patch workbench.
// A document is an ordered list of blocks (paragraphs) with stable ids.
// All diffs, decisions and results are keyed by block id, never by index.

export type SideName = 'local' | 'remote';

export type Block = {id: string; text: string};

// Where a moved/added block lands: after the given anchor block id
// (null = beginning of the document). Anchors are identities, so they
// survive index shifts caused by other committed changes.
export type MoveFacet = {after: string | null; seq: number};

export type Op =
  | {kind: 'edit'; blockId: string; from: string; to: string; moved?: MoveFacet}
  | {kind: 'move'; blockId: string; after: string | null; seq: number}
  | {kind: 'split'; blockId: string; partIds: string[]; parts: string[]; moved?: MoveFacet}
  | {kind: 'merge'; blockIds: string[]; text: string; moved?: MoveFacet}
  | {kind: 'add'; id: string; text: string; after: string | null; seq: number}
  | {kind: 'delete'; blockId: string; text: string};

export type OpKind = Op['kind'];

// A change is the unit of review. Non-conflicting ops from both sides are
// auto-combined (state 'auto'); conflicting ops become a pending decision
// between the local and the remote variant.
export type Change = {
  id: string;
  kind: OpKind | 'move-edit';
  blockIds: string[];
  conflict: boolean;
  agreed?: boolean; // both sides produced the same op
  local: Op[];
  remote: Op[];
};

export type Resolution = 'local' | 'remote' | 'pending';

export type Decision = {changeId: string; resolution: Resolution};

export type ChangeView = Change & {
  state: 'auto' | 'pending' | 'resolved';
  resolution?: 'local' | 'remote';
};

export type Stats = {total: number; auto: number; pending: number; resolved: number};

export type PatchEntry = {revision: number; at: string; decisions: Decision[]};

// Paragraphs are separated by blank lines; text inside a paragraph is kept as-is.
export function parseBlocks(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

export function joinBlocks(blocks: {text: string}[]): string {
  return blocks.map(block => block.text).join('\n\n');
}
