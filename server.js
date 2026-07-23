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
// HTTP layer — stateless Streamable HTTP transport, one MCP server instance
// per request, protected by a static bearer token.
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/mcp", async (req, res) => {
  const auth = req.get("authorization") || "";
  const expected = `Bearer ${BRIDGE_API_KEY}`;
  if (auth !== expected) {
    res.status(401).json({ error: "unauthorized" });
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
