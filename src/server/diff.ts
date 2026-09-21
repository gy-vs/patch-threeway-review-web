import type {Block, MoveFacet, Op} from '../shared/model';

// One-sided diff: baseline blocks (with stable ids) -> side paragraphs.
// Matching is identity-based, never index-based:
//   1. LCS over exact text anchors the in-order blocks (deterministic
//      tie-break keeps duplicate paragraphs attributed to the right id).
//   2. Remaining exact text pairs are out-of-order matches => moves.
//   3. Consecutive unmatched baseline runs equal to one side block => merge.
//   4. One unmatched baseline block equal to consecutive side run => split.
//   5. Best-similarity pairing of the rest => edits; leftovers => add/delete.

// Ops that can carry a move facet (pairs never hold move/add ops).
type FacetOp = Extract<Op, {moved?: MoveFacet}>;

type Pair = {base: number; side: number; op: FacetOp | null; stationary: boolean};

const SEPS = ['', ' ', '\n'];

function lcsPairs(base: string[], side: string[]): [number, number][] {
  const n = base.length, m = side.length;
  const dp: number[][] = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = base[i] === side[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (base[i] === side[j]) {pairs.push([i, j]); i++; j++;}
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; // tie: skip the baseline block first
    else j++;
  }
  return pairs;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9一-鿿]+/i).filter(t => t.length >= 2));
}

// Similarity score used to pair rewritten blocks; 0 means unrelated.
function score(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const contains = a.includes(b) || b.includes(a) ? 0.5 : 0;
  return jaccard + contains;
}

const EDIT_THRESHOLD = 0.2;

function runsOf(idxs: number[]): number[][] {
  const runs: number[][] = [];
  for (const idx of idxs) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === idx - 1) last.push(idx);
    else runs.push([idx]);
  }
  return runs;
}

