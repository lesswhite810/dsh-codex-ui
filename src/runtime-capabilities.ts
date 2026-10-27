/** 只读的运行时能力探测：识别当前 Profile/运行时里安装的 DSH 版本，不参与插件安装或更新。 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

type PackageManifest = { version?: string }
type OptionalServiceContext = {
  get?: (name: string) => unknown
}

type DesktopProfilesService = {
  current?: { name?: unknown; dir?: unknown }
}

type DesktopPnpmHandle = {
  stdout?: NodeJS.ReadableStream
  stderr?: NodeJS.ReadableStream
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  cancel(): void
}

type DesktopPnpmService = {
  runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): DesktopPnpmHandle
}

export type DependencyRuntime = {
  environmentKind: 'desktop' | 'cli'
  profileName: string
  profileDir: string
  runtimeRoots: readonly string[]
  desktopPnpm?: DesktopPnpmService
  /** 官方 Desktop 交给 profile 的 pnpm 启动方式。没有 desktopPnpm 时用它安装，不再去启动 asar 里的 CLI。 */
  packageManager?: ProfilePackageManager
  /** 当前进程不是 dsh CLI 时，从公开 profileContext 解析出的 CLI 入口。 */
  cliEntry?: string
  /** 官方 Desktop Host 交给包管理的环境；只合并字符串项。 */
  pluginEnv?: NodeJS.ProcessEnv
}

type ProfilePackageManager = {
  command: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
}

type LaunchedProfileService = {
  name?: unknown
  dir?: unknown
  installAnchor?: unknown
  packageManager?: { command?: unknown; args?: unknown; env?: unknown }
}

export type DependencyRuntimeOptions = {
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  cwd?: string
  homeDir?: string
}

function optionalService<T>(ctx: OptionalServiceContext | undefined, name: string): T | undefined {
  if (ctx === undefined) return undefined
  return (typeof ctx.get === 'function' ? ctx.get(name) : (ctx as Record<string, unknown>)[name]) as T | undefined
}

function validProfileName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..'
    && value !== 'node_modules' && !value.includes('/') && !value.includes('\\') && !/[\0-\x1f\x7f]/.test(value)
}

function profileNameFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile') return argv[index + 1]
    if (argument?.startsWith('--profile=')) return argument.slice('--profile='.length)
  }
  return argv[2] === 'web' ? 'web' : undefined
}

/**
 * Desktop 通过可选 Host service 暴露当前 profile；普通 Web/CLI 继续使用
 * DSH_PROFILE_DIR、命令行 profile 与默认 web profile。
 */
