import { Context, Schema, h, Logger } from 'koishi'
import type { IncomingMessage } from 'http'
import type WebSocket from 'ws'
import type { RawData } from 'ws'
// @cordisjs/plugin-server provides ctx.server (Router with .ws() method)
import '@cordisjs/plugin-server'

export const name = 'sillytavern-bridge'
export const usage = `
Bridges SillyTavern chats to Koishi bot channels via WebSocket.

## Usage
1. Install and enable this plugin in Koishi
2. Install the companion SillyTavern client extension
3. Configure the WebSocket URL and API key in both sides
4. In a bot channel, use \`bind <chatId>\` to link the channel to a SillyTavern chat
5. Messages flow bidirectionally between ST and bound channels
`

// ============================================================
// Configuration
// ============================================================

export interface Config {
  wsPath: string
  apiKey: string
  userMessagePrefix: string
  aiMessagePrefix: string
  pingInterval: number
}

export const Config: Schema<Config> = Schema.object({
  wsPath: Schema.string()
    .default('/st-proxy')
    .description('WebSocket endpoint path on the Koishi router'),
  apiKey: Schema.string()
    .required()
    .role('secret')
    .description('API key for authenticating SillyTavern clients'),
  userMessagePrefix: Schema.string()
    .default('')
    .description('Prefix for user messages broadcast to channels (e.g. "📝 ")'),
  aiMessagePrefix: Schema.string()
    .default('')
    .description('Prefix for AI messages broadcast to channels (e.g. "🤖 ")'),
  pingInterval: Schema.number()
    .default(10)
    .min(1)
    .max(300)
    .description('WebSocket ping interval in seconds (RFC 6455 protocol-level ping)'),
})

import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { PassThrough } from 'stream'

// Configure fluent-ffmpeg with the static binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path)

async function convertToOggOpus(inputBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputStream = new PassThrough()
    inputStream.end(inputBuffer)

    const chunks: Buffer[] = []
    const outputStream = new PassThrough()

    outputStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    outputStream.on('error', reject)

    ffmpeg(inputStream)
      .inputFormat('mp3') // Assume MP3 since most TTS from ST are MP3, or we can omit to auto-detect
      .outputFormat('ogg')
      .audioCodec('libopus')
      .on('error', reject)
      .pipe(outputStream)
  })
}

// ============================================================
// Service Interface
// ============================================================

export const inject = {
  required: ['database', 'server'] as const,
}

// ============================================================
// Database Model
// ============================================================

declare module 'koishi' {
  interface Tables {
    st_bindings: STBinding
  }
}

export interface STBinding {
  id: number
  platform: string
  channelId: string
  guildId: string
  stChatId: string
  createdAt: Date
  createdBy: string
}

// ============================================================
// Protocol Types
// ============================================================

/** Messages from SillyTavern → Koishi */
interface STUserMessage {
  type: 'user_message'
  chatId: string
  characterName: string
  userName: string
  content: {
    text: string
    images?: Array<{ data: string; mimeType: string }>
    files?: Array<{ name: string; data: string; mimeType: string }>
  }
  sourceChannelKey: string | null
  timestamp: number
}

interface STAiMessage {
  type: 'ai_message'
  chatId: string
  characterName: string
  content: {
    text: string
    images?: Array<{ data: string; mimeType: string }>
  }
  timestamp: number
}

interface STAiTts {
  type: 'ai_tts'
  chatId: string
  characterName: string
  audio: string
  mimeType: string
  timestamp: number
}

interface STGenerationStarted {
  type: 'generation_started'
  chatId: string
  characterName: string
}

interface STGenerationEnded {
  type: 'generation_ended'
  chatId: string
}

interface STValidateChatResult {
  type: 'validate_chat_result'
  requestId: string
  valid: boolean
  chatId: string
  error?: string | null
}

interface STListChatsResult {
  type: 'list_chats_result'
  requestId: string
  chats: Array<{
    chatId: string
    characterName: string
    messageCount: number
    lastMessage: string
  }>
  error?: string
}

interface STSendMessageResult {
  type: 'send_message_result'
  sourceChannelKey: string
  success: boolean
  error?: string
}

interface STGetAvatarResult {
  type: 'get_avatar_result'
  requestId: string
  avatar: string | null
  mimeType?: string
  error?: string
}

