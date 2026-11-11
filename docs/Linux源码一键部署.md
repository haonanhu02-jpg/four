# Linux 源码一键部署

`update-four.sh` 是独立 Bash 脚本，按 `main` 分支获取当前源码，在服务器上构建 Docker 镜像，再备份、迁移、启动。与 `source-deploy.sh` 按正式 Release 下载预构建镜像的方式不同，因此可以部署尚未发布 Release 的 1.2.0 代码。

服务器需要 Git、Python 3.10+、Docker、Docker Compose 2.20+、Bash，以及 Linux 常用的 flock、timeout、sed、sha256sum 工具。不需要在宿主机安装 Node.js。当前数据库为 PostgreSQL 18；数据库大版本升级需另行迁移。构建需要能访问 npm 和基础镜像服务，建议至少 2 核、4 GiB 内存。

下载本仓库根目录的 `update-four.sh` 到 Linux，然后直接执行：

```bash
source ./update-four.sh
```

也支持 `bash ./update-four.sh`。默认目录为 `~/four-workbench`，每次重复执行同一命令即可更新。默认项目名 `four-layer-workbench`，现有数据库卷、账号、`.env` 和密钥保留。不要变更 Compose 项目名或删除数据卷。

默认网站地址为 `http://192.168.3.110:5001`，监听 `0.0.0.0:5001`。首次部署及已有部署都会配置端口 5001；数据库密码、令牌密钥及账号数据保留。更换服务器时可指定访问地址：

```bash
FOUR_ORIGIN=http://服务器公网IP:5001 source ./update-four.sh
```

已有 `.env` 会先备份到 `.local/source-config-backups/`，仅更新网站端口、访问来源、监听地址及对应 Cookie 配置，其他内容保留。重复执行且配置一致时不会重复修改。可用 `FOUR_PORT` 自定义端口、`FOUR_ORIGIN` 自定义浏览器访问地址；HTTPS 域名由自己的反向代理提供。需要开放服务器防火墙/安全组的 5001 端口。

可选参数：`--dir /指定目录`、`--branch main`、`--project 自定义名称`。本地已有修改、分支分叉、目标目录属于其他项目时会停止，不会强制重置或删除内容。请不要把它指向原有 Release 部署目录 `~/four-workbench-deployment`；两种部署方式分别维护。已有部署可将 `--dir` 指向原本的本仓库 Git 检出目录，并保留项目名和原配置。

源码优先尝试 ghfast.top、gh-proxy.com，最后尝试 GitHub；镜像优先尝试 docker.1ms.run、docker.xuanyuan.me，最后尝试官方地址。基础镜像保留官方 SHA-256 摘要，npm 优先 npmmirror，失败后重试官方源。公共加速服务可用性随网络变化，不能保证所有网络都成功；通道全部失败会报错停止。

脚本先完成下载和构建，再启动/连接数据库，生成自定义格式备份并验证可读取，之后执行数据库迁移、初始化管理员和应用健康检查。不会先执行 `compose down`，也不会删除数据卷。构建失败不重启旧应用；迁移或启动失败时保留备份并报错，不自动降级数据库。

数据库备份位于部署目录 `.local/source-backups/`；首次管理员凭据位于 `.local/source-admin/admin.txt`，不会打印密码。已有可用管理员时不重设密码。访问地址必须与浏览器实际使用的地址一致，否则服务端会拒绝来源不匹配的写入。

当前支持同一目录的部署互斥；同时对同一 Compose 项目部署时，应始终使用同一目录。不要同时运行两份不同目录的脚本去更新同一个项目。
