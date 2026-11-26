import { expect, it } from 'vitest'
import { dsBotServer, normalizeDsBotEndpoint } from './dsBotMcp'

it('connects to the local DS Bot endpoint with the selected scope and client token', () => {
  expect(dsBotServer(8999, ' fixture ', 'scope')).toEqual({
    name: 'ds-bot', targetScope: 'scope', transport: 'streamable-http',
    url: 'http://127.0.0.1:8999/mcp', headers: { Authorization: 'Bearer fixture' }
  })
  expect(dsBotServer('8797', 'fixture', 'global').url).toBe('http://127.0.0.1:8797/mcp')
})

it('supports remote DS Bot MCP URLs and bare host:port endpoints', () => {
  expect(normalizeDsBotEndpoint('https://ds-bot.example.com')).toBe('https://ds-bot.example.com/mcp')
  expect(normalizeDsBotEndpoint('https://ds-bot.example.com/')).toBe('https://ds-bot.example.com/mcp')
  expect(normalizeDsBotEndpoint('https://ds-bot.example.com/v2/mcp')).toBe('https://ds-bot.example.com/v2/mcp')
  expect(normalizeDsBotEndpoint('http://192.168.1.25:8797')).toBe('http://192.168.1.25:8797/mcp')
  expect(normalizeDsBotEndpoint('192.168.1.25:8797')).toBe('http://192.168.1.25:8797/mcp')
  expect(normalizeDsBotEndpoint('ds-bot.tailnet.ts.net:8797/mcp')).toBe('http://ds-bot.tailnet.ts.net:8797/mcp')
  expect(dsBotServer('https://ds-bot.example.com/mcp', ' remote-tok ', 'global')).toEqual({
    name: 'ds-bot', targetScope: 'global', transport: 'streamable-http',
    url: 'https://ds-bot.example.com/mcp', headers: { Authorization: 'Bearer remote-tok' }
  })
})

it('rejects empty/invalid client tokens, ports, schemes, and embedded credentials', () => {
  expect(() => dsBotServer(8797, '', 'global')).toThrow()
  expect(() => dsBotServer(8797, 'fixture\u0000token', 'global')).toThrow()
  expect(() => dsBotServer(8797, 'fixture\r\ntoken', 'global')).toThrow()
  expect(() => dsBotServer(65536, 'fixture', 'global')).toThrow()
  expect(() => dsBotServer('80', 'fixture', 'global')).toThrow()
  expect(() => dsBotServer('', 'fixture', 'global')).toThrow()
  expect(() => dsBotServer('-1', 'fixture', 'global')).toThrow()
  expect(() => dsBotServer('ftp://ds-bot.example.com/mcp', 'fixture', 'global')).toThrow()
  expect(() => dsBotServer('https://user:pass@ds-bot.example.com/mcp', 'fixture', 'global')).toThrow()
  expect(() => dsBotServer('https://ds-bot.example.com /mcp', 'fixture', 'global')).toThrow()
})
