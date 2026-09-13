import { test } from "node:test";
import assert from "node:assert/strict";
import { Script, Transaction } from "@bsv/sdk";
import {
  addressFromWif, buildTx, createKey, inscriptionScript, opReturnScript,
} from "../src/embedded.ts";

test("keygen gives valid P2PKH address", () => {
  const { wif, address } = createKey();
  assert.match(address, /^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/);
  assert.equal(addressFromWif(wif), address);
});

test("inscription script carries ord envelope + content", () => {
  const { address } = createKey();
  const content = new TextEncoder().encode("hello-pet");
  const s = inscriptionScript(address, "image/jpeg", content);
  const asm = s.toASM();
  assert.ok(asm.includes("6f7264"), "envelope has ord marker"); // 'ord' as hex push
  assert.ok(asm.includes(Buffer.from("image/jpeg").toString("hex")), "envelope has content type");
  assert.ok(s.toHex().includes(Buffer.from("hello-pet").toString("hex")), "content embedded");
});

test("opreturn script round-trips parts", () => {
  const s = opReturnScript(["POCKETPETS-ENTRY", "abc123"]);
  const asm = s.toASM();
  assert.ok(asm.startsWith("OP_0 OP_RETURN"), asm.slice(0, 40));
});

const FAKE_UTXO = { txid: "a".repeat(64), vout: 0, value: 1_000_000, height: 900000 };

test("pay tx: outputs, change, fee, signs", async () => {
  const { wif, address } = createKey();
  const built = buildTx({
    wif,
    utxos: [FAKE_UTXO],
    payments: [
      { address: "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4", sats: 400000 },
      { address, sats: 80000 },
    ],
    opReturn: ["POCKETPETS-ENTRY", "pet1"],
    changeAddress: address,
  });
  const { hex, txid } = await (async () => {
    await built.tx.sign();
    return { hex: built.tx.toHex(), txid: built.tx.id("hex") };
  })();
  assert.match(txid, /^[0-9a-f]{64}$/);
  const back = Transaction.fromHex(hex);
  assert.equal(back.outputs.length, 4); // 2 pay + opreturn + change
  const totalOut = back.outputs.reduce((a, o) => a + (o.satoshis ?? 0), 0);
  assert.equal(totalOut + built.fee, 1_000_000);
  assert.ok(built.fee >= 20 && built.fee < 5000, `fee sane: ${built.fee}`);
});

test("miner fee clears 1 sat/vB relay minimum on real serialized size", async () => {
  const { wif, address } = createKey();
  const { buildTx, signTx } = await import("../src/embedded.ts");
  const built = buildTx({
    wif,
    utxos: [{ txid: "b".repeat(64), vout: 1, value: 2_000_000, height: 900001 }],
    payments: [{ address: "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4", sats: 400000 }],
    opReturn: ["POCKETPETS-PULL", "somepetuid"],
    changeAddress: address,
  });
  const { hex } = await signTx(built.tx);
  const vbytes = hex.length / 2;
  assert.ok(
    built.fee >= vbytes,
    `fee ${built.fee} must cover ${Math.ceil(vbytes)} vB at 1 sat/vB (was 0.01 sat/vB before fix)`
  );
});

test("mint tx puts inscription at vout 0", async () => {
  const { wif, address } = createKey();
  const insc = inscriptionScript(address, "image/jpeg", new TextEncoder().encode("x".repeat(1000)));
  const built = buildTx({
    wif,
    utxos: [{ ...FAKE_UTXO, value: 5_000_000 }],
    payments: [{ address, sats: 4_000_000 }],
    opReturn: ["POCKETPETS-MINT", "uid1"],
    inscription: { scriptHex: insc.toHex() },
    changeAddress: address,
  });
  await built.tx.sign();
  const back = Transaction.fromHex(built.tx.toHex());
  assert.equal(back.outputs[0]?.satoshis, 1);
  assert.equal(back.outputs[0]?.lockingScript?.toHex(), insc.toHex());
});
