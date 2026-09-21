import {useCallback, useEffect, useState} from 'react';
import {CheckCircle2, CircleDot, FilePlus2, GitMerge, RotateCcw, Send} from 'lucide-react';
import type {ChangeView, Op, PatchEntry, Resolution, Stats} from '../shared/model';

type DocSummary = {id: string; name: string; revision: number; stats: Stats};
type Review = {id: string; name: string; revision: number; changes: ChangeView[]; stats: Stats; patches: PatchEntry[]};
type Result = {id: string; revision: number; text: string; pending: number};

const KIND_LABEL: Record<string, string> = {
  edit: '编辑',
  move: '移动',
  split: '拆分',
  merge: '合并',
  add: '新增',
  delete: '删除',
  'move-edit': '移动+编辑',
};

function OpLine({op}: {op: Op}) {
  switch (op.kind) {
    case 'edit':
      return (
        <li>
          <span className="tag">编辑</span>
          <del>{op.from}</del>
          <ins>{op.to}</ins>
          {op.moved && <em>（同时移动）</em>}
        </li>
      );
    case 'move':
      return (
        <li>
          <span className="tag">移动</span>移至 {op.after ?? '文档开头'}
        </li>
      );
    case 'split':
      return (
        <li>
          <span className="tag">拆分</span>拆为 {op.parts.length} 段：{op.parts.join(' ／ ')}
        </li>
      );
    case 'merge':
      return (
        <li>
          <span className="tag">合并</span>
          {op.blockIds.join(' + ')} → “{op.text}”
        </li>
      );
    case 'add':
      return (
        <li>
          <span className="tag">新增</span>“{op.text}”
        </li>
      );
    case 'delete':
      return (
        <li>
          <span className="tag">删除</span>
          <del>{op.text}</del>
        </li>
      );
  }
}

function OpList({ops, empty}: {ops: Op[]; empty: string}) {
  if (ops.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="ops">
      {ops.map((op, i) => (
        <OpLine key={i} op={op} />
      ))}
    </ul>
  );
}

