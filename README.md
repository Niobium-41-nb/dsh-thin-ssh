# dsh-thin-ssh

[![check](https://github.com/Niobium-41-nb/dsh-thin-ssh/actions/workflows/check.yml/badge.svg)](https://github.com/Niobium-41-nb/dsh-thin-ssh/actions/workflows/check.yml) [![license](https://img.shields.io/github/license/Niobium-41-nb/dsh-thin-ssh)](https://github.com/Niobium-41-nb/dsh-thin-ssh/blob/master/LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that keeps the agent's
reasoning loop **local** and moves every server operation to the remote host: commands, file reads and
writes, and directory listings all run through the local OpenSSH client. It registers six `thin_ssh_*`
tools, starts no daemon, listens on no port, and stores no password or private key.

> 🇨🇳 完整文档为中文，见下文。

让 DeepSeek Harness 的 Agent **主体留在本地**，而所有对服务器的操作都在远端执行。

插件向模型注册六个 `thin_ssh_*` 工具。Agent 仍然在本地思考、读会话、调度工具；每一次实际命令、文件读写、目录列举都通过本机 OpenSSH 客户端送到服务器。它不启动常驻服务，不监听端口，也不保存任何密码或私钥。

## 工作方式

```
本地：Agent 推理循环  ──>  thin_ssh_* 工具  ──>  spawn ssh  ──>  服务器 shell
                     <──  JSON 结构化结果  <──  stdout/stderr  <──
```

- **本地进程**只有 `ssh` 客户端；远端执行由服务器上的用户 shell 完成。
- **认证完全交给本机 ssh**：支持 ssh-agent、`~/.ssh/config` 别名、`IdentityFile`、`ProxyJump` 等；`BatchMode=yes` 默认开启，缺少密钥时直接失败而不是卡住等密码。
- **不会把密码写进工具参数或配置文件**：带 `password` / `passphrase` / `privateKey` 等字段的 profile 会被拒绝。

## 前置条件

- Node 22.19+ / 24+，DeepSeek Harness 0.2.x。
- 本机可用 OpenSSH 客户端（Windows 10/11 的“OpenSSH 客户端”可选功能，或 macOS/Linux 自带 `ssh`）。
- 远端用户 shell 是 POSIX 风格，需提供 `cat`、`head`、`tail`、`mkdir`、`chmod`、`printf`、`base64`、`ls`；`base64` 用于无损写入文件。
- 首次连接需让本机 ssh 信任目标主机（手工 `ssh host true` 一次，或在 profile 的 `extraArgs` 里配置 `StrictHostKeyChecking=accept-new`）。

## 安装

```bash
# 构建（在插件目录）
pnpm install --ignore-scripts
pnpm build

# 装进 profile；注意 pnpm 的 file: 依赖必须先 remove 再 add
DSH="<HARNESS>/resources/runtime/cli/bin/dsh.cmd"
"$DSH" plugin --profile web remove dsh-thin-ssh
"$DSH" plugin --profile web add file:<PLUGINS>/dsh-thin-ssh
```

`cordis.patch.yml` 里只有一行 `insert`，无需手工改 profile 的 patch 文件。插件**没有浏览器半边**，因此无需重启宿主去刷新 client boot graph；但新增/删除工具本身属于插件装载，按常规重装流程即可。

## 快速开始

在会话里直接对 Agent 说：

> 用 thin ssh 连 prod.example，看看 /srv/app 里有什么。

Agent 应该按这个顺序调用工具：

1. `thin_ssh_status` —— 看本机 ssh 客户端和已有 profile。
2. `thin_ssh_profile`（`action: "add"`）—— 写入 `host` / `user` / `port` / `identityFile` / `cwd`。第一个 profile 自动成为默认。
3. `thin_ssh_list`、`thin_ssh_exec`、`thin_ssh_read_file`、`thin_ssh_write_file` —— 在服务器上干活。

## 工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `thin_ssh_status` | 查看客户端、profile 列表，可选连通性测试 | `profile`, `check` |
| `thin_ssh_profile` | `list` / `add` / `update` / `remove` / `default` | `action`, `name`, `host`, `user`, `port`, `identityFile`, `cwd`, `extraArgs`, `description` |
| `thin_ssh_exec` | 在远端 shell 执行命令 | `command`（必填）, `profile`, `cwd`, `stdin`, `timeoutMs`, `maxOutputBytes` |
| `thin_ssh_read_file` | 读取远端 UTF-8 文本 | `path`（必填）, `offset`, `limit`, `maxBytes` |
| `thin_ssh_write_file` | 写入/追加远端文本（base64 传输） | `path`, `content`（必填）, `append`, `createDirs`, `mode` |
| `thin_ssh_list` | 列出远端目录 | `path`, `long` |

所有工具都返回 JSON 结构化结果（`ok`、`exitCode`、`stdout`、`stderr`、`truncated`、`message` 等），模型看到的文本由 `output.render` 投影。`exitCode: -1` 表示进程没有产生退出码（spawn 失败、超时、被取消或输出超限），此时看 `error` 字段。

## 配置

在 profile 的 `cordis.yml` 中：

```yaml
config:
  dsh-thin-ssh:
    enabled: true
    sshPath: ssh
    defaultProfile: ''
    defaultTimeoutMs: 120000
    connectTimeoutSec: 10
    maxOutputBytes: 65536
    maxWriteBytes: 1048576
    allowedHosts: []
    allowWrite: true
    batchMode: true
    promptSection: true
    # stateDir: /custom/path
```

- `allowedHosts`：非空时只允许列表中的 host / ssh 别名，防止 Agent 跑去别的机器。
- `allowWrite: false`：只读模式，`thin_ssh_write_file` 在启动 ssh 之前就被拒绝。
- `stateDir` 或环境变量 `DSH_THIN_SSH_STATE_DIR`：覆盖 profile 存储目录；默认是 `<DSH_HOME>/dsh-thin-ssh/profiles.json`。

profile 文件也可以手工编辑，下一次工具调用立即生效：

```json
{
  "version": 1,
  "default": "prod",
  "profiles": {
    "prod": {
      "host": "prod.example",
      "user": "deploy",
      "port": 22,
      "identityFile": "~/.ssh/id_ed25519",
      "cwd": "/srv/app",
      "extraArgs": ["-o", "ProxyJump=bastion"],
      "description": "production app server"
    }
  }
}
```

## 安全边界与限制

- 本地 `ssh` 用 argv 数组启动，**不经过本地 shell**，profile 字段无法注入本地命令；路径则在远端 shell 里做单引号转义。
- `command` 本身是交给远端 shell 的解释执行，等同于把 shell 权限交给 Agent；请通过 `allowedHosts`、服务器账号权限和 `allowWrite` 控制影响面。
- 写入按 base64 分块（每块 16 KiB 字符）串行执行；单文件上限默认为 1 MiB，可通过 `maxWriteBytes` 调整。超大文件请用 `thin_ssh_exec` 在服务器上生成，或走专门的文件传输工具。
- 超时/取消只杀**本地 ssh 进程**；已经在远端启动的命令可能继续跑完。需要显式终止时请在远端用 `pkill` 等命令处理。
- 路径中的 `~` 会展开为**远端** `$HOME`；不支持密码交互和 `sshpass` 式调用。
- 没有客户端半边，因此没有侧边栏指示灯；连接状态请用 `thin_ssh_status` 查询。

## 开发

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -b tsconfig.json
node node_modules/tsdown/dist/run.mjs
node --experimental-strip-types tests/core.test.mjs
node --experimental-strip-types tests/plugin.test.mjs
```

测试不依赖真实 SSH 服务器：runner 的 `spawnFn` 可注入，所有超时、取消、退出码、输出截断路径都由假子进程覆盖。
