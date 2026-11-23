import { describe, expect, it } from 'vitest'
import {
  allocateToolPrefix,
  parseHermesYamlMcpServers,
  parseMcpConfigText,
  sanitizeToolPrefix,
  stripJsonCommentsAndBom
} from './configParser'

describe('configParser', () => {
  it('strips UTF-8 BOM, JSONC comments, and trailing commas without corrupting URLs', () => {
    const raw = `\uFEFF{
      // line comment
      "mcpServers": {
        "docs": {
          /* block comment */
          "url": "https://example.com/a//b/*c*/",
          "headers": {
            "X-Test": "http://localhost:3000/v1",
          },
        },
      },
    }`
    const cleaned = stripJsonCommentsAndBom(raw)
    const parsed = JSON.parse(cleaned) as { mcpServers: { docs: { url: string; headers: Record<string, string> } } }
    expect(parsed.mcpServers.docs.url).toBe('https://example.com/a//b/*c*/')
    expect(parsed.mcpServers.docs.headers['X-Test']).toBe('http://localhost:3000/v1')
  })

  it('parses mcpServers, VS Code servers, single server object, and bare server maps', () => {
    const vsCode = parseMcpConfigText(
      JSON.stringify({
        servers: {
          'my.vscode-mcp': { type: 'http', url: 'https://mcp.example.com/v1' }
        }
      })
    )
    expect(vsCode).toEqual([
      expect.objectContaining({
        name: 'my.vscode-mcp',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/v1',
        enabled: true
      })
    ])

    const single = parseMcpConfigText(
      JSON.stringify({ name: 'solo', command: 'npx', args: ['-y', '@org/pkg'] })
    )
    expect(single).toEqual([
      expect.objectContaining({
        name: 'solo',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@org/pkg']
      })
    ])

    const bare = parseMcpConfigText(
      JSON.stringify({
        '@scope/pkg': { sseUrl: 'https://sse.example.com/events' }
      })
    )
    expect(bare).toEqual([
      expect.objectContaining({
        name: '@scope/pkg',
        transport: 'sse',
        url: 'https://sse.example.com/events'
      })
    ])
  })

  it('supports Unicode/dot/slash/space server names and allocates collision-safe tool prefixes', () => {
    const parsed = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', args: ['a.js'] },
          '@org/my.pkg': { command: 'node', args: ['b.js'] },
          '中文 服务': { url: 'http://127.0.0.1:4000/mcp' }
        }
      })
    )
    expect(parsed.map((s) => s.name)).toEqual(['local', '@org/my.pkg', '中文 服务'])

    const used = new Set<string>()
    expect(allocateToolPrefix('local', used)).toBe('local')
    expect(allocateToolPrefix('@org/my.pkg', used)).toBe('org_my_pkg')
    expect(allocateToolPrefix('@org/my/pkg', used)).toBe('org_my_pkg_2')
    expect(sanitizeToolPrefix('中文 服务')).toBe('mcp')
    expect(allocateToolPrefix('中文 服务', used)).toBe('mcp')
    expect(allocateToolPrefix('中文 服务 2', used)).toBe('2')
  })

  it('normalizes URL aliases, expands workspaceFolder, flags unresolved variables, and respects disabled', () => {
    const parsed = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          ws: {
            command: 'node',
            args: ['${workspaceFolder}/server.js', '${workspaceFolderBasename}'],
            cwd: '${workspaceFolder}',
            env: { TOKEN: '${input:api_token}' },
            disabled: true
          },
          aliasHttp: {
            transport: 'streamableHttp',
            httpUrl: 'https://api.example.com/mcp'
          },
          aliasServer: {
            serverUrl: 'http://127.0.0.1:8080/mcp'
          }
        }
      }),
      { workspaceRoot: '/tmp/my-project' }
    )

    expect(parsed[0]).toMatchObject({
      name: 'ws',
      cwd: '/tmp/my-project',
      args: ['/tmp/my-project/server.js', 'my-project'],
      enabled: false,
      needsConfig: true,
      unresolvedVars: ['${input:api_token}']
    })
    expect(parsed[1]).toMatchObject({
      name: 'aliasHttp',
      transport: 'streamable-http',
      url: 'https://api.example.com/mcp',
      enabled: true,
      needsConfig: false
    })
    expect(parsed[2]).toMatchObject({
      name: 'aliasServer',
      transport: 'auto',
      url: 'http://127.0.0.1:8080/mcp'
    })
  })

  it('rejects empty commands and invalid URLs with clear messages', () => {
    expect(() =>
      parseMcpConfigText(JSON.stringify({ mcpServers: { badCmd: { command: '   ' } } }))
    ).toThrow(/command 不能为空/)

    expect(() =>
      parseMcpConfigText(JSON.stringify({ mcpServers: { badUrl: { url: 'not-a-url' } } }))
    ).toThrow(/无效的 MCP 服务 URL/)

    expect(() =>
      parseMcpConfigText(JSON.stringify({ mcpServers: { badProto: { url: 'ftp://example.com' } } }))
    ).toThrow(/仅支持 http\/https/)
  })

  it('parses Hermes YAML mcp_servers while excluding botark_workspace and loopback URLs', () => {
    const yaml = `
mcp_servers:
  botark_workspace:
    url: http://127.0.0.1:45678/mcp
    headers:
      Authorization: Bearer secret
  context7:
    command: npx
    args: ["-y", "@upstash/context7-mcp"]
`
    const parsed = parseHermesYamlMcpServers(yaml, {
      skipLoopbackUrls: new Set(['http://127.0.0.1:45678/mcp'])
    })
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.name).toBe('context7')
  })
})
