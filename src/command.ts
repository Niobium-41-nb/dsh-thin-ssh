/**
 * SSH argument and remote-command construction.
 *
 * Two rules govern this file:
 * 1. Local safety — the local `ssh` process is spawned with an argv array, never
 *    a shell, so profile fields cannot inject a local command.
 * 2. Remote correctness — every path is single-quoted for the remote shell,
 *    and file contents travel as base64 chunks so quotes/newlines cannot break
 *    the command string.
 * @module dsh-thin-ssh/command
 */

import { posix } from 'node:path'
import { assertCommand, assertPrintable, expandHomePath } from './config.ts'
import type { Config, SshProfile } from './types.ts'

/** Base64 characters per remote command; stays well below ARG_MAX on servers. */
export const WRITE_CHARS_PER_CHUNK = 16_384

/** POSIX single-quote a literal; a leading dash is neutralized with `./`. */
export function shellQuote(text: string): string {
  const safe = text.startsWith('-') ? `./${text}` : text
  return `'${safe.replaceAll("'", "'\\''")}'`
}

/** Quote a remote path, expanding a leading `~` through the remote shell's HOME. */
export function quoteRemotePath(path: string): string {
  assertPrintable(path, 'path')
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME/"${shellQuote(path.slice(2))}`
  return shellQuote(path)
}

/** Local `ssh` argv for one remote command. */
export function buildSshArgs(profile: SshProfile, config: Config, command: string): string[] {
  const args: string[] = []
  if (config.batchMode) args.push('-o', 'BatchMode=yes')
  args.push('-o', `ConnectTimeout=${config.connectTimeoutSec}`)
  if (profile.port !== undefined) args.push('-p', String(profile.port))
  if (profile.user !== undefined && profile.user.length > 0) args.push('-l', profile.user)
  if (profile.identityFile !== undefined && profile.identityFile.length > 0) {
    args.push('-i', expandHomePath(profile.identityFile))
  }
  for (const extra of profile.extraArgs ?? []) args.push(extra)
  args.push('--', profile.host, assertCommand(command))
  return args
}

/** Prefix a command with a remote `cd`, if a working directory was requested. */
export function withCwd(command: string, cwd: string | undefined, profileCwd?: string): string {
  const target = cwd ?? profileCwd
  if (target === undefined || target.length === 0) return command
  return `cd ${quoteRemotePath(target)} && ${command}`
}

/** Command used by the connectivity check. */
export const CHECK_COMMAND = 'true'

/** Command that reads text, optionally from a line offset/limit window. */
export function buildReadCommand(path: string, offset?: number, limit?: number, maxBytes?: number): string {
  const quoted = quoteRemotePath(path)
  if (offset === undefined && limit === undefined) {
    return maxBytes === undefined ? `cat ${quoted}` : `head -c ${maxBytes} ${quoted}`
  }
  let command = `tail -n +${Math.max(1, offset ?? 1)} ${quoted}`
  if (limit !== undefined) command += ` | head -n ${Math.max(0, limit)}`
  if (maxBytes !== undefined) command += ` | head -c ${maxBytes}`
  return command
}

/** Options for {@link buildWriteCommands}. */
export interface WriteOptions {
  append: boolean
  createDirs: boolean
  mode?: string
  maxWriteBytes: number
}

/** Commands that write UTF-8 text remotely through base64 chunks. */
export function buildWriteCommands(path: string, content: string, options: WriteOptions): string[] {
  const quoted = quoteRemotePath(path)
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > options.maxWriteBytes) {
    throw new Error(`content is ${bytes.length} bytes, above the ${options.maxWriteBytes}-byte write cap`)
  }
  if (options.mode !== undefined && !/^[0-7]{3,4}$/.test(options.mode)) {
    throw new Error('mode must be 3 or 4 octal digits, e.g. 644')
  }

  const base64 = bytes.toString('base64')
  const parent = posix.dirname(path)
  const prefix = options.createDirs && parent !== '.' && parent !== '/'
    ? `mkdir -p ${quoteRemotePath(parent)} && `
    : ''
  const chunks: string[] = []
  for (let start = 0; start < base64.length; start += WRITE_CHARS_PER_CHUNK) {
    chunks.push(base64.slice(start, start + WRITE_CHARS_PER_CHUNK))
  }
  if (chunks.length === 0) chunks.push('')

  return chunks.map((chunk, index) => {
    const operator = index === 0 && !options.append ? '>' : '>>'
    let command = `${prefix}printf '%s' '${chunk}' | base64 -d ${operator} ${quoted}`
    if (index === chunks.length - 1 && options.mode !== undefined) {
      command += ` && chmod ${options.mode} ${quoted}`
    }
    return command
  })
}

/** Command that lists a remote directory. */
export function buildListCommand(path: string, long: boolean): string {
  return long ? `ls -la ${quoteRemotePath(path)}` : `ls -1 ${quoteRemotePath(path)}`
}
