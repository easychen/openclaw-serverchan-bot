import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const ServerChanBotAccountSchema = z
    .object({
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        botToken: z.string().optional(),
        chatId: z.string().optional(), // Default target for outbound messages
        webhookUrl: z.string().optional(),
        webhookSecret: z.string().optional(),
        webhookPath: z.string().optional(), // Custom webhook path
        dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
        allowFrom: z.array(allowFromEntry).optional(),
        textChunkLimit: z.number().optional(),
        pollingEnabled: z.boolean().optional(), // Enable polling for updates
        pollingIntervalMs: z.number().optional(), // Polling interval in milliseconds
    })
    .strict();

export const ServerChanBotConfigSchema = ServerChanBotAccountSchema.extend({
    accounts: z.object({}).catchall(ServerChanBotAccountSchema).optional(),
});
