# Robinhood Stock Token Monitor

Monitors Robinhood Stock Tokens for:

- newly tokenized stocks or ETFs from `https://api.robinhood.com/rhj/assets`
- new mint events for existing tokens using ERC-20 `Transfer(0x0, to, amount)` logs on Robinhood Chain
- Discord webhook alerts

## Deploy On Railway

Railway uses `railway.json` and runs:

```bash
node monitor.mjs
```

Add these Railway variables:

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
RH_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY
POLL_INTERVAL_MS=300000
ALERT_ON_FIRST_RUN=false
```

For persistent state, add a Railway volume. The monitor automatically uses `$RAILWAY_VOLUME_MOUNT_PATH/state.json` when a Railway volume exists. You can also explicitly set:

```bash
STATE_FILE=/data/state.json
```

## First Run Behavior

By default, the first run seeds state without alerting for the full existing catalog. Future runs alert only on new tokenized assets, new deployments, activations, and mint events.

## Local Run

```bash
copy .env.example .env
node monitor.mjs --once
node monitor.mjs
```

## Notes

- New listing detection is based on Robinhood's official `assets` API.
- Mint detection is based on standard ERC-20 mint semantics: a `Transfer` event where `from` is the zero address.
- Use Alchemy or another dedicated Robinhood Chain RPC provider for production.
- This is monitoring infrastructure, not investment advice.
