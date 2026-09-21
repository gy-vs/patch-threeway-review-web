import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {ChangeView, Decision} from '../src/shared/model';

const app = createApp();

async function createDoc(body: {name?: string; baseline: string; local: string; remote: string}) {
  const res = await request(app).post('/api/documents').send({name: 'test', ...body}).expect(201);
  return res.body.id as string;
}
const review = async (id: string) => (await request(app).get(`/api/documents/${id}/review`).expect(200)).body;
const result = async (id: string) => (await request(app).get(`/api/documents/${id}/result`).expect(200)).body;
const decide = (id: string, baseRevision: number, decisions: Decision[]) =>
  request(app).post(`/api/documents/${id}/decisions`).send({baseRevision, decisions});
const conflicts = (changes: ChangeView[]) => changes.filter(c => c.conflict);

describe('three-way import and change generation', () => {
  it('imports baseline/local/remote and auto-combines split with merge', async () => {
    const id = await createDoc({
      baseline: 'Alpha Beta\n\nmid\n\nGamma\n\nDelta',
      local: 'Alpha\n\nBeta\n\nmid\n\nGamma\n\nDelta',
      remote: 'Alpha Beta\n\nmid\n\nGamma Delta',
    });
    const rev = await review(id);
    expect(rev.stats).toEqual({total: 2, auto: 2, pending: 0, resolved: 0});
    expect(rev.changes.map((c: ChangeView) => c.kind).sort()).toEqual(['merge', 'split']);
    const res = await result(id);
    expect(res.text).toBe('Alpha\n\nBeta\n\nmid\n\nGamma Delta');
  });

  it('composes move and edit on the same block automatically', async () => {
    const id = await createDoc({
      baseline: 'alpha\n\nbravo\n\ncharlie',
      local: 'charlie\n\nalpha\n\nbravo',
      remote: 'alpha\n\nbravo\n\ncharlie updated',
    });
    const rev = await review(id);
    expect(rev.stats.pending).toBe(0);
    expect(rev.changes[0].kind).toBe('move-edit');
    const res = await result(id);
    expect(res.text).toBe('charlie updated\n\nalpha\n\nbravo');
  });

  it('keeps duplicate paragraph identities across both sides', async () => {
    const id = await createDoc({
      baseline: 'Intro\n\nBody\n\nIntro',
      local: 'Intro updated\n\nBody\n\nIntro',
      remote: 'Intro\n\nBody\n\nIntro updated',
    });
    const rev = await review(id);
    expect(rev.stats.auto).toBe(2);
    expect(rev.changes[0].blockIds).toEqual(['b1']);
    expect(rev.changes[1].blockIds).toEqual(['b3']);
    const res = await result(id);
    expect(res.text).toBe('Intro updated\n\nBody\n\nIntro updated');
  });
});

describe('decisions and partial submit', () => {
  it('commits reviewed conflicts only and keeps the rest pending', async () => {
    const id = await createDoc({
      baseline: 'one\n\ntwo\n\nthree\n\nfour',
      local: 'one\n\ntwo L\n\nthree\n\nfour L',
      remote: 'one\n\ntwo R\n\nthree\n\nfour R',
    });
    const rev = await review(id);
    expect(rev.stats).toEqual({total: 2, auto: 0, pending: 2, resolved: 0});
    const [c1, c2] = conflicts(rev.changes);
    expect(c1.blockIds).toEqual(['b2']);
    expect(c2.blockIds).toEqual(['b4']);

    // Partial submit: only the first conflict is decided.
    const first = await decide(id, 1, [{changeId: c1.id, resolution: 'local'}]).expect(200);
    expect(first.body.revision).toBe(2);
    let res = await result(id);
    expect(res.text).toBe('one\n\ntwo L\n\nthree\n\nfour'); // c2 still pending -> baseline
    expect(res.pending).toBe(1);

    // Second patch on top of the current revision; the committed block's
    // final text stays stable.
    await decide(id, 2, [{changeId: c2.id, resolution: 'remote'}]).expect(200);
    res = await result(id);
    expect(res.text).toBe('one\n\ntwo L\n\nthree\n\nfour R');
    const rev2 = await review(id);
    expect(rev2.stats).toEqual({total: 2, auto: 0, pending: 0, resolved: 2});
    expect(rev2.patches).toHaveLength(3); // import + two decision batches
  });

  it('undoes a decision through a decision operation', async () => {
    const id = await createDoc({
      baseline: 'keep one\n\nremove me please\n\nkeep three',
      local: 'keep one\n\nkeep three',
      remote: 'keep one\n\nremove me please updated\n\nkeep three',
    });
    const rev = await review(id);
    const [change] = conflicts(rev.changes);
    expect(change.local[0].kind).toBe('delete');
    expect(change.remote[0].kind).toBe('edit');

    await decide(id, 1, [{changeId: change.id, resolution: 'remote'}]).expect(200);
    expect((await result(id)).text).toBe('keep one\n\nremove me please updated\n\nkeep three');

    // Undo is itself a decision: resolution 'pending' reopens the conflict.
    await decide(id, 2, [{changeId: change.id, resolution: 'pending'}]).expect(200);
    const after = await review(id);
    expect(after.stats.pending).toBe(1);
    expect((await result(id)).text).toBe('keep one\n\nremove me please\n\nkeep three');
  });

  it('rejects decisions on non-conflict changes and stale base revisions', async () => {
    const id = await createDoc({
      baseline: 'one\n\ntwo',
      local: 'one L\n\ntwo',
      remote: 'one\n\ntwo R',
    });
    const rev = await review(id);
    const auto = rev.changes.find((c: ChangeView) => !c.conflict);
    await decide(id, 1, [{changeId: auto.id, resolution: 'local'}]).expect(400);
    await decide(id, 0, []).expect(400);
    await decide(id, 99, [{changeId: 'chg:nope', resolution: 'local'}]).expect(400);
    await request(app).get('/api/documents/doc-nope/review').expect(404);
  });
});

