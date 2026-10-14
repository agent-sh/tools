// A/B harness: compare the SHIPPED chain-order merge vs a PROTOTYPE
// RRF + engine-weight ranking, on real live queries. No shipped code is
// modified — this imports the engines from dist and reimplements both merge
// strategies locally so we can eyeball whether RRF actually reorders better.
//
// Run: node packages/websearch/scripts/ab-rank.mjs [query...]

import {
  createMojeekEngine,
  createMarginaliaEngine,
  createWikipediaEngine,
  normalizeUrlForDedup,
} from "../dist/index.js";

const ENGINES = [
  { name: "mojeek", engine: createMojeekEngine(), class: "general", weight: 1.0 },
  { name: "marginalia", engine: createMarginaliaEngine(), class: "niche", weight: 0.8 },
  { name: "wikipedia", engine: createWikipediaEngine(), class: "vertical", weight: 0.6 },
];

const RRF_K = 10; // small k for short lists (TREC default 60 is for huge lists)
const COUNT = 8;

function mkInput(query) {
  return {
    backendUrl: "",
    query,
    count: COUNT,
    timeRange: "all",
    language: "auto",
    safeSearch: "moderate",
    categories: ["general"],
    timeoutMs: 9000,
    headers: {
      "user-agent": "agent-sh-harness-websearch/0.4.0 (+https://github.com/agent-sh/tools)",
    },
    signal: new AbortController().signal,
    checkHost: async () => {},
  };
}

// Gather each engine's ranked list (independently), tolerating failures.
async function gather(query) {
  const lists = [];
  for (const e of ENGINES) {
    try {
      const r = await e.engine.search(mkInput(query));
      lists.push({ ...e, results: r.results });
    } catch (err) {
      lists.push({ ...e, results: [], error: err.code ?? String(err.message ?? err) });
    }
  }
  return lists;
}

// ---- Strategy A: shipped chain-order merge (general-first, first-seen wins) ----
function chainOrder(lists) {
  const seen = new Set();
  const out = [];
  for (const l of lists) {
    for (const item of l.results) {
      const key = normalizeUrlForDedup(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...item, sources: [l.name] });
      if (out.length >= COUNT) return out;
    }
  }
  return out;
}

// ---- Strategy B: Reciprocal Rank Fusion + engine weights ----
function rrf(lists) {
  // Accumulate per-URL: fused score + which engines (with rank) returned it.
  const byKey = new Map();
  for (const l of lists) {
    l.results.forEach((item, rank) => {
      const key = normalizeUrlForDedup(item.url);
      const contrib = l.weight / (RRF_K + rank);
      const cur = byKey.get(key);
      if (cur) {
        cur.score += contrib;
        cur.sources.push(`${l.name}#${rank + 1}`);
        // keep the first-seen item fields (title/snippet) but prefer a
        // general-engine title if we only had a niche one — minor; skip for A/B
      } else {
        byKey.set(key, {
          item,
          score: contrib,
          sources: [`${l.name}#${rank + 1}`],
        });
      }
    });
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, COUNT)
    .map((e) => ({ ...e.item, sources: e.sources, _score: e.score }));
}

function host(u) {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
}

function printList(title, items, showScore) {
  console.log(`\n  ${title}`);
  items.forEach((it, i) => {
    const score = showScore && it._score !== undefined ? ` [${it._score.toFixed(3)}]` : "";
    const src = it.sources ? ` {${it.sources.join(",")}}` : "";
    console.log(`   ${i + 1}. ${host(it.url)}${score}${src}`);
    console.log(`      ${it.title.slice(0, 64)}`);
  });
}

// Rank-displacement: how much does B reorder A? (sum |posA - posB| over shared urls)
function displacement(a, b) {
  const posB = new Map(b.map((it, i) => [normalizeUrlForDedup(it.url), i]));
  let total = 0;
  let shared = 0;
  a.forEach((it, i) => {
    const k = normalizeUrlForDedup(it.url);
    if (posB.has(k)) {
      total += Math.abs(i - posB.get(k));
      shared += 1;
    }
  });
  return { total, shared, onlyInA: a.length - shared };
}

const queries = process.argv.slice(2);
const DEFAULT_QUERIES = [
  "rust async runtime tokio",
  "kubernetes pod scheduling explained",
  "structural typing typescript",
  "what is reciprocal rank fusion",
  "self hosting email server guide",
];

for (const q of queries.length ? queries : DEFAULT_QUERIES) {
  console.log("\n" + "=".repeat(78));
  console.log(`QUERY: ${JSON.stringify(q)}`);
  const lists = await gather(q);
  for (const l of lists) {
    console.log(
      `  · ${l.name} (${l.class}, w=${l.weight}): ${l.error ? "ERR " + l.error : l.results.length + " results"}`,
    );
  }
  const a = chainOrder(lists);
  const b = rrf(lists);
  printList("A — chain-order (SHIPPED):", a, false);
  printList("B — RRF + weights (PROTOTYPE):", b, true);
  const d = displacement(a, b);
  console.log(
    `\n  Δ reorder: ${d.total} total rank-shift over ${d.shared} shared urls; consensus (multi-engine) in B: ${b.filter((x) => x.sources.length > 1).length}`,
  );
}
