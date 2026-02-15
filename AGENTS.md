# Repository Guidelines

## 项目结构与模块组织
- `src/` 是核心实现，按职责分层：
  - `src/ssh/` 连接与命令执行
  - `src/profile/` profile 生命周期
  - `src/config/` 配置加载与校验
  - `src/tools/` MCP 工具注册
- `test/` 为 Vitest 测试与夹具，`test/fixtures/` 存放本地配置样例。
- `build/` 为 `tsc` 输出目录，禁止手改。
- `plan/` 为任务文档与规格变更。

## 构建、测试与本地运行
- `npm run build`：编译 TypeScript，生成 `build/`。
- `npm test`：运行全量测试（依赖本地 SSH 容器 `127.0.0.1:2222`）。
- `npm run inspect`：使用 MCP Inspector 进行手动验证。
- 启动测试容器：
  - `docker compose up -d`（结束后 `docker compose down`）。

## 编码风格与命名约定
- TypeScript（ESM），缩进 2 空格。
- 文件名 `kebab-case`，变量/函数 `camelCase`。
- 模块保持单一职责，避免大文件堆叠逻辑。

## 测试规范
- 使用 Vitest，测试文件位于 `test/*.test.ts`。
- 配置/逻辑优先写单测；SSH 行为用集成测试。
- 若出现 `ECONNREFUSED 127.0.0.1:2222`，先启动测试容器再重试。

## 提交与 PR 规范
- 提交信息使用 Conventional Commits（如 `feat:`、`fix:`、`chore:`）。
- 行为变更需同步更新 `plan/` 文档与 README。
- PR 需写清变更点、测试证据和风险说明。

## 发布与安全
- 严禁提交 `.npmrc` 或任何 token（`.gitignore` 已忽略）。
- 推荐使用发布脚本：  
  - 设置环境变量：`NPM_TOKEN`（必填），`NPM_OTP`（可选）  
  - 执行：`npm run publish:release`
- 脚本会临时写入 `.npmrc`，发布后自动清理，避免泄露。
