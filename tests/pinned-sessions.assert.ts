import assert from 'node:assert/strict'
import {
  insertPinnedWorkspace,
  normalizePinnedWorkspaceIds,
  PINNED_WORKSPACES_STORAGE_KEY,
  prunePinnedWorkspaceIds,
  readHostWorkspacePreferences,
  readPinnedWorkspaceIds,
  resolvePinnedWorkspaceHydration,
  savePinnedWorkspaceIds,
  togglePinnedWorkspace,
  WORKSPACE_PREFERENCES_ENDPOINT,
  writeHostWorkspacePreferences,
} from '../src/client/pinned-workspaces.ts'

assert.deepEqual(
  normalizePinnedWorkspaceIds(['a', '', 'b', 'a', '  ', 'c']),
  ['a', 'b', 'c'],
)
assert.deepEqual(togglePinnedWorkspace(['a'], 'b'), ['a', 'b'])
assert.deepEqual(togglePinnedWorkspace(['a', 'b'], 'a'), ['b'])

assert.deepEqual(insertPinnedWorkspace(['a', 'b'], 'c', 'b'), ['a', 'c', 'b'])
assert.deepEqual(insertPinnedWorkspace(['a', 'b'], 'c'), ['a', 'b', 'c'])
assert.deepEqual(insertPinnedWorkspace(['a', 'b'], 'b', 'a'), ['b', 'a'])
assert.deepEqual(prunePinnedWorkspaceIds(['a', 'b'], ['a', 'b', 'c']), ['a', 'b'])
assert.deepEqual(prunePinnedWorkspaceIds(['a', 'stale', 'b'], ['a', 'b']), ['a', 'b'])

assert.deepEqual(resolvePinnedWorkspaceHydration([], { exists: true, pinnedWorkspaceIds: ['host'] }), { ids: ['host'], writeHost: false })
assert.deepEqual(resolvePinnedWorkspaceHydration(['legacy'], { exists: false, pinnedWorkspaceIds: [] }), { ids: ['legacy'], writeHost: true })
assert.deepEqual(resolvePinnedWorkspaceHydration(['legacy'], { exists: true, pinnedWorkspaceIds: ['host'] }, ['dirty']), { ids: ['dirty'], writeHost: true })

const host = await readHostWorkspacePreferences(async (input, init) => {
  assert.equal(input, WORKSPACE_PREFERENCES_ENDPOINT)
  assert.equal(init?.method, 'GET')
  return new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: ['a', 'a', 'b'] }), { status: 200 })
})
assert.deepEqual(host, { exists: true, pinnedWorkspaceIds: ['a', 'b'] })

await assert.rejects(
  readHostWorkspacePreferences(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: 'broken' }), { status: 200 })),
  /置顶偏好响应格式无效/,
  'Host 明确返回非法置顶数据时不得静默降级',
)

const values = new Map<string, string>()
const localStorage = {
  get length() { return values.size },
  clear() { values.clear() },
  getItem(key: string) { return values.get(key) ?? null },
  key(index: number) { return [...values.keys()][index] ?? null },
  removeItem(key: string) { values.delete(key) },
  setItem(key: string, value: string) { values.set(key, value) },
} satisfies Storage
assert.deepEqual(readPinnedWorkspaceIds(localStorage), [])
savePinnedWorkspaceIds(localStorage, ['a', 'a', 'b'])
assert.equal(values.has(PINNED_WORKSPACES_STORAGE_KEY), true)
assert.deepEqual(readPinnedWorkspaceIds(localStorage), ['a', 'b'])
values.set(PINNED_WORKSPACES_STORAGE_KEY, '{broken')
assert.deepEqual(readPinnedWorkspaceIds(localStorage), [], '损坏的置顶缓存必须安全退化为空列表')

await writeHostWorkspacePreferences(['a', 'a', 'b'], async (input, init) => {
  assert.equal(input, WORKSPACE_PREFERENCES_ENDPOINT)
  assert.equal(init?.method, 'PUT')
  assert.deepEqual(JSON.parse(String(init?.body)), { pinnedWorkspaceIds: ['a', 'b'] })
  return new Response('{}', { status: 200 })
})
