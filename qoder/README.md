# Thin SSH for Qoder

Thin SSH 是一个面向 Qoder Desktop 的远程运维 MCP 插件。它让 Agent 通过**本机 OpenSSH 客户端**在远程服务器执行命令、读写 UTF-8 文本文件和列举目录，同时把推理循环留在本地。

插件由 [`dsh-thin-ssh`](../README.md) 适配而来，保留 MIT 许可。Qoder 适配版是独立的 Node.js MCP 服务，不依赖 DeepSeek Harness、Cordis、npm 第三方包或常驻进程。

## 功能

- 注册 6 个 `thin_ssh_*` 工具。
- 使用 Qoder 内置 Node.js 运行时，无需单独安装 Node.js 或执行 `npm install`。
- 支持多 SSH profile、默认 profile、ssh config 别名、ssh-agent、密钥文件和 `ProxyJump`。
- 默认启用 `BatchMode=yes`，不交互索取密码，不保存密码或私钥。
- 为命令执行提供超时、取消和输出上限；为文本写入提供 base64 分块传输。
- 可限制目标主机，并可禁用 `thin_ssh_write_file`。
- 不启动守护进程，不监听端口，不上传配置或文件内容到第三方服务。

## 前置条件

1. Qoder Desktop 支持安装第三方插件。
2. 本机有可用的 OpenSSH 客户端 `ssh`。Windows 10/11 可启用“OpenSSH 客户端”可选功能；macOS/Linux 通常自带。
3. 远程账号使用 POSIX 风格 shell，并提供 `cat`、`head`、`tail`、`mkdir`、`chmod`、`printf`、`base64`、`ls`。
4. 本机已配置密钥、ssh-agent 或 ssh config，并已信任目标主机。首次连接可先在本机终端执行一次 `ssh your-host true`。

## 安装

### 从 Qoder 插件市场安装

在 Qoder Desktop 的插件市场搜索 **Thin SSH**，安装后在 **Extensions → Installed** 中确认已启用。市场 listing 仅在审核通过后可见。

### 从 GitHub Release 安装