export default function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [staged, setStaged] = useState<Map<string, Resolution>>(new Map());
  const [status, setStatus] = useState('就绪');
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState({name: '', baseline: '', local: '', remote: ''});

  const loadDocs = useCallback(async () => {
    const list: DocSummary[] = await fetch('/api/documents').then(r => r.json());
    setDocs(list);
    setSelected(current => current ?? list[0]?.id ?? null);
  }, []);

  const loadReview = useCallback(async (id: string) => {
    const [rev, res] = await Promise.all([
      fetch(`/api/documents/${id}/review`).then(r => r.json()),
      fetch(`/api/documents/${id}/result`).then(r => r.json()),
    ]);
    setReview(rev);
    setResult(res);
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  useEffect(() => {
    if (selected) {
      setStaged(new Map());
      loadReview(selected);
    }
  }, [selected, loadReview]);

  function stage(changeId: string, resolution: Resolution) {
    setStaged(prev => {
      const next = new Map(prev);
      if (next.get(changeId) === resolution) next.delete(changeId);
      else next.set(changeId, resolution);
      return next;
    });
  }

  async function submit() {
    if (!review || staged.size === 0) return;
    setStatus('提交中…');
    const response = await fetch(`/api/documents/${review.id}/decisions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({baseRevision: review.revision, decisions: [...staged].map(([changeId, resolution]) => ({changeId, resolution}))}),
    });
    if (response.status === 409) {
      const body = await response.json();
      setStatus(`有 ${body.conflicts.length} 项决定与他人冲突，已刷新`);
      setStaged(new Map());
      await loadReview(review.id);
      return;
    }
    if (!response.ok) {
      setStatus(`提交失败：${(await response.json()).error ?? response.status}`);
      return;
    }
    setStaged(new Map());
    setStatus('已提交，生成新补丁');
    await Promise.all([loadReview(review.id), loadDocs()]);
  }

  async function importDoc() {
    const response = await fetch('/api/documents', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(form),
    });
    if (!response.ok) {
      setStatus('导入失败：请填写名称与三份文本');
      return;
    }
    const created = await response.json();
    setShowImport(false);
    setForm({name: '', baseline: '', local: '', remote: ''});
    await loadDocs();
    setSelected(created.id);
    setStatus('已导入并生成三方变更');
  }

  const effective = (change: ChangeView): Resolution | undefined =>
    staged.get(change.id) ?? (change.state === 'resolved' ? change.resolution : undefined);

  const pendingChanges = review?.changes.filter(c => c.conflict) ?? [];
  const autoChanges = review?.changes.filter(c => !c.conflict) ?? [];

  return (
    <main className="shell">
      <header className="topbar">
        <GitMerge size={20} />
        <strong>文档补丁工作台</strong>
        <small>三方评审 · 按块身份合并</small>
        {review && (
          <span className="rev">
            修订 r{review.revision} · 补丁 {review.patches.length} 个
          </span>
        )}
      </header>
      <section className="workspace">
        <aside className="pane">
          <div className="pane-head">
            <h2>文档</h2>
            <button onClick={() => setShowImport(v => !v)}>
              <FilePlus2 size={14} /> 导入
            </button>
          </div>
          {showImport && (
            <div className="import-form">
              <input
                placeholder="名称"
                value={form.name}
                onChange={e => setForm({...form, name: e.target.value})}
              />
              <label>基线</label>
              <textarea rows={4} value={form.baseline} onChange={e => setForm({...form, baseline: e.target.value})} />
              <label>本地版</label>
              <textarea rows={4} value={form.local} onChange={e => setForm({...form, local: e.target.value})} />
              <label>远端版</label>
              <textarea rows={4} value={form.remote} onChange={e => setForm({...form, remote: e.target.value})} />
              <button className="primary" onClick={importDoc}>
                创建三方评审
              </button>
            </div>
          )}
          <div className="list">
            {docs.map(doc => (
              <button className={doc.id === selected ? 'active' : ''} onClick={() => setSelected(doc.id)} key={doc.id}>
                {doc.name}
                <br />
                <small>
                  r{doc.revision} · 待审 {doc.stats.pending} · 已决 {doc.stats.resolved}
                </small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          {review && (
            <>
              <div className="toolbar">
                <span className="pill">自动合并 {review.stats.auto}</span>
                <span className="pill warn">待审 {review.stats.pending}</span>
                <span className="pill ok">已决 {review.stats.resolved}</span>
                <span className="spacer" />
                <span className="muted">{status}</span>
                <button className="primary" disabled={staged.size === 0} onClick={submit}>
                  <Send size={14} /> 提交已审决定{staged.size > 0 ? `（${staged.size}）` : ''}
                </button>
              </div>

              <h2>冲突（{pendingChanges.length}）</h2>
              {pendingChanges.length === 0 && <p className="muted">没有需要审阅的冲突。</p>}
              {pendingChanges.map(change => {
                const chosen = effective(change);
                return (
                  <article className={`card ${chosen ? 'decided' : ''}`} key={change.id}>
                    <header>
                      <span className="tag kind">{KIND_LABEL[change.kind]}</span>
                      <code>{change.blockIds.join(' + ')}</code>
                      <span className="spacer" />
                      {chosen ? (
                        <span className="pill ok">
                          <CheckCircle2 size={12} /> {chosen === 'local' ? '采用本地' : chosen === 'remote' ? '采用远端' : '已撤销'}
                          {staged.has(change.id) && '（待提交）'}
                        </span>
                      ) : (
                        <span className="pill warn">
                          <CircleDot size={12} /> 待审
                        </span>
                      )}
                    </header>
                    <div className="variants">
                      <div className={chosen === 'local' ? 'variant chosen' : 'variant'}>
                        <h3>本地方案</h3>
                        <OpList ops={change.local} empty="本地未改动" />
                        <button onClick={() => stage(change.id, 'local')}>采用本地</button>
                      </div>
                      <div className={chosen === 'remote' ? 'variant chosen' : 'variant'}>
                        <h3>远端方案</h3>
                        <OpList ops={change.remote} empty="远端未改动" />
                        <button onClick={() => stage(change.id, 'remote')}>采用远端</button>
                      </div>
                    </div>
                    {(chosen || change.state === 'resolved') && (
                      <button className="undo" onClick={() => stage(change.id, 'pending')}>
                        <RotateCcw size={13} /> 撤销决定（作为新决定提交）
                      </button>
                    )}
                  </article>
                );
              })}

              <h2>自动合并（{autoChanges.length}）</h2>
              {autoChanges.map(change => (
                <div className="auto-row" key={change.id}>
                  <span className="tag kind">{KIND_LABEL[change.kind]}</span>
                  <code>{change.blockIds.join(' + ')}</code>
                  {change.agreed && <span className="pill">双方一致</span>}
                  <div className="auto-ops">
                    <OpList ops={[...change.local, ...change.remote]} empty="" />
                  </div>
                </div>
              ))}
            </>
          )}
        </section>

        <aside className="pane">
          <h2>合并结果</h2>
          {result && (
            <>
              <p className="muted">
                r{result.revision} · 待审 {result.pending} 项（保持基线文本）
              </p>
              <pre className="result">{result.text}</pre>
              <h2>补丁历史</h2>
              <ol className="patches">
                {review?.patches.map(patch => (
                  <li key={patch.revision}>
                    <strong>r{patch.revision}</strong>{' '}
                    {patch.decisions.length === 0
                      ? '导入三方版本'
                      : patch.decisions
                          .map(d => `${d.changeId} → ${d.resolution === 'pending' ? '撤销' : d.resolution === 'local' ? '本地' : '远端'}`)
                          .join('；')}
                  </li>
                ))}
              </ol>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}
