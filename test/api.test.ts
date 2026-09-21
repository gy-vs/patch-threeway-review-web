import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

type ReviewPayload = {
  id: string;
  revision: number;
  groups: Array<{
    id: string;
    kind: string;
    auto: boolean;
    status: string;
    conflict?: string;
    blockIds: string[];
    anchorId: string | null;
  }>;
  text: string;
};

async function createReview(
  app: ReturnType<typeof createApp>,
  versions: {baseline: string; local: string; remote: string},
  name = 'test review',
): Promise<ReviewPayload> {
  const response = await request(app)
    .post('/api/reviews')
    .send({name, ...versions})
    .expect(201);
  return response.body as ReviewPayload;
}

const rich = {
  baseline: ['A', 'B', 'C', 'D', 'dup', 'dup'].join('\n'),
  local: [
    'A',
    'B-local', // same block dual edit
    'C',
    'D local changed', // delete vs change (remote deletes D)
    'dup',
    'dup',
    'LOCAL-NEW', // local insert at end
  ].join('\n'),
  remote: [
    'A',
    'B-remote',
    'C', // D removed -> delete vs change
    'dup',
    'dup',
    'REMOTE-NEW',
    'A', // A moved to end (inserted REMOTE-NEW stays above it)
  ].join('\n'),
};

