import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { handleServerChanBotWebhookRequest, serverChanBotPlugin } from "./src/channel.js";
import { setServerChanBotRuntime } from "./src/runtime.js";

const plugin = {
    id: "openclaw-serverchan-bot",
    name: "Server酱³ Bot",
    description: "Server酱³ Bot channel plugin for bidirectional messaging",
    configSchema: emptyPluginConfigSchema(),
    register(api: OpenClawPluginApi) {
        setServerChanBotRuntime(api.runtime);
        api.registerChannel({ plugin: serverChanBotPlugin });
        api.registerHttpHandler(handleServerChanBotWebhookRequest);
    },
};

export default plugin;
