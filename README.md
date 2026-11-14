# 12 Red Flags

![Red Flag Protocol](assets/flag-logo.jpg)

**Play it: [12redflags.com](https://12redflags.com)**

A fake crypto project built to look like the scams that took billions in 2025. Twelve red flags are hidden on the page, along with four decoys that look suspicious but are actually fine. Find all twelve without tripping the decoys.

This is a free training tool from [Crypto Clarity Collective](https://cryptoclaritycollective.com), built as the companion to my book *The $6 Billion Mistake*.

## Why this repo exists

One of the twelve red flags is "no real development activity." Scam projects link to a GitHub repo with one commit, forked from someone else's token, untouched for two years.

This repo is the opposite on purpose. Everything here is built in public, with the full commit history, including the mistakes and the fixes. Look at the history and you'll see what a real project looks like over time.

## What's in here

| Folder | What it is |
|---|---|
| `site/` | The game. One self-contained HTML file, no build step, no tracking pixels. |
| `n8n/` | The automations behind it, as n8n workflow exports. |
| `assets/` | The Red Flag Protocol artwork. `flag-icon-1000.png` (big flag) is for small sizes: token icon, favicon, app icons. `flag-icon-1000-classic.png` and `flag-logo.jpg` (smaller flag) are for anywhere the art shows large. |
| `ops/` | The deploy script and cron schedule that publish `site/` to 12redflags.com. |
| `tracker/` | The on-chain tracker: records every trade of a watched token on Base and tags snipers, bundled buys, sandwich bots, fresh wallets, whale trades, zero-value (address poisoning) transfers and copycat tokens. |

### site/index.html

Everything is in one file. The settings live in the `CONFIG` block near the top: contract address, fee recipient, newsletter link, and the score webhook. While the contract address is empty, the page says no token exists yet, so anything claiming to be $FLAG before launch is fake.

The scam claims on the page are fake on purpose. Every card carries a "TRAINING SITE" watermark, and a notice bar stays pinned to the bottom of the screen, so screenshots stay labeled.

### n8n/

- **spot-the-flag-score-logger.json** receives each finished game, checks it, and appends one row to a Google Sheet. It records the score, flags found, false alarms, time, and which flags were missed. No names, emails or IP addresses are stored. Scores that don't add up (12 flags found but some still marked missed, impossible point totals) are dropped.
- **spot-the-flag-weekly-summary.json** reads the sheet every Monday morning and emails a summary: games played, average flags found, and the three most-missed flags. It also drafts a post about the week's most-missed flag and adds it to the post queue.
- **12redflags-post-queue.json** posts to Farcaster from a `Post Queue` tab in the same sheet. Nothing posts until a person sets a row's Status to `approved`, and it sends at most one post every 15 minutes. Posting goes through Neynar with a managed signer; `ops/farcaster-signer/connect.mjs` is the one-time script that created it.

To use them in your own n8n: import each file, attach your own Google Sheets and Gmail credentials, and replace `YOUR_GOOGLE_SHEET_ID` and `you@example.com`. The sheet needs a tab called `Plays` with these headers in row 1: `Received`, `Score`, `Flags found`, `False alarms`, `Seconds`, `Missed flags`, `Client time`, `Source`.

### tracker/

`collector.mjs` runs every minute on a small server. For each watched token it pulls new transfers from Alchemy (free tier), finds the Uniswap v4 swaps, and works out who traded. Then it looks for patterns:

- **Snipers:** buys within 5 blocks (about 10 seconds) of the token going live
- **Bundles:** 3 or more different wallets buying back-to-back in one block for nearly the same amount, usually one operator pretending to be a crowd
- **Sandwiches:** a wallet buys right before someone else's trade and sells right after, in the same block
- **Fresh wallets:** a buyer whose wallet was first funded less than 24 hours earlier, and funding clusters where 3+ buyers were funded by the same address
- **Whales:** one trade moving 1% or more of the supply
- **Zero-value transfers:** the address poisoning pattern
- **Copycats:** fake FLAG or Red Flag tokens on Base, checked hourly on DEX Screener

Everything is stored in Supabase behind a single function that needs a secret, and a daily email summarizes it. Keys live in a `.env` file on the server, never in this repo.

## How the live site updates

This repo is the source of truth for 12redflags.com. Every 5 minutes the server checks `main` for a new commit. When it finds one, it:

1. Backs up the version that's live now
2. Publishes the `site/` folder (nothing else in the repo goes live)
3. Checks that the site still loads, and rolls back to the backup if it doesn't

The commit that's live is always at [12redflags.com/version.txt](https://12redflags.com/version.txt). The script is in `ops/`.

## About $FLAG

Red Flag Protocol ($FLAG) is a planned token on Base, built to pass my own scanner and launched in public as a teaching tool.

- **Do not buy it.** It is not an investment. Expect it to go to zero.
- I hold no team allocation and will never earn a cent from it. Creator fees go to a published charity address.
- No token exists yet. The official contract address will be posted at [12redflags.com](https://12redflags.com) and in this README at launch. If it isn't that exact address, it's a scam.

## Not financial advice

Nothing here is an offer to sell anything. It's a training tool. Check everything yourself, including this repo.
