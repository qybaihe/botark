import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorkspaceTool } from '@shared/workspace'

const MAX_BYTES = 96 * 1024
const string = { type: 'string' }
const workspacePath = { type: 'string', description: 'Relative to the selected workspace. Use "." for its root.' }
function tool(name: string, description: string, fields: string[]): WorkspaceTool {
  return { name, description, inputSchema: {
    type: 'object', properties: Object.fromEntries(fields.map((key) => [key, key === 'path' ? workspacePath : string])), required: fields, additionalProperties: false
  } }
}
export const fileTools = [
  tool('list', 'List entries in a workspace directory.', ['path']),
  tool('read', 'Read a UTF-8 text file (up to 96 KiB).', ['path']),
  tool('search', 'Find matching file names below a directory.', ['path', 'query']),
  tool('write', 'Create or replace a UTF-8 text file after approval.', ['path', 'text']),
  tool('patch', 'Replace one exact, unique piece of text after approval.', ['path', 'before', 'after'])
]
function within(root: string, file: string) {
  const rel = relative(root, file)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Path is outside the selected workspace')
}
function field(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`Expected text for ${key}`)
  return value
}
async function readText(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Select a text file of at most 96 KiB')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > MAX_BYTES) throw new Error('File exceeds 96 KiB')
    const view = buffer.subarray(0, used)
    if (view.includes(0)) throw new Error('Select a UTF-8 text file')
    return new TextDecoder('utf-8', { fatal: true }).decode(view)
  } finally { await file.close() }
}

export async function workspaceFile(root: string, name: string, args: Record<string, unknown>): Promise<string> {
  const path = resolve(root, field(args, 'path'))
  within(root, path)
  if (name === 'write' || name === 'patch') {
    if (path === root) throw new Error('Select a file inside the workspace')
    const parent = await realpath(dirname(path))
    within(root, parent)
    const dest = join(parent, basename(path))
    const existing = await lstat(dest).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (existing && !existing.isFile()) throw new Error('Target must be a regular file')
    let output: string
    if (name === 'patch') {
      const source = await readText(dest)
      const before = field(args, 'before')
      const at = source.indexOf(before)
      if (!before || at < 0 || source.indexOf(before, at + 1) !== -1) throw new Error('Patch must match exactly once')
      output = source.slice(0, at) + field(args, 'after') + source.slice(at + before.length)
    } else output = field(args, 'text')
    if (Buffer.byteLength(output) > MAX_BYTES) throw new Error('Output exceeds 96 KiB')
    const tmp = join(parent, '.botark-' + randomUUID())
    const file = await open(tmp, 'wx', existing ? existing.mode & 0o777 : 0o600)
    try {
      try { await file.writeFile(output) } finally { await file.close() }
      within(root, await realpath(parent))
      const now = await lstat(dest).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null })
      if (now?.ino !== existing?.ino || now?.ctimeMs !== existing?.ctimeMs) throw new Error('File changed during edit')
      await rename(tmp, dest)
    } finally { await rm(tmp, { force: true }) }
    return `Saved ${relative(root, dest)}`
  }
  const canonical = await realpath(path)
  within(root, canonical)
  if (name === 'read') return readText(canonical)
  if (name !== 'list' && name !== 'search') throw new Error('Unknown workspace tool')
  const query = name === 'search' ? field(args, 'query').toLowerCase() : ''
  const entries: string[] = []
  const directories = [canonical]
  let visited = 0
  while (directories.length) {
    const directory = await realpath(directories.pop()!)
    within(root, directory)
    for await (const item of await opendir(directory)) {
      const entry = join(directory, item.name)
      if (item.name.toLowerCase().includes(query)) entries.push(relative(root, entry) + (item.isDirectory() ? '/' : ''))
      if (name === 'search' && item.isDirectory()) directories.push(entry)
      if (++visited >= 5000 || entries.length >= 200) return [...entries, '… (listing truncated)'].join('\n')
    }
  }
  return entries.sort().join('\n')
}
