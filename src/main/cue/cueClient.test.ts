import { describe, expect, it, vi } from 'vitest'

const { loadCueTokens, fetcherMock } = vi.hoisted(() => ({
  loadCueTokens: vi.fn(async (accountId: string) => ({
    accountId,
    accessToken: 'jwt_cue_client_test',
    cookieHeader: 'cue_session_id=jwt_cue_client_test',
    deviceId: 'dev_client_1',
    authKind: 'session' as const,
    accountFingerprint: 'fp_client_1'
  })),
  fetcherMock: vi.fn()
}))

vi.mock('./cueAuth', () => ({
  CUE_CONNECT_BASE: 'https://api.manus.im',
  currentCueAuthForIdentity: () => undefined,
  cueFetcherForAccount: (_id: string, explicit?: typeof fetch) => explicit ?? fetcherMock,
  forceRefreshCueAuth: vi.fn(async () => null),
  loadCueTokens
}))
vi.mock('./cueAuthStore', () => ({
  getCueMainAuth: vi.fn(() => undefined)
}))
vi.mock('./cueDeviceId', () => ({
  getOrCreateCueDeviceId: () => 'dev_client_1'
}))

import {
  downloadCueMedia,
  extractCueHistoryMessages,
  fetchCueAgents,
  fetchCueQuota,
  fetchCueSessionHistory,
  mapCueMembershipQuota,
  verifyCueNativeCredentials
} from './cueClient'

