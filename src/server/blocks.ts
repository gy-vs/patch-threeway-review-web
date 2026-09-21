// Block parsing, deterministic derived ids and baseline<->side alignment.
//
// Alignment runs an LCS over block *text* (multiplicity is preserved, so
// repeated paragraphs get distinct origins). Equal blocks that are unmatched
// on both sides pair up as *moves*. The residual del/ins hunks are segmented
// by a dynamic program that chooses the cheapest ordered cover among edit
// (1:1), split (1:k), merge (k:1), delete and insert, using CJK-aware token
// affinity. Identity rule: edits keep the baseline origin; a split keeps the
// parent for its first part and adds derived children; a merge keeps the
// first member; only inserts create brand-new derived origins.

import type {
  Block,
  InsertOp,
  MoveOp,
  SideAlignment,
  SideName,
  SideOp,
} from './types';

// --- deterministic ids -------------------------------------------------------

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// A document is a sequence of non-empty paragraph blocks.
export function parseBlocks(content: string): Block[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map((text, index) => ({id: `b${index + 1}`, text}));
}

export function parseTexts(content: string): string[] {
  return parseBlocks(content).map(block => block.text);
}

export function blocksToText(texts: string[]): string {
  return texts.join('\n');
}

// Re-number baseline ids when a baseline document is first imported.
export function withBaselineIds(texts: string[]): Block[] {
  return texts.map((text, index) => ({id: `b${index + 1}`, text}));
}

export function insertOriginId(
  side: SideName,
  afterId: string | null,
  order: number,
  text: string,
): string {
  return `add:${side}:${afterId ?? 'START'}:${order}:${text}`;
}

function insertKey(afterId: string | null, order: number, text: string): string {
  return `ins:${afterId ?? 'START'}:${order}:${fnv1a(text)}`;
}

export function opGroupKey(op: SideOp): string {
  switch (op.kind) {
    case 'edit':
    case 'delete':
    case 'move':
    case 'split':
      return op.blockId;
    case 'merge':
      return `merge:${op.blockIds.join('+')}`;
    case 'insert':
      return insertKey(op.afterId, op.order, op.text);
  }
}

// --- LCS ---------------------------------------------------------------------

type Pair =
  | {type: 'match'; a: number; b: number}
  | {type: 'del'; a: number}
  | {type: 'ins'; b: number};

export function lcsAlign(a: string[], b: string[]): Pair[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({length: n + 1}, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({type: 'match', a: i, b: j});
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pairs.push({type: 'del', a: i});
      i += 1;
    } else {
      pairs.push({type: 'ins', b: j});
      j += 1;
    }
  }
  while (i < n) pairs.push({type: 'del', a: i++});
  while (j < m) pairs.push({type: 'ins', b: j++});
  return pairs;
}

// Tokenize for similarity: individual CJK characters and individual Latin
// letters/digits. Character granularity makes concatenation markers (B+C,
// BC, B-C) comparable and works for languages without inter-word spaces.
function tokens(text: string): string[] {
  const matches = text.toLowerCase().match(/[㐀-鿿豈-﫿]|[a-z0-9]/g);
  return matches ?? [];
}

// A real edit keeps most of the source paragraph in the same word/char order;
// a split fragment usually contains only a prefix of it. We measure the
// longest common ordered token subsequence relative to the shorter side,
// combined with token overlap, so "fox -> fox jumps high" reads as an edit
// while "alpha -> alpha / beta" reads as a split.
function tokenLcsCount(wa: string[], wb: string[]): number {
  const lcs = new Uint16Array(wa.length + 1);
  for (const tokenB of wb) {
    let diagonal = 0;
    for (let i = 1; i <= wa.length; i += 1) {
      const above = lcs[i];
      if (tokenB === wa[i - 1]) lcs[i] = diagonal + 1;
      else lcs[i] = Math.max(lcs[i], lcs[i - 1]);
      diagonal = above;
    }
  }
  return lcs[wa.length];
}

