import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { resolveConfig } from '../lib/config.mjs'
import { createThinSshService } from '../lib/service.mjs'
import { ProfileStore } from '../lib/store.mjs'

function fakeChild({ stdout = '', stderr = '', code = 0, error = '', hang = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => {
    queueMicrotask(() => child.emit('close', null))
    return true
  }
  queueMicrotask(() => {
    if (error !== '') {
      child.emit('error', new Error(error))
      return
    }
    if (hang) return
    if (stdout !== '') child.stdout.write(stdout)
    if (stderr !== '') child.stderr.write(stderr)
    child.emit('close', code)
  })
  return child
}

function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-thin-ssh-service-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new ProfileStore(join(directory, 'profiles.json'))
  store.upsert('test', {
    host: 'example.invalid',
    user: 'deploy',
    port: 2222,
    identityFile: '~/.ssh/id_ed25519',
    cwd: '/srv/app',
  })
  const calls = []
  const spawn = options.spawnFn ?? ((command, args) => options.child ?? fakeChild(options))
  const callTool = createThinSshService({
    config: resolveConfig({ defaultTimeoutMs: 100, maxOutputBytes: 65_536, ...options.config }),
    store,
    spawnFn(command, args) {
      calls.push({ command, args })
      if (options.spawnError !== undefined) throw new Error(options.spawnError)
      return spawn(command, args)
    },
  })
  return { callTool, calls, store }
}

test('exec uses argv without a local shell and preserves remote exit codes', async (t) => {
  const { callTool, calls } = setup(t, { stdout: 'done\n', code: 7 })
  const result = await callTool('thin_ssh_exec', { command: 'printf done' })
  assert.equal(result.structuredContent.ok, false)
  assert.equal(result.structuredContent.exitCode, 7)
  assert.equal(result.structuredContent.stdout, 'done\n')
  assert.equal(calls[0].command, 'ssh')
  assert.deepEqual(calls[0].args.slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'])
  assert.ok(calls[0].args.includes('-p'))
  assert.ok(calls[0].args.includes('2222'))
  assert.ok(calls[0].args.includes('--'))
  assert.equal(calls[0].args.at(-2), 'example.invalid')
  assert.equal(calls[0].args.at(-1), "cd '/srv/app' && printf done")
})

test('read quotes remote paths and returns UTF-8 text', async (t) => {
  const { callTool, calls } = setup(t, { stdout: '第一行\nsecond\n' })
  const result = await callTool('thin_ssh_read_file', { path: "/tmp/a'b.txt", offset: 1, limit: 1 })
  assert.equal(result.structuredContent.ok, true)
  assert.equal(result.structuredContent.stdout, '第一行\nsecond\n')
  assert.equal(calls[0].args.at(-1), "cd '/srv/app' && tail -n +1 '/tmp/a'\\''b.txt' | head -n 1")
})

test('write transfers exact UTF-8 content in base64 chunks and applies mode', async (t) => {
  const content = '你好 "quoted"\n'.repeat(4_000)
  const calls = []
  const { callTool } = setup(t, {
    spawnFn(command, args) {
      calls.push(args.at(-1))
      return fakeChild()
    },
  })
  const result = await callTool('thin_ssh_write_file', { path: '/tmp/a b.txt', content, mode: '0644' })
  assert.equal(result.structuredContent.ok, true)
  assert.equal(result.structuredContent.bytes, Buffer.byteLength(content))
  assert.ok(calls.length > 1)
  const encoded = calls.map((command) => {
    const match = command.match(/printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d/)
    assert.ok(match)
    return match[1]
  }).join('')
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), content)
  assert.match(calls[0], /mkdir -p '\/tmp'/)
  assert.match(calls.at(-1), /chmod 0644 '\/tmp\/a b\.txt'$/)
})

