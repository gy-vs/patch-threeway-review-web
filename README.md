# Document Patch Studio

文档补丁工作台：导入基线、本地版与远端版，按稳定块身份生成三方变更，
支持只提交已审阅的一部分冲突，未审冲突保持悬而未决。

## 运行

```sh
npm install
npm run dev      # 前端 http://127.0.0.1:4173 ，API http://127.0.0.1:4174
npm test         # vitest
npm run build    # 类型检查 + 前端构建
```

## 模型

- 文档 = 带稳定 id 的段落块序列；所有 diff、决定与结果都按块 id 关联，不按索引。
- 单侧 diff 识别：编辑、移动、拆分、合并、新增、删除。
  LCS 锚定相同文本，重复段落按位置归属到正确的块 id。
- 三方合并：互不接触的变更自动组合；同块变化若一致或可复合
  （移动+编辑）也自动合并，其余成为待审冲突。
- 决定按变更 id 提交，可只提交一部分；每个被接受的批次在当前
  revision 之上生成新补丁。撤销本身也是一条决定（resolution=pending）。
- 并发：两个页面提交不同块的决定可合并不相交批次；同块冲突返回 409。

## API

- `POST /api/documents` `{name, baseline, local, remote}` → 创建评审
- `GET /api/documents` → 列表（含统计）
- `GET /api/documents/:id/review` → 变更、状态、补丁历史
- `POST /api/documents/:id/decisions` `{baseRevision, decisions:[{changeId, resolution}]}`
  → 200 应用为新补丁；409 返回冲突变更的当前状态
- `GET /api/documents/:id/result` → 当前合并结果（未审块保持基线文本）
