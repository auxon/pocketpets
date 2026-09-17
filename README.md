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

## Economy (near-free demo pricing, fixed sats)

Real mainnet payments: game fees below are fixed satoshi amounts, not USD
conversions. Network fees are additional and unchanged, including inscription
transaction fees.

| Action | Price |
| --- | --- |
| Gacha pull | 1 sat |
| NFT mint | 1 sat fee + 1 sat inscription |
| Food refill | 1 sat |
| Cup entry | 1 sat to pot + 1 sat action fee (2% pot fee on payout) |
| Ledger anchor | 1 sat tip to pot + 1 sat action fee |
| PvP stakes | Free / $0.05 / $0.10 / $0.25, converted to sats at the exchange rate; paid stakes add a 1 sat action fee (winner takes 90%, house 10%) |
| NFT market | Seller-set prices unchanged + 2% fee (minimum 1 sat) |

Paid PvP dollar tiers are unchanged to match the separate backend's allowlist;
stakes are paid before a challenge is posted. Historical cup entries without a
recorded amount retain the legacy 100 sat fallback.

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
