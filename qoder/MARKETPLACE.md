# Qoder 插件市场提交材料

## 基本信息

| 字段 | 提交内容 |
| --- | --- |
| 插件名称 | Thin SSH |
| 插件标识 | `qoder-thin-ssh` |
| 版本 | `0.1.0` |
| 推荐分类 | 开发工具 / Developer Tools |
| 作者 | DSH plugin contributors |
| 许可证 | MIT |
| 图标 | `assets/icon.png` |
| 源码 | https://github.com/Niobium-41-nb/dsh-thin-ssh/tree/master/qoder |
| 问题反馈 | https://github.com/Niobium-41-nb/dsh-thin-ssh/issues |

## 简短摘要

通过本机 OpenSSH 在远程服务器执行命令、读写文本文件和列举目录，不保存密码或私钥。

## 详细介绍

Thin SSH 为 Qoder Desktop 提供 6 个 `thin_ssh_*` MCP 工具，让 Agent 把需要在服务器上执行的操作交给本机 OpenSSH 客户端，而不是使用本地 shell 模拟远程操作。

主要能力：

- 管理多个 SSH profile，支持 ssh config 别名、ssh-agent、密钥文件和 ProxyJump。
- 在远程 POSIX shell 执行命令并保留真实退出码。
- 读取、覆盖或追加远程 UTF-8 文本文件。
- 列举远程目录。
- 对连接和命令设置超时，对输出和写入大小设置上限，支持取消。
- 使用精确主机白名单和写入开关降低误操作风险。

插件不启动常驻服务，不监听端口，不需要 npm 依赖，也不把 profile、命令或文件内容上传到插件作者的服务。

## 使用说明

1. 安装并启用 Thin SSH。
2. 在本机配置 OpenSSH、密钥或 ssh-agent，并首次手工确认目标主机指纹。
3. 在 Qoder 会话中要求 Agent 调用 `thin_ssh_status` 检查状态。
4. 通过 `thin_ssh_profile` 添加主机、用户、端口和本机密钥路径；不要提供密码或私钥内容。
5. 使用 `thin_ssh_exec`、`thin_ssh_read_file`、`thin_ssh_write_file` 或 `thin_ssh_list` 完成远程任务。

完整说明见 [README.md](README.md)。

## 前置条件

- Qoder Desktop 支持第三方插件。
- 本机 OpenSSH 客户端可用。
- 远程账号使用 POSIX shell，并具备 `cat`、`head`、`tail`、`mkdir`、`chmod`、`printf`、`base64`、`ls`。
- 用户已有目标服务器访问权限，并自行配置密钥、ssh-agent 或 ssh config。

## 外部依赖

- 运行时：Qoder 内置 Node.js 通过 `${QODER_NODE_RUNTIME}` 提供。
- 系统命令：本机 `ssh`，可由 `THIN_SSH_SSH_PATH` 覆盖。
- 远端命令：上述 POSIX 工具。
- npm 第三方依赖：无。
- 在线 API、OAuth 服务、插件作者服务器：无。

## 审核测试说明

本插件使用本机 stdio MCP，不是在线 MCP 服务，无 URL、OAuth 或 API Key，因此无需服务授权或审核账号。

审核者可使用自有 SSH 目标验证真实连接，也可运行不连接外部服务器的测试：

```bash
npm test
npm run check
```

测试覆盖六个工具、MCP 初始化与工具发现、profile 持久化、密码字段拒绝、参数校验、ssh spawn 失败、超时、取消、输出上限、主机白名单、写入开关、远程路径引用、base64 分块写入和 SSH 选项注入防护。

自测报告见 [SELF_TEST_REPORT.md](SELF_TEST_REPORT.md)。插件包内不包含测试凭据、真实 profile 或用户配置。

## 隐私与权限说明

- profile 默认保存在用户本机 `~/.dsh/dsh-thin-ssh/profiles.json`。
- 不保存密码、私钥内容或 passphrase。
- 所有网络操作由用户本机 OpenSSH 直接发起。
- `thin_ssh_exec` 在远程 shell 执行命令，具有相应远程账号权限。
- `THIN_SSH_ALLOW_WRITE=false` 仅禁用 `thin_ssh_write_file`，不限制 `thin_ssh_exec`。
- `extraArgs` 拒绝 `ProxyCommand` 等可启动本机命令的 SSH 选项。

## 发布者署名

 manifest 和来源项目使用 **DSH plugin contributors**。发布者资料中的个人或组织名称、头像、联系方式和实名验证状态，以发布中心实际填写和审核结果为准。