test('list supports short and long remote directory output', async (t) => {
  const { callTool, calls } = setup(t, { stdout: 'a.txt\n' })
  const short = await callTool('thin_ssh_list', {})
  assert.equal(short.structuredContent.ok, true)
  assert.match(calls[0].args.at(-1), /ls -1 "\$HOME"$/)
  const long = await callTool('thin_ssh_list', { path: '~/deploy', long: true })
  assert.equal(long.structuredContent.ok, true)
  assert.match(calls[1].args.at(-1), /ls -la "\$HOME\/"'deploy'$/)
})

test('allowWrite=false refuses file writes before spawning ssh', async (t) => {
  const { callTool, calls } = setup(t, { config: { allowWrite: false } })
  const result = await callTool('thin_ssh_write_file', { path: '/tmp/x', content: 'x' })
  assert.equal(result.structuredContent.ok, false)
  assert.match(result.structuredContent.error, /allowWrite=false/)
  assert.equal(calls.length, 0)
})

test('allowedHosts rejects profile creation and remote calls', async (t) => {
  const { callTool, calls, store } = setup(t, { config: { allowedHosts: ['prod.example'] } })
  const add = await callTool('thin_ssh_profile', { action: 'add', name: 'other', host: 'other.example' })
  assert.equal(add.structuredContent.ok, false)
  assert.match(add.structuredContent.message, /not in allowedHosts/)
  store.upsert('prod', { host: 'prod.example', user: 'deploy' })
  const exec = await callTool('thin_ssh_exec', { profile: 'test', command: 'true' })
  assert.equal(exec.structuredContent.ok, false)
  assert.match(exec.structuredContent.error, /not in allowedHosts/)
  assert.equal(calls.length, 0)
})

test('extraArgs permits ProxyJump but rejects local command execution options', async (t) => {
  const { callTool, calls } = setup(t)
  const safe = await callTool('thin_ssh_profile', {
    action: 'update', name: 'test', extraArgs: ['-o', 'ProxyJump=bastion', '-o', 'StrictHostKeyChecking=accept-new'],
  })
  assert.equal(safe.structuredContent.ok, true)
  const unsafe = await callTool('thin_ssh_profile', {
    action: 'update', name: 'test', extraArgs: ['-o', 'ProxyCommand=touch /tmp/pwned'],
  })
  assert.equal(unsafe.structuredContent.ok, false)
  assert.match(unsafe.structuredContent.message, /extraArgs supports only/)
  await callTool('thin_ssh_exec', { command: 'true' })
  assert.ok(calls[0].args.includes('ProxyJump=bastion'))
  assert.ok(!calls[0].args.some((argument) => argument.includes('ProxyCommand')))
})

test('timeout terminates the local ssh child and reports failure', async (t) => {
  const { callTool } = setup(t, { hang: true })
  const result = await callTool('thin_ssh_exec', { command: 'sleep 10', timeoutMs: 10 })
  assert.equal(result.structuredContent.ok, false)
  assert.equal(result.structuredContent.exitCode, -1)
  assert.match(result.structuredContent.error, /timed out after 10ms/)
})

test('cancellation terminates the local ssh child', async (t) => {
  const { callTool } = setup(t, { hang: true })
  const controller = new AbortController()
  const pending = callTool('thin_ssh_exec', { command: 'sleep 10' }, controller.signal)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  controller.abort()
  const result = await pending
  assert.equal(result.structuredContent.ok, false)
  assert.match(result.structuredContent.error, /cancelled/)
})

test('output cap truncates output and stops ssh', async (t) => {
  const { callTool } = setup(t, { stdout: '123456789', config: { maxOutputBytes: 4 } })
  const result = await callTool('thin_ssh_exec', { command: 'yes' })
  assert.equal(result.structuredContent.ok, false)
  assert.equal(result.structuredContent.stdout, '1234')
  assert.equal(result.structuredContent.truncated, true)
  assert.match(result.structuredContent.error, /output exceeded the 4-byte cap/)
})

test('spawn failures become structured tool errors', async (t) => {
  const { callTool } = setup(t, { spawnError: 'missing ssh' })
  const result = await callTool('thin_ssh_exec', { command: 'true' })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.exitCode, -1)
  assert.match(result.structuredContent.error, /local ssh failed to start: Error: missing ssh/)
})
