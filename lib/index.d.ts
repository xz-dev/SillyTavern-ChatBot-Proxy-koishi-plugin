import { Context, Schema } from 'koishi';
import '@cordisjs/plugin-server';
export declare const name = "sillytavern-bridge";
export declare const usage = "\nBridges SillyTavern chats to Koishi bot channels via WebSocket.\n\n## Usage\n1. Install and enable this plugin in Koishi\n2. Install the companion SillyTavern client extension\n3. Configure the WebSocket URL and API key in both sides\n4. In a bot channel, use `bind <chatId>` to link the channel to a SillyTavern chat\n5. Messages flow bidirectionally between ST and bound channels\n";
export interface Config {
    wsPath: string;
    apiKey: string;
    showAiName: boolean;
    notifyBotOnline: boolean;
    notifySTOnline: boolean;
    pingInterval: number;
}
export declare const Config: Schema<Config>;
export declare const inject: {
    required: readonly ["database", "server"];
};
declare module 'koishi' {
    interface Tables {
        st_bindings: STBinding;
        st_status_msgs: STStatusMessage;
    }
}
export interface STBinding {
    id: number;
    platform: string;
    channelId: string;
    guildId: string;
    stChatId: string;
    createdAt: Date;
    createdBy: string;
    lastMessageId: string;
}
export interface STStatusMessage {
    id: number;
    platform: string;
    channelId: string;
    messageId: string;
    category: string;
}
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map