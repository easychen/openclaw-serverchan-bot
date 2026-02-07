import type { IncomingMessage, ServerResponse } from "node:http";
import type {
    ChannelAccountSnapshot,
    ChannelPlugin,
    ChannelStatusIssue,
    OpenClawConfig,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { ServerChanBotConfigSchema } from "./config-schema.js";
import {
    serverChanBotGetMe,
    serverChanBotSendMessage,
    serverChanBotGetUpdates,
    type ServerChanBotInfo,
    type ServerChanUpdate,
    parseWebhookPayload,
    verifyWebhookSecret,
} from "./api.js";
import { getServerChanBotRuntime } from "./runtime.js";

/**
 * Resolved account configuration for Server酱³ Bot
 */
export type ResolvedServerChanBotAccount = {
    accountId: string;
    name?: string;
    enabled: boolean;
    tokenSource: "config" | "env" | "none";
    config: {
        botToken?: string;
        chatId?: string; // Default target for outbound messages
        webhookUrl?: string;
        webhookSecret?: string;
        webhookPath?: string;
        dmPolicy?: string;
        allowFrom?: Array<string | number>;
        pollingEnabled?: boolean;
        pollingIntervalMs?: number;
    };
};

/**
 * Probe result for Server酱³ Bot
 */
export type ServerChanBotProbe = {
    ok: boolean;
    bot?: {
        id: number;
        name?: string;
        username?: string;
    };
    error?: string;
};

const meta = {
    id: "serverchan-bot",
    label: "Server酱³ Bot",
    selectionLabel: "Server酱³ (Bot API)",
    detailLabel: "Server酱³ Bot",
    docsPath: "/channels/serverchan-bot",
    docsLabel: "serverchan-bot",
    blurb: "Server酱³ Bot for bidirectional messaging.",
    order: 50,
    quickstartAllowFrom: true,
};

const normalizeAllowEntry = (entry: string) =>
    entry.replace(/^serverchan(-bot)?:/i, "").trim();

const channelConfigSchema = {
    toJSONSchema: () => buildChannelConfigSchema(ServerChanBotConfigSchema),
};

type ServerChanBotLog = {
    info?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
};

type WebhookTarget = {
    account: ResolvedServerChanBotAccount;
    config: OpenClawConfig;
    log?: ServerChanBotLog;
    botToken: string;
    path: string;
    secret?: string;
    statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function normalizeWebhookPath(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
        return "/";
    }
    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    if (withSlash.length > 1 && withSlash.endsWith("/")) {
        return withSlash.slice(0, -1);
    }
    return withSlash;
}

function resolveWebhookPath(webhookPath?: string, webhookUrl?: string): string | null {
    const trimmedPath = webhookPath?.trim();
    if (trimmedPath) {
        return normalizeWebhookPath(trimmedPath);
    }
    if (webhookUrl?.trim()) {
        try {
            const parsed = new URL(webhookUrl);
            return normalizeWebhookPath(parsed.pathname || "/");
        } catch {
            return null;
        }
    }
    return "/serverchan-bot";
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
    const chunks: Buffer[] = [];
    let total = 0;
    return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
        let resolved = false;
        const doResolve = (value: { ok: boolean; value?: unknown; error?: string }) => {
            if (resolved) {
                return;
            }
            resolved = true;
            req.removeAllListeners();
            resolve(value);
        };
        req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
                doResolve({ ok: false, error: "payload too large" });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf8");
                if (!raw.trim()) {
                    doResolve({ ok: false, error: "empty payload" });
                    return;
                }
                doResolve({ ok: true, value: JSON.parse(raw) as unknown });
            } catch (err) {
                doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        });
        req.on("error", (err) => {
            doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
    });
}