export function resolveDependencyRuntime(ctx?: OptionalServiceContext, options: DependencyRuntimeOptions = {}): DependencyRuntime {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv
  const cwd = options.cwd ?? process.cwd()
  const home = options.homeDir ?? homedir()
  const profiles = optionalService<DesktopProfilesService>(ctx, 'desktopProfiles')
  const desktopPnpm = optionalService<DesktopPnpmService>(ctx, 'desktopPnpm')
  if (profiles === undefined && desktopPnpm !== undefined) {
    throw new Error('DSH Desktop Profile 服务尚未就绪，请重启 Desktop 后重试。')
  }
  if (profiles !== undefined) {
    const current = profiles.current
    if (!validProfileName(current?.name) || typeof current.dir !== 'string' || !isAbsolute(current.dir)) {
      throw new Error('DSH Desktop 当前 Profile 信息无效，请重启 Desktop 后重试。')
    }
    if (typeof desktopPnpm?.runPlugin !== 'function') {
      throw new Error('DSH Desktop 包管理服务尚未就绪，请重启 Desktop 后重试。')
    }
    const profileDir = resolve(current.dir)
    // 只接受公开 Host contract 与旧 Desktop 明确提供的运行目录；
    // launcher-private bootstrap 路径不属于第三方插件兼容边界。
    const runtimeRoots = typeof env.DSH_RUNTIME_DIR === 'string' && isAbsolute(env.DSH_RUNTIME_DIR)
      ? [resolve(env.DSH_RUNTIME_DIR)]
      : []
    return {
      environmentKind: 'desktop',
      profileName: current.name,
      profileDir,
      runtimeRoots,
      desktopPnpm,
    }
  }
  const launched = optionalService<LaunchedProfileService>(ctx, 'profileContext')
  const launchedDir = typeof launched?.dir === 'string' && isAbsolute(launched.dir) ? resolve(launched.dir) : undefined
  const launchedName = validProfileName(launched?.name) ? launched.name : undefined
  const hostProfileDir = isOfficialDesktopHostEntry(argv[1]) && existsSync(resolve(cwd, 'package.json')) ? resolve(cwd) : undefined
  const profileDir = launchedDir ?? hostProfileDir ?? resolve(env.DSH_PROFILE_DIR ?? resolve(home, '.dsh', 'profiles', 'web'))
  const selected = profileNameFromArgv(argv)
  const profileName = launchedName ?? (validProfileName(selected) ? selected : validProfileName(basename(profileDir)) ? basename(profileDir) : 'web')
  const cliEntry = resolveCliFromInstallAnchor(launched?.installAnchor) ?? resolveCliBesideDesktopHost(argv[1])
  const cliRuntimeRoot = argv[1] === undefined ? undefined : resolveDshRuntimeRoot(argv[1], cwd)
  const anchorRoot = cliEntry === undefined ? undefined : resolveDshRuntimeRoot(cliEntry)
  const runtimeRoots = [env.DSH_RUNTIME_DIR, anchorRoot, cliRuntimeRoot]
    .filter((root): root is string => root !== undefined && root !== '')
  const pluginEnv = stringEnvironment(launched?.packageManager?.env)
  const packageManager = profilePackageManager(launched?.packageManager) ?? desktopPackageManagerFromArgv(argv)
  return {
    environmentKind: 'cli',
    profileName,
    profileDir,
    runtimeRoots,
    ...(cliEntry === undefined ? {} : { cliEntry }),
    ...(pluginEnv === undefined ? {} : { pluginEnv }),
    ...(packageManager === undefined ? {} : { packageManager }),
  }
}

function profilePackageManager(value: LaunchedProfileService['packageManager']): ProfilePackageManager | undefined {
  if (typeof value?.command !== 'string' || value.command === '') return undefined
  if (!Array.isArray(value.args) || !value.args.every(item => typeof item === 'string')) return undefined
  const env = stringEnvironment(value.env)
  return { command: value.command, args: value.args, ...(env === undefined ? {} : { env }) }
}

/** 官方 Desktop Host 把 pnpm 入口放在 argv[5]，bin 放在 argv[6]，不提供 desktopPnpm。 */
export function desktopPackageManagerFromArgv(
  argv: readonly string[],
  command = process.execPath,
): ProfilePackageManager | undefined {
  if (!isOfficialDesktopHostEntry(argv[1])) return undefined
  const pnpm = argv[5]
  if (typeof pnpm !== 'string' || !isAbsolute(pnpm) || !existsSync(pnpm)) return undefined
  const bin = argv[6]
  const path = typeof bin === 'string' && bin !== '' ? `${bin}${delimiter}${process.env.PATH ?? ''}` : process.env.PATH
  return {
    command,
    args: ['--expose-internals', pnpm],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(typeof path === 'string' && path !== '' ? { PATH: path } : {}),
    },
  }
}

function stringEnvironment(value: unknown): NodeJS.ProcessEnv | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const env: NodeJS.ProcessEnv = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') env[key] = item
  }
  return Object.keys(env).length === 0 ? undefined : env
}

