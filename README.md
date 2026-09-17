# Pocket Pets — gacha buddies on BSV

Mobile gacha game on Bitcoin SV. Live at **https://entangleit.com/pocketpets**.

Raise pocket pets, mint them as 1Sat Ordinal NFTs, log every action on-chain,
battle wild pets and real players, and trade on the NFT market.

## Play

```bash
npm install
npm run dev        # :5191
npm test           # node --test
```

## BSV OS runner (no browser keys)

Opened inside the BSV OS runner, the game routes every wallet operation —
payments, mints, NFT transfers, atomic-swap listings and buys — through the
OS daemon's `window.bsv` intents under the app origin policy. No keys touch
the page; the built-in/Yours backends stay as fallbacks outside the runner.
Needs one static file to install: `https://entangleit.com/manifest.json`.

## Economy (USD-denominated, settled in sats at the live rate)

| Action | Price |
| --- | --- |
| Gacha pull | $0.10 |
| NFT mint | $0.50 |
| Food refill | $0.05 |
| Cup entry | $0.10 + $0.02 |
| Ledger anchor | $0.02 |
| PvP stakes | Free / $0.05 / $0.10 / $0.25 (winner takes 90%, house 10%) |
| NFT market | 2% on sales |

## Pets

23 species across common → rare → epic → legendary. Pets **evolve** two ways:
mutation on care actions (feed 1%, play 1.5%, rest 0.5%) and win milestones
(100 / 250 / 500 wins). Lineage is stored on the pet, the NFT, and the ledger.

Food is a daily resource (20/day, refills at local midnight).

## On-chain

- **Built-in self-custody wallet** (PIN-encrypted, QR receive) or Yours via `@1sat/react`.
- **NFTs** are 1Sat Ordinal inscriptions; every game action appends to a
  hash-chained ledger anchorable on-chain.
- **Atomic swaps** (`SINGLE|ANYONECANPAY`): escrow-free NFT trades that settle
  payment + transfer in one tx, interpreter-verified in tests.
- **Order book + PvP lobby** run on a Cloudflare Worker + D1
  (`/Users/rah/gatekeep`, routes under `/v1/market` and `/v1/pvp`).

## Deploy

```bash
bash scripts/deploy-entangleit.sh   # build + stage + pages deploy (absolute paths!)
```

Auth for testers is Sign in with Twetch (OIDC, `twetch-oidc` repo).
