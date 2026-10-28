import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
//#region src/business-api.ts
const CODEX_UI_API_BASE = "/api/dsh-codex-ui";
const CODEX_UI_API_ENDPOINTS = Object.freeze({
	connectors: `${CODEX_UI_API_BASE}/connectors`,
	capabilities: `${CODEX_UI_API_BASE}/capabilities`,
	openInExplorer: `${CODEX_UI_API_BASE}/open-in-explorer`,
	preferences: `${CODEX_UI_API_BASE}/preferences`,
	sessionMove: `${CODEX_UI_API_BASE}/session-move`
});
//#endregion
//#region src/runtime-capabilities.ts
/** 只读的运行时能力探测：识别当前 Profile/运行时里安装的 DSH 版本，不参与插件安装或更新。 */
function optionalService(ctx, name) {
	if (ctx === void 0) return void 0;
	return typeof ctx.get === "function" ? ctx.get(name) : ctx[name];
}
function validProfileName(value) {
	return typeof value === "string" && value !== "" && value !== "." && value !== ".." && value !== "node_modules" && !value.includes("/") && !value.includes("\\") && !/[\0-\x1f\x7f]/.test(value);
}
function profileNameFromArgv(argv) {
	for (let index = 2; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--profile") return argv[index + 1];
		if (argument?.startsWith("--profile=")) return argument.slice(10);
	}
	return argv[2] === "web" ? "web" : void 0;
}
/**
* Desktop 通过可选 Host service 暴露当前 profile；普通 Web/CLI 继续使用
* DSH_PROFILE_DIR、命令行 profile 与默认 web profile。
*/
function resolveDependencyRuntime(ctx, options = {}) {
	const env = options.env ?? process.env;
	const argv = options.argv ?? process.argv;
	const cwd = options.cwd ?? process.cwd();
	const home = options.homeDir ?? homedir();
	const profiles = optionalService(ctx, "desktopProfiles");
	const desktopPnpm = optionalService(ctx, "desktopPnpm");
	if (profiles === void 0 && desktopPnpm !== void 0) throw new Error("DSH Desktop Profile 服务尚未就绪，请重启 Desktop 后重试。");
	if (profiles !== void 0) {
		const current = profiles.current;
		if (!validProfileName(current?.name) || typeof current.dir !== "string" || !isAbsolute(current.dir)) throw new Error("DSH Desktop 当前 Profile 信息无效，请重启 Desktop 后重试。");
		if (typeof desktopPnpm?.runPlugin !== "function") throw new Error("DSH Desktop 包管理服务尚未就绪，请重启 Desktop 后重试。");
		const profileDir = resolve(current.dir);
		const runtimeRoots = typeof env.DSH_RUNTIME_DIR === "string" && isAbsolute(env.DSH_RUNTIME_DIR) ? [resolve(env.DSH_RUNTIME_DIR)] : [];
		return {
			environmentKind: "desktop",
			profileName: current.name,
			profileDir,
			runtimeRoots,
			desktopPnpm
		};
	}
	const launched = optionalService(ctx, "profileContext");
	const launchedDir = typeof launched?.dir === "string" && isAbsolute(launched.dir) ? resolve(launched.dir) : void 0;
	const launchedName = validProfileName(launched?.name) ? launched.name : void 0;
	const hostProfileDir = isOfficialDesktopHostEntry(argv[1]) && existsSync(resolve(cwd, "package.json")) ? resolve(cwd) : void 0;
	const profileDir = launchedDir ?? hostProfileDir ?? resolve(env.DSH_PROFILE_DIR ?? resolve(home, ".dsh", "profiles", "web"));
	const selected = profileNameFromArgv(argv);
	const profileName = launchedName ?? (validProfileName(selected) ? selected : validProfileName(basename(profileDir)) ? basename(profileDir) : "web");
	const cliEntry = resolveCliFromInstallAnchor(launched?.installAnchor) ?? resolveCliBesideDesktopHost(argv[1]);
	const cliRuntimeRoot = argv[1] === void 0 ? void 0 : resolveDshRuntimeRoot(argv[1], cwd);
	const anchorRoot = cliEntry === void 0 ? void 0 : resolveDshRuntimeRoot(cliEntry);
	const runtimeRoots = [
		env.DSH_RUNTIME_DIR,
		anchorRoot,
		cliRuntimeRoot
	].filter((root) => root !== void 0 && root !== "");
	const pluginEnv = stringEnvironment(launched?.packageManager?.env);
	const packageManager = profilePackageManager(launched?.packageManager) ?? desktopPackageManagerFromArgv(argv);
	return {
		environmentKind: "cli",
		profileName,
		profileDir,
		runtimeRoots,
		...cliEntry === void 0 ? {} : { cliEntry },
		...pluginEnv === void 0 ? {} : { pluginEnv },
		...packageManager === void 0 ? {} : { packageManager }
	};
}
function profilePackageManager(value) {
	if (typeof value?.command !== "string" || value.command === "") return void 0;
	if (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string")) return void 0;
	const env = stringEnvironment(value.env);
	return {
		command: value.command,
		args: value.args,
		...env === void 0 ? {} : { env }
	};
}
/** 官方 Desktop Host 把 pnpm 入口放在 argv[5]，bin 放在 argv[6]，不提供 desktopPnpm。 */
function desktopPackageManagerFromArgv(argv, command = process.execPath) {
	if (!isOfficialDesktopHostEntry(argv[1])) return void 0;
	const pnpm = argv[5];
	if (typeof pnpm !== "string" || !isAbsolute(pnpm) || !existsSync(pnpm)) return void 0;
	const bin = argv[6];
	const path = typeof bin === "string" && bin !== "" ? `${bin}${delimiter}${process.env.PATH ?? ""}` : process.env.PATH;
	return {
		command,
		args: ["--expose-internals", pnpm],
		env: {
			ELECTRON_RUN_AS_NODE: "1",
			...typeof path === "string" && path !== "" ? { PATH: path } : {}
		}
	};
}
function stringEnvironment(value) {
	if (value === null || typeof value !== "object") return void 0;
	const env = {};
	for (const [key, item] of Object.entries(value)) if (typeof item === "string") env[key] = item;
	return Object.keys(env).length === 0 ? void 0 : env;
}
/** 从公开 profileContext.installAnchor 读出 dsh bin，不把 Desktop Host 入口当成 CLI。 */
function resolveCliFromInstallAnchor(anchor) {
	if (typeof anchor !== "string" || anchor === "" || !isAbsolute(anchor)) return void 0;
	try {
		const bin = JSON.parse(readFileSync(anchor, "utf8")).bin;
		const relative = typeof bin === "string" ? bin : bin !== null && typeof bin === "object" && typeof bin.dsh === "string" ? bin.dsh : void 0;
		if (relative === void 0 || relative === "") return void 0;
		const entry = resolve(dirname(anchor), relative);
		return existsSync(entry) ? entry : void 0;
	} catch {
		return;
	}
}
/** 官方 Desktop Host 是 Electron 的 IPC 子进程；父进程只接受带 type 的事件。 */
function isOfficialDesktopHostEntry(entry = process.argv[1]) {
	if (entry === void 0 || entry === "") return false;
	return entry.replaceAll("\\", "/").includes("/dsh-desktop-host/");
}
/** 从公开包布局定位同一次安装里的 dsh CLI，不读取 launcher 私有 service。 */
function resolveCliBesideDesktopHost(entry = process.argv[1]) {
	if (!isOfficialDesktopHostEntry(entry)) return void 0;
	const index = entry.replaceAll("\\", "/").toLowerCase().lastIndexOf("/node_modules/@deepseek-ai/dsh-desktop-host/");
	if (index < 0) return void 0;
	return resolveCliFromInstallAnchor(resolve(entry.slice(0, index), "node_modules", "@deepseek-ai", "dsh", "package.json"));
}
function profileDirectory(runtime) {
	return runtime.profileDir;
}
function isOfficialRuntimePackage(packageName) {
	return packageName === "@deepseek-ai/dsh" || packageName.startsWith("@deepseek-ai/dsh-");
}
/** 从全局 npm 安装的 dsh CLI 入口反推出包含 node_modules 的运行时目录；源码启动不匹配该目录结构。 */
function resolveDshRuntimeRoot(entry = process.argv[1], cwd = process.cwd()) {
	if (entry === void 0 || entry === "") return void 0;
	const cliEntry = resolveDshCliEntry(entry, cwd);
	const marker = [
		"node_modules",
		"@deepseek-ai",
		"dsh"
	].join(sep);
	const index = cliEntry.toLowerCase().lastIndexOf(marker.toLowerCase());
	if (index === -1) return void 0;
	const end = index + marker.length;
	if (end !== cliEntry.length && cliEntry[end] !== sep) return void 0;
	const root = cliEntry.slice(0, index);
	return root.endsWith(sep) ? root.slice(0, -1) : root;
}
function packageLookupRoots(packageName, runtime) {
	if (!isOfficialRuntimePackage(packageName)) return [profileDirectory(runtime)];
	return [.../* @__PURE__ */ new Set([...runtime.runtimeRoots, profileDirectory(runtime)])];
}
async function installedPackageVersion(packageName, runtime) {
	for (const root of packageLookupRoots(packageName, runtime)) try {
		const manifest = JSON.parse(await readFile(resolve(root, "node_modules", ...packageName.split("/"), "package.json"), "utf8"));
		if (typeof manifest.version === "string" && manifest.version !== "") return manifest.version;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
function parseSemver(version) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
	if (match === null) return void 0;
	return {
		core: [
			Number(match[1]),
			Number(match[2]),
			Number(match[3])
		],
		prerelease: match[4] === void 0 ? [] : match[4].split(".")
	};
}
function comparePrerelease(left, right) {
	if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (a === void 0 || b === void 0) return a === b ? 0 : a === void 0 ? -1 : 1;
		if (a === b) continue;
		const aNumeric = /^\d+$/.test(a);
		const bNumeric = /^\d+$/.test(b);
		if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return a > b ? 1 : -1;
	}
	return 0;
}
function newerVersion(installed, latest) {
	const current = parseSemver(installed);
	const candidate = parseSemver(latest);
	if (current === void 0 || candidate === void 0) return false;
	for (let index = 0; index < current.core.length; index += 1) if (candidate.core[index] !== current.core[index]) return candidate.core[index] > current.core[index];
	return comparePrerelease(candidate.prerelease, current.prerelease) > 0;
}
const OFFICIAL_TURN_NAVIGATOR_MIN_VERSION = "0.1.2-alpha.2";
/** 官方轮次导航从 DSH alpha.2 起成为运行时能力；版本判断不依赖其私有 DOM。 */
function supportsOfficialTurnNavigator(version) {
	return version === OFFICIAL_TURN_NAVIGATOR_MIN_VERSION || newerVersion(OFFICIAL_TURN_NAVIGATOR_MIN_VERSION, version);
}
/** 只读取本地运行时清单，不访问 npm registry。 */
async function runtimeSupportsOfficialTurnNavigator(runtime = resolveDependencyRuntime()) {
	const version = await installedPackageVersion("@deepseek-ai/dsh", runtime);
	return version !== void 0 && supportsOfficialTurnNavigator(version);
}
function resolveDshCliEntry(entry = process.argv[1], cwd = process.cwd()) {
	if (entry === void 0 || entry === "") throw new Error("无法定位 DSH CLI。请从 DSH 命令启动 Web 服务后重试。");
	if (entry.startsWith("file:")) return fileURLToPath(entry);
	return resolve(cwd, entry);
}
//#endregion
//#region src/explorer-path-policy.ts
function normalizedWindowsPath(path) {
	if (!win32.isAbsolute(path)) return void 0;
	const normalized = win32.normalize(path.trim()).replace(/[\\/]+$/, "");
	const root = win32.parse(normalized).root;
	if (root.startsWith("\\\\") || normalized.toLocaleLowerCase("en-US") === root.replace(/[\\/]+$/, "").toLocaleLowerCase("en-US")) return;
	return normalized;
}
/**
* 仅允许打开注册表中已有的工作区根目录。
* 不接受子目录、盘符根或 UNC，避免同源页面把 Host 端点当成任意路径启动器。
*/
function authorizedExplorerWorkspacePath(path, workspaceRoots) {
	const target = normalizedWindowsPath(path);
	if (target === void 0) return void 0;
	const targetKey = target.toLocaleLowerCase("en-US");
	for (const root of workspaceRoots) {
		const normalizedRoot = normalizedWindowsPath(root);
		if (normalizedRoot !== void 0 && normalizedRoot.toLocaleLowerCase("en-US") === targetKey) return normalizedRoot;
	}
}
//#endregion
//#region src/host-services.ts
function requireService(ctx, key, method) {
	const service = ctx.get(key);
	if (service === null || typeof service !== "object" || typeof service[method] !== "function") throw new Error(`michengai-codex-ui 需要宿主服务 “${key}.${String(method)}”`);
	return service;
}
/** 在唯一的宿主边界校验服务能力；宿主 API 变更时立即失败，不会静默返回 503。 */
function hostServices(ctx) {
	const emit = ctx.emit;
	return {
		webServer: requireService(ctx, "webServer", "register"),
		agents: requireService(ctx, "agents", "get"),
		sessions: requireService(ctx, "sessions", "get"),
		sessionPersistence: requireService(ctx, "sessionPersistence", "list"),
		tools: requireService(ctx, "tools", "schemas"),
		workspaceRegistry: requireService(ctx, "workspaceRegistry", "list"),
		sessionProjectionCache: ctx.get("sessionProjectionCache"),
		emit: (event, ...args) => {
			emit.call(ctx, event, ...args);
		},
		logger: {
			warn: (message) => {
				ctx.logger.warn("%s", message);
			},
			info: (message) => {
				ctx.logger.info("%s", message);
			}
		}
	};
}
//#endregion
//#region src/native-explorer.ts
const WINDOWS_EXPLORER_TIMEOUT_MS = 8e3;
const WINDOWS_FOREGROUND_EXPLORER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DcuWindowFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

$shell = New-Object -ComObject Shell.Application

function Find-ExplorerWindow([string]$path) {
  foreach ($item in @($shell.Windows())) {
    try {
      $candidate = [IO.Path]::GetFullPath([string]$item.Document.Folder.Self.Path).TrimEnd('\')
      if ($candidate -ieq $path) { return $item }
    } catch {}
  }
  return $null
}

function Open-ExplorerInForeground([string]$target) {
  $target = [IO.Path]::GetFullPath($target).TrimEnd('\')
  $window = Find-ExplorerWindow $target
  if ($null -eq $window) {
    $shell.Explore($target)
    for ($attempt = 0; $attempt -lt 120 -and $null -eq $window; $attempt += 1) {
      Start-Sleep -Milliseconds 25
      $window = Find-ExplorerWindow $target
    }
  }
  if ($null -eq $window) { throw 'Explorer window was not found.' }

  $handle = [IntPtr]([long]$window.HWND)
  $foreground = [DcuWindowFocus]::GetForegroundWindow()
  $foregroundProcessId = 0
  $foregroundThread = [DcuWindowFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
  $currentThread = [DcuWindowFocus]::GetCurrentThreadId()
  $attached = $foregroundThread -ne 0 -and [DcuWindowFocus]::AttachThreadInput($currentThread, $foregroundThread, $true)
  try {
    [void][DcuWindowFocus]::ShowWindowAsync($handle, 3)
    [void][DcuWindowFocus]::BringWindowToTop($handle)
    if (-not [DcuWindowFocus]::SetForegroundWindow($handle)) { throw 'Explorer could not be activated.' }
  } finally {
    if ($attached) { [void][DcuWindowFocus]::AttachThreadInput($currentThread, $foregroundThread, $false) }
  }
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $parts = $line.Split([char]9, 2)
  $requestId = $parts[0]
  try {
    if ($parts.Count -ne 2) { throw 'Invalid request.' }
    $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    Open-ExplorerInForeground $target
    [Console]::Out.WriteLine(('OK' + [char]9 + $requestId))
  } catch {
    $message = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message))
    [Console]::Out.WriteLine(('ERR' + [char]9 + $requestId + [char]9 + $message))
  }
  [Console]::Out.Flush()
}
`;
/**
* 常驻的 Windows Explorer 前台激活助手。
* PowerShell 与窗口 API 只在 Host 启动时初始化一次，点击时仅发送一行路径请求。
*/
var ForegroundExplorer = class {
	run;
	platform;
	child;
	startupChild;
	starting;
	stdout = "";
	sequence = 0;
	pending = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(run = spawn, platform = process.platform) {
		this.run = run;
		this.platform = platform;
	}
	/** 在用户点击前完成 PowerShell 与窗口 API 初始化。 */
	warmup() {
		if (this.platform !== "win32") return Promise.resolve();
		return this.ensureStarted().then(() => void 0);
	}
	async open(path) {
		if (this.platform !== "win32") throw new Error("foreground Explorer is only available on Windows");
		if (!isAbsolute(path)) throw new Error("Explorer path must be absolute");
		if (this.disposed) throw new Error("Explorer helper has been disposed");
		const child = await this.ensureStarted();
		const requestId = String(++this.sequence);
		const encodedPath = Buffer.from(path, "utf8").toString("base64");
		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(requestId);
				reject(/* @__PURE__ */ new Error("Explorer activation timed out"));
			}, WINDOWS_EXPLORER_TIMEOUT_MS);
			timeout.unref?.();
			this.pending.set(requestId, {
				resolve,
				reject,
				timeout
			});
			child.stdin.write(`${requestId}\t${encodedPath}\n`, (error) => {
				if (error === null || error === void 0) return;
				const request = this.pending.get(requestId);
				if (request === void 0) return;
				clearTimeout(request.timeout);
				this.pending.delete(requestId);
				request.reject(error);
			});
		});
	}
	dispose() {
		this.disposed = true;
		this.failAll(/* @__PURE__ */ new Error("Explorer helper has been disposed"));
		this.startupChild?.kill();
		this.child?.kill();
		this.startupChild = void 0;
		this.child = void 0;
		this.starting = void 0;
	}
	ensureStarted() {
		if (this.disposed) return Promise.reject(/* @__PURE__ */ new Error("Explorer helper has been disposed"));
		if (this.child !== void 0) return Promise.resolve(this.child);
		if (this.starting !== void 0) return this.starting;
		const encoded = Buffer.from(WINDOWS_FOREGROUND_EXPLORER_SCRIPT, "utf16le").toString("base64");
		this.starting = new Promise((resolve, reject) => {
			const child = this.run("powershell.exe", [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				encoded
			], { windowsHide: true });
			this.startupChild = child;
			let settled = false;
			const finishStart = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(startupTimeout);
				if (error !== void 0) {
					this.starting = void 0;
					if (this.startupChild === child) this.startupChild = void 0;
					child.kill();
					reject(error);
					return;
				}
				if (this.disposed) {
					this.starting = void 0;
					if (this.startupChild === child) this.startupChild = void 0;
					child.kill();
					reject(/* @__PURE__ */ new Error("Explorer helper has been disposed"));
					return;
				}
				if (this.startupChild === child) this.startupChild = void 0;
				this.child = child;
				this.starting = void 0;
				resolve(child);
			};
			const startupTimeout = setTimeout(() => finishStart(/* @__PURE__ */ new Error("Explorer helper startup timed out")), WINDOWS_EXPLORER_TIMEOUT_MS);
			startupTimeout.unref?.();
			child.stdout.on("data", (chunk) => {
				this.stdout += String(chunk);
				let newline = this.stdout.indexOf("\n");
				while (newline >= 0) {
					const line = this.stdout.slice(0, newline).trimEnd();
					this.stdout = this.stdout.slice(newline + 1);
					if (line === "READY") finishStart();
					else this.handleResponse(line);
					newline = this.stdout.indexOf("\n");
				}
			});
			child.once("error", (error) => finishStart(error));
			child.once("exit", () => {
				if (!settled) finishStart(/* @__PURE__ */ new Error("Explorer helper exited during startup"));
				if (this.child === child) this.child = void 0;
				this.failAll(/* @__PURE__ */ new Error("Explorer helper exited"));
			});
		});
		return this.starting;
	}
	handleResponse(line) {
		const [status, requestId, encodedMessage] = line.split("	");
		const request = requestId === void 0 ? void 0 : this.pending.get(requestId);
		if (request === void 0) return;
		clearTimeout(request.timeout);
		this.pending.delete(requestId);
		if (status === "OK") {
			request.resolve();
			return;
		}
		const message = encodedMessage === void 0 ? "Explorer activation failed" : Buffer.from(encodedMessage, "base64").toString("utf8");
		request.reject(new Error(message));
	}
	failAll(error) {
		for (const request of this.pending.values()) {
			clearTimeout(request.timeout);
			request.reject(error);
		}
		this.pending.clear();
	}
};
//#endregion
//#region src/session-migration.ts
var SessionMoveError = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "SessionMoveError";
	}
};
const movingSessions = /* @__PURE__ */ new Set();
const ZSTD_MAGIC = 4247762216;
/** 旧宿主 list() 直接给会话头；0.1.6 起返回 { header, revision }。 */
function persistedSessionHeader(item) {
	if (item === null || typeof item !== "object") return void 0;
	const record = item;
	if (typeof record.id === "string" && record.id.length > 0) return record;
	const nested = record.header;
	if (nested !== null && typeof nested === "object") {
		const header = nested;
		if (typeof header.id === "string" && header.id.length > 0) return header;
	}
}
async function listPersistedHeader(persistence, sessionId) {
	for (const item of await persistence.list()) {
		const header = persistedSessionHeader(item);
		if (header?.id === sessionId) return header;
	}
}
function isMissingArtifact(error) {
	if (error.code === "ENOENT") return true;
	return error.name === "SessionPersistenceNotFoundError";
}
function missingArtifactError(error) {
	return new SessionMoveError("session-move/session-not-found", "读取会话持久化记录失败。", error === void 0 ? void 0 : { cause: error });
}
async function loadStoredSession(persistence, sessionId) {
	try {
		if (typeof persistence.loadStored === "function") return persistence.loadStored(sessionId);
		if (typeof persistence.open !== "function") return void 0;
		const handle = await persistence.open(sessionId, "read");
		try {
			const { events } = await handle.read();
			return {
				meta: handle.header,
				events,
				inheritedEventCount: handle.inheritedEventCount
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isMissingArtifact(error)) throw missingArtifactError(error);
		throw error;
	}
}
function locateArtifact(persistence, meta) {
	if (typeof persistence.locate !== "function") return void 0;
	return persistence.locate(meta);
}
async function resolveArtifactPath(persistence, sessionId, meta) {
	const located = locateArtifact(persistence, meta);
	if (located?.path !== void 0 && located.path !== "") return located.path;
	if (typeof persistence.resolveCurrentLog === "function") return persistence.resolveCurrentLog(sessionId);
}
function firstZstdFrameEnd(buffer) {
	if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return void 0;
	let offset = 4;
	if (offset >= buffer.length) return void 0;
	const descriptor = buffer.readUInt8(offset);
	offset += 1;
	if ((descriptor & 24) !== 0) return void 0;
	const contentSizeFlag = descriptor >>> 6;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryFlag = descriptor & 3;
	const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
	const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
	offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	for (;;) {
		if (buffer.length - offset < 3) return void 0;
		const blockHeader = buffer.readUIntLE(offset, 3);
		offset += 3;
		const lastBlock = (blockHeader & 1) !== 0;
		const blockType = blockHeader >>> 1 & 3;
		const blockSize = blockHeader >>> 3;
		if (blockType === 3) return void 0;
		const payloadBytes = blockType === 1 ? 1 : blockSize;
		if (buffer.length - offset < payloadBytes) return void 0;
		offset += payloadBytes;
		if (lastBlock) break;
	}
	if (checksum) {
		if (buffer.length - offset < 4) return void 0;
		offset += 4;
	}
	return offset;
}
async function zlibZstd(name, data, options) {
	const transform = (await import("node:zlib"))[name];
	if (typeof transform !== "function") throw new SessionMoveError("session-move/zstd-unavailable", "当前 Node.js 运行时不支持 Zstd 会话迁移。");
	return new Promise((resolvePromise, rejectPromise) => {
		const done = (error, output) => {
			if (error === null) resolvePromise(output);
			else rejectPromise(error);
		};
		if (options === void 0) transform(data, done);
		else transform(data, options, done);
	});
}
async function zstdChecksumOptions() {
	const { constants } = await import("node:zlib");
	const flag = constants.ZSTD_c_checksumFlag;
	return typeof flag === "number" ? { params: { [flag]: 1 } } : void 0;
}
function isSessionGenerationFilename(name) {
	return /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(name);
}
async function decodeArtifactFile(path) {
	let bytes;
	try {
		bytes = await readFile(path);
	} catch (error) {
		if (isMissingArtifact(error)) throw missingArtifactError(error);
		throw error;
	}
	if (!(path.endsWith(".zstd") || bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC)) {
		const text = bytes.toString("utf8");
		const newlineIndex = text.indexOf("\n");
		return {
			firstLine: newlineIndex < 0 ? text : text.slice(0, newlineIndex),
			body: newlineIndex < 0 ? "" : text.slice(newlineIndex + 1),
			zstd: false
		};
	}
	const frameEnd = firstZstdFrameEnd(bytes);
	if (frameEnd === void 0) throw new SessionMoveError("session-move/artifact-invalid", "会话工件头部无法解析。");
	return {
		firstLine: (await zlibZstd("zstdDecompress", bytes.subarray(0, frameEnd))).toString("utf8").replace(/\n$/, ""),
		body: "",
		zstd: true,
		trailingZstd: bytes.subarray(frameEnd)
	};
}
async function readSessionArtifact(persistence, sessionId, meta) {
	try {
		const path = await resolveArtifactPath(persistence, sessionId, meta);
		if (path === void 0) throw new SessionMoveError("session-move/path-invalid", "宿主无法定位会话工件。");
		if (typeof persistence.readRaw === "function") {
			const raw = await persistence.readRaw(sessionId);
			if (raw === void 0) throw missingArtifactError();
			const newlineIndex = raw.content.indexOf("\n");
			return {
				path,
				decoded: {
					firstLine: newlineIndex < 0 ? raw.content : raw.content.slice(0, newlineIndex),
					body: newlineIndex < 0 ? "" : raw.content.slice(newlineIndex + 1),
					zstd: path.endsWith(".zstd")
				}
			};
		}
		return {
			path,
			decoded: await decodeArtifactFile(path)
		};
	} catch (error) {
		if (error instanceof SessionMoveError) throw error;
		if (isMissingArtifact(error)) throw missingArtifactError(error);
		throw error;
	}
}
async function encodeRewrittenArtifact(firstLine, decoded, encodeArtifact) {
	if (decoded.zstd && decoded.trailingZstd !== void 0) {
		const headerFrame = await zlibZstd("zstdCompress", Buffer.from(`${firstLine}\n`, "utf8"), await zstdChecksumOptions());
		return Buffer.concat([headerFrame, decoded.trailingZstd]);
	}
	return encodeArtifact(firstLine, decoded.body, decoded.zstd);
}
function rawSessionIds(workspace) {
	return Array.isArray(workspace.record?.sessionIds) ? workspace.record.sessionIds : workspace.sessionIds;
}
function validIdentifier(value) {
	return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
async function pathExists(path) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
async function writeTemporaryFile(finalPath, data) {
	const temporaryPath = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await open(temporaryPath, "wx", 384);
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return temporaryPath;
}
async function encodeSessionArtifact(headerLine, body, zstd) {
	if (!zstd) return Buffer.from(`${headerLine}\n${body}`, "utf8");
	const options = await zstdChecksumOptions();
	const headerFrame = await zlibZstd("zstdCompress", Buffer.from(`${headerLine}\n`, "utf8"), options);
	if (body === "") return headerFrame;
	const bodyFrame = await zlibZstd("zstdCompress", Buffer.from(body, "utf8"), options);
	return Buffer.concat([headerFrame, bodyFrame]);
}
var ArtifactDirectoryMove = class {
	oldArtifact;
	newArtifact;
	directoryMoved = false;
	backupCreated = false;
	published = false;
	temporaryPath;
	extraBackups = [];
	oldDirectory;
	newDirectory;
	movedOldArtifact;
	backupArtifact;
	constructor(oldArtifact, newArtifact) {
		this.oldArtifact = oldArtifact;
		this.newArtifact = newArtifact;
		this.oldDirectory = dirname(oldArtifact);
		this.newDirectory = dirname(newArtifact);
		const relativeArtifact = relative(this.oldDirectory, oldArtifact);
		if (relativeArtifact.startsWith("..") || resolve(this.oldDirectory, relativeArtifact) !== resolve(oldArtifact)) throw new SessionMoveError("session-move/path-invalid", "会话工件路径无效。");
		this.movedOldArtifact = join(this.newDirectory, relativeArtifact);
		this.backupArtifact = join(this.newDirectory, `${basename(oldArtifact)}.${randomBytes(6).toString("hex")}.dcu-backup`);
	}
	async publish(bytes, siblings) {
		if (resolve(this.oldDirectory).toLowerCase() === resolve(this.newDirectory).toLowerCase()) throw new SessionMoveError("session-move/path-conflict", "源项目和目标项目使用了相同的会话目录。");
		if (await pathExists(this.newDirectory)) throw new SessionMoveError("session-move/destination-occupied", "目标项目已经存在同名会话工件。");
		try {
			await mkdir(dirname(this.newDirectory), { recursive: true });
			await rename(this.oldDirectory, this.newDirectory);
			this.directoryMoved = true;
			await rename(this.movedOldArtifact, this.backupArtifact);
			this.backupCreated = true;
			this.temporaryPath = await writeTemporaryFile(this.newArtifact, bytes);
			await rename(this.temporaryPath, this.newArtifact);
			this.temporaryPath = void 0;
			this.published = true;
			if (siblings !== void 0) await this.rewriteSiblingGenerations(siblings);
		} catch (error) {
			try {
				await this.rollback();
			} catch (rollbackError) {
				throw new SessionMoveError("session-move/rollback-failed", "迁移会话工件失败，且自动回滚未完整完成。", { cause: rollbackError });
			}
			if (error instanceof SessionMoveError) throw error;
			throw new SessionMoveError("session-move/artifact-failed", "迁移会话工件失败，原会话已恢复。", { cause: error });
		}
	}
	async rewriteSiblingGenerations(siblings) {
		for (const name of await readdir(this.newDirectory)) {
			if (!isSessionGenerationFilename(name)) continue;
			const path = join(this.newDirectory, name);
			if (resolve(path) === resolve(this.newArtifact) || resolve(path) === resolve(this.backupArtifact)) continue;
			let decoded;
			try {
				decoded = await decodeArtifactFile(path);
			} catch {
				continue;
			}
			let header;
			try {
				header = JSON.parse(decoded.firstLine);
			} catch {
				continue;
			}
			if (header.id !== siblings.sessionId) continue;
			const backup = join(this.newDirectory, `${name}.${randomBytes(6).toString("hex")}.dcu-backup`);
			await rename(path, backup);
			this.extraBackups.push({
				path,
				backup
			});
			const rewritten = await encodeRewrittenArtifact(JSON.stringify({
				...header,
				cwd: siblings.targetCwd
			}), decoded, siblings.encodeArtifact);
			this.temporaryPath = await writeTemporaryFile(path, rewritten);
			await rename(this.temporaryPath, path);
			this.temporaryPath = void 0;
		}
	}
	async rollback() {
		const failures = [];
		if (this.temporaryPath !== void 0) {
			try {
				await rm(this.temporaryPath, { force: true });
			} catch (error) {
				failures.push(error);
			}
			this.temporaryPath = void 0;
		}
		for (const extra of this.extraBackups.splice(0).reverse()) {
			try {
				await rm(extra.path, { force: true });
			} catch (error) {
				failures.push(error);
			}
			try {
				await rename(extra.backup, extra.path);
			} catch (error) {
				failures.push(error);
			}
		}
		if (this.published) try {
			await rm(this.newArtifact, { force: true });
			this.published = false;
		} catch (error) {
			failures.push(error);
		}
		if (this.backupCreated) try {
			await rename(this.backupArtifact, this.movedOldArtifact);
			this.backupCreated = false;
		} catch (error) {
			failures.push(error);
		}
		if (this.directoryMoved) try {
			await mkdir(dirname(this.oldDirectory), { recursive: true });
			await rename(this.newDirectory, this.oldDirectory);
			this.directoryMoved = false;
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new AggregateError(failures, "会话工件回滚失败");
	}
	async commit(logger) {
		const leftovers = [...this.backupCreated ? [this.backupArtifact] : [], ...this.extraBackups.splice(0).map((extra) => extra.backup)];
		this.backupCreated = false;
		for (const backup of leftovers) try {
			await rm(backup, { force: true });
		} catch (error) {
			logger?.warn(`会话迁移成功，但旧工件备份清理失败：${String(error)}`);
		}
	}
};
function workspaceSnapshots(workspaces, sessionId) {
	return workspaces.map((workspace) => {
		const ids = [...rawSessionIds(workspace)];
		const index = ids.indexOf(sessionId);
		return {
			workspace,
			contained: index >= 0,
			beforeId: index >= 0 ? ids[index + 1] : void 0
		};
	});
}
async function restoreWorkspaceSnapshots(snapshots, sessionId) {
	for (const snapshot of snapshots) if (!snapshot.contained && rawSessionIds(snapshot.workspace).includes(sessionId)) await snapshot.workspace.detachSession(sessionId);
	for (const snapshot of snapshots) {
		if (!snapshot.contained) continue;
		if (!rawSessionIds(snapshot.workspace).includes(sessionId)) await snapshot.workspace.attachSession(sessionId);
		const currentIds = rawSessionIds(snapshot.workspace);
		const beforeId = snapshot.beforeId !== void 0 && currentIds.includes(snapshot.beforeId) ? snapshot.beforeId : void 0;
		await snapshot.workspace.insertSessionBefore(sessionId, beforeId);
	}
}
async function enterStoredSession(services, sessionId, stored) {
	const preparation = services.sessionPersistence.prepare === void 0 ? void 0 : await services.sessionPersistence.prepare(sessionId);
	const session = preparation?.session ?? services.sessions.prepare(sessionId, {
		seedSource: "persistence",
		seed: stored.events,
		meta: stored.meta,
		inheritedEventCount: stored.inheritedEventCount
	});
	const detach = services.sessions.enter(session);
	try {
		services.sessions.announce?.(session);
	} catch (error) {
		detach();
		preparation?.[Symbol.dispose]();
		throw error;
	}
	return {
		detach,
		releasePreparation: () => {
			preparation?.[Symbol.dispose]();
		}
	};
}
function detachOriginalEntry(store, sessionId, entry) {
	if (store === void 0 || entry === void 0 || store.get(sessionId) !== entry) return;
	if (entry.detach === void 0) throw new SessionMoveError("session-move/service-unavailable", "宿主无法安全释放原会话入口。");
	entry.detach();
	if (store.get(sessionId) === entry) throw new SessionMoveError("session-move/quiesce-failed", "原会话入口未能完整释放。");
}
async function rollbackMove(services, sessionId, transaction, snapshots, originalStored, originalEntry, enteredPlaceholder) {
	const failures = [];
	try {
		enteredPlaceholder?.detach();
	} catch (error) {
		failures.push(error);
	}
	try {
		enteredPlaceholder?.releasePreparation();
	} catch (error) {
		failures.push(error);
	}
	try {
		await transaction.rollback();
	} catch (error) {
		failures.push(error);
	}
	let restored;
	try {
		if (services.sessions.get(sessionId) === void 0) restored = await enterStoredSession(services, sessionId, originalStored);
		await restoreWorkspaceSnapshots(snapshots, sessionId);
	} catch (error) {
		failures.push(error);
	} finally {
		try {
			if (originalEntry === void 0) restored?.detach();
			restored?.releasePreparation();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "会话迁移回滚失败");
}
async function moveAccounting(target, snapshots, sessionId) {
	for (const snapshot of snapshots) if (snapshot.workspace.id !== target.id && snapshot.contained) await snapshot.workspace.detachSession(sessionId);
	await target.attachSession(sessionId);
}
/**
* 把持久化会话完整迁移到目标项目。整个会话目录一起移动，当前代际和同目录旧代际的 cwd 一并改写；任何提交前失败都会恢复原工件和项目顺序。
*/
async function moveSessionToWorkspace(services, sessionId, targetWorkspaceId, options = {}) {
	if (!validIdentifier(sessionId) || !validIdentifier(targetWorkspaceId)) throw new SessionMoveError("session-move/invalid-request", "会话或目标项目标识无效。");
	if (movingSessions.has(sessionId)) throw new SessionMoveError("session-move/busy", "该会话正在移动，请稍后重试。");
	movingSessions.add(sessionId);
	try {
		const workspaces = services.workspaceRegistry.list();
		const target = workspaces.find((workspace) => workspace.id === targetWorkspaceId);
		if (target === void 0) throw new SessionMoveError("session-move/workspace-not-found", "目标项目不存在。");
		const snapshots = workspaceSnapshots(workspaces, sessionId);
		const targetSnapshot = snapshots.find((snapshot) => snapshot.workspace.id === target.id);
		const sources = snapshots.filter((snapshot) => snapshot.contained && snapshot.workspace.id !== target.id);
		if (sources.length > 1 || targetSnapshot?.contained === true && sources.length > 0) throw new SessionMoveError("session-move/accounting-invalid", "会话当前的项目归属不一致，无法安全移动。");
		const persistedHeader = await listPersistedHeader(services.sessionPersistence, sessionId);
		if (persistedHeader === void 0) throw new SessionMoveError("session-move/session-not-found", "该会话没有可迁移的持久化记录。");
		if (persistedHeader.origin === "subagent") throw new SessionMoveError("session-move/subagent-unsupported", "子代理会话不能移动到其他项目。");
		const targetPath = await realpath(target.path);
		let currentPath;
		if (persistedHeader.cwd !== void 0) try {
			currentPath = await realpath(persistedHeader.cwd);
		} catch {
			currentPath = void 0;
		}
		if (currentPath === targetPath && targetSnapshot?.contained === true && sources.length === 0) return {
			sessionId,
			moved: false,
			fromWorkspaceIds: [target.id],
			toWorkspaceId: target.id,
			toWorkspaceTitle: target.title || target.id
		};
		const liveSession = services.sessions.get(sessionId);
		const originalEntry = services.sessions.store?.get(sessionId);
		if (liveSession !== void 0 && (services.sessions.store === void 0 || originalEntry === void 0)) throw new SessionMoveError("session-move/service-unavailable", "宿主无法提供可恢复的会话入口，暂时不能移动活跃会话。");
		if (currentPath === targetPath) {
			const stored = liveSession === void 0 ? await loadStoredSession(services.sessionPersistence, sessionId) : void 0;
			if (liveSession === void 0 && stored === void 0) throw new SessionMoveError("session-move/session-not-found", "读取会话持久化记录失败。");
			let enteredPlaceholder;
			try {
				if (stored !== void 0) enteredPlaceholder = await enterStoredSession(services, sessionId, stored);
				await moveAccounting(target, snapshots, sessionId);
			} catch (error) {
				try {
					await restoreWorkspaceSnapshots(snapshots, sessionId);
				} catch (rollbackError) {
					throw new SessionMoveError("session-move/rollback-failed", "恢复项目归属失败。", { cause: rollbackError });
				}
				throw new SessionMoveError("session-move/accounting-failed", "更新项目归属失败，原会话已恢复。", { cause: error });
			} finally {
				enteredPlaceholder?.detach();
				enteredPlaceholder?.releasePreparation();
			}
			return {
				sessionId,
				moved: true,
				fromWorkspaceIds: sources.map((snapshot) => snapshot.workspace.id),
				toWorkspaceId: target.id,
				toWorkspaceTitle: target.title || target.id
			};
		}
		const agent = services.agents.get(sessionId);
		try {
			if (agent !== void 0) {
				agent.cancel({ kind: "disposed" });
				await agent.whenIdle?.();
			}
			if (liveSession !== void 0) await services.sessions.flush(liveSession);
		} catch (error) {
			throw new SessionMoveError("session-move/quiesce-failed", "会话仍在运行，暂时无法移动。", { cause: error });
		}
		const originalStored = await loadStoredSession(services.sessionPersistence, sessionId);
		if (originalStored === void 0) throw new SessionMoveError("session-move/session-not-found", "读取会话持久化记录失败。");
		const artifact = await readSessionArtifact(services.sessionPersistence, sessionId, persistedHeader);
		let header;
		try {
			header = JSON.parse(artifact.decoded.firstLine);
		} catch (error) {
			throw new SessionMoveError("session-move/artifact-invalid", "会话工件头部无法解析。", { cause: error });
		}
		if (header.id !== sessionId) throw new SessionMoveError("session-move/artifact-invalid", "会话工件标识与请求不一致。");
		const targetHeader = {
			...header,
			cwd: targetPath
		};
		const targetMeta = {
			...originalStored.meta,
			cwd: targetPath
		};
		const newPath = locateArtifact(services.sessionPersistence, targetMeta)?.path;
		if (newPath === void 0) throw new SessionMoveError("session-move/path-invalid", "宿主无法定位会话工件。");
		const encoder = options.encodeArtifact ?? encodeSessionArtifact;
		const bytes = await encodeRewrittenArtifact(JSON.stringify(targetHeader), artifact.decoded, encoder);
		const transaction = new ArtifactDirectoryMove(artifact.path, newPath);
		try {
			await agent?.scope?.dispose?.();
			services.agents.store?.delete(sessionId);
			detachOriginalEntry(services.sessions.store, sessionId, originalEntry);
		} catch (error) {
			if (originalEntry !== void 0 && services.sessions.get(sessionId) === void 0) try {
				(await enterStoredSession(services, sessionId, originalStored)).releasePreparation();
			} catch (restoreError) {
				throw new SessionMoveError("session-move/rollback-failed", "恢复原会话入口失败。", { cause: restoreError });
			}
			throw new SessionMoveError("session-move/quiesce-failed", "会话仍在运行，暂时无法移动。", { cause: error });
		}
		let enteredPlaceholder;
		try {
			await transaction.publish(bytes, {
				sessionId,
				targetCwd: targetPath,
				encodeArtifact: encoder
			});
			let movedStored;
			try {
				movedStored = await loadStoredSession(services.sessionPersistence, sessionId);
			} catch (error) {
				throw new SessionMoveError("session-move/validation-failed", "迁移后的会话工件校验失败。", { cause: error });
			}
			if (movedStored === void 0 || movedStored.meta.cwd !== targetPath) throw new SessionMoveError("session-move/validation-failed", "迁移后的会话工件校验失败。");
			enteredPlaceholder = await enterStoredSession(services, sessionId, movedStored);
			try {
				await moveAccounting(target, snapshots, sessionId);
			} catch (error) {
				throw new SessionMoveError("session-move/accounting-failed", "更新项目归属失败。", { cause: error });
			}
			enteredPlaceholder.detach();
			enteredPlaceholder.releasePreparation();
			enteredPlaceholder = void 0;
			await transaction.commit(services.logger);
		} catch (error) {
			try {
				await rollbackMove(services, sessionId, transaction, snapshots, originalStored, originalEntry, enteredPlaceholder);
			} catch (rollbackError) {
				throw new SessionMoveError("session-move/rollback-failed", "会话移动失败，且自动回滚未完整完成。", { cause: rollbackError });
			}
			if (error instanceof SessionMoveError) throw error;
			throw new SessionMoveError("session-move/failed", "会话移动失败，原会话已恢复。", { cause: error });
		}
		try {
			await services.sessionProjectionCache?.coldSnapshot?.(sessionId);
		} catch (error) {
			services.logger?.warn(`会话已移动，但投影缓存刷新失败：${String(error)}`);
		}
		services.logger?.info?.(`会话 ${sessionId} 已移动到项目 ${target.id}`);
		return {
			sessionId,
			moved: true,
			fromWorkspaceIds: sources.map((snapshot) => snapshot.workspace.id),
			toWorkspaceId: target.id,
			toWorkspaceTitle: target.title || target.id
		};
	} finally {
		movingSessions.delete(sessionId);
	}
}
//#endregion
//#region src/onboarding-settings.ts
/**
* 停用官方设置壳后，仍登记引导设置。
* 不能 import `@deepseek-ai/dsh-client-ui-settings-general`：裸模块名会向上解析到
* `~/.dsh/profiles/node_modules` 里的 0.1.2 残留，其 `settings.register` 在新宿主上不存在，
* 会让整个渲染进程启动失败。
*/
function registerOnboardingSettings(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		const bound = settingsCtx;
		const settings = bound.settings;
		try {
			if (typeof settings?.configure === "function") return bound.effect(() => {
				const dispose = settings.configure({ auto: false }, ctx.fiber);
				return typeof dispose === "function" ? dispose : () => {};
			});
			ctx.logger.warn("[michengai-codex-ui] 当前宿主缺少 settings.configure 接口，跳过引导设置注册。");
		} catch (error) {
			ctx.logger.warn("[michengai-codex-ui] 引导设置注册已跳过：%s", error);
		}
	});
}
//#endregion
//#region src/workspace-preferences.ts
const WORKSPACE_PREFERENCES_FILE = ".dsh-codex-ui-preferences.json";
/** Desktop 和普通 DSH Web 共用 Profile；服务换端口或重启后目录仍保持稳定。 */
function workspacePreferencesPath(profileDir = process.env.DSH_PROFILE_DIR ?? resolve(homedir(), ".dsh", "profiles", "web")) {
	return resolve(profileDir, WORKSPACE_PREFERENCES_FILE);
}
/** 严格校验来自 HTTP 或磁盘的数据，避免损坏配置被静默写回。 */
function parsePinnedWorkspaceIds(value) {
	if (!Array.isArray(value) || value.length > 1e3) return void 0;
	if (!value.every((id) => typeof id === "string" && id.trim() !== "" && id.length <= 256)) return void 0;
	return [...new Set(value)];
}
/** 版本 1 只有置顶列表；版本 2 文件可能残留已废弃的分组字段，读取时忽略未知字段。 */
function parseWorkspacePreferences(value) {
	if (value === null || typeof value !== "object") return void 0;
	const record = value;
	const pinnedWorkspaceIds = parsePinnedWorkspaceIds(record.pinnedWorkspaceIds);
	if (pinnedWorkspaceIds === void 0) return void 0;
	if (record.version !== 1 && record.version !== 2) return void 0;
	return {
		version: 2,
		pinnedWorkspaceIds
	};
}
async function readWorkspacePreferences(path = workspacePreferencesPath()) {
	try {
		const preferences = parseWorkspacePreferences(JSON.parse(await readFile(path, "utf8")));
		if (preferences === void 0) throw new Error("置顶偏好文件格式无效。");
		return {
			...preferences,
			exists: true
		};
	} catch (error) {
		if (error.code === "ENOENT") return {
			version: 2,
			pinnedWorkspaceIds: [],
			exists: false
		};
		throw error;
	}
}
function temporaryPath(path) {
	return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}
let writeQueue = Promise.resolve();
/** 串行、原子保存，避免快速拖动排序产生乱序或半截 JSON。 */
function writeWorkspacePreferences(pinnedWorkspaceIds, path = workspacePreferencesPath()) {
	const normalized = parsePinnedWorkspaceIds([...pinnedWorkspaceIds]);
	if (normalized === void 0) return Promise.reject(/* @__PURE__ */ new Error("置顶偏好数据无效。"));
	const task = writeQueue.catch(() => void 0).then(async () => {
		await mkdir(dirname(path), { recursive: true });
		const temporary = temporaryPath(path);
		try {
			await writeFile(temporary, `${JSON.stringify({
				version: 2,
				pinnedWorkspaceIds: normalized
			}, void 0, 2)}\n`, "utf8");
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true }).catch(() => void 0);
		}
	});
	writeQueue = task;
	return task;
}
//#endregion
//#region src/index.ts
const connectorsEndpoint = CODEX_UI_API_ENDPOINTS.connectors;
const capabilitiesEndpoint = CODEX_UI_API_ENDPOINTS.capabilities;
const explorerEndpoint = CODEX_UI_API_ENDPOINTS.openInExplorer;
const preferencesEndpoint = CODEX_UI_API_ENDPOINTS.preferences;
const sessionMoveEndpoint = CODEX_UI_API_ENDPOINTS.sessionMove;
const maxPreferencesBodyBytes = 32768;
function headerValue(headers, name) {
	const value = headers[name];
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value[0];
}
var RequestBodyTooLargeError = class extends Error {};
/** 有界读取 Node HTTP body；偏好接口只接受很小的 JSON。 */
async function readRequestBody(request, maxBytes = maxPreferencesBodyBytes) {
	const declared = Number(headerValue(request.headers ?? {}, "content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLargeError("请求体过大。");
	if (request[Symbol.asyncIterator] === void 0) return "";
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > maxBytes) throw new RequestBodyTooLargeError("请求体过大。");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/**
* 所有业务 REST 依赖 connection >=0.1.2-rc.1 的 Host/Origin/Fetch Metadata 与登录检查。
* 必须在读取请求体及执行副作用前调用；不得将 undefined 以外的拒绝结果当作放行。
* 发布包信任边界由 tests/business-rest-auth.assert.ts 的真实宿主契约用例验证。
*/
function authenticateBusinessRequest(ctx, request, response, errorBody = (_status, message) => ({ error: message })) {
	const reject = (status, message) => {
		response.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		});
		response.end(JSON.stringify(errorBody(status, message)));
		return false;
	};
	try {
		const connection = ctx.get("connection");
		if (typeof connection?.requestRejection !== "function") {
			ctx.logger.warn("Codex UI 业务 REST 认证不可用：缺少 connection.requestRejection。");
			return reject(503, "宿主认证服务暂不可用。");
		}
		const rejection = connection.requestRejection(request);
		if (rejection !== void 0) return reject(rejection, rejection === 401 ? "请先登录 DSH。" : "已拒绝不可信或跨站请求。");
		return true;
	} catch (error) {
		const reason = error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
		ctx.logger.warn("Codex UI 业务 REST 认证调用失败：%s", reason);
		return reject(503, "宿主认证服务暂不可用。");
	}
}
const inject = [
	"webServer",
	"agents",
	"tools",
	"workspaceRegistry",
	"sessions",
	"sessionPersistence"
];
function sessionMoveStatus(error) {
	if (!(error instanceof SessionMoveError)) return 500;
	if (error.code === "session-move/invalid-request") return 400;
	if (error.code === "session-move/session-not-found" || error.code === "session-move/workspace-not-found") return 404;
	if (error.code === "session-move/service-unavailable") return 503;
	if (error.code === "session-move/zstd-unavailable") return 501;
	if (error.code === "session-move/busy" || error.code === "session-move/subagent-unsupported" || error.code === "session-move/accounting-invalid" || error.code === "session-move/destination-occupied") return 409;
	return 500;
}
function publicSessionMoveError(error) {
	const code = error instanceof SessionMoveError ? error.code : "session-move/failed";
	return {
		code,
		error: {
			"session-move/invalid-request": "会话或目标项目标识无效。",
			"session-move/session-not-found": "该会话没有可迁移的持久化记录。",
			"session-move/workspace-not-found": "目标项目不存在。",
			"session-move/service-unavailable": "宿主暂时无法安全移动活跃会话。",
			"session-move/subagent-unsupported": "子代理会话不能移动到其他项目。",
			"session-move/busy": "该会话正在移动，请稍后重试。",
			"session-move/accounting-invalid": "会话当前的项目归属不一致，无法安全移动。",
			"session-move/destination-occupied": "目标项目已经存在同名会话工件。",
			"session-move/zstd-unavailable": "当前运行环境不支持该会话的存储格式。",
			"session-move/rollback-failed": "移动失败，自动恢复未完整完成，请查看服务端日志。"
		}[code] ?? "暂时无法移动该会话，请稍后重试。"
	};
}
function sessionMoveAuthenticationError(status, error) {
	return {
		ok: false,
		code: status === 401 ? "session-move/unauthorized" : status === 403 ? "session-move/forbidden" : "session-move/service-unavailable",
		error
	};
}
/** 提供不泄露地址、命令和凭证的连接器目录。 */
function apply(ctx) {
	registerOnboardingSettings(ctx);
	const host = hostServices(ctx);
	ctx.effect(() => {
		const foregroundExplorer = new ForegroundExplorer();
		foregroundExplorer.warmup().catch((error) => ctx.logger.warn("foreground explorer warmup failed: %s", error));
		const disposeConnectors = host.webServer.register({
			kind: "exact",
			path: connectorsEndpoint,
			handler: async (request, response) => {
				if (!authenticateBusinessRequest(ctx, request, response)) return;
				if (request.method !== "GET" && request.method !== "HEAD") {
					response.writeHead(405);
					response.end();
					return;
				}
				try {
					const sessionId = new URL(request.url ?? "/", "http://localhost").searchParams.get("sessionId");
					const scope = sessionId === null ? void 0 : host.agents.get(sessionId);
					const connectors = /* @__PURE__ */ new Map();
					for (const tool of host.tools.schemas(scope)) {
						const match = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(tool.name);
						if (match === null) continue;
						const [, serverName, toolName] = match;
						const tools = connectors.get(serverName) ?? [];
						tools.push({
							name: toolName,
							description: tool.description ?? ""
						});
						connectors.set(serverName, tools);
					}
					const payload = [...connectors].sort(([a], [b]) => a.localeCompare(b)).map(([name, tools]) => ({
						name,
						tools
					}));
					response.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(request.method === "HEAD" ? void 0 : JSON.stringify({ connectors: payload }));
				} catch {
					response.writeHead(503, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({ error: "连接器目录暂不可用。" }));
				}
			}
		});
		const disposeCapabilities = host.webServer.register({
			kind: "exact",
			path: capabilitiesEndpoint,
			handler: async (request, response) => {
				if (!authenticateBusinessRequest(ctx, request, response)) return;
				if (request.method !== "GET") {
					response.writeHead(405);
					response.end();
					return;
				}
				try {
					const capabilities = { officialTurnNavigator: await runtimeSupportsOfficialTurnNavigator(resolveDependencyRuntime(ctx)) };
					response.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({ capabilities }));
				} catch (error) {
					ctx.logger.warn("capabilities endpoint failed: %s", error);
					response.writeHead(503, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({ error: "运行时能力探测暂不可用。" }));
				}
			}
		});
		const disposePreferences = host.webServer.register({
			kind: "exact",
			path: preferencesEndpoint,
			handler: async (request, response) => {
				if (!authenticateBusinessRequest(ctx, request, response)) return;
				try {
					if (request.method === "GET" || request.method === "HEAD") {
						const preferences = await readWorkspacePreferences();
						response.writeHead(200, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						response.end(request.method === "HEAD" ? void 0 : JSON.stringify(preferences));
						return;
					}
					if (request.method === "PUT") {
						const body = JSON.parse(await readRequestBody(request));
						const record = body !== null && typeof body === "object" ? body : void 0;
						const pinnedWorkspaceIds = record === void 0 ? void 0 : parsePinnedWorkspaceIds(record.pinnedWorkspaceIds);
						if (pinnedWorkspaceIds === void 0) {
							response.writeHead(400, {
								"content-type": "application/json; charset=utf-8",
								"cache-control": "no-store"
							});
							response.end(JSON.stringify({ error: "置顶偏好格式无效。" }));
							return;
						}
						await writeWorkspacePreferences(pinnedWorkspaceIds);
						response.writeHead(200, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						response.end(JSON.stringify({
							version: 2,
							pinnedWorkspaceIds,
							exists: true
						}));
						return;
					}
					response.writeHead(405, { allow: "GET, HEAD, PUT" });
					response.end();
				} catch (error) {
					if (error instanceof RequestBodyTooLargeError) {
						response.writeHead(413, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						response.end(JSON.stringify({ error: "请求体过大。" }));
						return;
					}
					if (error instanceof SyntaxError) {
						response.writeHead(400, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						response.end(JSON.stringify({ error: "置顶偏好格式无效。" }));
						return;
					}
					ctx.logger.warn("preferences endpoint failed: %s", error);
					response.writeHead(503, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({ error: "置顶偏好暂不可用。" }));
				}
			}
		});
		const disposeSessionMove = host.webServer.register({
			kind: "exact",
			path: sessionMoveEndpoint,
			handler: async (request, response) => {
				if (!authenticateBusinessRequest(ctx, request, response, sessionMoveAuthenticationError)) return;
				if (request.method !== "POST") {
					response.writeHead(405, { allow: "POST" });
					response.end();
					return;
				}
				try {
					const body = JSON.parse(await readRequestBody(request));
					const record = body !== null && typeof body === "object" ? body : void 0;
					const sessionId = typeof record?.sessionId === "string" ? record.sessionId.trim() : "";
					const targetWorkspaceId = typeof record?.targetWorkspaceId === "string" ? record.targetWorkspaceId.trim() : "";
					const result = await moveSessionToWorkspace(host, sessionId, targetWorkspaceId);
					response.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({
						ok: true,
						result
					}));
				} catch (error) {
					if (error instanceof RequestBodyTooLargeError) {
						response.writeHead(413, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						response.end(JSON.stringify({
							ok: false,
							code: "session-move/invalid-request",
							error: "请求体过大。"
						}));
						return;
					}
					if (error instanceof SyntaxError) {
						response.writeHead(400, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						response.end(JSON.stringify({
							ok: false,
							code: "session-move/invalid-request",
							error: "请求格式无效。"
						}));
						return;
					}
					ctx.logger.warn("session move failed: %s", error);
					const payload = publicSessionMoveError(error);
					response.writeHead(sessionMoveStatus(error), {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({
						ok: false,
						...payload
					}));
				}
			}
		});
		const disposeExplorer = host.webServer.register({
			kind: "exact",
			path: explorerEndpoint,
			handler: async (request, response) => {
				if (!authenticateBusinessRequest(ctx, request, response)) return;
				if (request.method !== "POST") {
					response.writeHead(405, { allow: "POST" });
					response.end();
					return;
				}
				if (process.platform !== "win32") {
					response.writeHead(501, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({ error: "当前平台使用系统默认打开方式。" }));
					return;
				}
				try {
					const body = JSON.parse(await readRequestBody(request));
					if (typeof body.path !== "string" || body.path.trim() === "") {
						response.writeHead(400, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						response.end(JSON.stringify({ error: "目录路径无效。" }));
						return;
					}
					const authorizedPath = authorizedExplorerWorkspacePath(body.path, host.workspaceRegistry.list().map((workspace) => workspace.path));
					if (authorizedPath === void 0) {
						response.writeHead(403, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						response.end(JSON.stringify({ error: "仅允许打开已注册的工作区目录。" }));
						return;
					}
					await foregroundExplorer.open(authorizedPath);
					response.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({
						opened: true,
						foreground: true
					}));
				} catch (error) {
					ctx.logger.warn("foreground explorer open failed: %s", error);
					response.writeHead(error instanceof SyntaxError ? 400 : 503, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify({ error: error instanceof SyntaxError ? "目录路径格式无效。" : "无法在前台打开资源管理器。" }));
				}
			}
		});
		return () => {
			foregroundExplorer.dispose();
			disposeConnectors();
			disposeCapabilities();
			disposeExplorer();
			disposePreferences();
			disposeSessionMove();
		};
	}, "michengai-codex-ui: catalogs");
}
//#endregion
export { RequestBodyTooLargeError, apply, inject, readRequestBody };
