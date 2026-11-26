import { beforeEach, expect, it, vi } from 'vitest'
import { importAndVerifyCueCredentials, runCueRpc } from './cueIpc'

const fixture = vi.hoisted(() => ({
  roster: vi.fn(),
  agent: vi.fn(),
  history: vi.fn(),
  send: vi.fn(),
  cancelTurn: vi.fn(),
  syncWatch: vi.fn(),
  stopOpenApi: vi.fn(),
  verifyApiKey: vi.fn(),
  verifyNative: vi.fn(),
  persistTokens: vi.fn(),
  parseInput: vi.fn(),
  loadTokens: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
vi.mock('../muse/accountProxy', () => ({
  loadAccountProxyUrl: vi.fn(async () => undefined)
}))
vi.mock('./cueDeviceId', () => ({
  getOrCreateCueDeviceId: () => 'dev_ipc_1'
}))
vi.mock('./cueDesktopHandoff', () => ({
  onCueHandoffSignedIn: vi.fn(),
  revokeCueLoginNonce: vi.fn()
}))
vi.mock('./cueLogin', () => ({
  cancelCueLogin: vi.fn(),
  closeCueLoginWindow: vi.fn(),
  onCueLoginEvent: vi.fn(),
  openCueLoginWindow: vi.fn(),
  tryCapturePartitionCookies: vi.fn(async () => ({ captured: false }))
}))
vi.mock('./cueWatchManager', () => ({
  emitCueWatchEvent: vi.fn(),
  ensureCueAccountWatch: vi.fn(),
  setCueWatchEventEmitter: vi.fn(),
  stopCueAccountWatch: vi.fn()
}))
vi.mock('./cueAuth', () => ({
  clearCueAccountAuth: vi.fn(),
  currentCueAuthForIdentity: (auth: unknown) => auth,
  getCueCredentialRevision: () => Symbol.for('cue_rev_1'),
  hasValidCueAuth: vi.fn(async () => true),
  importCueCredentials: vi.fn(),
  listSavedCueAccountIds: () => [],
  loadCueTokens: fixture.loadTokens,
  parseAnyCueCredentialInput: fixture.parseInput,
  persistCueTokens: fixture.persistTokens
}))
vi.mock('./cueClient', () => ({
  callCueApi: vi.fn(),
  downloadCueMedia: vi.fn(),
  fetchCueAgents: fixture.roster,
  fetchCueAgentById: fixture.agent,
  fetchCueQuota: vi.fn(),
  fetchCueSessionHistory: fixture.history,
  verifyCueNativeCredentials: fixture.verifyNative
}))
vi.mock('./cueChatSocket', () => ({
  cancelCueNativeTurn: fixture.cancelTurn,
  sendCueNativeMessage: fixture.send,
  syncCueWatchedSessions: fixture.syncWatch
}))
vi.mock('./cueOpenApi', () => ({
  runCueOpenApi: vi.fn(),
  stopCueOpenApiTask: fixture.stopOpenApi,
  uploadCueOpenApiAttachment: vi.fn(),
  verifyCueApiKey: fixture.verifyApiKey
}))

beforeEach(() => {
  vi.clearAllMocks()
  fixture.loadTokens.mockResolvedValue({ accessToken: 'fixture', authKind: 'session' })
  fixture.agent.mockResolvedValue(null)
  fixture.roster.mockResolvedValue({ ok: true, status: 200, agents: [{ id: 'first', sessionId: 'wrong' }] })
  fixture.cancelTurn.mockReturnValue({ cancelledCount: 1, sessionIds: ['sess_active'] })
  fixture.stopOpenApi.mockResolvedValue({ ok: true, data: {} })
  fixture.syncWatch.mockResolvedValue(undefined)
})

it('does not use another agent session for history or sends', async () => {
  const target = { accountId: 'cue-fixture', agentId: 'named' }
  await expect(runCueRpc({ ...target, op: 'getHistory' })).resolves.toMatchObject({ ok: false, status: 404 })
  await expect(runCueRpc({ ...target, op: 'sendMessage', text: 'Fixture' })).resolves.toMatchObject({ ok: false, status: 404 })
  expect(fixture.history).not.toHaveBeenCalled()
  expect(fixture.send).not.toHaveBeenCalled()
})

it('uses an exact roster match when agent detail is unavailable', async () => {
  fixture.roster.mockResolvedValue({
    ok: true,
    status: 200,
    agents: [
      { id: 'first', sessionId: 'wrong' },
      { id: 'named', sessionId: 'right' }
    ]
  })
  fixture.history.mockResolvedValue({ ok: true, status: 200, messages: [] })
  await expect(runCueRpc({ accountId: 'cue-fixture', agentId: 'named', op: 'getHistory' })).resolves.toMatchObject({
    ok: true,
    data: { sessionId: 'right' }
  })
  expect(fixture.history).toHaveBeenCalledWith('cue-fixture', 'right', expect.anything())
})

it('propagates 401 on health and listAgents instead of returning fake online or default agent', async () => {
  fixture.roster.mockResolvedValue({ ok: false, status: 401, agents: [], error: 'Unauthorized' })
  await expect(runCueRpc({ accountId: 'cue-expired', op: 'health' })).resolves.toMatchObject({
    ok: false,
    status: 401
  })
  await expect(runCueRpc({ accountId: 'cue-expired', op: 'listAgents' })).resolves.toMatchObject({
    ok: false,
    status: 401
  })
})

it('cancels native socket turn and sends remote task.stop on stopRun', async () => {
  const res = await runCueRpc({
    accountId: 'cue-fixture',
    op: 'stopRun',
    sessionId: 'sess_active'
  })
  expect(res).toMatchObject({
    ok: true,
    data: { stopped: true, cancelledTurns: 1, remoteStopped: true, sessionId: 'sess_active' }
  })
  expect(fixture.cancelTurn).toHaveBeenCalledWith({
    accountId: 'cue-fixture',
    sessionId: 'sess_active',
    requestId: undefined
  })
  expect(fixture.stopOpenApi).toHaveBeenCalledWith('cue-fixture', 'fixture', 'sess_active', { asWebToken: true })
})

it('verifies both API keys and native session tokens before saving on import', async () => {
  fixture.parseInput.mockReturnValueOnce({ apiKey: 'sk-manus-bad', authKind: 'api-key' })
  fixture.verifyApiKey.mockRejectedValueOnce(new Error('Manus 拒绝了 API Key'))
  await expect(
    importAndVerifyCueCredentials({ accountId: 'cue-1', credential: 'sk-manus-bad', verifyApiKey: true })
  ).rejects.toThrow('API Key')
  expect(fixture.persistTokens).not.toHaveBeenCalled()

  fixture.parseInput.mockReturnValueOnce({ accessToken: 'bad_cookie', authKind: 'session' })
  fixture.verifyNative.mockResolvedValueOnce({ ok: false, status: 401, message: 'Cue Cookie / Token 无效或已过期' })
  await expect(
    importAndVerifyCueCredentials({
      accountId: 'cue-1',
      credential: 'cue_session_id=bad_cookie',
      verifyApiKey: true
    })
  ).rejects.toThrow('无效或已过期')
  expect(fixture.persistTokens).not.toHaveBeenCalled()

  fixture.parseInput.mockReturnValueOnce({ accessToken: 'good_cookie', authKind: 'session' })
  fixture.verifyNative.mockResolvedValueOnce({ ok: true, status: 200 })
  await importAndVerifyCueCredentials({
    accountId: 'cue-1',
    credential: 'cue_session_id=good_cookie',
    verifyApiKey: true
  })
  expect(fixture.persistTokens).toHaveBeenCalledOnce()
})
