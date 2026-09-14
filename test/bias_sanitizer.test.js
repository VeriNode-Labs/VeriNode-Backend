import test from "node:test";
import assert from "node:assert/strict";

import {
  castBlindProfile,
  matchSkills,
  normalizeSkillList,
  sanitizeProfile,
  scrubText,
} from "../src/ai/bias_sanitizer.js";

test("sanitizeProfile drops demographic fields and keeps skills/metrics", () => {
  const out = sanitizeProfile({
    id: "abc123",
    name: "Omar Al-Sayed",
    email: "omar@example.com",
    location: "Nairobi, Kenya",
    gender: "male",
    university: "MIT",
    verified_skills: ["smart contracts", "rust", "solidity", "  Docker  ", "cooking"],
    completion_ratio: "78%",
    deliverable_metrics: { rushed: 3, on_time: 7 },
  });

  assert.equal(out.id, "abc123");
  assert.deepEqual(out.verified_skills, ["smart contracts", "rust", "solidity", "docker"]);
  assert.equal(out.completion_ratio, 0.78);
  assert.deepEqual(out.deliverable_metrics, { count: 2, total: 10 });
  assert.equal(out.name, undefined);
  assert.equal(out.location, undefined);
  assert.equal(out.university, undefined);
});

test("sanitizeProfile computes completion ratio from completed/total", () => {
  const out = sanitizeProfile({ id: "x", completed: 3, total: 4 });
  assert.equal(out.completion_ratio, 0.75);
});

test("sanitizeProfile clamps completion ratio and handles empty inputs", () => {
  const over = sanitizeProfile({ id: "x", completion_ratio: 1.7 });
  assert.equal(over.completion_ratio, 1);
  const empty = sanitizeProfile({});
  assert.equal(empty.completion_ratio, null);
  assert.deepEqual(empty.verified_skills, []);
});

test("scrubText strips pronouns, geos, and prestige tags", () => {
  const out = scrubText("He graduated from MIT and lives in London. They are a senior engineer, she said.");
  assert.equal(/he|mit|london|they|she/i.test(out), false);
});

test("normalizeSkillList returns only lexicon terms, deduped", () => {
  assert.deepEqual(normalizeSkillList("rust, Rust, soroban, cooking, solidity"), ["rust", "soroban", "solidity"]);
  assert.deepEqual(normalizeSkillList(["node.js", "node", "sleeping"]), ["node.js"]);
});

test("matchSkills rewards overlap and stays deterministic", () => {
  const exact = matchSkills(["rust", "soroban"], ["rust", "soroban"]);
  assert.equal(exact.score, 1);
  assert.deepEqual([...exact.overlap].sort(), ["rust", "soroban"].sort());

  const partial = matchSkills(["rust", "soroban", "stellar"], ["rust", "python"]);
  assert.equal(partial.overlap.length, 1);
  assert.ok(partial.score > 0 && partial.score < 1);

  const none = matchSkills(["rust"], ["python"]);
  assert.equal(none.score, 0);
  assert.deepEqual(none.overlap, []);

  const empty = matchSkills([], []);
  assert.equal(empty.score, 0);
});

test("matchSkills order is stable across runs", () => {
  const a = matchSkills(["rust", "soroban", "stellar"], ["rust", "soroban"]);
  const b = matchSkills(["rust", "soroban", "stellar"], ["rust", "soroban"]);
  assert.deepEqual(a, b);
});

test("castBlindProfile exposes no address", () => {
  const p = castBlindProfile({ address: "GXYZ", blind_id: "abc", verified_skills: "rust,soroban", completion_ratio: 0.5 });
  assert.equal(p.address, undefined);
  assert.equal(p.id, "abc");
});