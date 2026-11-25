import { configFromEnv, resolveStorePath } from './lib/config.mjs'
import { ProfileStore } from './lib/store.mjs'
import { createThinSshService, tools, USAGE_TEXT } from './lib/service.mjs'

const protocolVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
const maxLineBytes = 16 * 1024 * 1024
const activeCalls = new Map()

let config
try {
  config = configFromEnv()
} catch (error) {
  process.stderr.write(`[qoder-thin-ssh] invalid configuration: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const store = new ProfileStore(resolveStorePath(config))
const callTool = createThinSshService({ config, store })
const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const callKey = (id) => `${typeof id}:${String(id)}`

function invalidRequest(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function dispatch(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return invalidRequest(null, -32600, 'Invalid request')
  }
  const { id, method, params = {} } = request
  if (id === undefined) {
    if (method === 'notifications/cancelled' && params !== null && typeof params === 'object') {
      activeCalls.get(callKey(params.requestId))?.abort()
    }
    return undefined
  }
  if (typeof id !== 'string' && typeof id !== 'number') return invalidRequest(null, -32600, 'Invalid request identifier')
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return invalidRequest(id, -32602, 'Parameters must be an object')
  }
  const fail = (code, message) => invalidRequest(id, code, message)

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: protocolVersions.has(params.protocolVersion) ? params.protocolVersion : '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'qoder-thin-ssh', version: '0.1.0' },
          instructions: USAGE_TEXT,
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools } }
    case 'tools/call': {
      if (typeof params.name !== 'string') return fail(-32602, 'Tool name must be a string')
      const args = params.arguments ?? {}
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail(-32602, 'Tool arguments must be an object')
      const controller = new AbortController()
      activeCalls.set(callKey(id), controller)
      try {
        const result = await callTool(params.name, args, controller.signal)
        return { jsonrpc: '2.0', id, result }
      } finally {
        activeCalls.delete(callKey(id))
      }
    }
    default:
      return fail(-32601, 'Method not supported')
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  let end
  while ((end = buffer.indexOf(10)) !== -1) {
    const line = buffer.subarray(0, end)
    buffer = buffer.subarray(end + 1)
    if (line.length > maxLineBytes) {
      process.stderr.write('Request exceeds the 16 MiB protocol budget\n')
      process.exit(1)
    }
    if (!line.toString('utf8').trim()) continue
    let request
    try {
      request = JSON.parse(line.toString('utf8'))
    } catch {
      reply(invalidRequest(null, -32700, 'Invalid JSON'))
      continue
    }
    dispatch(request)
      .then((response) => {
        if (response !== undefined) reply(response)
      })
      .catch((error) => {
        const id = request !== null && typeof request === 'object' ? request.id : null
        reply(invalidRequest(typeof id === 'string' || typeof id === 'number' ? id : null, -32603, error instanceof Error ? error.message : String(error)))
      })
  }
  if (buffer.length > maxLineBytes) {
    process.stderr.write('Request exceeds the 16 MiB protocol budget\n')
    process.exit(1)
  }
})

process.stdin.on('end', () => {
  for (const controller of activeCalls.values()) controller.abort()
  process.exit(0)
})
