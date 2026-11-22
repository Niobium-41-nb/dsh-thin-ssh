/**
 * Shared data contracts for dsh-thin-ssh.
 *
 * Everything crossing a tool boundary is plain JSON: no class instances, no
 * `undefined` fields, no Buffers. That keeps `output.schema` validation happy
 * and makes session-log replay deterministic.
 * @module dsh-thin-ssh/types
 */

/** One remote endpoint. Authentication is always delegated to the local ssh client. */
export interface SshProfile {
  /** Host name, IP, or a Host alias from the user's ssh config. */
  host: string
  /** Remote user; omitted means ssh's own default. */
  user?: string
  /** Remote port; omitted means ssh's own default. */
  port?: number
  /** Local private key path; `~` is expanded. */
  identityFile?: string
  /** Default remote working directory for every tool call. */
  cwd?: string
  /** Extra LOCAL ssh CLI arguments, e.g. `-o ProxyJump=bastion`. */
  extraArgs?: string[]
  /** Human-readable note. */
  description?: string
}

/** On-disk profile document (`profiles.json`). */
export interface ProfileDocument {
  version: 1
  default: string
  profiles: Record<string, SshProfile>
}

/** Plugin configuration (also the schemastery schema shape). */
export interface Config {
  /** Whether the tools are active. */
  enabled: boolean
  /** Local ssh executable, resolved through PATH by default. */
  sshPath: string
  /** Profile name used when a tool call omits `profile`. */
  defaultProfile: string
  /** Hard deadline for one remote command. */
  defaultTimeoutMs: number
  /** ssh ConnectTimeout, in seconds. */
  connectTimeoutSec: number
  /** Cap on captured stdout+stderr per call. */
  maxOutputBytes: number
  /** Cap on one write_file payload in UTF-8 bytes. */
  maxWriteBytes: number
  /** When non-empty, only these hosts / aliases may be called. */
  allowedHosts: string[]
  /** When false, write_file is refused before ssh starts. */
  allowWrite: boolean
  /** Add `BatchMode=yes` so a missing key fails instead of prompting. */
  batchMode: boolean
  /** Register the short usage section in the system prompt. */
  promptSection: boolean
  /** Override the profile store directory. */
  stateDir?: string
}

/** Structured result of one remote command. */
export interface SshRunResult {
  /** Whether the local spawn succeeded and the remote exit code was zero. */
  ok: boolean
  /** `null` when the process never produced an exit code (spawn error, kill). */
  exitCode: number | null
  /** Captured stdout, already capped. */
  stdout: string
  /** Captured stderr, already capped. */
  stderr: string
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Whether output was cut at the configured cap. */
  truncated: boolean
  /** Human-readable error from the local side (not remote exit status). */
  error: string
}

/** One resolved endpoint plus the name it was resolved under. */
export interface ResolvedProfile {
  name: string
  profile: SshProfile
}
