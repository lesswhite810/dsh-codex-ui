import { createRequire } from 'node:module'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, createElement, type ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChannelBrowser } from '../src/client/ChannelBrowser.tsx'
import { CodexWorkspaceBrowser } from '../src/client/CodexWorkspaceBrowser.tsx'
import { ScheduleBrowser } from '../src/client/ScheduleBrowser.tsx'
import { createWorkspaceShortcutSource } from '../src/client/workspace-shortcuts.ts'
import { PINNED_WORKSPACES_STORAGE_KEY } from '../src/client/pinned-workspaces.ts'
import type { PendingInteractionSnapshot, UseSessionPendingInteraction, UseSessionStatus } from '../src/client/session-pending.ts'
import type { SessionStatusSnapshot } from '../src/client/session-host.ts'
import type { PendingInteractionKind } from '../src/client/session-pending.ts'

const createRoot = (createRequire(import.meta.url)('react-dom/client') as {
  createRoot: (container: Element) => { render: (node: ReactNode) => void; unmount: () => void }
}).createRoot

const t = (key: string): string => ({
  'sessions.waitingAnswer': '等待回答',
  'sessions.waitingApproval': '等待审批',
  'sessions.planReview': '计划待审',
}[key] ?? key)

const sessionActions = {
  openSession: () => {},
  archiveSession: async () => {},
  deleteSession: async () => {},
  forkSession: async () => {},
  renameSession: async () => {},
}

const EMPTY_PENDING_INTERACTIONS: PendingInteractionSnapshot = new Map()
const useEmptyPendingInteractions: UseSessionPendingInteraction = selector => selector(EMPTY_PENDING_INTERACTIONS)

type LegacySessionSummary = SessionSummary & { pendingInteraction?: PendingInteractionKind }

function createSession(id: string, displayTitle: string, pendingInteraction: PendingInteractionKind | undefined): LegacySessionSummary {
  return {
    id: id as SessionId,
    displayTitle,
    running: true,
    pendingInteraction,
    blank: false,
    updatedAt: Date.parse('2026-09-01T00:00:00.000Z'),
    retainedBy: {},
  }
}

function createSessionStore(session: SessionSummary) {
  const state: SessionListState = {
    ids: [session.id],
    byId: { [session.id]: session },
    phase: 'ready',

    projectionsBySession: {},
  }
  return <T,>(selector: (snapshot: SessionListState) => T): T => selector(state)
}

function createPendingInteractionStore(sessionId: string, kind: PendingInteractionKind): UseSessionPendingInteraction {
  const state = new Map([[sessionId, { kind }]])
  return selector => selector(state)
}

function createSessionStatusStore(sessionId: string, kind: PendingInteractionKind): UseSessionStatus {
  const state: SessionStatusSnapshot = new Map([[sessionId, { pendingInteraction: { kind }, running: true }]])
  return selector => selector(state)
}

function createDataTransfer(): DataTransfer {
  const values = new Map<string, string>()
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => { values.set(type, value) },
    setDragImage: () => {},
  } as unknown as DataTransfer
}

function dispatchDrag(target: Element, type: 'dragstart' | 'dragover' | 'dragleave' | 'dragend' | 'drop', dataTransfer: DataTransfer, relatedTarget?: EventTarget | null): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientY', { value: 0 })
  if (relatedTarget !== undefined) Object.defineProperty(event, 'relatedTarget', { value: relatedTarget })
  target.dispatchEvent(event)
}