function buildWebhookUrlFromConfig(params: { cfg: OpenClawConfig; path: string }): string {
    const gateway = params.cfg.gateway ?? {};
    const port =
        typeof gateway.port === "number" && gateway.port > 0 ? gateway.port : 18789;
    const customHost =
        typeof gateway.customBindHost === "string" && gateway.customBindHost.trim()
            ? gateway.customBindHost.trim()
            : undefined;
    const bind = typeof gateway.bind === "string" ? gateway.bind : "loopback";
    const host = customHost ?? (bind === "loopback" ? "127.0.0.1" : "localhost");
    const scheme = gateway.tls?.enabled ? "https" : "http";
    return `${scheme}://${host}:${port}${params.path}`;
}

function selectWebhookTarget(
    targets: WebhookTarget[],
    headers: Record<string, string | string[] | undefined>,
): WebhookTarget | null {
    if (targets.length === 1) {
        const only = targets[0];
        if (!only.secret) {
            return only;
        }
        return verifyWebhookSecret(headers, only.secret) ? only : null;
    }
    const secretTarget = targets.find((target) => {
        if (!target.secret) {
            return false;
        }
        return verifyWebhookSecret(headers, target.secret);
    });
    if (secretTarget) {
        return secretTarget;
    }
    const withoutSecret = targets.filter((target) => !target.secret);
    if (withoutSecret.length === 1) {
        return withoutSecret[0];
    }
    return null;
}

export function registerServerChanBotWebhookTarget(target: WebhookTarget): () => void {
    const key = normalizeWebhookPath(target.path);
    const normalizedTarget = { ...target, path: key };
    const existing = webhookTargets.get(key) ?? [];
    const next = [...existing, normalizedTarget];
    webhookTargets.set(key, next);
    return () => {
        const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
        if (updated.length > 0) {
            webhookTargets.set(key, updated);
        } else {
            webhookTargets.delete(key);
        }
    };
}

