import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";

await loadEnvFile(".env");

const config = {
  discordWebhookUrl: env("DISCORD_WEBHOOK_URL", ""),
  assetsUrl: env("RH_ASSETS_URL", "https://api.robinhood.com/rhj/assets"),
  rpcUrl: env("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  pollIntervalMs: intEnv("POLL_INTERVAL_MS", 300000),
  stateFile: env("STATE_FILE", process.env.RAILWAY_VOLUME_MOUNT_PATH ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/state.json` : "./state.json"),
  runOnce: boolEnv("RUN_ONCE", false) || process.argv.includes("--once"),
  alertOnFirstRun: boolEnv("ALERT_ON_FIRST_RUN", false),
  confirmations: intEnv("CONFIRMATIONS", 20),
  blockChunkSize: intEnv("BLOCK_CHUNK_SIZE", 2000),
  addressChunkSize: intEnv("ADDRESS_CHUNK_SIZE", 75),
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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function env(name, fallback) { return process.env[name] ?? fallback; }
function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function boolEnv(name, fallback) {
  const raw = process.env[name];
  return raw ? ["1", "true", "yes", "on"].includes(raw.toLowerCase()) : fallback;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hex(n) { return `0x${n.toString(16)}`; }
function fromHexQuantity(value) { return Number.parseInt(value, 16); }
function normalizeAddress(address) { return address.toLowerCase(); }
function addressFromTopic(topic) { return `0x${topic.slice(-40)}`; }
function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function formatUnits(raw, decimals = 18) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 8);
  return `${whole}.${fractionText}`;
}

async function readState(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, assetsById: {}, contractsByAddress: {}, lastScannedBlock: null, initializedAt: null, updatedAt: null };
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
  const response = await fetch(url, { ...options, headers: { accept: "application/json", "user-agent": "robinhood-token-monitor/1.0", ...(options.headers ?? {}) } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

let rpcId = 0;
let lastRpcRequestAt = 0;
async function rpc(method, params) {
  const body = { jsonrpc: "2.0", id: ++rpcId, method, params };
  for (let attempt = 0; attempt <= config.rpcMaxRetries; attempt += 1) {
    const waitFor = Math.max(0, lastRpcRequestAt + config.rpcRequestDelayMs - Date.now());
    if (waitFor > 0) await sleep(waitFor);
    lastRpcRequestAt = Date.now();
    const response = await fetch(config.rpcUrl, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "robinhood-token-monitor/1.0" }, body: JSON.stringify(body) });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    const retryableStatus = response.status === 429 || response.status >= 500;
    const retryableRpc = json?.error?.code === 429 || json?.error?.code === -32005 || json?.error?.message?.toLowerCase?.().includes("rate");
    if (response.ok && !json?.error) return json.result;
    if (attempt < config.rpcMaxRetries && (retryableStatus || retryableRpc)) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new Error(`${config.rpcUrl} returned ${response.status}: ${text.slice(0, 500)}`);
    throw new Error(`RPC ${method} failed: ${JSON.stringify(json?.error ?? text)}`);
  }
}

async function fetchAssets() {
  const data = await fetchJson(config.assetsUrl);
  return (Array.isArray(data.assets) ? data.assets : []).filter((asset) => Array.isArray(asset.deployments)).map((asset) => ({
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
    deployments: asset.deployments.map((deployment) => ({ contractAddress: deployment.contractAddress, chainId: deployment.chainId, networkName: deployment.networkName }))
  }));
}

function indexAssets(assets) {
  const assetsById = {};
  const contractsByAddress = {};
  for (const asset of assets) {
    assetsById[asset.id] = asset;
    for (const deployment of asset.deployments) {
      if (!deployment.contractAddress) continue;
      contractsByAddress[normalizeAddress(deployment.contractAddress)] = { assetId: asset.id, tokenSymbol: asset.tokenSymbol, tokenName: asset.tokenName, tokenDecimals: asset.tokenDecimals ?? 18, status: asset.status, chainId: deployment.chainId, networkName: deployment.networkName };
    }
  }
  return { assetsById, contractsByAddress };
}

function assetFields(asset) {
  const contracts = (asset.deployments ?? []).map((deployment) => deployment.contractAddress).filter(Boolean);
  return [
    { name: "Symbol", value: asset.tokenSymbol || "unknown", inline: true },
    { name: "Status", value: asset.status || "unknown", inline: true },
    { name: "ISIN", value: asset.isin || "unknown", inline: true },
    { name: "Contract", value: contracts.length > 0 ? contracts.join("\n").slice(0, 1024) : "none" }
  ];
}

function detectAssetChanges(previous, current, firstRun) {
  if (firstRun && !config.alertOnFirstRun) return [];
  const alerts = [];
  for (const [id, asset] of Object.entries(current.assetsById)) {
    const old = previous.assetsById[id];
    if (!old) {
      alerts.push({ type: "new_asset", title: `New Robinhood Stock Token: ${asset.tokenSymbol}`, description: asset.tokenName, fields: assetFields(asset) });
      continue;
    }
    const oldContracts = new Set((old.deployments ?? []).map((deployment) => normalizeAddress(deployment.contractAddress ?? "")));
    const addedContracts = (asset.deployments ?? []).filter((deployment) => deployment.contractAddress && !oldContracts.has(normalizeAddress(deployment.contractAddress)));
    if (addedContracts.length > 0) alerts.push({ type: "new_deployment", title: `New deployment for ${asset.tokenSymbol}`, description: asset.tokenName, fields: [...assetFields(asset), { name: "New contract(s)", value: addedContracts.map((deployment) => deployment.contractAddress).join("\n").slice(0, 1024) }] });
    if (old.status !== asset.status && asset.status === "ASSET_STATUS_ACTIVE") alerts.push({ type: "asset_activated", title: `${asset.tokenSymbol} is now active`, description: asset.tokenName, fields: assetFields(asset) });
  }
  return alerts;
}

async function getLatestSafeBlock() {
  return Math.max(0, fromHexQuantity(await rpc("eth_blockNumber", [])) - config.confirmations);
}
async function getMintLogs(contractsByAddress, fromBlock, toBlock) {
  const addresses = Object.keys(contractsByAddress);
  if (addresses.length === 0 || fromBlock > toBlock) return [];
  const logs = [];
  for (let blockStart = fromBlock; blockStart <= toBlock; blockStart += config.blockChunkSize) {
    const blockEnd = Math.min(toBlock, blockStart + config.blockChunkSize - 1);
    for (const addressChunk of chunks(addresses, config.addressChunkSize)) {
      logs.push(...await rpc("eth_getLogs", [{ fromBlock: hex(blockStart), toBlock: hex(blockEnd), address: addressChunk, topics: [TRANSFER_TOPIC, ZERO_TOPIC] }]));
    }
  }
  return logs;
}
function mintAlerts(logs, contractsByAddress, firstRun) {
  if (firstRun && !config.alertOnFirstRun) return [];
  return logs.map((log) => {
    const token = contractsByAddress[normalizeAddress(log.address)] ?? {};
    const amount = formatUnits(BigInt(log.data || "0x0").toString(), token.tokenDecimals ?? 18);
    const recipient = log.topics?.[2] ? addressFromTopic(log.topics[2]) : "unknown";
    return { type: "mint", title: `Mint detected: ${token.tokenSymbol ?? log.address}`, description: token.tokenName ?? "Robinhood Stock Token", fields: [
      { name: "Symbol", value: token.tokenSymbol ?? "unknown", inline: true },
      { name: "Amount", value: amount, inline: true },
      { name: "Recipient", value: recipient },
      { name: "Contract", value: log.address },
      { name: "Transaction", value: `https://robinhoodchain.blockscout.com/tx/${log.transactionHash}` }
    ] };
  });
}

