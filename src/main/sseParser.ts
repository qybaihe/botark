export interface ParsedSseFrame {
  event: string
  data: string
}

/**
 * Incremental SSE frame parser handling arbitrary chunk boundaries, CRLF/LF,
 * comment keepalives (`: keepalive`), multi-line `data:` blocks, and `event:` headers.
 */
export class SseParser {
  private static readonly MAX_FRAME_LENGTH = 16 * 1024 * 1024
  constructor(private readonly oversizedFrame: () => Error = () => new Error('SSE frame too large')) {}

  private buffer = ''
  private currentEvent = ''
  private currentData: string[] = []
  private frameLength = 0

  feed(chunk: string): ParsedSseFrame[] {
    return [...this.frames(chunk)]
  }

  *frames(chunk: string): Generator<ParsedSseFrame> {
    let start = 0
    let nl = chunk.indexOf('\n')
    while (nl !== -1) {
      this.checkFrameLength(this.buffer.length + nl - start + 1)
      const line = (this.buffer + chunk.slice(start, nl)).replace(/\r$/, '')
      this.buffer = ''
      if (line === '') {
        const frame = this.takeFrame()
        if (frame) yield frame
      } else if (line.startsWith(':')) {
        // SSE comment / keepalive
      } else if (line.startsWith('event:')) {
        this.currentEvent = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        this.currentData.push(line.slice(5).trimStart())
      }
      if (line.startsWith('data:') || line.startsWith('event:')) this.frameLength += line.length + 1
      start = nl + 1
      nl = chunk.indexOf('\n', start)
    }
    this.checkFrameLength(this.buffer.length + chunk.length - start)
    this.buffer += chunk.slice(start)
  }

  flush(): ParsedSseFrame[] {
    const frames = this.buffer ? this.feed('\n') : []
    const frame = this.takeFrame()
    if (frame) frames.push(frame)
    return frames
  }

  private checkFrameLength(extra: number): void {
    if (this.frameLength + extra > SseParser.MAX_FRAME_LENGTH) {
      throw this.oversizedFrame()
    }
  }

  private takeFrame(): ParsedSseFrame | undefined {
    const frame = this.currentEvent || this.currentData.length
      ? { event: this.currentEvent || 'message', data: this.currentData.join('\n') }
      : undefined
    this.currentEvent = ''
    this.currentData = []
    this.frameLength = 0
    return frame
  }
}
