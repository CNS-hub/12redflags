// 12redflags tracker: records every trade of a watched token on Base and tags the
// bots and scams that show up. Built for the $FLAG launch, rehearsed on other Clanker tokens.
//
// Data sources (all free):
//   - Alchemy (Base): token transfers, transaction receipts, wallet history
//   - DEX Screener: copycat search
// Storage: Supabase, through one locked-down function (public.flag_api) that needs a secret.
//
// Modes:
//   node collector.mjs                       collect new trades for every active token (run every minute)
//   node collector.mjs add <token> <poolId> <deployTx> [label]   start watching a token
//   node collector.mjs recent                list the newest Clanker tokens (to pick a dry-run token)
//   node collector.mjs copycats              look for fake FLAG / Red Flag tokens (run hourly)
//
// Settings come from .env next to this file (never committed):
//   ALCHEMY_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, FLAG_API_SECRET

import { readFileSync } from "node:fs";

// ---------- settings ----------
const here = new URL(".", import.meta.url);
try {
  for (const line of readFileSync(new URL(".env", here), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
const ENV = process.env;
for (const k of ["ALCHEMY_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "FLAG_API_SECRET"]) {
  if (!ENV[k]) { console.error("missing setting " + k); process.exit(1); }
}

const ALCHEMY_URL = "https://base-mainnet.g.alchemy.com/v2";
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b"; // Uniswap v4 on Base (Clanker v4 pools)
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const ZERO = "0x0000000000000000000000000000000000000000";

const SNIPER_BLOCKS = 5;          // buys within 5 blocks (~10 s) of deploy
const FRESH_HOURS = 24;           // wallet first funded less than 24 h before its buy
const WHALE_PCT = 1;              // one trade moving >= 1% of supply
const MAX_PROFILES_PER_RUN = 40;  // keeps Alchemy usage inside the free tier
const MAX_RUNTIME_MS = 50_000;    // cron runs every minute
const BLOCK_STEP = 2000;
const started = Date.now();

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + n.toString(16);
const lc = (s) => (s || "").toLowerCase();

async function rpcBatch(calls) {
  // Alchemy free tier: about 25 receipts per second. Small chunks, pause between, retry on 429.
  const out = [];
  for (let i = 0; i < calls.length; i += 10) {
    const chunk = calls.slice(i, i + 10).map((c, j) => ({ jsonrpc: "2.0", id: i + j, method: c[0], params: c[1] }));
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(ALCHEMY_URL, {
        method: "POST",
        headers: { Authorization: "Bearer " + ENV.ALCHEMY_KEY, "content-type": "application/json" },
        body: JSON.stringify(chunk),
      });
      let arr = r.status === 429 ? null : await r.json();
      if (arr && !Array.isArray(arr)) arr = [arr];
      const limited = !arr || arr.some((x) => x.error && (x.error.code === 429 || /compute units/i.test(x.error.message || "")));
      if (limited) {
        if (attempt >= 6) throw new Error("Alchemy rate limit, giving up for this run");
        await sleep(1200 * (attempt + 1));
        continue;
      }
      arr.sort((a, b) => a.id - b.id);
      for (const x of arr) {
        if (x.error) throw new Error(`${chunk.find((c) => c.id === x.id)?.method}: ${JSON.stringify(x.error)}`);
        out.push(x.result);
      }
      break;
    }
    if (calls.length > 10) await sleep(400);
  }
  return out;
}
const rpc = async (m, p) => (await rpcBatch([[m, p]]))[0];

async function api(action, payload = {}) {
  const r = await fetch(`${ENV.SUPABASE_URL}/rest/v1/rpc/flag_api`, {
    method: "POST",
    headers: {
      apikey: ENV.SUPABASE_ANON_KEY,
      Authorization: "Bearer " + ENV.SUPABASE_ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_secret: ENV.FLAG_API_SECRET, p_action: action, p_payload: payload }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`flag_api ${action} ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

function units(raw, decimals) {
  const neg = raw < 0n; let v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base; let frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}
function int128(word) {
  let v = BigInt("0x" + word);
  if (v >= 1n << 255n) v -= 1n << 256n;
  return v;
}

// ---------- collect ----------
async function getTransfers(token, fromBlock, toBlock) {
  const rows = [];
  let pageKey;
  do {
    const res = await rpc("alchemy_getAssetTransfers", [{
      fromBlock: hex(fromBlock), toBlock: hex(toBlock),
      contractAddresses: [token], category: ["erc20"],
      withMetadata: true, excludeZeroValue: false, order: "asc", maxCount: "0x3e8",
      ...(pageKey ? { pageKey } : {}),
    }]);
    rows.push(...res.transfers);
    pageKey = res.pageKey;
  } while (pageKey && Date.now() - started < MAX_RUNTIME_MS);
  return rows;
}

async function profile(addresses) {
  if (!addresses.length) return [];
  const calls = [];
  for (const a of addresses) {
    calls.push(["alchemy_getAssetTransfers", [{ toAddress: a, category: ["external", "internal"], order: "asc", maxCount: "0x1", withMetadata: true }]]);
    calls.push(["eth_getTransactionCount", [a, "latest"]]);
  }
  const res = await rpcBatch(calls);
  return addresses.map((a, i) => {
    const first = res[2 * i]?.transfers?.[0];
    return {
      address: a,
      first_funded_at: first?.metadata?.blockTimestamp || null,
      first_funder: first ? lc(first.from) : null,
      nonce: parseInt(res[2 * i + 1], 16),
      tags: [],
    };
  });
}

async function collectToken(tok, latest, deadline) {
  const token = lc(tok.address), poolId = lc(tok.pool_id), paired = lc(tok.paired);
  const dec = tok.decimals || 18;
  const supply = tok.total_supply ? BigInt(String(tok.total_supply).split(".")[0]) * 10n ** BigInt(dec) : null;
  let from = Number(tok.last_block ?? tok.deploy_block - 1) + 1;

  while (from <= latest && Date.now() < deadline) {
    const to = Math.min(latest, from + BLOCK_STEP - 1);
    const raw = await getTransfers(token, from, to);

    const transfers = raw.map((t) => ({
      token, tx_hash: lc(t.hash), log_index: parseInt(t.uniqueId.split(":log:")[1] ?? "0", 10),
      block: parseInt(t.blockNum, 16), block_time: t.metadata?.blockTimestamp || null,
      from_addr: lc(t.from), to_addr: lc(t.to),
      amount: units(BigInt(t.rawContract.value || "0x0"), dec),
      _raw: BigInt(t.rawContract.value || "0x0"),
    }));

    const events = [];
    for (const t of transfers) {
      if (t._raw === 0n && t.from_addr !== ZERO) {
        events.push({ token, type: "zero_value_transfer", wallet: t.to_addr, tx_hash: t.tx_hash,
          detail: { from: t.from_addr, to: t.to_addr, note: "0-amount transfer, common in address poisoning" } });
      }
    }

    // Trades: transactions where tokens moved in or out of the Uniswap v4 PoolManager.
    const byTx = new Map();
    for (const t of transfers) {
      if (t.from_addr !== POOL_MANAGER && t.to_addr !== POOL_MANAGER) continue;
      if (!byTx.has(t.tx_hash)) byTx.set(t.tx_hash, []);
      byTx.get(t.tx_hash).push(t);
    }
    const hashes = [...byTx.keys()];
    const receipts = hashes.length ? await rpcBatch(hashes.map((h) => ["eth_getTransactionReceipt", [h]])) : [];

    const tokenIs0 = BigInt(token) < BigInt(paired || "0x" + "f".repeat(40));
    const trades = [];
    receipts.forEach((rc, i) => {
      if (!rc) return;
      const h = hashes[i];
      const swaps = rc.logs.filter((l) => lc(l.address) === POOL_MANAGER && l.topics[0] === SWAP_TOPIC && lc(l.topics[1]) === poolId);
      if (!swaps.length) return; // liquidity moves, not trades
      const tx = byTx.get(h);
      let net = 0n; // tokens leaving the pool (positive = buy)
      for (const t of tx) {
        if (t.from_addr === POOL_MANAGER) net += t._raw;
        if (t.to_addr === POOL_MANAGER) net -= t._raw;
      }
      if (net === 0n) return;
      let pairedAbs = 0n;
      for (const s of swaps) {
        const w = s.data.slice(2);
        const a0 = int128(w.slice(0, 64)), a1 = int128(w.slice(64, 128));
        const p = tokenIs0 ? a1 : a0;
        pairedAbs += p < 0n ? -p : p;
      }
      const block = parseInt(rc.blockNumber, 16);
      const tags = [];
      const after = block - Number(tok.deploy_block);
      if (net > 0n && after <= SNIPER_BLOCKS) tags.push("sniper");
      const amt = net > 0n ? net : -net;
      if (supply && amt * 100n >= supply * BigInt(WHALE_PCT)) tags.push("whale");
      trades.push({
        token, tx_hash: h, log_index: parseInt(swaps[0].logIndex, 16), block,
        block_time: tx[0].block_time, tx_index: parseInt(rc.transactionIndex, 16),
        trader: lc(rc.from), router: "0x" + swaps[0].topics[2].slice(26),
        side: net > 0n ? "buy" : "sell",
        token_amount: units(amt, dec), paired_amount: units(pairedAbs, 18),
        blocks_after_deploy: after, tags,
      });
    });

    // Sandwiches: same wallet buys before and sells after someone else's trade in one block.
    const byBlock = new Map();
    for (const t of trades) { if (!byBlock.has(t.block)) byBlock.set(t.block, []); byBlock.get(t.block).push(t); }
    for (const list of byBlock.values()) {
      list.sort((a, b) => a.tx_index - b.tx_index);
      for (let a = 0; a < list.length; a++) {
        if (list[a].side !== "buy") continue;
        for (let c = a + 2; c < list.length; c++) {
          if (list[c].trader !== list[a].trader || list[c].side !== "sell") continue;
          const victims = list.slice(a + 1, c).filter((v) => v.trader !== list[a].trader);
          if (!victims.length) continue;
          list[a].tags.push("sandwich"); list[c].tags.push("sandwich");
          for (const v of victims) {
            v.tags.push("sandwiched");
            events.push({ token, type: "sandwich", wallet: list[a].trader, tx_hash: v.tx_hash,
              detail: { attacker: list[a].trader, front: list[a].tx_hash, victim: v.trader, back: list[c].tx_hash, block: v.block } });
          }
        }
      }
    }

    // Bundles: 3+ different wallets buying back-to-back in one block with near-identical size.
    // Usually one operator splitting a buy across wallets to look like real demand.
    for (const list of byBlock.values()) {
      const buys = list.filter((t) => t.side === "buy").sort((a, b) => a.tx_index - b.tx_index);
      let run = [];
      const flush = () => {
        const traders = new Set(run.map((t) => t.trader));
        if (run.length >= 3 && traders.size >= 3) {
          for (const t of run) t.tags.push("bundle");
          events.push({ token, type: "bundle", wallet: run[0].trader, tx_hash: run[0].tx_hash,
            detail: { block: run[0].block, wallets: [...traders], paid_each: run.map((t) => t.paired_amount) } });
        }
        run = [];
      };
      for (const t of buys) {
        const prev = run[run.length - 1];
        const close = prev && t.tx_index - prev.tx_index <= 2 &&
          Math.abs(Number(t.paired_amount) - Number(prev.paired_amount)) <= 0.05 * Math.max(Number(prev.paired_amount), 1e-12);
        if (prev && !close) flush();
        run.push(t);
      }
      flush();
    }

    // Profile new buyers: how old is the wallet, who funded it.
    const buyers = [...new Set(trades.filter((t) => t.side === "buy").map((t) => t.trader))];
    let wallets = [];
    if (buyers.length) {
      const known = new Set(await api("known_wallets", { addresses: buyers }));
      const fresh = buyers.filter((b) => !known.has(b)).slice(0, MAX_PROFILES_PER_RUN);
      wallets = await profile(fresh);
      const prof = new Map(wallets.map((w) => [w.address, w]));
      for (const t of trades) {
        const w = prof.get(t.trader);
        if (!w || !w.first_funded_at || t.side !== "buy") continue;
        const ageH = (new Date(t.block_time) - new Date(w.first_funded_at)) / 3.6e6;
        if (ageH >= 0 && ageH < FRESH_HOURS) {
          t.tags.push("fresh_wallet");
          if (!w.tags.includes("fresh_wallet")) w.tags.push("fresh_wallet");
        }
      }
    }

    for (const t of trades) {
      t.tags = [...new Set(t.tags)];
      if (t.tags.includes("sniper")) events.push({ token, type: "sniper", wallet: t.trader, tx_hash: t.tx_hash, detail: { blocks_after_deploy: t.blocks_after_deploy, amount: t.token_amount, paid: t.paired_amount } });
      if (t.tags.includes("whale")) events.push({ token, type: "whale", wallet: t.trader, tx_hash: t.tx_hash, detail: { side: t.side, amount: t.token_amount, paid: t.paired_amount } });
    }
    if (trades.length && tok.last_block < tok.deploy_block) {
      const first = trades[0];
      events.push({ token, type: "first_trade", wallet: first.trader, tx_hash: first.tx_hash, detail: { blocks_after_deploy: first.blocks_after_deploy, side: first.side } });
    }

    for (const t of transfers) delete t._raw;
    await api("ingest", { token, last_block: to, transfers, trades, wallets, events });
    console.log(`${new Date().toISOString()} ${tok.symbol} blocks ${from}-${to}: ${transfers.length} transfers, ${trades.length} trades, ${wallets.length} new wallets, ${events.length} events`);
    tok.last_block = to;
    from = to + 1;
  }
}

async function collect() {
  const tokens = await api("tokens");
  if (!tokens.length) return console.log("no active tokens");
  const latest = parseInt(await rpc("eth_blockNumber", []), 16) - 3; // stay a few blocks behind the tip
  // Newest launches first, and each token gets a fair share of the minute so a long
  // backfill can't starve a live launch.
  tokens.sort((a, b) => Number(b.deploy_block) - Number(a.deploy_block));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const left = MAX_RUNTIME_MS - (Date.now() - started);
    const deadline = Date.now() + Math.max(5000, left / (tokens.length - i));
    try { await collectToken(t, latest, deadline); }
    catch (e) { console.error(`${new Date().toISOString()} ${t.symbol} ERROR ${e.message}`); }
  }
}

// ---------- add a token ----------
async function addToken(address, poolId, deployTx, label) {
  const sel = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" };
  const [rc, n, s, d, ts] = await rpcBatch([
    ["eth_getTransactionReceipt", [deployTx]],
    ...Object.values(sel).map((data) => ["eth_call", [{ to: address, data }, "latest"]]),
  ]);
  const str = (h) => { const b = Buffer.from(h.slice(2), "hex"); const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex"))); return b.subarray(64, 64 + len).toString("utf8"); };
  const decimals = parseInt(d, 16);
  const block = parseInt(rc.blockNumber, 16);
  const blk = await rpc("eth_getBlockByNumber", [hex(block), false]);
  const payload = {
    address, symbol: str(s), name: str(n), pool_id: poolId,
    paired: "0x4200000000000000000000000000000000000006",
    decimals, total_supply: units(BigInt(ts), decimals).split(".")[0],
    deploy_block: block, deployed_at: new Date(parseInt(blk.timestamp, 16) * 1000).toISOString(),
    deployer: lc(rc.from), label: label || "dry run", is_official: label === "official",
  };
  await api("add_token", payload);
  console.log("watching", payload);
}

async function recent() {
  const r = await (await fetch("https://www.clanker.world/api/tokens?sort=desc&page=1&limit=20")).json();
  for (const t of r.data) console.log([t.deployed_at, t.symbol, t.contract_address, t.pool_address, t.tx_hash, t.type, t.pair].join(" | "));
}

// ---------- copycats ----------
async function copycats() {
  const tokens = await api("tokens");
  const official = new Set(tokens.filter((t) => t.is_official).map((t) => lc(t.address)));
  let found = 0;
  for (const q of ["FLAG", "Red Flag", "12redflags", "Red Flag Protocol"]) {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q));
    if (!r.ok) continue;
    const j = await r.json();
    for (const p of j.pairs || []) {
      if (p.chainId !== "base") continue;
      const b = p.baseToken || {};
      const looksLike = /^\$?flag$/i.test(b.symbol || "") || /red\s*flag|12\s*red\s*flags/i.test(b.name || "");
      if (!looksLike || official.has(lc(b.address))) continue;
      const res = await api("copycat", { address: b.address, chain: "base", symbol: b.symbol, name: b.name, source: "dexscreener", url: p.url,
        detail: { pair: p.pairAddress, dex: p.dexId, created: p.pairCreatedAt, liquidity_usd: p.liquidity?.usd, volume_24h: p.volume?.h24 } });
      if (res.new) {
        found++;
        await api("ingest", { events: [{ token: lc(b.address), type: "copycat", wallet: null, tx_hash: null,
          detail: { symbol: b.symbol, name: b.name, url: p.url, created: p.pairCreatedAt, liquidity_usd: p.liquidity?.usd } }] });
      }
    }
  }
  console.log(`${new Date().toISOString()} copycat check: ${found} new`);
}

// ---------- main ----------
const [mode, ...args] = process.argv.slice(2);
try {
  if (!mode) await collect();
  else if (mode === "add") await addToken(lc(args[0]), lc(args[1]), args[2], args[3]);
  else if (mode === "recent") await recent();
  else if (mode === "copycats") await copycats();
  else throw new Error("unknown mode " + mode);
} catch (e) {
  console.error(`${new Date().toISOString()} FATAL ${e.message}`);
  process.exit(1);
}
