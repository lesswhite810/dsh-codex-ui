import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, RequestBodyTooLargeError, readRequestBody } from '../src/index.ts'
import { readHostWorkspacePreferences, writeHostWorkspacePreferences } from '../src/client/pinned-workspaces.ts'
import {
  MAX_PINNED_WORKSPACE_IDS,
  MAX_WORKSPACE_ID_LENGTH,
  parsePinnedWorkspaceIds,
  readWorkspacePreferences,
  WORKSPACE_PREFERENCES_FILE,
  writeWorkspacePreferences,
} from '../src/workspace-preferences.ts'

const directory = await mkdtemp(join(tmpdir(), 'dcu-workspace-preferences-'))
const path = join(directory, WORKSPACE_PREFERENCES_FILE)
const legacyGroupField = ['workspace', 'Groups'].join('')

try {
  assert.deepEqual(await readWorkspacePreferences(path), { version: 2, pinnedWorkspaceIds: [], exists: false })
  assert.deepEqual(parsePinnedWorkspaceIds(['a', 'a', 'b']), ['a', 'b'])
  assert.equal(parsePinnedWorkspaceIds(Array.from({ length: MAX_PINNED_WORKSPACE_IDS + 1 }, (_, index) => String(index))), undefined)
  assert.equal(parsePinnedWorkspaceIds(['x'.repeat(MAX_WORKSPACE_ID_LENGTH + 1)]), undefined)

  await writeWorkspacePreferences(['a', 'a', 'b'], path)
  assert.deepEqual(await readWorkspacePreferences(path), { version: 2, pinnedWorkspaceIds: ['a', 'b'], exists: true })

  await Promise.all([
    writeWorkspacePreferences(['first'], path),
    writeWorkspacePreferences(['second'], path),
  ])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 2, pinnedWorkspaceIds: ['second'] })

  await writeFile(path, JSON.stringify({ version: 1, pinnedWorkspaceIds: ['legacy'] }), 'utf8')
  assert.deepEqual(await readWorkspacePreferences(path), { version: 2, pinnedWorkspaceIds: ['legacy'], exists: true })

  // 旧版磁盘文件残留的分组字段必须在读取时忽略，且下次保存后被彻底替换。
  await writeFile(path, JSON.stringify({ version: 2, pinnedWorkspaceIds: ['keep'], [legacyGroupField]: [{ id: 'stale', title: '旧分组', workspaceIds: ['keep'] }] }), 'utf8')
  assert.deepEqual(await readWorkspacePreferences(path), { version: 2, pinnedWorkspaceIds: ['keep'], exists: true })
  await writeWorkspacePreferences(['keep'], path)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 2, pinnedWorkspaceIds: ['keep'] })

  assert.deepEqual(
    await readHostWorkspacePreferences(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: ['a', 'a', 'b'] }))),
    { exists: true, pinnedWorkspaceIds: ['a', 'b'] },
  )
  await writeHostWorkspacePreferences(['a', 'a', 'b'], async (input, init) => {
    assert.equal(input, '/api/dsh-codex-ui/preferences')
    assert.equal(init?.method, 'PUT')
    assert.deepEqual(JSON.parse(String(init?.body)), { pinnedWorkspaceIds: ['a', 'b'] })
    return new Response('{}')
  })

  await writeFile(path, '{broken', 'utf8')
  await assert.rejects(readWorkspacePreferences(path), SyntaxError)
} finally {
  await rm(directory, { recursive: true, force: true })
}

const request = (chunks: Array<string | Uint8Array>, headers: Record<string, string> = {}) => ({
  headers: { origin: 'http://localhost:3080', host: 'localhost:3080', 'sec-fetch-site': 'same-origin', ...headers },
  socket: { remoteAddress: '127.0.0.1' },
  async *[Symbol.asyncIterator](): AsyncGenerator<string | Uint8Array> {
    for (const chunk of chunks) yield chunk
  },
})

assert.equal(await readRequestBody(request(['{"a":', '1}']), 16), '{"a":1}')
await assert.rejects(readRequestBody(request([], { 'content-length': '17' }), 16), RequestBodyTooLargeError)
await assert.rejects(readRequestBody(request(['12345678', '901234567']), 16), RequestBodyTooLargeError)

