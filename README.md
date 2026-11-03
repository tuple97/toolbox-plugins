# toolbox-plugins

开发工具箱（Toolbox）的**公共插件库**：面向通用场景的官方插件源码、构建工具与插件索引。
需要公司内网能力的插件不在这里，见私有库 `toolbox-plugins-private`。

## 目录结构

```
plugins/<插件目录>/          插件源码（manifest.json + src/ + backend/）
packages/build-tools/        构建工具：清单校验、zip 打包、索引合并、产物校验
packages/plugin-sdk/         插件前端 API 的类型声明与样式契约
examples/hello-toolbox/      最小可用的插件示例（可直接指向源码目录安装）
scripts/                     构建 / 签名 / 密钥脚本
registry.json                插件索引（宿主按它安装，由发布流水线生成）
```

## 现有插件

| 插件 | 标识 | 说明 |
|---|---|---|
| 连接管理 | `com.toolbox.connections` | 维护 MySQL / PostgreSQL 连接配置与库表元数据 |
| SQL 模板 | `com.toolbox.sql-template` | 模板、变量配置、字段映射与前后置脚本 |
| SQL 查询 | `com.toolbox.db-query` | 按模板执行查询：变量表单、分页、字段映射与导出 |
| SQL 执行 | `com.toolbox.command-executor` | 自由编写并执行 SQL，支持取消与智能补全 |
| 词典 | `com.toolbox.dictionary` | 本地词典数据，用于查询结果的值翻译 |
| Agent 账号 | `com.toolbox.agent-accounts` | 本地 AI 客户端账号检测、切换与导入 |
| JRebel 服务 | `com.toolbox.jrebel-server` | 本地 JRebel 激活服务（仅回环地址） |

## 开发

```bash
pnpm install
pnpm typecheck                   # tsc --noEmit（含 .vue 的模块声明）
pnpm build                       # 构建全部插件到 dist/ 与 release/（不写索引）
node scripts/build.mjs --only dictionary   # 只构建一个插件
```

把 `dist/<插件id>/<版本>/` 目录拖进工具箱即可安装；
或在设置里开启**开发者模式**后，直接指向 `plugins/<目录>` 源码目录。

> 构建成功后还会把前端产物回写到 `plugins/<目录>/frontend/`（该目录已 gitignore），
> 这样源码目录本身也能被开发者模式直接加载。

## 发布

```bash
pnpm build                       # 本地校验产物
git tag plugins-YYYYMMDD-HHMM     # 推 tag 触发 .github/workflows/release.yml
git push origin plugins-YYYYMMDD-HHMM
```

流水线会构建全部插件、创建 Release 上传 zip、并把新索引提交回 main。
宿主读取的是 `main` 分支上的 `registry.json`，它是宿主内置的**官方源**：
索引必须带签名（`registry.json.sig`），否则宿主按未验签来源处理。

## 插件能力（宿主提供的运行时 API）

前端通过 `activate(api)` 拿到：`api.vue`（共享 Vue）、`api.ui`（原子组件）、
`api.host`（invoke / storage / 事件 / 通知 / 文件对话框）、`api.registerTool`。

后端（`runtime.backend = "js"`）在 goja 里跑，全局 `toolbox`：

| 能力 | 说明 | 需要的权限 |
|---|---|---|
| `toolbox.handler(name, fn)` | 注册前端可调用的 handler | — |
| `toolbox.storage` | 插件私有键值存储 | `storage` |
| `toolbox.http.request` | 受限 HTTP（域名白名单 + 超时 + 体积上限） | `network` |
| `toolbox.events.emit` | 发事件到应用总线 | `events` |
| `toolbox.server.*` | 本地 HTTP 服务（仅回环 + 端口白名单） | `server` |
| `toolbox.fs.readText/list/exists` | 只读本地文件 | `files` |
| `toolbox.fs.saveText` | 导出：宿主弹「另存为」对话框并写盘 | `fileWrite` |
| `toolbox.plugins.call` | 调用其它插件公开的 handler | 依赖声明 |

**导出的推荐做法**是 `toolbox.fs.saveText({ title, fileName, content, filters })`：
保存对话框由宿主后端弹出，写入路径不经过插件 JS —— 插件只能提供内容，无法伪造落点。

## 与私有库的差异

| 项 | 本库 | 私有库 |
|---|---|---|
| 定位 | 通用工具能力 | 公司内部业务（PMS / ES 等） |
| 网络白名单 | 公开服务域名 | 内网域名（`*.sany.com.cn`） |
| 下载地址 | 本库的 Release | 私有库的 Release |

清单协议、权限模型、样式契约与构建产物校验在两个库里完全一致，
见 `packages/plugin-sdk/index.d.ts` 顶部的说明。
