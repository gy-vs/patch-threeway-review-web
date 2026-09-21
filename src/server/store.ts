// In-memory review store.
//
// A review keeps the three imported versions plus:
//   - groups: the stable change groups derived at import time
//   - decisions: per-group working decisions (a tentative review)
//   - resolutions: groups already committed (decision + final text)
//   - ledger: inverse ops of every commit, enabling decision undo
//
// All state transitions go through changeRevision, which serializes commits
// so two concurrent pages submitting disjoint groups merge cleanly, while
// overlapping decisions fail with revision_conflict.

import {alignSide, parseTexts, withBaselineIds} from './blocks';
import {applyEffects, applyInverses, materialize} from './engine';
import {buildGroups, resultingOrigins} from './groups';
import type {
  ChangeGroup,
  CommitResponse,
  Decision,
  DecisionChoice,
  Effect,
  Inverse,
  OriginBlock,
  Resolution,
} from './types';

export type LedgerEntry = {
  revision: number;
  groupId: string;
  choice: DecisionChoice | 'auto';
  inverses: Inverse[];
};

export type ReviewDoc = {
  id: string;
  name: string;
  revision: number;
  baseline: {id: string; text: string}[];
  localText: string;
  remoteText: string;
  localVersion: OriginBlock[];
  remoteVersion: OriginBlock[];
  groups: ChangeGroup[];
  decisions: Record<string, Decision>;
  resolutions: Record<string, Resolution>;
  ledger: LedgerEntry[];
  blocks: OriginBlock[]; // current integrated document
  updatedAt: string;
};

const docs = new Map<string, ReviewDoc>();
let sequence = 0;
const waiters: Array<() => void> = [];

async function changeRevision<T>(doc: ReviewDoc, fn: () => T): Promise<T> {
  // Simple async mutex so concurrent requests are applied atomically.
  while ((doc as {locked?: boolean}).locked) {
    await new Promise<void>(resolve => waiters.push(resolve));
  }
  (doc as {locked?: boolean}).locked = true;
  try {
    return fn();
  } finally {
    (doc as {locked?: boolean}).locked = false;
    const next = waiters.shift();
    if (next) next();
  }
}

export function listReviews(): Array<{
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  groups: number;
  pending: number;
}> {
  return [...docs.values()].map(doc => ({
    id: doc.id,
    name: doc.name,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    groups: doc.groups.length,
    pending: doc.groups.filter(group => !doc.resolutions[group.id]).length,
  }));
}

export function getReview(id: string): ReviewDoc | undefined {
  return docs.get(id);
}

export function createReview(input: {
  name: string;
  baseline: string;
  local: string;
  remote: string;
}): ReviewDoc {
  const baselineTexts = parseTexts(input.baseline);
  const localTexts = parseTexts(input.local);
  const remoteTexts = parseTexts(input.remote);
  const baseline = withBaselineIds(baselineTexts);
  const localAlignment = alignSide(baseline, localTexts, 'local');
  const remoteAlignment = alignSide(baseline, remoteTexts, 'remote');
  const {groups} = buildGroups(baseline, localAlignment, remoteAlignment);

  sequence += 1;
  const id = `rev-${sequence}`;
  const doc: ReviewDoc = {
    id,
    name: input.name,
    revision: 0,
    baseline,
    localText: localTexts.join('\n'),
    remoteText: remoteTexts.join('\n'),
    localVersion: localTexts.map((text, i) => ({
      origin: localAlignment.origins[i],
      text,
    })),
    remoteVersion: remoteTexts.map((text, i) => ({
      origin: remoteAlignment.origins[i],
      text,
    })),
    groups,
    decisions: {},
    resolutions: {},
    ledger: [],
    blocks: baseline.map(block => ({origin: block.id, text: block.text})),
    updatedAt: new Date().toISOString(),
  };
  docs.set(id, doc);
  return doc;
}

export function saveDecision(
  doc: ReviewDoc,
  groupId: string,
  choice: DecisionChoice,
  customText: string | undefined,
): Decision | {error: string} {
  const group = doc.groups.find(value => value.id === groupId);
  if (!group) return {error: 'group_not_found'};
  if (doc.resolutions[groupId]) return {error: 'already_resolved'};
  if (choice === 'merged' && !(customText ?? '').trim()) {
    return {error: 'custom_text_required'};
  }
  if ((choice === 'local' && !group.ops.local) || (choice === 'remote' && !group.ops.remote)) {
    return {error: 'side_unavailable'};
  }
  const decision: Decision = {
    groupId,
    choice,
    customText: choice === 'merged' ? customText : undefined,
    updatedAt: new Date().toISOString(),
  };
  doc.decisions[groupId] = decision;
  return decision;
}

function originsWatchedByGroup(group: ChangeGroup): string[] {
  const origins: string[] = [...group.blockIds];
  for (const op of [group.ops.local, group.ops.remote].filter(
    (value): value is NonNullable<typeof value> => Boolean(value),
  )) {
    for (const origin of resultingOrigins(op)) origins.push(origin);
  }
  return origins;
}

export async function commitGroups(
  doc: ReviewDoc,
  expectedRevision: number,
  groupIds: string[] | null,
): Promise<
  | CommitResponse
  | {
      error: 'revision_conflict';
      current: number;
      resolvedByOthers: string[];
    }
