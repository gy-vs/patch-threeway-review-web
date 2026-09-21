import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  GitMerge,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Shuffle,
  Sparkles,
} from 'lucide-react';
import {
  api,
  type DecisionChoice,
  type GroupView,
  type ReviewPayload,
  type ReviewSummary,
  type SideName,
} from './api';

type Draft = {choice: DecisionChoice; customText: string};

const KIND_LABEL: Record<string, string> = {
  edit: '编辑',
  delete: '删除',
  move: '移动',
  split: '拆分',
  merge: '合并',
  insert: '插入',
  dual: '双方异构',
};

const CONFLICT_LABEL: Record<string, string> = {
  edit_edit: '同块双改',
  delete_vs_change: '删除 × 修改',
  split_vs_merge: '拆分 × 合并',
  incompatible_structure: '结构不兼容',
};

const SIDE_LABEL: Record<SideName, string> = {local: '本地版', remote: '远端版'};

export default function App() {
  const [items, setItems] = useState<ReviewSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [status, setStatus] = useState<{kind: 'info' | 'ok' | 'error'; text: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshList = useCallback(async () => {
    try {
      setItems(await api.list());
    } catch {
      /* offline */
    }
  }, []);

  const loadReview = useCallback(
    async (id: string, silent = false) => {
      try {
        const payload = await api.get(id);
        setReview(payload);
        setDrafts(previous => {
          const next: Record<string, Draft> = {};
          for (const group of payload.groups) {
            if (group.status === 'resolved') continue;
            const existing = previous[group.id];
            if (existing) next[group.id] = existing;
            else if (group.decision) {
              next[group.id] = {
                choice: group.decision.choice,
                customText: group.decision.customText ?? '',
              };
            }
          }
          return next;
        });
        if (!silent) setStatus({kind: 'ok', text: `已加载 revision ${payload.revision}`});
      } catch (error) {
        if (!silent) setStatus({kind: 'error', text: `加载失败：${(error as Error).message}`});
      }
    },
    [],
  );

  useEffect(() => {
    refreshList().then(() => undefined);
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) return;
    loadReview(selectedId).then(() => undefined);
  }, [selectedId, loadReview]);

  // Light polling: two open pages see each other's committed, disjoint
  // decisions without a reload.
  useEffect(() => {
    if (!selectedId) return;
    const tick = () => {
      loadReview(selectedId, true).then(() => {
        refreshList().then(() => undefined);
        pollRef.current = setTimeout(tick, 2500);
      });
    };
    pollRef.current = setTimeout(tick, 2500);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [selectedId, loadReview, refreshList]);

  const pendingGroups = useMemo(
    () => review?.groups.filter(group => group.status === 'pending') ?? [],
    [review],
  );
  const reviewedIds = useMemo(
    () =>
      pendingGroups
        .filter(group => !group.auto && drafts[group.id]?.choice)
        .map(group => group.id),
    [pendingGroups, drafts],
  );
  const autoPending = useMemo(
    () => pendingGroups.filter(group => group.auto).length,
    [pendingGroups],
  );
  const unresolvedConflicts = useMemo(
    () => pendingGroups.filter(group => !group.auto && !drafts[group.id]?.choice).length,
    [pendingGroups, drafts],
  );

  const setDraft = (groupId: string, draft: Draft) =>
    setDrafts(previous => ({...previous, [groupId]: draft}));

  const persistDraft = async (group: GroupView, draft: Draft) => {
    if (!review) return;
    setDraft(group.id, draft);
    try {
      await api.decide(
        review.id,
        group.id,
        draft.choice,
        draft.choice === 'merged' ? draft.customText : undefined,
      );
    } catch (error) {
      setStatus({kind: 'error', text: `审阅意见未保存：${(error as Error).message}`});
    }
  };

  const commit = async (onlyReviewed: boolean) => {
    if (!review) return;
    setBusy(true);
    setStatus({kind: 'info', text: '正在生成新补丁…'});
    try {
      const result = await api.commit(
        review.id,
        review.revision,
        onlyReviewed ? reviewedIds : null,
      );
      setStatus({
        kind: 'ok',
        text: `revision ${result.revision}：已提交 ${result.applied.length} 组，${result.pending.length} 组保持悬置`,
      });
      await loadReview(review.id, true);
      await refreshList();
    } catch (error) {
      const e = error as Error & {status?: number; body?: {resolvedByOthers?: string[]}};
      if (e.status === 409) {
        setStatus({
          kind: 'error',
          text: `并发冲突：其他页面已提交 ${
            e.body?.resolvedByOthers?.join(', ') ?? '部分组'
          }，已刷新，请重新选择`,
        });
        await loadReview(review.id, true);
      } else {
        setStatus({kind: 'error', text: `提交失败：${e.message}`});
      }
    } finally {
      setBusy(false);
    }
  };

  const undo = async (group: GroupView) => {
    if (!review) return;
    setBusy(true);
    try {
      await api.undo(review.id, review.revision, group.id);
      setStatus({kind: 'ok', text: `已撤销「${group.title}」，该组重新进入待审`});
      await loadReview(review.id, true);
      await refreshList();
    } catch (error) {
      setStatus({kind: 'error', text: `撤销失败：${(error as Error).message}`});
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <header className="topbar">
        <GitMerge size={20} />
        <strong>文档补丁审阅工作台</strong>
        <small>稳定块身份 · 三方变更 · 部分提交</small>
        <div className="topbar-spacer" />
        <button className="ghost" onClick={() => setImportOpen(true)}>
          <Plus size={15} /> 导入三方版本
        </button>
      </header>

      <section className="workspace">
        <aside className="pane sidebar">
          <h2>审阅文档</h2>
          <div className="list">
            {items.map(item => (
              <button
                key={item.id}
                className={item.id === selectedId ? 'active' : ''}
                onClick={() => setSelectedId(item.id)}
              >
                <strong>{item.name}</strong>
                <br />
                <small>
                  revision {item.revision} · {item.groups} 组 · 待审 {item.pending}
                </small>
              </button>
            ))}
            {items.length === 0 && <p className="muted">尚无文档，点击右上角导入。</p>}
          </div>
        </aside>

        <section className="pane groups-pane">
          {!review ? (
            <p className="muted">从左侧选择一个审阅，或导入新的基线 / 本地 / 远端版本。</p>
          ) : (
            <>
              <div className="review-head">
                <div>
                  <h2>{review.name}</h2>
                  <small className="muted">
                    revision {review.revision} · {review.groups.length} 个变更组
                  </small>
                </div>
                <div className="toolbar">
                  <button
                    className="secondary"
                    onClick={() => loadReview(review.id)}
                    title="重新拉取"
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button
                    className="primary"
                    disabled={busy || reviewedIds.length === 0}
                    onClick={() => commit(true)}
                  >
                    {busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
                    提交已审 {reviewedIds.length} 组
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || unresolvedConflicts > 0}
                    onClick={() => commit(false)}
                    title={
                      unresolvedConflicts > 0
                        ? '仍有冲突组未审阅'
                        : '审阅意见 + 全部自动组一次性提交'
                    }
                  >
                    全部提交
                  </button>
                </div>
              </div>

              <div className="commit-banner">
                <Sparkles size={15} />
                <span>
                  本次提交将自动合入 <b>{autoPending}</b> 个互不冲突的组
                  {reviewedIds.length > 0 && (
                    <>
                      ，连同你已审阅的 <b>{reviewedIds.length}</b> 个决定
                    </>
                  )}
                  ；<b>{unresolvedConflicts}</b> 个未审冲突保持悬置，之后仍可继续提交。
                </span>
              </div>

              {status && <div className={`status ${status.kind}`}>{status.text}</div>}

              <div className="groups">
                {review.groups.map(group => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    draft={drafts[group.id]}
                    onDraft={setDraft}
                    onPersist={persistDraft}
                    onUndo={undo}
                    busy={busy}
                  />
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="pane preview">
          <h2>集成结果</h2>
          {review && (
            <>
              <p className="muted small">
                已提交块的最终文本基于 revision {review.revision}；未审块保持基线内容，
                不会因索引平移丢失身份。
              </p>
              <div className="doc-preview">
                {review.integrated.map(block => (
                  <div className="doc-line" key={block.origin} title={block.origin}>
                    {block.text}
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      </section>

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onCreated={async payload => {
            setImportOpen(false);
            await refreshList();
            setSelectedId(payload.id);
          }}
        />
      )}
    </main>
  );
}

function GroupCard({
  group,
  draft,
  onDraft,
  onPersist,
  onUndo,
  busy,
}: {
  group: GroupView;
  draft?: Draft;
  onDraft: (id: string, draft: Draft) => void;
  onPersist: (group: GroupView, draft: Draft) => Promise<void>;
  onUndo: (group: GroupView) => Promise<void>;
  busy: boolean;
}) {
  const resolved = group.status === 'resolved';
  return (
    <article className={`card ${resolved ? 'resolved' : ''} ${group.auto ? 'auto' : 'conflict'}`}>
      <header>
        <span className="badge kind">{KIND_LABEL[group.kind] ?? group.kind}</span>
        {group.auto ? (
          <span className="badge auto">
            <Shuffle size={12} /> 自动组合
          </span>
        ) : (
          <span className="badge conflict">
            <AlertTriangle size={12} /> {group.conflict ? CONFLICT_LABEL[group.conflict] : '待审阅'}
          </span>
        )}
        {resolved && (
          <span className="badge done">
            <CheckCircle2 size={12} /> 已提交 rev {group.committedAtRevision}
          </span>
        )}
        <strong className="card-title">{group.title}</strong>
      </header>

      {group.baselineText && (
        <div className="row">
          <span className="tag">基线</span>
          <div className="text baseline">{group.baselineText}</div>
        </div>
      )}

      <div className="proposals">
        {(['local', 'remote'] as SideName[]).map(side => {
          const proposal = group.proposals.find(value => value.side === side);
          if (!proposal) return null;
          return (
            <div className={`proposal ${side}`} key={side}>
              <span className="tag">{SIDE_LABEL[side]}</span>
              <span className="detail">{proposal.detail}</span>
              {proposal.text && <div className="text">{proposal.text}</div>}
            </div>
          );
        })}
      </div>

      {!resolved && !group.auto && (
        <div className="decision">
          {(['local', 'remote', 'keep', 'merged'] as DecisionChoice[]).map(choice => {
            const sideMissing =
              (choice === 'local' && !group.ops.local) ||
              (choice === 'remote' && !group.ops.remote);
            const id = `${group.id}:${choice}`;
            return (
              <label className={`choice ${sideMissing ? 'disabled' : ''}`} key={choice}>
                <input
                  type="radio"
                  name={group.id}
                  checked={draft?.choice === choice}
                  disabled={sideMissing}
                  onChange={() =>
                    onDraft(group.id, {
                      choice,
                      customText: draft?.customText ?? '',
                    })
                  }
                />
                {choice === 'local' && '采纳本地'}
                {choice === 'remote' && '采纳远端'}
                {choice === 'keep' && '保留基线'}
                {choice === 'merged' && '自定义合并'}
              </label>
            );
          })}
          {draft?.choice === 'merged' && (
            <div className="custom-merge">
              <textarea
                placeholder="输入该冲突块合并后的最终文本…"
                value={draft.customText}
                onChange={event =>
                  onDraft(group.id, {choice: 'merged', customText: event.target.value})
                }
              />
              <button
                className="secondary small"
                disabled={busy || !draft.customText.trim()}
                onClick={() => onPersist(group, draft)}
              >
                保存合并文本
              </button>
            </div>
          )}
          {draft?.choice && draft.choice !== 'merged' && (
            <button className="secondary small" onClick={() => onPersist(group, draft)}>
              记录审阅意见
            </button>
          )}
          {group.decision && (
            <small className="muted">
              已记录：{group.decision.choice === 'keep' ? '保留基线' : `采纳${group.decision.choice === 'local' ? '本地' : '远端'}`}
            </small>
          )}
        </div>
      )}

      {resolved && (
        <div className="resolved-actions">
          <div className="final-text">
            {Object.entries(group.finalTexts ?? {}).map(([origin, text]) => (
              <div key={origin} title={origin}>
                <span className="tag">最终</span>
                <span className="text">{text}</span>
              </div>
            ))}
          </div>
          <button className="ghost small undo" onClick={() => onUndo(group)} disabled={busy}>
            <RotateCcw size={13} /> 撤销该决定
          </button>
        </div>
      )}
    </article>
  );
}

function ImportDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (payload: ReviewPayload) => void;
}) {
  const [name, setName] = useState('新三方审阅');
  const [baseline, setBaseline] = useState('');
  const [local, setLocal] = useState('');
  const [remote, setRemote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await api.create({name, baseline, local, remote});
      onCreated(payload);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={event => event.stopPropagation()}>
        <h2>导入基线 / 本地版 / 远端版</h2>
        <p className="muted small">每行一个段落（空行会被忽略）。块身份在导入时确定。</p>
        <label className="field">
          文档名
          <input value={name} onChange={event => setName(event.target.value)} />
        </label>
        <div className="triple">
          <label className="field">
            基线
            <textarea value={baseline} onChange={event => setBaseline(event.target.value)} placeholder={'A\nB\nC'} />
          </label>
          <label className="field">
            本地版
            <textarea value={local} onChange={event => setLocal(event.target.value)} />
          </label>
          <label className="field">
            远端版
            <textarea value={remote} onChange={event => setRemote(event.target.value)} />
          </label>
        </div>
        {error && <div className="status error">{error}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || !baseline || !local || !remote} onClick={submit}>
            {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
            生成三方变更
          </button>
        </div>
      </div>
    </div>
  );
}