async function render(node: ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(node)
    await Promise.resolve()
    await Promise.resolve()
  })
  return {
    container,
    dispose: async () => {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

test('添加工作区按钮随官方入口启停和快捷键目录实时更新', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const listeners = new Set<() => void>()
  const shortcutListeners = new Set<() => void>()
  let rows = [{ id: 'workspace.add', aria: 'Control+O' }]
  const request = vi.fn()
  const official = { locale: 'workspace', inject: () => ({
    requestAddWorkspace: request,
    closeAddWorkspace: () => {}, setDirectoryBusy: () => {}, createWorkspace: async () => ({ workspaceId: 'new' }),
    hooks: {
      workspaceShortcuts: { getSnapshot: () => ({ searchRequest: 0, addRequested: false }), subscribe: () => () => {} },
      shortcuts: { getSnapshot: () => rows, subscribe: (listener: () => void) => { shortcutListeners.add(listener); return () => { shortcutListeners.delete(listener) } } },
    },
  }) }
  let present = false
  const source = createWorkspaceShortcutSource({ entries: () => present ? [official] : [], subscribe: (_key, listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } })
  const workspaces = { baselinesReady: true, archivedSessionIds: [], items: [] }
  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions, wide: true, useSessions: createSessionStore(createSession('unused', 'unused', undefined)),
    useSessionPendingInteraction: useEmptyPendingInteractions,
    useWorkspaces: (select: (snapshot: typeof workspaces) => unknown) => select(workspaces), t,
    workspaceShortcuts: source, deleteWorkspace: vi.fn(), insertSessionBefore: vi.fn(), insertWorkspaceBefore: vi.fn(), openPath: vi.fn(), renameWorkspace: vi.fn(), startSession: vi.fn(),
  } as never))
  const button = () => view.container.querySelector<HTMLButtonElement>('[aria-label="workspace.add"]')!
  try {
    expect(button().disabled).toBe(true)
    await act(async () => { present = true; for (const notify of listeners) notify() })
    expect(button().disabled).toBe(false)
    expect(button().getAttribute('aria-keyshortcuts')).toBe('Control+O')
    await act(async () => { rows = [{ id: 'workspace.add', aria: 'Alt+O' }]; for (const notify of shortcutListeners) notify() })
    expect(button().getAttribute('aria-keyshortcuts')).toBe('Alt+O')
    await act(async () => { button().click() })
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => { present = false; for (const notify of listeners) notify() })
    expect(button().disabled).toBe(true)
    expect(button().getAttribute('aria-keyshortcuts')).toBeNull()
  } finally {
    await view.dispose()
    source.dispose()
    expect(shortcutListeners.size).toBe(0)
  }
})

test('跨置顶与项目悬停不依赖 dragleave，结束清空所有落点', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const workspaces = { baselinesReady: true, archivedSessionIds: [], items: ['a', 'b', 'c'].map(id => ({ workspaceId: id, title: id, path: `D:/${id}`, sessionIds: [] })) }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: ['a', 'c'] }))))
  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions, wide: true, useSessions: createSessionStore(createSession('unused', 'unused', undefined)),
    useSessionPendingInteraction: useEmptyPendingInteractions,
    useWorkspaces: (selector: (snapshot: typeof workspaces) => unknown) => selector(workspaces), t,
    deleteWorkspace: vi.fn(), insertSessionBefore: vi.fn(), insertWorkspaceBefore: vi.fn(), openPath: vi.fn(), renameWorkspace: vi.fn(), startSession: vi.fn(),
  } as never))
  try {
    const pinned = view.container.querySelectorAll('.dcu-wb-pinned-list .dcu-wb-project-head')
    const regular = view.container.querySelector<HTMLElement>('.dcu-wb-collections .dcu-wb-project')!
    const transfer = createDataTransfer()
    const markers = () => view.container.querySelectorAll('.dcu-wb-drop')
    await act(async () => { dispatchDrag(pinned[1]!, 'dragstart', transfer) })
    await act(async () => { dispatchDrag(pinned[0]!, 'dragover', transfer) })
    expect(markers()).toHaveLength(1)
    await act(async () => { dispatchDrag(regular, 'dragover', transfer) })
    expect(markers()).toHaveLength(1)
    expect(regular.classList.contains('dcu-wb-drop')).toBe(true)
    await act(async () => { dispatchDrag(pinned[0]!, 'dragover', transfer) })
    expect(markers()).toHaveLength(1)
    expect(regular.classList.contains('dcu-wb-drop')).toBe(false)
    await act(async () => { dispatchDrag(pinned[1]!, 'dragend', transfer) })
    expect(markers()).toHaveLength(0)
    expect(view.container.querySelector('.dcu-wb-drop-indicator')).toBeNull()
  } finally { await view.dispose() }
})

