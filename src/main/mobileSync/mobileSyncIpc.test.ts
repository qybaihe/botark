import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MOBILE_SYNC_CHANNELS, type MobileWorkspaceSnapshot } from '@shared/mobileSync'
import { decryptAesGcmCombined } from './mobileSyncCrypto'
import { registerMobileSyncIpc } from './mobileSyncIpc'

const fixture = vi.hoisted(() => ({
  directory: '',
  on: new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.directory, getVersion: () => '1.0.0' },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  dialog: { showSaveDialog: async () => ({ filePath: join(fixture.directory, 'workspace.botark-sync') }) },
  ipcMain: {
    on: (name: string, handler: (...args: unknown[]) => unknown) => fixture.on.set(name, handler),
    handle: (name: string, handler: (...args: unknown[]) => unknown) => fixture.handle.set(name, handler)
  }
}))
vi.mock('../hermes/hermesStore', () => ({
  listHermesAccountRecords: () => [],
  getHermesAccount: () => undefined
}))

it('exports the latest renderer snapshot before the LAN server has been started', async () => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'botark-export-test-'))
  try {
    registerMobileSyncIpc()
    const snapshot: MobileWorkspaceSnapshot = {
      version: 1, updatedAtMs: 1, hostName: 'Fixture', selectedBotId: null,
      groups: [{ id: 'group', name: 'Fixture group', collapsed: true }],
      bots: [], accounts: {}, messages: {}, approvals: {}
    }
    fixture.on.get(MOBILE_SYNC_CHANNELS.pushSnapshot)!({}, snapshot)
    const exported = await fixture.handle.get(MOBILE_SYNC_CHANNELS.exportOfflineBundle)!({ sender: {} }) as {
      filePath: string; transferKey: string
    }
    const envelope = JSON.parse(readFileSync(exported.filePath, 'utf8')) as { payload: string }
    const bundle = JSON.parse(decryptAesGcmCombined(envelope.payload, exported.transferKey))
    expect(bundle.snapshot.groups).toEqual(snapshot.groups)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})
