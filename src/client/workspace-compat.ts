import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type WorkspaceStartService = {
  startSession: (workspaceId?: WorkspaceId) => unknown
}

export type WorkspaceConnectService = {
  connectWorkspace: (workspaceId: WorkspaceId) => Promise<SessionId>
}

export function hasStartSession(value: unknown): value is WorkspaceStartService {
  return value !== null && typeof value === 'object' && 'startSession' in value && typeof value.startSession === 'function'
}

export function hasConnectWorkspace(value: unknown): value is WorkspaceConnectService {
  return value !== null && typeof value === 'object' && 'connectWorkspace' in value && typeof value.connectWorkspace === 'function'
}

export type WorkspaceOpenService = {
  openWorkspace: (workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void) => unknown
}

export function hasOpenWorkspace(value: unknown): value is WorkspaceOpenService {
  return value !== null && typeof value === 'object' && 'openWorkspace' in value && typeof value.openWorkspace === 'function'
}

/** 与 DSH 官方最近工作区策略一致；时间相同时保留 Host 工作区顺序。 */
export function recentWorkspaceId(
  workspaces: readonly { workspaceId: WorkspaceId; sessionIds: readonly SessionId[]; createdAt: string }[],
  sessions: Readonly<Record<string, { updatedAt: number }>>,
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
