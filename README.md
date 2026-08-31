# Robinhood Stock Token Monitor

Monitors Robinhood Stock Tokens for:

- newly tokenized stocks or ETFs from `https://api.robinhood.com/rhj/assets`
- new mint events for existing tokens using ERC-20 `Transfer(0x0, to, amount)` logs on Robinhood Chain
- Telegram alerts
- optional Discord webhook alerts

## Setup

Requires Node.js 18+.

```bash
cd outputs/robinhood-token-monitor
copy .env.example .env
```

Edit `.env` and set:

```bash
TELEGRAM_BOT_TOKEN=1234567890:your_bot_token
TELEGRAM_CHAT_ID=123456789
```

Run continuously:

```bash
node monitor.mjs
```

Run one polling cycle:

```bash
node monitor.mjs --once
```

## First Run Behavior

By default, the first run seeds `state.json` and does not alert for every currently listed token. This avoids Discord spam.

To alert on the first run:

```bash
ALERT_ON_FIRST_RUN=true node monitor.mjs --once
```

## Deploy On Railway

1. Push this folder to a GitHub repo.
2. In Railway, create a new project from that GitHub repo.
3. Add a volume mounted at `/data`.
4. Add these Railway variables:

```bash
TELEGRAM_BOT_TOKEN=1234567890:your_bot_token
TELEGRAM_CHAT_ID=123456789
RH_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY
STATE_FILE=/data/state.json
POLL_INTERVAL_MS=300000
ALERT_ON_FIRST_RUN=false
SYMBOL_FILTER=GPRO
MINT_ALERT_MODE=first_per_contract
MINT_WATCH_SYMBOLS=GPRO
```

Railway will use `railway.json` and run:

```bash
node monitor.mjs
```

The first deploy seeds `/data/state.json` without alerting for the full existing catalog. Future runs alert only on new tokenized assets, new deployments, activations, and mint events.

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | optional | Telegram bot token for alerts. |
| `TELEGRAM_CHAT_ID` | optional | Telegram chat ID to receive alerts. |
| `DISCORD_WEBHOOK_URL` | optional | Discord webhook URL for alerts. |
| `RH_ASSETS_URL` | `https://api.robinhood.com/rhj/assets` | Robinhood asset metadata endpoint. |
| `RH_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | Robinhood Chain JSON-RPC endpoint. |
| `POLL_INTERVAL_MS` | `300000` | Delay between polling cycles. |
| `STATE_FILE` | `./state.json` | Snapshot and block cursor file. |
| `RUN_ONCE` | `false` | Exit after one cycle. |
| `ALERT_ON_FIRST_RUN` | `false` | Send alerts for initial catalog and historical mint scan. |
| `SYMBOL_FILTER` | empty | Comma-separated token symbols to alert on. When set to `GPRO`, all non-GPRO alerts are suppressed. |
| `MINT_ALERT_MODE` | `all` | Use `all`, `first_per_contract`, or `off` for mint alerts. |
| `MINT_WATCH_SYMBOLS` | empty | Comma-separated token symbols whose mints should always alert. |
| `MINT_WATCH_CONTRACTS` | empty | Comma-separated token contract addresses whose mints should always alert. |
| `CONFIRMATIONS` | `20` | Blocks to wait before scanning logs. |
| `BLOCK_CHUNK_SIZE` | `2000` | Max block span per `eth_getLogs` request. |
| `ADDRESS_CHUNK_SIZE` | `75` | Max token contracts per `eth_getLogs` request. |
| `RPC_REQUEST_DELAY_MS` | `300` | Delay before each RPC request to reduce public RPC rate-limit errors. |
| `RPC_MAX_RETRIES` | `5` | Retry count for `429` and transient RPC errors. |

## Notes

- New listing detection is based on Robinhood's official `assets` API.
- Mint detection is based on standard ERC-20 mint semantics: a `Transfer` event where `from` is the zero address.
- The public Robinhood RPC is rate-limited and not recommended for production. For a production monitor, use Alchemy, QuickNode, Blockdaemon, dRPC, Validation Cloud, or another Robinhood Chain provider.
- This is monitoring infrastructure, not investment advice.
