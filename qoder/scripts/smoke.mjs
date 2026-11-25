import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, '.qoder-plugin', 'plugin.json'), 'utf8'))
const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
assert.equal(manifest.name, 'qoder-thin-ssh')
assert.equal(manifest.version, '0.1.0')
assert.equal(mcp.mcpServers['qoder-thin-ssh'].command, '${QODER_NODE_RUNTIME}')
assert.deepEqual(mcp.mcpServers['qoder-thin-ssh'].args, ['${QODER_PLUGIN_ROOT}/server.mjs'])

const stateDir = mkdtempSync(join(tmpdir(), 'qoder-thin-ssh-'))
const child = spawn(process.env.MCP_NODE_EXECUTABLE ?? process.execPath, [join(root, 'server.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    THIN_SSH_STATE_DIR: stateDir,
    THIN_SSH_SSH_PATH: '__qoder_thin_ssh_missing_executable__',
    THIN_SSH_DEFAULT_TIMEOUT_MS: '1000',
    THIN_SSH_CONNECT_TIMEOUT_SEC: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr += chunk })
let buffer = ''
let nextId = 1
const pending = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (waiter === undefined) continue
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error !== undefined) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`))
    else waiter.resolve(message.result)
  }
})
child.on('error', (error) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
  pending.clear()
})
child.on('exit', (code) => {
  if (code !== 0) process.stderr.write(`MCP server exited with ${code}: ${stderr}\n`)
})

function request(method, params = {}) {
  const id = nextId++
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`Timed out waiting for ${method}`))
    }, 5_000)
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function call(name, args = {}) {
  return request('tools/call', { name, arguments: args })
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'qoder-thin-ssh-smoke', version: '0.1.0' },
  })
  assert.equal(initialized.protocolVersion, '2025-11-25')
  assert.equal(initialized.serverInfo.name, 'qoder-thin-ssh')
  assert.match(initialized.instructions, /thin_ssh_status/)

  const listed = await request('tools/list')
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    'thin_ssh_status',
    'thin_ssh_profile',
    'thin_ssh_exec',
    'thin_ssh_read_file',
    'thin_ssh_write_file',
    'thin_ssh_list',
  ])

  const emptyStatus = await call('thin_ssh_status')
  assert.equal(emptyStatus.isError, undefined)
  assert.deepEqual(emptyStatus.structuredContent.profiles, [])

  const added = await call('thin_ssh_profile', {
    action: 'add',
    name: 'smoke',
    host: 'example.invalid',
    user: 'deploy',
  })
  assert.equal(added.structuredContent.ok, true)
  assert.equal(added.structuredContent.defaultProfile, 'smoke')

  const status = await call('thin_ssh_status')
  assert.equal(status.structuredContent.activeProfile, 'smoke')

  const profiles = await call('thin_ssh_profile', { action: 'list' })
  assert.match(profiles.structuredContent.message, /deploy@example.invalid/)

  const rejectedSecret = await call('thin_ssh_profile', {
    action: 'update',
    name: 'smoke',
    password: 'must-not-be-stored',
  })
  assert.equal(rejectedSecret.isError, true)
  assert.match(rejectedSecret.content[0].text, /not allowed/)
  assert.doesNotMatch(readFileSync(join(stateDir, 'profiles.json'), 'utf8'), /must-not-be-stored/)

  const invalidExec = await call('thin_ssh_exec', {})
  assert.equal(invalidExec.isError, true)
  assert.match(invalidExec.content[0].text, /command is required/)

  const unreachable = await call('thin_ssh_status', { check: true })
  assert.equal(unreachable.structuredContent.ok, true)
  assert.equal(unreachable.structuredContent.reachable, false)
  assert.match(unreachable.structuredContent.message, /connection failed/)

  const invalidMode = await call('thin_ssh_write_file', { path: '/tmp/x', content: 'x', mode: '999' })
  assert.equal(invalidMode.isError, true)
  assert.match(invalidMode.content[0].text, /invalid format/)

  const removed = await call('thin_ssh_profile', { action: 'remove', name: 'smoke' })
  assert.equal(removed.structuredContent.ok, true)
  assert.deepEqual(removed.structuredContent.profiles, [])

  process.stdout.write('MCP smoke test passed: manifest, initialize, six tools, profile persistence, validation, and spawn-failure handling.\n')
} finally {
  child.stdin.end()
  await new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise()
    child.once('exit', resolvePromise)
  })
  rmSync(stateDir, { recursive: true, force: true })
}