async function processServerChanBotUpdate(params: {
    update: ServerChanUpdate;
    account: ResolvedServerChanBotAccount;
    cfg: OpenClawConfig;
    botToken: string;
    log?: ServerChanBotLog;
    statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
    const { update, account, cfg, botToken, log, statusSink } = params;
    const updateChatId =
        update.message.chat?.id ??
        update.message.chat_id ??
        update.message.from?.id;
    if (updateChatId === undefined || updateChatId === null) {
        log?.error?.(`[${account.accountId}] update missing chat id: ${JSON.stringify(update)}`);
        return;
    }
    const chatId = String(updateChatId);
    const text = update.message.text || "";
    const messageId = String(update.message.message_id);

    log?.info?.(
        `[${account.accountId}] received message from ${chatId}: ${text.substring(0, 50)}...`,
    );

    statusSink?.({
        lastInboundAt: Date.now(),
    });

    const msgContext = {
        Provider: "serverchan-bot",
        Surface: "serverchan-bot",
        Channel: "serverchan-bot",
        From: chatId,
        To: chatId,
        Body: text,
        RawBody: text,
        BodyForCommands: text,
        BodyForAgent: text,
        ChatType: "direct" as const,
        AccountId: account.accountId,
        MessageSid: messageId,
        MessageSidFull: `serverchan-bot:${messageId}`,
        SessionKey: `serverchan-bot:${chatId}`,
        SenderId: chatId,
        Timestamp: update.message.date ? update.message.date * 1000 : Date.now(),
    };

    try {
        const pluginRuntime = getServerChanBotRuntime();
        const { queuedFinal } =
            await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                ctx: msgContext,
                cfg,
                dispatcherOptions: {
                    deliver: async (payload: { text?: string }) => {
                        const replyText = payload.text || "";
                        if (!replyText.trim()) {
                            return;
                        }

                        const configuredChatId = account.config.chatId?.trim();
                        const targetChatId = configuredChatId || chatId;

                        try {
                            const result = await serverChanBotSendMessage(
                                botToken,
                                targetChatId,
                                replyText,
                            );

                            if (!result.ok) {
                                log?.error?.(
                                    `[${account.accountId}] failed to send reply: ${result.error}`,
                                );
                            } else {
                                statusSink?.({
                                    lastOutboundAt: Date.now(),
                                });
                            }
                        } catch (sendErr) {
                            log?.error?.(`[${account.accountId}] send error: ${String(sendErr)}`);
                        }
                    },
                    onError: (err: unknown, info: { kind: string }) => {
                        log?.error?.(
                            `[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
                        );
                    },
                },
            });

        if (!queuedFinal) {
            log?.debug?.(`[${account.accountId}] no response generated for message from ${chatId}`);
        }
    } catch (dispatchErr) {
        log?.error?.(`[${account.accountId}] dispatch error: ${String(dispatchErr)}`);
    }
}

export async function handleServerChanBotWebhookRequest(
    req: IncomingMessage,
    res: ServerResponse,
): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = normalizeWebhookPath(url.pathname);
    const targets = webhookTargets.get(path);
    if (!targets || targets.length === 0) {
        return false;
    }

    if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end("Method Not Allowed");
        return true;
    }

    const selected = selectWebhookTarget(targets, req.headers);
    if (!selected) {
        res.statusCode = 401;
        res.end("unauthorized");
        return true;
    }

    const body = await readJsonBody(req, 1024 * 1024);
    if (!body.ok) {
        res.statusCode = body.error === "payload too large" ? 413 : 400;
        res.end(body.error ?? "invalid payload");
        return true;
    }

    const update = parseWebhookPayload(body.value);
    if (!update) {
        res.statusCode = 400;
        res.end("invalid payload");
        return true;
    }

    selected.statusSink?.({ lastInboundAt: Date.now() });
    processServerChanBotUpdate({
        update,
        account: selected.account,
        cfg: selected.config,
        botToken: selected.botToken,
        log: selected.log,
        statusSink: selected.statusSink,
    }).catch((err) => {
        selected.log?.error?.(`[${selected.account.accountId}] webhook error: ${String(err)}`);
    });

    res.statusCode = 200;
    res.end("ok");
    return true;
}

/**
 * Resolve account configuration from OpenClaw config
 */
function resolveServerChanBotAccount(params: {
    cfg: unknown;
    accountId?: string | null;
}): ResolvedServerChanBotAccount {
    const { cfg, accountId } = params;
    const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
    const configObj = cfg as { channels?: Record<string, Record<string, unknown>> } | undefined;
    const section = configObj?.channels?.["serverchan-bot"] ?? {};

    // Check for account-specific config
    const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
    const accountConfig = accounts?.[resolvedAccountId] ?? {};

    // Resolve token (account-specific or top-level)
    const botToken =
        (accountConfig.botToken as string | undefined) ??
        (section.botToken as string | undefined) ??
        process.env.SERVERCHAN_BOT_TOKEN;

    const tokenSource: "config" | "env" | "none" = accountConfig.botToken
        ? "config"
        : section.botToken
            ? "config"
            : process.env.SERVERCHAN_BOT_TOKEN
                ? "env"
                : "none";

    // Resolve enabled status
    const enabled =
        (accountConfig.enabled as boolean | undefined) ??
        (section.enabled as boolean | undefined) ??
        true;

    // Resolve name
    const name =
        (accountConfig.name as string | undefined) ?? (section.name as string | undefined);

    return {
        accountId: resolvedAccountId,
        name,
        enabled,
        tokenSource,
        config: {
            botToken,
            chatId:
                String((accountConfig.chatId as string | number | undefined) ??
                    (section.chatId as string | number | undefined) ?? "").trim() || undefined,
            webhookUrl:
                (accountConfig.webhookUrl as string | undefined) ??
                (section.webhookUrl as string | undefined),
            webhookSecret:
                (accountConfig.webhookSecret as string | undefined) ??
                (section.webhookSecret as string | undefined),
            webhookPath:
                (accountConfig.webhookPath as string | undefined) ??
                (section.webhookPath as string | undefined),
            dmPolicy:
                (accountConfig.dmPolicy as string | undefined) ??
                (section.dmPolicy as string | undefined),
            allowFrom:
                (accountConfig.allowFrom as Array<string | number> | undefined) ??
                (section.allowFrom as Array<string | number> | undefined),
            pollingEnabled:
                (accountConfig.pollingEnabled as boolean | undefined) ??
                (section.pollingEnabled as boolean | undefined),
            pollingIntervalMs:
                (accountConfig.pollingIntervalMs as number | undefined) ??
                (section.pollingIntervalMs as number | undefined) ??
                3000, // Default 3 second polling interval
        },
    };
}

/**
 * List all account IDs configured for Server酱³ Bot
 */
function listServerChanBotAccountIds(cfg: unknown): string[] {
    const configObj = cfg as { channels?: Record<string, Record<string, unknown>> } | undefined;
    const section = configObj?.channels?.["serverchan-bot"];
    if (!section) {
        return [DEFAULT_ACCOUNT_ID];
    }

    const accounts = section.accounts as Record<string, unknown> | undefined;
    if (!accounts || typeof accounts !== "object") {
        return [DEFAULT_ACCOUNT_ID];
    }

    const ids = Object.keys(accounts).filter((id) => id.trim());
    if (ids.length === 0) {
        return [DEFAULT_ACCOUNT_ID];
    }

    // Ensure default is first if present
    if (!ids.includes(DEFAULT_ACCOUNT_ID)) {
        ids.unshift(DEFAULT_ACCOUNT_ID);
    }

    return ids;
}

/**
 * Probe Server酱³ Bot API to verify credentials
 */
async function probeServerChanBot(
    token: string | undefined,
    _timeoutMs: number,
): Promise<ServerChanBotProbe> {
    if (!token) {
        return { ok: false, error: "No bot token configured" };
    }

    try {
        const result = await serverChanBotGetMe(token);
        if (!result.ok) {
            return { ok: false, error: result.error ?? "Unknown error" };
        }
        return {
            ok: true,
            bot: result.result,
        };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * Monitor Server酱³ Bot for incoming messages (polling mode)
 */
async function monitorServerChanBotPolling(params: {
    token: string;
    accountId: string;
    config: unknown;
    runtime: unknown;
    abortSignal: AbortSignal;
    intervalMs?: number;
    onUpdate: (update: ServerChanUpdate) => Promise<void>;
}): Promise<void> {
    const { token, abortSignal, onUpdate, intervalMs = 3000 } = params;
    let offset = 0;

    while (!abortSignal.aborted) {
        try {
            const result = await serverChanBotGetUpdates(token, {
                timeout: 30,
                offset,
            });

            if (result.ok && result.result.length > 0) {
                for (const update of result.result) {
                    offset = update.update_id + 1;
                    await onUpdate(update);
                }
            }
        } catch (err) {
            // Log error but continue polling
            console.error("[serverchan-bot] Polling error:", err);
            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}

export const serverChanBotPlugin: ChannelPlugin<ResolvedServerChanBotAccount, ServerChanBotProbe> =
{
    id: "serverchan-bot",
    meta,
    pairing: {
        idLabel: "serverChanUid",
        normalizeAllowEntry,
        notifyApproval: async ({ cfg, id }) => {
            const account = resolveServerChanBotAccount({ cfg });
            if (!account.config.botToken) {
                throw new Error("Server酱³ Bot token not configured");
            }
            await serverChanBotSendMessage(
                account.config.botToken,
                id,
                "✅ 您已被授权使用此 Bot。",
            );
        },
    },
    capabilities: {
        chatTypes: ["direct"],
        media: false,
        reactions: false,
        threads: false,
        polls: false,
        nativeCommands: false,
        blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.serverchan-bot"] },
    configSchema: channelConfigSchema,
    config: {
        listAccountIds: (cfg) => listServerChanBotAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveServerChanBotAccount({ cfg, accountId }),
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        isConfigured: (account) => account.tokenSource !== "none",
        describeAccount: (account): ChannelAccountSnapshot => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.tokenSource !== "none",
            tokenSource: account.tokenSource,
        }),
        resolveAllowFrom: ({ cfg, accountId }) =>
            (resolveServerChanBotAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
                String(entry),
            ),
        formatAllowFrom: ({ allowFrom }) =>
            allowFrom
                .map((entry) => String(entry).trim())
                .filter(Boolean)
                .map((entry) => (entry === "*" ? entry : normalizeAllowEntry(entry)))
                .map((entry) => (entry === "*" ? entry : entry.toLowerCase())),
    },
    security: {
        resolveDmPolicy: ({ cfg, accountId, account }) => {
            const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
            const channelsCfg = cfg.channels as Record<string, Record<string, unknown>> | undefined;
            const serverChanCfg = channelsCfg?.["serverchan-bot"] as Record<string, unknown> | undefined;
            const accounts = serverChanCfg?.accounts as Record<string, unknown> | undefined;
            const useAccountPath = Boolean(accounts?.[resolvedAccountId]);
            const basePath = useAccountPath
                ? `channels.serverchan-bot.accounts.${resolvedAccountId}.`
                : "channels.serverchan-bot.";
            return {
                policy: account.config.dmPolicy ?? "pairing",
                allowFrom: account.config.allowFrom ?? [],
                policyPath: `${basePath}dmPolicy`,
                allowFromPath: basePath,
                approveHint: `Add user ID to channels.serverchan-bot.allowFrom or run: openclaw channels approve serverchan-bot <userId>`,
                normalizeEntry: normalizeAllowEntry,
            };
        },
    },
    messaging: {
        normalizeTarget: (raw) => {
            const trimmed = raw.trim();
            if (!trimmed) {
                return undefined;
            }
            // Remove channel prefix if present
            const normalized = trimmed.replace(/^serverchan(-bot)?:/i, "");
            // Should be a numeric UID
            if (/^\d+$/.test(normalized)) {
                return normalized;
            }
            return undefined;
        },
        targetResolver: {
            looksLikeId: (raw, normalized) => {
                const value = (normalized ?? raw).trim();
                if (!value) {
                    return false;
                }
                return /^\d+$/.test(value);
            },
            hint: "<uid>",
        },
    },
    outbound: {
        deliveryMode: "direct",
        chunker: (text, limit) => getServerChanBotRuntime().channel.text.chunkText(text, limit),
        chunkerMode: "text",
        textChunkLimit: 4000,
        sendText: async ({ to, text, accountId, cfg }) => {
            const account = resolveServerChanBotAccount({ cfg, accountId });
            if (!account.config.botToken) {
                throw new Error("Server酱³ Bot token not configured");
            }

            const result = await serverChanBotSendMessage(account.config.botToken, to, text);

            if (!result.ok) {
                throw new Error(result.error ?? "Failed to send message");
            }

            return {
                channel: "serverchan-bot",
                messageId: result.result?.message_id ? String(result.result.message_id) : "unknown",
                to,
            };
        },
    },
    status: {
        defaultRuntime: {
            accountId: DEFAULT_ACCOUNT_ID,
            running: false,
            lastStartAt: null,
            lastStopAt: null,
            lastError: null,
        },
        collectStatusIssues: (accounts) => {
            const issues: ChannelStatusIssue[] = [];
            for (const account of accounts) {
                if (!account.configured) {
                    issues.push({
                        channel: "serverchan-bot",
                        accountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
                        kind: "config",
                        message: "Server酱³ Bot token not configured",
                    });
                }
            }
            return issues;
        },
        buildChannelSummary: async ({ snapshot }) => ({
            configured: snapshot.configured ?? false,
            tokenSource: snapshot.tokenSource ?? "none",
            running: snapshot.running ?? false,
            lastStartAt: snapshot.lastStartAt ?? null,
            lastStopAt: snapshot.lastStopAt ?? null,
            lastError: snapshot.lastError ?? null,
            probe: snapshot.probe,
            lastProbeAt: snapshot.lastProbeAt ?? null,
        }),
        probeAccount: async ({ account, timeoutMs }) =>
            probeServerChanBot(account.config.botToken, timeoutMs),
        buildAccountSnapshot: ({ account, runtime, probe }) => {
            const configured = account.tokenSource !== "none";
            return {
                accountId: account.accountId,
                name: account.name,
                enabled: account.enabled,
                configured,
                tokenSource: account.tokenSource,
                running: runtime?.running ?? false,
                lastStartAt: runtime?.lastStartAt ?? null,
                lastStopAt: runtime?.lastStopAt ?? null,
                lastError: runtime?.lastError ?? null,
                probe,
                lastInboundAt: runtime?.lastInboundAt ?? null,
                lastOutboundAt: runtime?.lastOutboundAt ?? null,
            };
        },
    },
    gateway: {
        startAccount: async (ctx) => {
            const { account, log, setStatus, abortSignal, cfg, runtime } = ctx;
            const { botToken, pollingEnabled, pollingIntervalMs } = account.config;
            const typedConfig = cfg as OpenClawConfig;
            const statusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) =>
                setStatus({ accountId: account.accountId, ...patch });

            if (!botToken) {
                throw new Error("Server酱³ Bot token not configured");
            }

            let botLabel = "";
            try {
                const probe = await probeServerChanBot(botToken, 5000);
                if (probe.ok && probe.bot?.name) {
                    botLabel = ` (${probe.bot.name})`;
                }
                if (probe.ok && probe.bot) {
                    setStatus({ accountId: account.accountId, bot: probe.bot });
                }
            } catch (err) {
                log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
            }

            log?.info(`[${account.accountId}] starting Server酱³ Bot provider${botLabel}`);
            setStatus({
                accountId: account.accountId,
                running: true,
                lastStartAt: Date.now(),
            });

            const hasWebhookConfig =
                Boolean(account.config.webhookUrl?.trim()) ||
                Boolean(account.config.webhookPath?.trim()) ||
                Boolean(account.config.webhookSecret?.trim());

            // Mode selection:
            // - If pollingEnabled is explicitly set, it wins.
            // - Otherwise, fall back to webhook when webhook config exists; else polling.
            const shouldPoll = typeof pollingEnabled === "boolean" ? pollingEnabled : !hasWebhookConfig;
            const wantsWebhook = typeof pollingEnabled === "boolean" ? !pollingEnabled : hasWebhookConfig;

            const webhookPath = wantsWebhook
                ? resolveWebhookPath(account.config.webhookPath, account.config.webhookUrl)
                : null;
            if (wantsWebhook && webhookPath) {
                const webhookSecret = account.config.webhookSecret?.trim() || undefined;
                const unregister = registerServerChanBotWebhookTarget({
                    account,
                    config: typedConfig,
                    log,
                    botToken,
                    path: webhookPath,
                    secret: webhookSecret,
                    statusSink,
                });
                abortSignal.addEventListener("abort", unregister, { once: true });
                const webhookUrl =
                    account.config.webhookUrl?.trim() ??
                    buildWebhookUrlFromConfig({ cfg: typedConfig, path: webhookPath });
                log?.info?.(`[${account.accountId}] webhook url: ${webhookUrl}`);
                if (!webhookSecret) {
                    log?.info?.(`[${account.accountId}] webhook secret not configured`);
                }
            } else if (wantsWebhook && !webhookPath) {
                log?.error?.(`[${account.accountId}] webhook path could not be derived`);
            }

            // Only start polling if enabled
            if (!shouldPoll) {
                log?.info(`[${account.accountId}] polling disabled, waiting for webhook`);
                return;
            }

            try {
                await monitorServerChanBotPolling({
                    token: botToken,
                    accountId: account.accountId,
                    config: cfg,
                    runtime,
                    abortSignal,
                    intervalMs: pollingIntervalMs,
                    onUpdate: async (update) => {
                        await processServerChanBotUpdate({
                            update,
                            account,
                            cfg: typedConfig,
                            botToken,
                            log,
                            statusSink,
                        });
                    },
                });
            } catch (err) {
                setStatus({
                    accountId: account.accountId,
                    running: false,
                    lastError: err instanceof Error ? err.message : String(err),
                });
                throw err;
            }
        },
    },
};
