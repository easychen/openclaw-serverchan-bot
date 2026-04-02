import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { handleServerChanBotWebhookRequest, serverChanBotPlugin } from "./src/channel.js";
import { setServerChanBotRuntime } from "./src/runtime.js";

const pluginConfigSchema = {
    toJSONSchema: () => ({
        type: "object",
        additionalProperties: false,
        properties: {},
    }),
};

const plugin = {
    id: "openclaw-serverchan-bot",
    name: "Server酱³ Bot",
    description: "Server酱³ Bot channel plugin for bidirectional messaging",
    configSchema: pluginConfigSchema,
    register(api: OpenClawPluginApi) {
        setServerChanBotRuntime(api.runtime);
        api.registerChannel({ plugin: serverChanBotPlugin });
        
        // Register webhook handler using the new API (OpenClaw 2026.3+)
        // The handler will only be activated when webhook is configured in channel config
        api.registerPluginHttpRoute({
            path: "/serverchan-bot",
            handler: handleServerChanBotWebhookRequest,
            auth: "plugin",
            match: "prefix",
        });
    },
};

export default plugin;
