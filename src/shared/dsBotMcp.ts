import type { McpConfigScope, McpServerConfigInput } from './workspace'

export function dsBotServer(port: number, token: string, targetScope: McpConfigScope): McpServerConfigInput {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DS Bot MCP port must be 1024–65535')
  const credential = token.trim()
  if (!credential || /\s/.test(credential)) throw new Error('Enter the client token from DS Bot')
  return {
    name: 'ds-bot', transport: 'streamable-http', targetScope,
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${credential}` }
  }
}