> {
  return changeRevision(doc, () => {
    // Auto groups are folded in on every commit, so they are always
    // deterministic. A *partial* commit only conflicts when one of its
    // explicitly reviewed groups was resolved by another page meanwhile;
    // disjoint decisions merge across revisions. A bulk commit (no explicit
    // ids) still requires an exact revision.
    const stale = doc.revision !== expectedRevision;
    if (stale && groupIds === null) {
      return {
        error: 'revision_conflict' as const,
        current: doc.revision,
        resolvedByOthers: Object.keys(doc.resolutions),
      };
    }

    const requested = new Set(
      groupIds ??
        doc.groups
          .filter(group => !doc.resolutions[group.id])
          .map(group => group.id),
    );

    if (stale) {
      const overlap = [...requested].filter(id => doc.resolutions[id]);
      if (overlap.length > 0) {
        return {
          error: 'revision_conflict' as const,
          current: doc.revision,
          resolvedByOthers: overlap,
        };
      }
    }

    // Auto groups are always included; explicit group ids select reviewed
    // conflict groups. A group another page resolved concurrently is skipped
    // (disjoint decisions merge) rather than rejected.
    const skipped: CommitResponse['skipped'] = [];
    const toApply: Array<{group: ChangeGroup; choice: DecisionChoice | 'auto'; customText?: string}> = [];
    for (const group of doc.groups) {
      if (doc.resolutions[group.id]) {
        if (requested.has(group.id)) {
          skipped.push({groupId: group.id, reason: 'already_resolved'});
        }
        continue;
      }
      if (group.auto) {
        toApply.push({group, choice: 'auto'});
      } else if (requested.has(group.id)) {
        const decision = doc.decisions[group.id];
        if (!decision) {
          skipped.push({groupId: group.id, reason: 'no_decision'});
          continue;
        }
        toApply.push({
          group,
          choice: decision.choice,
          customText: decision.customText,
        });
      }
    }

    const applied: string[] = [];
    let blocks = doc.blocks;
    const newLedger: LedgerEntry[] = [];
    const newResolutions: Record<string, Resolution> = {};

    doc.revision += 1;
    const revision = doc.revision;

    for (const item of toApply) {
      const effects: Effect[] = materialize(
        item.group,
        item.choice,
        item.customText,
      );
      const watched = originsWatchedByGroup(item.group);
      const outcome = applyEffects(blocks, effects, watched);
      blocks = outcome.blocks;

      const finalTexts: Record<string, string> = {};
      for (const [origin, text] of Object.entries(outcome.finalTexts)) {
        finalTexts[origin] = text;
      }

      newLedger.push({
        revision,
        groupId: item.group.id,
        choice: item.choice,
        inverses: outcome.inverses,
      });
      newResolutions[item.group.id] = {
        groupId: item.group.id,
        choice: item.choice,
        finalTexts,
        revision,
      };
      applied.push(item.group.id);
    }

    doc.blocks = blocks;
    doc.ledger.push(...newLedger);
    Object.assign(doc.resolutions, newResolutions);
    doc.updatedAt = new Date().toISOString();

    return {
      revision: doc.revision,
      applied,
      skipped,
      pending: doc.groups
        .filter(group => !doc.resolutions[group.id])
        .map(group => group.id),
    };
  });
}

export async function undoGroup(
  doc: ReviewDoc,
  expectedRevision: number,
  groupId: string,
): Promise<
  | {revision: number; groupId: string; blocks: OriginBlock[]}
  | {error: 'revision_conflict'; current: number}
  | {error: 'not_resolved'}
> {
  return changeRevision(doc, () => {
    if (doc.revision !== expectedRevision) {
      return {error: 'revision_conflict' as const, current: doc.revision};
    }
    const entry = [...doc.ledger].reverse().find(value => value.groupId === groupId);
    if (!entry) return {error: 'not_resolved' as const};

    doc.blocks = applyInverses(doc.blocks, entry.inverses);
    doc.ledger = doc.ledger.filter(value => value !== entry);
    delete doc.resolutions[groupId];
    delete doc.decisions[groupId];
    doc.revision += 1;
    doc.updatedAt = new Date().toISOString();
    return {revision: doc.revision, groupId, blocks: doc.blocks};
  });
}

// --- demo seed ---------------------------------------------------------------

export function seedDemo() {
  if (docs.size > 0) return;
  createReview({
    name: '发布说明三方审阅',
    baseline: [
      '标题：发布说明 v2',
      '本次版本修复若干缺陷。',
      '安装方式：运行 install.sh。',
      '联系团队：发送邮件到 dev@example.com。',
      '附录包含完整的接口清单。',
      '感谢所有贡献者。',
      '重复段落：保持原样。',
      '重复段落：保持原样。',
    ].join('\n'),
    local: [
      '标题：发布说明 v2',
      '本次版本修复若干缺陷，并提升启动速度。', // 同块双改 (L)
      '安装方式：运行 install.sh。',
      '联系团队：发送邮件到 docs@example.com。', // 删除+修改（远端删本段）
      '附录包含完整的接口清单。',
      '感谢所有贡献者。',
      '本地新增：阅读升级指南。', // 本地插入
      '重复段落：保持原样。',
      '重复段落：保持原样。',
    ].join('\n'),
    remote: [
      '标题：发布说明 v2',
      '本次版本修复若干缺陷，并优化内存占用。', // 同块双改 (R) -> 冲突
      '安装方式：',
      'Linux 运行 install.sh。', // 真正拆分安装段
      'Windows 运行 setup.ps1。',
      '联系团队：发送邮件到 dev@example.com。',
      '附录包含完整的接口清单与示例。', // 编辑
      '重复段落：保持原样。',
      '重复段落：保持原样。',
      '感谢所有贡献者。', // 删除联系段? 不: 保留联系段, 移动感谢段到末尾
    ].join('\n'),
  });
}
