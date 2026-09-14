export const ALLOWED_PROFILE_FIELDS = Object.freeze([
  "id",
  "merit_score",
  "verified_skills",
  "deliverable_metrics",
  "completion_ratio",
  "escrows_completed",
]);

export const DEMOGRAPHIC_FIELDS = Object.freeze([
  "name", "email", "phone", "telephone", "whatsapp", "telegram", "location", "city", "country",
  "nationality", "ethnicity", "gender", "age", "dob", "birth_year", "photo", "avatar", "picture",
  "institution", "university", "school", "employer", "company", "organization", "title", "headline",
  "bio", "about", "linkedin", "twitter", "github_handle", "resume", "website", "portfolio",
]);

export const GEO_MARKERS = Object.freeze([
  "nairobi", "lagos", "accra", "abuja", "ibadan", "benin city", "kampala", "kigali", "dakar",
  "johannesburg", "cape town", "new york", "san francisco", "london", "berlin", "toronto",
  "los angeles", "warsaw", "gdansk", "mumbai", "bangalore", "ghana", "nigeria", "kenya",
  "uganda", "rwanda", "senegal", "south africa", "usa", "uk", "europe", "asia", "africa",
  "canada", "brazil", "india", "china", "germany", "france", "ethiopia", "cairo", "casablanca",
  "rabat", "tunis", "addis ababa", "lisbon", "porto", "zurich", "amsterdam", "paris", "barcelona",
  "madrid", "milan", "rome", "dubai", "abu dhabi", "algiers",
]);

export const PRESTIGE_TAGS = Object.freeze([
  "mit", "harvard", "stanford", "oxford", "cambridge", "yale", "princeton", "cmu", "berkeley",
  "eth zürich", "eth zurich", "google", "microsoft", "amazon", "apple", "meta", "facebook",
  "ibm", "goldman", "mckinsey", "bain", "y combinator", "ycombinator", "faang", "spacex",
  "tesla", "openai", "stripe",
]);

const PRONOUN_RE = /(^|\W)(he|him|his|she|her|hers|they|them|their|theirs|it|its|himself|herself|themself|themselves|xe|xem|xyr|ze|zir)(\W|$)/gi;

export const TECHNICAL_LEXICON = Object.freeze([
  "rust", "crates", "smart contracts", "smart-contract", "soroban", "stellar", "dapps",
  "blockchain", "web3", "onchain", "solidity", "ether", "evm", "defi", "nft", "tokenomics",
  "liquidity", "amm", "oracle", "merkle", "zkp", "zero knowledge", "snark", "cryptography",
  "hashing", "signatures", "websockets", "ipfs", "wallets", "ethers", "viem", "hardhat",
  "foundry", "openzeppelin", "truffle", "javascript", "typescript", "node", "node.js", "express",
  "react", "nextjs", "vue", "svelte", "pnpm", "npm", "bun", "deno", "python", "django",
  "fastapi", "flask", "celery", "pandas", "numpy", "scikit", "tensorflow", "pytorch", "rust",
  "go", "golang", "java", "kotlin", "scala", "cpp", "c++", "c", "c#", "dotnet", "php", "laravel",
  "ruby", "rails", "elixir", "golang", "sql", "postgres", "postgresql", "mysql", "sqlite",
  "mongodb", "redis", "dynamodb", "cassandra", "kafka", "graphql", "grpc", "rest", "api",
  "microservices", "docker", "kubernetes", "k8s", "terraform", "ansible", "helm", "nginx", "aws",
  "gcp", "azure", "cloudflare", "vercel", "netlify", "s3", "lambda", "serverless", "linux", "bash",
  "git", "github", "gitlab", "cicd", "ci/cd", "jenkins", "github actions", "testing", "jest",
  "vitest", "pytest", "mocha", "cypress", "playwright", "tdd", "wasm", "webassembly", "assembler",
  "llvm", "compilers", "machine learning", "ml", "ai", "llm", "rag", "vector databases",
  "data engineering", "etl", "data analysis", "powerbi", "tableau", "matplotlib", "d3",
  "frontend", "backend", "fullstack", "devops", "sre", "security", "penetration", "audit",
  "smart contracts", "goverance", "uikit", "storybook", "figma", "design systems", "a11y",
  "accessibility", "performance", "observability", "prometheus", "grafana", "sentry",
  "elasticsearch", "opentelemetry", "zero-downtime", "chaos engineering",
]);

const tokenize = (value) => String(value).toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);

