export interface HarkBrowserPreview {
  label: string
  status: string
  screenshotKey?: string
  screenshotUrl?: string
}

interface Panel {
  kind: string
  status: string
  title?: string
  url?: string
  liveViewUrl?: string
  screenshotKey?: string
  screenshotUrl?: string
}

export function currentHarkBrowser(panels: Panel[]): HarkBrowserPreview | null {
  const candidates = panels.filter((p) => p.screenshotKey || p.screenshotUrl || p.liveViewUrl || /browser|computer/i.test(p.kind))
  const panel = candidates.findLast((p) => /^(active|running|pending|started|waiting_for_input)$/i.test(p.status))
    ?? candidates.at(-1)
  if (!panel) return null
  // A storage key is resolved by Hark's presign API. A direct URL must belong to Hark.
  const key = panel.screenshotKey
  const screenshotKey = key && !/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(key) ? key : undefined
  let screenshotUrl: string | undefined
  if (!screenshotKey && panel.screenshotUrl && URL.canParse(panel.screenshotUrl, 'https://app.hark.com')) {
    const url = new URL(panel.screenshotUrl, 'https://app.hark.com')
    if (url.protocol === 'https:' && (url.hostname === 'hark.com' || url.hostname.endsWith('.hark.com'))) {
      screenshotUrl = url.href
    }
  }
  return {
    label: panel.url || panel.title || panel.kind, status: panel.status,
    screenshotKey, screenshotUrl
  }
}
