// Hi-Desert Law — Clio API bridge (MCP server over Streamable HTTP)
//
// Exposes a small set of Clio Manage v4 actions as MCP tools so that
// Claude (running in a headless/scheduled session with no browser or
// desktop app available) can create tasks and look up matters directly,
// without needing Chrome or the Claude desktop app to be open.
//
// This process must run somewhere with real outbound internet access
// (e.g. Render, Fly.io, a small VPS) — it will NOT work inside a
// network-sandboxed Claude session. See README.md for deployment steps.

import express from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const {
  CLIO_CLIENT_ID,
  CLIO_CLIENT_SECRET,
  CLIO_REFRESH_TOKEN,
  BRIDGE_API_KEY,
  CLIO_API_BASE = "https://app.clio.com/api/v4",
  CLIO_OAUTH_TOKEN_URL = "https://app.clio.com/oauth/token",
  PORT = 3000,
} = process.env;

for (const [name, val] of Object.entries({
  CLIO_CLIENT_ID,
  CLIO_CLIENT_SECRET,
  CLIO_REFRESH_TOKEN,
  BRIDGE_API_KEY,
})) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Clio OAuth token management
// ---------------------------------------------------------------------------
// Clio access tokens are short-lived. We keep the current one in memory and
// transparently refresh it (using the long-lived refresh token) whenever it's
// missing or about to expire. Nothing here ever writes the refresh token
// anywhere except into memory for the lifetime of this process.

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0; // epoch ms

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const resp = await fetch(CLIO_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: CLIO_REFRESH_TOKEN,
      client_id: CLIO_CLIENT_ID,
      client_secret: CLIO_CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Clio token refresh failed: ${resp.status} ${resp.statusText} — ${body}`
    );
  }

  const data = await resp.json();
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = now + (data.expires_in ?? 3600) * 1000;
  return cachedAccessToken;
}

async function clioFetch(path, options = {}) {
  const token = await getAccessToken();
  const resp = await fetch(`${CLIO_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(
      `Clio API error: ${resp.status} ${resp.statusText} — ${JSON.stringify(json)}`
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

function buildServer() {
  const server = new McpServer({
    name: "hi-desert-law-clio-bridge",
    version: "0.1.0",
  });

  server.registerTool(
    "clio_search_matters",
    {
      title: "Search Clio matters",
      description:
        "Search Hi-Desert Law's Clio matters by client name, matter description, or display number. Use this to confirm a matter exists and to get its numeric matter ID before creating a task or filing mail against it.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Free-text search — client name, matter description, or display/case number"
          ),
        status: z
          .enum(["open", "pending", "closed", "any"])
          .default("open")
          .describe("Restrict to matters in this status; 'any' for all"),
      },
    },
    async ({ query, status }) => {
      const params = new URLSearchParams({
        query,
        fields: "id,display_number,description,status,client{name}",
      });
      if (status !== "any") params.set("status", status);
      const data = await clioFetch(`/matters.json?${params.toString()}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data.data ?? [], null, 2) }],
      };
    }
  );

  server.registerTool(
    "clio_get_matter",
    {
      title: "Get a Clio matter by ID",
      description:
        "Fetch full details for a single Clio matter given its numeric matter ID.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID"),
      },
    },
    async ({ matterId }) => {
      const data = await clioFetch(
        `/matters/${matterId}.json?fields=id,display_number,description,status,client{name},open_date`
      );
      return { content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_create_task",
    {
      title: "Create a Clio task",
      description:
        "Create a task in Clio Manage against a specific matter, with a priority and an assignee. Use this for actionable case mail that needs follow-up (a deadline, a callback, a filing to prep, etc).",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID to attach the task to"),
        name: z.string().max(255).describe("Short task title"),
        description: z
          .string()
          .optional()
          .describe("Longer description — cite the source email's date/sender and what needs to happen"),
        assigneeId: z
          .number()
          .int()
          .describe(
            "Clio user ID of the assignee — DJ 354525096, Jenn Coffey 357831845, Samantha Mayer 359200225, Tim Curr 358894135, Cynthia Barnette 359244492"
          ),
        priority: z
          .enum(["low", "normal", "high"])
          .default("normal")
          .describe("'high' for deadlines/client-blocking items, otherwise 'normal'"),
        dueAt: z
          .string()
          .optional()
          .describe("Due date in YYYY-MM-DD format, if there's a deadline"),
      },
    },
    async ({ matterId, name, description, assigneeId, priority, dueAt }) => {
      const body = {
        data: {
          name,
          description,
          matter: { id: matterId },
          assignee: { id: assigneeId, type: "User" },
          priority,
          ...(dueAt ? { due_at: dueAt } : {}),
        },
      };
      const data = await clioFetch(`/tasks.json`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_list_tasks",
    {
      title: "List a Clio matter's tasks",
      description:
        "List existing tasks on a matter, optionally filtered by status. Use this BEFORE creating a task to check whether an equivalent one already exists, so automations don't create duplicates.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID"),
        status: z
          .enum(["pending", "in_progress", "in_review", "complete", "draft", "any"])
          .default("any")
          .describe(
            "Restrict to tasks in this Clio status (Clio's real status values, not a generic open/closed split); 'any' for all — 'any' is the safer default for duplicate-checking so an existing task isn't missed just because it's in_progress rather than pending."
          ),
      },
    },
    async ({ matterId, status }) => {
      const params = new URLSearchParams({
        matter_id: String(matterId),
        fields: "id,name,description,status,due_at,priority,assignee{name}",
      });
      if (status !== "any") params.set("status", status);
      const data = await clioFetch(`/tasks.json?${params.toString()}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data.data ?? [], null, 2) }],
      };
    }
  );

  server.registerTool(
    "clio_update_task",
    {
      title: "Update a Clio task",
      description:
        "Update an existing Clio task's name, description, priority, or due date. Use this instead of clio_create_task when clio_list_tasks shows an equivalent task already exists — e.g. to append missing details rather than creating a duplicate.",
      inputSchema: {
        taskId: z.number().int().describe("The Clio task ID to update"),
        name: z.string().max(255).optional().describe("New task title, if it should change"),
        description: z
          .string()
          .optional()
          .describe("New (or appended) description — replaces the existing description"),
        priority: z.enum(["low", "normal", "high"]).optional(),
        dueAt: z.string().optional().describe("New due date in YYYY-MM-DD format"),
      },
    },
    async ({ taskId, name, description, priority, dueAt }) => {
      const data = { id: taskId };
      if (name !== undefined) data.name = name;
      if (description !== undefined) data.description = description;
      if (priority !== undefined) data.priority = priority;
      if (dueAt !== undefined) data.due_at = dueAt;
      const result = await clioFetch(`/tasks/${taskId}.json`, {
        method: "PATCH",
        body: JSON.stringify({ data }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // In-memory cache of Clio's custom field definitions (id, name), refreshed
  // periodically — avoids an extra API round trip on every matter update.
  let customFieldsCache = null;
  let customFieldsCacheAt = 0;

  async function resolveCustomFieldId(fieldName) {
    const now = Date.now();
    if (!customFieldsCache || now - customFieldsCacheAt > 10 * 60_000) {
      const data = await clioFetch(
        `/custom_fields.json?fields=id,name,parent_type&page_size=200`
      );
      customFieldsCache = data.data ?? [];
      customFieldsCacheAt = now;
    }
    const match = customFieldsCache.find(
      (f) =>
        f.parent_type === "Matter" &&
        f.name.trim().toLowerCase() === fieldName.trim().toLowerCase()
    );
    if (!match) {
      throw new Error(
        `No Matter custom field named "${fieldName}" found in Clio. ` +
          `Known Matter custom fields: ${customFieldsCache
            .filter((f) => f.parent_type === "Matter")
            .map((f) => f.name)
            .join(", ")}`
      );
    }
    return match.id;
  }

  server.registerTool(
    "clio_update_matter",
    {
      title: "Update a Clio matter",
      description:
        "Update a matter's description and/or one or more custom field values (e.g. 'Case Number', 'Hearing Date on Petition'). Only supply the fields you want to change — omitted fields are left alone. Custom field names must match Clio's existing field names exactly (case-insensitive).",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID to update"),
        description: z
          .string()
          .optional()
          .describe("New matter description, if it should change"),
        customFields: z
          .array(
            z.object({
              name: z
                .string()
                .describe("Exact name of the Matter custom field, e.g. 'Case Number'"),
              value: z.string().describe("New value for that field"),
            })
          )
          .optional()
          .describe("Custom field values to set"),
      },
    },
    async ({ matterId, description, customFields }) => {
      const data = { id: matterId };
      if (description !== undefined) data.description = description;
      if (customFields?.length) {
        data.custom_field_values = await Promise.all(
          customFields.map(async (cf) => ({
            custom_field: { id: await resolveCustomFieldId(cf.name) },
            value: cf.value,
          }))
        );
      }
      const result = await clioFetch(`/matters/${matterId}.json`, {
        method: "PATCH",
        body: JSON.stringify({ data }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Minimal OAuth 2.1 authorization server (with PKCE + dynamic client
// registration), just enough to satisfy MCP clients (like Cowork) that
// expect a remote HTTP MCP server to have a real "sign-in service" rather
// than a bare static header. There is exactly one real credential that
// matters here — BRIDGE_API_KEY — which is used two ways:
//   1. as the "password" a human must supply once at /oauth/authorize to
//      approve a client, and
//   2. as the HMAC signing secret for the access/refresh tokens we issue,
//      so tokens stay verifiable across server restarts without needing a
//      database (self-contained, JWT-style tokens).
// ---------------------------------------------------------------------------

function baseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function escapeHtml(s = "") {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Short-lived, single-use authorization codes. In-memory is fine — the
// authorize→token round trip happens within seconds, well within any host's
// uptime window.
const pendingCodes = new Map(); // code -> { redirectUri, codeChallenge, codeChallengeMethod, exp }
const registeredClients = new Map(); // client_id -> registration info (informational only)

function signAccessToken() {
  return jwt.sign(
    { sub: "hi-desert-law", type: "access", jti: crypto.randomUUID() },
    BRIDGE_API_KEY,
    { expiresIn: "1h" }
  );
}
function signRefreshToken() {
  return jwt.sign(
    { sub: "hi-desert-law", type: "refresh", jti: crypto.randomUUID() },
    BRIDGE_API_KEY,
    { expiresIn: "180d" }
  );
}
function verifyToken(token, expectedType) {
  const payload = jwt.verify(token, BRIDGE_API_KEY);
  if (payload.type !== expectedType) throw new Error("wrong token type");
  return payload;
}

const app = express();
app.set("trust proxy", true); // Render sits behind a proxy; needed for correct https:// detection
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// --- OAuth discovery -------------------------------------------------------

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["clio"],
  });
});

// --- Dynamic client registration (RFC 7591) --------------------------------
// Accept any registrant — there's only ever one real client in practice
// (Cowork's connector). The actual gate is the access-key prompt at
// /oauth/authorize, not client identity.

app.post("/oauth/register", (req, res) => {
  const clientId = crypto.randomBytes(16).toString("hex");
  const record = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: req.body?.redirect_uris ?? [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: req.body?.client_name,
  };
  registeredClients.set(clientId, record);
  res.status(201).json(record);
});

// --- Authorization endpoint (Authorization Code + PKCE) --------------------

app.get("/oauth/authorize", (req, res) => {
  const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } =
    req.query;

  if (response_type !== "code" || !redirect_uri || !code_challenge) {
    res.status(400).send("Missing or invalid OAuth parameters.");
    return;
  }

  res.type("html").send(`
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Hi-Desert Law — Clio Bridge</title></head>
      <body style="font-family: -apple-system, sans-serif; max-width: 420px; margin: 60px auto;">
        <h2>Connect to the Clio Bridge</h2>
        <p>Enter the Bridge Access Key to approve this connection.</p>
        <form method="POST" action="/oauth/approve">
          <input type="hidden" name="client_id" value="${escapeHtml(client_id ?? "")}">
          <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
          <input type="hidden" name="state" value="${escapeHtml(state ?? "")}">
          <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
          <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method ?? "S256")}">
          <input type="password" name="key" placeholder="Bridge Access Key" autofocus
                 style="width: 100%; padding: 8px; font-size: 14px; margin-bottom: 12px;">
          <button type="submit" style="padding: 8px 16px; font-size: 14px;">Approve</button>
        </form>
      </body>
    </html>
  `);
});

app.post("/oauth/approve", (req, res) => {
  const { key, redirect_uri, state, code_challenge, code_challenge_method } = req.body;

  if (key !== BRIDGE_API_KEY) {
    res.status(401).type("html").send("<p>Incorrect key. Go back and try again.</p>");
    return;
  }

  const code = crypto.randomBytes(24).toString("hex");
  pendingCodes.set(code, {
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method || "S256",
    exp: Date.now() + 5 * 60_000,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
});

// --- Token endpoint ----------------------------------------------------

app.post("/oauth/token", (req, res) => {
  const { grant_type } = req.body;

  if (grant_type === "authorization_code") {
    const { code, code_verifier } = req.body;
    const entry = pendingCodes.get(code);
    if (!entry || entry.exp < Date.now()) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    pendingCodes.delete(code); // single use

    const challenge =
      entry.codeChallengeMethod === "plain"
        ? code_verifier
        : crypto.createHash("sha256").update(code_verifier || "").digest("base64url");

    if (!code_verifier || challenge !== entry.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    res.json({
      access_token: signAccessToken(),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: signRefreshToken(),
    });
    return;
  }

  if (grant_type === "refresh_token") {
    try {
      verifyToken(req.body.refresh_token, "refresh");
    } catch {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    res.json({
      access_token: signAccessToken(),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: signRefreshToken(),
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// --- The actual MCP endpoint ------------------------------------------------

app.post("/mcp", async (req, res) => {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const base = baseUrl(req);

  const authorized =
    token === BRIDGE_API_KEY || // legacy/manual static-key use, still supported
    (() => {
      try {
        verifyToken(token, "access");
        return true;
      } catch {
        return false;
      }
    })();

  if (!authorized) {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
      .json({ error: "unauthorized" });
    return;
  }

  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message: String(err?.message ?? err) });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Clio bridge listening on port ${PORT}`);
});
