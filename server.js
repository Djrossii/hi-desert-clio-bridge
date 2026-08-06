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
    version: "0.6.0",
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
        `/matters/${matterId}.json?fields=id,display_number,description,status,client{name},open_date,practice_area{name},custom_field_values{id,value,field_name}`
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
        status: z
          .enum(["pending", "in_progress", "in_review", "complete"])
          .optional()
          .describe(
            "New task status — 'complete' marks the task done (v0.5.0; removes the old browser-only limitation on completing tasks)"
          ),
      },
    },
    async ({ taskId, name, description, priority, dueAt, status }) => {
      const data = { id: taskId };
      if (name !== undefined) data.name = name;
      if (description !== undefined) data.description = description;
      if (priority !== undefined) data.priority = priority;
      if (dueAt !== undefined) data.due_at = dueAt;
      if (status !== undefined) data.status = status;
      const result = await clioFetch(`/tasks/${taskId}.json`, {
        method: "PATCH",
        body: JSON.stringify({ data }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_delete_task",
    {
      title: "Delete a Clio task",
      description:
        "Permanently delete a Clio task by ID (v0.5.0). Use for stale tasks per the firm's clio-task-discipline rule — a task whose triggering event has passed or whose condition is cured is verified and DELETED. Verify the task really is stale (clio_list_tasks / matter records) before deleting; deletion is not reversible from the API.",
      inputSchema: {
        taskId: z.number().int().describe("The Clio task ID to delete"),
      },
    },
    async ({ taskId }) => {
      await clioFetch(`/tasks/${taskId}.json`, { method: "DELETE" });
      return {
        content: [{ type: "text", text: JSON.stringify({ deleted: true, taskId }) }],
      };
    }
  );

  // In-memory cache of Clio's custom field definitions (id, name), refreshed
  // periodically — avoids an extra API round trip on every matter update.
  let customFieldsCache = null;
  let customFieldsCacheAt = 0;

  async function resolveCustomField(fieldName) {
    const now = Date.now();
    if (!customFieldsCache || now - customFieldsCacheAt > 10 * 60_000) {
      const data = await clioFetch(
        `/custom_fields.json?fields=id,name,parent_type,field_type&page_size=200`
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
    return match;
  }

  server.registerTool(
    "clio_update_matter",
    {
      title: "Update a Clio matter",
      description:
        "Update a matter's description, status (open/pending/closed — e.g. reopen a closed matter before filing newly arrived documents, per the closed-matter reopen rule), and/or one or more custom field values (e.g. 'Case Number', 'Hearing Date on Petition'). Only supply the fields you want to change — omitted fields are left alone. Custom field names must match Clio's existing field names exactly (case-insensitive). NOTE: Clio hard-limits Text (One-Line) custom fields (e.g. 'Property APN') to 255 characters — the bridge rejects longer values up front with a clear error (v0.6.0) instead of surfacing Clio's raw 422; put overflow detail in a HISTORY note or a Text (Multi-Line) field instead.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID to update"),
        description: z
          .string()
          .optional()
          .describe("New matter description, if it should change"),
        status: z
          .enum(["open", "pending", "closed"])
          .optional()
          .describe(
            "New matter status — use 'open' to reopen a closed matter before filing new documents to it"
          ),
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
    async ({ matterId, description, status, customFields }) => {
      const data = { id: matterId };
      if (description !== undefined) data.description = description;
      if (status !== undefined) data.status = status;
      if (customFields?.length) {
        // v0.5.0 fix for the long-standing 422 on populated fields: Clio
        // requires the EXISTING custom_field_value id when updating a field
        // that already holds a value (omitting it makes Clio try to create a
        // duplicate value → 422). Read the matter's current values first and
        // include the value id where one exists.
        const existing = await clioFetch(
          `/matters/${matterId}.json?fields=custom_field_values{id,value,custom_field}`
        );
        const existingValues = existing.data?.custom_field_values ?? [];
        data.custom_field_values = await Promise.all(
          customFields.map(async (cf) => {
            const field = await resolveCustomField(cf.name);
            // v0.6.0: fail fast, clearly, on Clio's real 255-char ceiling for
            // Text (One-Line) fields — previously this surfaced as a raw 422
            // (hit live on the Property APN field, 8/5/26).
            if (field.field_type === "text_line" && cf.value.length > 255) {
              throw new Error(
                `Value for custom field "${cf.name}" is ${cf.value.length} characters, but Clio ` +
                  `limits Text (One-Line) fields to 255. Nothing was updated. Shorten the value ` +
                  `(e.g. keep a summary here and put the full detail in the matter's HISTORY note ` +
                  `via clio_update_note), or ask DJ to convert the field to Text (Multi-Line).`
              );
            }
            const current = existingValues.find(
              (v) => v.custom_field?.id === field.id
            );
            const entry = {
              custom_field: { id: field.id },
              value: cf.value,
            };
            if (current?.id) entry.id = current.id; // update-in-place, not create
            return entry;
          })
        );
      }
      let result;
      try {
        result = await clioFetch(`/matters/${matterId}.json`, {
          method: "PATCH",
          body: JSON.stringify({ data }),
        });
      } catch (err) {
        // Keep the raw Clio error, but translate the known 422 shapes into
        // something an automation can act on without guesswork.
        if (/\b422\b/.test(String(err?.message)) && customFields?.length) {
          throw new Error(
            `${err.message} — HINT (bridge v0.6.0): a 422 on a custom-field write usually means ` +
              `either (a) a value exceeds the field type's limit (Text One-Line caps at 255 chars), or ` +
              `(b) Clio's picklist/date/format validation rejected the value. No fields were changed.`
          );
        }
        throw err;
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_relate_contact",
    {
      title: "Relate a contact to a matter",
      description:
        "Create a labeled relationship between an existing Clio contact and a matter (v0.5.0 — implements the firm's RELATED CONTACT ON DISCOVERY rule from headless sessions; removes the old Clio-UI-only limitation). The description is the relationship label, e.g. 'Heir', 'Beneficiary', 'Successor Trustee', 'Tenant (Defendant)', 'Opposing counsel — counsel for {party}'. Call clio_list_relationships first to avoid duplicates.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID"),
        contactId: z.number().int().describe("The Clio contact ID (from clio_search_contacts / clio_create_contact)"),
        description: z
          .string()
          .max(255)
          .describe("Relationship label shown on the matter, e.g. 'Heir', 'Tenant (Defendant)', 'Opposing counsel — counsel for John Doe'"),
      },
    },
    async ({ matterId, contactId, description }) => {
      const result = await clioFetch(`/relationships.json`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            description,
            matter: { id: matterId },
            contact: { id: contactId },
          },
        }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_list_relationships",
    {
      title: "List a matter's related contacts",
      description:
        "List the contact relationships (related contacts with labels) on a Clio matter (v0.5.0). Use before clio_relate_contact to avoid duplicate relationships, and for the firm's related-contact sweeps.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID"),
      },
    },
    async ({ matterId }) => {
      const params = new URLSearchParams({
        matter_id: String(matterId),
        fields: "id,description,contact{id,name}",
        page_size: "200",
      });
      const data = await clioFetch(`/relationships.json?${params.toString()}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data.data ?? [], null, 2) }],
      };
    }
  );

  server.registerTool(
    "clio_list_activities",
    {
      title: "List activities (time entries) on a matter",
      description:
        "List the Activities (time entries and expenses) recorded on a Clio matter (v0.5.0). USE THIS FOR DEDUP before clio_create_time_entry when there is any chance the entry already exists — e.g. backlog remediation, retries after errors, or calls another session may have filed. Optionally filter by date.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID"),
        date: z
          .string()
          .optional()
          .describe("Only return activities on this date (YYYY-MM-DD)"),
      },
    },
    async ({ matterId, date }) => {
      const params = new URLSearchParams({
        matter_id: String(matterId),
        fields: "id,type,date,quantity,note,non_billable,user{id,name}",
        page_size: "200",
        order: "date(asc)",
      });
      const data = await clioFetch(`/activities.json?${params.toString()}`);
      let rows = data.data ?? [];
      if (date) rows = rows.filter((a) => a.date === date);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_delete_activity",
    {
      title: "Delete an activity (time entry)",
      description:
        "Permanently delete a Clio Activity (time entry) by ID (v0.5.0). ONLY for removing verified duplicates or erroneous entries created by automation — never delete a human-entered time entry without DJ's instruction. Call clio_list_activities first and verify the exact entry (id, date, note) before deleting.",
      inputSchema: {
        activityId: z.number().int().describe("The Clio activity (time entry) ID to delete"),
      },
    },
    async ({ activityId }) => {
      await clioFetch(`/activities/${activityId}.json`, { method: "DELETE" });
      return {
        content: [
          { type: "text", text: JSON.stringify({ deleted: true, activityId }) },
        ],
      };
    }
  );

  server.registerTool(
    "clio_list_recent_tasks",
    {
      title: "List recent Clio tasks across ALL matters",
      description:
        "List tasks firm-wide (not scoped to one matter), filtered by status and/or how recently they were updated. Built for the completed-task-review automation: fetch tasks with status 'complete' updated since the last run to detect new completions, or status 'pending'/'in_progress' to scan outstanding tasks for 'CLAUDE:' work orders. Returns each task with its matter reference.",
      inputSchema: {
        status: z
          .enum(["pending", "in_progress", "in_review", "complete", "draft", "any"])
          .default("complete")
          .describe("Clio task status to filter by; 'any' for all statuses"),
        updatedSince: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp (e.g. 2026-07-23T08:00:00-07:00) — only return tasks updated at or after this moment. Use the state file's lastRun to fetch only what changed."
          ),
        assigneeId: z
          .number()
          .int()
          .optional()
          .describe("Restrict to tasks assigned to this Clio user ID"),
        nameContains: z
          .string()
          .optional()
          .describe(
            "Only return tasks whose name contains this text (case-insensitive), e.g. 'CLAUDE:' or 'Approve for eFiling'"
          ),
      },
    },
    async ({ status, updatedSince, assigneeId, nameContains }) => {
      const params = new URLSearchParams({
        fields:
          "id,name,description,status,due_at,completed_at,priority,updated_at,matter{id,display_number},assignee{id,name}",
        page_size: "200",
      });
      if (status !== "any") params.set("status", status);
      if (updatedSince) params.set("updated_since", updatedSince);
      if (assigneeId !== undefined) params.set("assignee_id", String(assigneeId));
      const data = await clioFetch(`/tasks.json?${params.toString()}`);
      let tasks = data.data ?? [];
      if (nameContains) {
        const needle = nameContains.toLowerCase();
        tasks = tasks.filter((t) => (t.name ?? "").toLowerCase().includes(needle));
      }
      return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_list_documents",
    {
      title: "List a Clio matter's documents",
      description:
        "List the documents already stored on a matter in Clio Manage, optionally filtered by a case-insensitive filename substring. Use this BEFORE clio_upload_document to check whether the file was already uploaded (possibly by another automation or a human), so duplicates aren't created.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID"),
        nameContains: z
          .string()
          .optional()
          .describe(
            "Only return documents whose filename contains this text (case-insensitive)"
          ),
      },
    },
    async ({ matterId, nameContains }) => {
      const params = new URLSearchParams({
        matter_id: String(matterId),
        fields: "id,name,created_at,latest_document_version{fully_uploaded}",
        page_size: "200",
      });
      const data = await clioFetch(`/documents.json?${params.toString()}`);
      let docs = data.data ?? [];
      if (nameContains) {
        const needle = nameContains.toLowerCase();
        docs = docs.filter((d) => (d.name ?? "").toLowerCase().includes(needle));
      }
      return { content: [{ type: "text", text: JSON.stringify(docs, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_upload_document",
    {
      title: "Upload a document to a Clio matter",
      description:
        "Upload a file into Clio Manage's Documents tab on a specific matter. Provide the file EITHER as contentBase64 (small files only — a few hundred KB) OR as sourceUrl, an https URL this server fetches directly (use this for anything larger, e.g. a pre-authenticated OneDrive/Graph download URL). Call clio_list_documents first to avoid duplicates. Internally this runs Clio's three-step upload: create the document record, PUT the bytes to Clio's presigned bucket URL, then mark the version fully_uploaded.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID to file the document under"),
        fileName: z
          .string()
          .max(255)
          .describe("Filename to store in Clio, including extension, e.g. 'CalVCB Letter (2026-07-08).pdf'"),
        contentBase64: z
          .string()
          .optional()
          .describe("The file's bytes, base64-encoded. Use only for small files; prefer sourceUrl otherwise."),
        sourceUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "An https URL from which this server fetches the file bytes directly (e.g. a time-limited pre-authenticated download URL). Exactly one of contentBase64 / sourceUrl must be provided."
          ),
        receivedAt: z
          .string()
          .optional()
          .describe(
            "Date the document was received, YYYY-MM-DD (or a full ISO-8601 datetime), if known. The bridge converts a bare date to the datetime Clio requires (v0.6.0 — previously a bare date drew a 422 'invalid xmlschema format')."
          ),
        expectedBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "The file's exact size in bytes as measured at the source. STRONGLY RECOMMENDED for contentBase64: large base64 payloads can corrupt in transit through a model context, and a corrupted payload often still decodes — this check rejects the upload BEFORE anything reaches Clio when the decoded size doesn't match."
          ),
      },
    },
    async ({ matterId, fileName, contentBase64, sourceUrl, receivedAt, expectedBytes }) => {
      if (!contentBase64 === !sourceUrl) {
        throw new Error("Provide exactly one of contentBase64 or sourceUrl.");
      }

      // --- obtain the bytes ---------------------------------------------
      let bytes;
      if (contentBase64) {
        bytes = Buffer.from(contentBase64, "base64");
      } else {
        if (!/^https:\/\//i.test(sourceUrl)) {
          throw new Error("sourceUrl must be an https:// URL.");
        }
        const resp = await fetch(sourceUrl, { redirect: "follow" });
        if (!resp.ok) {
          throw new Error(
            `Fetching sourceUrl failed: ${resp.status} ${resp.statusText}`
          );
        }
        bytes = Buffer.from(await resp.arrayBuffer());
      }
      if (!bytes.length) throw new Error("The file is empty — nothing to upload.");
      if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
        throw new Error(
          `Byte-verification failed: decoded ${bytes.length} bytes but expectedBytes is ${expectedBytes}. ` +
            `The payload was corrupted in transit — nothing was uploaded to Clio. Re-send the file.`
        );
      }
      const MAX = 100 * 1024 * 1024;
      if (bytes.length > MAX) {
        throw new Error(`File is ${bytes.length} bytes; the limit is 100 MB.`);
      }

      // --- step 1: create the document record, get the presigned PUT ----
      // Clio's received_at is an xmlschema DATETIME; a bare YYYY-MM-DD draws a
      // 422. Promote bare dates to noon UTC (same calendar date in Pacific).
      const receivedAtIso =
        receivedAt && /^\d{4}-\d{2}-\d{2}$/.test(receivedAt)
          ? `${receivedAt}T12:00:00Z`
          : receivedAt;
      const created = await clioFetch(
        `/documents.json?fields=id,name,latest_document_version{uuid,put_url,put_headers}`,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              name: fileName,
              parent: { id: matterId, type: "Matter" },
              ...(receivedAtIso ? { received_at: receivedAtIso } : {}),
            },
          }),
        }
      );
      const doc = created.data;
      const version = doc?.latest_document_version;
      if (!version?.put_url) {
        throw new Error(
          `Clio did not return a put_url for the new document (got: ${JSON.stringify(created)}). The document record may exist in an un-uploaded state (id ${doc?.id}).`
        );
      }

      // --- step 2: PUT the bytes to Clio's storage bucket ----------------
      const putHeaders = {};
      for (const h of version.put_headers ?? []) putHeaders[h.name] = h.value;
      const putResp = await fetch(version.put_url, {
        method: "PUT",
        headers: putHeaders,
        body: bytes,
      });
      if (!putResp.ok) {
        const body = await putResp.text().catch(() => "");
        throw new Error(
          `Uploading bytes to Clio's storage failed: ${putResp.status} ${putResp.statusText} — ${body.slice(0, 500)}. Document record id ${doc.id} was created but is NOT fully uploaded.`
        );
      }

      // --- step 3: mark the version fully uploaded -----------------------
      const finalized = await clioFetch(
        `/documents/${doc.id}.json?fields=id,name,latest_document_version{fully_uploaded}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            data: { uuid: version.uuid, fully_uploaded: true },
          }),
        }
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                uploaded: true,
                documentId: finalized.data?.id ?? doc.id,
                name: finalized.data?.name ?? fileName,
                bytes: bytes.length,
                fully_uploaded:
                  finalized.data?.latest_document_version?.fully_uploaded ?? null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "clio_get_document_download_url",
    {
      title: "Get a time-limited download URL for a Clio document",
      description:
        "Mint a short-lived, pre-authenticated download URL for a document already stored in Clio Manage, so the bytes can be pulled OUT of Clio (e.g. into the OneDrive matter folder via the Clio Download Bridge Power Automate flow) without any caller needing a Clio credential. This is the reverse of clio_upload_document. Returns the document's name and exact byte size alongside the URL — always pass that byte size to the consumer as expectedBytes so the transfer can be byte-verified. The URL is issued by Clio's storage layer and expires quickly (minutes); fetch it promptly and do not log, email, or persist it. For small files you may instead pass inline:true to get the bytes as base64 directly.",
      inputSchema: {
        documentId: z
          .number()
          .int()
          .describe("The Clio document ID (from clio_list_documents)"),
        inline: z
          .boolean()
          .optional()
          .describe(
            "If true, return the bytes as base64 instead of a URL. ONLY for files under ~35 KB — larger payloads corrupt in transit through a model context. Defaults to false."
          ),
      },
    },
    async ({ documentId, inline = false }) => {
      // --- metadata first: name + exact size, for byte-verification --------
      const meta = await clioFetch(
        `/documents/${documentId}.json?fields=id,name,size,content_type,latest_document_version{fully_uploaded}`
      );
      const doc = meta.data;
      if (!doc) throw new Error(`Clio returned no document for id ${documentId}.`);
      if (doc.latest_document_version?.fully_uploaded === false) {
        throw new Error(
          `Document ${documentId} ("${doc.name}") is not fully uploaded in Clio — refusing to hand out a download URL for a partial file.`
        );
      }

      const token = await getAccessToken();
      const dlPath = `${CLIO_API_BASE}/documents/${documentId}/download`;

      if (inline) {
        const resp = await fetch(dlPath, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "follow",
        });
        if (!resp.ok) {
          throw new Error(
            `Clio download failed: ${resp.status} ${resp.statusText}`
          );
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        const INLINE_MAX = 35 * 1024;
        if (buf.length > INLINE_MAX) {
          throw new Error(
            `Document ${documentId} is ${buf.length} bytes — too large for inline mode (ceiling ${INLINE_MAX}). Call again without inline to get a download URL and use the Clio Download Bridge.`
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  documentId,
                  name: doc.name,
                  bytes: buf.length,
                  mode: "inline",
                  contentBase64: buf.toString("base64"),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // --- redirect: "manual" so we can capture the presigned Location -----
      const resp = await fetch(dlPath, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
      });

      const location = resp.headers.get("location");
      if (!location) {
        throw new Error(
          `Clio did not return a redirect for document ${documentId} (status ${resp.status}). ` +
            `The storage layer may have changed; inline mode still works for small files.`
        );
      }
      if (!/^https:\/\//i.test(location)) {
        throw new Error("Clio returned a non-https download location — refusing to use it.");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                documentId,
                name: doc.name,
                bytes: doc.size ?? null,
                contentType: doc.content_type ?? null,
                mode: "url",
                downloadUrl: location,
                note:
                  "Time-limited presigned URL — fetch promptly, do not log or persist it. Pass `bytes` to the consumer as expectedBytes and byte-verify after transfer.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "clio_create_time_entry",
    {
      title: "Create a Clio time entry",
      description:
        "Create a time entry (Activity of type TimeEntry) on a matter. Firm rule: time is ALWAYS captured on client work including phone calls, but marked non-billable unless the matter is a conservatorship (the firm only bills hourly on conservator cases). Pass hours as a decimal (0.1 = 6 minutes); the bridge converts to seconds for Clio.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID the time was spent on"),
        date: z.string().describe("Date the work was performed, YYYY-MM-DD"),
        hours: z
          .number()
          .positive()
          .max(24)
          .describe("Time spent, in decimal hours (0.1 = 6 min). Round up to the nearest 0.1."),
        description: z
          .string()
          .max(2000)
          .describe(
            "The time entry narrative, e.g. 'Telephone conference with client re trust account security.'"
          ),
        nonBillable: z
          .boolean()
          .default(true)
          .describe(
            "true for flat-fee matters (the default); false ONLY on conservatorship matters, which bill hourly"
          ),
        userId: z
          .number()
          .int()
          .default(354525096)
          .describe(
            "Clio user ID who performed the work — DJ 354525096 (default), Jenn Coffey 357831845, Samantha Mayer 359200225, Tim Curr 358894135, Cynthia Barnette 359244492"
          ),
      },
    },
    async ({ matterId, date, hours, description, nonBillable, userId }) => {
      const body = {
        data: {
          type: "TimeEntry",
          date,
          quantity: Math.round(hours * 3600), // Clio wants seconds
          note: description,
          non_billable: nonBillable,
          matter: { id: matterId },
          user: { id: userId },
        },
      };
      const data = await clioFetch(
        `/activities.json?fields=id,type,date,quantity,note,non_billable,matter{id,display_number},user{id,name}`,
        { method: "POST", body: JSON.stringify(body) }
      );
      return { content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_search_contacts",
    {
      title: "Search Clio contacts",
      description:
        "Search Clio contacts by name, email address, or phone number. Use this to match an inbound caller's number or name to an existing contact BEFORE creating a new one — Clio's query matches phone numbers, so searching the last 10 digits of a caller ID usually finds the person. Returns each contact's phone numbers, emails, and type (Person/Company).",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Free-text search — a name ('Dawn Blevins'), email, or phone number. For phone matching, digits only works best, e.g. '7604031210'."
          ),
        type: z
          .enum(["Person", "Company", "any"])
          .default("any")
          .describe("Restrict to persons or companies; 'any' for both"),
      },
    },
    async ({ query, type }) => {
      const params = new URLSearchParams({
        query,
        fields:
          "id,name,first_name,last_name,type,title,primary_email_address,primary_phone_number,phone_numbers{name,number},email_addresses{name,address},company{id,name}",
        page_size: "50",
      });
      if (type !== "any") params.set("type", type);
      const data = await clioFetch(`/contacts.json?${params.toString()}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data.data ?? [], null, 2) }],
      };
    }
  );

  server.registerTool(
    "clio_create_contact",
    {
      title: "Create a Clio contact",
      description:
        "Create a new contact (Person or Company) in Clio. Firm rule (CHECK ALL SOURCES BEFORE STOPPING): a contact record should carry the fullest information findable — name, title, firm/company, phone, email, and mailing address — looked up from every available source, not just what one email or call provided. Always clio_search_contacts first to avoid duplicates.",
      inputSchema: {
        type: z.enum(["Person", "Company"]).describe("Contact type"),
        name: z
          .string()
          .optional()
          .describe("Company name — required when type is Company"),
        firstName: z.string().optional().describe("First name — required when type is Person"),
        lastName: z.string().optional().describe("Last name — required when type is Person"),
        title: z.string().optional().describe("Job title, e.g. 'Paralegal'"),
        companyId: z
          .number()
          .int()
          .optional()
          .describe("Existing Company contact ID to link this Person to"),
        phone: z
          .string()
          .optional()
          .describe("Primary phone number, e.g. '(760) 403-1210'"),
        email: z.string().optional().describe("Primary email address"),
        street: z.string().optional().describe("Mailing address street"),
        city: z.string().optional(),
        state: z.string().optional().describe("State/province, e.g. 'CA'"),
        postalCode: z.string().optional(),
        country: z.string().optional().describe("Defaults to United States when an address is given"),
      },
    },
    async ({ type, name, firstName, lastName, title, companyId, phone, email, street, city, state, postalCode, country }) => {
      if (type === "Company" && !name) throw new Error("Company contacts require 'name'.");
      if (type === "Person" && !lastName) throw new Error("Person contacts require at least 'lastName'.");
      const data = {
        type,
        ...(type === "Company" ? { name } : { first_name: firstName, last_name: lastName }),
        ...(title ? { title } : {}),
        ...(companyId ? { company: { id: companyId } } : {}),
        ...(phone
          ? { phone_numbers: [{ name: "Work", number: phone, default_number: true }] }
          : {}),
        ...(email
          ? { email_addresses: [{ name: "Work", address: email, default_email: true }] }
          : {}),
        ...(street || city || postalCode
          ? {
              addresses: [
                {
                  name: "Work",
                  street,
                  city,
                  province: state,
                  postal_code: postalCode,
                  country: country || "United States",
                },
              ],
            }
          : {}),
      };
      const result = await clioFetch(
        `/contacts.json?fields=id,name,type,title,primary_phone_number,primary_email_address`,
        { method: "POST", body: JSON.stringify({ data }) }
      );
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_update_contact",
    {
      title: "Update a Clio contact",
      description:
        "Update an existing contact — add or correct title, company link, phone, email, or mailing address (e.g. curing a thin record per the CHECK-ALL-SOURCES rule). Only supplied fields change. NOTE: supplying phone/email/address REPLACES that list on the contact.",
      inputSchema: {
        contactId: z.number().int().describe("The Clio contact ID to update"),
        title: z.string().optional(),
        companyId: z.number().int().optional().describe("Company contact ID to link (Persons only)"),
        phone: z.string().optional().describe("New primary phone number"),
        email: z.string().optional().describe("New primary email address"),
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional(),
      },
    },
    async ({ contactId, title, companyId, phone, email, street, city, state, postalCode, country }) => {
      const data = { id: contactId };
      if (title !== undefined) data.title = title;
      if (companyId !== undefined) data.company = { id: companyId };
      if (phone !== undefined)
        data.phone_numbers = [{ name: "Work", number: phone, default_number: true }];
      if (email !== undefined)
        data.email_addresses = [{ name: "Work", address: email, default_email: true }];
      if (street || city || postalCode)
        data.addresses = [
          {
            name: "Work",
            street,
            city,
            province: state,
            postal_code: postalCode,
            country: country || "United States",
          },
        ];
      const result = await clioFetch(
        `/contacts/${contactId}.json?fields=id,name,type,title,primary_phone_number,primary_email_address`,
        { method: "PATCH", body: JSON.stringify({ data }) }
      );
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_log_communication",
    {
      title: "Log a communication (phone call or email) on a Clio matter",
      description:
        "Record a communication in Clio Manage's Communications tab — the proper home for a call log. For an inbound client call: senders = the client contact, receivers = the firm user who took the call. Put the call summary in 'body' (key points, action items); the full transcript belongs in an attached document via clio_upload_document, not here. Pair with clio_create_time_entry so the call's time is captured.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID"),
        type: z
          .enum(["PhoneCommunication", "EmailCommunication"])
          .default("PhoneCommunication")
          .describe("Communication type"),
        subject: z
          .string()
          .max(255)
          .describe("Short subject, e.g. 'TC with client re trust account security'"),
        body: z
          .string()
          .describe("The detailed note — summary, key points, action items, duration"),
        date: z.string().describe("Date of the communication, YYYY-MM-DD"),
        senderContactId: z
          .number()
          .int()
          .optional()
          .describe("Clio CONTACT id of the sender (e.g. the client on an inbound call)"),
        senderUserId: z
          .number()
          .int()
          .optional()
          .describe("Clio USER id of the sender (e.g. the staff member on an outbound call)"),
        receiverContactId: z
          .number()
          .int()
          .optional()
          .describe("Clio CONTACT id of the receiver (e.g. the client on an outbound call)"),
        receiverUserId: z
          .number()
          .int()
          .optional()
          .describe("Clio USER id of the receiver (e.g. the staff member on an inbound call)"),
      },
    },
    async ({ matterId, type, subject, body, date, senderContactId, senderUserId, receiverContactId, receiverUserId }) => {
      const senders = [
        ...(senderContactId ? [{ type: "Contact", id: senderContactId }] : []),
        ...(senderUserId ? [{ type: "User", id: senderUserId }] : []),
      ];
      const receivers = [
        ...(receiverContactId ? [{ type: "Contact", id: receiverContactId }] : []),
        ...(receiverUserId ? [{ type: "User", id: receiverUserId }] : []),
      ];
      if (!senders.length || !receivers.length) {
        throw new Error(
          "A communication needs at least one sender and one receiver (contact and/or user IDs)."
        );
      }
      const data = {
        type,
        subject,
        body,
        date,
        matter: { id: matterId },
        senders,
        receivers,
      };
      const result = await clioFetch(
        `/communications.json?fields=id,type,subject,date,matter{id,display_number}`,
        { method: "POST", body: JSON.stringify({ data }) }
      );
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_delete_document",
    {
      title: "Delete a Clio document (to trash)",
      description:
        "Move a document to Clio's trash — for corrupt uploads and superseded drafts, per the firm's superseded-document deletion rule (the replacement must already be uploaded and verified). NEVER delete filed/court-endorsed documents, signed originals, client-provided source documents, or anything of evidentiary value. Documents in Clio's trash are recoverable by a human for a limited time.",
      inputSchema: {
        documentId: z.number().int().describe("The Clio document ID to move to trash"),
      },
    },
    async ({ documentId }) => {
      await clioFetch(`/documents/${documentId}.json`, { method: "DELETE" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ deleted: true, documentId, note: "Moved to Clio trash." }),
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // Notes (v0.6.0) — the firm's HISTORY / DEFICIENCY LOG note hygiene rules
  // (notification-pause-note-hygiene) live on Clio Notes: ONE running HISTORY
  // note per matter appended with terse dated lines, ONE DEFICIENCY LOG note
  // per matter updated in place. Appending to the existing note is the easy
  // path here by design: clio_list_notes → clio_update_note(appendLine).
  // -------------------------------------------------------------------------

  server.registerTool(
    "clio_list_notes",
    {
      title: "List a Clio matter's notes",
      description:
        "List the notes on a Clio matter, optionally filtered by a case-insensitive subject substring (e.g. 'HISTORY' or 'DEFICIENCY LOG'). ALWAYS call this before clio_create_note — the firm rule is ONE running HISTORY note and ONE DEFICIENCY LOG note per matter, appended/updated in place via clio_update_note, never duplicated. Returns each note's id, subject, full detail, date, and timestamps. An empty result means the matter has no notes matching the filter — not that notes are unavailable.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID"),
        subjectContains: z
          .string()
          .optional()
          .describe(
            "Only return notes whose subject contains this text (case-insensitive), e.g. 'HISTORY'"
          ),
      },
    },
    async ({ matterId, subjectContains }) => {
      // Clio's list-notes call needs type=Matter alongside matter_id — a
      // missing type draws ParameterMissing, which reads like "no notes".
      const params = new URLSearchParams({
        type: "Matter",
        matter_id: String(matterId),
        fields: "id,subject,detail,date,created_at,updated_at",
        limit: "200",
        order: "date(asc)",
      });
      const data = await clioFetch(`/notes.json?${params.toString()}`);
      let notes = data.data ?? [];
      if (subjectContains) {
        const needle = subjectContains.toLowerCase();
        notes = notes.filter((n) => (n.subject ?? "").toLowerCase().includes(needle));
      }
      return { content: [{ type: "text", text: JSON.stringify(notes, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_create_note",
    {
      title: "Create a note on a Clio matter",
      description:
        "Create a new note (type Matter) on a Clio matter. Call clio_list_notes first: if the matter already has a note with this subject (e.g. its running HISTORY note or DEFICIENCY LOG), APPEND to it with clio_update_note instead — the bridge refuses a same-subject duplicate unless allowDuplicateSubject is explicitly true. Returns the created note's id.",
      inputSchema: {
        matterId: z.number().int().describe("The Clio matter ID to attach the note to"),
        subject: z
          .string()
          .max(255)
          .describe("Note subject/title, e.g. 'HISTORY' or 'DEFICIENCY LOG'"),
        detail: z
          .string()
          .describe(
            "The note body. For a new HISTORY note, start with the first terse dated line, e.g. '8/5/26 — …'"
          ),
        date: z
          .string()
          .optional()
          .describe("Note date, YYYY-MM-DD (defaults to today in Clio if omitted)"),
        allowDuplicateSubject: z
          .boolean()
          .optional()
          .describe(
            "Set true ONLY to deliberately create a second note whose subject matches an existing note on the matter. Default false: the bridge blocks the duplicate and tells you to append instead (ONE HISTORY note per matter rule)."
          ),
      },
    },
    async ({ matterId, subject, detail, date, allowDuplicateSubject = false }) => {
      if (!allowDuplicateSubject) {
        const params = new URLSearchParams({
          type: "Matter",
          matter_id: String(matterId),
          fields: "id,subject",
          limit: "200",
        });
        const existing = await clioFetch(`/notes.json?${params.toString()}`);
        const dup = (existing.data ?? []).find(
          (n) => (n.subject ?? "").trim().toLowerCase() === subject.trim().toLowerCase()
        );
        if (dup) {
          throw new Error(
            `Matter ${matterId} already has a note with subject "${dup.subject}" (note id ${dup.id}). ` +
              `Append to it with clio_update_note(noteId: ${dup.id}, appendLine: …) instead — the firm ` +
              `rule is ONE running note per subject. Pass allowDuplicateSubject: true only if a second ` +
              `note with this subject is genuinely intended.`
          );
        }
      }
      const body = {
        data: {
          type: "Matter",
          subject,
          detail,
          matter: { id: matterId },
          ...(date ? { date } : {}),
        },
      };
      const result = await clioFetch(
        `/notes.json?fields=id,subject,date,created_at`,
        { method: "POST", body: JSON.stringify(body) }
      );
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "clio_update_note",
    {
      title: "Update a Clio note (append a line, or replace subject/body)",
      description:
        "Update an existing Clio note. THE COMMON CASE is appendLine: the bridge reads the note's current body and appends your line on a new line at the end — use this to add a terse dated line to a matter's running HISTORY note (read → append → PATCH, atomic from the caller's side). Alternatively pass detail to REPLACE the whole body (for DEFICIENCY LOG in-place rewrites where resolved items are removed) and/or subject to retitle. Provide appendLine OR detail, not both. Returns the updated note with its full new detail so the write can be verified.",
      inputSchema: {
        noteId: z.number().int().describe("The Clio note ID (from clio_list_notes)"),
        appendLine: z
          .string()
          .optional()
          .describe(
            "A line to append to the end of the note's existing body on its own new line, e.g. '8/5/26 — TitlePro247 title work: …'"
          ),
        detail: z
          .string()
          .optional()
          .describe(
            "Full replacement body — REPLACES the note's entire detail. Use for DEFICIENCY LOG in-place updates; prefer appendLine for HISTORY notes."
          ),
        subject: z
          .string()
          .max(255)
          .optional()
          .describe("New subject, if the note should be retitled"),
      },
    },
    async ({ noteId, appendLine, detail, subject }) => {
      if (appendLine !== undefined && detail !== undefined) {
        throw new Error("Provide appendLine OR detail, not both.");
      }
      if (appendLine === undefined && detail === undefined && subject === undefined) {
        throw new Error("Nothing to update — provide appendLine, detail, and/or subject.");
      }
      const data = {};
      if (appendLine !== undefined) {
        const current = await clioFetch(
          `/notes/${noteId}.json?fields=id,subject,detail`
        );
        const existingDetail = current.data?.detail ?? "";
        data.detail = existingDetail
          ? `${existingDetail.replace(/\s+$/, "")}\n${appendLine}`
          : appendLine;
      } else if (detail !== undefined) {
        data.detail = detail;
      }
      if (subject !== undefined) data.subject = subject;
      const result = await clioFetch(
        `/notes/${noteId}.json?fields=id,subject,detail,date,updated_at`,
        { method: "PATCH", body: JSON.stringify({ data }) }
      );
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
// The 40mb limit exists for clio_upload_document's contentBase64 mode — the
// default 100kb JSON body cap would reject any real document.
app.use(express.json({ limit: "40mb" }));
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
