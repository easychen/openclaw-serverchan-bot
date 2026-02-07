# openclaw-serverchan-bot

Server酱³ Bot channel plugin for OpenClaw - 支持双向消息通信的 Server酱³ Bot 渠道插件。

## 功能特点

- 📤 **下行推送**：通过 OpenClaw 向 Server酱³ App 发送消息
- 📥 **上行回复**：接收用户通过 Server酱³ App 发送的消息，并由 AI 自动回复
- 🔄 **双向通信**：完整的 Telegram Bot API 兼容接口

## 安装

### 从 NPM 安装（推荐）

```bash
openclaw plugins install openclaw-serverchan-bot
```

### 从本地安装

```bash
openclaw plugins install ./extensions/serverchan-bot
```

## 获取 Bot Token

1. 访问 [Server酱³ 控制台](https://sc3.ft07.com/bot) 登录账号
2. 创建一个新的 Bot 或使用已有的 Bot
3. 复制 Bot Token 和 UID (作为 chat_id )

## 配置

在 OpenClaw 配置文件中添加以下内容：

### 基础配置

```json5
{
  channels: {
    "serverchan-bot": {
      enabled: true,
      botToken: "your-bot-token-here",
      chatId: "your-chat-id",  // 消息目标用户 ID
      dmPolicy: "open",
    },
  },
}
```


### 完整配置选项

```json5
{
  channels: {
    "serverchan-bot": {
      // 必需：启用渠道
      enabled: true,
      
      // 必需：Bot Token（从 Server酱³ 控制台获取）
      botToken: "your-bot-token-here",
      
      // 必需：目标用户 chat_id
      // - 用于主动推送消息
      // - 双向对话时会自动从入站消息获取，可作为默认值
      chatId: "your-chat-id",
      
      // 可选：DM 策略
      // - "open": 允许所有用户发送消息（推荐测试时使用）
      // - "pairing": 需要配对验证（默认，更安全）
      // - "allowlist": 只允许特定用户
      // - "disabled": 禁用私聊
      dmPolicy: "open",
      
      // 可选：允许列表（当 dmPolicy 为 "allowlist" 时生效）
      allowFrom: ["user-id-1", "user-id-2"],
      
      // 可选：轮询配置
      pollingEnabled: true,      // 是否启用轮询（默认 true）
      pollingIntervalMs: 3000,   // 轮询间隔，毫秒（默认 3000）
      
      // 可选：Webhook 配置（高级）
      webhookUrl: "https://your-domain.com/webhook",
      webhookSecret: "your-webhook-secret",
      webhookPath: "/serverchan-bot/webhook",
    },
  },
}
```

### 使用场景说明

| 场景 | chat_id 来源 | 说明 |
|------|-------------|------|
| **双向对话** | 自动获取 | 用户先发消息，AI 回复时自动使用入站消息的 chat_id |
| **主动推送** | 配置文件 | OpenClaw 主动推送通知，必须配置 chat_id |


### 使用环境变量

也可以通过环境变量配置 Bot Token：

```bash
export SERVERCHAN_BOT_TOKEN="your-bot-token-here"
```

## 使用方法

### 1. 启动 Gateway

配置完成后，重启 OpenClaw Gateway：

```bash
openclaw gateway restart
```

### 2. 验证连接

查看渠道状态：

```bash
openclaw channels status
```

或在 OpenClaw Web UI 的 Channels 页面查看 "Server酱³ Bot" 状态。

### 3. 开始对话

- 打开 Server酱³ App
- 向你的 Bot 发送消息
- 等待 AI 回复

## 多账号配置

如果需要配置多个 Bot 账号：

```json5
{
  channels: {
    "serverchan-bot": {
      enabled: true,
      dmPolicy: "open",
      accounts: {
        default: {
          botToken: "token-for-default-account",
        },
        work: {
          botToken: "token-for-work-account",
          chatId: "work-chat-id",
        },
      },
    },
  },
}
```

## 常见问题

### Q: 消息发送失败？

1. 检查 Bot Token 是否正确
2. 确认 Gateway 已启动
3. 查看日志：`openclaw gateway logs`

### Q: 没有收到 AI 回复？

1. 确认 `dmPolicy` 设置为 `"open"` 或用户在允许列表中
2. 检查 AI 模型配置是否正确
3. 查看详细日志

### Q: 如何查看实时日志？

```bash
openclaw gateway logs --follow
```

## API 兼容性

本插件使用 Server酱³ Bot API，与 Telegram Bot API 类似，支持以下 API：

- `getMe` - 获取 Bot 信息
- `sendMessage` - 发送消息（ 文本，支持 Markdown 格式）
- `getUpdates` - 获取更新（轮询模式）

## 相关链接

- [Server酱³ 官网](https://sc3.ft07.com/)
- [Server酱³ Bot API 文档](https://sc3.ft07.com/bot)
- [OpenClaw 文档](https://docs.openclaw.ai/)

## 许可证

MIT
