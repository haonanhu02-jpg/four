# 四层工作对齐工作台

Vue 3 + TypeScript + Vite 前端、NestJS 后端、PostgreSQL 数据库的工作台工程，规划面向约 1000 名使用者。

当前交付 1.0.0，六个阶段已完成本地验收：账号基础、四层事项管理、进度与对齐体检，以及自动顺延、跨年承接和历史复盘。支持年度目标→月度目标→周任务→日待办的完整来源链、周期筛选、自动保存、版本冲突处理及回收站，正式数据保存到 PostgreSQL。桌面和手机均可使用；IndexedDB 持久化访客数据、离线草稿和待同步操作，联网后提交，支持旧 JSON 迁移、示例和备份恢复。

## 下载镜像与生产部署

已验证的 Linux amd64 镜像及完整运行包见 [v1.0.0 Releases](https://github.com/haonanhu02-jpg/four/releases/tag/v1.0.0)。源码版本为 Git 标签 `v1.0.0`；`main` 分支会继续更新。

- [完整交付包](https://github.com/haonanhu02-jpg/four/releases/download/v1.0.0/four-layer-workbench-1.0.0-linux-amd64.tar.gz)：包含 API、web、PostgreSQL 18 镜像、源码、生产 Compose、配置模板、备份恢复工具及验收摘要。
- [独立镜像归档](https://github.com/haonanhu02-jpg/four/releases/download/v1.0.0/images.tar.gz)：仅需镜像时下载，可直接 `docker load --input images.tar.gz`。
- [完整包 SHA-256](https://github.com/haonanhu02-jpg/four/releases/download/v1.0.0/four-layer-workbench-1.0.0-linux-amd64.tar.gz.sha256)：用于校验下载文件。

镜像通过 Releases 提供，本版本没有发布到 GHCR。完整包在空目录解压后运行：

```sh
node deploy/verify-release.mjs .
docker load --input images.tar.gz
node deploy/verify-release.mjs . --images
node deploy/init-production.mjs
```

填写新生成的 `.env.production` 中的域名、HTTPS、SMTP 等配置，再按[生产部署与恢复](docs/生产部署与恢复.md)启动。工具使用 Node.js 24；Linux Docker 和 Windows Docker Desktop 的 Linux 容器模式均可装载这些镜像。实际密钥、数据库和本地草稿不在源码或发布附件中。

镜像 OCI revision 与包内 `release.json` 使用打包时的源码指纹关联；`v1.0.0` 标签中的 114 个交付源文件已逐一校验一致。阶段验收记录保留各次验收时的环境与发布状态，当前下载入口以此处 Releases 为准。

未完成日、周、月事项自动承接到当前周期，保留原计划、截止日、状态和顺延记录；跨年时保留原年度来源并提示确认。历史复盘读取封存内容，支持周期、层级、完成状态及分页。实现和验证见[第四阶段验收记录](docs/阶段4-验收记录.md)，统计口径见[第三阶段验收记录](docs/阶段3-验收记录.md)。离线、同步与 JSON 迁移见[第五阶段验收记录](docs/阶段5-验收记录.md)。

## 使用 Docker 启动

需要 Node.js 24（生成本地配置时使用）及已启动的 Docker Engine / Docker Desktop，支持 Docker Compose v2 或更新版本。

```sh
node deploy/init-env.mjs
docker compose up -d --build --wait
```

配置生成器只在 `.env` 不存在时创建文件，随机生成数据库密码与令牌密钥。已有 `.env` 时保留当前配置，直接启动即可。

- 工作台：[http://localhost:8080](http://localhost:8080)
- 开发邮件收件箱：[http://127.0.0.1:8025](http://127.0.0.1:8025)
- API 健康检查：[http://localhost:8080/api/health](http://localhost:8080/api/health)

注册和验证码登录会向本地 Mailpit 发送真实 SMTP 邮件，在上面的收件箱读取验证码。这验证本地 SMTP 链路；对真实邮箱投递需配置实际 SMTP 服务后验证。

Compose 会等待 PostgreSQL 就绪，执行一次性迁移服务，再启动 API 和前端。数据库通过独立持久卷保存，`docker compose down` 停止服务时保留数据。

## 使用 npm 开发

```sh
node deploy/init-env.mjs
npm ci
docker compose up -d --wait db mailpit
```

将 `.env` 中的 `APP_ORIGIN` 改成 `http://127.0.0.1:5173`，保留本机数据库地址与 SMTP 地址，然后运行：

```sh
npm run db:migrate
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。前端开发服务器代理 `/api` 到 `http://127.0.0.1:3000`。完整 Compose 使用独立的 `COMPOSE_APP_ORIGIN`（默认 `http://localhost:8080`），不会受到 npm 开发源配置影响。

## 工程结构

```text
apps/api/             NestJS API、账号、四层业务和数据库访问
apps/web/             Vue 登录、四层工作台、IndexedDB 与离线同步
packages/contracts/   共享接口、校验和错误约定
database/migrations/  版本化 PostgreSQL 迁移
scripts/migrate.mjs   带锁及校验和的迁移入口
deploy/               Nginx 配置与本地配置初始化
tests/                真实 PostgreSQL / SMTP 集成验证
docs/                 技术方案、阶段计划和运行说明
```

## 检查与构建

```sh
npm run check
npm run db:migrate
npm run test:integration
docker compose build
docker compose up -d --wait
npm run test:browser
npm run test:ui
```

集成验证需要本机 PostgreSQL 与 Mailpit 已就绪；`npm run check` 执行代码检查、类型检查和生产构建。浏览器回归需 Chrome/Chromium（可用 CHROME_PATH 指定），通过生产构建验证断网重开；开发模式不注册离线壳缓存。GitHub Actions 在隔离环境运行上述验证并启动容器做 HTTP 与浏览器检查，当前不推送镜像或部署远端。

## 基础镜像

Dockerfile 使用多阶段构建，包含 `api` 和 `web` 两个运行目标。默认镜像名：

```text
four-layer-workbench-api:1.0.0
four-layer-workbench-web:1.0.0
```

前端由非 root Nginx 服务并代理 API，后端由非 root Node.js 进程运行。生产依赖和编译产物进入运行镜像，`.env`、测试数据和实际密钥不进入镜像。

第六阶段已提供实际镜像归档、完整运行包与容量实测。运行包位于 artifacts/stage6/release-1.0.0/，整体归档为 artifacts/stage6/four-layer-workbench-1.0.0-linux-amd64.tar.gz，含 SHA-256 校验。生产运行步骤见[生产部署与恢复](docs/生产部署与恢复.md)，范围和实测见[第六阶段验收记录](docs/阶段6-验收记录.md)。正式域名、HTTPS 与 SMTP 仍由实际环境配置，当前未对外发布。部署时的域名、HTTPS、SMTP 服务、服务器和镜像仓库配置见[阶段 1 运行说明](docs/阶段1-运行说明.md)，当前阶段镜像标签以本页为准。

- [技术方案](docs/四层工作对齐工作台-技术方案.md)
- [实施阶段计划](docs/四层工作对齐工作台-实施阶段计划.md)
