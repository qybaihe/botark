import { expect, it } from 'vitest'
import { dsBotServer } from './dsBotMcp'

it('connects to the local DS Bot endpoint with the selected scope and client token', () => {
  expect(dsBotServer(8999, ' fixture ', 'scope')).toEqual({
    name: 'ds-bot', targetScope: 'scope', transport: 'streamable-http',
    url: 'http://127.0.0.1:8999/mcp', headers: { Authorization: 'Bearer fixture' }
  })
})
it('rejects an empty client token or invalid local port before saving', () => {
  expect(() => dsBotServer(8797, '', 'global')).toThrow()
  expect(() => dsBotServer(65536, 'fixture', 'global')).toThrow()
})