type Route = { path: string; handler: (req: ReturnType<typeof request> & { method?: string; url?: string }, response: ResponseRecorder) => Promise<void> }
type ResponseRecorder = { status?: number; headers?: Record<string, string>; body?: string; writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void }

let preferencesRoute: Route | undefined
let capabilitiesRoute: Route | undefined
let explorerRoute: Route | undefined
let sessionMoveRoute: Route | undefined
let disposeEffect: (() => void) | undefined
const webServer = {
  register: (route: Route) => {
    if (route.path === '/api/dsh-codex-ui/preferences') preferencesRoute = route
    if (route.path === '/api/dsh-codex-ui/capabilities') capabilitiesRoute = route
    if (route.path === '/api/dsh-codex-ui/open-in-explorer') explorerRoute = route
    if (route.path === '/api/dsh-codex-ui/session-move') sessionMoveRoute = route
    return () => {}
  },
}
let authenticationRejection: 401 | 403 | undefined
const services: Record<string, unknown> = {
  webServer,
  agents: { get: () => undefined },
  sessions: {
    get: () => undefined,
    flush: async () => {},
    prepare: () => { throw new Error('测试不应创建会话') },
    enter: () => { throw new Error('测试不应进入会话') },
  },
  sessionPersistence: {
    list: async () => [],
    readRaw: async () => undefined,
    loadStored: async () => undefined,
    locate: () => undefined,
  },
  tools: { schemas: () => [] },
  workspaceRegistry: { list: () => [{ path: 'D:\\Repository\\known-workspace' }] },
  connection: { requestRejection: () => authenticationRejection },
}
const context = {
  inject() {},
  get: (key: string) => services[key],
  effect: (effect: () => void | (() => void)) => { disposeEffect = effect() ?? undefined },
  logger: { warn: () => {} },
}
const previousProfileDir = process.env.DSH_PROFILE_DIR
const endpointDirectory = await mkdtemp(join(tmpdir(), 'dcu-workspace-preferences-endpoint-'))
process.env.DSH_PROFILE_DIR = endpointDirectory