test('拖动项目时置顶末尾落点不得把项目分区顶下去', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const workspaces = { baselinesReady: true, archivedSessionIds: [], items: ['pinned', 'loose'].map(id => ({ workspaceId: id, title: id, path: `D:/${id}`, sessionIds: [] })) }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: ['pinned'] }))))
  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions, wide: true, useSessions: createSessionStore(createSession('unused', 'unused', undefined)),
    useSessionPendingInteraction: useEmptyPendingInteractions,
    useWorkspaces: (selector: (snapshot: typeof workspaces) => unknown) => selector(workspaces), t,
    deleteWorkspace: vi.fn(), insertSessionBefore: vi.fn(), insertWorkspaceBefore: vi.fn(), openPath: vi.fn(), renameWorkspace: vi.fn(), startSession: vi.fn(),
  } as never))
  try {
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const projects = view.container.querySelector<HTMLElement>('.dcu-wb-section[aria-label="workspace.projects"]')!
    const before = projects.offsetTop
    const transfer = createDataTransfer()
    await act(async () => { dispatchDrag(view.container.querySelectorAll('.dcu-wb-project-head')[1]!, 'dragstart', transfer) })
    const pinEnd = view.container.querySelector<HTMLElement>('.dcu-wb-pin-end')!
    expect(pinEnd).not.toBeNull()
    expect(getComputedStyle(pinEnd).position).toBe('absolute')
    expect(projects.offsetTop).toBe(before)
  } finally { await view.dispose() }
})

test('空置顶在 dragleave 清掉蓝线后仍能接收项目', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const workspaces = { baselinesReady: true, archivedSessionIds: [], items: ['alpha', 'beta'].map(id => ({ workspaceId: id, title: id, path: `D:/${id}`, sessionIds: [] })) }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: [] }))))
  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions, wide: true, useSessions: createSessionStore(createSession('unused', 'unused', undefined)),
    useSessionPendingInteraction: useEmptyPendingInteractions,
    useWorkspaces: (selector: (snapshot: typeof workspaces) => unknown) => selector(workspaces), t,
    deleteWorkspace: vi.fn(), insertSessionBefore: vi.fn(), insertWorkspaceBefore: vi.fn(), openPath: vi.fn(), renameWorkspace: vi.fn(), startSession: vi.fn(),
  } as never))
  try {
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const project = view.container.querySelector('.dcu-wb-project-head')!
    const pinned = view.container.querySelector('.dcu-wb-section[aria-label="workspace.pinned"]')!
    const empty = pinned.querySelector('.dcu-wb-empty')!
    const transfer = createDataTransfer()
    await act(async () => { dispatchDrag(project, 'dragstart', transfer) })
    await act(async () => { dispatchDrag(empty, 'dragover', transfer) })
    await act(async () => { dispatchDrag(pinned, 'dragleave', transfer, null) })
    await act(async () => { dispatchDrag(empty, 'drop', transfer) })
    expect(view.container.querySelector('.dcu-wb-pinned-list .dcu-wb-project-title')?.textContent).toBe('alpha')
    expect(view.container.querySelectorAll('.dcu-wb-section[aria-label="workspace.projects"] .dcu-wb-project-title')).toHaveLength(1)
  } finally { await view.dispose() }
})

