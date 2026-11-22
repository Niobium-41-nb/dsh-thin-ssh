/**
 * Pure helper tests: argument construction, profile normalization, store CRUD,
 * and every runner outcome through an injected fake child process.
 *
 * Run: node --experimental-strip-types tests/core.test.mjs
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCommand, normalizeProfile, resolveConfig, resolveStorePath, validateProfileName } from '../src/config.ts'
import {
  WRITE_CHARS_PER_CHUNK, buildListCommand, buildReadCommand, buildSshArgs, buildWriteCommands,
  quoteRemotePath, shellQuote, withCwd,
} from '../src/command.ts'
import { runSsh } from '../src/runner.ts'
import { ProfileStore } from '../src/store.ts'

const failures = []
let checks = 0

function ok(label, condition, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

function throws(label, fn, fragment) {
  try {
    fn()
    ok(label, false, 'expected an error')
  } catch (error) {
    ok(label, String(error).includes(fragment), `got ${String(error)}`)
  }
}

const config = resolveConfig()

// ── shell quoting ─────────────────────────────────────────────────────────
ok('shellQuote wraps plain paths', shellQuote('/srv/app') === "'/srv/app'")
ok('shellQuote escapes embedded quotes', shellQuote("a'b") === "'a'\\''b'")
ok('shellQuote neutralizes a leading dash', shellQuote('-rf') === "'./-rf'")
ok('quoteRemotePath keeps HOME expandable', quoteRemotePath('~/a b') === '"$HOME/"\'a b\'')
ok('quoteRemotePath handles bare tilde', quoteRemotePath('~') === '"$HOME"')

// ── local ssh argv ────────────────────────────────────────────────────────
const profile = {
  host: 'example',
  user: 'deploy',
  port: 2222,
  identityFile: '~/.ssh/id_ed25519',
  cwd: '/srv/app',
  extraArgs: ['-o', 'ProxyJump=bastion'],
}
const args = buildSshArgs(profile, config, 'echo hi')
ok('ssh args enable BatchMode', args[0] === '-o' && args[1] === 'BatchMode=yes', args.join(' '))
ok('ssh args set ConnectTimeout', args.includes('ConnectTimeout=10'))
ok('ssh args carry port and user', args.includes('-p') && args.includes('2222') && args.includes('-l') && args.includes('deploy'))
ok('ssh args carry the identity file', args.includes('-i') && args.some((a) => a.endsWith('id_ed25519')))
ok('ssh args preserve extra args in order', args.includes('ProxyJump=bastion'))
ok('ssh args end options before host and command', args.at(-3) === '--' && args.at(-2) === 'example' && args.at(-1) === 'echo hi')
ok('buildSshArgs accepts only printable commands', (() => {
  try {
    buildSshArgs(profile, config, 'ok\u0000bad')
    return false
  } catch {
    return true
  }
})())
ok('withCwd prefers the call override', withCwd('pwd', '/tmp', '/srv/app') === "cd '/tmp' && pwd")
ok('withCwd falls back to the profile', withCwd('pwd', undefined, '/srv/app') === "cd '/srv/app' && pwd")
ok('withCwd is inert with no directory', withCwd('pwd', undefined, undefined) === 'pwd')

// ── remote read / write / list commands ───────────────────────────────────
ok('read command uses cat by default', buildReadCommand('/srv/a.txt') === "cat '/srv/a.txt'")
ok('read command uses a line window', buildReadCommand('/srv/a.txt', 5, 10) === "tail -n +5 '/srv/a.txt' | head -n 10")
ok('read command caps bytes', buildReadCommand('a', undefined, undefined, 128) === 'head -c 128 \'a\'')
const text = 'line 1\nline 2\n' + 'x'.repeat(WRITE_CHARS_PER_CHUNK)
const writeOptions = { append: false, createDirs: true, maxWriteBytes: 1_000_000 }
const commands = buildWriteCommands('/srv/deep/a.txt', text, writeOptions)
ok('write commands are chunked', commands.length === 2, `got ${String(commands.length)}`)
ok('write command creates parent directories', commands[0].startsWith("mkdir -p '/srv/deep' && "))
ok('first chunk truncates, later chunks append', commands[0].includes('| base64 -d > ') && commands[1].includes('| base64 -d >> '))
const joinedBase64 = commands.map((c) => c.match(/printf '%s' '([^']*)'/)?.[1] ?? '').join('')
ok('write transport round-trips UTF-8', Buffer.from(joinedBase64, 'base64').toString('utf8') === text)
ok('write emits an empty file for empty content', buildWriteCommands('a', '', writeOptions).length === 1)
ok('write applies an octal mode last', buildWriteCommands('a', 'x', { ...writeOptions, mode: '644' })[0].endsWith(" && chmod 644 'a'"))
throws('write rejects a bad mode', () => buildWriteCommands('a', 'x', { ...writeOptions, mode: 'rwx' }), 'octal digits')
throws('write enforces its byte cap', () => buildWriteCommands('a', 'x'.repeat(100), { ...writeOptions, maxWriteBytes: 10 }), 'write cap')
ok('list command switches between short and long', buildListCommand('/srv', false) === "ls -1 '/srv'" && buildListCommand('/srv', true) === "ls -la '/srv'")

// ── config and profile validation ─────────────────────────────────────────
ok('resolveConfig fills defaults', resolveConfig({}).maxOutputBytes === 65_536)
ok('resolveConfig keeps an override', resolveConfig({ sshPath: '/usr/bin/ssh' }).sshPath === '/usr/bin/ssh')
const temp = mkdtempSync(join(tmpdir(), 'dsh-thin-ssh-core-'))
ok('state path honors the env override', resolveStorePath(config, { DSH_THIN_SSH_STATE_DIR: temp }) === join(temp, 'profiles.json'))
ok('state path honors the config override', resolveStorePath({ ...config, stateDir: temp }, {}) === join(temp, 'profiles.json'))
ok('profile name validation accepts normal names', validateProfileName('prod-01') === 'prod-01')
throws('profile name validation rejects spaces', () => validateProfileName('prod 1'), 'invalid profile name')
const normalized = normalizeProfile({ host: 'example', user: 'deploy', port: 22, extraArgs: ['-o', 'X=1'] }, 'prod')
ok('normalizeProfile keeps valid fields', normalized.host === 'example' && normalized.user === 'deploy' && normalized.port === 22)
throws('normalizeProfile needs a host', () => normalizeProfile({}, 'prod'), 'string host')
throws('normalizeProfile refuses secrets', () => normalizeProfile({ host: 'h', password: 'x' }, 'prod'), 'not supported')
throws('normalizeProfile checks the port range', () => normalizeProfile({ host: 'h', port: 70_000 }, 'prod'), '65535')
throws('assertCommand rejects empty commands', () => assertCommand(''), 'must not be empty')

// ── store CRUD ────────────────────────────────────────────────────────────
const store = new ProfileStore(join(temp, 'profiles.json'))
ok('a missing store reads as empty', store.names().length === 0)
store.upsert('prod', { host: 'prod.example' })
ok('the first profile becomes the default', store.read().default === 'prod')
store.upsert('dev', { host: 'dev.example' })
ok('a second profile does not steal the default', store.read().default === 'prod')
ok('store lists names in order', store.names().join(',') === 'dev,prod')
store.setDefault('dev')
ok('setDefault changes the default', store.read().default === 'dev')
store.remove('dev')
ok('removing the default clears it', store.read().default === '')
throws('removing an unknown profile fails', () => store.remove('dev'), 'unknown SSH profile')
writeFileSync(store.file, '{not json', 'utf8')
throws('a corrupt store is reported, not silently reset', () => store.read(), 'JSON')

// ── runner outcomes ───────────────────────────────────────────────────────
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdin = { end() {} }
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.killed = false
  }

  kill() {
    this.killed = true
    return true
  }
}

function fakeSpawn(script) {
  return (_command, _args, _options) => {
    const child = new FakeChild()
    queueMicrotask(() => script(child))
    return child
  }
}

const run = async (script, overrides = {}) => runSsh({
  config,
  profile: { host: 'example' },
  command: 'true',
  spawnFn: fakeSpawn(script),
  ...overrides,
})

const success = await run((child) => {
  child.stdout.emit('data', Buffer.from('out'))
  child.stderr.emit('data', Buffer.from('warn'))
  child.emit('close', 0, null)
})
ok('runner reports success with both streams', success.ok && success.stdout === 'out' && success.stderr === 'warn')

const nonzero = await run((child) => child.emit('close', 7, null))
ok('runner reports a non-zero exit', !nonzero.ok && nonzero.exitCode === 7)

const spawnError = await run((child) => child.emit('error', new Error('ENOENT')), {
  spawnFn: () => { throw new Error('boom') },
})
ok('runner catches a synchronous spawn failure', !spawnError.ok && spawnError.error.includes('boom'), spawnError.error)

const emittedError = await run((child) => child.emit('error', new Error('ENOENT')))
ok('runner catches an emitted error', !emittedError.ok && emittedError.error.includes('ENOENT'))

const capped = await run((child) => {
  child.stdout.emit('data', Buffer.from('12345'))
  child.stdout.emit('data', Buffer.from('67890'))
  child.emit('close', 0, null)
}, { maxOutputBytes: 6 })
ok('runner truncates at the cap', capped.truncated && capped.stdout === '123456', `${capped.stdout}/${String(capped.truncated)}`)

const timedOut = await run(() => {}, { timeoutMs: 5 })
ok('runner kills on timeout', !timedOut.ok && timedOut.error.includes('timed out'))

const controller = new AbortController()
const aborted = await run((child) => {
  queueMicrotask(() => controller.abort())
}, { signal: controller.signal })
ok('runner reports an aborted call', !aborted.ok && aborted.error.includes('cancelled'))

const preAborted = new AbortController()
preAborted.abort()
const cancelled = await run(() => {}, { signal: preAborted.signal })
ok('an already aborted signal is handled', !cancelled.ok && cancelled.error.includes('cancelled'))

process.stdout.write(`\n${String(checks)} checks, ${String(failures.length)} failures\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  process.exitCode = 1
}
