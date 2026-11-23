import type { SlackInbound, SlackState } from '@shared/slack'
import type { SlackBridge } from '@shared/slack'
import { submitBrief, useRooms } from './roomStore'
import type { CollabRoom } from './model'

export function receiveSlackMessage(event: SlackInbound): boolean {
  const rooms = useRooms.getState().rooms
  const parent = rooms.find((r) => r.id === event.roomId)
  if (!parent || parent.coordinatorId) return false
  const id = event.fork ? event.roomId + '/slack/' + event.channel + '/' + event.thread : parent.id
  let room = rooms.find((r) => r.id === id)
  if (!room) {
    room = { ...parent, id, title: parent.title + ' · ' + event.text.slice(0, 40),
      messages: [], brief: '', finalId: undefined, slackParent: parent.id, slackThread: event.thread, slackChannel: event.channel,
      members: parent.members.map((m) => ({ ...m, cursor: 0, sessionId: ['grok', 'dot'].includes(m.platform) ? m.sessionId : undefined })) }
    useRooms.setState((s) => ({ rooms: [...s.rooms, room!], externalAudiences: { ...s.externalAudiences, [id]: 'Slack ' + event.channel } }))
  }
  if (!room.messages.some((m) => m.id === event.id)) void submitBrief(id, event.text, 'Slack ' + event.user, event.id)
  return true
}

function publishNew(bridge: SlackBridge, room: CollabRoom, previousLength: number) {
  for (const message of room.messages.slice(previousLength)) {
    if (message.id.startsWith('slack-')) continue
    void bridge.request({ op: 'post', roomId: room.slackParent ?? room.id, thread: room.slackThread, channel: room.slackChannel,
      text: `[${message.author}] ${message.text}` }).catch((e) => useRooms.setState((s) => ({
        errors: { ...s.errors, [room.id]: `Slack 同步失败：${e instanceof Error ? e.message : String(e)}` }
      })))
  }
}
let unsubscribe: (() => void) | undefined

export function applySlackConnection(bridge: SlackBridge, connection: SlackState) {
  unsubscribe?.()
  unsubscribe = undefined
  if (connection.connected) sessionStorage.setItem('botark.slack.connected', '1')
  else sessionStorage.removeItem('botark.slack.connected')
  const bound = new Map(connection.connected ? connection.bindings.map((b) => [b.roomId, b.channel]) : [])
  const audiences: Record<string, string> = {}
  for (const room of useRooms.getState().rooms) {
    const channel = bound.get(room.slackParent ?? room.id)
    if (channel) audiences[room.id] = 'Slack ' + channel
  }
  useRooms.setState({ externalAudiences: audiences })
  if (!connection.connected) return
  const off = bridge.onMessage((msg) => {
    if (receiveSlackMessage(msg)) void bridge.request({ op: 'received', id: msg.id }).catch(() => {})
  })
  const stop = useRooms.subscribe((state, before) => {
    if (state.rooms === before.rooms) return
    for (const room of state.rooms) {
      if (room.coordinatorId || !bound.has(room.slackParent ?? room.id)) continue
      const old = before.rooms.find((r) => r.id === room.id)
      if (old && room.messages.length > old.messages.length) publishNew(bridge, room, old.messages.length)
    }
  })
  unsubscribe = () => { off(); stop() }
}
