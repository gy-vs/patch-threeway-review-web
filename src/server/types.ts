// Stable block identity and three-way review domain types.
//
// Every block carries an *origin* id: baseline blocks keep their id forever,
// blocks created by an edit/split/merge/insert carry deterministic derived
// ids. Local and remote are aligned once at import, so later index shifts
// never change an origin. Groups, decisions and effects all reference origins.

export type SideName = 'local' | 'remote';

export type OriginBlock = {origin: string; text: string};

// Baseline block before alignment assigns permanent ids.
export type Block = {id: string; text: string};

// --- One side's operation on baseline origins ------------------------------

export type EditOp = {kind: 'edit'; blockId: string; text: string; side: SideName};
export type DeleteOp = {kind: 'delete'; blockId: string; side: SideName};
export type MoveOp = {
  kind: 'move';
  blockId: string;
  afterId: string | null; // null => move to the very start
  order: number;
  side: SideName;
};
export type SplitOp = {
  kind: 'split';
  blockId: string;
  parts: string[]; // length >= 2
  side: SideName;
};
export type MergeOp = {
  kind: 'merge';
  blockIds: string[]; // length >= 2, first one is the surviving origin
  text: string;
  side: SideName;
};
export type InsertOp = {
  kind: 'insert';
  afterId: string | null;
  order: number; // dense rank inside the anchor gap
  text: string;
  side: SideName;
};

export type SideOp = EditOp | DeleteOp | MoveOp | SplitOp | MergeOp | InsertOp;

export type SideAlignment = {
  ops: SideOp[];
  // origin for every block of this side version, in document order
  origins: string[];
};

// --- Review change groups ---------------------------------------------------

export type Proposal = {
  side: SideName;
  detail: string;
  text?: string;
};

export type ConflictReason =
  | 'edit_edit'
  | 'delete_vs_change'
  | 'split_vs_merge'
  | 'incompatible_structure';

export type GroupStatus = 'pending' | 'resolved';

export type ChangeGroup = {
  id: string; // stable for the whole review session
  kind: SideOp['kind'] | 'dual';
  title: string;
  blockIds: string[]; // baseline origins touched
  anchorId: string | null;
  proposals: Proposal[];
  auto: boolean; // non-conflicting, auto-composed
  conflict?: ConflictReason;
  ops: {local?: SideOp; remote?: SideOp};
  status: GroupStatus;
  baselineText?: string;
};

// --- Decisions --------------------------------------------------------------

export type DecisionChoice = 'local' | 'remote' | 'keep' | 'merged';

export type Decision = {
  groupId: string;
  choice: DecisionChoice;
  customText?: string; // required for choice 'merged'
  updatedAt: string;
};

export type Resolution = {
  groupId: string;
  choice: DecisionChoice | 'auto';
  finalTexts: Record<string, string>; // origin -> final committed text
  revision: number; // revision that introduced this resolution
};

export type CommitSkipped = {groupId: string; reason: string};

export type CommitResponse = {
  revision: number;
  applied: string[];
  skipped: CommitSkipped[];
  pending: string[];
};

// --- Materialized effects ---------------------------------------------------

// Primitive effects and inverses used to commit and undo a group.
// Editing never changes an origin; split children and merge survivors keep
// the parent/first-member origin.
export type Effect =
  | {type: 'edit'; origin: string; text: string}
  | {type: 'remove'; origin: string}
  | {type: 'add'; origin: string; text: string; after: string | null; order: number}
  | {type: 'move'; origin: string; after: string | null; order: number};

// Primitive inverse used to undo a previously committed group.
export type Neighbors = {before: string | null; after: string | null};

export type Inverse =
  | {type: 'edit'; origin: string; text: string}
  | {type: 'remove'; origin: string}
  | {
      type: 'add';
      origin: string;
      text: string;
      after: string | null;
      siblings: Neighbors;
    }
  | {
      type: 'move';
      origin: string;
      after: string | null;
      order: number;
      siblings: Neighbors;
    };
