export interface WorkspaceTool {
  name: string
  description?: string
  inputSchema: { type: 'object'; [key: string]: unknown }
}

export type McpTransportType = 'stdio' | 'streamable-http' | 'sse'
export type McpConfigScope = 'global' | 'scope'
export type McpServerSource = 'manual' | 'import' | 'detected' | 'hermes'

export interface McpServerConfigInput {
  name: string
  transport?: McpTransportType | 'auto'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  targetScope?: McpConfigScope
  keepExistingSecrets?: boolean
}

export interface WorkspaceServerView {
  name: string
  running: boolean
  enabled?: boolean
  needsConfig?: boolean
  transport?: McpTransportType | 'auto'
  resolvedTransport?: McpTransportType
  command?: string
  args?: string[]
  url?: string
  cwd?: string
  envKeys?: string[]
  headerKeys?: string[]
  toolCount?: number
  lastError?: string
  source?: McpServerSource
  scope?: McpConfigScope
}

export interface DetectedMcpConfig {
  path: string
  label: string
  origin: 'workspace' | 'user'
  serverCount: number
  serverNames: string[]
  newServerNames: string[]
  parseError?: string
}

export interface WorkspaceOptimizeReport {
  completedAtMs: number
  directory?: string
  trusted: boolean
  scannedFiles: number
  detectedFiles?: string[]
  importedServers: string[]
  skippedExisting: string[]
  skippedShadowed?: string[]
  malformedFiles?: Array<{ path: string; error: string }>
  startedServers: string[]
  failedServers: Array<{ name: string; error: string }>
  totalTools: number
  ready: boolean
  hermes?: {
    homeFound: boolean
    envFound: boolean
    configYamlPath?: string
    configuredAccounts: number
    loopbackState: 'active' | 'stale' | 'unconfigured'
  }
  summary: string
}

export type WorkspaceRequest =
  | { op: 'status' | 'unbind' }
  | { op: 'bind'; directory?: string }
  | { op: 'import'; targetScope?: McpConfigScope; autoStart?: boolean }
  | { op: 'upsert' | 'update'; previousName?: string; server: McpServerConfigInput; autoStart?: boolean }
  | { op: 'remove'; server: string; targetScope?: McpConfigScope }
  | { op: 'importJson'; rawJson: string; targetScope?: McpConfigScope; autoStart?: boolean }
  | { op: 'start' | 'stop' | 'restart'; server: string; targetScope?: McpConfigScope }
  | { op: 'detectConfigs'; includeUserConfigs?: boolean }
  | {
      op: 'optimizeReady'
      directory?: string
      autoStart?: boolean
      includeUserConfigs?: boolean
      selectedPaths?: string[]
      bindIfMissing?: boolean
    }
  | { op: 'run'; tool: string; args: Record<string, unknown>; recipient: string }
  | { op: 'hermes'; accountId: string; configPath?: string }

export interface WorkspaceView {
  directory?: string
  trusted?: boolean
  persistedCount?: number
  servers: WorkspaceServerView[]
  tools: WorkspaceTool[]
  detectedConfigs?: DetectedMcpConfig[]
  lastReport?: WorkspaceOptimizeReport
  canceled?: boolean
  importedCount?: number
}

export interface WorkspaceBridge {
  manage(scope: string, request: Exclude<WorkspaceRequest, { op: 'run' }>): Promise<WorkspaceView>
  run(scope: string, tool: string, args: Record<string, unknown>, recipient: string): Promise<string>
}

export const WORKSPACE_CHANNEL = 'botark:workspace'
