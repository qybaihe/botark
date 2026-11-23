function extractLeadingJsonObject(raw: string): string {
  let source = raw.trimStart()
  if (source.startsWith('```')) {
    const firstNewline = source.indexOf('\n')
    if (firstNewline === -1) return source
    source = source.slice(firstNewline + 1).trimStart()
  }
  if (!source.startsWith('{')) return source

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(0, i + 1)
    }
  }
  return source
}

export function requestedTool(text: string) {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('[TOOL]')) return undefined
  const payload = extractLeadingJsonObject(trimmed.slice(6))
  const value = JSON.parse(payload)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !value.args ||
    typeof value.args !== 'object' ||
    Array.isArray(value.args)
  ) {
    throw new Error('无效的工具请求')
  }
  return value as { name: string; args: Record<string, unknown> }
}