function editAffinity(a: string, b: string): number {
  const wa = tokens(a);
  const wb = tokens(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const common = tokenLcsCount(wa, wb);
  const coverage = common / Math.min(wa.length, wb.length);
  const overlap = common / Math.max(wa.length, wb.length);
  return Math.min(1, coverage * 0.7 + overlap * 0.3 + 0.15);
}

const HUNK_EDIT_AFFINITY = 0.8;

// True iff two paragraphs look like an edit rather than unrelated split/merge
// fragments: high ordered token affinity, with most source tokens surviving.
function looksLikeEdit(baseText: string, sideText: string): boolean {
  const baseTokens = tokens(baseText);
  const sideTokens = tokens(sideText);
  if (baseTokens.length === 0 || sideTokens.length === 0) return false;
  const coverage = tokenLcsCount(baseTokens, sideTokens) / baseTokens.length;
  return (
    coverage >= 0.8 &&
    editAffinity(baseText, sideText) >= HUNK_EDIT_AFFINITY
  );
}

type Anchor = {afterId: string | null; sideIndex: number};

export function alignSide(
  baseline: Block[],
  sideTexts: string[],
  side: SideName,
): SideAlignment {
  const pairs = lcsAlign(
    baseline.map(block => block.text),
    sideTexts,
  );

  const matchedSideToBase = new Map<number, number>();
  const rawDels: number[] = [];
  const rawInss: number[] = [];
  for (const pair of pairs) {
    if (pair.type === 'match') matchedSideToBase.set(pair.b, pair.a);
    else if (pair.type === 'del') rawDels.push(pair.a);
    else rawInss.push(pair.b);
  }

  // --- move pairing: equal text, unmatched on both sides --------------------
  const movedBaseToSide = new Map<number, number>();
  const movedSideSet = new Set<number>();
  const freeSides = [...rawInss].sort((x, y) => x - y);
  for (const baseIndex of rawDels) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const sideIndex of freeSides) {
      if (movedSideSet.has(sideIndex)) continue;
      if (sideTexts[sideIndex] !== baseline[baseIndex].text) continue;
      const distance = Math.abs(sideIndex - baseIndex);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = sideIndex;
      }
    }
    if (best >= 0) {
      movedBaseToSide.set(baseIndex, best);
      movedSideSet.add(best);
    }
  }

  // Nearest preceding resolved block at a side position -> baseline anchor.
  const anchorCache = new Map<number, Anchor>();
  const anchorAtSide = (sideIndex: number): Anchor => {
    const cached = anchorCache.get(sideIndex);
    if (cached) return cached;
    for (let p = sideIndex - 1; p >= 0; p -= 1) {
      const matched = matchedSideToBase.get(p);
      if (matched !== undefined) {
        const anchor: Anchor = {afterId: baseline[matched].id, sideIndex: p};
        anchorCache.set(sideIndex, anchor);
        return anchor;
      }
      if (movedSideSet.has(p)) {
        const from = [...movedBaseToSide.entries()].find(([, b]) => b === p)!;
        const inner = anchorAtSide(p);
        void from;
        const anchor: Anchor = {...inner, sideIndex: p};
        anchorCache.set(sideIndex, anchor);
        return anchor;
      }
    }
    const anchor: Anchor = {afterId: null, sideIndex: -1};
    anchorCache.set(sideIndex, anchor);
    return anchor;
  };

  const ops: SideOp[] = [];
  for (const [baseIndex, sideIndex] of [...movedBaseToSide.entries()].sort(
    (x, y) => x[1] - y[1],
  )) {
    const anchor = anchorAtSide(sideIndex);
    const op: MoveOp = {
      kind: 'move',
      blockId: baseline[baseIndex].id,
      afterId: anchor.afterId,
      order: sideIndex - anchor.sideIndex - 1,
      side,
    };
    ops.push(op);
  }

  // --- origin assignment -----------------------------------------------------
  // Walk the side document in order. Every block gets exactly one origin:
  // matched/moved blocks keep theirs; edits take a deterministic edit origin;
  // split children derive ids; merged survivor absorbs the block; inserts get
  // insert ids. Classification below fills `originAtSide`.
  // Identity rule (mirrors engine): edits keep the baseline origin, splits
  // keep the parent for the first part and add derived children, merges keep
  // the first member, inserts get derived ids.
  const originAtSide = new Map<number, string>();
  const splitOrigin = (baseIndex: number, k: number) =>
    `split:${baseline[baseIndex].id}:${k}`;
  const mergeOrigin = (baseIndices: number[]) => baseline[baseIndices[0]].id;
  const insertOrigin = (afterId: string | null, order: number, text: string) =>
    insertOriginId(side, afterId, order, text);

  // --- residual hunk classification -----------------------------------------
  const classifyHunk = (
    baseIndices: number[],
    sideIndices: number[],
    anchor: Anchor,
  ) => {
    if (baseIndices.length === 0) {
      sideIndices.forEach(sideIndex => {
        const order = sideIndex - anchor.sideIndex - 1;
        const op: InsertOp = {
          kind: 'insert',
          afterId: anchor.afterId,
          order,
          text: sideTexts[sideIndex],
          side,
        };
        ops.push(op);
        originAtSide.set(sideIndex, insertOrigin(anchor.afterId, order, op.text));
      });
      return;
    }
    if (sideIndices.length === 0) {
      baseIndices.forEach(baseIndex => {
        ops.push({kind: 'delete', blockId: baseline[baseIndex].id, side});
      });
      return;
    }
    if (baseIndices.length === 1 && sideIndices.length === 1) {
      const baseIndex = baseIndices[0];
      const sideIndex = sideIndices[0];
      if (baseline[baseIndex].text === sideTexts[sideIndex]) {
        originAtSide.set(sideIndex, baseline[baseIndex].id);
        return;
      }
      ops.push({
        kind: 'edit',
        blockId: baseline[baseIndex].id,
        text: sideTexts[sideIndex],
        side,
      });
      originAtSide.set(sideIndex, baseline[baseIndex].id);
      return;
    }
    // General n x m: run an inner LCS; recurse on residual slices so
    // rearranged common paragraphs anchor the smaller true gaps.
    const sub = lcsAlign(
      baseIndices.map(index => baseline[index].text),
      sideIndices.map(index => sideTexts[index]),
    );
    const subMatches = sub.filter(pair => pair.type === 'match');
    if (subMatches.length === 0) {
      // Nothing equal inside the hunk. Find the best ordered segmentation
      // into edit (1:1), split (1:k), merge (k:1), delete and insert pieces,
      // using token-affinity costs via dynamic programming.
      const nB = baseIndices.length;
      const nS = sideIndices.length;
      const DELETE_COST = 0.55;
      const INSERT_COST = 0.55;
      const STRUCTURE_PENALTY = 0.08; // slight preference for 1:1 edits

      const baseText = (i: number) => baseline[baseIndices[i]].text;
      const sideText = (j: number) => sideTexts[sideIndices[j]];

      // cost of covering one base with one contiguous side segment [j0,j1)
      const affinityGrid: number[][] = baseIndices.map((_, i) =>
        sideIndices.map((_, j) => editAffinity(baseText(i), sideText(j))),
      );
      const segmentCost = (i: number, j0: number, j1: number): number => {
        if (j1 - j0 === 1) {
          if (looksLikeEdit(baseText(i), sideText(j0))) {
            return 1 - affinityGrid[i][j0];
          }
          return Number.POSITIVE_INFINITY;
        }
        const joined = sideIndices
          .slice(j0, j1)
          .map(index => sideTexts[index])
          .join('');
        const joinedTokens = tokens(joined);
        const baseTokens = tokens(baseText(i));
        const common = tokenLcsCount(baseTokens, joinedTokens);
        // A real split reproduces essentially the entire source paragraph
        // across its fragments; weak coverage is not a split.
        const coverage = common / Math.max(baseTokens.length, 1);
        if (coverage < 0.85) return Number.POSITIVE_INFINITY;
        let cost = 1 - coverage + (j1 - j0) * STRUCTURE_PENALTY;
        // Soft penalty: a fragment that itself looks like a high-affinity edit
        // of a *different* base block belongs to that block instead.
        for (let jj = j0; jj < j1; jj += 1) {
          for (let other = 0; other < nB; other += 1) {
            if (other === i) continue;
            if (affinityGrid[other][jj] >= 0.9) cost += 0.5;
          }
        }
        return cost;
      };
      // cost of covering a contiguous base segment [i0,i1) with one side block
      const mergeCost = (i0: number, i1: number, j: number): number => {
        const joined = baseIndices
          .slice(i0, i1)
          .map(index => baseline[index].text)
          .join('');
        const joinedTokens = tokens(joined);
        const sideTokens = tokens(sideText(j));
        const common = tokenLcsCount(joinedTokens, sideTokens);
        const coverage = common / Math.max(joinedTokens.length, 1);
        if (coverage < 0.85) return Number.POSITIVE_INFINITY;
        let cost = 1 - coverage + (i1 - i0) * STRUCTURE_PENALTY;
        for (let ii = i0; ii < i1; ii += 1) {
          for (let other = 0; other < nS; other += 1) {
            if (other === j) continue;
            if (affinityGrid[ii][other] >= 0.9) cost += 0.5;
          }
        }
        return cost;
      };

      type Choice =
        | {move: 'edit' | 'split'; i: number; j0: number; j1: number}
        | {move: 'merge'; i0: number; i1: number; j: number}
        | {move: 'delete'; i: number}
        | {move: 'insert'; j: number};
      const dp: number[][] = Array.from({length: nB + 1}, () =>
        new Array(nS + 1).fill(Number.POSITIVE_INFINITY),
      );
      const back: (Choice | null)[][] = Array.from({length: nB + 1}, () =>
        new Array<Choice | null>(nS + 1).fill(null),
      );
      dp[0][0] = 0;
      for (let i = 0; i <= nB; i += 1) {
        for (let j = 0; j <= nS; j += 1) {
          if (dp[i][j] === Number.POSITIVE_INFINITY) continue;
          const relax = (ni: number, nj: number, cost: number, choice: Choice) => {
            if (cost < Number.POSITIVE_INFINITY && dp[i][j] + cost < dp[ni][nj]) {
              dp[ni][nj] = dp[i][j] + cost;
              back[ni][nj] = choice;
            }
          };
          if (i < nB) relax(i + 1, j, DELETE_COST, {move: 'delete', i});
          if (j < nS) relax(i, j + 1, INSERT_COST, {move: 'insert', j});
          if (i < nB && j < nS) {
            // 1:k (edit when k=1, split when k>=2)
            for (let j1 = j + 1; j1 <= nS; j1 += 1) {
              const cost = segmentCost(i, j, j1);
              relax(i + 1, j1, cost, {
                move: j1 - j === 1 ? 'edit' : 'split',
                i,
                j0: j,
                j1,
              });
            }
            // k:1 merges (k>=2)
            for (let i1 = i + 2; i1 <= nB; i1 += 1) {
              const cost = mergeCost(i, i1, j);
              relax(i1, j + 1, cost, {move: 'merge', i0: i, i1, j});
            }
          }
        }
      }

      // Reconstruct (in reverse), then emit in document order.
      const choices: Choice[] = [];
      let i = nB;
      let j = nS;
      while (i > 0 || j > 0) {
        const choice = back[i][j];
        if (!choice) break;
        choices.push(choice);
        if (choice.move === 'delete') i -= 1;
        else if (choice.move === 'insert') j -= 1;
        else if (choice.move === 'merge') {
          i = choice.i0;
          j -= 1;
        } else {
          i -= 1;
          j = choice.j0;
        }
      }
      choices.reverse();

      for (const choice of choices) {
        if (choice.move === 'delete') {
          const b = baseIndices[choice.i];
          ops.push({kind: 'delete', blockId: baseline[b].id, side});
        } else if (choice.move === 'insert') {
          const s = sideIndices[choice.j];
          const order = s - anchor.sideIndex - 1;
          ops.push({
            kind: 'insert',
            afterId: anchor.afterId,
            order,
            text: sideTexts[s],
            side,
          });
          originAtSide.set(s, insertOrigin(anchor.afterId, order, sideTexts[s]));
        } else if (choice.move === 'edit') {
          const b = baseIndices[choice.i];
          const s = sideIndices[choice.j0];
          ops.push({
            kind: 'edit',
            blockId: baseline[b].id,
            text: sideTexts[s],
            side,
          });
          originAtSide.set(s, baseline[b].id);
        } else if (choice.move === 'split') {
          const b = baseIndices[choice.i];
          const slice = sideIndices.slice(choice.j0, choice.j1);
          ops.push({
            kind: 'split',
            blockId: baseline[b].id,
            parts: slice.map(s => sideTexts[s]),
            side,
          });
          slice.forEach((s, k) =>
            originAtSide.set(s, k === 0 ? baseline[b].id : splitOrigin(b, k)),
          );
        } else if (choice.move === 'merge') {
          const slice = baseIndices.slice(choice.i0, choice.i1);
          const s = sideIndices[choice.j];
          ops.push({
            kind: 'merge',
            blockIds: slice.map(b => baseline[b].id),
            text: sideTexts[s],
            side,
          });
          originAtSide.set(s, mergeOrigin(slice));
        }
      }
      return;
    }
    let subAnchor = anchor;
    let subDels: number[] = [];
    let subInss: number[] = [];
    const flushSub = () => {
      if (subDels.length || subInss.length) {
        classifyHunk(subDels, subInss, subAnchor);
      }
      subDels = [];
      subInss = [];
    };
    for (const pair of sub) {
      if (pair.type === 'match') {
        flushSub();
        const baseIndex = baseIndices[pair.a];
        const sideIndex = sideIndices[pair.b];
        subAnchor = {afterId: baseline[baseIndex].id, sideIndex};
      } else if (pair.type === 'del') subDels.push(baseIndices[pair.a]);
      else subInss.push(sideIndices[pair.b]);
    }
    flushSub();
  };

  // Walk raw LCS pairs; del/inss between matches form residual hunks.
  let hunkDels: number[] = [];
  let hunkInss: number[] = [];
  let pendingAnchor = anchorAtSide(0);
  const flushHunk = () => {
    const dels = hunkDels.filter(index => !movedBaseToSide.has(index));
    const inss = hunkInss.filter(index => !movedSideSet.has(index));
    if (dels.length || inss.length) classifyHunk(dels, inss, pendingAnchor);
    hunkDels = [];
    hunkInss = [];
  };
  for (const pair of pairs) {
    if (pair.type === 'match') {
      flushHunk();
      originAtSide.set(pair.b, baseline[pair.a].id);
      pendingAnchor = {afterId: baseline[pair.a].id, sideIndex: pair.b};
    } else if (pair.type === 'del') {
      hunkDels.push(pair.a);
    } else {
      if (hunkInss.length === 0 && hunkDels.length === 0) {
        pendingAnchor = anchorAtSide(pair.b);
      }
      hunkInss.push(pair.b);
    }
  }
  flushHunk();

  // Origins for moved blocks (filled after classification so edit/split
  // origins never collide with move origins).
  for (const [baseIndex, sideIndex] of movedBaseToSide) {
    originAtSide.set(sideIndex, baseline[baseIndex].id);
  }

  const origins = sideTexts.map((_, sideIndex) => originAtSide.get(sideIndex)!);
  return {ops, origins};
}
