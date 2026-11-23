import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'

let cachedIcon: NativeImage | string | undefined
let resolvedOnce = false

/**
 * Resolve the shared BotArk window icon (`build/icon.png`) for all Electron
 * `BrowserWindow`s (main window, platform login windows, and OAuth child popups).
 * Safely degrades to `undefined` or path string in unit/E2E mock environments.
 */
export function getAppWindowIcon(): NativeImage | string | undefined {
  if (resolvedOnce) return cachedIcon
  resolvedOnce = true

  const candidates = [
    join(__dirname, '../../build/icon.png'),
    process.resourcesPath ? join(process.resourcesPath, 'app/build/icon.png') : '',
    join(process.cwd(), 'build/icon.png')
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      if (nativeImage && typeof nativeImage.createFromPath === 'function') {
        const img = nativeImage.createFromPath(candidate)
        if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) {
          cachedIcon = img
          return cachedIcon
        }
      }
    } catch {
      /* fallback to raw path in mock/headless environments */
    }
    cachedIcon = candidate
    return cachedIcon
  }

  return undefined
}