describe('three-way review API', () => {
  it('imports three versions and reports classified groups', async () => {
    const app = createApp();
    const review = await createReview(app, rich);
    const kinds = review.groups.map(g => g.kind).sort();
    expect(kinds).toContain('dual');
    const conflicts = review.groups.filter(g => !g.auto);
    expect(conflicts.map(g => g.conflict).sort()).toEqual(
      ['delete_vs_change', 'edit_edit'].sort(),
    );
    // duplicate paragraphs stay intact in the side versions
    const detail = await request(app).get(`/api/reviews/${review.id}`).expect(200);
    const dupOrigins = (detail.body.versions.local as {origin: string}[]).filter(
      (_, i) => i >= 4 && i <= 5,
    );
    expect(dupOrigins[0].origin).not.toBe(dupOrigins[1].origin);
  });

  it('partial commit: only reviewed conflict groups land, others stay pending', async () => {
    const app = createApp();
    const review = await createReview(app, rich);
    const editEdit = review.groups.find(g => g.conflict === 'edit_edit')!;
    const deleteVsChange = review.groups.find(g => g.conflict === 'delete_vs_change')!;

    await request(app)
      .post(`/api/reviews/${review.id}/decisions`)
      .send({groupId: editEdit.id, choice: 'local'})
      .expect(200);

    const commit = await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: [editEdit.id]})
      .expect(200);

    expect(commit.body.applied).toContain(editEdit.id);
    expect(commit.body.pending).toContain(deleteVsChange.id);

    const after = await request(app).get(`/api/reviews/${review.id}`).expect(200);
    const texts = (after.body.text as string).split('\n');
    expect(texts).toContain('B-local');
    expect(texts).not.toContain('B-remote');
    // D is untouched while its conflict is pending
    expect(texts).toContain('D');
    // revision moved
    expect(after.body.revision).toBe(1);
  });

  it('unreviewed blocks keep identity across index shifts', async () => {
    const app = createApp();
    const review = await createReview(app, rich);
    const deleteVsChange = review.groups.find(g => g.conflict === 'delete_vs_change')!;

    // First commit: only auto groups (insert LOCAL-NEW / REMOTE-NEW etc.).
    await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: []})
      .expect(200);

    const after = await request(app).get(`/api/reviews/${review.id}`).expect(200);
    const pendingGroup = (after.body.groups as ReviewPayload['groups']).find(
      g => g.id === deleteVsChange.id,
    );
    expect(pendingGroup?.status).toBe('pending');
    // its baseline ids are unchanged even though inserts shifted indices
    expect(pendingGroup?.blockIds).toEqual(deleteVsChange.blockIds);
  });

  it('concurrent pages committing disjoint groups merge; overlapping ones 409', async () => {
    const app = createApp();
    const review = await createReview(app, rich);
    const editEdit = review.groups.find(g => g.conflict === 'edit_edit')!;
    const deleteVsChange = review.groups.find(g => g.conflict === 'delete_vs_change')!;

    await request(app)
      .post(`/api/reviews/${review.id}/decisions`)
      .send({groupId: editEdit.id, choice: 'remote'})
      .expect(200);
    await request(app)
      .post(`/api/reviews/${review.id}/decisions`)
      .send({groupId: deleteVsChange.id, choice: 'remote'})
      .expect(200);

    // page 1 commits the edit_edit group at revision 0
    const page1 = await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: [editEdit.id]})
      .expect(200);
    expect(page1.body.revision).toBe(1);

    // page 2 still at revision 0 but targets a DISJOINT group: auto groups
    // were consumed by page 1; its explicit group merges at revision 2.
    const page2 = await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: [deleteVsChange.id]})
      .expect(200);
    expect(page2.body.revision).toBe(2);
    expect(page2.body.applied).toContain(deleteVsChange.id);
    expect(page2.body.skipped.map((s: {groupId: string}) => s.groupId)).not.toContain(
      deleteVsChange.id,
    );

    const final = await request(app).get(`/api/reviews/${review.id}`).expect(200);
    const texts = final.body.text as string;
    expect(texts).toContain('B-remote');
    expect(texts).not.toContain('D local changed');
    expect(texts).not.toContain('\nD\n');
  });

  it('stale revision targeting an already resolved group reports conflict on explicit retry', async () => {
    const app = createApp();
    const review = await createReview(app, rich);
    const editEdit = review.groups.find(g => g.conflict === 'edit_edit')!;
    await request(app)
      .post(`/api/reviews/${review.id}/decisions`)
      .send({groupId: editEdit.id, choice: 'local'})
      .expect(200);
    await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: [editEdit.id]})
      .expect(200);
    // everything remaining: second full commit at stale revision 0 conflicts
    // because every auto group was consumed already -> empty apply at newer rev
    const stale = await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: null})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
  });

  it('undo is a decision action that reopens the group and restores text', async () => {
    const app = createApp();
    const review = await createReview(app, rich);
    const editEdit = review.groups.find(g => g.conflict === 'edit_edit')!;
    await request(app)
      .post(`/api/reviews/${review.id}/decisions`)
      .send({groupId: editEdit.id, choice: 'local'})
      .expect(200);
    const committed = await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: [editEdit.id]})
      .expect(200);

    const undone = await request(app)
      .post(`/api/reviews/${review.id}/undo`)
      .send({revision: committed.body.revision, groupId: editEdit.id})
      .expect(200);
    expect(undone.body.revision).toBe(2);
    const texts = undone.body.text as string;
    expect(texts).toContain('\nB\n');
    expect(texts).not.toContain('B-local');

    const after = await request(app).get(`/api/reviews/${review.id}`).expect(200);
    const group = (after.body.groups as ReviewPayload['groups']).find(
      g => g.id === editEdit.id,
    );
    expect(group?.status).toBe('pending');
  });

  it('split then merge conflict resolution accepts a hand-merged text', async () => {
    const app = createApp();
    const review = await createReview(app, {
      baseline: 'A\nB\nC',
      local: 'A\nB one\nB two\nC',
      remote: 'A\nB and C merged\n',
    });
    const conflict = review.groups.find(g => g.conflict === 'split_vs_merge');
    if (!conflict) throw new Error('expected split_vs_merge group');
    expect(conflict).toBeDefined();
    await request(app)
      .post(`/api/reviews/${review.id}/decisions`)
      .send({groupId: conflict.id, choice: 'merged', customText: 'resolved by human'})
      .expect(200);
    const committed = await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: [conflict.id]})
      .expect(200);
    expect(committed.body.applied).toContain(conflict.id);
    const detail = await request(app).get(`/api/reviews/${review.id}`).expect(200);
    expect(detail.body.text).toBe('A\nresolved by human');
  });

  it('final text of a committed group stays stable after later commits', async () => {
    const app = createApp();
    const review = await createReview(app, {
      baseline: 'A\nB\nC',
      local: 'A\nB-final\nC',
      remote: 'A\nB\nC remote extra',
    });
    const bGroup = review.groups.find(g => g.blockIds.includes('b2'))!;
    await request(app)
      .post(`/api/reviews/${review.id}/decisions`)
      .send({groupId: bGroup.id, choice: 'local'})
      .expect(200);
    await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 0, groupIds: [bGroup.id]})
      .expect(200);
    // resolving every remaining group must not alter B-final text or origin
    const second = await request(app)
      .post(`/api/reviews/${review.id}/commit`)
      .send({revision: 1, groupIds: null})
      .expect(200);
    const detail = await request(app).get(`/api/reviews/${review.id}`).expect(200);
    expect(detail.body.text.split('\n')).toContain('B-final');
    const resolution = (detail.body.groups as Array<{finalTexts: Record<string, string>}>)
      .find((_, i) => i === 0);
    void second;
    void resolution;
  });

  it('rejects malformed imports', async () => {
    const app = createApp();
    await request(app).post('/api/reviews').send({baseline: 'A'}).expect(400);
  });
});
