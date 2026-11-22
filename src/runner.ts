/**
 * One SSH invocation: spawn, cap, deadline, cancellation.
 *
 * The runner is intentionally injectable (`spawnFn`) so tests can drive every
 * outcome — including timeout and abort — without a real SSH server.
 * @module dsh-thin-ssh/runner
 */

import { spawn } from 'node:child_process'
import { buildSshArgs } from './command.ts'
import type { Config, SshProfile, SshRunResult } from './types.ts'

/** Minimal structural view of a child process, satisfyable by a test double. */
export interface SshChild {
  stdin: { end(data?: string | Uint8Array): void } | null
  stdout: { on(event: string, listener: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: string, listener: (chunk: Buffer) => void): unknown } | null
  on(event: string, listener: (...args: unknown[]) => void): unknown
  kill(signal?: string): boolean
}

/** Injectable process factory. */
export type SshSpawn = (
  command: string,
  args: readonly string[],
  options: { windowsHide: boolean },
) => SshChild

/** Real process factory. */
const defaultSpawn: SshSpawn = (command, args, options) => spawn(command, [...args], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: options.windowsHide,
}) as unknown as SshChild

/** Inputs to one remote command. */
export interface RunSshOptions {
  config: Config
  profile: SshProfile
  command: string
  stdin?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  spawnFn?: SshSpawn
}

/** Build a result for a failure that happened before (or instead of) a close event. */
function result(
  code: number | null,
  stdout: Buffer[],
  stderr: Buffer[],
  startedAt: number,
  truncated: boolean,
  error: string,
): SshRunResult {
  return {
    ok: error === '' && code === 0,
    exitCode: code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    durationMs: Date.now() - startedAt,
    truncated,
    error,
  }
}

/** Run one command on the remote host and collect its capped output. */
export async function runSsh(options: RunSshOptions): Promise<SshRunResult> {
  const startedAt = Date.now()
  const timeoutMs = Math.max(1, options.timeoutMs ?? options.config.defaultTimeoutMs)
  const cap = Math.max(1, options.maxOutputBytes ?? options.config.maxOutputBytes)
  const spawnFn = options.spawnFn ?? defaultSpawn
  const args = buildSshArgs(options.profile, options.config, options.command)

  let child: SshChild
  try {
    child = spawnFn(options.config.sshPath, args, { windowsHide: true })
  } catch (error) {
    return result(null, [], [], startedAt, false, `local ssh failed to start: ${String(error)}`)
  }

  return new Promise<SshRunResult>((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let collected = 0
    let truncated = false
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const kill = (): void => {
      try {
        child.kill()
      } catch {
        // A process that already exited needs no help.
      }
    }

    const finish = (code: number | null, error: string): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(result(code, stdoutChunks, stderrChunks, startedAt, truncated, error))
    }

    const onAbort = (): void => {
      kill()
      finish(null, 'cancelled: the tool call was aborted')
    }

    const collect = (sink: Buffer[], chunk: Buffer): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      const room = cap - collected
      if (room <= 0) {
        truncated = true
        return
      }
      if (buffer.length <= room) {
        sink.push(buffer)
        collected += buffer.length
        return
      }
      sink.push(buffer.subarray(0, room))
      collected = cap
      truncated = true
      kill()
      finish(null, `output exceeded the ${cap}-byte cap`)
    }

    if (child.stdout !== null) child.stdout.on('data', (chunk) => collect(stdoutChunks, chunk))
    if (child.stderr !== null) child.stderr.on('data', (chunk) => collect(stderrChunks, chunk))

    child.on('error', (error) => finish(null, `local ssh failed: ${String(error)}`))
    child.on('close', (code) => finish(typeof code === 'number' ? code : null, ''))

    timer = setTimeout(() => {
      kill()
      finish(null, `timed out after ${String(timeoutMs)}ms`)
    }, timeoutMs)

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) {
      onAbort()
      return
    }

    try {
      child.stdin?.end(options.stdin ?? '')
    } catch (error) {
      kill()
      finish(null, `could not write stdin: ${String(error)}`)
    }
  })
}
