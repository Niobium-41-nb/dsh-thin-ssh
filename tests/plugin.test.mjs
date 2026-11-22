/**
 * Wiring tests: mount the plugin against a fake cordis context, drive the six
 * tools, and use an injected fake `ssh` process so no server is needed.
 *
 * Run: node --experimental-strip-types tests/plugin.test.mjs
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

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

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdinData = ''
    this.stdin = { end: (data) => { this.stdinData = String(data ?? '') } }
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.killed = false
  }

  kill() {
    this.killed = true
    return true
  }
}

/** Mount the plugin with a fake tool registry and a fake ssh binary. */
function mount(stateDir, rawConfig = {}) {
  const tools = new Map()
  const injections = []
  const calls = []
  const children = []
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    inject(names, callback) {
      injections.push(names)
      callback(ctx)
      return () => {}
    },
    get() {
      return undefined
    },
  }
  const spawnFn = (_command, argv) => {
    const command = argv.at(-1)
    const child = new FakeChild()
    calls.push({ argv, command, child })
    children.push(child)
    queueMicrotask(() => {
      if (command === 'true' || command === 'false') {
        child.emit('close', command === 'false' ? 3 : 0, null)
        return
      }
      if (command.includes('base64 -d')) {
        child.emit('close', 0, null)
        return
      }
      if (command.startsWith('cat ') || command.includes('| head -n')) {
        child.stdout.emit('data', Buffer.from('hello\nworld\n'))
      } else if (command.startsWith('ls ')) {
        child.stdout.emit('data', Buffer.from('a.txt\nb.txt\n'))
      } else {
        child.stdout.emit('data', Buffer.from(`ran: ${command}\n`))
      }
      child.emit('close', 0, null)
    })
    return child
  }
  apply(ctx, { stateDir, ...rawConfig }, { spawnFn })
  return {
    tools,
    injections,
    calls,
    children,
    call: async (name, args) => tools.get(name).execute(args, {}),
  }
}

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-thin-ssh-plugin-'))
const harness = mount(stateDir)

ok('all six tools are registered', harness.tools.size === 6, `got ${String(harness.tools.size)}`)
ok('tool names are stable', [...harness.tools.keys()].sort().join(',') === [
  'thin_ssh_exec', 'thin_ssh_list', 'thin_ssh_profile', 'thin_ssh_read_file', 'thin_ssh_status', 'thin_ssh_write_file',
].join(','))
ok('the optional prompt service is requested', harness.injections.some((names) => names.includes('systemPrompt')))

const initial = await harness.call('thin_ssh_status', {})
ok('status with no profiles is not an error', initial.ok && initial.profiles.length === 0, String(initial.message))

const added = await harness.call('thin_ssh_profile', { action: 'add', name: 'prod', host: 'prod.example', user: 'deploy' })
ok('profile add creates a default', added.ok && added.defaultProfile === 'prod', String(added.message))
ok('profile add persists the host', added.profiles.includes('prod'))

const secret = await harness.call('thin_ssh_profile', { action: 'add', name: 'bad', host: 'h', password: 'x' })
ok('profile add refuses a password field', !secret.ok && String(secret.message).includes('not supported'))

const list = await harness.call('thin_ssh_profile', { action: 'list' })
ok('profile list reports the host', list.ok && list.message.includes('deploy@prod.example'), String(list.message))

const checked = await harness.call('thin_ssh_status', { profile: 'prod', check: true })
ok('status check reaches the fake server', checked.ok && checked.reachable, String(checked.message))
ok('status check uses BatchMode', harness.calls.at(-1).argv.includes('BatchMode=yes'))
ok('status check passes the host after --', harness.calls.at(-1).argv.at(-2) === 'prod.example')

