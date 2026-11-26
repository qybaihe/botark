import type { McpConfigScope, McpServerConfigInput } from './workspace'

export function normalizeDsBotEndpoint(endpointOrPort: number | string): string {
  if (typeof endpointOrPort === 'number') {
    if (!Number.isInteger(endpointOrPort) || endpointOrPort < 1024 || endpointOrPort > 65535) {
      throw new Error('DS Bot MCP port must be 1024–65535')
    }
    return `http://127.0.0.1:${endpointOrPort}/mcp`
  }
  const raw = endpointOrPort.trim()
  if (!raw || /[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('Enter a local port (e.g. 8797) or a remote DS Bot MCP URL')
  }
  if (/^\d+$/.test(raw)) {
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('DS Bot MCP port must be 1024–65535')
    }
    return `http://127.0.0.1:${port}/mcp`
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('Enter a valid local port or http(s) DS Bot URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('DS Bot MCP URL must use http:// or https://')
  }
  if (!parsed.hostname || parsed.hostname.startsWith('-')) {
    throw new Error('DS Bot MCP URL must include a valid host')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Pass the DS Bot client token in the token field, not in the URL')
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    parsed.pathname = '/mcp'
  }
  parsed.hash = ''
  return parsed.toString()
}

export function dsBotServer(
  endpointOrPort: number | string,
  token: string,
  targetScope: McpConfigScope
): McpServerConfigInput {
  const url = normalizeDsBotEndpoint(endpointOrPort)
  const credential = token.trim()
  if (!credential || /[\s\u0000-\u001f\u007f]/.test(credential)) {
    throw new Error('Enter the client token from DS Bot')
  }
  return {
    name: 'ds-bot',
    transport: 'streamable-http',
    targetScope,
    url,
    headers: { Authorization: `Bearer ${credential}` }
  }
}
