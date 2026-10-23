import { getStore } from "@netlify/blobs";
import { scryptSync, randomBytes, timingSafeEqual, createHmac, randomUUID } from "node:crypto";

const TAGS = ["Guide", "API", "Database", "Synopsis", "Notes"];
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (error, s = 400) => json({ error }, s);

const secret = () => {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("AUTH_SECRET is missing. Add it in Netlify > Environment variables (16+ characters).");
  return s;
};
const mac = (b) => createHmac("sha256", secret()).update(b).digest("base64url");
const sign = (p) => { const b = Buffer.from(JSON.stringify(p)).toString("base64url"); return b + "." + mac(b); };
const verify = (t) => {
  try {
    const [b, s] = (t || "").split(".");
    const e = mac(b);
    if (!s || s.length !== e.length || !timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
};
const hash = (pw) => { const salt = randomBytes(16).toString("hex"); return salt + ":" + scryptSync(pw, salt, 64).toString("hex"); };
const same = (pw, h) => { const [salt, k] = h.split(":"); return timingSafeEqual(scryptSync(pw, salt, 64), Buffer.from(k, "hex")); };

const PROMPTS = {
  improve: "You are a technical documentation editor. Improve the clarity, grammar and professional tone of the user's Markdown without changing its meaning. Keep the Markdown structure. Return only the revised Markdown.",
  grammar: "Fix spelling and grammar only. Keep the wording, meaning and Markdown formatting. Return only the corrected Markdown.",
  summarize: "Summarise the user's text as a short Markdown section titled '## Summary' with 3 to 5 bullet points. Return only Markdown.",
  expand: "Expand the user's text with useful detail, examples and clear structure, using Markdown. Keep the same topic. Return only Markdown.",
  outline: "Create a clear documentation outline in Markdown (headings and bullet points) for the user's text or topic. Return only Markdown.",
  generate: "Write a complete, well-structured documentation page in Markdown for the topic the user describes. Use a single H1, H2 sections, lists, and a table or code block where useful. Return only Markdown.",
};

const asText = (d) => (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");

async function gemini(key, model, system, user, signal) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { maxOutputTokens: 4000 } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || String(r.status));
  const t = asText(d);
  if (!t.trim()) throw new Error("Empty reply");
  return t;
}

async function anthropic(key, model, system, user, signal) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || String(r.status));
  const t = (d.content || []).map((c) => c.text || "").join("");
  if (!t.trim()) throw new Error("Empty reply");
  return t;
}

async function openaiStyle(key, base, model, system, user, signal) {
  const r = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || String(r.status));
  const t = d.choices?.[0]?.message?.content || "";
  if (!t.trim()) throw new Error("Empty reply");
  return t;
}

// Own variable names on purpose: Netlify auto-injects placeholder ANTHROPIC_API_KEY / GEMINI_API_KEY values.
function buildChain() {
  const env = process.env, chain = [];
  if (env.AI_API_KEY) {
    const models = [env.AI_MODEL || "gemini-3.8-flash", ...String(env.AI_FALLBACK_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean)];
    for (const m of [...new Set(models)]) chain.push({ name: "gemini:" + m, run: (s, u, sig) => gemini(env.AI_API_KEY, m, s, u, sig) });
  }
  if (env.AI_ANTHROPIC_KEY) {
    const m = env.AI_ANTHROPIC_MODEL || "claude-haiku-5-5";
    chain.push({ name: "anthropic:" + m, run: (s, u, sig) => anthropic(env.AI_ANTHROPIC_KEY, m, s, u, sig) });
  }
  if (env.AI_OPENAI_KEY && env.AI_OPENAI_MODEL) {
    const base = env.AI_OPENAI_BASE_URL || "https://api.openai.com/v1";
    chain.push({ name: "openai-style:" + env.AI_OPENAI_MODEL, run: (s, u, sig) => openaiStyle(env.AI_OPENAI_KEY, base, env.AI_OPENAI_MODEL, s, u, sig) });
  }
  return chain;
}

// Tries each configured service in order; if one is busy or fails, the next one answers.
async function askAI(system, user) {
  const chain = buildChain();
  if (!chain.length) throw new Error("AI_NOT_CONFIGURED");
  const t0 = Date.now();
  let last = "";
  for (const p of chain) {
    const left = 9000 - (Date.now() - t0);
    if (left < 1500) break;
    try {
      return { text: await p.run(system, user, AbortSignal.timeout(left)), by: p.name };
    } catch (e) {
      last = String(e.name === "TimeoutError" ? "timed out" : e.message).slice(0, 200);
    }
  }
  throw new Error("AI_PROVIDER:All configured AI services failed or were busy. Last error: " + (last || "none"));
}

