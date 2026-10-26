import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = process.env.CONTAINER_MCP_URL || 'http://127.0.0.1:18878/mcp'
const tokenFile = process.env.CONTAINER_MCP_TOKEN_FILE || '/opt/container-mcp/runtime/access-token'
const token = (await readFile(tokenFile, 'utf8')).trim()
const client = new Client({ name: 'container-mcp-smoke', version: '0.1.0' }, { capabilities: {} })
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

await client.connect(transport)
const tools = await client.listTools()
const expected = ['container_exec', 'container_poll', 'container_stop']
assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...expected].sort())
for (const name of expected) {
  const tool = tools.tools.find((candidate) => candidate.name === name)
  assert.ok(tool.description?.length > 20, `${name} must include a full description`)
  assert.ok(tool.inputSchema?.properties, `${name} must publish an input schema`)
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args })
  assert.equal(result.isError, false, `${name} call failed: ${JSON.stringify(result)}`)
  const text = result.content?.find((item) => item.type === 'text')?.text
  assert.ok(text, `${name} returned no text result`)
  return JSON.parse(text)
}
async function exec(command, cwd, wait_ms = 3000) {
  return call('container_exec', { command, cwd, wait_ms })
}

try {
  const temp = await exec('mktemp -d /tmp/container-mcp-acceptance.XXXXXX', '/tmp')
  assert.equal(temp.exit_code, 0)
  const testDir = temp.stdout.trim()
  assert.ok(testDir.startsWith('/tmp/container-mcp-acceptance.'), 'test dir must be a fresh /tmp directory')
  console.log(`TEST_DIR=${testDir}`)

  const identity = await exec('printf "hostname="; hostname; printf "uid="; id; printf "cwd="; pwd', testDir)
  assert.equal(identity.exit_code, 0)
  assert.match(identity.stdout, /hostname=.+\nuid=uid=0\(root\)/)
  assert.match(identity.stdout, new RegExp(`cwd=${testDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  console.log(`IDENTITY=${identity.stdout.trim().replaceAll('\n', ' | ')}`)

  const file = `${testDir}/probe.txt`
  let result = await exec("printf '%s\\n' 'first-value' > probe.txt", testDir)
  assert.equal(result.exit_code, 0)
  result = await exec('cat probe.txt', testDir)
  assert.equal(result.stdout, 'first-value\n')
  result = await exec("sed -i 's/first-value/edited-value/' probe.txt && cat probe.txt", testDir)
  assert.equal(result.stdout, 'edited-value\n')
  result = await exec('rm probe.txt && if test ! -e probe.txt; then echo absent; else exit 9; fi', testDir)
  assert.equal(result.stdout.trim(), 'absent')
  assert.equal(result.exit_code, 0)
  console.log('FILE_CRUD=created/read/edited/read/deleted/not-present')

  result = await exec("printf 'stdout-marker\\n'; printf 'stderr-marker\\n' >&2; exit 7", testDir)
  assert.equal(result.exit_code, 7)
  assert.equal(result.stdout, 'stdout-marker\n')
  assert.equal(result.stderr, 'stderr-marker\n')
  console.log(`STDERR_EXIT=stdout:${result.stdout.trim()}, stderr:${result.stderr.trim()}, exit:${result.exit_code}`)

  result = await exec("printf 'before-poll\\n'; sleep 0.6; printf 'after-poll\\n'; sleep 60", testDir, 150)
  assert.equal(result.status, 'running')
  assert.ok(result.task_id, 'long command must return a task_id')
  const taskId = result.task_id
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 800))
  const polled = await call('container_poll', { task_id: taskId })
  assert.ok(polled.stdout.includes('after-poll'), `poll must return new stdout: ${JSON.stringify(polled)}`)
  assert.equal(polled.status, 'running')
  const stopped = await call('container_stop', { task_id: taskId })
  assert.equal(stopped.status, 'stopped', JSON.stringify(stopped))
  assert.ok(stopped.exit_code !== null)
  console.log(`BACKGROUND_TASK=started:${taskId}, poll:received-new-output, stopped:${stopped.status}, exit:${stopped.exit_code}`)

  if (process.env.SKIP_OPENCODE !== '1') {
    // Use the existing local model endpoint/model ID through a one-run config;
    // do not open or change the DL-VINS repository config. All files stay in /tmp.
    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      model: 'dlvins-vllm/Qwen3.8-27B-NVFP4-RTX5090',
      provider: {
        'dlvins-vllm': {
          npm: '@ai-sdk/openai-compatible',
          name: 'DL-VINS Local vLLM',
          options: { baseURL: 'http://127.0.0.1:18000/v1', apiKey: 'local-no-auth' },
          models: {
            'Qwen3.8-27B-NVFP4-RTX5090': {
              name: 'Qwen3.8 27B NVFP4 (local, tool-enabled)',
              tool_call: true,
              reasoning: true,
              limit: { context: 262144, output: 8192 },
              modalities: { input: ['text'], output: ['text'] },
            },
          },
        },
      },
    }
    const configJson = JSON.stringify(opencodeConfig)
    const quotedConfig = `'${configJson.replaceAll("'", "'\\''")}'`
    const prompt = 'In this temporary directory only, create hello.py that prints exactly "hello from opencode", run it with python3, and report the real stdout. Do not inspect or access any project repository.'
    const openCodeCommand = `mkdir -p opencode-smoke && cd opencode-smoke && OPENCODE_CONFIG_CONTENT=${quotedConfig} opencode run --auto --model dlvins-vllm/Qwen3.8-27B-NVFP4-RTX5090 ${JSON.stringify(prompt)}`
    const opencode = await exec(openCodeCommand, testDir, 5000)
    let opencodeResult = opencode
    if (opencode.status === 'running') {
      const task = opencode.task_id
      assert.ok(task, 'OpenCode smoke must return a task id if it exceeds the wait')
      const chunks = [opencode.stdout, opencode.stderr]
      for (let attempt = 0; attempt < 45; attempt++) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
        const next = await call('container_poll', { task_id: task, max_output_bytes: 65536 })
        chunks.push(next.stdout, next.stderr)
        if (next.status !== 'running' && !next.has_more) {
          opencodeResult = { status: next.status, exit_code: next.exit_code, stdout: chunks.filter((_, i) => i % 2 === 0).join(''), stderr: chunks.filter((_, i) => i % 2 === 1).join('') }
          break
        }
      }
      if (opencodeResult.status === 'running') await call('container_stop', { task_id: task })
    }
    assert.equal(opencodeResult.status, 'completed', `OpenCode run did not finish: ${JSON.stringify(opencodeResult)}`)
    assert.equal(opencodeResult.exit_code, 0, `OpenCode failed: ${opencodeResult.stderr}`)
    const actual = await exec('python3 hello.py', `${testDir}/opencode-smoke`)
    assert.equal(actual.exit_code, 0)
    assert.equal(actual.stdout.trim(), 'hello from opencode')
    console.log(`OPENCODE=exit:${opencodeResult.exit_code}, hello.py stdout:${actual.stdout.trim()}`)
  } else {
    console.log('OPENCODE=skipped for offline candidate-image validation')
  }

  const cleanup = await exec(`rm -rf -- '${testDir}' && test ! -e '${testDir}' && echo removed`, '/tmp')
  assert.equal(cleanup.exit_code, 0)
  assert.equal(cleanup.stdout.trim(), 'removed')
  console.log('CLEANUP=temporary /tmp tree removed')
  console.log('ALL_TESTS_PASSED')
} finally {
  await client.close().catch(() => {})
}
