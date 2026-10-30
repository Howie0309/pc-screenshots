# 网页竞品批量截图与评估

用本机 Chrome 批量给生成式 AI 产品（当前适配 ChatGPT 网页版）发 query、截完整长图，再用多模态大模型（VLM）逐条评估，支持人工评级、整体分析、Excel 导出和一键发布在线分享页。

## 它能做什么

- 批量截图：PC 网页 / 手机视图（iPhone 390、440）长截图，自动命名归档
- 失败自动重试、连续失败自动暂停并定时重试
- 逐条 VLM 评估（并发）+ 人工评级/备注 + 整体分析
- 自动解析结构化评估结果（打分维度 / GenUI 组件字段），按字段筛选
- 导出 Excel（可选字段、可嵌入截图）
- 一键发布成 popo 在线分享页

## 适用环境

这是一个**本地工具**：每个人在自己的 Mac 上运行，驱动自己已登录的 Chrome、用自己的账号和模型配置。不能做成一个所有人共用的在线服务。

- macOS
- Node.js 18+（`node -v` 确认）
- Google Chrome
- 公司 ChatGPT 网页版账号（在工具启动的专用 Chrome 里登录一次）
- 一个 OpenAI 兼容的多模态大模型接口（Base URL + API Key + 模型名），仅「评估」功能需要；只截图可不配

## 快速开始

```bash
cd pc-screenshots
npm install          # 安装依赖（含 playwright-core、sharp、exceljs）
npm start            # 启动本地服务
```

然后浏览器打开 http://127.0.0.1:3210 ，按页面提示：

1. 点右上角「启动 Chrome」，在弹出的窗口里登录 ChatGPT（只需首次）
2. 点「设置」填入 VLM 的 Base URL / API Key / 模型名（只做截图可跳过）
3. 「新建批次」→ 粘贴或导入 query（txt/csv/xlsx）→ 选视图 → 开始截图
4. 截完可「评估选中 / 全部」，在大图里逐条看、打人工评级
5. 「导出 Excel」或「发布分享网页」

命令行批量截图（可选）：`npm run shot -- queries.txt [--mobile | --mobile440]`
<!--MORE-->

## 配置说明

首次可把 `config.example.json` 复制为 `config.json` 再在页面「设置」里填写；也可以直接在页面里填，会自动写入 `config.json`。

- `config.json` 保存在本机，含 API Key，**不要提交到代码库或分享出去**（已在 .gitignore 中忽略）
- 截图节奏、失败重试、评估并发、暂停自动恢复等都在「设置」里，可按需调

### 评估与截图的一致性

- 提交重截时会清空该条的旧模型评估、人工评级和备注，同时清空批次整体分析；即使随后取消排队，也需重新评估和标注。
- 正在运行的旧评估若遇到重截或条目被删除，其晚到结果不会写回。重新评估、修改人工标注或删除条目后，整体分析需重新生成。
- 长图因高度上限被截断时，模型会收到明确提示，评估正文会注明范围；GenUI 结果强制标记为不确定，数量仅代表截图可见部分。

### 配置 popo 分享

分享依赖另行安装的 popo 上传工具（本项目不包含）、Python 3 和有效的本机登录凭据。在「设置」中填写 `popoUsername`（公司账号用户名）和 `popoUploadScript`（`upload.py` 的绝对路径，支持 `~/`）。脚本路径留空时尝试当前用户的 `~/.comate/skills/.system/popo/scripts/upload.py`。

也可通过环境变量 `POPO_USERNAME`、`POPO_UPLOAD_SCRIPT` 配置，页面中非空设置优先。缺少用户名或上传脚本时会给出明确错误，不影响其他功能。

## 验证

回归测试使用 Node.js 22.3+ 的模块模拟能力，建议 Node.js 24：`npm test`。测试使用模拟模型调用与临时测试批次，不会启动 Chrome、调用真实模型或发布网页。

`npm run test:smoke` 会临时启动仅监听本机的服务，验证页面、配置读取和批次 API，结束后删除测试批次并停止服务。

## 注意事项

- 服务只监听本机 127.0.0.1，没有登录校验，不要对外暴露
- 批量频繁提问可能触发 Cloudflare 人机验证；遇到暂停时去专用 Chrome 里手动过验证再继续
- 截图、批次数据存在本地 `batches/` 目录，分享代码时不包含（已忽略）
- Chrome 升级后若连接报错，重启服务即可（已兼容新版）

## 目录结构

- `server.mjs` 本地服务入口
- `lib/` 核心逻辑：`gpt`(截图) / `capture`(队列) / `vlm`(评估) / `evaluate`(评估队列) / `excel` / `sitegen` / `popo` / `store`
- `public/` 前端页面
- `shot-gpt.mjs` 命令行版截图

