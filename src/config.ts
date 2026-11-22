/**
 * Configuration, profile validation, and state-path resolution.
 *
 * There is deliberately no settings-namespace dependency: the profile store is
 * a small JSON file the plugin owns, so a thin-ssh setup survives harness
 * profile changes and can also be edited by hand.
 * @module dsh-thin-ssh/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Config as ConfigShape, SshProfile } from './types.ts'

/** Stable profile name pattern; keeps keys safe in JSON and in tool output. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Fields that must never be persisted, even if a caller supplies them. */
const FORBIDDEN_PROFILE_KEYS = new Set(['password', 'passphrase', 'privateKey', 'secret', 'key'])

/** Expand a leading `~` the way the harness's own helpers do. */
export function expandHomePath(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/** Resolve the DeepSeek Harness home without importing its private packages. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(expandHomePath(fromEnv))
  return join(homedir(), '.dsh')
}

/** Resolve the directory that holds `profiles.json`. */
export function resolveStateDir(config: ConfigShape, env: NodeJS.ProcessEnv = process.env): string {
  if (config.stateDir !== undefined && config.stateDir.trim().length > 0) {
    return resolve(expandHomePath(config.stateDir))
  }
  const fromEnv = env.DSH_THIN_SSH_STATE_DIR
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(expandHomePath(fromEnv))
  return join(resolveDshHome(env), 'dsh-thin-ssh')
}

/** Resolve the full profile-store path. */
export function resolveStorePath(config: ConfigShape, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStateDir(config, env), 'profiles.json')
}

/** Schemastery declaration shown in `cordis.yml`. */
export const Config: z<ConfigShape> = z.object({
  enabled: z.boolean().default(true),
  sshPath: z.string().default('ssh'),
  defaultProfile: z.string().default(''),
  defaultTimeoutMs: z.natural().default(120_000),
  connectTimeoutSec: z.natural().default(10),
  maxOutputBytes: z.natural().default(65_536),
  maxWriteBytes: z.natural().default(1_048_576),
  allowedHosts: z.array(String).default([]),
  allowWrite: z.boolean().default(true),
  batchMode: z.boolean().default(true),
  promptSection: z.boolean().default(true),
  stateDir: z.string(),
})

/** Complete defaults, so direct instantiation never reads `undefined` knobs. */
export const DEFAULTS: ConfigShape = {
  enabled: true,
  sshPath: 'ssh',
  defaultProfile: '',
  defaultTimeoutMs: 120_000,
  connectTimeoutSec: 10,
  maxOutputBytes: 65_536,
  maxWriteBytes: 1_048_576,
  allowedHosts: [],
  allowWrite: true,
  batchMode: true,
  promptSection: true,
}

/** Merge a partial configuration over the defaults. */
export function resolveConfig(raw: Partial<ConfigShape> | undefined): ConfigShape {
  const source = raw ?? {}
  return {
    ...DEFAULTS,
    ...source,
    allowedHosts: source.allowedHosts ?? DEFAULTS.allowedHosts,
    ...(source.stateDir !== undefined ? { stateDir: source.stateDir } : {}),
  }
}

/** Validate a profile name used as a JSON key. */
export function validateProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new Error(`invalid profile name "${name}": use 1-64 letters, digits, dot, dash or underscore`)
  }
  return name
}

/** Reject control characters (including NUL) in any string handed to ssh or a remote shell. */
export function assertPrintable(value: string, field: string): string {
  if (value.length === 0) throw new Error(`${field} must not be empty`)
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field} must not contain control characters`)
  return value
}

/** Refuse secret-looking fields before they can reach a profile or a command. */
export function assertNoSecretKeys(input: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_PROFILE_KEYS.has(key.toLowerCase())) {
      throw new Error(`${label}: ${key} is not supported; configure a key file or ssh agent locally`)
    }
  }
}

/**
 * Normalize an untrusted profile object into the persisted shape.
 *
 * Secret-looking keys are rejected rather than stored: authentication belongs
 * to the user's ssh agent / key files, never to a tool argument.
 */
export function normalizeProfile(input: unknown, name: string): SshProfile {
  validateProfileName(name)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`profile "${name}" must be an object`)
  }
  const raw = input as Record<string, unknown>
  assertNoSecretKeys(raw, `profile "${name}"`)
  if (typeof raw.host !== 'string') throw new Error(`profile "${name}" needs a string host`)
  const profile: SshProfile = { host: assertPrintable(raw.host.trim(), 'host') }

  if (raw.user !== undefined) {
    if (typeof raw.user !== 'string') throw new Error(`profile "${name}": user must be a string`)
    profile.user = assertPrintable(raw.user.trim(), 'user')
  }
  if (raw.port !== undefined) {
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65_535) {
      throw new Error(`profile "${name}": port must be an integer between 1 and 65535`)
    }
    profile.port = raw.port
  }
  if (raw.identityFile !== undefined) {
    if (typeof raw.identityFile !== 'string') throw new Error(`profile "${name}": identityFile must be a string`)
    profile.identityFile = expandHomePath(assertPrintable(raw.identityFile.trim(), 'identityFile'))
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string') throw new Error(`profile "${name}": cwd must be a string`)
    profile.cwd = raw.cwd.trim()
  }
  if (raw.extraArgs !== undefined) {
    if (!Array.isArray(raw.extraArgs) || raw.extraArgs.some((item) => typeof item !== 'string')) {
      throw new Error(`profile "${name}": extraArgs must be an array of strings`)
    }
    const extraArgs = raw.extraArgs as string[]
    for (const item of extraArgs) assertPrintable(item, 'extraArgs entry')
    profile.extraArgs = [...extraArgs]
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') throw new Error(`profile "${name}": description must be a string`)
    profile.description = raw.description.slice(0, 500)
  }
  return profile
}

/** Check a profile against the optional host allow-list. */
export function assertHostAllowed(host: string, allowedHosts: readonly string[]): void {
  if (allowedHosts.length === 0) return
  const lowered = host.toLowerCase()
  if (allowedHosts.some((allowed) => allowed.toLowerCase() === lowered)) return
  throw new Error(`host "${host}" is not in allowedHosts`)
}

/** Validate a remote command before it is sent to the shell on the server. */
export function assertCommand(command: string): string {
  if (command.length === 0) throw new Error('command must not be empty')
  if (command.includes('\u0000')) throw new Error('command must not contain NUL bytes')
  if (command.length > 1_000_000) throw new Error('command exceeds the 1000000-character safety limit')
  return command
}
