# Document Patch Studio — 三方补丁审阅工作台

导入一份文档的**基线、本地版、远端版**，系统按**稳定块身份**对齐三个版本，
自动识别移动、编辑、拆分、合并、删除、插入，把本地与远端互不冲突的变化自动组合，
把真正需要人决定的变化列为冲突组。用户可以只提交已经审阅的一部分，未审冲突
保持悬置；已提交块的最终文本基于当前 revision 生成新补丁，不会被未审块影响。

## 核心保证

- **稳定块身份**：对齐基于块级 LCS（保留重复段落的多重性），基线块身份永久不变；
  编辑不改变块身份，拆分首段与合并幸存者保留父/首块身份，只有插入产生派生身份。
  未审块不会因索引平移丢失身份。
- **三方分组**：移动、编辑、拆分、合并按起源键分组；块集合相交的操作（如拆分 ×
  合并）自动并为同一冲突组。
- **自动组合**：仅一侧变化、双方相同变化、移动 + 内容修改等互不冲突场景自动合入；
  同块双改、删除 × 修改、拆分 × 合并列为冲突。
- **部分提交**：`POST /api/reviews/:id/commit` 可只带已审的 `groupIds`；自动组始终
  随每次提交合入；未审组继续悬置，后续可再次提交。
- **撤销是决策操作**：`POST /api/reviews/:id/undo` 回放精确逆操作（含邻居快照），
  把组重新置为待审，即使其它不相交提交已经移动/删除了原锚点也能正确还原位置。
- **并发决定合并**：两个页面提交**不相交**的块时，基于当前 revision 直接合并；
  提交已被其他页面决定的块（或一次性全量提交）时返回 `409 revision_conflict`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/reviews` | 列表（revision、组数、待审数） |
| POST | `/api/reviews` | 导入 `{name, baseline, local, remote}` 生成三方变更 |
| GET | `/api/reviews/:id` | 三版本块（带 origin）、集成结果、变更组 |
| POST | `/api/reviews/:id/decisions` | 记录审阅意见 `{groupId, choice, customText}` |
| POST | `/api/reviews/:id/commit` | 部分提交 `{revision, groupIds}`（`null` 为全部） |
| POST | `/api/reviews/:id/undo` | 撤销一个已提交组 `{revision, groupId}` |

`choice` 取 `local` / `remote` / `keep` / `merged`（后者需 `customText`）。

## 运行

```bash
npm install
npm run dev      # tsx 服务端 (4174) + vite (4173, 代理 /api)
npm test         # vitest：对齐、分组、身份/撤销、API 共 38 个用例
npm run build
```

服务启动时内置一份中文示例审阅，覆盖同块双改、移动、拆分、删除×修改、编辑、
插入和重复段落。
