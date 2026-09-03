import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

await loadEnvFile(".env");

const config = {
  discordWebhookUrl: env("DISCORD_WEBHOOK_URL", ""),
  telegramBotToken: env("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: env("TELEGRAM_CHAT_ID", ""),
  telegramChatIds: listEnv("TELEGRAM_CHAT_IDS"),
  assetsUrl: env("RH_ASSETS_URL", "https://api.robinhood.com/rhj/assets"),
  rpcUrl: env("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  pollIntervalMs: intEnv("POLL_INTERVAL_MS", 300_000),
  stateFile: env(
    "STATE_FILE",
    process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/state.json`
      : "./state.json"
  ),
  runOnce: boolEnv("RUN_ONCE", false) || process.argv.includes("--once"),
  alertOnFirstRun: boolEnv("ALERT_ON_FIRST_RUN", false),
  symbolFilter: listEnv("SYMBOL_FILTER").map((symbol) => symbol.toUpperCase()),
  mintAlertMode: env("MINT_ALERT_MODE", "all"),
  mintWatchSymbols: listEnv("MINT_WATCH_SYMBOLS").map((symbol) => symbol.toUpperCase()),
  mintWatchContracts: listEnv("MINT_WATCH_CONTRACTS").map(normalizeAddress),
  confirmations: intEnv("CONFIRMATIONS", 20),
  blockChunkSize: intEnv("BLOCK_CHUNK_SIZE", 500),
  addressChunkSize: intEnv("ADDRESS_CHUNK_SIZE", 25),
  rpcRequestDelayMs: intEnv("RPC_REQUEST_DELAY_MS", 300),
  rpcMaxRetries: intEnv("RPC_MAX_RETRIES", 5)
};

async function loadEnvFile(file) {
  try {
    const body = await fs.readFile(file, "utf8");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const equalsAt = trimmed.indexOf("=");
      if (equalsAt === -1) continue;

      const key = trimmed.slice(0, equalsAt).trim();
      let value = trimmed.slice(equalsAt + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function listEnv(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hex(n) {
  return `0x${n.toString(16)}`;
}

function fromHexQuantity(value) {
  return Number.parseInt(value, 16);
}

function normalizeAddress(address) {
  return address.toLowerCase();
}

function addressFromTopic(topic) {
  return `0x${topic.slice(-40)}`;
}

function formatUnits(raw, decimals = 18) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;

  if (fraction === 0n) return whole.toString();

  const fractionText = fraction.toString().padStart(decimals, "0");
  const trimmed = fractionText.replace(/0+$/, "").slice(0, 8);
  return `${whole}.${trimmed}`;
}

async function readState(file) {
  try {
    const body = await fs.readFile(file, "utf8");
    const state = JSON.parse(body);
    state.mintedContractsByAddress = state.mintedContractsByAddress ?? {};
    return state;
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        version: 1,
        assetsById: {},
        contractsByAddress: {},
        mintedContractsByAddress: {},
        lastScannedBlock: null,
        initializedAt: null,
        updatedAt: null
      };
    }
    throw error;
  }
}

async function writeState(file, state) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, file);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "accept": "application/json",
      "user-agent": "robinhood-token-monitor/1.0",
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 500)}`);
  }

  return response.json();
}

let rpcId = 0;
let lastRpcRequestAt = 0;
async function rpc(method, params) {
  const body = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method,
    params
  };

  for (let attempt = 0; attempt <= config.rpcMaxRetries; attempt += 1) {
    const waitFor = Math.max(
      0,
      lastRpcRequestAt + config.rpcRequestDelayMs - Date.now()
    );
    if (waitFor > 0) await sleep(waitFor);
    lastRpcRequestAt = Date.now();

    let response;
    try {
      response = await fetch(config.rpcUrl, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "user-agent": "robinhood-token-monitor/1.0"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (attempt < config.rpcMaxRetries) {
        await sleep(1_000 * 2 ** attempt);
        continue;
      }

      throw new Error(
        `RPC ${method} network request failed after ${config.rpcMaxRetries + 1} attempt(s): ${
          error.message
        }`
      );
    }

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = null;
    }

    const retryableStatus = response.status === 429 || response.status >= 500;
    const retryableRpc =
      json?.error?.code === 429 ||
      json?.error?.code === -32005 ||
      json?.error?.message?.toLowerCase?.().includes("rate");

    if (response.ok && !json?.error) return json.result;

    if (attempt < config.rpcMaxRetries && (retryableStatus || retryableRpc)) {
      await sleep(1_000 * 2 ** attempt);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `${config.rpcUrl} returned ${response.status}: ${text.slice(0, 500)}`
      );
    }

    throw new Error(`RPC ${method} failed: ${JSON.stringify(json?.error ?? text)}`);
  }
}

