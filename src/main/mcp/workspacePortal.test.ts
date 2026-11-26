import { describe, expect, it } from 'vitest'
import { fileTools } from './workspaceFiles'
import { isSensitivePortalPath, normalizePortalRelPath } from './workspacePortal'

describe('workspace portal contract', () => {
  it('exposes the workspace file tools', () => {
    expect(fileTools.map((tool) => tool.name)).toEqual([
      'list',
      'read',
      'search',
      'write',
      'patch'
    ])
  })

  it('only accepts plain string arguments', () => {
    for (const tool of fileTools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
      for (const value of Object.values(tool.inputSchema.properties ?? {})) {
        expect(value).toMatchObject({ type: 'string' })
        expect(
          Object.keys(value).every((key) => key === 'type' || key === 'description')
        ).toBe(true)
      }
    }
  })

  it('normalizes Windows and relative portal paths cleanly', () => {
    expect(normalizePortalRelPath('.\\docs\\guide.md')).toBe('docs/guide.md')
    expect(normalizePortalRelPath('/src/main/')).toBe('src/main')
    expect(normalizePortalRelPath('./')).toBe('.')
  })

  it('blocks sensitive credential, key, and VCS paths while allowing normal files and env templates', () => {
    const blocked = [
      '.env',
      '.env.local',
      'apps/web/.env.production',
      '.git',
      '.git/config',
      'sub/.git/HEAD',
      'certs/server.key',
      'certs/ca.pem',
      'keys/id_rsa',
      'keys/id_ed25519.pub',
      '.npmrc',
      '.aws/credentials',
      'config/service-account-prod.json',
      'secrets.yaml'
    ]
    for (const p of blocked) {
      expect(isSensitivePortalPath(p), `expected ${p} to be blocked`).toBe(true)
    }

    const allowed = [
      '.',
      'README.md',
      '.env.example',
      '.env.sample',
      '.env.template',
      'src/secretHelper.ts',
      'docs/guide.md',
      'package.json'
    ]
    for (const p of allowed) {
      expect(isSensitivePortalPath(p), `expected ${p} to be allowed`).toBe(false)
    }
  })
})
