/**
 * dsh-thin-ssh — host plugin.
 *
 * The agent's reasoning loop stays in this harness process. Every registered
 * tool hands its real work to the local OpenSSH client, so the filesystem and
 * processes being manipulated belong to the remote server, not to the machine
 * running the agent.
 * @module dsh-thin-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, resolveConfig, resolveStorePath } from './config.ts'
import { ProfileStore } from './store.ts'
import { registerTools } from './tools.ts'
import type { SshSpawn } from './runner.ts'
import type { Config as ConfigShape } from './types.ts'

export type { SshProfile } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-thin-ssh'

/** The base bundle's tool registry is the only required service. */
export const inject = ['tools']

/** Schemastery configuration, surfaced in `cordis.yml`. */
export const Config = ConfigSchema

/** Prompt section that keeps the model from using local tools for remote work. */
const USAGE_SECTION = 'dsh-thin-ssh:usage'

/** Order just after the harness's own tool guidance. */
const USAGE_SECTION_ORDER = 10_060

/** Structural view of the optional system-prompt service. */
interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
}

/** Usage text shown to the model once per boot. */
export const USAGE_TEXT = [
  '## Thin SSH — remote operations',
  '',
  'You are running locally. Any operation that must affect the remote server MUST use a `thin_ssh_*` tool; '
  + 'local shell / `run_code` tools only affect the local machine.',
  '',
  'Start with `thin_ssh_status`. If no profile exists, create one with `thin_ssh_profile` (host, user, port, '
  + 'identity file). Then use `thin_ssh_exec` for commands and `thin_ssh_read_file`, `thin_ssh_write_file`, '
  + 'or `thin_ssh_list` for files. Commands are interpreted by the remote user\'s shell, so quote remote paths.',
  '',
  'Never ask the user for a password and never put a private key in a tool argument: authentication is handled '
  + 'by the local ssh client (ssh agent, key file, or ssh config). Report non-zero exit codes and capped output '
  + 'instead of assuming the command did nothing.',
].join('\n')

/** Optional test seam; production never supplies it. */
export interface ApplyDependencies {
  spawnFn?: SshSpawn
}

/** Mount the tool set and the optional prompt section. */
export function apply(ctx: Context, rawConfig?: Partial<ConfigShape>, deps?: ApplyDependencies): void {
  const config = resolveConfig(rawConfig)
  if (config.enabled === false) {
    process.stderr.write('[dsh-thin-ssh] disabled by configuration\n')
    return
  }

  const store = new ProfileStore(resolveStorePath(config))
  registerTools(ctx, {
    config,
    store,
    ...(deps?.spawnFn !== undefined ? { spawnFn: deps.spawnFn } : {}),
  })

  if (!config.promptSection || typeof ctx.inject !== 'function') return
  ctx.inject(['systemPrompt'], (scope) => {
    const systemPrompt = (scope as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
    if (systemPrompt === undefined) return
    systemPrompt.section({ name: USAGE_SECTION, order: USAGE_SECTION_ORDER, text: USAGE_TEXT })
  })
}