async function getLatestSafeBlock() {
  const latest = fromHexQuantity(await rpc("eth_blockNumber", []));
  return Math.max(0, latest - config.confirmations);
}

async function fetchAssets() {
  const data = await fetchJson(config.assetsUrl);
  const assets = Array.isArray(data.assets) ? data.assets : [];
  return assets
    .filter((asset) => Array.isArray(asset.deployments))
    .map((asset) => ({
      id: asset.id,
      tokenSymbol: asset.tokenSymbol,
      tokenName: asset.tokenName,
      status: asset.status,
      currentMultiplier: asset.currentMultiplier,
      pendingMultiplier: asset.pendingMultiplier,
      pendingMultiplierEffectiveTime: asset.pendingMultiplierEffectiveTime,
      logoUrl: asset.logoUrl,
      tokenDecimals: asset.tokenDecimals ?? 18,
      isin: asset.isin,
      deployments: asset.deployments.map((deployment) => ({
        contractAddress: deployment.contractAddress,
        chainId: deployment.chainId,
        networkName: deployment.networkName
      }))
    }));
}

function indexAssets(assets) {
  const assetsById = {};
  const contractsByAddress = {};

  for (const asset of assets) {
    assetsById[asset.id] = asset;
    for (const deployment of asset.deployments) {
      if (!deployment.contractAddress) continue;
      contractsByAddress[normalizeAddress(deployment.contractAddress)] = {
        assetId: asset.id,
        tokenSymbol: asset.tokenSymbol,
        tokenName: asset.tokenName,
        tokenDecimals: asset.tokenDecimals ?? 18,
        status: asset.status,
        chainId: deployment.chainId,
        networkName: deployment.networkName
      };
    }
  }

  return { assetsById, contractsByAddress };
}

function detectAssetChanges(previous, current, firstRun) {
  if (firstRun && !config.alertOnFirstRun) return [];

  const alerts = [];
  for (const [id, asset] of Object.entries(current.assetsById)) {
    if (!symbolAllowed(asset.tokenSymbol)) continue;

    const old = previous.assetsById[id];
    if (!old) {
      alerts.push({
        type: "new_asset",
        title: `New Robinhood Stock Token: ${asset.tokenSymbol}`,
        description: asset.tokenName,
        fields: assetFields(asset)
      });
      continue;
    }

    const oldContracts = new Set(
      (old.deployments ?? []).map((deployment) =>
        normalizeAddress(deployment.contractAddress ?? "")
      )
    );

    const addedContracts = (asset.deployments ?? []).filter(
      (deployment) =>
        deployment.contractAddress &&
        !oldContracts.has(normalizeAddress(deployment.contractAddress))
    );

    if (addedContracts.length > 0) {
      alerts.push({
        type: "new_deployment",
        title: `New deployment for ${asset.tokenSymbol}`,
        description: asset.tokenName,
        fields: [
          ...assetFields(asset),
          {
            name: "New contract(s)",
            value: addedContracts
              .map((deployment) => deployment.contractAddress)
              .join("\n")
              .slice(0, 1024)
          }
        ]
      });
    }

    if (old.status !== asset.status && asset.status === "ASSET_STATUS_ACTIVE") {
      alerts.push({
        type: "asset_activated",
        title: `${asset.tokenSymbol} is now active`,
        description: asset.tokenName,
        fields: assetFields(asset)
      });
    }
  }

  return alerts;
}

function assetFields(asset) {
  const contracts = (asset.deployments ?? [])
    .map((deployment) => deployment.contractAddress)
    .filter(Boolean);

  return [
    { name: "Symbol", value: asset.tokenSymbol || "unknown", inline: true },
    { name: "Status", value: asset.status || "unknown", inline: true },
    { name: "ISIN", value: asset.isin || "unknown", inline: true },
    {
      name: "Contract",
      value: contracts.length > 0 ? contracts.join("\n").slice(0, 1024) : "none"
    }
  ];
}