export default async (req) => {
  try {
    const path = new URL(req.url).pathname.replace(/^\/(?:\.netlify\/functions\/)?api\/?/, "").split("/").filter(Boolean);
    const m = req.method;
    const users = getStore("users"), docs = getStore("docs");
    const body = m === "POST" || m === "PUT" ? await req.json().catch(() => ({})) : {};
    const [route, id] = path;

    if (route === "register" && m === "POST") {
      const email = String(body.email || "").trim().toLowerCase(), pw = String(body.password || ""), name = String(body.name || "").trim().slice(0, 60);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email address.");
      if (pw.length < 8) return fail("Password must be at least 8 characters.");
      if (await users.get(email)) return fail("An account with this email already exists. Log in instead.", 409);
      const u = { id: randomUUID(), email, name: name || email.split("@")[0], pw: hash(pw), at: Date.now() };
      await users.setJSON(email, u);
      return json({ token: sign({ id: u.id, exp: Date.now() + 7 * 864e5 }), user: { email, name: u.name } }, 201);
    }

    if (route === "login" && m === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      const u = email && (await users.get(email, { type: "json" }));
      if (!u || !same(String(body.password || ""), u.pw)) return fail("Wrong email or password.", 401);
      return json({ token: sign({ id: u.id, exp: Date.now() + 7 * 864e5 }), user: { email, name: u.name } });
    }

    const auth = verify((req.headers.get("authorization") || "").replace(/^Bearer /, ""));
    if (!auth) return fail("Please log in again.", 401);
    const key = "u-" + auth.id;
    const list = (await docs.get(key, { type: "json" })) || [];

    if (route === "docs" && !id && m === "GET") return json({ docs: list });

    if (route === "docs" && id && m === "PUT") {
      if (!/^[\w-]{1,40}$/.test(id)) return fail("Bad document id.");
      const md = String(body.md ?? "");
      if (md.length > 200000) return fail("Document is too large (200,000 characters max).", 413);
      const d = { id, title: String(body.title || "Untitled document").slice(0, 200), tag: TAGS.includes(body.tag) ? body.tag : "Notes", md, at: Number(body.at) || Date.now() };
      const i = list.findIndex((x) => x.id === id);
      if (i < 0 && list.length >= 200) return fail("Document limit reached (200).", 403);
      i < 0 ? list.unshift(d) : (list[i] = d);
      await docs.setJSON(key, list);
      return json({ doc: d });
    }

    if (route === "docs" && id && m === "DELETE") {
      await docs.setJSON(key, list.filter((x) => x.id !== id));
      return json({ ok: true });
    }

    if (route === "ai" && m === "POST") {
      const task = String(body.task || ""), text = String(body.text || "").slice(0, 12000), extra = String(body.extra || "").slice(0, 500);
      if (!PROMPTS[task]) return fail("Unknown AI action.");
      if (task === "generate" ? !extra.trim() : !text.trim()) return fail("There is no text to work with.");
      const usage = getStore("usage"), uk = auth.id + "-" + new Date().toISOString().slice(0, 10);
      const used = Number(await usage.get(uk)) || 0, LIMIT = Number(process.env.AI_DAILY_LIMIT) || 30;
      if (used >= LIMIT) return fail(`Daily AI limit reached (${LIMIT} requests). Try again tomorrow.`, 429);
      const out = await askAI(PROMPTS[task], task === "generate" ? `Topic and requirements:\n${extra}\n\nExisting text (optional):\n${text}` : text);
      await usage.set(uk, String(used + 1)); // only successful answers count toward the daily limit
      return json({ result: out.text.trim(), remaining: LIMIT - used - 1, by: out.by });
    }

    return fail("Not found.", 404);
  } catch (e) {
    const msg = String(e.message);
    if (msg === "AI_NOT_CONFIGURED") return fail("The AI assistant is not set up yet. Add AI_API_KEY (your Gemini key) in Netlify environment variables.", 503);
    if (msg.startsWith("AI_PROVIDER:")) return fail("The AI service returned an error: " + msg.slice(12), 502);
    return fail(msg.includes("AUTH_SECRET") ? msg : "Server error. Please try again.", 500);
  }
};

export const config = { path: "/api/*" };
