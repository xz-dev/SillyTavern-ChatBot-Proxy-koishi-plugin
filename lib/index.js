"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.Config = exports.usage = exports.name = void 0;
exports.apply = apply;
const koishi_1 = require("koishi");
// @cordisjs/plugin-server provides ctx.server (Router with .ws() method)
require("@cordisjs/plugin-server");
exports.name = 'sillytavern-bridge';
exports.usage = `
Bridges SillyTavern chats to Koishi bot channels via WebSocket.

## Usage
1. Install and enable this plugin in Koishi
2. Install the companion SillyTavern client extension
3. Configure the WebSocket URL and API key in both sides
4. In a bot channel, use \`bind <chatId>\` to link the channel to a SillyTavern chat
5. Messages flow bidirectionally between ST and bound channels
`;
exports.Config = koishi_1.Schema.object({
    wsPath: koishi_1.Schema.string()
        .default('/st-proxy')
        .description('WebSocket endpoint path on the Koishi router'),
    apiKey: koishi_1.Schema.string()
        .required()
        .role('secret')
        .description('API key for authenticating SillyTavern clients'),
    userMessagePrefix: koishi_1.Schema.string()
        .default('')
        .description('Prefix for user messages broadcast to channels (e.g. "📝 ")'),
    aiMessagePrefix: koishi_1.Schema.string()
        .default('')
        .description('Prefix for AI messages broadcast to channels (e.g. "🤖 ")'),
});
// ============================================================
// Service Dependencies
// ============================================================
exports.inject = {
    required: ['database', 'server'],
};
// ============================================================
// Plugin Entry
// ============================================================
const logger = new koishi_1.Logger('st-bridge');
function apply(ctx, config) {
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
    });
    // ----------------------------------------------------------
    // ST Client Management
    // ----------------------------------------------------------
    const allClients = new Set();
    let activeClient = null;
    /** Send a message to the active ST client */
    function sendToST(msg) {
        if (!activeClient || activeClient.readyState !== 1) {
            return false;
        }
        try {
            activeClient.send(JSON.stringify(msg));
            return true;
        }
        catch (e) {
            logger.error('Failed to send to ST client:', e);
            return false;
        }
    }
    // ----------------------------------------------------------
    // Request/Response for validate_chat and list_chats
    // ----------------------------------------------------------
    let requestCounter = 0;
    const pendingRequests = new Map();
    function generateRequestId() {
        return `req_${++requestCounter}_${Date.now()}`;
    }
    /** Send a request to ST and wait for the response (with timeout) */
    function requestST(msg, timeoutMs = 15000) {
        const requestId = msg.requestId;
        if (!sendToST(msg))
            return Promise.resolve(null);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingRequests.delete(requestId);
                resolve(null);
            }, timeoutMs);
            pendingRequests.set(requestId, { resolve, timer });
        });
    }
    function handleRequestResponse(msg) {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(msg.requestId);
            pending.resolve(msg);
        }
    }
    // ----------------------------------------------------------
    // Heartbeat
    // ----------------------------------------------------------
    const PING_INTERVAL = 30_000;
    let pingTimer = null;
    function startPingTimer() {
        if (pingTimer)
            return;
        pingTimer = setInterval(() => {
            for (const client of allClients) {
                if (client.readyState === 1) {
                    try {
                        client.send(JSON.stringify({ type: 'ping' }));
                    }
                    catch {
                        // will be handled by close event
                    }
                }
            }
        }, PING_INTERVAL);
    }
    function stopPingTimer() {
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
    }
    ctx.on('dispose', stopPingTimer);
    // ----------------------------------------------------------
    // WebSocket Server
    // ----------------------------------------------------------
    /** Clean up a socket: remove all listeners, remove from set, update activeClient */
    function cleanupSocket(socket) {
        socket.removeAllListeners();
        allClients.delete(socket);
        if (activeClient === socket) {
            activeClient = allClients.size > 0
                ? [...allClients][allClients.size - 1]
                : null;
        }
        logger.info(`ST client cleaned up. Remaining: ${allClients.size}`);
        if (allClients.size === 0) {
            stopPingTimer();
        }
    }
    ctx.server.ws(config.wsPath, (socket, req) => {
        // Authenticate
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const key = url.searchParams.get('key');
        if (key !== config.apiKey) {
            logger.warn('ST client authentication failed');
            socket.close(4001, 'Unauthorized');
            return;
        }
        // Register client
        allClients.add(socket);
        activeClient = socket;
        logger.info(`ST client connected. Total: ${allClients.size}, using latest.`);
        startPingTimer();
        const onMessage = (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                handleSTMessage(msg).catch((e) => {
                    logger.error('Error handling ST message:', e);
                });
            }
            catch (e) {
                logger.error('Failed to parse ST message:', e);
            }
        };
        const onClose = () => {
            cleanupSocket(socket);
        };
        const onError = (err) => {
            logger.error('ST WebSocket error:', err);
            // error is always followed by close, so cleanup happens there
        };
        socket.on('message', onMessage);
        socket.on('close', onClose);
        socket.on('error', onError);
    });
    // When plugin is disposed (hot-reload / unload), close ALL client connections
    ctx.on('dispose', () => {
        for (const socket of allClients) {
            try {
                socket.close(1001, 'Plugin unloading');
            }
            catch {
                // ignored
            }
            cleanupSocket(socket);
        }
        allClients.clear();
        activeClient = null;
    });
    // ----------------------------------------------------------
    // Handle messages from ST
    // ----------------------------------------------------------
    async function handleSTMessage(msg) {
        switch (msg.type) {
            case 'user_message':
                await broadcastUserMessage(msg);
                break;
            case 'ai_message':
                await broadcastAiMessage(msg);
                break;
            case 'ai_tts':
                await broadcastAiTts(msg);
                break;
            case 'generation_started':
                await setTypingStatus(msg.chatId, true);
                break;
            case 'generation_ended':
                await setTypingStatus(msg.chatId, false);
                break;
            case 'validate_chat_result':
            case 'list_chats_result':
                handleRequestResponse(msg);
                break;
            case 'pong':
                // heartbeat response, nothing to do
                break;
            default:
                logger.warn('Unknown message type from ST:', msg.type);
        }
    }
    // ----------------------------------------------------------
    // Broadcasting: ST → Channels
    // ----------------------------------------------------------
    function findBot(platform) {
        // Status.ONLINE = 1 (const enum from @satorijs/protocol)
        return ctx.bots.find(b => b.platform === platform && b.status === 1 /* Status.ONLINE */);
    }
    async function getBindingsForChat(chatId) {
        return ctx.database.get('st_bindings', { stChatId: chatId });
    }
    async function broadcastUserMessage(msg) {
        const bindings = await getBindingsForChat(msg.chatId);
        if (!bindings.length) {
            logger.debug('No bindings found for chatId:', msg.chatId);
            return;
        }
        for (const binding of bindings) {
            const channelKey = `${binding.platform}:${binding.channelId}`;
            // Skip the originating channel
            if (msg.sourceChannelKey === channelKey)
                continue;
            const bot = findBot(binding.platform);
            if (!bot) {
                logger.debug(`No online bot found for platform "${binding.platform}", available: [${ctx.bots.map(b => `${b.platform}(${b.status})`).join(', ')}]`);
                continue;
            }
            try {
                // Build message content
                const parts = [];
                // Text
                if (msg.content.text) {
                    parts.push(`${config.userMessagePrefix}${msg.userName}: ${msg.content.text}`);
                }
                // Images
                if (msg.content.images?.length) {
                    for (const img of msg.content.images) {
                        parts.push((0, koishi_1.h)('image', {
                            url: `data:${img.mimeType};base64,${img.data}`,
                        }).toString());
                    }
                }
                // Files
                if (msg.content.files?.length) {
                    for (const file of msg.content.files) {
                        parts.push((0, koishi_1.h)('file', {
                            url: `data:${file.mimeType};base64,${file.data}`,
                        }).toString());
                    }
                }
                if (parts.length > 0) {
                    await bot.sendMessage(binding.channelId, parts.join('\n'));
                }
            }
            catch (e) {
                logger.error(`Failed to broadcast user message to ${channelKey}:`, e);
            }
        }
    }
    async function broadcastAiMessage(msg) {
        const bindings = await getBindingsForChat(msg.chatId);
        if (!bindings.length)
            return;
        for (const binding of bindings) {
            const bot = findBot(binding.platform);
            if (!bot)
                continue;
            try {
                const parts = [];
                if (msg.content.text) {
                    parts.push(`${config.aiMessagePrefix}${msg.characterName}: ${msg.content.text}`);
                }
                if (msg.content.images?.length) {
                    for (const img of msg.content.images) {
                        parts.push((0, koishi_1.h)('image', {
                            url: `data:${img.mimeType};base64,${img.data}`,
                        }).toString());
                    }
                }
                if (parts.length > 0) {
                    await bot.sendMessage(binding.channelId, parts.join('\n'));
                }
            }
            catch (e) {
                const channelKey = `${binding.platform}:${binding.channelId}`;
                logger.error(`Failed to broadcast AI message to ${channelKey}:`, e);
            }
        }
    }
    async function broadcastAiTts(msg) {
        const bindings = await getBindingsForChat(msg.chatId);
        if (!bindings.length)
            return;
        const audioUrl = `data:${msg.mimeType};base64,${msg.audio}`;
        for (const binding of bindings) {
            const bot = findBot(binding.platform);
            if (!bot)
                continue;
            try {
                await bot.sendMessage(binding.channelId, (0, koishi_1.h)('audio', { url: audioUrl }).toString());
            }
            catch (e) {
                const channelKey = `${binding.platform}:${binding.channelId}`;
                logger.error(`Failed to broadcast TTS to ${channelKey}:`, e);
            }
        }
    }
    async function setTypingStatus(chatId, _typing) {
        // Typing indicator is best-effort and platform-dependent.
        // Many platforms don't have a public API for typing status.
        // We attempt it but silently ignore failures.
        const bindings = await getBindingsForChat(chatId);
        for (const binding of bindings) {
            const bot = findBot(binding.platform);
            if (!bot)
                continue;
            try {
                // Some adapters support sendMessage with typing indicator
                // For now this is a placeholder — platform-specific typing
                // would need bot.internal access which varies per adapter.
                // TODO: implement per-platform typing via bot.internal
            }
            catch {
                // ignored
            }
        }
    }
    // ----------------------------------------------------------
    // Channel → ST: Forward channel messages
    // ----------------------------------------------------------
    ctx.on('message', async (session) => {
        // Ignore bot's own messages
        if (session.userId === session.selfId)
            return;
        // Look up binding for this channel
        const [binding] = await ctx.database.get('st_bindings', {
            platform: session.platform,
            channelId: session.channelId,
        });
        if (!binding)
            return;
        // No active ST client
        if (!activeClient || activeClient.readyState !== 1)
            return;
        // Extract text content
        const textParts = [];
        const images = [];
        if (session.elements) {
            for (const el of session.elements) {
                if (el.type === 'text') {
                    textParts.push(el.attrs?.content || '');
                }
                else if (el.type === 'at') {
                    // Include mentions as text
                    textParts.push(`@${el.attrs?.name || el.attrs?.id || ''}`);
                }
                else if (el.type === 'image' || el.type === 'img') {
                    const url = el.attrs?.url || el.attrs?.src;
                    if (url) {
                        try {
                            const imageData = await fetchUrlAsBase64(url);
                            if (imageData) {
                                images.push(imageData);
                            }
                        }
                        catch (e) {
                            logger.warn('Failed to fetch image:', e);
                        }
                    }
                }
            }
        }
        // Fallback to session.content if no elements parsed
        const text = textParts.join('').trim() || session.content?.trim() || '';
        // Skip empty messages with no images
        if (!text && images.length === 0)
            return;
        const sourceChannelKey = `${session.platform}:${session.channelId}`;
        const senderName = session.username || session.userId || 'Unknown';
        // Send text message
        if (text) {
            sendToST({
                type: 'send_message',
                chatId: binding.stChatId,
                text,
                sourceChannelKey,
                senderName,
            });
        }
        // Send images as files
        for (const img of images) {
            sendToST({
                type: 'send_file',
                chatId: binding.stChatId,
                file: img,
                sourceChannelKey,
                senderName,
            });
        }
    });
    // ----------------------------------------------------------
    // Helper: Fetch URL content as base64
    // ----------------------------------------------------------
    async function fetchUrlAsBase64(url) {
        try {
            const response = await fetch(url);
            if (!response.ok)
                return null;
            const buffer = Buffer.from(await response.arrayBuffer());
            const mimeType = response.headers.get('content-type') || 'application/octet-stream';
            const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
            return {
                name: `image.${ext}`,
                data: buffer.toString('base64'),
                mimeType,
            };
        }
        catch {
            return null;
        }
    }
    // ----------------------------------------------------------
    // Commands
    // ----------------------------------------------------------
    // Parent command group
    ctx.command('st', 'SillyTavern bridge commands');
    ctx.command('st.bind <chatId:text>', 'Bind this channel to a SillyTavern chat')
        .alias('st-bind')
        .usage('Usage: st.bind <chatId>\nGet the chatId from st.list or the SillyTavern extension settings panel.')
        .example('st.bind Ani - 2026-03-14@18h06m18s170ms')
        .action(async ({ session }, chatId) => {
        if (!chatId)
            return 'Please provide a SillyTavern chat ID.';
        if (!session)
            return;
        // Validate chatId with ST client
        if (!activeClient || activeClient.readyState !== 1) {
            return 'ST client is not connected. Cannot validate chat ID.';
        }
        const reqId = generateRequestId();
        const result = await requestST({
            type: 'validate_chat',
            requestId: reqId,
            chatId,
        });
        if (!result) {
            return 'ST client did not respond (timeout). Is the browser tab open?';
        }
        if (!result.valid) {
            return `Invalid chat ID: ${result.error || 'not found'}`;
        }
        await ctx.database.upsert('st_bindings', [{
                platform: session.platform,
                channelId: session.channelId,
                guildId: session.guildId || '',
                stChatId: chatId,
                createdAt: new Date(),
                createdBy: session.userId,
            }], ['platform', 'channelId']);
        return `Bound to SillyTavern chat: ${chatId}`;
    });
    ctx.command('st.unbind', 'Unbind this channel from SillyTavern')
        .alias('st-unbind')
        .action(async ({ session }) => {
        if (!session)
            return;
        const removed = await ctx.database.remove('st_bindings', {
            platform: session.platform,
            channelId: session.channelId,
        });
        if (!removed.matched) {
            return 'This channel is not bound to any SillyTavern chat.';
        }
        return 'Unbound from SillyTavern chat.';
    });
    ctx.command('st.list', 'List all SillyTavern chats')
        .alias('st-list')
        .action(async () => {
        if (!activeClient || activeClient.readyState !== 1) {
            return 'ST client is not connected.';
        }
        const reqId = generateRequestId();
        const result = await requestST({
            type: 'list_chats',
            requestId: reqId,
        });
        if (!result) {
            return 'ST client did not respond (timeout).';
        }
        if (result.error) {
            return `Error: ${result.error}`;
        }
        if (!result.chats.length) {
            return 'No chats found.';
        }
        const lines = result.chats.map((chat, i) => `${i + 1}. [${chat.characterName}] ${chat.chatId} (${chat.messageCount} msgs)`);
        return lines.join('\n');
    });
    ctx.command('st.status', 'Show SillyTavern bridge status')
        .alias('st-status')
        .action(async ({ session }) => {
        if (!session)
            return;
        const [binding] = await ctx.database.get('st_bindings', {
            platform: session.platform,
            channelId: session.channelId,
        });
        const stConnected = activeClient?.readyState === 1;
        return [
            `Binding: ${binding ? binding.stChatId : 'not bound'}`,
            `ST connection: ${stConnected ? 'online' : 'offline'}`,
            `ST clients: ${allClients.size}`,
        ].join('\n');
    });
}
//# sourceMappingURL=index.js.map