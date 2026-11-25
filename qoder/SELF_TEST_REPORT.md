# Thin SSH 0.1.0 自测报告

- 测试日期：2026-11-25
- 测试平台：Windows 10.0.26300，x64
- 系统 Node.js：v24.22.1
- Qoder Desktop：0.5.18（Qoder CN）
- 插件标识：`qoder-thin-ssh`
- 插件版本：`0.1.0`
- 测试类型：静态检查、单元测试、MCP stdio 协议测试、Qoder 安装与工具发现验证
- 真实 SSH 服务器测试：未执行；测试不依赖外部服务器，也不使用真实凭据

## 结论

发布候选的 11 个模拟 SSH 单元测试全部通过；系统 Node.js 与 Qoder 内置运行时下的 MCP 冒烟测试均通过；所有 JavaScript 文件通过语法检查。Qoder 官方本地安装器已成功安装并启用该适配插件，会话中已发现 6 个 `thin_ssh_*` 工具。

本次测试验证了协议、参数处理、命令构造和失败路径。由于没有专用测试服务器，真实网络连通性、真实密钥认证和具体 Linux 发行版的远端工具差异仍需由审核者或用户使用自有 SSH 目标复测。

## 测试环境与命令

### 系统 Node.js

```bash
node --version
npm test
npm run check
for file in server.mjs lib/*.mjs scripts/*.mjs; do node --check "$file"; done
```

结果：

- `npm test`：11/11 通过。
- `npm run check`：11/11 单元测试通过，MCP smoke test 通过。
- `node --check`：全部通过，无输出。

### Qoder 内置运行时

```bash
ELECTRON_RUN_AS_NODE=1 \
MCP_NODE_EXECUTABLE="D:/Program Files/Qoder CN/.qoder-versions/0.5.18/Qoder CN.exe" \
npm run check
```

结果：

- 11/11 单元测试通过。
- MCP 子进程由 Qoder 内置运行时启动。
- `initialize`、`tools/list` 和 `tools/call` 冒烟测试通过。

## 静态与打包检查

| 检查项 | 结果 |
| --- | --- |
| `.qoder-plugin/plugin.json` 可解析，名称和版本正确 | 通过 |
| `.mcp.json` 可解析，使用 `${QODER_NODE_RUNTIME}` 和 `${QODER_PLUGIN_ROOT}` | 通过 |
| 六个工具名称、顺序和 JSON Schema 正确 | 通过 |
| 所有运行时 `.mjs` 文件通过 `node --check` | 通过 |
| 无 npm 第三方运行时依赖 | 通过 |
| 包内无 `node_modules`、`.git`、profile 状态、凭据或用户配置 | 通过 |
| ZIP 根目录直接包含 `.qoder-plugin/plugin.json`、`.mcp.json`、`server.mjs` | 通过 |
| MIT LICENSE 保留 `Copyright (c) 2026 DSH plugin contributors` | 通过 |

## MCP 协议测试

`scripts/smoke.mjs` 启动真实的 `server.mjs` stdio 子进程，使用临时 profile 目录和故意不存在的 ssh 可执行文件，覆盖：

| 场景 | 结果 |
| --- | --- |
| `initialize` 返回 2025-11-25 协议、服务器信息和使用说明 | 通过 |
| `tools/list` 返回六个 `thin_ssh_*` 工具 | 通过 |
| 空 profile 状态查询 | 通过 |
| 添加 profile 并自动设为默认 | 通过 |
| 状态查询和 profile 列表 | 通过 |
| profile 原子持久化 | 通过 |
| 拒绝 `password` 字段且不写入临时状态文件 | 通过 |
| 拒绝缺少 `command` 的执行请求 | 通过 |
| ssh spawn 失败返回结构化结果，不崩溃 | 通过 |
| 拒绝非法文件 mode | 通过 |
| 删除 profile | 通过 |
| 退出时清理临时测试目录 | 通过 |

## 工具与安全回归测试

`scripts/service.test.mjs` 使用模拟 ssh 子进程，不启动本地或远程 shell，不访问网络。

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| 1 | `thin_ssh_exec` 使用 argv 启动 ssh，附加 `--`，保留远端非零退出码和 stdout | 通过 |
| 2 | `thin_ssh_read_file` 正确处理含单引号的远端路径、偏移和行数限制 | 通过 |
| 3 | `thin_ssh_write_file` 对 Unicode、引号和换行进行 base64 分块传输，重组后内容一致，并应用 mode | 通过 |
| 4 | `thin_ssh_list` 支持默认目录、`~/` 路径和长短格式 | 通过 |
| 5 | `THIN_SSH_ALLOW_WRITE=false` 在启动 ssh 前拒绝写文件 | 通过 |
| 6 | `allowedHosts` 拒绝白名单外 profile 创建和远程调用 | 通过 |
| 7 | `extraArgs` 允许 `ProxyJump`，拒绝可启动本机命令的 `ProxyCommand` | 通过 |
| 8 | 超时终止本机 ssh 子进程并返回 `exitCode: -1` | 通过 |
| 9 | MCP 取消信号终止本机 ssh 子进程 | 通过 |
| 10 | 输出达到上限后截断并终止 ssh | 通过 |
| 11 | ssh spawn 异常转换为结构化工具错误 | 通过 |

## Qoder 宿主集成

通过 Qoder 官方 `install_extension` 流程安装本地插件 ZIP，安装器返回：

- 插件：Thin SSH
- 版本：0.1.0
- 来源：local
- 范围：user
- `installed: true`
- `enabled: true`

安装后当前会话的 MCP 工具目录中出现了以下六个工具：

1. `thin_ssh_status`
2. `thin_ssh_profile`
3. `thin_ssh_exec`
4. `thin_ssh_read_file`
5. `thin_ssh_write_file`
6. `thin_ssh_list`

这验证了 Qoder 对 manifest、MCP 声明和内置 Node.js 运行时的加载链路。市场审核应以最终发布的 ZIP 和校验文件为准。

## 已知限制与未验证项

- 未连接真实 SSH 服务器，未验证真实密钥、ssh-agent、ProxyJump 或主机指纹交互。
- 未验证具体远程操作系统是否安装全部 POSIX 工具。
- 超时和取消只终止本机 ssh 进程，不能保证终止已经在远端启动的命令。
- `THIN_SSH_ALLOW_WRITE=false` 只禁用 `thin_ssh_write_file`，不限制 `thin_ssh_exec` 的远程命令。
- 单文件文本写入默认上限为 1 MiB，不是通用二进制文件传输工具。
- 插件没有 MCP App 或自定义 UI，因此无 UI 加载、按钮交互或截图测试项。

## 复现方式

在插件源码目录执行：

```bash
npm test
npm run check
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

打包脚本会生成 `dist/qoder-thin-ssh-0.1.0.zip` 和对应 `.sha256`，并检查 ZIP 根目录必需条目。