async function getMintLogs(contractsByAddress, fromBlock, toBlock) {
  const addresses = Object.entries(contractsByAddress)
    .filter(([, token]) => symbolAllowed(token.tokenSymbol))
    .map(([address]) => address);
  if (addresses.length === 0 || fromBlock > toBlock) return [];

  const logs = [];
  for (let blockStart = fromBlock; blockStart <= toBlock; blockStart += config.blockChunkSize) {
    const blockEnd = Math.min(toBlock, blockStart + config.blockChunkSize - 1);
    for (const addressChunk of chunks(addresses, config.addressChunkSize)) {
      logs.push(...await getMintLogsChunk(addressChunk, blockStart, blockEnd));
    }
  }

  return logs;
}

async function getMintLogsChunk(addresses, fromBlock, toBlock) {
  try {
    return await rpc("eth_getLogs", [
      {
        fromBlock: hex(fromBlock),
        toBlock: hex(toBlock),
        address: addresses,
        topics: [TRANSFER_TOPIC, ZERO_TOPIC]
      }
    ]);
  } catch (error) {
    if (!isInvalidBlockRangeError(error) || fromBlock >= toBlock) {
      throw error;
    }

    const midpoint = Math.floor((fromBlock + toBlock) / 2);
    const first = await getMintLogsChunk(addresses, fromBlock, midpoint);
    const second = await getMintLogsChunk(addresses, midpoint + 1, toBlock);
    return [...first, ...second];
  }
}

function isInvalidBlockRangeError(error) {
  return String(error?.message ?? "")
    .toLowerCase()
    .includes("invalid block range");
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function mintAlerts(logs, contractsByAddress, mintedContractsByAddress, firstRun) {
  if (firstRun && !config.alertOnFirstRun) return [];
  if (config.mintAlertMode === "off") return [];

  return logs.flatMap((log) => {
    const token = contractsByAddress[normalizeAddress(log.address)] ?? {};
    if (!symbolAllowed(token.tokenSymbol)) return [];

    const contractAddress = normalizeAddress(log.address);
    const watched =
      config.mintWatchContracts.includes(contractAddress) ||
      config.mintWatchSymbols.includes((token.tokenSymbol ?? "").toUpperCase());
    if (
      config.mintAlertMode === "first_per_contract" &&
      mintedContractsByAddress[contractAddress] &&
      !watched
    ) {
      return [];
    }

    const rawAmount = BigInt(log.data || "0x0").toString();
    const amount = formatUnits(rawAmount, token.tokenDecimals ?? 18);
    const recipient = log.topics?.[2] ? addressFromTopic(log.topics[2]) : "unknown";

    return [{
      type: "mint",
      title: `Mint detected: ${token.tokenSymbol ?? log.address}`,
      description: token.tokenName ?? "Robinhood Stock Token",
      fields: [
        { name: "Symbol", value: token.tokenSymbol ?? "unknown", inline: true },
        { name: "Amount", value: amount, inline: true },
        { name: "Recipient", value: recipient },
        { name: "Contract", value: log.address },
        {
          name: "Transaction",
          value: `https://robinhoodchain.blockscout.com/tx/${log.transactionHash}`
        }
      ]
    }];
  });
}

function symbolAllowed(symbol) {
  if (config.symbolFilter.length === 0) return true;
  return config.symbolFilter.includes((symbol ?? "").toUpperCase());
}

function updateMintedContracts(state, logs) {
  state.mintedContractsByAddress = state.mintedContractsByAddress ?? {};
  for (const log of logs) {
    const contractAddress = normalizeAddress(log.address);
    state.mintedContractsByAddress[contractAddress] = {
      firstSeenAt: state.mintedContractsByAddress[contractAddress]?.firstSeenAt ?? new Date().toISOString(),
      latestSeenAt: new Date().toISOString(),
      latestTransactionHash: log.transactionHash
    };
  }
}

async function sendDiscord(alerts) {
  if (alerts.length === 0) return;

  if (!config.discordWebhookUrl || config.discordWebhookUrl.includes("...")) {
    return;
  }

  for (const batch of chunks(alerts, 10)) {
    const response = await fetch(config.discordWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Robinhood Token Monitor",
        embeds: batch.map((alert) => ({
          title: alert.title,
          description: alert.description,
          color: alert.type === "mint" ? 0x00a86b : 0x1f8b4c,
          timestamp: new Date().toISOString(),
          fields: alert.fields.slice(0, 25)
        }))
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord webhook returned ${response.status}: ${text.slice(0, 500)}`);
    }
  }
}

async function sendTelegram(alerts) {
  if (alerts.length === 0) return;

  const chatIds = config.telegramChatIds.length > 0
    ? config.telegramChatIds
    : config.telegramChatId
      ? [config.telegramChatId]
      : [];

  if (
    !config.telegramBotToken ||
    chatIds.length === 0 ||
    config.telegramBotToken.includes("your_bot_token")
  ) {
    return;
  }

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  for (const chatId of chatIds) {
    for (const alert of alerts) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: telegramAlertText(alert),
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Telegram returned ${response.status} for chat ${chatId}: ${text.slice(0, 500)}`);
      }
    }
  }
}

