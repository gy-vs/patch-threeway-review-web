import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  commitGroups,
  createReview,
  getReview,
  listReviews,
  saveDecision,
  seedDemo,
  undoGroup,
  type ReviewDoc,
} from './store';
import {blocksToText, parseTexts} from './blocks';
import type {DecisionChoice} from './types';

export function createApp(){
  const app = express();
  app.use(express.json({limit:'2mb'}));

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'three-way-patch-review', count: listReviews().length}),
  );

  app.get('/api/reviews', (_req, res) => res.json(listReviews()));

  app.post('/api/reviews', (req, res) => {
    const {name, baseline, local, remote} = req.body ?? {};
    if (typeof baseline !== 'string' || typeof local !== 'string' || typeof remote !== 'string') {
      return res.status(400).json({error: 'missing_versions'});
    }
    const doc = createReview({
      name: typeof name === 'string' && name.trim() ? name.trim() : '未命名审阅',
      baseline,
      local,
      remote,
    });
    return res.status(201).json(reviewPayload(doc));
  });

  app.get('/api/reviews/:id', (req, res) => {
    const doc = getReview(req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(doc.revision));
    return res.json(reviewPayload(doc));
  });

  // Save a tentative review decision (does not change the document).
  app.post('/api/reviews/:id/decisions', (req, res) => {
    const doc = getReview(req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    const {groupId, choice, customText} = req.body ?? {};
    if (typeof groupId !== 'string' || typeof choice !== 'string') {
      return res.status(400).json({error: 'bad_decision'});
    }
    if (!['local', 'remote', 'keep', 'merged'].includes(choice)) {
      return res.status(400).json({error: 'bad_choice'});
    }
    const result = saveDecision(doc, groupId, choice as DecisionChoice, customText);
    if ('error' in result) return res.status(400).json(result);
    return res.json(result);
  });

  // Partial commit: only the named reviewed groups are applied; auto groups
  // are always folded in; unresolved conflict groups stay pending.
  app.post('/api/reviews/:id/commit', async (req, res) => {
    const doc = getReview(req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    const revision = Number(req.body?.revision);
    const groupIds = Array.isArray(req.body?.groupIds)
      ? req.body.groupIds.filter((value: unknown): value is string => typeof value === 'string')
      : null;
    const result = await commitGroups(doc, revision, groupIds);
    if ('error' in result) return res.status(409).json(result);
    return res.json(result);
  });

  // Undo is itself a decision action: it returns one group to pending and
  // rebuilds the integrated text by replaying the inverse ledger.
  app.post('/api/reviews/:id/undo', async (req, res) => {
    const doc = getReview(req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    const revision = Number(req.body?.revision);
    const groupId = String(req.body?.groupId ?? '');
    const result = await undoGroup(doc, revision, groupId);
    if ('error' in result) {
      if (result.error === 'revision_conflict') return res.status(409).json(result);
      return res.status(400).json(result);
    }
    return res.json({...result, text: blocksToText(result.blocks.map(b => b.text))});
  });

  // Utility: line/block counts for the three imported versions.
  app.post('/api/reviews/:id/analyze', (req, res) => {
    const doc = getReview(req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const version =
      req.body?.version === 'local'
        ? doc.localText
        : req.body?.version === 'remote'
          ? doc.remoteText
          : content;
    return res.json({
      id: doc.id,
      revision: doc.revision,
      blocks: parseTexts(version).length,
      diagnostics: [],
    });
  });

  return app;
}

function reviewPayload(doc: ReviewDoc) {
  return {
    id: doc.id,
    name: doc.name,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    versions: {
      baseline: doc.baseline.map(block => ({origin: block.id, text: block.text})),
      local: doc.localVersion,
      remote: doc.remoteVersion,
    },
    integrated: doc.blocks,
    text: blocksToText(doc.blocks.map(block => block.text)),
    groups: doc.groups.map(group => {
      const resolution = doc.resolutions[group.id];
      return {
        ...group,
        status: resolution ? 'resolved' : 'pending',
        decision: doc.decisions[group.id] ?? null,
        finalTexts: resolution?.finalTexts ?? null,
        committedAtRevision: resolution?.revision ?? null,
      };
    }),
  };
}

seedDemo();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () =>
    console.log('server http://127.0.0.1:4174'),
  );
}