export function diffBlocks(base: Block[], sideTexts: string[], sidePrefix: 'l' | 'r'): Op[] {
  const baseTexts = base.map(b => b.text);
  const pairs: Pair[] = [];
  const matchedBase = new Set<number>();
  const matchedSide = new Set<number>();

  // 1. LCS anchors (stationary blocks, duplicates included).
  for (const [b, s] of lcsPairs(baseTexts, sideTexts)) {
    pairs.push({base: b, side: s, op: null, stationary: true});
    matchedBase.add(b);
    matchedSide.add(s);
  }

  // 2. Out-of-order exact matches => moves (k-th unmatched occurrence pairs
  //    with k-th unmatched occurrence, so duplicates stay deterministic).
  const restBaseByText = new Map<string, number[]>();
  const restSideByText = new Map<string, number[]>();
  for (let i = 0; i < baseTexts.length; i++) {
    if (!matchedBase.has(i)) {
      const arr = restBaseByText.get(baseTexts[i]) ?? [];
      arr.push(i);
      restBaseByText.set(baseTexts[i], arr);
    }
  }
  for (let i = 0; i < sideTexts.length; i++) {
    if (!matchedSide.has(i)) {
      const arr = restSideByText.get(sideTexts[i]) ?? [];
      arr.push(i);
      restSideByText.set(sideTexts[i], arr);
    }
  }
  const moves: Pair[] = [];
  for (const [text, bIdxs] of restBaseByText) {
    const sIdxs = restSideByText.get(text) ?? [];
    for (let k = 0; k < Math.min(bIdxs.length, sIdxs.length); k++) {
      moves.push({base: bIdxs[k], side: sIdxs[k], op: null, stationary: false});
      matchedBase.add(bIdxs[k]);
      matchedSide.add(sIdxs[k]);
    }
  }

  const consumedBase = new Set<number>();
  const consumedSide = new Set<number>();
  const merges: Op[] = [];
  const splits: Op[] = [];
  let fresh = 0;
  const newId = () => `${sidePrefix}${++fresh}`;

  const unmatchedBase = () =>
    baseTexts.map((_, i) => i).filter(i => !matchedBase.has(i) && !consumedBase.has(i));
  const unmatchedSide = () =>
    sideTexts.map((_, i) => i).filter(i => !matchedSide.has(i) && !consumedSide.has(i));

  // 3. Merges: consecutive unmatched baseline blocks joined equal one side block.
  const sideByText = new Map<string, number[]>();
  for (const s of unmatchedSide()) {
    const arr = sideByText.get(sideTexts[s]) ?? [];
    arr.push(s);
    sideByText.set(sideTexts[s], arr);
  }
  for (const run of runsOf(unmatchedBase())) {
    let i = 0;
    while (i < run.length) {
      let eaten = 0;
      for (let len = run.length - i; len >= 2 && !eaten; len--) {
        const slice = run.slice(i, i + len);
        const texts = slice.map(b => baseTexts[b]);
        for (const sep of SEPS) {
          const joined = texts.join(sep);
          const target = (sideByText.get(joined) ?? []).find(s => !consumedSide.has(s));
          if (target !== undefined) {
            const op: Op = {kind: 'merge', blockIds: slice.map(b => base[b].id), text: joined};
            merges.push(op);
            pairs.push({base: slice[0], side: target, op, stationary: false});
            slice.forEach(b => consumedBase.add(b));
            consumedSide.add(target);
            eaten = len;
            break;
          }
        }
      }
      i += eaten || 1;
    }
  }

  // 4. Splits: one unmatched baseline block equals a consecutive side run.
  for (const b of unmatchedBase()) {
    const text = baseTexts[b];
    let done = false;
    for (const run of runsOf(unmatchedSide())) {
      for (let start = 0; start < run.length && !done; start++) {
        for (let len = run.length - start; len >= 2 && !done; len--) {
          const slice = run.slice(start, start + len);
          const parts = slice.map(s => sideTexts[s]);
          if (SEPS.some(sep => parts.join(sep) === text)) {
            const partIds = [base[b].id, ...parts.slice(1).map(() => newId())];
            const op: Op = {kind: 'split', blockId: base[b].id, partIds, parts};
            splits.push(op);
            pairs.push({base: b, side: slice[0], op, stationary: false});
            consumedBase.add(b);
            slice.forEach(s => consumedSide.add(s));
            done = true;
          }
        }
      }
      if (done) break;
    }
  }

  // 5. Greedy best-similarity pairing => edits; leftovers => deletes/adds.
  const edits: Op[] = [];
  const deletes: Op[] = [];
  const addSides: number[] = [];
  const remBase = unmatchedBase();
  const remSide = unmatchedSide();
  const candidates: {b: number; s: number; score: number}[] = [];
  for (const b of remBase) {
    for (const s of remSide) {
      const sc = score(baseTexts[b], sideTexts[s]);
      if (sc >= EDIT_THRESHOLD) candidates.push({b, s, score: sc});
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.b - y.b || x.s - y.s);
  const pairedBase = new Set<number>();
  const pairedSide = new Set<number>();
  for (const {b, s} of candidates) {
    if (pairedBase.has(b) || pairedSide.has(s)) continue;
    pairedBase.add(b);
    pairedSide.add(s);
    const op: Op = {kind: 'edit', blockId: base[b].id, from: baseTexts[b], to: sideTexts[s]};
    edits.push(op);
    pairs.push({base: b, side: s, op, stationary: false});
  }
  for (const b of remBase) {
    if (!pairedBase.has(b)) deletes.push({kind: 'delete', blockId: base[b].id, text: baseTexts[b]});
  }
  for (const s of remSide) {
    if (!pairedSide.has(s)) addSides.push(s);
  }

  // 6. Moved facets for edit/split/merge pairs that are out of order
  //    relative to the stationary anchors.
  const stationary = pairs.filter(p => p.stationary).sort((a, b) => a.side - b.side);
  const inOrder = (p: Pair): boolean => {
    for (const q of stationary) {
      if (q.base < p.base && q.side >= p.side) return false;
      if (q.base > p.base && q.side <= p.side) return false;
    }
    return true;
  };
  // Nearest preceding anchor (by side order) -> its stable baseline id.
  const anchorAfter = (sideIdx: number, anchors: Pair[]): string | null => {
    let anchor: string | null = null;
    for (const p of anchors) {
      if (p.side < sideIdx) anchor = base[p.base].id;
      else break;
    }
    return anchor;
  };
  for (const p of pairs) {
    if (p.op && !p.stationary && !inOrder(p)) {
      p.op.moved = {after: anchorAfter(p.side, stationary), seq: p.side};
    }
  }
  // Non-moved edit/split/merge pairs also become anchors for what follows.
  const anchorPairs = pairs
    .filter(p => p.stationary || (p.op !== null && !p.op.moved))
    .sort((a, b) => a.side - b.side);

  // 7. Standalone move ops and adds, anchored by identity.
  const moveOps: Op[] = moves.map(p => ({
    kind: 'move',
    blockId: base[p.base].id,
    after: anchorAfter(p.side, anchorPairs),
    seq: p.side,
  }));
  const addOps: Op[] = addSides.map(s => ({
    kind: 'add',
    id: newId(),
    text: sideTexts[s],
    after: anchorAfter(s, anchorPairs),
    seq: s,
  }));

  const byBase = (op: Op): number => {
    const id = op.kind === 'merge' ? op.blockIds[0] : op.kind === 'add' ? '' : op.blockId;
    const idx = base.findIndex(b => b.id === id);
    return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
  };
  const sortOps = (ops: Op[]) => ops.sort((x, y) => byBase(x) - byBase(y));
  return [
    ...sortOps(merges),
    ...sortOps(splits),
    ...sortOps(edits),
    ...sortOps(deletes),
    ...addOps.sort((x, y) => (x.kind === 'add' && y.kind === 'add' ? x.seq - y.seq : 0)),
    ...moveOps.sort((x, y) => (x.kind === 'move' && y.kind === 'move' ? x.seq - y.seq : 0)),
  ];
}