1. 打开 [dsh-thin-ssh Releases](https://github.com/Niobium-41-nb/dsh-thin-ssh/releases)。
2. 下载 `qoder-thin-ssh-0.1.0.zip`，可按同名校验文件核对 SHA-256。
3. 在 Qoder Desktop 的插件 ZIP 导入入口选择该文件。
4. 打开 **Extensions → Installed → Thin SSH**，确认插件已启用。

ZIP 根目录直接包含 `.qoder-plugin/plugin.json` 和 `.mcp.json`。不要解压后再套一层目录。

## 快速开始

直接在 Qoder 会话中描述任务，例如：

> 用 Thin SSH 连接 prod.example，用户 deploy，查看 /srv/app 里有什么。

Agent 应先调用 `thin_ssh_status`，再通过 `thin_ssh_profile` 创建 profile，然后调用相应工具。创建 profile 时只需要主机、用户、端口和本机密钥路径；**不要提供密码或私钥内容**。

也可以先在本机终端验证连接：

```bash
ssh -i ~/.ssh/id_ed25519 deploy@prod.example true
```

## 工具

| 工具 | 作用 | 常用参数 |
| --- | --- | --- |
| `thin_ssh_status` | 查看本机 ssh 路径、profile 和可选连通性结果 | `profile`、`check` |
| `thin_ssh_profile` | 列出、添加、更新、删除或选择默认 profile | `action`、`name`、`host`、`user`、`port`、`identityFile`、`cwd`、`extraArgs` |
| `thin_ssh_exec` | 在远程 shell 执行命令 | `command`、`profile`、`cwd`、`stdin`、`timeoutMs`、`maxOutputBytes` |
| `thin_ssh_read_file` | 读取远程 UTF-8 文本文件 | `path`、`offset`、`limit`、`maxBytes` |
| `thin_ssh_write_file` | 覆盖或追加远程 UTF-8 文本文件 | `path`、`content`、`append`、`createDirs`、`mode` |
| `thin_ssh_list` | 列举远程目录 | `path`、`long` |

工具同时返回文本和 JSON 结构化结果。远程非零退出码会保留在 `exitCode` 中；spawn 失败、超时、取消或输出超限使用 `exitCode: -1`，具体原因见 `error`。

## Profile 存储

默认保存在：

```text
~/.dsh/dsh-thin-ssh/profiles.json
```

这与原 DSH 插件共享存储位置，便于迁移。文件只保存连接元数据和本机密钥路径，不保存密码或私钥。写入采用同目录临时文件加原子重命名。

可通过 `THIN_SSH_STATE_DIR` 或兼容变量 `DSH_THIN_SSH_STATE_DIR` 修改存储目录。

## 安全配置

Qoder 插件默认允许 Agent 操作已配置的主机。生产环境建议在自定义插件副本的 `.mcp.json` 中为 MCP 服务添加 `env`，限制主机或禁用文件写入工具：

```json
{
  "mcpServers": {
    "qoder-thin-ssh": {
      "command": "${QODER_NODE_RUNTIME}",
      "args": ["${QODER_PLUGIN_ROOT}/server.mjs"],
      "env": {
        "THIN_SSH_ALLOWED_HOSTS": "prod.example,staging.example",
        "THIN_SSH_ALLOW_WRITE": "false",
        "THIN_SSH_STATE_DIR": "C:/Users/you/.qoder-thin-ssh"
      }
    }
  }
}
```

可用环境变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `THIN_SSH_SSH_PATH` | `ssh` | 本机 OpenSSH 可执行文件 |
| `THIN_SSH_DEFAULT_PROFILE` | 空 | 默认 profile 名称 |
| `THIN_SSH_DEFAULT_TIMEOUT_MS` | `120000` | 单次 ssh 调用超时 |
| `THIN_SSH_CONNECT_TIMEOUT_SEC` | `10` | ssh 连接超时 |
| `THIN_SSH_MAX_OUTPUT_BYTES` | `65536` | stdout/stderr 合计上限 |
| `THIN_SSH_MAX_WRITE_BYTES` | `1048576` | 单文件文本写入上限 |
| `THIN_SSH_ALLOWED_HOSTS` | 空 | 逗号分隔的精确主机白名单 |
| `THIN_SSH_ALLOW_WRITE` | `true` | 是否允许 `thin_ssh_write_file` |
| `THIN_SSH_BATCH_MODE` | `true` | 是否禁用密码交互 |
| `THIN_SSH_STATE_DIR` | `~/.dsh/dsh-thin-ssh` | profile 存储目录 |

## 安全边界

- 本机 `ssh` 通过 argv 数组启动，不经过本机 shell。
- profile 拒绝 `password`、`passphrase`、`privateKey` 等字段；认证交给本机 ssh、ssh-agent、密钥文件或 ssh config。
- 远程路径会按 POSIX shell 规则加引号；文本内容通过 base64 传输，避免引号、换行和 Unicode 被破坏。
- `extraArgs` 只接受 `-o` 成对配置的 `ProxyJump`、`StrictHostKeyChecking`、`ServerAliveInterval`、`ServerAliveCountMax`；`ProxyCommand` 等可启动本机命令的选项会被拒绝。
- `allowedHosts` 是精确主机名匹配，包括 ssh config 别名。
- `THIN_SSH_ALLOW_WRITE=false` **只禁用 `thin_ssh_write_file`**，不会把 `thin_ssh_exec` 变成只读命令。需要强制只读时，应使用远端只读账号、服务器权限或命令审批策略。
- `thin_ssh_exec` 的 `command` 本身就是交给远程 shell 执行的命令，等同于授予 Agent 该远端账号的 shell 权限。
- 超时和取消只终止本机 ssh 进程；已经在远端启动的命令可能继续运行。
- 单文件写入默认上限为 1 MiB。大文件传输应使用专门的传输工具。

## 开发与复测

无需安装依赖，使用 Node.js 22.19+ 或 24+：

```bash
npm test
npm run check
```

`npm test` 使用模拟 ssh 子进程覆盖六个工具、退出码、路径引用、base64 写入、白名单、写入开关、SSH 选项限制、超时、取消、输出截断和 spawn 失败，不连接真实服务器。

`npm run check` 还会启动真实 MCP stdio 子进程，验证 manifest、初始化、六个工具发现、profile 持久化和参数校验。

在 Windows 上生成发布 ZIP：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

输出位于 `dist/`，包含插件 ZIP 和 `.sha256` 校验文件。完整结果见 [SELF_TEST_REPORT.md](SELF_TEST_REPORT.md)，市场提交字段见 [MARKETPLACE.md](MARKETPLACE.md)。

## 许可

[MIT](../LICENSE)，Copyright (c) 2026 DSH plugin contributors。
