export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'
export const GEMINI_MODEL = 'gemini-2.5-flash'

export interface GeminiModel {
  id: string
  label: string
  thinking: boolean
}

export interface GeminiConfig {
  baseUrl: string
  model: string
  systemInstruction: string
  temperature?: number
  enableSearchGrounding: boolean
  showThinking: boolean
  models: GeminiModel[]
}

export type GeminiDraft = Partial<Omit<GeminiConfig, 'models'>> & { apiKey?: string }
export interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}
export interface GeminiSession {
  id: string
  title: string
  updatedAt: number
  usage?: GeminiUsage
}
export interface GeminiAttachment {
  id: string
  name: string
  size: number
  mimeType: string
  dataBase64?: string
}
export interface GeminiSearchWidget {
  kind: 'google_search'
  widgetId: string
  html: string
}
export interface GeminiMessage {
  id: string
  text: string
  role: 'user' | 'bot'
  createdAt: number
  richWidgets?: GeminiSearchWidget[]
  thought?: string
  attachments?: GeminiAttachment[]
  usage?: GeminiUsage
}
export interface GeminiChatRequest {
  accountId: string
  conversationId: string
  requestId: string
  userMessageId?: string
  sessionId?: string
  text: string
  attachments?: GeminiAttachment[]
}
export interface GeminiChatResult {
  sessionId: string
  message: GeminiMessage
}
export type GeminiEvent = {
  accountId: string
  requestId: string
  sessionId: string
} & ({ type: 'accepted' } | { type: 'progress'; text: string; thought?: string })

export interface GeminiBridge {
  config(accountId: string): Promise<GeminiConfig | null>
  configure(accountId: string, draft: GeminiDraft): Promise<GeminiConfig>
  verifyAndListModels(accountId: string, draft?: GeminiDraft): Promise<GeminiModel[]>
  listAccounts(): Promise<string[]>
  clearAuth(accountId: string): Promise<{ signedIn: false }>
  createSession(accountId: string): Promise<GeminiSession>
  listSessions(accountId: string): Promise<GeminiSession[]>
  clearHistory(accountId: string): Promise<void>
  getHistory(accountId: string, sessionId: string): Promise<GeminiMessage[]>
  renameSession(accountId: string, sessionId: string, title: string): Promise<void>
  deleteSession(accountId: string, sessionId: string): Promise<void>
  streamChat(request: GeminiChatRequest): Promise<GeminiChatResult>
  cancelChat(accountId: string, target: { requestId: string } | { conversationId: string; sessionId?: string }): Promise<void>
  onEvent(listener: (event: GeminiEvent) => void): () => void
}
