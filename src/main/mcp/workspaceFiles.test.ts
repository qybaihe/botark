import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { workspaceFile } from './workspaceFiles'

let dir: string, root: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'workspace-fixture-')))
  root = join(dir, 'root')
  await mkdir(root)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

it('rejects traversal, linked parents and writes to links', async () => {
  await writeFile(join(dir, 'outside.txt'), 'fixture')
  // Use NTFS junction on Windows so the link test runs without Developer Mode / admin elevation
  await symlink(dir, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')

  const paths = ['../outside.txt', 'link/outside.txt', 'link']
  try {
    await symlink(join(dir, 'outside.txt'), join(root, 'file'))
    paths.push('file')
  } catch (err) {
    if (process.platform !== 'win32' || (err as NodeJS.ErrnoException).code !== 'EPERM') {
      throw err
    }
  }

  for (const path of paths) {
    await expect(workspaceFile(root, 'read', { path })).rejects.toThrow()
    await expect(workspaceFile(root, 'write', { path, text: 'changed' })).rejects.toThrow()
  }
  expect(await readFile(join(dir, 'outside.txt'), 'utf8')).toBe('fixture')
})

it('applies an unambiguous literal patch and preserves content on a failed match', async () => {
  await workspaceFile(root, 'write', { path: 'draft', text: 'a a b' })
  await expect(workspaceFile(root, 'patch', { path: 'draft', before: 'a', after: 'x' })).rejects.toThrow('exactly once')
  await workspaceFile(root, 'patch', { path: 'draft', before: 'b', after: '$1' })
  expect(await workspaceFile(root, 'read', { path: 'draft' })).toBe('a a $1')
})