describe('Cue native Connect-RPC client & history parser', () => {
  it('fetches Cue Agents via AgentsService/ListAgents with manus-agents headers and parses sessionUid', async () => {
    fetcherMock.mockResolvedValueOnce(
      Response.json({
        agents: [
          {
            id: 'ag_1',
            name: '旅行管家',
            sessionUid: 'sess_travel_1',
            email: 'travel@cue.im',
            phoneNumber: '+15550100',
            isManus: false
          },
          {
            agent_id: 'ag_2',
            nickname: '日常助手',
            session_uid: 'sess_daily_2',
            last_display_message: '明天上午九点有会'
          }
        ]
      })
    )

    const res = await fetchCueAgents('acc_cue_1', { limit: 25 })
    expect(res.ok).toBe(true)
    expect(res.agents).toEqual([
      {
        id: 'ag_1',
        name: '旅行管家',
        sessionId: 'sess_travel_1',
        email: 'travel@cue.im',
        handle: 'travel@cue.im',
        phoneNumber: '+15550100',
        isManus: false,
        description: 'travel@cue.im · +15550100'
      },
      {
        id: 'ag_2',
        name: '日常助手',
        sessionId: 'sess_daily_2',
        lastDisplayMessage: '明天上午九点有会',
        description: '明天上午九点有会'
      }
    ])

    const [url, init] = fetcherMock.mock.calls[0]!
    expect(url).toBe('https://api.manus.im/agents.v1.AgentsService/ListAgents')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ limit: 25 })
    expect(init.headers['Connect-Protocol-Version']).toBe('1')
    expect(init.headers['x-product-name']).toBe('manus-agents')
    expect(init.headers['Authorization']).toBe('Bearer jwt_cue_client_test')
  })

  it('extracts ordered user/bot chat history from getSessionV2 segments & events', async () => {
    fetcherMock.mockResolvedValueOnce(
      Response.json({
        segments: [
          {
            events: [
              { id: 'm2', type: 'chat', sender: 'assistant', content: '已帮你查看天气', timestamp: 1700000002 },
              { id: 'm1', type: 'chat', sender: 'user', content: '明天需要带伞吗', timestamp: 1700000001 },
              { id: 'm_status', type: 'statusUpdate', agentStatus: 'stopped', timestamp: 1700000003 }
            ]
          }
        ]
      })
    )

    const hist = await fetchCueSessionHistory('acc_cue_1', 'sess_travel_1', { limit: 40 })
    expect(hist.ok).toBe(true)
    expect(hist.messages).toEqual([
      { id: 'm1', role: 'user', text: '明天需要带伞吗', createdAtMs: 1700000001000 },
      { id: 'm2', role: 'bot', text: '已帮你查看天气', createdAtMs: 1700000002000 }
    ])

    expect(
      extractCueHistoryMessages({
        events: [{ type: 'event', event: { id: 'e1', type: 'chat', sender: 'assistant', content: 'hi', timestamp: 1700000005000 } }]
      })
    ).toEqual([{ id: 'e1', role: 'bot', text: 'hi', createdAtMs: 1700000005000 }])
  })

  it('keeps the freshest history copy and derives stable IDs for idless chat events', async () => {
    const event = { type: 'chat', sender: 'assistant', content: 'No explicit ID', timestamp: 1_700_000_000 }
    const newest = { type: 'chat', id: 'same-id', sender: 'assistant', content: 'Edited', timestamp: 1_700_000_001 }
    const cursor = { kind: 'events', userChatId: 'before-first', prevId: 'previous' }
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ turns: [{ ...cursor, events: [newest, event] }] }))
      .mockResolvedValueOnce(Response.json({ turns: [{ kind: 'events', events: [event, { ...newest, content: 'Old copy' }] }] }))
    const history = await fetchCueSessionHistory('fixture', 'session', { fetchImpl })
    expect(history.messages).toEqual([
      expect.objectContaining({ id: extractCueHistoryMessages([event])[0]?.id, text: event.content }),
      expect.objectContaining({ id: 'same-id', text: 'Edited' })
    ])
  })

  it('parses proto3 stringified int64 and snake_case Cue membership quota fields', () => {
    const camel = mapCueMembershipQuota({
      membership: { accessAllowed: true },
      limitCredits: '1000',
      usedCredits: '250',
      reservedCredits: '50',
      weeklyRemainingCredits: '700',
      purchasedRemainingCredits: '300',
      windowStartMs: '1700000000000',
      windowEndMs: '1700604800000'
    })
    expect(camel).toEqual({
      accessAllowed: true,
      limitCredits: 1000,
      usedCredits: 250,
      reservedCredits: 50,
      weeklyRemainingCredits: 700,
      purchasedRemainingCredits: 300,
      remainingPercent: 70,
      windowStartMs: 1700000000000,
      windowEndMs: 1700604800000
    })

    const snake = mapCueMembershipQuota({
      membership: { access_allowed: false },
      limit_credits: '500',
      remaining_credits: '200',
      purchased_remaining_credits: '50'
    })
    expect(snake).toMatchObject({
      accessAllowed: false,
      limitCredits: 500,
      weeklyRemainingCredits: 200,
      purchasedRemainingCredits: 50,
      remainingPercent: 40
    })
  })

  it('falls back to GetAgentsAvailableCredits when GetAgentsMembership omits numeric credits', async () => {
    fetcherMock.mockReset()
    fetcherMock
      .mockResolvedValueOnce(Response.json({ membership: { accessAllowed: true } }))
      .mockResolvedValueOnce(
        Response.json({
          weeklyRemainingCredits: '850',
          purchasedRemainingCredits: '120',
          limitCredits: '1000'
        })
      )

    const quota = await fetchCueQuota('acc_cue_1')
    expect(quota).toMatchObject({
      accessAllowed: true,
      limitCredits: 1000,
      weeklyRemainingCredits: 850,
      purchasedRemainingCredits: 120,
      remainingPercent: 85
    })
    expect(quota.quotaUnavailable).toBeUndefined()
    expect(fetcherMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.manus.im/user.v1.SubscriptionService/GetAgentsMembership',
      'https://api.manus.im/user.v1.SubscriptionService/GetAgentsAvailableCredits'
    ])
  })

  it('extracts getSessionView cascade turns and events turns and paginates backward with before cursor', async () => {
    const cascadeSample = {
      turns: [
        {
          kind: 'cascade',
          prevId: 'turn_0',
          turn: {
            turnUserMessage: {
              id: 'u_turn1',
              type: 'chat',
              sender: 'user',
              content: '美国节点延迟怎么样',
              timestamp: 1700000010
            },
            blocks: [
              {
                type: 'lead',
                event: {
                  id: 'a_turn1_lead',
                  type: 'chat',
                  sender: 'assistant',
                  content: '正在帮你测试节点延迟…',
                  timestamp: 1700000011
                }
              },
              {
                type: 'fold',
                items: [
                  {
                    kind: 'event',
                    event: {
                      id: 'tool_1',
                      type: 'toolUsed',
                      tool: 'shell'
                    }
                  }
                ]
              },
              {
                type: 'plain',
                item: {
                  kind: 'event',
                  event: {
                    id: 'a_turn1_done',
                    type: 'chat',
                    sender: 'assistant',
                    content: '测试完成，美国节点平均 180ms。',
                    timestamp: 1700000012
                  }
                }
              }
            ]
          }
        },
        {
          kind: 'events',
          userChatId: 'u_turn2',
          events: [
            { id: 'u_turn2', type: 'chat', sender: 'user', content: '好的谢谢', timestamp: 1700000020 },
            { id: 'a_turn2', type: 'chat', sender: 'assistant', content: '不客气！', timestamp: 1700000021 }
          ]
        }
      ]
    }
    expect(extractCueHistoryMessages(cascadeSample)).toEqual([
      { id: 'u_turn1', role: 'user', text: '美国节点延迟怎么样', createdAtMs: 1700000010000 },
      { id: 'a_turn1_lead', role: 'bot', text: '正在帮你测试节点延迟…', createdAtMs: 1700000011000 },
      {
        id: 'a_turn1_done',
        role: 'bot',
        text: '测试完成，美国节点平均 180ms。',
        createdAtMs: 1700000012000,
        tools: [{ id: 'tool_1', name: 'shell', toolType: 'shell', status: 'completed' }]
      },
      { id: 'u_turn2', role: 'user', text: '好的谢谢', createdAtMs: 1700000020000 },
      { id: 'a_turn2', role: 'bot', text: '不客气！', createdAtMs: 1700000021000 }
    ])

    fetcherMock.mockReset()
    fetcherMock
      .mockResolvedValueOnce(
        Response.json({
          turns: [
            {
              kind: 'events',
              userChatId: 'u_page2',
              prevId: 'u_page1',
              events: [
                { id: 'u_page2', type: 'chat', sender: 'user', content: '11', timestamp: 1700000100 },
                { id: 'a_page2', type: 'chat', sender: 'assistant', content: '收到 11', timestamp: 1700000101 }
              ]
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          turns: [
            {
              kind: 'events',
              userChatId: 'u_page1',
              prevId: null,
              events: [
                { id: 'u_page1', type: 'chat', sender: 'user', content: '更早的提问', timestamp: 1700000001 },
                { id: 'a_page1', type: 'chat', sender: 'assistant', content: '更早的回答', timestamp: 1700000002 }
              ]
            }
          ]
        })
      )

    const paged = await fetchCueSessionHistory('acc_cue_1', 'sess_travel_1', { maxPages: 5 })
    expect(paged.ok).toBe(true)
    expect(paged.messages.map((m) => m.id)).toEqual(['u_page1', 'a_page1', 'u_page2', 'a_page2'])
    expect(String(fetcherMock.mock.calls[0]![0])).toContain('/api/chat/getSessionView?')
    expect(String(fetcherMock.mock.calls[0]![0])).toContain('type=private')
    expect(String(fetcherMock.mock.calls[0]![0])).toContain('layout=events')
    expect(String(fetcherMock.mock.calls[1]![0])).toContain('before=u_page2')
  })

  it('falls back to getSessionV2 when getSessionView fails or returns empty', async () => {
    fetcherMock.mockReset()
    fetcherMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          segments: [
            {
              events: [
                { id: 'v2_1', type: 'chat', sender: 'user', content: 'v2 q', timestamp: 1700000001 },
                { id: 'v2_2', type: 'chat', sender: 'assistant', content: 'v2 a', timestamp: 1700000002 }
              ]
            }
          ]
        })
      )

    const hist = await fetchCueSessionHistory('acc_cue_1', 'sess_fallback_1')
    expect(hist.ok).toBe(true)
    expect(hist.messages.map((m) => m.id)).toEqual(['v2_1', 'v2_2'])
    expect(String(fetcherMock.mock.calls[1]![0])).toContain('/api/chat/getSessionV2?')
    expect(String(fetcherMock.mock.calls[1]![0])).toContain('type=private')
  })

  it('extracts media attachments from chat history events including media-only replies', () => {
    const messages = extractCueHistoryMessages({
      events: [
        {
          id: 'm_img',
          type: 'chat',
          sender: 'assistant',
          content: '',
          timestamp: 1700000100,
          attachments: [
            {
              id: 'f_1',
              url: 'https://files.manuscdn.com/chart.png',
              filename: 'chart.png',
              mimeType: 'image/png'
            },
            {
              id: 'f_2',
              url: 'https://api.manus.im/files/report.pdf',
              filename: 'report.pdf',
              mimeType: 'application/pdf'
            }
          ]
        }
      ]
    })
    expect(messages).toEqual([
      {
        id: 'm_img',
        role: 'bot',
        text: '',
        createdAtMs: 1700000100000,
        media: [
          {
            kind: 'image',
            path: 'https://files.manuscdn.com/chart.png',
            name: 'chart.png',
            mimeType: 'image/png',
            imageId: 'f_1'
          },
          {
            kind: 'file',
            path: 'https://api.manus.im/files/report.pdf',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            imageId: 'f_2'
          }
        ]
      }
    ])
  })

  it('live-verifies native Cue tokens before saving and rejects expired credentials', async () => {
    const okFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ agents: [] }))
    const ok = await verifyCueNativeCredentials(
      'acc_verify',
      { accessToken: 'good_tok', authKind: 'session' },
      { fetchImpl: okFetch }
    )
    expect(ok).toEqual({ ok: true, status: 200 })

    const badFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
    const bad = await verifyCueNativeCredentials(
      'acc_verify',
      { accessToken: 'bad_tok', authKind: 'session' },
      { fetchImpl: badFetch }
    )
    expect(bad.ok).toBe(false)
    expect(bad.status).toBe(401)
  })

  it('proxy-downloads Cue media while enforcing HTTPS allowlist', async () => {
    const rejected = await downloadCueMedia('acc_cue_1', 'https://evil.example.com/secret.png')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.status).toBe(403)

    const bytes = new Uint8Array([137, 80, 78, 71])
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    )
    const ok = await downloadCueMedia('acc_cue_1', 'https://api.manus.im/files/plot.png', {
      fetchImpl
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.data.mimeType).toBe('image/png')
      expect(ok.data.filename).toBe('plot.png')
      expect(Buffer.from(ok.data.dataBase64, 'base64')).toEqual(Buffer.from(bytes))
    }
  })
})
