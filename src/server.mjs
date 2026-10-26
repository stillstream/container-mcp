import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, stat, mkdir, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const HOST = process.env.CONTAINER_MCP_HOST || '127.0.0.1'
const PORT = Number(process.env.CONTAINER_MCP_PORT || 18878)
const MCP_PATH = '/mcp'
const TOKEN_FILE = process.env.CONTAINER_MCP_TOKEN_FILE || '/opt/container-mcp/runtime/access-token'
const MAX_ACTIVE_TASKS = 32
const MAX_RECORDED_TASKS = 128
const MAX_CAPTURE_BYTES_PER_STREAM = 1024 * 1024
const DEFAULT_RESPONSE_BYTES = 16 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const TASK_TTL_MS = 2 * 60 * 60 * 1000
const tasks = new Map()
let stopping = false

await mkdir(resolve(TOKEN_FILE, '..'), { recursive: true })

async function ensureToken() {
  if (!existsSync(TOKEN_FILE)) {
    const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
    await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600, flag: 'wx' })
  }
  await chmod(TOKEN_FILE, 0o600)
  const token = (await readFile(TOKEN_FILE, 'utf8')).trim()
  if (token.length < 32) throw new Error('access token file must contain at least 32 characters')
  return token
}
const ACCESS_TOKEN = await ensureToken()

