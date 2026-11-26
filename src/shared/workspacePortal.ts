/**
 * Workspace portal — lets a member that cannot speak BotArk's external
 * `[TOOL]` protocol (Hark refuses to act as another app's backend model)
 * still reach the local workspace through its own native web tools.
 *
 * The portal is a small HTTP service bound to 127.0.0.1 that serves:
 *   GET  /?token=…                   index of the workspace root
 *   GET  /browse?path=…&token=…      directory listing
 *   GET  /raw?path=…&token=…         raw UTF-8 file contents
 *   GET  /search?q=…&path=…&token=…  filename search below a directory
 *   GET  /write?path=…&token=…       edit form for a file
 *   POST /write                      save file (every write requires human approval)
 *   GET  /api/catalog?token=…        JSON service metadata (without echoing token)
 *
 * When publishing for a cloud member, a temporary cloudflared quick tunnel
 * exposes the loopback server over HTTPS after explicit user consent. Every
 * request must present the random per-session token, sensitive credential files
 * and `.git` directories are blocked, and idle portals shut down automatically.
 */
export interface PortalToolSummary {
  name: string
  description?: string
  inputSchema: { type: 'object'; [key: string]: unknown }
}

export interface PortalCatalog {
  service: string
  tools: PortalToolSummary[]
  endpoints: Array<{ method: 'GET' | 'POST'; path: string; purpose: string }>
}

export type PortalRequest =
  | { op: 'status'; scope: string }
  | { op: 'open'; scope: string }
  | { op: 'close'; scope: string }

export interface PortalState {
  scope?: string
  root?: string
  /** Tunnel root, without the token. */
  publicUrl?: string
  /** The URL to hand to the member: portal root plus the access token. */
  entryUrl?: string
  localUrl?: string
  running: boolean
  /** Epoch ms when the portal will auto-close if idle. */
  expiresAt?: number
  tools: PortalToolSummary[]
  error?: string
}

export interface PortalBridge {
  manage(request: PortalRequest): Promise<PortalState>
}

export const WORKSPACE_PORTAL_CHANNEL = 'botark:workspace-portal'