function telegramAlertText(alert) {
  const fields = alert.fields
    .map((field) => `<b>${escapeHtml(field.name)}:</b> ${escapeHtml(field.value)}`)
    .join("\n");

  return [
    `<b>${escapeHtml(alert.title)}</b>`,
    alert.description ? escapeHtml(alert.description) : "",
    fields
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4096);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendNotifications(alerts) {
  if (alerts.length === 0) return;

  const hasTelegram =
    config.telegramBotToken &&
    (config.telegramChatIds.length > 0 || config.telegramChatId) &&
    !config.telegramBotToken.includes("your_bot_token");
  const hasDiscord =
    config.discordWebhookUrl && !config.discordWebhookUrl.includes("...");

  if (!hasTelegram && !hasDiscord) {
    console.log(`No alert destination is configured; ${alerts.length} alert(s) not sent.`);
    for (const alert of alerts) {
      console.log(`[${alert.type}] ${alert.title} - ${alert.description}`);
    }
    return;
  }

  await Promise.all([sendTelegram(alerts), sendDiscord(alerts)]);
}

async function pollOnce() {
  const state = await readState(config.stateFile);
  const firstRun = !state.initializedAt;

  console.log(`[${new Date().toISOString()}] Fetching Robinhood assets...`);
  const assets = await fetchAssets();
  const current = indexAssets(assets);

  const latestSafeBlock = await getLatestSafeBlock();
  const fromBlock =
    state.lastScannedBlock === null
      ? latestSafeBlock
      : Math.min(state.lastScannedBlock + 1, latestSafeBlock);

  console.log(
    `[${new Date().toISOString()}] Assets=${assets.length}, scan=${fromBlock}-${latestSafeBlock}`
  );

  const assetAlerts = detectAssetChanges(state, current, firstRun);
  const logs =
    firstRun && !config.alertOnFirstRun
      ? []
      : await getMintLogs(current.contractsByAddress, fromBlock, latestSafeBlock);
  const alerts = [
    ...assetAlerts,
    ...mintAlerts(
      logs,
      current.contractsByAddress,
      state.mintedContractsByAddress ?? {},
      firstRun
    )
  ];
  updateMintedContracts(state, logs);

  await sendNotifications(alerts);

  const now = new Date().toISOString();
  state.version = 1;
  state.assetsById = current.assetsById;
  state.contractsByAddress = current.contractsByAddress;
  state.mintedContractsByAddress = state.mintedContractsByAddress ?? {};
  state.lastScannedBlock = latestSafeBlock;
  state.initializedAt = state.initializedAt ?? now;
  state.updatedAt = now;
  await writeState(config.stateFile, state);

  console.log(
    `[${new Date().toISOString()}] Done. alerts=${alerts.length}, mintLogs=${logs.length}`
  );
}

async function main() {
  if (!globalThis.fetch) {
    throw new Error("This monitor requires Node.js 18+ for global fetch().");
  }

  do {
    try {
      await pollOnce();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.stack || error.message}`);
      try {
        await sendNotifications([
          {
            type: "error",
            title: "Robinhood Token Monitor error",
            description: error.message,
            fields: []
          }
        ]);
      } catch (discordError) {
        console.error(
          `[${new Date().toISOString()}] Discord error alert failed: ${
            discordError.stack || discordError.message
          }`
        );
      }
    }

    if (config.runOnce) break;
    await sleep(config.pollIntervalMs);
  } while (true);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