const executed = await harness.call('thin_ssh_exec', { command: 'uname -a', profile: 'prod', cwd: '/srv/app' })
ok('exec reports success and stdout', executed.ok && executed.stdout.includes('ran:'), JSON.stringify(executed))
ok('exec records the remote command', executed.command === "cd '/srv/app' && uname -a", executed.command)
ok('exec passes stdin when supplied', (await harness.call('thin_ssh_exec', { command: 'cat', stdin: 'abc' })).ok
  && harness.children.at(-1).stdinData === 'abc')
const failedExit = await harness.call('thin_ssh_exec', { command: 'false' })
ok('non-zero results stay structured', failedExit.exitCode === 3 && !failedExit.ok && failedExit.stdout === '')

const read = await harness.call('thin_ssh_read_file', { path: '/srv/app/a.txt' })
ok('read_file returns remote content', read.ok && read.stdout === 'hello\nworld\n', JSON.stringify(read))
ok('read_file counts bytes', read.bytes === Buffer.byteLength('hello\nworld\n', 'utf8'))
ok('read_file builds a cat command', harness.calls.at(-1).command === "cat '/srv/app/a.txt'", harness.calls.at(-1).command)

const written = await harness.call('thin_ssh_write_file', { path: 'a.txt', content: 'hello' })
ok('write_file reports the byte count', written.ok && written.bytes === 5, JSON.stringify(written))
ok('write_file transfers through base64', harness.calls.at(-1).command.includes("printf '%s' 'aGVsbG8=' | base64 -d > 'a.txt'"), harness.calls.at(-1).command)
const beforeAppend = harness.calls.length
await harness.call('thin_ssh_write_file', { path: 'a.txt', content: '!', append: true })
ok('write_file appends when asked', harness.calls.at(-1).command.includes("| base64 -d >> 'a.txt'"))
ok('write_file uses one ssh call per short chunk', harness.calls.length === beforeAppend + 1)

const listing = await harness.call('thin_ssh_list', {})
ok('list uses the short form by default', listing.ok && harness.calls.at(-1).command.endsWith('ls -1 "$HOME"'), harness.calls.at(-1).command)
await harness.call('thin_ssh_list', { long: true, path: '/srv' })
ok('list switches to the long form', harness.calls.at(-1).command.includes("ls -la '/srv'"))

const updated = await harness.call('thin_ssh_profile', { action: 'update', name: 'prod', host: 'new.example' })
ok('profile update replaces the host', updated.ok)
const afterUpdate = await harness.call('thin_ssh_status', { check: true })
ok('status follows the updated host', afterUpdate.reachable && harness.calls.at(-1).argv.at(-2) === 'new.example')

const removed = await harness.call('thin_ssh_profile', { action: 'remove', name: 'prod' })
ok('profile remove clears the default', removed.ok && removed.defaultProfile === '')

// A second mount with the same store but a restricted configuration.
const guardedDir = mkdtempSync(join(tmpdir(), 'dsh-thin-ssh-guarded-'))
writeFileSync(join(guardedDir, 'profiles.json'), JSON.stringify({
  version: 1,
  default: 'blocked',
  profiles: { blocked: { host: 'other.example' } },
}), 'utf8')
const guarded = mount(guardedDir, { allowedHosts: ['allowed.example'], allowWrite: false })
const blockedStatus = await guarded.call('thin_ssh_status', {})
ok('allowedHosts rejects an unknown host', !blockedStatus.ok && String(blockedStatus.message).includes('not in allowedHosts'), String(blockedStatus.message))
const writesBefore = guarded.calls.length
const refusedWrite = await guarded.call('thin_ssh_write_file', { path: 'x', content: 'x' })
ok('allowWrite=false refuses before spawning ssh', !refusedWrite.ok && guarded.calls.length === writesBefore)

const disabled = mount(mkdtempSync(join(tmpdir(), 'dsh-thin-ssh-disabled-')), { enabled: false })
ok('enabled=false registers no tools', disabled.tools.size === 0)

process.stdout.write(`\n${String(checks)} checks, ${String(failures.length)} failures\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  process.exitCode = 1
}