try {
  apply(context as never)
  assert.ok(preferencesRoute)
  assert.ok(capabilitiesRoute)
  assert.ok(sessionMoveRoute)

  const invoke = async (method: string, chunks: string[] = [], headers: Record<string, string> = {}) => {
    const response: ResponseRecorder = {
      writeHead: (status, responseHeaders) => { response.status = status; response.headers = responseHeaders },
      end: body => { response.body = body },
    }
    await preferencesRoute?.handler({ ...request(chunks, headers), method, url: preferencesRoute.path }, response)
    return response
  }

  const missing = await invoke('GET')
  assert.equal(missing.status, 200)
  assert.deepEqual(JSON.parse(missing.body ?? ''), { version: 2, pinnedWorkspaceIds: [], exists: false })

  const saved = await invoke('PUT', [JSON.stringify({ pinnedWorkspaceIds: ['one', 'two'] })], { 'sec-fetch-site': 'same-origin' })
  assert.equal(saved.status, 200)
  assert.deepEqual(JSON.parse(saved.body ?? ''), { version: 2, pinnedWorkspaceIds: ['one', 'two'], exists: true })
  assert.deepEqual((await readWorkspacePreferences(join(endpointDirectory, WORKSPACE_PREFERENCES_FILE))).pinnedWorkspaceIds, ['one', 'two'])

  const savedWithLegacyField = await invoke('PUT', [JSON.stringify({ pinnedWorkspaceIds: ['two'], [legacyGroupField]: [{ id: 'stale', title: '旧分组', workspaceIds: [] }] })], { 'sec-fetch-site': 'same-origin' })
  assert.equal(savedWithLegacyField.status, 200, '旧客户端残留的分组字段必须被忽略')
  assert.deepEqual(JSON.parse(savedWithLegacyField.body ?? ''), { version: 2, pinnedWorkspaceIds: ['two'], exists: true })

  await invoke('PUT', [JSON.stringify({ pinnedWorkspaceIds: ['two'] })], { 'sec-fetch-site': 'same-origin' })
  assert.deepEqual(JSON.parse((await invoke('GET')).body ?? '{}'), { version: 2, pinnedWorkspaceIds: ['two'], exists: true })

  assert.equal((await invoke('PUT', [JSON.stringify({})])).status, 400, '缺少置顶列表时必须拒绝')
  assert.equal((await invoke('PUT', [JSON.stringify({ pinnedWorkspaceIds: [1] })])).status, 400, '非字符串置顶标识必须拒绝')
  assert.equal((await invoke('PUT', [JSON.stringify({ pinnedWorkspaceIds: ['  '] })])).status, 400, '空白置顶标识必须拒绝')

  authenticationRejection = 403
  assert.equal((await invoke('PUT', ['{}'], { 'sec-fetch-site': 'cross-site' })).status, 403)
  authenticationRejection = undefined
  assert.equal((await invoke('PUT', [], { 'content-length': String(33 * 1024) })).status, 413)
  assert.equal((await invoke('POST')).status, 405)

  const invokeCapabilities = async (method: string, url: string, headers: Record<string, string> = {}) => {
    const response: ResponseRecorder = {
      writeHead: (status, responseHeaders) => { response.status = status; response.headers = responseHeaders },
      end: body => { response.body = body },
    }
    await capabilitiesRoute?.handler({ ...request([], headers), method, url }, response)
    return response
  }
  authenticationRejection = 403
  const crossSiteCapability = await invokeCapabilities('POST', capabilitiesRoute?.path ?? '', { 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSiteCapability.status, 403, '能力探测路由必须拒绝跨站请求')
  assert.equal(JSON.parse(crossSiteCapability.body ?? '{}').error, '已拒绝不可信或跨站请求。')
  authenticationRejection = undefined
  assert.equal((await invokeCapabilities('POST', capabilitiesRoute?.path ?? '')).status, 405, '能力探测只接受 GET')

  services.desktopProfiles = {
    get current(): never { throw new Error('无法读取 D:\\Users\\demo\\secret-profile') },
  }
  const capabilityFailure = await invokeCapabilities('GET', capabilitiesRoute?.path ?? '')
  assert.equal(capabilityFailure.status, 503)
  assert.equal(JSON.parse(capabilityFailure.body ?? '{}').error, '运行时能力探测暂不可用。')
  assert.doesNotMatch(capabilityFailure.body ?? '', /secret-profile|D:\\\\Users/, '能力探测响应必须脱敏')
  delete services.desktopProfiles

  const explorerResponse: ResponseRecorder = {
    writeHead: (status, responseHeaders) => { explorerResponse.status = status; explorerResponse.headers = responseHeaders },
    end: body => { explorerResponse.body = body },
  }
  await explorerRoute?.handler({ ...request([JSON.stringify({ path: 'D:\\Repository\\unregistered' })], { 'sec-fetch-site': 'same-origin' }), method: 'POST', url: explorerRoute.path }, explorerResponse)
  assert.equal(explorerResponse.status, process.platform === 'win32' ? 403 : 501, 'Explorer Host 路由必须在 Windows 拒绝未注册路径，并在其他平台明确回退')

  const invokeSessionMove = async (chunks: string[], headers: Record<string, string>) => {
    const response: ResponseRecorder = {
      writeHead: (status, responseHeaders) => { response.status = status; response.headers = responseHeaders },
      end: body => { response.body = body },
    }
    await sessionMoveRoute?.handler({ ...request(chunks, headers), method: 'POST', url: sessionMoveRoute.path }, response)
    return response
  }
  authenticationRejection = 403
  const crossSiteMove = await invokeSessionMove([JSON.stringify({ sessionId: 'one', targetWorkspaceId: 'two' })], { 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSiteMove.status, 403)
  assert.deepEqual(JSON.parse(crossSiteMove.body ?? '{}'), { ok: false, code: 'session-move/forbidden', error: '已拒绝不可信或跨站请求。' })
  authenticationRejection = undefined
  const invalidMove = await invokeSessionMove([JSON.stringify({ sessionId: '', targetWorkspaceId: '' })], { 'sec-fetch-site': 'same-origin' })
  assert.equal(invalidMove.status, 400)
  assert.equal(JSON.parse(invalidMove.body ?? '{}').code, 'session-move/invalid-request')
} finally {
  disposeEffect?.()
  if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = previousProfileDir
  await rm(endpointDirectory, { recursive: true, force: true })
}
