import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setServerChanBotRuntime(next: PluginRuntime) {
    runtime = next;
}

export function getServerChanBotRuntime(): PluginRuntime {
    if (!runtime) {
        throw new Error("ServerChan Bot runtime not initialized");
    }
    return runtime;
}