async function sendDiscord(alerts) {
  if (alerts.length === 0) return;
  if (!config.discordWebhookUrl || config.discordWebhookUrl.includes("...")) {
    console.log(`DISCORD_WEBHOOK_URL is not set; ${alerts.length} alert(s) not sent.`);
    for (const alert of alerts) console.log(`[${alert.type}] ${alert.title} - ${alert.description}`);
    return;
  }
  for (const batch of chunks(alerts, 10)) {
    const response = await fetch(config.discordWebhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "Robinhood Token Monitor", embeds: batch.map((alert) => ({ title: alert.title, description: alert.description, color: alert.type === "mint" ? 0x00a86b : 0x1f8b4c, timestamp: new Date().toISOString(), fields: alert.fields.slice(0, 25) })) }) });
    if (!response.ok) throw new Error(`Discord webhook returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
}

async function pollOnce() {
  const state = await readState(config.stateFile);
  const firstRun = !state.initializedAt;
  console.log(`[${new Date().toISOString()}] Fetching Robinhood assets...`);
  const current = indexAssets(await fetchAssets());
  const latestSafeBlock = await getLatestSafeBlock();
  const fromBlock = state.lastScannedBlock === null ? latestSafeBlock : Math.min(state.lastScannedBlock + 1, latestSafeBlock);
  console.log(`[${new Date().toISOString()}] Assets=${Object.keys(current.assetsById).length}, scan=${fromBlock}-${latestSafeBlock}`);
  const assetAlerts = detectAssetChanges(state, current, firstRun);
  const logs = firstRun && !config.alertOnFirstRun ? [] : await getMintLogs(current.contractsByAddress, fromBlock, latestSafeBlock);
  const alerts = [...assetAlerts, ...mintAlerts(logs, current.contractsByAddress, firstRun)];
  await sendDiscord(alerts);
  const now = new Date().toISOString();
  await writeState(config.stateFile, { version: 1, assetsById: current.assetsById, contractsByAddress: current.contractsByAddress, lastScannedBlock: latestSafeBlock, initializedAt: state.initializedAt ?? now, updatedAt: now });
  console.log(`[${new Date().toISOString()}] Done. alerts=${alerts.length}, mintLogs=${logs.length}`);
}

async function main() {
  do {
    try {
      await pollOnce();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.stack || error.message}`);
      try { await sendDiscord([{ type: "error", title: "Robinhood Token Monitor error", description: error.message, fields: [] }]); } catch (discordError) { console.error(`[${new Date().toISOString()}] Discord error alert failed: ${discordError.stack || discordError.message}`); }
    }
    if (config.runOnce) break;
    await sleep(config.pollIntervalMs);
  } while (true);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
