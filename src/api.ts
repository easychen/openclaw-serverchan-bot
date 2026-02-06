/**
 * Server酱³ Bot API Client
 *
 * API Base URL: https://bot-go.apijia.cn
 * Similar to Telegram Bot API
 */

const API_BASE_URL = "https://bot-go.apijia.cn";

export type ServerChanBotInfo = {
    ok: boolean;
    result?: {
        id: number;
        name?: string;
        username?: string;
    };
    error?: string;
};

export type ServerChanMessage = {
    message_id: number;
    chat_id?: number;
    chat?: {
        id: number;
        type?: string;
    };
    from?: {
        id: number;
        is_bot?: boolean;
        first_name?: string;
    };
    text: string;
    date?: number;
};

export type ServerChanUpdate = {
    update_id: number;
    message: ServerChanMessage;
};

export type ServerChanUpdatesResponse = {
    ok: boolean;
    result: ServerChanUpdate[];
    error?: string;
};

export type ServerChanSendResult = {
    ok: boolean;
    result?: {
        message_id: number;
        chat_id: number;
        text: string;
        date?: number;
    };
    error?: string;
};

export type SendMessageOptions = {
    parseMode?: "text" | "markdown";
    silent?: boolean;
};

export type GetUpdatesOptions = {
    timeout?: number;
    offset?: number;
};

/**
 * Get bot information
 */
export async function serverChanBotGetMe(token: string): Promise<ServerChanBotInfo> {
    const url = `${API_BASE_URL}/bot${token}/getMe`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
        },
    });

    if (!response.ok) {
        return {
            ok: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
        };
    }

    return (await response.json()) as ServerChanBotInfo;
}

/**
 * Send a message to a chat
 */
export async function serverChanBotSendMessage(
    token: string,
    chatId: number | string,
    text: string,
    options?: SendMessageOptions,
): Promise<ServerChanSendResult> {
    const url = `${API_BASE_URL}/bot${token}/sendMessage`;

    const body: Record<string, unknown> = {
        chat_id: typeof chatId === "string" ? Number.parseInt(chatId, 10) : chatId,
        text,
    };

    if (options?.parseMode) {
        body.parse_mode = options.parseMode;
    }

    if (options?.silent !== undefined) {
        body.silent = options.silent;
    }

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        return {
            ok: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
        };
    }

    return (await response.json()) as ServerChanSendResult;
}

/**
 * Poll for updates (uplink messages)
 */
export async function serverChanBotGetUpdates(
    token: string,
    options?: GetUpdatesOptions,
): Promise<ServerChanUpdatesResponse> {
    const params = new URLSearchParams();

    if (options?.timeout !== undefined) {
        params.set("timeout", String(options.timeout));
    }

    if (options?.offset !== undefined) {
        params.set("offset", String(options.offset));
    }

    const queryString = params.toString();
    const url = `${API_BASE_URL}/bot${token}/getUpdates${queryString ? `?${queryString}` : ""}`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
        },
    });

    if (!response.ok) {
        return {
            ok: false,
            result: [],
            error: `HTTP ${response.status}: ${response.statusText}`,
        };
    }

    return (await response.json()) as ServerChanUpdatesResponse;
}

/**
 * Parse webhook payload
 */
export function parseWebhookPayload(body: unknown): ServerChanUpdate | null {
    if (!body || typeof body !== "object") {
        return null;
    }

    const payload = body as Record<string, unknown>;

    if (payload.ok !== true) {
        return null;
    }

    const updateId = payload.update_id;
    const message = payload.message;

    if (typeof updateId !== "number" || !message || typeof message !== "object") {
        return null;
    }

    const msg = message as Record<string, unknown>;
    const messageId = msg.message_id;
    const text = msg.text;
    const rawChatId = msg.chat_id;
    const chat = msg.chat;
    const chatId =
        typeof rawChatId === "number"
            ? rawChatId
            : chat && typeof chat === "object"
                ? (chat as { id?: unknown }).id
                : undefined;

    if (typeof messageId !== "number" || typeof chatId !== "number" || typeof text !== "string") {
        return null;
    }

    return {
        update_id: updateId,
        message: {
            message_id: messageId,
            chat_id: chatId,
            chat: chat && typeof chat === "object" ? (chat as { id: number; type?: string }) : undefined,
            text,
            date: typeof msg.date === "number" ? msg.date : undefined,
        },
    };
}

/**
 * Verify webhook secret
 */
export function verifyWebhookSecret(
    headers: Record<string, string | string[] | undefined>,
    expectedSecret: string,
): boolean {
    const secret = headers["x-sc3bot-webhook-secret"] ?? headers["X-Sc3Bot-Webhook-Secret"];
    const secretValue = Array.isArray(secret) ? secret[0] : secret;
    return secretValue === expectedSecret;
}