const LEXICON_SET = new Set(TECHNICAL_LEXICON.map((l) => l.toLowerCase()));
const LEXICON_PHRASES = TECHNICAL_LEXICON.map((l) => l.toLowerCase()).filter(
  (term) => term.includes(" ") || term.includes("/") || term.includes("."),
);

export function scrubText(text) {
  if (typeof text !== "string") return "";
  let out = text.replace(PRONOUN_RE, " ");
  for (const marker of [...GEO_MARKERS, ...PRESTIGE_TAGS]) {
    out = out.replace(
      new RegExp(`(^|[^a-z0-9])${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "gi"),
      " ",
    );
  }
  return out.replace(/\s+/g, " ").trim();
}

export function normalizeSkillList(input) {
  if (input == null) return [];
  const items = Array.isArray(input)
    ? input.flatMap((i) => String(i).split(/[,;]/))
    : String(input).split(/[,;]/);
  const seen = new Set();
  const results = [];
  for (const rawItem of items) {
    const item = scrubText(rawItem).toLowerCase();
    if (!item) continue;
    const matched = [];
    if (LEXICON_SET.has(item)) matched.push(item);
    for (const phrase of LEXICON_PHRASES) {
      if (phrase !== item && phrase.length > 2 && item.includes(phrase)) matched.push(phrase);
    }
    for (const token of tokenize(item)) {
      if (LEXICON_SET.has(token) && !matched.includes(token)) matched.push(token);
    }
    for (const term of matched) {
      if (!seen.has(term)) {
        seen.add(term);
        results.push(term);
      }
    }
  }
  const terms = results;
  return terms.filter(
    (term) => !terms.some((other) => other !== term && other.includes(term) && other.length > term.length),
  );
}

export function sanitizeProfile(raw = {}) {
  const out = {
    id: raw.id,
    merit_score: typeof raw.merit_score === "number" && raw.merit_score > 0 ? raw.merit_score : undefined,
    verified_skills: [],
    deliverable_metrics: null,
    completion_ratio: null,
  };

  const skillsInput = raw.verified_skills ?? raw.skills ?? [];
  out.verified_skills = normalizeSkillList(skillsInput);

  if (!Number.isFinite(out.merit_score)) {
    out.merit_score = undefined;
  }

  const metrics = raw.deliverable_metrics ?? raw.metrics ?? undefined;
  if (Array.isArray(metrics)) {
    const numeric = metrics.map((m) => (typeof m === "number" ? m : Number.parseFloat(String(m)))).filter(Number.isFinite);
    out.deliverable_metrics = {
      count: numeric.length,
      total: numeric.reduce((a, b) => a + b, 0),
    };
  } else if (metrics && typeof metrics === "object") {
    const numeric = Object.values(metrics).map((m) => Number.parseFloat(String(m))).filter(Number.isFinite);
    out.deliverable_metrics = {
      count: numeric.length,
      total: numeric.reduce((a, b) => a + b, 0),
    };
  }

  let ratio = raw.completion_ratio;
  if (raw.completed != null && raw.total != null && Number(raw.total) > 0) {
    ratio = Number(raw.completed) / Number(raw.total);
  }
  if (typeof ratio === "string" && ratio.endsWith("%")) {
    ratio = Number.parseFloat(ratio) / 100;
  }
  if (Number.isFinite(ratio)) {
    out.completion_ratio = Math.min(Math.max(Number(ratio), 0), 1);
  }

  if (Number.isInteger(raw.escrows_completed)) {
    out.escrows_completed = raw.escrows_completed;
  }

  return out;
}

export function castBlindProfile(row) {
  return {
    id: row.blind_id ?? row.id,
    merit_score: row.merit_score,
    verified_skills: normalizeSkillList(row.verified_skills ?? []),
    deliverable_metrics: null,
    completion_ratio: row.completion_ratio ?? null,
    escrows_completed: row.total_escrows_completed ?? row.escrows_completed ?? 0,
  };
}

export function matchSkills(requiredSkills, candidateSkills) {
  const req = new Set(normalizeSkillList(requiredSkills));
  const cand = new Set(normalizeSkillList(candidateSkills));
  const overlap = [...req].filter((s) => cand.has(s));
  const union = new Set([...req, ...cand]);
  const jaccard = union.size === 0 ? 0 : overlap.length / union.size;
  const cosine = req.size === 0 || cand.size === 0 ? 0 : overlap.length / Math.sqrt(req.size * cand.size);
  const score = Math.round((Math.max(jaccard, cosine) * 1000)) / 1000;
  return { score, overlap, jaccard, cosine };
}