async function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  console.error(line)
}
function response(value, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(value) }] }
}
function running(task) { return task.exitCode === null && !task.closed }
function activeCount() { return [...tasks.values()].filter(running).length }
function groupExists(pid) {
  try { process.kill(-pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
function signalGroup(task, signal) {
  if (!Number.isInteger(task.pid) || task.pid <= 0) return false
  try { process.kill(-task.pid, signal); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
function capture(task, key, chunk) {
  const bufferKey = `${key}Buffer`
  const droppedKey = `${key}Dropped`
  const old = task[bufferKey]
  let next = Buffer.concat([old, chunk])
  if (next.length > MAX_CAPTURE_BYTES_PER_STREAM) {
    const drop = next.length - MAX_CAPTURE_BYTES_PER_STREAM
    next = next.subarray(drop)
    task[droppedKey] += drop
  }
  task[bufferKey] = next
  task[`${key}Total`] += chunk.length
}
function takeOutput(task, maxBytes, advance = true) {
  let truncated = false
  const budgetPerStream = Math.floor(maxBytes / 2)
  const read = (key, budget) => {
    const buffer = task[`${key}Buffer`]
    const total = task[`${key}Total`]
    const base = total - buffer.length
    let cursor = task[`${key}Cursor`]
    if (cursor < base) { cursor = base; truncated = true }
    const start = Math.max(0, cursor - base)
    const data = buffer.subarray(start, Math.min(buffer.length, start + budget))
    const more = start + data.length < buffer.length
    if (more) truncated = true
    if (advance) task[`${key}Cursor`] = cursor + data.length
    return { text: data.toString('utf8'), more }
  }
  const stdout = read('stdout', budgetPerStream)
  const stderr = read('stderr', budgetPerStream)
  return { stdout: stdout.text, stderr: stderr.text, truncated, has_more: stdout.more || stderr.more }
}
function cleanOldTasks() {
  const now = Date.now()
  for (const [id, task] of tasks) {
    if (!running(task) && task.closedAt && now - task.closedAt > TASK_TTL_MS) tasks.delete(id)
  }
  if (tasks.size < MAX_RECORDED_TASKS) return
  for (const [id, task] of tasks) {
    if (!running(task)) tasks.delete(id)
    if (tasks.size < MAX_RECORDED_TASKS) break
  }
}
function publicTask(task, maxBytes, advance = true) {
  const output = takeOutput(task, maxBytes, advance)
  const isRunning = running(task)
  return {
    status: isRunning ? 'running' : task.stopRequested ? 'stopped' : 'completed',
    exit_code: task.exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
    truncated: output.truncated,
    has_more: output.has_more,
    ...(isRunning || output.has_more ? { task_id: task.id } : {}),
  }
}
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

const toolDefinitions = []
function registerTool(name, config, handler) {
  toolDefinitions.push([name, config, handler])
}

registerTool('container_exec', {
  title: 'Execute container shell command',
  description: 'Execute an arbitrary shell command inside dlvins-dev as the service user (currently root). This tool can create, overwrite, move, or delete files, modify system configuration, and run any installed program; it has full container-wide write and potentially destructive capability and is NOT read-only. No project-path whitelist is applied; actual access is limited only by container Linux permissions and mounted read-only filesystems. Provide an absolute existing directory as cwd. Commands exceeding wait_ms continue in their own process group and return task_id.',
  inputSchema: {
    command: z.string().min(1).max(100_000).describe('Arbitrary shell command/script/program invocation. May modify or delete data and system files.'),
    cwd: z.string().min(1).refine(isAbsolute, 'cwd must be an absolute path').describe('Absolute existing directory inside the container; there is no project-directory allowlist.'),
    wait_ms: z.number().int().min(0).max(5000).default(1500).describe('Maximum time to wait before returning; 0–5000 milliseconds. Longer commands continue in the background.'),
  },
}, async ({ command, cwd, wait_ms = 1500 }) => {
  if (stopping) return response({ status: 'error', message: 'service is shutting down' }, true)
  cleanOldTasks()
  if (activeCount() >= MAX_ACTIVE_TASKS) return response({ status: 'error', message: `active task limit reached (${MAX_ACTIVE_TASKS})` }, true)
  const absoluteCwd = resolve(cwd)
  let info
  try { info = await stat(absoluteCwd) } catch { return response({ status: 'error', message: 'cwd does not exist or is not accessible' }, true) }
  if (!info.isDirectory()) return response({ status: 'error', message: 'cwd must be an existing directory' }, true)
  const id = randomUUID()
  const task = {
    id, pid: null, commandBytes: Buffer.byteLength(command), cwd: absoluteCwd,
    stdoutBuffer: Buffer.alloc(0), stderrBuffer: Buffer.alloc(0),
    stdoutTotal: 0, stderrTotal: 0, stdoutDropped: 0, stderrDropped: 0,
    stdoutCursor: 0, stderrCursor: 0, exitCode: null, signal: null,
    closed: false, closedAt: null, stopRequested: false,
  }
  tasks.set(id, task)
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    cwd: absoluteCwd,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  task.pid = child.pid
  child.stdout.on('data', (chunk) => capture(task, 'stdout', chunk))
  child.stderr.on('data', (chunk) => capture(task, 'stderr', chunk))
  task.closedPromise = new Promise((resolveClose) => {
    child.once('error', (error) => {
      task.spawnError = error.message
      task.exitCode = 127
      task.closed = true
      task.closedAt = Date.now()
      resolveClose()
    })
    child.once('close', (code, signal) => {
      if (!task.closed) {
        task.exitCode = Number.isInteger(code) ? code : 128 + (signal ? ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 }[signal] || 0) : 0)
        task.signal = signal || null
        task.closed = true
        task.closedAt = Date.now()
      }
      resolveClose()
    })
  })
  await log(`task_started id=${id} uid=${process.getuid?.() ?? 'unknown'} cwd=${absoluteCwd} command_bytes=${task.commandBytes}`)
  if (wait_ms > 0) await Promise.race([task.closedPromise, delay(wait_ms)])
  const result = publicTask(task, DEFAULT_RESPONSE_BYTES)
  if (task.spawnError) result.stderr = `${result.stderr}${result.stderr ? '\n' : ''}spawn error: ${task.spawnError}`
  if (!running(task)) await log(`task_finished id=${id} exit_code=${task.exitCode}`)
  return response(result)
})

registerTool('container_poll', {
  title: 'Poll container command task',
  description: 'Return newly captured stdout/stderr and current state for a task started by container_exec on this service. Each poll advances that task’s output cursor. A response is capped at max_output_bytes total; truncated=true means earlier retained output was dropped or more output remains for a later poll. Completed task records are in-memory only and expire after two hours.',
  inputSchema: {
    task_id: z.string().uuid().describe('Task ID returned by container_exec.'),
    max_output_bytes: z.number().int().min(1024).max(MAX_RESPONSE_BYTES).default(DEFAULT_RESPONSE_BYTES).describe('Maximum combined stdout and stderr bytes in this response, from 1024 through 65536.'),
  },
}, async ({ task_id, max_output_bytes = DEFAULT_RESPONSE_BYTES }) => {
  const task = tasks.get(task_id)
  if (!task) return response({ status: 'not_found', task_id, message: 'unknown, expired, or service-restarted task id' }, true)
  const result = publicTask(task, max_output_bytes)
  if (task.spawnError && result.stderr) result.stderr += `\nspawn error: ${task.spawnError}`
  return response({ task_id, ...result })
})

registerTool('container_stop', {
  title: 'Stop container command task',
  description: 'Stop only the process group created and owned by this container-mcp service for the supplied task_id. Sends SIGTERM, then SIGKILL after a short grace period if that same process group remains. It does not search for or kill unrelated container processes. This is a state-changing operation.',
  inputSchema: {
    task_id: z.string().uuid().describe('Task ID returned by container_exec; only service-owned tasks can be stopped.'),
  },
}, async ({ task_id }) => {
  const task = tasks.get(task_id)
  if (!task) return response({ status: 'not_found', task_id, message: 'unknown, expired, or service-restarted task id' }, true)
  if (!running(task)) return response({ status: task.stopRequested ? 'stopped' : 'completed', task_id, exit_code: task.exitCode, message: 'task is not running' })
  task.stopRequested = true
  await log(`task_stop_requested id=${task.id}`)
  try { signalGroup(task, 'SIGTERM') } catch (error) { return response({ status: 'error', task_id, message: `failed to signal owned process group: ${error.message}` }, true) }
  await Promise.race([task.closedPromise, delay(1500)])
  // The shell leader may exit while descendants still occupy its isolated process group.
  if (groupExists(task.pid)) {
    try { signalGroup(task, 'SIGKILL') } catch {}
    await Promise.race([task.closedPromise, delay(1500)])
  }
  const result = publicTask(task, DEFAULT_RESPONSE_BYTES)
  if (running(task)) result.message = 'termination requested; process group has not closed yet'
  await log(`task_stop_finished id=${task.id} status=${result.status} exit_code=${task.exitCode}`)
  return response({ task_id, ...result })
})

const tokenEqual = (request) => {
  const header = request.headers.authorization || ''
  const provided = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(ACCESS_TOKEN)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

const httpServer = createServer(async (request, res) => {
  const path = request.url?.split('?')[0]
  if (request.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, service: 'container-mcp', uid: process.getuid?.() ?? null }))
    return
  }
  if (path !== MCP_PATH) { res.writeHead(404).end('not found'); return }
  if (!tokenEqual(request)) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('unauthorized'); return }
  if (!['POST', 'GET', 'DELETE'].includes(request.method || '')) { res.writeHead(405).end('method not allowed'); return }
  const requestServer = new McpServer({ name: 'container-mcp', version: '0.1.0' }, { capabilities: { tools: {} } })
  // Tools are registered once per transport instance; handlers close over the process-wide task table.
  for (const [name, config, handler] of toolDefinitions) requestServer.registerTool(name, config, handler)
  const transport = new StreamableHTTPServerTransport({})
  res.on('close', () => { void transport.close(); void requestServer.close() })
  try {
    await requestServer.connect(transport)
    await transport.handleRequest(request, res)
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    if (!res.writableEnded) res.end('MCP request failed')
    await log(`mcp_request_error ${error?.name || 'Error'}`)
  }
})

httpServer.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
httpServer.listen(PORT, HOST, () => {
  void log(`service_ready host=${HOST} port=${PORT} uid=${process.getuid?.() ?? 'unknown'} gid=${process.getgid?.() ?? 'unknown'} tools=container_exec,container_poll,container_stop`)
})

async function shutdown(signal) {
  if (stopping) return
  stopping = true
  await log(`service_shutdown signal=${signal} active_tasks=${activeCount()}`)
  for (const task of tasks.values()) {
    if (running(task)) {
      task.stopRequested = true
      try { signalGroup(task, 'SIGTERM') } catch {}
    }
  }
  await Promise.race([Promise.all([...tasks.values()].filter(running).map((task) => task.closedPromise)), delay(2000)])
  for (const task of tasks.values()) if (task.pid && groupExists(task.pid)) { try { signalGroup(task, 'SIGKILL') } catch {} }
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
