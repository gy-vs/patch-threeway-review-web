import type {Block, Change, ChangeView, Decision, Op, PatchEntry, Resolution, Stats} from '../shared/model';
import {parseBlocks} from '../shared/model';
import {diffBlocks} from './diff';
import {buildResult, combineChanges} from './merge';

// A review session: immutable three-way input plus an append-only decision
// log. Every accepted decision batch produces a new revision (a new patch
// on top of the current one); undecided conflicts stay pending.
export type Session = {
  id: string;
  name: string;
  createdAt: string;
  base: Block[];
  localText: string;
  remoteText: string;
  localOps: Op[];
  remoteOps: Op[];
  changes: Change[];
  decisions: Map<string, 'local' | 'remote'>;
  touchedAt: Map<string, number>; // changeId -> revision of its last decision
  revision: number;
  patches: PatchEntry[];
};

export class DecisionError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const sessions = new Map<string, Session>();
let counter = 0;

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function createSession(name: string, baseline: string, local: string, remote: string): Session {
  const base = parseBlocks(baseline).map((text, i) => ({id: `b${i + 1}`, text}));
  const localOps = diffBlocks(base, parseBlocks(local), 'l');
  const remoteOps = diffBlocks(base, parseBlocks(remote), 'r');
  const changes = combineChanges(base, localOps, remoteOps);
  const now = new Date().toISOString();
  const session: Session = {
    id: `doc-${++counter}`,
    name,
    createdAt: now,
    base,
    localText: local,
    remoteText: remote,
    localOps,
    remoteOps,
    changes,
    decisions: new Map(),
    touchedAt: new Map(),
    revision: 1,
    patches: [{revision: 1, at: now, decisions: []}],
  };
  sessions.set(session.id, session);
  return session;
}

export function listSessions() {
  return [...sessions.values()].map(s => ({id: s.id, name: s.name, revision: s.revision, stats: statsOf(s)}));
}

export function statsOf(session: Session): Stats {
  let auto = 0, resolved = 0;
  for (const change of session.changes) {
    if (!change.conflict) auto++;
    else if (session.decisions.has(change.id)) resolved++;
  }
  return {total: session.changes.length, auto, pending: session.changes.length - auto - resolved, resolved};
}

export function reviewOf(session: Session) {
  const changes: ChangeView[] = session.changes.map(change => {
    const resolution = session.decisions.get(change.id);
    return {
      ...change,
      state: !change.conflict ? 'auto' : resolution ? 'resolved' : 'pending',
      ...(resolution ? {resolution} : {}),
    };
  });
  return {
    id: session.id,
    name: session.name,
    revision: session.revision,
    changes,
    stats: statsOf(session),
    patches: session.patches,
  };
}

const RESOLUTIONS: Resolution[] = ['local', 'remote', 'pending'];

// Apply a batch of decisions as a new patch on top of the current revision.
// Decisions are keyed by stable change id, so batches from two pages merge
// as long as they touch disjoint changes; undo is just a 'pending' decision.
export function applyDecisions(session: Session, baseRevision: number, decisions: Decision[]) {
  if (!Number.isInteger(baseRevision) || baseRevision < 1 || baseRevision > session.revision) {
    throw new DecisionError('invalid_base_revision', 400, {current: session.revision});
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new DecisionError('empty_decisions', 400);
  }
  const conflicts: {changeId: string; current: Resolution}[] = [];
  for (const decision of decisions) {
    const change = session.changes.find(c => c.id === decision.changeId);
    if (!change || !change.conflict || !RESOLUTIONS.includes(decision.resolution)) {
      throw new DecisionError('invalid_decision', 400, {changeId: decision.changeId});
    }
    const current: Resolution = session.decisions.get(change.id) ?? 'pending';
    const touchedAt = session.touchedAt.get(change.id) ?? 0;
    // Another page decided this change after the client's base revision.
    if (touchedAt > baseRevision && current !== decision.resolution) {
      conflicts.push({changeId: change.id, current});
    }
  }
  if (conflicts.length > 0) {
    return {ok: false as const, conflicts, revision: session.revision};
  }
  session.revision += 1;
  const applied: Decision[] = [];
  for (const decision of decisions) {
    if (decision.resolution === 'pending') session.decisions.delete(decision.changeId);
    else session.decisions.set(decision.changeId, decision.resolution);
    session.touchedAt.set(decision.changeId, session.revision);
    applied.push(decision);
  }
  session.patches.push({revision: session.revision, at: new Date().toISOString(), decisions: applied});
  return {ok: true as const, revision: session.revision, stats: statsOf(session)};
}

// The working document: baseline + auto-combined ops + resolved decisions.
// Committed blocks are fixed by their decisions; pending blocks keep the
// baseline text, and every lookup is by block id, so index shifts caused
// by committed changes never move a pending block's identity.
export function resultOf(session: Session) {
  const ops: Op[] = [];
  for (const change of session.changes) {
    if (!change.conflict) {
      ops.push(...change.local, ...change.remote);
      continue;
    }
    const resolution = session.decisions.get(change.id);
    if (resolution === 'local') ops.push(...change.local);
    else if (resolution === 'remote') ops.push(...change.remote);
  }
  const {blocks, text} = buildResult(session.base, ops);
  return {id: session.id, revision: session.revision, blocks, text, pending: statsOf(session).pending};
}
