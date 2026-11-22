import { writeFileSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  MOBILE_SYNC_CHANNELS,
  type DirectHermesCredential,
  type MobileBridgeLiveEvent,
  type MobileRelayCommand,
  type MobileSyncStateView,
  type MobileWorkspaceSnapshot
} from '@shared/mobileSync'
import { getHermesAccount, listHermesAccountRecords } from '../hermes/hermesStore'
import { defaultMobileSyncDevicesPath, MobileSyncServer } from './mobileSyncServer'

let syncServer: MobileSyncServer | null = null
let initialSnapshot: MobileWorkspaceSnapshot | undefined
let registered = false

function broadcastState(state: MobileSyncStateView): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(MOBILE_SYNC_CHANNELS.stateChanged, state)
  }
}

function dispatchCommandToRenderer(command: MobileRelayCommand): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
  if (!win) return
  win.webContents.send(MOBILE_SYNC_CHANNELS.command, command)
}

function collectDirectHermesCredentials(): DirectHermesCredential[] {
  const out: DirectHermesCredential[] = []
  try {
    for (const rec of listHermesAccountRecords()) {
      const full = getHermesAccount(rec.accountId)
      if (!full?.baseUrl) continue
      out.push({
        accountId: full.accountId,
        baseUrl: full.baseUrl,
        apiKey: full.apiKey,
        model: full.model,
        displayName: full.displayName
      })
    }
  } catch {
    /* keychain locked or empty */
  }
  return out
}

function ensureServer(): MobileSyncServer {
  if (!syncServer) {
    syncServer = new MobileSyncServer({
      storePath: defaultMobileSyncDevicesPath(app.getPath('userData')),
      appVersion: app.getVersion(),
      getDirectCredentials: collectDirectHermesCredentials,
      onCommand: dispatchCommandToRenderer,
      onStateChange: broadcastState
    })
    if (initialSnapshot) {
      syncServer.updateSnapshot(initialSnapshot)
      initialSnapshot = undefined
    }
  }
  return syncServer
}

export async function stopMobileSyncServer(): Promise<void> {
  if (syncServer) {
    await syncServer.stop().catch(() => undefined)
  }
}

export function registerMobileSyncIpc(): void {
  if (registered) return
  registered = true

  ipcMain.handle(MOBILE_SYNC_CHANNELS.getState, () => ensureServer().getState())
  ipcMain.handle(MOBILE_SYNC_CHANNELS.start, () => ensureServer().start())
  ipcMain.handle(MOBILE_SYNC_CHANNELS.stop, () => ensureServer().stop())
  ipcMain.handle(MOBILE_SYNC_CHANNELS.rotatePairing, () => ensureServer().rotatePairing())

  ipcMain.handle(MOBILE_SYNC_CHANNELS.setIncludeDirectCredentials, (_event, enabled: unknown) => {
    return ensureServer().setIncludeDirectCredentials(Boolean(enabled))
  })

  ipcMain.handle(MOBILE_SYNC_CHANNELS.revokeDevice, (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') throw new TypeError('deviceId must be a string')
    return ensureServer().revokeDevice(deviceId)
  })

  ipcMain.handle(MOBILE_SYNC_CHANNELS.exportOfflineBundle, async (event) => {
    const srv = ensureServer()
    const { bundleJson, transferKey, fingerprint } = srv.createOfflineEncryptedBundle()
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const defaultName = `BotArk-Sync-${fingerprint}.botark-sync`
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: '导出加密同步包（可通过隔空投送发送到 iPhone）',
          defaultPath: defaultName,
          filters: [{ name: 'BotArk Sync Bundle', extensions: ['botark-sync', 'json'] }]
        })
      : await dialog.showSaveDialog({
          title: '导出加密同步包（可通过隔空投送发送到 iPhone）',
          defaultPath: defaultName,
          filters: [{ name: 'BotArk Sync Bundle', extensions: ['botark-sync', 'json'] }]
        })
    if (result.canceled || !result.filePath) {
      return { canceled: true as const }
    }
    writeFileSync(result.filePath, bundleJson, { encoding: 'utf8', mode: 0o600 })
    return {
      canceled: false as const,
      filePath: result.filePath,
      transferKey,
      fingerprint
    }
  })

  ipcMain.on(MOBILE_SYNC_CHANNELS.pushSnapshot, (_event, snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== 'object') return
    if (syncServer) syncServer.updateSnapshot(snapshot as MobileWorkspaceSnapshot)
    else initialSnapshot = snapshot as MobileWorkspaceSnapshot
  })

  ipcMain.on(MOBILE_SYNC_CHANNELS.pushEvent, (_event, payload: unknown) => {
    if (!syncServer || !payload || typeof payload !== 'object') return
    syncServer.broadcastLiveEvent(payload as MobileBridgeLiveEvent)
  })
}
