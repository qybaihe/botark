import { ipcMain, type BrowserWindow } from 'electron'
import { GEMINI_CHANNELS } from '@shared/ipc'
import type { GeminiChatRequest, GeminiBridge } from '@shared/gemini'
import { cancelAccountRuns, listModels, stopRun, streamChat, verifyAndListModels } from './geminiClient'
import * as store from './geminiStore'

export function registerGeminiIpc(getWindow: () => BrowserWindow | null) {
  const methods = {
    config: async (id: string) => {
      const account = await store.credentials(id)
      return account && store.publicConfig(account)
    },
    configure: (id, draft) => store.configure(id, draft, (config) => listModels(id, config)),
    verifyAndListModels,
    listAccounts: store.listAccounts,
    clearAuth: (id: string) => {
      cancelAccountRuns(id)
      return store.clearAuth(id)
    },
    createSession: (id: string) => store.createSession(id),
    listSessions: store.listSessions,
    clearHistory: (id: string) => {
      cancelAccountRuns(id)
      store.clearHistory(id)
    },
    getHistory: store.getHistory,
    renameSession: store.renameSession,
    deleteSession: store.deleteSession,
    cancelChat: stopRun,
    streamChat: (req: GeminiChatRequest) => {
      const contents = getWindow()!.webContents
      const cancel = () => stopRun(req.accountId, { requestId: req.requestId })
      contents.once('destroyed', cancel)
      contents.once('render-process-gone', cancel)
      return streamChat(req, (event) => {
        if (!contents.isDestroyed()) contents.send(GEMINI_CHANNELS.event, event)
      }).finally(() => {
        contents.removeListener('destroyed', cancel)
        contents.removeListener('render-process-gone', cancel)
      })
    }
  } satisfies { [K in Exclude<keyof GeminiBridge, 'onEvent'>]:
    (...args: Parameters<GeminiBridge[K]>) => ReturnType<GeminiBridge[K]> | Awaited<ReturnType<GeminiBridge[K]>> }
  for (const key of Object.keys(methods) as (keyof typeof methods)[]) {
    ipcMain.handle(GEMINI_CHANNELS[key], (event, ...args) => {
      const sender = getWindow()?.webContents
      if (!sender || event.sender !== sender || event.senderFrame !== sender.mainFrame) throw new Error('Desktop window required')
      return Reflect.apply(methods[key], undefined, args)
    })
  }
}
export function disposeGeminiIpc() {
  cancelAccountRuns('*')
  for (const channel of Object.values(GEMINI_CHANNELS)) ipcMain.removeHandler(channel)
  store.closeHistory()
}