test.each([401, 403, 503])('偏好读取 HTTP %s 保留本地置顶并提示尚未同步', async status => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.setItem(PINNED_WORKSPACES_STORAGE_KEY, JSON.stringify(['cached']))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))
  const workspaces = { baselinesReady: true, archivedSessionIds: [], items: [{ workspaceId: 'cached', title: '本地项目', path: 'D:/cached', sessionIds: [] }] }
  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions, wide: true, useSessions: createSessionStore(createSession('unused', 'unused', undefined)),
    useSessionPendingInteraction: useEmptyPendingInteractions,
    useWorkspaces: (selector: (snapshot: typeof workspaces) => unknown) => selector(workspaces), t,
    deleteWorkspace: vi.fn(), insertSessionBefore: vi.fn(), insertWorkspaceBefore: vi.fn(), openPath: vi.fn(), renameWorkspace: vi.fn(), startSession: vi.fn(),
  } as never))
  try {
    expect(view.container.querySelector('.dcu-wb-pinned-list .dcu-wb-project-title')?.textContent).toBe('本地项目')
    const message = view.container.querySelector('.dcu-wb-error[role="status"]')?.textContent
    expect(message).toContain('workspace.preferencesLocalOnly')
    expect(message).toContain(status === 401 ? 'errors.unauthorized' : status === 403 ? 'errors.forbidden' : 'errors.serviceUnavailable')
  } finally { await view.dispose() }
})

function expectPendingState(container: Element, title: string, kind: PendingInteractionKind, label: string): void {
  const row = [...container.querySelectorAll<HTMLElement>('.dcu-wb-session')]
    .find(candidate => candidate.querySelector('.dcu-wb-session-title')?.textContent === title)
  const pending = row?.querySelector<HTMLElement>('[data-state="warning"]')
  expect(pending?.dataset.pendingKind).toBe(kind)
  expect(pending?.textContent).toBe(label)
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

test('任务树从 SessionSummary 快照渲染等待回答状态', async () => {
  const session = createSession('workspace-session', '任务会话', 'question')
  const useSessions = createSessionStore(session)
  const workspaces = {
    baselinesReady: true,
    archivedSessionIds: [],
    items: [{ workspaceId: 'workspace-1', title: '测试项目', path: 'D:\\Workspace\\test', sessionIds: [session.id] }],
  }
  const useWorkspaces = <T,>(selector: (snapshot: typeof workspaces) => T): T => selector(workspaces)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))

  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions,
    wide: true,
    useSessions,
    useSessionPendingInteraction: useEmptyPendingInteractions,
    useWorkspaces,
    t,
    deleteWorkspace: async () => {},
    insertSessionBefore: async () => {},
    insertWorkspaceBefore: async () => {},
    openPath: async () => {},
    renameWorkspace: async () => {},
    startSession: () => {},
  } as never))
  try {
    expectPendingState(view.container, '任务会话', 'question', '等待回答')
  } finally {
    await view.dispose()
  }
})

