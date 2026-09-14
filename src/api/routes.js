import express from "express";
import cors from "cors";
import { blindIdFor } from "../db/schema.js";
import { castBlindProfile, matchSkills, sanitizeProfile, scrubText } from "../ai/bias_sanitizer.js";

export function defaultMerit(row) {
  return typeof row?.merit_score === "number" ? row.merit_score : 100;
}

export function createRouter(db) {
  const router = express.Router();

  router.get("/health", (req, res) => {
    res.json({ status: "ok", service: "lumina-backend", time: new Date().toISOString() });
  });

  router.get("/api/assets", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ ok: true, assets: db.getAssets({ limit, offset }) });
  });

  router.get("/api/creators/blind-pool", (req, res) => {
    const pool = db.listCreators().map((row) => ({
      ...castBlindProfile({ ...row, blind_id: blindIdFor(row.address) }),
      merit_score: defaultMerit(row),
    }));
    res.json({ ok: true, pool });
  });

  router.post("/api/creators/profile", (req, res) => {
    const sanitized = sanitizeProfile(req.body ?? {});
    const address = req.body?.address;
    if (!address) {
      return res.status(400).json({ ok: false, error: "address is required" });
    }
    db.upsertCreator({
      address,
      verifiedSkills: sanitized.verified_skills.join(","),
      completionRatio: sanitized.completion_ratio,
    });
    const row = db.getCreator(address);
    res.json({
      ok: true,
      stored: {
        ...castBlindProfile({ ...row, blind_id: blindIdFor(address) }),
        merit_score: defaultMerit(row),
      },
    });
  });

  router.post("/api/match", (req, res) => {
    const raw = req.body?.skills ?? req.body?.requiredSkills ?? [];
    const query = [].concat(raw).map((s) => scrubText(s)).filter(Boolean).join(",");
    const limit = Math.min(Number(req.body?.limit) || 10, 100);
    const matches = db
      .listCreators()
      .map((row) => {
        const profile = castBlindProfile({ ...row, blind_id: blindIdFor(row.address) });
        const match = matchSkills(query, profile.verified_skills);
        const score = match.score > 0 ? match.score : 0;
        return {
          candidate_id: profile.id,
          score,
          overlap: match.overlap,
          verified_skills: profile.verified_skills,
          completion_ratio: profile.completion_ratio,
          merit_score: defaultMerit(row),
          escrows_completed: profile.escrows_completed,
        };
      })
      .filter((m) => m.score > 0 || query.length === 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.completion_ratio ?? 0) - (a.completion_ratio ?? 0) ||
          b.merit_score - a.merit_score,
      )
      .slice(0, limit);

    res.json({ ok: true, query: { skills: query }, matches });
  });

  return router;
}

export function createApp(db, deps = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(createRouter(db));

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: "not found" });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ ok: false, error: err.message || "internal error" });
  });

  return app;
}