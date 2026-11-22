/**
 * The six model-callable thin-ssh tools.
 *
 * The agent stays in this process. Each tool resolves a profile, builds a
 * remote command, and delegates the actual work to `ssh` on the local machine.
 * No password ever enters a tool argument: authentication is the local ssh
 * client's job (agent, key file, or ssh config).
 * @module dsh-thin-ssh/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  assertCommand, assertHostAllowed, assertNoSecretKeys, assertPrintable, normalizeProfile, validateProfileName,
} from './config.ts'
import {
  CHECK_COMMAND, buildListCommand, buildReadCommand, buildWriteCommands, withCwd,
} from './command.ts'
import { runSsh } from './runner.ts'
import type { SshSpawn } from './runner.ts'
import type { ProfileStore } from './store.ts'
import type { Config, SshProfile } from './types.ts'

/** Registration inputs. */
export interface ToolsOptions {
  config: Config
  store: ProfileStore
  /** Test seam; production uses the real `ssh` process. */
  spawnFn?: SshSpawn
}

interface BaseRemoteArgs {
  profile?: string
  cwd?: string
  stdin?: string
  timeoutMs?: number
  maxOutputBytes?: number
}

interface ExecArgs extends BaseRemoteArgs {
  command: string
}

interface ReadArgs extends BaseRemoteArgs {
  path: string
  offset?: number
  limit?: number
  maxBytes?: number
}

interface WriteArgs extends BaseRemoteArgs {
  path: string
  content: string
  append?: boolean
  createDirs?: boolean
  mode?: string
}

interface ListArgs extends BaseRemoteArgs {
  path?: string
  long?: boolean
}

interface StatusArgs {
  profile?: string
  check?: boolean
}

type ProfileAction = 'list' | 'add' | 'update' | 'remove' | 'default'

interface ProfileArgs {
  action: ProfileAction
  name?: string
  host?: string
  user?: string
  port?: number
  identityFile?: string
  cwd?: string
  description?: string
  extraArgs?: string[]
}

interface CommandResult {
  ok: boolean
  profile: string
  command: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
  error: string
  message: string
}

interface ReadResult extends CommandResult {
  path: string
  bytes: number
}

interface WriteResult extends CommandResult {
  path: string
  bytes: number
  mode: string
}

interface StatusResult {
  ok: boolean
  sshPath: string
  profiles: string[]
  defaultProfile: string
  activeProfile: string
  reachable: boolean
  message: string
}

interface ProfileResult {
  ok: boolean
  action: ProfileAction
  profiles: string[]
  defaultProfile: string
  message: string
}

/** Shared output properties for every command-shaped tool. */
const commandProperties = {
  ok: { type: 'boolean' as const, required: true },
  profile: { type: 'string' as const, required: true },
  command: { type: 'string' as const, required: true },
  exitCode: { type: 'integer' as const, required: true },
  stdout: { type: 'string' as const, required: true },
  stderr: { type: 'string' as const, required: true },
  durationMs: { type: 'integer' as const, required: true },
  truncated: { type: 'boolean' as const, required: true },
  error: { type: 'string' as const, required: true },
  message: { type: 'string' as const, required: true },
} as const

/** Model-facing text for one remote command result. */
function describeRun(value: CommandResult): string {
  const head = `${value.ok ? 'OK' : 'FAILED'} on ${value.profile}: exit ${String(value.exitCode)}, ${String(value.durationMs)}ms`
  const error = value.error === '' ? '' : ` | ${value.error}`
  const stdout = value.stdout.length > 0 ? value.stdout : '(empty)'
  const stderr = value.stderr.length > 0 ? `\nstderr:\n${value.stderr}` : ''
  const truncated = value.truncated ? '\n[output truncated]' : ''
  return `${head}${error}\nstdout:\n${stdout}${stderr}${truncated}\n${value.message}`
}

/** Build a structured failure without throwing (the model can recover from it). */
function failedCommand(profile: string, command: string, error: string): CommandResult {
  return {
    ok: false,
    profile,
    command,
    exitCode: -1,
    stdout: '',
    stderr: '',
    durationMs: 0,
    truncated: false,
    error,
    message: error,
  }
}

/** Resolve an explicit / configured / stored profile in that order. */
function resolveTarget(store: ProfileStore, config: Config, requested?: string): { name: string; profile: SshProfile } {
  const document = store.read()
  const explicit = requested !== undefined && requested.trim().length > 0 ? requested.trim() : undefined
  const configured = config.defaultProfile.trim().length > 0 ? config.defaultProfile.trim() : undefined
  const name = explicit ?? configured ?? document.default
  if (name.length === 0) {
    throw new Error('no SSH profile configured: call thin_ssh_profile with action "add" first')
  }
  const profile = document.profiles[name]
  if (profile === undefined) throw new Error(`unknown SSH profile "${name}"`)
  assertHostAllowed(profile.host, config.allowedHosts)
  return { name, profile }
}