test('任务树把会话拖到其他项目时先确认，取消不迁移且确认只执行一次', async () => {
  const session = createSession('move-session', '待移动会话', undefined)
  const targetSession = createSession('target-session', '目标项目会话', undefined)
  const sessionState: SessionListState = {
    ids: [session.id, targetSession.id],
    byId: { [session.id]: session, [targetSession.id]: targetSession },
    phase: 'ready',

    projectionsBySession: {},
  }
  const useSessions = <T,>(selector: (snapshot: SessionListState) => T): T => selector(sessionState)
  const workspaces = {
    baselinesReady: true,
    archivedSessionIds: [],
    items: [
      { workspaceId: 'source', title: '源项目', path: 'D:\\Workspace\\source', sessionIds: [session.id] },
      { workspaceId: 'target', title: '目标项目', path: 'D:\\Workspace\\target', sessionIds: [targetSession.id] },
    ],
  }
  const useWorkspaces = <T,>(selector: (snapshot: typeof workspaces) => T): T => selector(workspaces)
  const moveSession = vi.fn(async () => {})
  const insertSessionBefore = vi.fn(async () => {})
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))

  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions,
    moveSession,
    wide: true,
    useSessions,
    useSessionPendingInteraction: useEmptyPendingInteractions,
    useWorkspaces,
    t,
    deleteWorkspace: async () => {},
    insertSessionBefore,
    insertWorkspaceBefore: async () => {},
    openPath: async () => {},
    renameWorkspace: async () => {},
    startSession: () => {},
  } as never))
  try {
    const sourceRow = [...view.container.querySelectorAll<HTMLElement>('.dcu-wb-session')]
      .find(row => row.querySelector('.dcu-wb-session-title')?.textContent === '待移动会话')
    const targetProject = [...view.container.querySelectorAll<HTMLElement>('.dcu-wb-project')]
      .find(project => project.querySelector('.dcu-wb-project-title')?.textContent === '目标项目')
    const targetSessionRow = [...targetProject!.querySelectorAll<HTMLElement>('.dcu-wb-session')]
      .find(row => row.querySelector('.dcu-wb-session-title')?.textContent === '目标项目会话')
    expect(sourceRow).toBeDefined()
    expect(targetProject).toBeDefined()
    expect(targetSessionRow).toBeDefined()
    const dataTransfer = createDataTransfer()

    await act(async () => { dispatchDrag(sourceRow!, 'dragstart', dataTransfer) })
    await act(async () => { dispatchDrag(targetSessionRow!, 'dragover', dataTransfer) })
    expect(targetProject?.classList.contains('dcu-wb-session-move-drop')).toBe(true)

    await act(async () => {
      dispatchDrag(targetSessionRow!, 'drop', dataTransfer)
      await Promise.resolve()
    })
    expect(moveSession).not.toHaveBeenCalled()
    expect(insertSessionBefore).not.toHaveBeenCalled()

    const cancelButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'sessions.cancel')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('sessions.moveConfirmTitle')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('目标项目')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('D:\\Workspace\\target')
    await act(async () => { cancelButton?.click() })
    expect(moveSession).not.toHaveBeenCalled()

    const secondDataTransfer = createDataTransfer()
    await act(async () => { dispatchDrag(sourceRow!, 'dragstart', secondDataTransfer) })
    await act(async () => { dispatchDrag(targetSessionRow!, 'drop', secondDataTransfer) })
    const confirmButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'sessions.moveConfirmAction')
    await act(async () => {
      confirmButton?.click()
      await Promise.resolve()
    })
    expect(moveSession).toHaveBeenCalledTimes(1)
    expect(moveSession).toHaveBeenCalledWith('move-session', 'target')
  } finally {
    await view.dispose()
  }
})

test('频道树从 SessionSummary 快照渲染等待审批状态', async () => {
  const session = createSession('im:test-channel', '频道会话快照', 'approval')
  const useSessions = createSessionStore(session)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    groups: [{ id: 'wecom', label: '企业微信', sessions: [{ sessionId: session.id, title: '频道会话', running: true }] }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))

  const view = await render(createElement(ChannelBrowser, { ...sessionActions, useSessions, useSessionPendingInteraction: useEmptyPendingInteractions, t } as never))
  try {
    expectPendingState(view.container, '频道会话', 'approval', '等待审批')
  } finally {
    await view.dispose()
  }
})

test('定时树从 SessionSummary 快照渲染计划待审状态', async () => {
  const session = createSession('dsh-automation-session-review', '2026-09-01 08:00 - 日报任务', 'plan-review')
  const useSessions = createSessionStore(session)
  const workspaces = { archivedSessionIds: [] }
  const useWorkspaces = <T,>(selector: (snapshot: typeof workspaces) => T): T => selector(workspaces)

  const view = await render(createElement(ScheduleBrowser, {
    ...sessionActions,
    useSessions,
    useSessionPendingInteraction: useEmptyPendingInteractions,
    useWorkspaces,
    t,
  } as never))
  try {
    expectPendingState(view.container, session.displayTitle, 'plan-review', '计划待审')
  } finally {
    await view.dispose()
  }
})

