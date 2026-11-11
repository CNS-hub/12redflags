// connect.mjs
// One-time setup: lets the n8n post queue cast as @12redflags through Neynar.
//
// What it does:
//   1. Asks for your Neynar API key and the @12redflags recovery phrase (hidden as you type).
//   2. Checks the phrase belongs to the expected account and shows you the username.
//   3. Asks Neynar for a new posting key, signs the request with the phrase, registers it.
//   4. Shows a QR code. You approve it in the Farcaster app.
//   5. Prints the signer UUID for the post queue.
//
// What it does NOT do:
//   - It never saves, prints, or sends the recovery phrase anywhere. The phrase is used
//     only on this Mac to make one signature. Only the signature goes to Neynar.
//   - It never saves the API key. Only the signer UUID is written to signer.txt.
//
// Run:  cd ~/12redflags-signer && node connect.mjs

import readline from "node:readline";
import { writeFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import qrcode from "qrcode-terminal";

const EXPECTED_FID = 3358393;                                         // from the signed 12redflags.com manifest
const EXPECTED_CUSTODY = "0x8b10314e286Aa18B351D4E78DA31a2177bb1E341"; // same source
const API = "https://api.neynar.com/v2/farcaster";

// Farcaster's SignedKeyRequestValidator contract on Optimism (EIP-712 domain).
const DOMAIN = {
  name: "Farcaster SignedKeyRequestValidator",
  version: "1",
  chainId: 10,
  verifyingContract: "0x00000000FC700472606ED4fA22623Acf62c60553",
};
const TYPES = {
  SignedKeyRequest: [
    { name: "requestFid", type: "uint256" },
    { name: "key", type: "bytes" },
    { name: "deadline", type: "uint256" },
  ],
};

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.startsWith(question)) rl.output.write(question);
        else rl.output.write("*".repeat(Math.min(s.length, 1)));
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function neynar(apiKey, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Neynar ${method} ${path} failed (${res.status}): ${json.message || text}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n12 Red Flags: connect @12redflags to the post queue\n");

  const apiKey = process.env.NEYNAR_API_KEY || (await ask("Neynar API key (hidden): ", { hidden: true }));
  if (!apiKey) throw new Error("No API key entered.");

  let phrase = await ask("@12redflags recovery phrase, words separated by spaces (hidden): ", { hidden: true });
  phrase = phrase.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  let account;
  try { account = mnemonicToAccount(phrase); } catch { throw new Error("That phrase isn't a valid recovery phrase. Nothing was sent anywhere."); }
  phrase = null; // drop our copy

  if (account.address.toLowerCase() !== EXPECTED_CUSTODY.toLowerCase()) {
    throw new Error(
      `That phrase belongs to ${account.address}, not the account that signed 12redflags.com (${EXPECTED_CUSTODY}).\n` +
      "Nothing was sent anywhere. Check you copied the phrase from the @12redflags account."
    );
  }

  const lookup = await neynar(apiKey, "GET", `/user/custody-address?custody_address=${account.address}`);
  const user = lookup.user || {};
  console.log(`\nPhrase matches FID ${user.fid ?? "?"} (@${user.username ?? "?"}).`);
  if (Number(user.fid) !== EXPECTED_FID) throw new Error(`Expected FID ${EXPECTED_FID}. Stopping.`);
  const ok = await ask(`Create a posting key for @${user.username}? Type yes to continue: `);
  if (ok.toLowerCase() !== "yes") { console.log("Stopped. Nothing was created."); return; }

  const signer = await neynar(apiKey, "POST", "/signer");
  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const signature = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "SignedKeyRequest",
    message: { requestFid: BigInt(EXPECTED_FID), key: signer.public_key, deadline: BigInt(deadline) },
  });

  const reg = await neynar(apiKey, "POST", "/signer/signed_key", {
    signer_uuid: signer.signer_uuid,
    app_fid: EXPECTED_FID,
    deadline,
    signature,
    sponsor: { sponsored_by_neynar: true },
  });

  if (!reg.signer_approval_url) throw new Error("Neynar didn't return an approval link: " + JSON.stringify(reg));
  console.log("\nScan this with your phone camera and approve in the Farcaster app (as @12redflags):\n");
  qrcode.generate(reg.signer_approval_url, { small: true });
  console.log("\nOr open this link on your phone:\n" + reg.signer_approval_url + "\n");
  console.log("Waiting for approval (up to 15 minutes)...");

  const until = Date.now() + 15 * 60 * 1000;
  while (Date.now() < until) {
    await sleep(4000);
    const s = await neynar(apiKey, "GET", `/signer?signer_uuid=${signer.signer_uuid}`);
    if (s.status === "approved") {
      writeFileSync(new URL("./signer.txt", import.meta.url), signer.signer_uuid + "\n");
      console.log("\nApproved.");
      console.log("Signer UUID: " + signer.signer_uuid);
      console.log("Saved to ~/12redflags-signer/signer.txt. Paste the UUID to Claude. (It only works together with your API key.)\n");
      return;
    }
    if (s.status === "revoked") throw new Error("The request was rejected or revoked in Farcaster.");
    process.stdout.write(".");
  }
  console.log("\nTimed out. Run it again when you're ready; an unapproved key does nothing.");
}

main().catch((e) => { console.error("\nError: " + e.message + "\n"); process.exit(1); });
