import { Context, Schema, h, Logger, Universal } from 'koishi'
import { createHash } from 'crypto'
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
  showAiName: boolean
  notifyBotOnline: boolean
  notifySTOnline: boolean
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
  showAiName: Schema.boolean()
    .default(true)
    .description('Show AI character name as a header before messages'),
  notifyBotOnline: Schema.boolean()
    .default(true)
    .description('Send notification when bot comes online'),
  notifySTOnline: Schema.boolean()
    .default(true)
    .description('Send notification when SillyTavern connects/disconnects'),
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
    st_status_msgs: STStatusMessage
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
  lastMessageId: string
}

export interface STStatusMessage {
  id: number
  platform: string
  channelId: string
  messageId: string
  category: string
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
  messageId: number
  content: {
    text: string
    images?: Array<{ data: string; mimeType: string }>
    reasoning?: string
  }
  timestamp: number
}

interface STAiTts {
  type: 'ai_tts'
  chatId: string
  characterName: string
  messageId: number | null
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

interface KoishiReloadPage {
  type: 'reload_page'
}

type KoishiDownstreamMessage = KoishiSendCombinedMessage | KoishiValidateChat | KoishiListChats | KoishiGetAvatar | KoishiReloadPage

// ============================================================
// Plugin Entry
// ============================================================

const logger = new Logger('st-bridge')

export function apply(ctx: Context, config: Config) {

  // ----------------------------------------------------------
  // Fix: set bot.server for Telegram bots so $getFileFromPath
  // returns proper HTTP URLs instead of crashing on relative paths.
  //
  // Without this, the adapter's $getFileFromId fails because:
  //   $getFileFromPath → this.server is undefined → this.file.file('/path')
  //   → Satori core http/file hook does new URL('/path') → ERR_INVALID_URL
  //
  // With bot.server set, $getFileFromPath returns:
  //   { src: 'https://api.telegram.org/file/bot{TOKEN}/photos/file_XX.jpg' }
  // ----------------------------------------------------------

  function fixTelegramBotServer(bot: any) {
    if (bot.platform !== 'telegram' || bot.server) return
    const endpoint = bot.file?.config?.endpoint
    if (endpoint) {
      bot.server = endpoint
      logger.info(`Set Telegram bot file server: ${endpoint}`)
    }
  }

  for (const bot of ctx.bots) fixTelegramBotServer(bot)
  ctx.on('bot-added', (bot) => fixTelegramBotServer(bot))

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
    lastMessageId: 'string',
  }, {
    autoInc: true,
    unique: [['platform', 'channelId']],
  })

  ctx.model.extend('st_status_msgs', {
    id: 'unsigned',
    platform: 'string',
    channelId: 'string',
    messageId: 'string',
    category: 'string',
  }, {
    autoInc: true,
  })

  // Load persisted lastMessageId from DB into memory on startup
  ctx.on('ready', async () => {
    const bindings = await ctx.database.get('st_bindings', {})
    for (const b of bindings) {
      if (b.lastMessageId) {
        lastSeenMessageId.set(`${b.platform}:${b.channelId}`, b.lastMessageId)
      }
    }
    if (lastSeenMessageId.size) {
      logger.info(`Loaded lastMessageId for ${lastSeenMessageId.size} channel(s) from DB`)
    }
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

  // --- Bot offline/online debounce state ---
  const RECONNECT_GRACE_PERIOD = 30000
  /** Pending offline notification timers, keyed by bot.sid */
  const botOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Track when each bot went offline (epoch ms), keyed by bot.sid */
  const botOfflineAt = new Map<string, number>()

  // --- Missed message recovery state ---
  /** Last processed message ID per bound channel. Key = "platform:channelId" */
  const lastSeenMessageId = new Map<string, string>()
  const MAX_RECOVERY_MESSAGES = 50

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
      // Send persistent offline notification (deleted when ST reconnects)
      if (config.notifySTOnline) {
        broadcastStatusNotification('st_offline', 'SillyTavern offline')
      }
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

    // Notify all bound channels — delete "ST offline" messages, send "ST online"
    if (config.notifySTOnline) {
      broadcastStatusNotification('st_online', 'SillyTavern online', undefined, ['st_offline'], 30000)
    }

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

    // Clean up bot offline debounce timers
    for (const timer of botOfflineTimers.values()) clearTimeout(timer)
    botOfflineTimers.clear()
    botOfflineAt.clear()

    // Clean up in-memory caches
    lastSeenMessageId.clear()
  })

  // ----------------------------------------------------------
  // Status Notifications (event-driven, with 30s debounce)
  //
  // When a bot goes offline, we start a grace period timer.
  // If the bot reconnects within the grace period, we suppress
  // both offline logging and online notifications (brief blip).
  // If it stays offline beyond the grace period, we log it.
  // On genuine reconnect (after grace period), we send a
  // notification and attempt to recover missed messages.
  // ----------------------------------------------------------

  ctx.on('login-updated', (session) => {
    const bot = session.bot
    const sid = bot.sid

    if (bot.status === Universal.Status.ONLINE) {
      const timer = botOfflineTimers.get(sid)
      if (timer) {
        // Reconnected within grace period — suppress all notifications
        clearTimeout(timer)
        botOfflineTimers.delete(sid)
        botOfflineAt.delete(sid)
        logger.info(`Bot ${sid} reconnected within ${RECONNECT_GRACE_PERIOD}ms, suppressing notifications`)
      } else if (botOfflineAt.has(sid)) {
        // Was offline longer than grace period — genuine reconnect
        logger.info(`Bot ${sid} is back online after outage, notifying bound channels`)
        if (config.notifyBotOnline) {
          broadcastStatusNotification('bot_online', "I'm back online — ready when you are.", bot.platform, undefined, 30000)
        }
        // Recover messages sent while bot was offline
        recoverMissedMessages(bot).catch(e => logger.warn('Missed message recovery failed:', e))
        botOfflineAt.delete(sid)
      } else {
        // First-time online (no recorded offline) — normal startup
        logger.info(`Bot ${sid} is online`)
        if (config.notifyBotOnline) {
          broadcastStatusNotification('bot_online', "I'm back online — ready when you are.", bot.platform, undefined, 30000)
        }
      }
    } else if (bot.status === Universal.Status.OFFLINE || bot.status === Universal.Status.DISCONNECT) {
      if (!botOfflineTimers.has(sid)) {
        botOfflineAt.set(sid, Date.now())
        logger.info(`Bot ${sid} went offline, starting ${RECONNECT_GRACE_PERIOD}ms grace period`)
        const timer = setTimeout(() => {
          botOfflineTimers.delete(sid)
          logger.warn(`Bot ${sid} confirmed offline (grace period expired)`)
        }, RECONNECT_GRACE_PERIOD)
        botOfflineTimers.set(sid, timer)
      }
    } else if (bot.status === Universal.Status.RECONNECT) {
      logger.info(`Bot ${sid} is reconnecting...`)
    }
  })

  // ----------------------------------------------------------
  // Missed Message Recovery
  //
  // When a bot reconnects after an outage, iterate recent
  // channel messages (newest-first via getMessageIter) until
  // we reach the last message we processed before going offline.
  // Bundle missed messages with ISO 8601 timestamps and forward
  // them to ST as a single combined message per channel.
  // ----------------------------------------------------------

  async function recoverMissedMessages(bot: any) {
    if (!activeClient || activeClient.readyState !== 1) {
      logger.info('ST not connected, skipping missed message recovery')
      return
    }

    const bindings = await ctx.database.get('st_bindings', { platform: bot.platform })
    if (!bindings.length) return

    for (const binding of bindings) {
      const channelKey = `${binding.platform}:${binding.channelId}`
      const lastId = lastSeenMessageId.get(channelKey)
      if (!lastId) continue // Never processed a message here — skip

      try {
        const missed: Array<{ sender: string; text: string; time: string }> = []

        for await (const msg of bot.getMessageIter(binding.channelId)) {
          // Stop when we reach the last message we already processed
          if (msg.id === lastId) break
          // Skip bot's own messages
          if (msg.user?.id === bot.selfId) continue
          // Safety limit
          if (missed.length >= MAX_RECOVERY_MESSAGES) break

          const sender = msg.user?.name || msg.user?.nick || msg.user?.id || 'Unknown'
          const content = msg.content || msg.elements?.map((e: any) => {
            if (e.type === 'text') return e.attrs?.content || ''
            if (e.type === 'img' || e.type === 'image') return '[Image]'
            if (e.type === 'audio' || e.type === 'voice' || e.type === 'record') return '[Audio]'
            if (e.type === 'video') return '[Video]'
            if (e.type === 'file') return '[File]'
            return ''
          }).join('') || '[empty]'

          const timestamp = msg.createdAt || msg.timestamp || Date.now()
          missed.push({ sender, text: content, time: toLocalISO(timestamp) })
        }

        if (!missed.length) continue

        // getMessageIter yields newest-first; reverse for chronological order
        missed.reverse()

        // Update lastSeenMessageId to the newest recovered message
        // (first item before reverse = newest = missed[missed.length - 1] after reverse is wrong,
        //  but we can just leave it — the next real message from middleware will update it)

        const bundled = missed.map(m => `[${m.time}] ${m.sender}: ${m.text}`).join('\n')
        const header = `--- ${missed.length} message(s) received while bot was offline ---`

        const msg: KoishiSendCombinedMessage = {
          type: 'send_combined_message',
          chatId: binding.stChatId,
          text: `${header}\n${bundled}`,
          files: [],
          sourceChannelKey: channelKey,
          senderName: '[System: Offline Recovery]',
        }
        sendToST(msg)
        logger.info(`Recovered ${missed.length} missed message(s) for ${channelKey}`)
      } catch (e) {
        // getMessageIter not supported by this adapter, or other error — not fatal
        logger.debug(`Could not recover messages for ${channelKey}: ${e}`)
      }
    }
  }

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
        logger.debug(`generation_started received, chatId=${msg.chatId}`)
        const bindings = await getBindingsForChat(msg.chatId)
        for (const binding of bindings) {
          startTypingForChannel(binding.platform, binding.channelId)
        }
        break
      }
      case 'generation_ended': {
        logger.debug(`generation_ended received, chatId=${msg.chatId}`)
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
      await sendMuted(platform, channelId, `ST error: ${msg.error || 'unknown error'}\nUse st.retry to retry.`)
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
    return ctx.bots.find(b => b.platform === platform && b.status === Universal.Status.ONLINE)
  }

  /** Wrap text in a blockquote element for system/header messages */
  function sysMsg(text: string): string {
    return `<quote>${text}</quote>`
  }

  /** Escape HTML special characters for Telegram HTML parse mode */
  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  /** Format a timestamp as ISO 8601 with the server's local timezone offset */
  function toLocalISO(ts: number): string {
    const d = new Date(ts)
    const off = -d.getTimezoneOffset() // minutes ahead of UTC
    const sign = off >= 0 ? '+' : '-'
    const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
    return d.getFullYear()
      + '-' + pad(d.getMonth() + 1)
      + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours())
      + ':' + pad(d.getMinutes())
      + ':' + pad(d.getSeconds())
      + sign + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60)
  }

  /**
   * Format system text as a blockquote for a specific platform's native API.
   * Used by sendMuted() which bypasses the Satori MessageEncoder.
   */
  function sysMsgNative(text: string, platform: string): string {
    switch (platform) {
      case 'telegram':
        return `<blockquote>${escapeHtml(text)}</blockquote>`
      case 'discord':
        return text.split('\n').map(l => `> ${l}`).join('\n')
      default:
        return text
    }
  }

  /**
   * Send a message silently (no push notification) if the platform supports it.
   * Falls back to normal bot.sendMessage() on unsupported platforms.
   * @param text - Raw text content (NOT wrapped in sysMsg; formatting is handled internally)
   * @returns message IDs array (for auto-delete), or empty on failure
   */
  async function sendMuted(platform: string, channelId: string, text: string): Promise<string[]> {
    stopTyping(`${platform}:${channelId}`)
    const bot = findBot(platform)
    if (!bot) return []

    try {
      switch (platform) {
        case 'telegram': {
          const result = await (bot as any).internal.sendMessage({
            chat_id: channelId,
            text: sysMsgNative(text, 'telegram'),
            parse_mode: 'HTML',
            disable_notification: true,
          })
          return [String(result.message_id)]
        }
        case 'discord': {
          const result = await (bot as any).internal.createMessage(channelId, {
            content: sysMsgNative(text, 'discord'),
            flags: 1 << 12, // SUPPRESS_NOTIFICATIONS
          })
          return [result.id]
        }
        case 'matrix': {
          const txnId = `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`
          const result = await (bot as any).http.put(
            `/client/v3/rooms/${encodeURIComponent(channelId)}/send/m.room.message/${txnId}`,
            {
              msgtype: 'm.notice',
              body: text,
              format: 'org.matrix.custom.html',
              formatted_body: `<blockquote>${escapeHtml(text)}</blockquote>`,
            },
          )
          return [(result as any).event_id]
        }
        default:
          // Platform does not support muted sending — fall back to normal send
          return await bot.sendMessage(channelId, sysMsg(text)) ?? []
      }
    } catch (e) {
      logger.warn(`sendMuted failed on ${platform}:${channelId}:`, e)
      return []
    }
  }

  /** Send a message to a channel, releasing any typing lock first */
  async function sendToChannel(platform: string, channelId: string, content: string): Promise<string[]> {
    stopTyping(`${platform}:${channelId}`)
    const bot = findBot(platform)
    if (!bot) return []
    return await bot.sendMessage(channelId, content)
  }

  /**
   * Send an AI message with reasoning/thinking content using platform-native APIs.
   * Formats reasoning differently per platform for optimal display.
   * Caller is responsible for calling stopTyping() before invoking this.
   */
  async function sendAiMessageWithReasoning(
    platform: string, channelId: string, bot: any,
    nameHeader: string, reasoning: string, bodyText: string,
  ): Promise<string[]> {
    try {
      switch (platform) {
        case 'telegram': {
          const parts: string[] = []
          if (nameHeader) parts.push(`<blockquote>${escapeHtml(nameHeader)}</blockquote>`)
          parts.push(`<blockquote expandable>Thinking:\n${escapeHtml(reasoning)}</blockquote>`)
          if (bodyText) parts.push(escapeHtml(bodyText))
          const result = await (bot as any).internal.sendMessage({
            chat_id: channelId,
            text: parts.join('\n'),
            parse_mode: 'HTML',
          })
          return [String(result.message_id)]
        }
        case 'discord': {
          const parts: string[] = []
          if (nameHeader) parts.push(`> ${nameHeader}`)
          const reasoningLines = reasoning.split('\n')
            .map(l => l ? `> *${l.replace(/\*/g, '\\*')}*` : '>')
            .join('\n')
          parts.push(`> *Thinking:*\n${reasoningLines}`)
          if (bodyText) {
            parts.push('') // empty line to end blockquote
            parts.push(bodyText)
          }
          const result = await (bot as any).internal.createMessage(channelId, {
            content: parts.join('\n'),
          })
          return [result.id]
        }
        case 'matrix': {
          const txnId = `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`
          const htmlParts: string[] = []
          const plainParts: string[] = []
          if (nameHeader) {
            htmlParts.push(`<blockquote>${escapeHtml(nameHeader)}</blockquote>`)
            plainParts.push(`> ${nameHeader}`)
          }
          htmlParts.push(`<blockquote><em style="color:gray">Thinking:\n${escapeHtml(reasoning)}</em></blockquote>`)
          plainParts.push(`> Thinking:\n${reasoning}`)
          if (bodyText) {
            htmlParts.push(escapeHtml(bodyText))
            plainParts.push(bodyText)
          }
          const result = await (bot as any).http.put(
            `/client/v3/rooms/${encodeURIComponent(channelId)}/send/m.room.message/${txnId}`,
            {
              msgtype: 'm.text',
              body: plainParts.join('\n'),
              format: 'org.matrix.custom.html',
              formatted_body: htmlParts.join('\n'),
            },
          )
          return [(result as any).event_id]
        }
        default: {
          // Satori fallback: quote + italic
          const parts: string[] = []
          if (nameHeader) parts.push(sysMsg(nameHeader))
          parts.push(`<quote><i>Thinking:\n${reasoning}</i></quote>`)
          if (bodyText) parts.push(bodyText)
          return await bot.sendMessage(channelId, parts.join('\n')) ?? []
        }
      }
    } catch (e) {
      logger.warn(`sendAiMessageWithReasoning failed on ${platform}:${channelId}:`, e)
      return []
    }
  }

  /** Broadcast a message to all bound channels, optionally filtered by platform */
  async function broadcastToAllChannels(content: string, platformFilter?: string) {
    const query: any = {}
    if (platformFilter) query.platform = platformFilter
    const bindings = await ctx.database.get('st_bindings', query)
    for (const b of bindings) {
      sendToChannel(b.platform, b.channelId, content).catch(() => {})
    }
  }

  /**
   * Send a message and auto-delete it after a delay (best-effort).
   * @param content - When muted=false, should be pre-formatted (e.g. sysMsg wrapped).
   *                  When muted=true, should be raw text (sendMuted handles formatting).
   * @param muted - If true, send silently via sendMuted() (no push notification).
   */
  async function sendTemporary(platform: string, channelId: string, content: string, deleteAfterMs = 30000, muted = false) {
    const bot = findBot(platform)
    if (!bot) return
    try {
      const msgIds = muted
        ? await sendMuted(platform, channelId, content)
        : await bot.sendMessage(channelId, content)
      if (msgIds?.length) {
        setTimeout(async () => {
          for (const id of msgIds) {
            try { await bot.deleteMessage(channelId, id) } catch { /* best effort */ }
          }
        }, deleteAfterMs)
      }
    } catch {
      // best effort
    }
  }

  /**
   * Broadcast a temporary message to all bound channels, auto-deleted after delay.
   * @param content - When muted=false, should be pre-formatted. When muted=true, raw text.
   * @param muted - If true, send silently via sendMuted() (no push notification).
   */
  async function broadcastTemporary(content: string, deleteAfterMs = 30000, platformFilter?: string, muted = false) {
    const query: any = {}
    if (platformFilter) query.platform = platformFilter
    const bindings = await ctx.database.get('st_bindings', query)
    for (const b of bindings) {
      sendTemporary(b.platform, b.channelId, content, deleteAfterMs, muted)
    }
  }

  // ----------------------------------------------------------
  // DB-backed Status Notifications
  //
  // Every status notification (bot_online, st_online, st_offline)
  // is tracked in st_status_msgs so that old notifications can
  // be deleted even after a server restart/crash.
  // ----------------------------------------------------------

  /**
   * Send a status notification to a single channel, replacing any previous
   * notification of the same category (and optionally extra categories).
   * Message IDs are persisted in DB so cleanup survives restarts.
   */
  async function sendStatusNotification(
    category: string,
    platform: string,
    channelId: string,
    text: string,
    alsoDeleteCategories?: string[],
    autoDeleteMs?: number,
  ) {
    const bot = findBot(platform)
    if (!bot) return

    // 1. Find old notifications to clean up
    const cats = [category, ...(alsoDeleteCategories || [])]
    const oldMsgs = await ctx.database.get('st_status_msgs', {
      platform, channelId, category: { $in: cats },
    })

    // 2. Delete old platform messages (best-effort)
    for (const old of oldMsgs) {
      bot.deleteMessage(channelId, old.messageId).catch(() => {})
    }

    // 3. Remove old DB records
    if (oldMsgs.length) {
      await ctx.database.remove('st_status_msgs', {
        platform, channelId, category: { $in: cats },
      })
    }

    // 4. Send new muted notification
    const msgIds = await sendMuted(platform, channelId, text)

    // 5. Persist new message IDs
    for (const messageId of msgIds) {
      await ctx.database.create('st_status_msgs', {
        platform, channelId, messageId, category,
      })
    }

    // 6. Auto-delete after delay (DB record cleaned up too, so crash recovery won't re-delete)
    if (autoDeleteMs && msgIds.length) {
      setTimeout(async () => {
        const b = findBot(platform)
        if (!b) return
        for (const id of msgIds) {
          b.deleteMessage(channelId, id).catch(() => {})
        }
        ctx.database.remove('st_status_msgs', {
          platform, channelId, messageId: { $in: msgIds },
        }).catch(() => {})
      }, autoDeleteMs)
    }
  }

  /**
   * Broadcast a status notification to all bound channels,
   * optionally filtered by platform. Replaces old notifications
   * of the same category in each channel.
   */
  async function broadcastStatusNotification(
    category: string,
    text: string,
    platformFilter?: string,
    alsoDeleteCategories?: string[],
    autoDeleteMs?: number,
  ) {
    const query: any = {}
    if (platformFilter) query.platform = platformFilter
    const bindings = await ctx.database.get('st_bindings', query)
    for (const b of bindings) {
      sendStatusNotification(category, b.platform, b.channelId, text, alsoDeleteCategories, autoDeleteMs)
        .catch(e => logger.warn(`sendStatusNotification failed for ${b.platform}:${b.channelId}:`, e))
    }
  }

  // ----------------------------------------------------------
  // Typing Indicator (Heartbeat pattern)
  //
  // ST sends generation_started every 2s as a heartbeat.
  // Koishi records the arrival time using its own clock.
  // The typing loop checks each cycle: if no heartbeat
  // within 8s, the loop exits automatically.
  // ----------------------------------------------------------

  const TYPING_INTERVAL = 4000      // resend typing every 4s (Telegram expires after 5s)
  const HEARTBEAT_TIMEOUT = 8000    // stop typing if no heartbeat for 8s
  const MAX_TYPING_DURATION = 180000 // safety: force stop after 3 minutes

  /** Per-channel heartbeat timestamp. 0 = default / explicit stop. */
  const typingHeartbeats = new Map<string, number>()
  /** Tracks which channels currently have an active typing loop. */
  const typingLoopActive = new Set<string>()

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
   * Start or refresh typing for a specific platform and channel.
   * - If a loop is already running: just update the heartbeat timestamp.
   * - If no loop exists: update heartbeat and start a new typing loop.
   */
  function startTypingForChannel(platform: string, channelId: string): string {
    const key = `${platform}:${channelId}`

    // Always update heartbeat to current time
    typingHeartbeats.set(key, Date.now())

    // If loop already running, heartbeat refresh is enough
    if (typingLoopActive.has(key)) return key

    const bot = findBot(platform)
    if (!bot) return key

    // Start typing loop (async, non-blocking)
    typingLoopActive.add(key)
    logger.debug(`Typing loop started: ${key}`)
    ;(async () => {
      const startTime = Date.now()
      while (true) {
        const lastHeartbeat = typingHeartbeats.get(key) ?? 0
        if (Date.now() - lastHeartbeat >= HEARTBEAT_TIMEOUT) {
          logger.debug(`Typing loop exited (heartbeat timeout): ${key}`)
          break
        }
        if (Date.now() - startTime >= MAX_TYPING_DURATION) {
          logger.warn(`Typing loop force stopped (max duration ${MAX_TYPING_DURATION}ms): ${key}`)
          break
        }
        await sendTypingAction(bot, channelId)
        await new Promise(r => setTimeout(r, TYPING_INTERVAL))
      }
      typingLoopActive.delete(key)
    })()

    return key
  }

  /**
   * Explicitly stop typing for a channel by setting heartbeat to 0.
   * The loop will see Date.now() - 0 ≫ 8s on its next check and exit.
   */
  function stopTypingForChannel(platform: string, channelId: string) {
    const key = `${platform}:${channelId}`
    logger.debug(`Typing stop requested: ${key}`)
    typingHeartbeats.set(key, 0)
  }

  /** Stop typing for a channel by key */
  function stopTyping(key: string) {
    typingHeartbeats.set(key, 0)
  }

  ctx.on('dispose', () => {
    for (const key of typingHeartbeats.keys()) {
      typingHeartbeats.set(key, 0)
    }
    typingHeartbeats.clear()
    typingLoopActive.clear()
  })

  // Per-channel cache: stMsgId → platformMsgId (for TTS reply targeting)
  const MSG_CACHE_MAX = 1000
  const msgIdCache = new Map<string, Map<number, string>>()

  function cacheMsgId(channelKey: string, stMsgId: number, platformMsgId: string) {
    let map = msgIdCache.get(channelKey)
    if (!map) {
      map = new Map()
      msgIdCache.set(channelKey, map)
    }
    map.set(stMsgId, platformMsgId)
    if (map.size > MSG_CACHE_MAX) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
  }

  ctx.on('dispose', () => { msgIdCache.clear() })

  // Per-channel TTS dedup: messageId → audio content hash
  const TTS_DEDUP_MAX = 500
  const ttsDedup = new Map<string, Map<number, string>>()

  function isDuplicateTts(channelKey: string, messageId: number, audio: string): boolean {
    const hash = createHash('md5').update(audio).digest('hex')
    let map = ttsDedup.get(channelKey)
    if (!map) {
      map = new Map()
      ttsDedup.set(channelKey, map)
    }
    if (map.get(messageId) === hash) return true
    map.set(messageId, hash)
    if (map.size > TTS_DEDUP_MAX) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    return false
  }

  ctx.on('dispose', () => { ttsDedup.clear() })

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
          parts.push(`${sysMsg(`${msg.userName}:`)}\n${msg.content.text}`)
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

    // Filter: only include reasoning if it has non-whitespace content; preserve original (no trim)
    const reasoning = msg.content.reasoning?.trim() ? msg.content.reasoning : ''

    for (const binding of bindings) {
      const key = `${binding.platform}:${binding.channelId}`
      stopTyping(key)

      const bot = findBot(binding.platform)
      if (!bot) continue

      try {
        const nameHeader = config.showAiName ? `${msg.characterName}:` : ''
        const bodyText = msg.content.text || ''
        const hasImages = msg.content.images && msg.content.images.length > 0

        if (reasoning && !hasImages) {
          // Text-only with reasoning: use platform-native APIs for best formatting
          const sentIds = await sendAiMessageWithReasoning(
            binding.platform, binding.channelId, bot,
            nameHeader, reasoning, bodyText,
          )
          if (sentIds?.length && msg.messageId != null) {
            cacheMsgId(key, msg.messageId, sentIds[0])
          }
        } else {
          // Standard path: no reasoning, or images present (Satori-based)
          let text: string
          if (reasoning && hasImages) {
            // Images + reasoning: use Satori formatting as fallback
            const parts: string[] = []
            if (nameHeader) parts.push(sysMsg(nameHeader))
            parts.push(`<quote><i>Thinking:\n${reasoning}</i></quote>`)
            if (bodyText) parts.push(bodyText)
            text = parts.join('\n')
          } else {
            text = bodyText
              ? (nameHeader ? `${sysMsg(nameHeader)}\n${bodyText}` : bodyText)
              : ''
          }

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
            const sentIds = await bot.sendMessage(binding.channelId, parts.join('\n'))
            if (sentIds?.length && msg.messageId != null) {
              cacheMsgId(key, msg.messageId, sentIds[0])
            }
          } else if (text) {
            const sentIds = await sendToChannel(binding.platform, binding.channelId, text)
            if (sentIds?.length && msg.messageId != null) {
              cacheMsgId(key, msg.messageId, sentIds[0])
            }
          }
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

      // Dedup: skip if same audio for same messageId was already sent to this channel
      if (msg.messageId != null && isDuplicateTts(key, msg.messageId, msg.audio)) {
        logger.debug(`TTS dedup: skipping duplicate for msg #${msg.messageId} on ${key}`)
        continue
      }

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
        const audioElement = h('audio', { url: audioUrl }).toString()

        // Reply to the corresponding text message if cached
        let content: string
        if (msg.messageId != null) {
          const platformMsgId = msgIdCache.get(key)?.get(msg.messageId)
          content = platformMsgId
            ? h.quote(platformMsgId).toString() + audioElement
            : audioElement
        } else {
          content = audioElement
        }

        await bot.sendMessage(binding.channelId, content)
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
        await sendMuted(session.platform, session.channelId!, 'ST client is not connected. Message not forwarded.')
        return pass()
      }

      // Extract text, images, and audio from message elements
      const textParts: string[] = []
      const files: Array<{ name: string; data: string; mimeType: string }> = []

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
              if (!src) {
                logger.warn(`Element ${el.type} has no src, skipping. attrs=${JSON.stringify(el.attrs)}`)
                break
              }
              logger.debug(`Element ${el.type} src: ${src.substring(0, 80)}...`)
              let data: { name: string; data: string; mimeType: string } | null = null
              if (src.startsWith('data:')) {
                // data: URL — adapter already downloaded, extract directly
                const buf = Buffer.from(
                  await ctx.http.get(src, { responseType: 'arraybuffer' })
                )
                if (buf.length) {
                  const mimeType = src.split(';')[0].split(':')[1] || 'application/octet-stream'
                  const ext = mimeType.split('/')[1] || 'bin'
                  data = { name: `file.${ext}`, data: buf.toString('base64'), mimeType }
                }
              } else {
                // http: or other URL — download
                data = await downloadToBase64(src, 'application/octet-stream')
              }
              if (data) {
                files.push(data)
              } else {
                logger.warn(`Failed to download ${el.type} from ${src.substring(0, 60)}`)
              }
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

      // Track last seen message ID for offline recovery (memory + DB)
      if (session.messageId) {
        lastSeenMessageId.set(sourceChannelKey, session.messageId)
        ctx.database.set('st_bindings', {
          platform: session.platform,
          channelId: session.channelId,
        }, { lastMessageId: session.messageId }).catch(() => {})
      }

      // Track for potential retry
      pendingSentMessages.set(sourceChannelKey, msg)
      const sent = sendToST(msg)

      if (sent) {
        // New message sent successfully — clear stale failed message for this channel
        lastFailedMessage.delete(sourceChannelKey)
      } else {
        await sendMuted(session.platform, session.channelId!, 'Failed to forward message to ST.')
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
      if (!chatId) return sysMsg('Please provide a SillyTavern chat ID.')
      if (!session) return

      if (!activeClient || activeClient.readyState !== 1) {
        return sysMsg('ST client is not connected. Cannot validate chat ID.')
      }

      const reqId = generateRequestId()
      const result = await requestST<STValidateChatResult>({
        type: 'validate_chat',
        requestId: reqId,
        chatId,
      })

      if (!result) {
        return sysMsg('ST client did not respond (timeout). Is the browser tab open?')
      }
      if (!result.valid) {
        return sysMsg(`Invalid chat ID: ${result.error || 'not found'}`)
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

      return sysMsg(`Bound to SillyTavern chat: ${chatId}`)
    })

  ctx.command('st.unbind', 'Unbind this channel from SillyTavern')
    .alias('st-unbind')
    .action(async ({ session }) => {
      if (!session) return

      const removed = await ctx.database.remove('st_bindings', {
        platform: session.platform,
        channelId: session.channelId,
      })

      if (!removed.matched) {
        return sysMsg('This channel is not bound to any SillyTavern chat.')
      }

      // Clean up status notification records and in-memory cache
      await ctx.database.remove('st_status_msgs', {
        platform: session.platform,
        channelId: session.channelId,
      })
      lastSeenMessageId.delete(`${session.platform}:${session.channelId}`)

      return sysMsg('Unbound from SillyTavern chat.')
    })

  ctx.command('st.list', 'List all SillyTavern chats')
    .alias('st-list')
    .action(async ({ session }) => {
      if (!session) return

      if (!activeClient || activeClient.readyState !== 1) {
        return sysMsg('ST client is not connected.')
      }

      const reqId = generateRequestId()
      const result = await requestST<STListChatsResult>({
        type: 'list_chats',
        requestId: reqId,
      })

      if (!result) {
        return sysMsg('ST client did not respond (timeout).')
      }
      if (result.error) {
        return sysMsg(`Error: ${result.error}`)
      }
      if (!result.chats.length) {
        return sysMsg('No chats found.')
      }

      const lines = result.chats.map((chat, i) =>
        `${i + 1}. [${h('b', chat.characterName).toString()}] ${h('code', chat.chatId).toString()} (${chat.messageCount} msgs)`
      )
      return sysMsg(lines.join('\n'))
    })

  ctx.command('st.status', 'Show SillyTavern bridge status')
    .alias('st-status')
    .action(async ({ session }) => {
      if (!session) return

      const [binding] = await ctx.database.get('st_bindings', {
        platform: session.platform,
        channelId: session.channelId,
      })

      const stConnected = activeClient?.readyState === 1

      return sysMsg([
        `Binding: ${binding ? h('code', binding.stChatId).toString() : 'not bound'}`,
        `ST connection: ${stConnected ? 'online' : 'offline'}`,
        `ST clients: ${allClients.size}`,
        `Ping interval: ${config.pingInterval}s`,
      ].join('\n'))
    })

  ctx.command('st.config <key:string> [value:string]', 'View or update bridge configuration')
    .alias('st-config')
    .usage('Usage: st.config <key> [value]\nKeys: ping, ainame, botonline, stonline')
    .example('st.config ping 5')
    .example('st.config ainame false')
    .action(async ({ session }, key, value) => {
      if (!key) {
        return sysMsg([
          'Current config:',
          `  ping: ${config.pingInterval}s`,
          `  ainame: ${config.showAiName}`,
          `  botonline: ${config.notifyBotOnline}`,
          `  stonline: ${config.notifySTOnline}`,
        ].join('\n'))
      }

      if (key === 'ping') {
        if (!value) {
          return sysMsg(`ping: ${config.pingInterval}s`)
        }
        const seconds = parseInt(value, 10)
        if (isNaN(seconds) || seconds < 1 || seconds > 300) {
          return sysMsg('Invalid value. ping must be 1-300 seconds.')
        }
        config.pingInterval = seconds
        if (allClients.size > 0) {
          startPingTimer()
        }
        ctx.scope.update(config)
        return sysMsg(`Ping interval set to ${seconds}s (saved)`)
      }

      if (key === 'ainame') {
        if (!value) {
          return sysMsg(`ainame: ${config.showAiName}`)
        }
        if (value !== 'true' && value !== 'false') {
          return sysMsg('Invalid value. ainame must be true or false.')
        }
        config.showAiName = value === 'true'
        ctx.scope.update(config)
        return sysMsg(`AI name display ${config.showAiName ? 'enabled' : 'disabled'} (saved)`)
      }

      if (key === 'botonline') {
        if (!value) {
          return sysMsg(`botonline: ${config.notifyBotOnline}`)
        }
        if (value !== 'true' && value !== 'false') {
          return sysMsg('Invalid value. botonline must be true or false.')
        }
        config.notifyBotOnline = value === 'true'
        ctx.scope.update(config)
        return sysMsg(`Bot online notification ${config.notifyBotOnline ? 'enabled' : 'disabled'} (saved)`)
      }

      if (key === 'stonline') {
        if (!value) {
          return sysMsg(`stonline: ${config.notifySTOnline}`)
        }
        if (value !== 'true' && value !== 'false') {
          return sysMsg('Invalid value. stonline must be true or false.')
        }
        config.notifySTOnline = value === 'true'
        ctx.scope.update(config)
        return sysMsg(`ST online notification ${config.notifySTOnline ? 'enabled' : 'disabled'} (saved)`)
      }

      return sysMsg(`Unknown config key: ${key}\nAvailable keys: ping, ainame, botonline, stonline`)
    })

  ctx.command('st.retry', 'Retry the last failed message to SillyTavern')
    .alias('st-retry')
    .action(async ({ session }) => {
      if (!session) return

      if (!activeClient || activeClient.readyState !== 1) {
        return sysMsg('ST client is not connected. Cannot retry.')
      }

      const channelKey = `${session.platform}:${session.channelId}`
      const failedMsg = lastFailedMessage.get(channelKey)
      if (!failedMsg) {
        return sysMsg('No failed message to retry.')
      }

      // Re-send the failed message
      const sent = sendToST(failedMsg)
      if (!sent) {
        return sysMsg('Failed to send. ST client may have disconnected.')
      }

      // Track it again for potential re-failure
      pendingSentMessages.set(channelKey, failedMsg)
      // Clear from failed (will be re-added if it fails again)
      lastFailedMessage.delete(channelKey)

      return sysMsg('Retrying last message...')
    })

  ctx.command('st.reload', 'Force reload the SillyTavern browser page')
    .alias('st-reload')
    .action(async ({ session }) => {
      if (!session) return
      if (!activeClient || activeClient.readyState !== 1) {
        return sysMsg('ST client is not connected.')
      }
      sendToST({ type: 'reload_page' })
      return sysMsg('SillyTavern reload signal sent.')
    })
}