test('任务树从待处理交互 Store 渲染等待审批状态', async () => {
  const session = createSession('workspace-store-session', '任务 Store 会话', undefined)
  const useSessions = createSessionStore(session)
  const useSessionPendingInteraction = createPendingInteractionStore(session.id, 'approval')
  const workspaces = {
    baselinesReady: true,
    archivedSessionIds: [],
    items: [{ workspaceId: 'workspace-store-1', title: 'Store 测试项目', path: 'D:\\Workspace\\store-test', sessionIds: [session.id] }],
  }
  const useWorkspaces = <T,>(selector: (snapshot: typeof workspaces) => T): T => selector(workspaces)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))

  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions,
    wide: true,
    useSessions,
    useSessionPendingInteraction,
    useWorkspaces,
    t,
    deleteWorkspace: async () => {},
    insertSessionBefore: async () => {},
    insertWorkspaceBefore: async () => {},
    openPath: async () => {},
    renameWorkspace: async () => {},
    startSession: () => {},
  } as never))
  try {
    expectPendingState(view.container, session.displayTitle, 'approval', '等待审批')
  } finally {
    await view.dispose()
  }
})

test('频道树从待处理交互 Store 渲染等待回答状态', async () => {
  const session = createSession('im:store-channel', '频道 Store 会话快照', undefined)
  const useSessions = createSessionStore(session)
  const useSessionPendingInteraction = createPendingInteractionStore(session.id, 'question')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    groups: [{ id: 'wecom', label: '企业微信', sessions: [{ sessionId: session.id, title: '频道 Store 会话', running: true }] }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))

  const view = await render(createElement(ChannelBrowser, {
    ...sessionActions,
    useSessions,
    useSessionPendingInteraction,
    t,
  } as never))
  try {
    expectPendingState(view.container, '频道 Store 会话', 'question', '等待回答')
  } finally {
    await view.dispose()
  }
})

test('任务树在没有旧 pending Store 时从 SessionStatus 渲染等待审批', async () => {
  const session = createSession('workspace-status-session', '任务 Status 会话', undefined)
  const useSessions = createSessionStore(session)
  const useSessionStatus = createSessionStatusStore(session.id, 'approval')
  const workspaces = {
    baselinesReady: true,
    archivedSessionIds: [],
    items: [{ workspaceId: 'workspace-status-1', title: 'Status 测试项目', path: 'D:\\Workspace\\status-test', sessionIds: [session.id] }],
  }
  const useWorkspaces = <T,>(selector: (snapshot: typeof workspaces) => T): T => selector(workspaces)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: true, pinnedWorkspaceIds: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))

  const view = await render(createElement(CodexWorkspaceBrowser, {
    ...sessionActions,
    wide: true,
    useSessions,
    useSessionStatus,
    useWorkspaces,
    t,
    deleteWorkspace: async () => {},
    insertSessionBefore: async () => {},
    insertWorkspaceBefore: async () => {},
    openPath: async () => {},
    renameWorkspace: async () => {},
    startSession: () => {},
  } as never))
  try {
    expectPendingState(view.container, session.displayTitle, 'approval', '等待审批')
  } finally {
    await view.dispose()
  }
})

test('定时树从待处理交互 Store 渲染计划待审状态', async () => {
  const session = createSession('dsh-automation-session-store-review', '2026-09-01 09:00 - Store 日报任务', undefined)
  const useSessions = createSessionStore(session)
  const useSessionPendingInteraction = createPendingInteractionStore(session.id, 'plan-review')
  const workspaces = { archivedSessionIds: [] }
  const useWorkspaces = <T,>(selector: (snapshot: typeof workspaces) => T): T => selector(workspaces)

  const view = await render(createElement(ScheduleBrowser, {
    ...sessionActions,
    useSessions,
    useSessionPendingInteraction,
    useWorkspaces,
    t,
  } as never))
  try {
    expectPendingState(view.container, session.displayTitle, 'plan-review', '计划待审')
  } finally {
    await view.dispose()
  }
})
