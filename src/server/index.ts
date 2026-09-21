import express from 'express';
import {fileURLToPath} from 'node:url';
import {applyDecisions, createSession, DecisionError, getSession, listSessions, resultOf, reviewOf} from './store';

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/documents', (_req, res) => res.json(listSessions()));

  app.post('/api/documents', (req, res) => {
    const {name, baseline, local, remote} = req.body ?? {};
    if ([name, baseline, local, remote].some(v => typeof v !== 'string' || v.trim().length === 0)) {
      return res.status(400).json({error: 'invalid_document'});
    }
    const session = createSession(name.trim(), baseline, local, remote);
    res.status(201).json({id: session.id, revision: session.revision});
  });

  app.get('/api/documents/:id/review', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({error: 'not_found'});
    res.json(reviewOf(session));
  });

  app.post('/api/documents/:id/decisions', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({error: 'not_found'});
    try {
      const outcome = applyDecisions(session, req.body?.baseRevision, req.body?.decisions);
      if (!outcome.ok) {
        return res.status(409).json({error: 'decision_conflict', conflicts: outcome.conflicts, revision: outcome.revision});
      }
      res.json({id: session.id, revision: outcome.revision, stats: outcome.stats});
    } catch (error) {
      if (error instanceof DecisionError) {
        return res.status(error.status).json({error: error.message, ...error.payload});
      }
      throw error;
    }
  });

  app.get('/api/documents/:id/result', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({error: 'not_found'});
    res.json(resultOf(session));
  });

  return app;
}

function seedDemo() {
  createSession(
    '示例：产品说明书',
    '产品说明书\n\n第一章 概述\n本产品用于文档补丁审阅。\n\n第二章 功能\n支持三方对比。\n\n附录\n版本 1.0',
    '产品说明书\n\n第一章 概述\n本产品用于文档补丁审阅与合并。\n\n第二章 功能\n支持三方对比。\n\n附录\n版本 1.0',
    '产品说明书\n\n第一章 概述\n本产品用于文档补丁审阅与协作。\n\n附录\n版本 1.0\n\n第二章 功能\n支持三方对比。',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedDemo();
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
