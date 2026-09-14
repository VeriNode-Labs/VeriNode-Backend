import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createDb } from "../src/db/schema.js";
import { createApp } from "../src/api/routes.js";

function testApp() {
  const db = createDb(":memory:");
  const app = createApp(db);
  return { db, app };
}

test("GET /health reports ok", async () => {
  const { app } = testApp();
  const res = await request(app).get("/health").expect(200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.service, "lumina-backend");
});

test("POST /api/creators/profile stores sanitized skills and returns a blind id", async () => {
  const { app, db } = testApp();
  const res = await request(app)
    .post("/api/creators/profile")
    .send({
      address: "CBDBGVT7VFFWZYJSP5GZYVXGYVBOZ4UTUUVK6Z3Y2H2B56T4DV3N3T3T3",
      name: "Ada Lovelace",
      location: "London, UK",
      university: "harvard",
      pronoun: "she/her",
      verified_skills: ["rust", "soroban", "stellar", "solidity"],
      completion_ratio: 0.8,
      merit_score: 140,
    })
    .expect(200);

  assert.equal(res.body.ok, true);
  const stored = res.body.stored;
  assert.match(stored.id, /^[0-9a-f]{16}$/);
  assert.equal(stored.completion_ratio, 0.8);
  assert.deepEqual(stored.verified_skills, ["rust", "soroban", "stellar", "solidity"]);

  const row = db.getCreator("CBDBGVT7VFFWZYJSP5GZYVXGYVBOZ4UTUUVK6Z3Y2H2B56T4DV3N3T3T3");
  assert.ok(row);
  assert.equal(row.verified_skills, "rust,soroban,stellar,solidity");
  const serialized = JSON.stringify(stored);
  assert.equal(/london|harvard|lovelace|she/i.test(serialized), false);
});

test("GET /api/creators/blind-pool never exposes addresses or demographics", async () => {
  const { app, db } = testApp();
  db.upsertCreator({ address: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB", verifiedSkills: "rust,soroban" });
  db.upsertCreator({ address: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", verifiedSkills: "python,fastapi" });

  const res = await request(app).get("/api/creators/blind-pool").expect(200);
  assert.equal(res.body.pool.length, 2);
  const serialized = JSON.stringify(res.body.pool);
  assert.equal(/BBAAAAAAAA|BBBBBBBB/.test(serialized), false);
  for (const p of res.body.pool) {
    assert.match(p.id, /^[0-9a-f]{16}$/);
    assert.equal(p.address, undefined);
    assert.equal(p.name, undefined);
  }
});

test("GET /api/assets returns cached on-chain assets", async () => {
  const { app, db } = testApp();
  db.insertAsset({
    onchain_id: "42",
    creator: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
    fingerprint: "0a0b0c0d",
    metadata_uri: "ipfs://QmX",
    licensing_fee: "1000",
    registered_at: 1900000000,
  });
  const res = await request(app).get("/api/assets").expect(200);
  assert.equal(res.body.assets.length, 1);
  assert.equal(res.body.assets[0].fingerprint, "0a0b0c0d");
  assert.equal(res.body.assets[0].onchain_id, "42");
});

test("POST /api/match ranks by skills only, ignoring demographic signals", async () => {
  const { app, db } = testApp();
  db.upsertCreator({ address: "ADDR-A-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", verifiedSkills: "rust,soroban" });
  db.upsertCreator({ address: "ADDR-B-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", verifiedSkills: "rust,soroban" });
  db.upsertCreator({ address: "ADDR-C-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", verifiedSkills: "python,django" });

  const res = await request(app)
    .post("/api/match")
    .send({ skills: ["rust", "soroban", "stellar"] })
    .expect(200);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.matches.length, 2);
  const [top] = res.body.matches;
  assert.deepEqual(top.overlap.sort(), ["rust", "soroban"].sort());
  assert.ok(top.score > 0);

  const withFluff = await request(app)
    .post("/api/creators/profile")
    .send({
      address: "ADDR-D-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      name: "Grace Hopper",
      gender: "female",
      age: 60,
      location: "New York",
      verified_skills: ["rust", "soroban", "stellar", "solidity"],
    })
    .expect(200);

  assert.equal(withFluff.body.ok, true);

  const { db: db2, app: app2 } = testApp();
  db2.upsertCreator({ address: "ADDR-E-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", verifiedSkills: "rust,soroban,stellar,solidity" });
  const res2 = await request(app2)
    .post("/api/match")
    .send({ skills: ["rust", "soroban"] })
    .expect(200);
  assert.equal(res2.body.matches[0].overlap.length, 2);
  assert.equal(res2.body.matches[0].score, 0.707);
});

test("unknown route returns 404 json", async () => {
  const { app } = testApp();
  const res = await request(app).get("/nope").expect(404);
  assert.equal(res.body.ok, false);
});