type STUpstreamMessage =
  | STUserMessage
  | STAiMessage
  | STAiTts
  | STGenerationStarted
  | STGenerationEnded
  | STValidateChatResult
  | STListChatsResult
  | STSendMessageResult
  | STGetAvatarResult

/** Messages from Koishi → SillyTavern */
interface KoishiSendCombinedMessage {
  type: 'send_combined_message'
  chatId: string
  text: string
  files: Array<{
    name: string
    data: string
    mimeType: string
  }>
  sourceChannelKey: string
  senderName: string
}

interface KoishiValidateChat {
  type: 'validate_chat'
  requestId: string
  chatId: string
}

interface KoishiListChats {
  type: 'list_chats'
  requestId: string
}

interface KoishiGetAvatar {
  type: 'get_avatar'
  requestId: string
  characterName: string
}

type KoishiDownstreamMessage = KoishiSendCombinedMessage | KoishiValidateChat | KoishiListChats | KoishiGetAvatar

// ============================================================
// Plugin Entry
// ============================================================

const logger = new Logger('st-bridge')

export function apply(ctx: Context, config: Config) {

  // ----------------------------------------------------------
  // Database table
  // ----------------------------------------------------------

  ctx.model.extend('st_bindings', {
    id: 'unsigned',
    platform: 'string',
    channelId: 'string',
    guildId: 'string',
    stChatId: 'string',
    createdAt: 'timestamp',
    createdBy: 'string',
  }, {
    autoInc: true,
    unique: [['platform', 'channelId']],
  })

  // ----------------------------------------------------------
  // ST Client Management
  // ----------------------------------------------------------

  const allClients = new Set<WebSocket>()
  let activeClient: WebSocket | null = null

  /** Stores the last sent message per channel (for retry on failure) */
  const pendingSentMessages = new Map<string, KoishiSendCombinedMessage>()
  /** Stores the last failed message per channel for st.retry */
  const lastFailedMessage = new Map<string, KoishiSendCombinedMessage>()

  /** Send a message to the active ST client */
  function sendToST(msg: KoishiDownstreamMessage): boolean {
    if (!activeClient || activeClient.readyState !== 1) {
      return false
    }
    try {
      activeClient.send(JSON.stringify(msg))
      return true
    } catch (e) {
      logger.error('Failed to send to ST client:', e)
      return false
    }
  }

  // ----------------------------------------------------------
  // Request/Response for validate_chat and list_chats
  // ----------------------------------------------------------

  let requestCounter = 0
  const pendingRequests = new Map<string, { resolve: (value: any) => void, timer: ReturnType<typeof setTimeout> }>()

  function generateRequestId(): string {
    return `req_${++requestCounter}_${Date.now()}`
  }

  /** Send a request to ST and wait for the response (with timeout) */
  function requestST<T>(msg: KoishiDownstreamMessage, timeoutMs = 15000): Promise<T | null> {
    const requestId = (msg as any).requestId as string
    if (!sendToST(msg)) return Promise.resolve(null)

    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId)
        resolve(null)
      }, timeoutMs)
      pendingRequests.set(requestId, { resolve, timer })
    })
  }

  function handleRequestResponse(msg: STValidateChatResult | STListChatsResult | STGetAvatarResult) {
    const pending = pendingRequests.get(msg.requestId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingRequests.delete(msg.requestId)
      pending.resolve(msg)
    }
  }

  // ----------------------------------------------------------
  // Heartbeat (RFC 6455 protocol-level ping/pong)
  // ----------------------------------------------------------

  const clientAlive = new Map<WebSocket, boolean>()
  let pingTimer: ReturnType<typeof setInterval> | null = null

  function startPingTimer() {
    stopPingTimer()
    pingTimer = setInterval(() => {
      for (const client of allClients) {
        if (clientAlive.get(client) === false) {
          // Previous ping got no pong — dead connection
          logger.warn('ST client failed pong check, terminating')
          client.terminate()
          cleanupSocket(client)
          continue
        }
        clientAlive.set(client, false)
        try {
          client.ping() // RFC 6455 protocol-level ping
        } catch {
          // will be handled by close event
        }
      }
    }, config.pingInterval * 1000)
  }

  function stopPingTimer() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  ctx.on('dispose', stopPingTimer)

  // ----------------------------------------------------------
  // WebSocket Server
  // ----------------------------------------------------------

  /** Clean up a socket: remove all listeners, remove from set, update activeClient */
  function cleanupSocket(socket: WebSocket) {
    socket.removeAllListeners()
    allClients.delete(socket)
    clientAlive.delete(socket)
    if (activeClient === socket) {
      activeClient = allClients.size > 0
        ? [...allClients][allClients.size - 1]
        : null
    }
    logger.info(`ST client cleaned up. Remaining: ${allClients.size}`)
    if (allClients.size === 0) {
      stopPingTimer()
    }
  }

  ctx.server.ws(config.wsPath, (socket: WebSocket, req: IncomingMessage) => {
    // Authenticate
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const key = url.searchParams.get('key')
    if (key !== config.apiKey) {
      logger.warn('ST client authentication failed')
      socket.close(4001, 'Unauthorized')
      return
    }

    // Register client
    allClients.add(socket)
    clientAlive.set(socket, true)
    activeClient = socket
    logger.info(`ST client connected. Total: ${allClients.size}, using latest.`)
    startPingTimer()

    // RFC 6455: browser auto-replies pong to our ping
    socket.on('pong', () => {
      clientAlive.set(socket, true)
    })

    const onMessage = (raw: RawData) => {
      try {
        const msg: STUpstreamMessage = JSON.parse(raw.toString())
        handleSTMessage(msg).catch((e: unknown) => {
          logger.error('Error handling ST message:', e)
        })
      } catch (e) {
        logger.error('Failed to parse ST message:', e)
      }
    }

    const onClose = () => {
      cleanupSocket(socket)
    }

    const onError = (err: Error) => {
      logger.error('ST WebSocket error:', err)
      // error is always followed by close, so cleanup happens there
    }

    socket.on('message', onMessage)
    socket.on('close', onClose)
    socket.on('error', onError)
  })

  // When plugin is disposed (hot-reload / unload), close ALL client connections
  ctx.on('dispose', () => {
    for (const socket of allClients) {
      try {
        socket.close(1001, 'Plugin unloading')
      } catch {
        // ignored
      }
      cleanupSocket(socket)
    }
    allClients.clear()
    clientAlive.clear()
    activeClient = null
  })

  // ----------------------------------------------------------
  // Handle messages from ST
  // ----------------------------------------------------------

  async function handleSTMessage(msg: STUpstreamMessage) {
    switch (msg.type) {
      case 'user_message':
        await broadcastUserMessage(msg)
        break
      case 'ai_message':
        await broadcastAiMessage(msg)
        break
      case 'ai_tts':
        await broadcastAiTts(msg)
        break
      case 'generation_started': {
        const bindings = await getBindingsForChat(msg.chatId)
        for (const binding of bindings) {
          startTypingForChannel(binding.platform, binding.channelId)
        }
        break
      }
      case 'generation_ended': {
        const bindings = await getBindingsForChat(msg.chatId)
        for (const binding of bindings) {
          stopTypingForChannel(binding.platform, binding.channelId)
        }
        break
      }
      case 'validate_chat_result':
      case 'list_chats_result':
      case 'get_avatar_result':
        handleRequestResponse(msg)
        break
      case 'send_message_result':
        await handleSendMessageResult(msg)
        break
      default:
        logger.warn('Unknown message type from ST:', (msg as any).type)
    }
  }

  async function handleSendMessageResult(msg: STSendMessageResult) {
    if (msg.success) {
      // Clear any pending failed message for this channel
      pendingSentMessages.delete(msg.sourceChannelKey)
      lastFailedMessage.delete(msg.sourceChannelKey)
      return
    }

    // Store the failed message for retry
    const originalMsg = pendingSentMessages.get(msg.sourceChannelKey)
    if (originalMsg) {
      lastFailedMessage.set(msg.sourceChannelKey, originalMsg)
      pendingSentMessages.delete(msg.sourceChannelKey)
    }

    // Parse sourceChannelKey: "platform:channelId"
    const colonIdx = msg.sourceChannelKey.indexOf(':')
    if (colonIdx === -1) return

    const platform = msg.sourceChannelKey.substring(0, colonIdx)
    const channelId = msg.sourceChannelKey.substring(colonIdx + 1)

    try {
      await sendToChannel(platform, channelId, `ST error: ${msg.error || 'unknown error'}\nUse st.retry to retry.`)
    } catch (e) {
      logger.error(`Failed to send error notification to ${msg.sourceChannelKey}:`, e)
    }
  }

  // ----------------------------------------------------------
  // Bot Avatar Sync
  // ----------------------------------------------------------

  async function syncBotAvatar(chatId: string) {
    if (!activeClient || activeClient.readyState !== 1) return

    // Extract character name from chatId
    const sepIdx = chatId.indexOf(' - ')
    if (sepIdx === -1) return
    const charName = chatId.substring(0, sepIdx)

    const reqId = generateRequestId()
    const result = await requestST<STGetAvatarResult>({
      type: 'get_avatar',
      requestId: reqId,
      characterName: charName,
    })

    if (!result || !result.avatar) {
      logger.warn('Failed to get avatar:', result?.error || 'no response')
      return
    }

    const imageBuffer = Buffer.from(result.avatar, 'base64')

    // Set avatar for all bots that have bindings to this chatId
    const bindings = await ctx.database.get('st_bindings', { stChatId: chatId })
    const platforms = new Set(bindings.map(b => b.platform))

    for (const platform of platforms) {
      const bot = findBot(platform)
      if (!bot) continue

      try {
        if (platform === 'telegram') {
          // Telegram requires InputProfilePhoto format with attach:// reference
          const token = (bot.config as any)?.token
          if (!token) continue

          const boundary = '----FormBoundary' + Math.random().toString(36).slice(2)
          const photoJson = JSON.stringify({ type: 'static', photo: 'attach://avatar_file' })

          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\n`),
            Buffer.from('Content-Disposition: form-data; name="photo"\r\n\r\n'),
            Buffer.from(photoJson + '\r\n'),
            Buffer.from(`--${boundary}\r\n`),
            Buffer.from('Content-Disposition: form-data; name="avatar_file"; filename="avatar.png"\r\n'),
            Buffer.from(`Content-Type: ${result.mimeType || 'image/png'}\r\n\r\n`),
            imageBuffer,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ])

          const resp = await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
          })
          const respJson = await resp.json() as any
          if (respJson.ok) {
            logger.info(`Telegram bot avatar updated for character: ${charName}`)
          } else {
            logger.warn(`Telegram setMyProfilePhoto failed: ${respJson.description}`)
          }
        } else if (platform === 'discord') {
          const base64 = `data:image/png;base64,${result.avatar}`
          await (bot as any).internal.modifyCurrentUser({ avatar: base64 })
          logger.info(`Discord bot avatar updated for character: ${charName}`)
        }
      } catch (e) {
        logger.warn(`Failed to set bot avatar for ${platform}:`, e)
      }
    }
  }

  // ----------------------------------------------------------
  // Broadcasting: ST → Channels
  // ----------------------------------------------------------

  function findBot(platform: string) {
    // Status.ONLINE = 1 (const enum from @satorijs/protocol)
    return ctx.bots.find(b => b.platform === platform && b.status === 1 /* Status.ONLINE */)
  }

  /** Send a message to a channel, releasing any typing lock first */
  async function sendToChannel(platform: string, channelId: string, content: string) {
    stopTyping(`${platform}:${channelId}`)
    const bot = findBot(platform)
    if (!bot) return
    await bot.sendMessage(channelId, content)
  }

  // ----------------------------------------------------------
  // Typing Indicator (Promise lock pattern)
  // ----------------------------------------------------------

  const TYPING_INTERVAL = 4000 // resend typing every 4s (Telegram expires after 5s)
  const typingLocks = new Map<string, { release: () => void }>()

  /** Send a single typing action for a channel (best-effort) */
  async function sendTypingAction(bot: any, channelId: string) {
    try {
      if (bot.platform === 'telegram') {
        await (bot as any).internal.sendChatAction({
          chat_id: channelId,
          action: 'typing',
        })
      } else if (bot.platform === 'discord') {
        await (bot as any).internal.triggerTypingIndicator(channelId)
      }
    } catch {
      // best effort
    }
  }

  /**
   * Start typing for a specific platform and channel.
   * Typing continues until stopTyping is called.
   */
  function startTypingForChannel(platform: string, channelId: string): string {
    const key = `${platform}:${channelId}`
    const bot = findBot(platform)
    if (!bot) return key

    // Release any existing typing lock for this channel
    typingLocks.get(key)?.release()

    // Create a lock (pending Promise + release function)
    let released = false
    let releaseFn!: () => void
    const lockPromise = new Promise<void>(resolve => {
      releaseFn = () => {
        if (released) return
        released = true
        resolve()
      }
    })

    typingLocks.set(key, { release: releaseFn })

    // Start typing loop (async, non-blocking)
    ;(async () => {
      while (!released) {
        await sendTypingAction(bot, channelId)
        // Wait 4s OR lock release, whichever comes first
        await Promise.race([
          new Promise(r => setTimeout(r, TYPING_INTERVAL)),
          lockPromise,
        ])
      }
      typingLocks.delete(key)
    })()

    return key
  }

  function stopTypingForChannel(platform: string, channelId: string) {
    const key = `${platform}:${channelId}`
    typingLocks.get(key)?.release()
  }

  /** Legacy helper for commands using session */
  function startTyping(session: any): string {
    return startTypingForChannel(session.platform, session.channelId)
  }

  /** Stop typing for a channel by key */
  function stopTyping(key: string) {
    typingLocks.get(key)?.release()
  }

  ctx.on('dispose', () => {
    for (const lock of typingLocks.values()) {
      lock.release()
    }
    typingLocks.clear()
  })

  async function getBindingsForChat(chatId: string): Promise<STBinding[]> {
    return ctx.database.get('st_bindings', { stChatId: chatId })
  }

  async function broadcastUserMessage(msg: STUserMessage) {
    const bindings = await getBindingsForChat(msg.chatId)
    if (!bindings.length) {
      logger.debug('No bindings found for chatId:', msg.chatId)
      return
    }

    for (const binding of bindings) {
      const channelKey = `${binding.platform}:${binding.channelId}`

      // Skip the originating channel
      if (msg.sourceChannelKey === channelKey) continue

      try {
        // Build message content
        const parts: string[] = []

        // Text
        if (msg.content.text) {
          parts.push(`${config.userMessagePrefix}${msg.userName}: ${msg.content.text}`)
        }

        // Images
        if (msg.content.images?.length) {
          for (const img of msg.content.images) {
            parts.push(h('image', {
              url: `data:${img.mimeType};base64,${img.data}`,
            }).toString())
          }
        }

        // Files
        if (msg.content.files?.length) {
          for (const file of msg.content.files) {
            parts.push(h('file', {
              url: `data:${file.mimeType};base64,${file.data}`,
            }).toString())
          }
        }

        if (parts.length > 0) {
          await sendToChannel(binding.platform, binding.channelId, parts.join('\n'))
        }
      } catch (e) {
        logger.error(`Failed to broadcast user message to ${channelKey}:`, e)
      }
    }
  }

  async function broadcastAiMessage(msg: STAiMessage) {
    const bindings = await getBindingsForChat(msg.chatId)
    if (!bindings.length) return

    for (const binding of bindings) {
      const key = `${binding.platform}:${binding.channelId}`
      stopTyping(key)

      const bot = findBot(binding.platform)
      if (!bot) continue

      try {
        const text = msg.content.text
          ? `${config.aiMessagePrefix}${msg.characterName}: ${msg.content.text}`
          : ''
        const hasImages = msg.content.images && msg.content.images.length > 0

        if (hasImages) {
          const parts: string[] = []
          for (const img of msg.content.images!) {
            parts.push(h('image', {
              url: `data:${img.mimeType};base64,${img.data}`,
            }).toString())
          }
          if (text) {
            parts.push(text)
          }
          await bot.sendMessage(binding.channelId, parts.join('\n'))
        } else if (text) {
          await sendToChannel(binding.platform, binding.channelId, text)
        }
      } catch (e) {
        logger.error(`Failed to broadcast AI message to ${key}:`, e)
      }
    }
  }

  async function broadcastAiTts(msg: STAiTts) {
    const bindings = await getBindingsForChat(msg.chatId)
    if (!bindings.length) return

    for (const binding of bindings) {
      const key = `${binding.platform}:${binding.channelId}`
      stopTyping(key)

      const bot = findBot(binding.platform)
      if (!bot) continue

      try {
        const audioBuffer = Buffer.from(msg.audio, 'base64')
        const isMp3OrOgg = msg.mimeType === 'audio/mpeg' || msg.mimeType === 'audio/ogg'
        
        let finalBuffer = audioBuffer
        let mimeType = msg.mimeType
        
        // Transcode to OGG Opus to ensure native voice message format across all platforms
        if (isMp3OrOgg && msg.mimeType !== 'audio/ogg') {
          try {
            finalBuffer = await convertToOggOpus(audioBuffer) as any
            mimeType = 'audio/ogg'
          } catch (err) {
            logger.warn('Failed to transcode TTS audio to OGG, falling back to original format', err)
          }
        }
        
        const audioUrl = `data:${mimeType};base64,${finalBuffer.toString('base64')}`
        await bot.sendMessage(binding.channelId, h('audio', { url: audioUrl }).toString())
      } catch (e) {
        logger.error(`Failed to broadcast TTS to ${key}:`, e)
      }
    }
  }

  // ----------------------------------------------------------
  // Channel → ST: Forward channel messages (middleware)
  // Uses next() callback so commands are consumed first and
  // only plain text messages reach the forwarding logic.
  // ----------------------------------------------------------

  ctx.middleware(async (session, next) => {
    return next(async (done) => {
      // This callback only runs if the message was NOT consumed by a command
      const pass = () => done?.() as any

      // Ignore bot's own messages
      if (session.userId === session.selfId) return pass()

      // Look up binding for this channel
      const [binding] = await ctx.database.get('st_bindings', {
        platform: session.platform,
        channelId: session.channelId,
      })
      if (!binding) return pass()

      // No active ST client — notify user
      if (!activeClient || activeClient.readyState !== 1) {
        await session.send('ST client is not connected. Message not forwarded.')
        return pass()
      }

      // Start typing immediately — content extraction (downloading images/audio) may take time
      startTyping(session)

      // Extract text, images, and audio from message elements
      const textParts: string[] = []
      const files: Array<{ name: string; data: string; mimeType: string }> = []

      logger.info(`Message elements: ${session.elements?.map((e: any) => e.type).join(', ') || 'none'}`)

      if (session.elements) {
        for (const el of session.elements) {
          const src = el.attrs?.src || el.attrs?.url
          switch (el.type) {
            case 'text':
              textParts.push(el.attrs?.content || '')
              break
            case 'at':
              textParts.push(`@${el.attrs?.name || el.attrs?.id || ''}`)
              break
            default: {
              // Handle all file-like elements: image, img, audio, voice, record, video, file, etc.
              logger.info(`Processing element type="${el.type}" src="${src?.substring(0, 60) || 'none'}"`)
              if (!src && !session.platform) break
              let data = src?.startsWith('http') ? await downloadToBase64(src, 'application/octet-stream') : null
              if (!data && session.platform === 'telegram') {
                const rawEvent = (session.event as any)?._data?.message || (session.event as any)?._data
                logger.info(`Telegram fallback: rawEvent keys=${Object.keys(rawEvent || {})}`)
                // Try to extract file_id from various Telegram message types
                const fileId =
                  rawEvent?.photo?.[rawEvent.photo.length - 1]?.file_id ||
                  rawEvent?.voice?.file_id ||
                  rawEvent?.audio?.file_id ||
                  rawEvent?.video?.file_id ||
                  rawEvent?.document?.file_id ||
                  rawEvent?.sticker?.file_id ||
                  rawEvent?.video_note?.file_id ||
                  rawEvent?.animation?.file_id
                const fileName = rawEvent?.document?.file_name || el.attrs?.file || `file.bin`
                const mimeType = rawEvent?.document?.mime_type || rawEvent?.audio?.mime_type || rawEvent?.video?.mime_type || 'application/octet-stream'
                logger.info(`Telegram fallback: fileId=${fileId}, fileName=${fileName}, mimeType=${mimeType}`)
                if (fileId) {
                  data = await downloadTelegramFile(session, fileId, fileName, mimeType)
                  logger.info(`Telegram fallback download result: ${data ? 'success' : 'failed'}`)
                }
              }
              if (data) files.push(data)
              break
            }
          }
        }
      }

      let text = textParts.join('').trim()
      // Only fallback to session.content if no elements were parsed at all
      if (!session.elements || session.elements.length === 0) {
        text = text || session.content?.trim() || ''
      }

      // Skip empty messages with no media
      if (!text && files.length === 0) {
        stopTyping(`${session.platform}:${session.channelId}`)
        return pass()
      }

      const sourceChannelKey = `${session.platform}:${session.channelId}`
      const senderName = session.username || session.userId || 'Unknown'

      const msg: KoishiSendCombinedMessage = {
        type: 'send_combined_message',
        chatId: binding.stChatId,
        text,
        files,
        sourceChannelKey,
        senderName,
      }

      // Track for potential retry
      pendingSentMessages.set(sourceChannelKey, msg)
      const sent = sendToST(msg)

      if (sent) {
        // New message sent successfully — clear stale failed message for this channel
        lastFailedMessage.delete(sourceChannelKey)
      } else {
        await session.send('Failed to forward message to ST.')
      }

      return pass()
    })
  })

  // ----------------------------------------------------------
  // Helper: Fetch URL content as base64
  // ----------------------------------------------------------

  /** Download a URL to base64 using ctx.http (handles Satori internal URLs) */
  async function downloadToBase64(url: string, defaultMimeType = 'application/octet-stream'): Promise<{ name: string; data: string; mimeType: string } | null> {
    try {
      const buffer = Buffer.from(
        await ctx.http.get(url, { responseType: 'arraybuffer' })
      )
      if (!buffer.length) return null
      // Infer mime type from URL extension as fallback
      const ext = url.split('.').pop()?.split('?')[0] || 'bin'
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm',
        pdf: 'application/pdf', txt: 'text/plain',
      }
      const mimeType = mimeMap[ext] || defaultMimeType
      return {
        name: `file.${ext}`,
        data: buffer.toString('base64'),
        mimeType,
      }
    } catch (e) {
      logger.warn(`Failed to download ${url}:`, e)
      return null
    }
  }

  /** Download a Telegram file by file_id via internal.getFile + ctx.http (respects proxy-agent) */
  async function downloadTelegramFile(session: any, fileId: string, defaultName: string, defaultMime: string): Promise<{ name: string; data: string; mimeType: string } | null> {
    try {
      const token = (session.bot.config as any)?.token
      if (!token) { logger.warn('No Telegram bot token found'); return null }
      const file = await (session.bot as any).internal.getFile({ file_id: fileId })
      if (!file?.file_path) { logger.warn(`getFile returned no file_path for ${fileId}`); return null }
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
      const result = await downloadToBase64(url, defaultMime)
      if (result) result.name = defaultName || result.name
      return result
    } catch (e) {
      logger.warn('Telegram file download failed:', e)
    }
    return null
  }

  // ----------------------------------------------------------
  // Commands
  // ----------------------------------------------------------

  // Parent command group
  ctx.command('st', 'SillyTavern bridge commands')

  ctx.command('st.bind <chatId:text>', 'Bind this channel to a SillyTavern chat')
    .alias('st-bind')
    .usage('Usage: st.bind <chatId>\nGet the chatId from st.list or the SillyTavern extension settings panel.')
    .example('st.bind Ani - 2026-03-14@18h06m18s170ms')
    .action(async ({ session }, chatId) => {
      if (!chatId) return 'Please provide a SillyTavern chat ID.'
      if (!session) return

      const typingKey = startTyping(session)
      try {
        if (!activeClient || activeClient.readyState !== 1) {
          return 'ST client is not connected. Cannot validate chat ID.'
        }

        const reqId = generateRequestId()
        const result = await requestST<STValidateChatResult>({
          type: 'validate_chat',
          requestId: reqId,
          chatId,
        })

        if (!result) {
          return 'ST client did not respond (timeout). Is the browser tab open?'
        }
        if (!result.valid) {
          return `Invalid chat ID: ${result.error || 'not found'}`
        }

        await ctx.database.upsert('st_bindings', [{
          platform: session.platform,
          channelId: session.channelId,
          guildId: session.guildId || '',
          stChatId: chatId,
          createdAt: new Date(),
          createdBy: session.userId,
        }], ['platform', 'channelId'])

        // Sync bot avatar with the character's avatar (async, don't wait)
        syncBotAvatar(chatId).catch(e => logger.warn('Avatar sync failed:', e))

        return `Bound to SillyTavern chat: ${chatId}`
      } finally {
        stopTyping(typingKey)
      }
    })

  ctx.command('st.unbind', 'Unbind this channel from SillyTavern')
    .alias('st-unbind')
    .action(async ({ session }) => {
      if (!session) return

      const typingKey = startTyping(session)
      try {
        const removed = await ctx.database.remove('st_bindings', {
          platform: session.platform,
          channelId: session.channelId,
        })

        if (!removed.matched) {
          return 'This channel is not bound to any SillyTavern chat.'
        }
        return 'Unbound from SillyTavern chat.'
      } finally {
        stopTyping(typingKey)
      }
    })

  ctx.command('st.list', 'List all SillyTavern chats')
    .alias('st-list')
    .action(async ({ session }) => {
      if (!session) return

      const typingKey = startTyping(session)
      try {
        if (!activeClient || activeClient.readyState !== 1) {
          return 'ST client is not connected.'
        }

        const reqId = generateRequestId()
        const result = await requestST<STListChatsResult>({
          type: 'list_chats',
          requestId: reqId,
        })

        if (!result) {
          return 'ST client did not respond (timeout).'
        }
        if (result.error) {
          return `Error: ${result.error}`
        }
        if (!result.chats.length) {
          return 'No chats found.'
        }

        const lines = result.chats.map((chat, i) =>
          `${i + 1}. [${h('b', chat.characterName).toString()}] ${h('code', chat.chatId).toString()} (${chat.messageCount} msgs)`
        )
        return lines.join('\n')
      } finally {
        stopTyping(typingKey)
      }
    })

  ctx.command('st.status', 'Show SillyTavern bridge status')
    .alias('st-status')
    .action(async ({ session }) => {
      if (!session) return

      const typingKey = startTyping(session)
      try {
        const [binding] = await ctx.database.get('st_bindings', {
          platform: session.platform,
          channelId: session.channelId,
        })

        const stConnected = activeClient?.readyState === 1

        return [
          `Binding: ${binding ? h('code', binding.stChatId).toString() : 'not bound'}`,
          `ST connection: ${stConnected ? 'online' : 'offline'}`,
          `ST clients: ${allClients.size}`,
          `Ping interval: ${config.pingInterval}s`,
        ].join('\n')
      } finally {
        stopTyping(typingKey)
      }
    })

  ctx.command('st.config <key:string> [value:string]', 'View or update bridge configuration')
    .alias('st-config')
    .usage('Usage: st.config ping <seconds>\nExample: st.config ping 5')
    .action(async ({ session }, key, value) => {
      const typingKey = session ? startTyping(session) : ''
      try {
        if (!key) {
          return `Current config:\n  ping: ${config.pingInterval}s`
        }

      if (key === 'ping') {
        if (!value) {
          return `ping: ${config.pingInterval}s`
        }
        const seconds = parseInt(value, 10)
        if (isNaN(seconds) || seconds < 1 || seconds > 300) {
          return 'Invalid value. ping must be 1-300 seconds.'
        }
        config.pingInterval = seconds
        // Restart ping timer with new interval
        if (allClients.size > 0) {
          startPingTimer()
        }
        // Persist to koishi.yml via ctx.scope
        ctx.scope.update(config)
        return `Ping interval set to ${seconds}s (saved)`
      }

      return `Unknown config key: ${key}\nAvailable keys: ping`
      } finally {
        stopTyping(typingKey)
      }
    })

  ctx.command('st.retry', 'Retry the last failed message to SillyTavern')
    .alias('st-retry')
    .action(async ({ session }) => {
      if (!session) return

      const typingKey = startTyping(session)
      try {
        if (!activeClient || activeClient.readyState !== 1) {
          return 'ST client is not connected. Cannot retry.'
        }

        const channelKey = `${session.platform}:${session.channelId}`
        const failedMsg = lastFailedMessage.get(channelKey)
        if (!failedMsg) {
          return 'No failed message to retry.'
        }

        // Re-send the failed message
        const sent = sendToST(failedMsg)
        if (!sent) {
          return 'Failed to send. ST client may have disconnected.'
        }

        // Track it again for potential re-failure
        pendingSentMessages.set(channelKey, failedMsg)
        // Clear from failed (will be re-added if it fails again)
        lastFailedMessage.delete(channelKey)

        return 'Retrying last message...'
      } finally {
        stopTyping(typingKey)
      }
    })
}