/** Register every tool on the host context. */
export function registerTools(ctx: Context, options: ToolsOptions): void {
  const { config, store, spawnFn } = options

  /** Run one remote command and project it into a JSON-safe result. */
  const remote = async (args: BaseRemoteArgs, exec: ToolRunContext | undefined, command: string): Promise<CommandResult> => {
    let name = ''
    try {
      const target = resolveTarget(store, config, args.profile)
      name = target.name
      const fullCommand = withCwd(command, args.cwd, target.profile.cwd)
      const run = await runSsh({
        config,
        profile: target.profile,
        command: fullCommand,
        ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.maxOutputBytes !== undefined ? { maxOutputBytes: args.maxOutputBytes } : {}),
        ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
        ...(spawnFn !== undefined ? { spawnFn } : {}),
      })
      const value: CommandResult = {
        ok: run.ok,
        profile: name,
        command: fullCommand,
        exitCode: run.exitCode ?? -1,
        stdout: run.stdout,
        stderr: run.stderr,
        durationMs: run.durationMs,
        truncated: run.truncated,
        error: run.error,
        message: run.ok ? 'remote command completed' : 'remote command failed',
      }
      return value
    } catch (error) {
      return failedCommand(name, command, error instanceof Error ? error.message : String(error))
    }
  }

  ctx.tools.register(defineTool({
    name: 'thin_ssh_status',
    description: 'Inspect the local OpenSSH client, the configured SSH profiles, and optionally test connectivity '
      + 'to one profile. Use this first when the agent needs to know which server it can operate on.',
    parameters: {
      profile: { type: 'string', description: 'Profile to inspect/test. Defaults to the configured or stored default.' },
      check: { type: 'boolean', description: 'Run a cheap remote `true` to verify the connection. Default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sshPath: { type: 'string', required: true },
          profiles: { type: 'array', items: { type: 'string' }, required: true },
          defaultProfile: { type: 'string', required: true },
          activeProfile: { type: 'string', required: true },
          reachable: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String((value as StatusResult).message) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: StatusArgs, exec: ToolRunContext) {
      try {
        const document = store.read()
        const names = Object.keys(document.profiles).sort()
        let active = ''
        let reachable = false
        let note = ''
        if (names.length > 0) {
          const target = resolveTarget(store, config, args.profile)
          active = target.name
          if (args.check === true) {
            const probe = await remote({ profile: active, timeoutMs: 15_000, maxOutputBytes: 4_096 }, exec, CHECK_COMMAND)
            reachable = probe.ok
            note = probe.ok ? 'connection OK' : `connection failed: ${probe.message}`
          }
        }
        const value: StatusResult = {
          ok: true,
          sshPath: config.sshPath,
          profiles: names,
          defaultProfile: document.default,
          activeProfile: active,
          reachable,
          message: [
            `ssh client: ${config.sshPath}`,
            `profiles: ${names.length > 0 ? names.join(', ') : '(none configured)'}`,
            `default: ${document.default === '' ? '(none)' : document.default}`,
            active === '' ? '' : `active: ${active}${args.check === true ? ` — ${note}` : ''}`,
            'Authentication uses your local ssh agent / key files; no password is stored by this plugin.',
          ].filter((line) => line.length > 0).join('\n'),
        }
        return value
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false, sshPath: config.sshPath, profiles: [], defaultProfile: '', activeProfile: '',
          reachable: false, message: `thin_ssh_status failed: ${message}`,
        } satisfies StatusResult
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thin_ssh_profile',
    description: 'List, add, update, remove, or select SSH profiles. A profile holds host, optional user, port, '
      + 'identity file, extra local ssh arguments, and a default remote working directory. Never put passwords '
      + 'or private keys in a profile; configure them locally for the ssh client.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'update', 'remove', 'default'],
        description: '`add` is an idempotent upsert; `update` requires an existing profile; `default` selects one.',
      },
      name: { type: 'string', description: 'Profile name: 1-64 letters, digits, dot, dash or underscore.' },
      host: { type: 'string', description: 'Host name, IP, or an alias from the local ssh config.' },
      user: { type: 'string', description: 'Remote user.' },
      port: { type: 'integer', description: 'Remote port (1-65535).' },
      identityFile: { type: 'string', description: 'Local private-key path; `~` is expanded locally.' },
      cwd: { type: 'string', description: 'Default remote working directory.' },
      description: { type: 'string', description: 'Short human-readable note.' },
      extraArgs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra LOCAL ssh CLI arguments, e.g. "-o" and "ProxyJump=bastion" as two entries.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          profiles: { type: 'array', items: { type: 'string' }, required: true },
          defaultProfile: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String((value as ProfileResult).message) }],
    },
    async execute(args: ProfileArgs) {
      const fail = (message: string): ProfileResult => ({
        ok: false, action: args.action, profiles: store.names(), defaultProfile: store.read().default, message,
      })
      try {
        if (args.action === 'list') {
          const document = store.read()
          const lines = Object.entries(document.profiles).map(([name, profile]) => {
            const user = profile.user === undefined ? '' : `${profile.user}@`
            const port = profile.port === undefined ? '' : `:${String(profile.port)}`
            const note = profile.description === undefined ? '' : ` — ${profile.description}`
            return `- ${name}: ${user}${profile.host}${port}${note}`
          })
          return {
            ok: true,
            action: 'list',
            profiles: Object.keys(document.profiles).sort(),
            defaultProfile: document.default,
            message: lines.length > 0 ? lines.join('\n') : 'No SSH profiles configured yet.',
          } satisfies ProfileResult
        }

        if (args.name === undefined || args.name.trim().length === 0) {
          return fail(`action "${args.action}" requires a name`)
        }
        const name = validateProfileName(args.name.trim())
        assertNoSecretKeys(args as unknown as Record<string, unknown>, `profile "${name}"`)
        let document
        if (args.action === 'add' || args.action === 'update') {
          const existing = store.read().profiles[name]
          if (args.action === 'update' && existing === undefined) return fail(`unknown SSH profile "${name}"`)
          const merged: Record<string, unknown> = {
            ...(existing === undefined ? {} : existing as unknown as Record<string, unknown>),
            ...(args.host !== undefined ? { host: args.host } : {}),
            ...(args.user !== undefined ? { user: args.user } : {}),
            ...(args.port !== undefined ? { port: args.port } : {}),
            ...(args.identityFile !== undefined ? { identityFile: args.identityFile } : {}),
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.extraArgs !== undefined ? { extraArgs: args.extraArgs } : {}),
          }
          const profile = normalizeProfile(merged, name)
          assertHostAllowed(profile.host, config.allowedHosts)
          document = store.upsert(name, profile)
        } else if (args.action === 'remove') {
          document = store.remove(name)
        } else {
          document = store.setDefault(name)
        }
        return {
          ok: true,
          action: args.action,
          profiles: Object.keys(document.profiles).sort(),
          defaultProfile: document.default,
          message: `SSH profile ${name}: ${args.action} applied. Profiles: ${Object.keys(document.profiles).sort().join(', ') || '(none)'}.`,
        } satisfies ProfileResult
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thin_ssh_exec',
    description: 'Execute a shell command ON THE REMOTE SERVER through ssh. The agent itself keeps running locally; '
      + 'use this tool (not a local shell) for anything that must affect the server. Supports an optional remote '
      + 'working directory, stdin, timeout and output cap. A non-zero remote exit code is reported, not thrown.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Shell command executed by the remote user\'s shell. Quote paths for that shell.',
      },
      profile: { type: 'string', description: 'Profile name; defaults to the configured or stored default.' },
      cwd: { type: 'string', description: 'Remote working directory for this call.' },
      stdin: { type: 'string', description: 'Optional text written to the remote command\'s stdin.' },
      timeoutMs: { type: 'integer', description: 'Deadline in milliseconds; defaults to the plugin configuration.' },
      maxOutputBytes: { type: 'integer', description: 'Cap on combined stdout+stderr bytes.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: commandProperties },
      render: (_args, value) => [{ type: 'text', text: describeRun(value as CommandResult) }],
    },
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `SSH ${(args as ExecArgs).command.split('\n')[0]?.slice(0, 80) ?? 'command'}`,
      kind: 'execute' as const,
      rawInput: (args as ExecArgs).command,
    }),
    async execute(args: ExecArgs, exec: ToolRunContext) {
      if (config.enabled === false) return failedCommand('', '', 'thin-ssh is disabled in the plugin configuration')
      try {
        assertCommand(args.command)
      } catch (error) {
        return failedCommand('', args.command, error instanceof Error ? error.message : String(error))
      }
      return await remote(args, exec, args.command)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thin_ssh_read_file',
    description: 'Read a UTF-8 text file on the remote server. Use this instead of a local file read when the '
      + 'target lives on the server. Supports 1-based line offset and line limit; output is capped.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path. A leading `~` uses the remote HOME.' },
      profile: { type: 'string', description: 'Profile name; defaults to the configured or stored default.' },
      cwd: { type: 'string', description: 'Remote working directory for this call.' },
      offset: { type: 'integer', description: '1-based first line to return. Default 1.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return.' },
      maxBytes: { type: 'integer', description: 'Hard cap on bytes read from the server.' },
      timeoutMs: { type: 'integer', description: 'Deadline in milliseconds.' },
      maxOutputBytes: { type: 'integer', description: 'Cap on combined stdout+stderr bytes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ...commandProperties, path: { type: 'string', required: true }, bytes: { type: 'integer', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: describeRun(value as ReadResult) }],
    },
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `SSH read ${(args as ReadArgs).path}`,
      kind: 'read' as const,
      rawInput: (args as ReadArgs).path,
    }),
    async execute(args: ReadArgs, exec: ToolRunContext) {
      if (config.enabled === false) return { ...failedCommand('', '', 'thin-ssh is disabled'), path: args.path, bytes: 0 }
      let command = ''
      try {
        assertPrintable(args.path, 'path')
        command = buildReadCommand(args.path, args.offset, args.limit, args.maxBytes)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ...failedCommand('', command, message), path: args.path, bytes: 0 }
      }
      const run = await remote(args, exec, command)
      return { ...run, path: args.path, bytes: Buffer.byteLength(run.stdout, 'utf8') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thin_ssh_write_file',
    description: 'Write or append UTF-8 text to a file ON THE REMOTE SERVER. Content is transferred as base64 chunks '
      + 'so quotes and newlines are preserved. Parent directories are created by default; an optional octal mode '
      + 'is applied after writing. Refused when the plugin sets allowWrite=false.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path. A leading `~` uses the remote HOME.' },
      content: { type: 'string', required: true, description: 'Exact UTF-8 text to write.' },
      profile: { type: 'string', description: 'Profile name; defaults to the configured or stored default.' },
      cwd: { type: 'string', description: 'Remote working directory for this call.' },
      append: { type: 'boolean', description: 'Append instead of replacing the file. Default false.' },
      createDirs: { type: 'boolean', description: 'Create missing parent directories. Default true.' },
      mode: { type: 'string', description: 'Optional octal mode, e.g. "644" or "0755".' },
      timeoutMs: { type: 'integer', description: 'Deadline in milliseconds.' },
      maxOutputBytes: { type: 'integer', description: 'Cap on combined stdout+stderr bytes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...commandProperties,
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          mode: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: describeRun(value as WriteResult) }],
    },
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `SSH write ${(args as WriteArgs).path}`,
      kind: 'edit' as const,
      rawInput: (args as WriteArgs).path,
    }),
    async execute(args: WriteArgs, exec: ToolRunContext) {
      const mode = args.mode ?? ''
      const reject = (message: string): WriteResult => ({
        ...failedCommand('', '', message), path: args.path, bytes: 0, mode,
      })
      if (config.enabled === false) return reject('thin-ssh is disabled')
      if (config.allowWrite === false) return reject('remote writes are disabled by allowWrite=false')
      let commands: string[] = []
      let bytes = 0
      try {
        bytes = Buffer.byteLength(args.content, 'utf8')
        commands = buildWriteCommands(args.path, args.content, {
          append: args.append === true,
          createDirs: args.createDirs !== false,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          maxWriteBytes: config.maxWriteBytes,
        })
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error))
      }

      let last = failedCommand('', commands[0] ?? '', 'write did not run')
      for (const command of commands) {
        // Each chunk is one ssh call: a failed chunk must stop the sequence.
        const result = await remote(args, exec, command)
        last = result
        if (!result.ok) break
      }
      return { ...last, path: args.path, bytes: last.ok ? bytes : 0, mode }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thin_ssh_list',
    description: 'List a directory ON THE REMOTE SERVER. Use `long=true` for permissions, owner, size and '
      + 'timestamps. Paths are quoted for the remote shell.',
    parameters: {
      path: { type: 'string', description: 'Remote directory; defaults to the remote HOME.' },
      profile: { type: 'string', description: 'Profile name; defaults to the configured or stored default.' },
      cwd: { type: 'string', description: 'Remote working directory for this call.' },
      long: { type: 'boolean', description: 'Use `ls -la` instead of `ls -1`.' },
      timeoutMs: { type: 'integer', description: 'Deadline in milliseconds.' },
      maxOutputBytes: { type: 'integer', description: 'Cap on combined stdout+stderr bytes.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: commandProperties },
      render: (_args, value) => [{ type: 'text', text: describeRun(value as CommandResult) }],
    },
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `SSH list ${(args as ListArgs).path ?? '~'}`,
      kind: 'other' as const,
    }),
    async execute(args: ListArgs, exec: ToolRunContext) {
      if (config.enabled === false) return failedCommand('', '', 'thin-ssh is disabled')
      try {
        const path = args.path ?? '~'
        assertPrintable(path, 'path')
        return await remote(args, exec, buildListCommand(path, args.long === true))
      } catch (error) {
        return failedCommand('', '', error instanceof Error ? error.message : String(error))
      }
    },
  }))
}
