// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { createGlobalPanelSource } from '../src/client/global-panels.tsx'

test('官方插件面板不进入侧栏顶栏，插件面板清单只来自宿主 sidebar.panellist 插槽', () => {
  const entries = [
    { options: { id: 'plugins', order: 0, label: () => '插件' } },
    { options: { id: 'files', order: 2, label: () => '文件' } },
  ]
  const source = createGlobalPanelSource({ entriesOfSlot: () => entries, subscribe: () => () => {} }, { subscribe: () => () => {} })
  expect(source.getSnapshot().map(panel => panel.id)).toEqual(['files'])
})

test('面板注册、重命名、移除和语言更新实时同步并释放订阅', () => {
  let entries = [{ options: { id: 'files', order: 2, label: () => '文件' } }]
  const listeners = new Set<() => void>()
  const subscribe = (_name: unknown, fn?: () => void) => { const listener = fn ?? _name as () => void; listeners.add(listener); return () => { listeners.delete(listener) } }
  const source = createGlobalPanelSource({ entriesOfSlot: () => entries, subscribe }, { subscribe: listener => subscribe(listener) })
  const changed = vi.fn()
  const off = source.subscribe(changed)
  expect(source.getSnapshot().map(p => p.label)).toEqual(['文件'])
  const first = source.getSnapshot()
  expect(source.getSnapshot()).toBe(first)
  listeners.forEach(fn => fn())
  expect(source.getSnapshot()).toBe(first)
  entries = [{ options: { id: 'files', order: 2, label: () => 'Files' } }]
  listeners.forEach(fn => fn())
  expect(source.getSnapshot()[0]?.label).toBe('Files')
  entries = []
  listeners.forEach(fn => fn())
  expect(source.getSnapshot()).toEqual([])
  off()
  expect(listeners.size).toBe(0)
})

