// Shared client view of the review API. The server owns the domain types in
// src/server/types.ts; keep this structural copy in sync.

export type SideName = 'local' | 'remote';
export type ConflictReason =
  | 'edit_edit'
  | 'delete_vs_change'
  | 'split_vs_merge'
  | 'incompatible_structure';
export type DecisionChoice = 'local' | 'remote' | 'keep' | 'merged';
export type GroupKind =
  | 'edit'
  | 'delete'
  | 'move'
  | 'split'
  | 'merge'
  | 'insert'
  | 'dual';

export type SideOpView = {
  kind: GroupKind;
  text?: string;
  parts?: string[];
  blockIds?: string[];
  blockId?: string;
  afterId?: string | null;
  order?: number;
  side?: SideName;
};

export type Proposal = {
  side: SideName;
  detail: string;
  text?: string;
};

export type GroupView = {
  id: string;
  kind: GroupKind;
  title: string;
  blockIds: string[];
  anchorId: string | null;
  proposals: Proposal[];
  auto: boolean;
  conflict?: ConflictReason;
  ops: {local?: SideOpView; remote?: SideOpView};
  status: 'pending' | 'resolved';
  baselineText?: string;
  decision: {groupId: string; choice: DecisionChoice; customText?: string} | null;
  finalTexts: Record<string, string> | null;
  committedAtRevision: number | null;
};

export type OriginBlock = {origin: string; text: string};

export type ReviewPayload = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  versions: {
    baseline: OriginBlock[];
    local: OriginBlock[];
    remote: OriginBlock[];
  };
  integrated: OriginBlock[];
  text: string;
  groups: GroupView[];
};

export type ReviewSummary = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  groups: number;
  pending: number;
};

async function jsonOrThrow(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`) as Error & {
      status: number;
      body: any;
    };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  list(): Promise<ReviewSummary[]> {
    return fetch('/api/reviews').then(jsonOrThrow);
  },
  get(id: string): Promise<ReviewPayload> {
    return fetch(`/api/reviews/${id}`).then(jsonOrThrow);
  },
  create(input: {
    name: string;
    baseline: string;
    local: string;
    remote: string;
  }): Promise<ReviewPayload> {
    return fetch('/api/reviews', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(input),
    }).then(jsonOrThrow);
  },
  decide(
    id: string,
    groupId: string,
    choice: DecisionChoice,
    customText?: string,
  ): Promise<unknown> {
    return fetch(`/api/reviews/${id}/decisions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({groupId, choice, customText}),
    }).then(jsonOrThrow);
  },
  commit(
    id: string,
    revision: number,
    groupIds: string[] | null,
  ): Promise<{
    revision: number;
    applied: string[];
    skipped: {groupId: string; reason: string}[];
    pending: string[];
  }> {
    return fetch(`/api/reviews/${id}/commit`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, groupIds}),
    }).then(jsonOrThrow);
  },
  undo(
    id: string,
    revision: number,
    groupId: string,
  ): Promise<{revision: number}> {
    return fetch(`/api/reviews/${id}/undo`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision, groupId}),
    }).then(jsonOrThrow);
  },
};