describe('concurrent decisions', () => {
  it('merges disjoint decisions from two pages and rejects overlapping ones', async () => {
    const id = await createDoc({
      baseline: 'one\n\ntwo\n\nthree\n\nfour',
      local: 'one L\n\ntwo\n\nthree L\n\nfour',
      remote: 'one R\n\ntwo\n\nthree R\n\nfour',
    });
    const rev = await review(id);
    const [c1, c2] = conflicts(rev.changes);

    // Page A decides c1 against revision 1.
    await decide(id, 1, [{changeId: c1.id, resolution: 'local'}]).expect(200);
    // Page B decides c2 against the same (now stale) revision: disjoint, so
    // the decisions merge instead of failing.
    const merged = await decide(id, 1, [{changeId: c2.id, resolution: 'remote'}]).expect(200);
    expect(merged.body.revision).toBe(3);
    expect((await review(id)).stats).toEqual({total: 2, auto: 0, pending: 0, resolved: 2});

    // Page A re-decides c2 with a stale base: conflict, current state returned.
    const conflict = await decide(id, 1, [{changeId: c2.id, resolution: 'local'}]);
    expect(conflict.status).toBe(409);
    expect(conflict.body.conflicts).toEqual([{changeId: c2.id, current: 'remote'}]);

    // Same resolution again: idempotent, accepted.
    await decide(id, 1, [{changeId: c2.id, resolution: 'remote'}]).expect(200);

    const res = await result(id);
    expect(res.text).toBe('one L\n\ntwo\n\nthree R\n\nfour');
  });

  it('keeps pending block identities stable when committed changes shift indexes', async () => {
    const id = await createDoc({
      baseline: 'alpha\n\nbravo\n\ncharlie\n\ndelta\n\necho',
      local: 'bravo\n\ncharlie\n\ndelta L\n\necho',
      remote: 'alpha edited\n\nbravo\n\ncharlie\n\ndelta R\n\necho',
    });
    const rev = await review(id);
    const [c1, c4] = conflicts(rev.changes);
    expect(c1.blockIds).toEqual(['b1']); // delete vs edit
    expect(c4.blockIds).toEqual(['b4']); // edit vs edit

    // Commit the deletion of the first block: every later block shifts index.
    await decide(id, 1, [{changeId: c1.id, resolution: 'local'}]).expect(200);
    let res = await result(id);
    expect(res.text).toBe('bravo\n\ncharlie\n\ndelta\n\necho');
    expect(res.blocks.map((b: {id: string}) => b.id)).toEqual(['b2', 'b3', 'b4', 'b5']);

    // The pending conflict on b4 is still decidable by identity and lands on
    // the right block; the committed deletion stays stable.
    await decide(id, 2, [{changeId: c4.id, resolution: 'remote'}]).expect(200);
    res = await result(id);
    expect(res.text).toBe('bravo\n\ncharlie\n\ndelta R\n\necho');
    expect(res.blocks.map((b: {id: string}) => b.id)).toEqual(['b2', 'b3', 'b4', 'b5']);
  });
});