/** 从公开 profileContext.installAnchor 读出 dsh bin，不把 Desktop Host 入口当成 CLI。 */
export function resolveCliFromInstallAnchor(anchor: unknown): string | undefined {
  if (typeof anchor !== 'string' || anchor === '' || !isAbsolute(anchor)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(anchor, 'utf8')) as { bin?: unknown }
    const bin = manifest.bin
    const relative = typeof bin === 'string'
      ? bin
      : bin !== null && typeof bin === 'object' && typeof (bin as { dsh?: unknown }).dsh === 'string'
        ? (bin as { dsh: string }).dsh
        : undefined
    if (relative === undefined || relative === '') return undefined
    const entry = resolve(dirname(anchor), relative)
    return existsSync(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

/** 官方 Desktop Host 是 Electron 的 IPC 子进程；父进程只接受带 type 的事件。 */
export function isOfficialDesktopHostEntry(entry = process.argv[1]): boolean {
  if (entry === undefined || entry === '') return false
  return entry.replaceAll('\\', '/').includes('/dsh-desktop-host/')
}

/** 从公开包布局定位同一次安装里的 dsh CLI，不读取 launcher 私有 service。 */
export function resolveCliBesideDesktopHost(entry = process.argv[1]): string | undefined {
  if (!isOfficialDesktopHostEntry(entry)) return undefined
  const normalized = entry.replaceAll('\\', '/')
  const marker = '/node_modules/@deepseek-ai/dsh-desktop-host/'
  const index = normalized.toLowerCase().lastIndexOf(marker)
  if (index < 0) return undefined
  return resolveCliFromInstallAnchor(resolve(entry.slice(0, index), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function profileDirectory(runtime: DependencyRuntime): string {
  return runtime.profileDir
}
export function isOfficialRuntimePackage(packageName: string): boolean {
  return packageName === '@deepseek-ai/dsh' || packageName.startsWith('@deepseek-ai/dsh-')
}

/** 从全局 npm 安装的 dsh CLI 入口反推出包含 node_modules 的运行时目录；源码启动不匹配该目录结构。 */
export function resolveDshRuntimeRoot(entry = process.argv[1], cwd = process.cwd()): string | undefined {
  if (entry === undefined || entry === '') return undefined
  const cliEntry = resolveDshCliEntry(entry, cwd)
  const marker = ['node_modules', '@deepseek-ai', 'dsh'].join(sep)
  const index = cliEntry.toLowerCase().lastIndexOf(marker.toLowerCase())
  if (index === -1) return undefined
  const end = index + marker.length
  if (end !== cliEntry.length && cliEntry[end] !== sep) return undefined
  const root = cliEntry.slice(0, index)
  return root.endsWith(sep) ? root.slice(0, -1) : root
}

function packageLookupRoots(packageName: string, runtime: DependencyRuntime): string[] {
  if (!isOfficialRuntimePackage(packageName)) return [profileDirectory(runtime)]
  return [...new Set([...runtime.runtimeRoots, profileDirectory(runtime)])]
}

async function installedPackageVersion(packageName: string, runtime: DependencyRuntime): Promise<string | undefined> {
  for (const root of packageLookupRoots(packageName, runtime)) {
    try {
      const manifest = JSON.parse(await readFile(resolve(root, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8')) as PackageManifest
      if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

/** 磁盘有包且仍在 profile 声明里，才算已安装。卸载后残留的 node_modules 不算。 */
type Semver = {
  core: readonly [number, number, number]
  prerelease: readonly string[]
}

function parseSemver(version: string): Semver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a > b ? 1 : -1
  }
  return 0
}

export function newerVersion(installed: string, latest: string): boolean {
  const current = parseSemver(installed)
  const candidate = parseSemver(latest)
  if (current === undefined || candidate === undefined) return false
  for (let index = 0; index < current.core.length; index += 1) {
    if (candidate.core[index] !== current.core[index]) return candidate.core[index]! > current.core[index]!
  }
  return comparePrerelease(candidate.prerelease, current.prerelease) > 0
}

const OFFICIAL_TURN_NAVIGATOR_MIN_VERSION = '0.1.2-alpha.2'

/** 官方轮次导航从 DSH alpha.2 起成为运行时能力；版本判断不依赖其私有 DOM。 */
export function supportsOfficialTurnNavigator(version: string): boolean {
  return version === OFFICIAL_TURN_NAVIGATOR_MIN_VERSION
    || newerVersion(OFFICIAL_TURN_NAVIGATOR_MIN_VERSION, version)
}

/** 只读取本地运行时清单，不访问 npm registry。 */
export async function runtimeSupportsOfficialTurnNavigator(runtime: DependencyRuntime = resolveDependencyRuntime()): Promise<boolean> {
  const version = await installedPackageVersion('@deepseek-ai/dsh', runtime)
  return version !== undefined && supportsOfficialTurnNavigator(version)
}

export function resolveDshCliEntry(entry = process.argv[1], cwd = process.cwd()): string {
  if (entry === undefined || entry === '') throw new Error('无法定位 DSH CLI。请从 DSH 命令启动 Web 服务后重试。')
  if (entry.startsWith('file:')) return fileURLToPath(entry)
  return resolve(cwd, entry)
}
