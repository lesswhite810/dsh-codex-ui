import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { CODEX_UI_API_ENDPOINTS } from '../src/business-api.ts'
import { supportsOfficialTurnNavigator } from '../src/runtime-capabilities.ts'

// 能力探测保留：官方轮次导航从 DSH 0.1.2-alpha.2 起可用。
assert.equal(supportsOfficialTurnNavigator('0.1.2-alpha.2'), true)
assert.equal(supportsOfficialTurnNavigator('0.1.2-alpha.3'), true)
assert.equal(supportsOfficialTurnNavigator('0.1.3'), true)
assert.equal(supportsOfficialTurnNavigator('0.2.0'), true)
assert.equal(supportsOfficialTurnNavigator('0.1.2-alpha.1'), false)
assert.equal(supportsOfficialTurnNavigator('0.1.1'), false)
assert.equal(supportsOfficialTurnNavigator('not-a-version'), false)

// 配套插件管理能力已移除：只保留只读的能力探测路由。
assert.equal(CODEX_UI_API_ENDPOINTS.capabilities, '/api/dsh-codex-ui/capabilities')
assert.equal('dependencies' in CODEX_UI_API_ENDPOINTS, false, '不得再暴露依赖管理接口')

const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
assert.match(host, /path: capabilitiesEndpoint/)
assert.doesNotMatch(host, /installDependency|updateAllDependencies|installProgressSnapshot|dependencyStatuses/, 'Host 不得再包含安装、更新或依赖状态逻辑')
assert.doesNotMatch(host, /publicDependencyError/, '不得保留依赖错误文案包装')

const settingsSection = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
assert.doesNotMatch(settingsSection, /id: 'about'/, '设置页不得再注册 Codex UI 页签')
assert.equal(existsSync(new URL('../src/client/AboutSection.tsx', import.meta.url)), false, '关于页组件必须已删除')

const navigatorSource = readFileSync(new URL('../src/client/official-turn-navigator.ts', import.meta.url), 'utf8')
assert.match(navigatorSource, /CODEX_UI_API_ENDPOINTS\.capabilities/, '客户端能力探测必须走只读能力接口')

assert.equal(existsSync(new URL('../src/dependency-manager.ts', import.meta.url)), false, '安装管理模块必须已删除')
assert.equal(existsSync(new URL('../src/dependencies.ts', import.meta.url)), false, '依赖清单模块必须已删除')
