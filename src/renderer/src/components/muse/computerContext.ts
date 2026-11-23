type ComputerContextSnap = {
  taskId?: string
  sha256?: string
  status?: string
  url?: string
  title?: string
  raw: Record<string, unknown>
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export function parseComputerContext(raw: unknown): ComputerContextSnap {
  const root = asObj(raw) || {}
  const nested = asObj(root['context']) || asObj(root['result']) || asObj(root['task']) || root
  const preview = asObj(nested['preview']) || asObj(nested['latest_preview']) || nested
  const taskId = str(
    nested['task_id'] ||
      nested['taskId'] ||
      preview['task_id'] ||
      preview['taskId'] ||
      nested['active_task_id'] ||
      nested['id']
  )
  const sha256 = str(preview['sha256'] || preview['hash'] || nested['sha256'] || nested['preview_sha256'])
  return {
    taskId: taskId || undefined,
    sha256: sha256 || undefined,
    status: str(nested['status'] || nested['state']) || undefined,
    url: str(nested['url'] || nested['current_url'] || preview['url']) || undefined,
    title: str(nested['title'] || preview['title']) || undefined,
    raw: nested
  }
}
