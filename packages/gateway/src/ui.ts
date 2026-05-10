/**
 * ui.ts — Web dashboard for browsing and managing Lore data.
 *
 * Served from the gateway at `/ui/*`. No frontend framework — pure
 * server-rendered HTML with inline CSS. Destructive actions use
 * `<form method="POST">` with PRG (Post-Redirect-Get) pattern.
 */
import {
  data,
  ltm,
  temporal,
  runRecall,
  config,
  projectName,
  ensureProject,
} from "@loreai/core";

// ---------------------------------------------------------------------------
// HTML template helpers
// ---------------------------------------------------------------------------

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "\u2026";
}

const CSS = `
:root {
  --bg: #ffffff; --bg2: #f5f5f5; --bg3: #e8e8e8;
  --fg: #1a1a1a; --fg2: #555; --fg3: #888;
  --accent: #2563eb; --accent-hover: #1d4ed8;
  --danger: #dc2626; --danger-hover: #b91c1c;
  --border: #d4d4d4; --radius: 6px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111; --bg2: #1a1a1a; --bg3: #2a2a2a;
    --fg: #e5e5e5; --fg2: #aaa; --fg3: #777;
    --accent: #60a5fa; --accent-hover: #93bbfd;
    --danger: #f87171; --danger-hover: #fca5a5;
    --border: #333; 
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--font); background: var(--bg); color: var(--fg); line-height: 1.5; }
.container { max-width: 960px; margin: 0 auto; padding: 16px 20px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { margin: 16px 0 8px; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.2em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
nav { padding: 12px 20px; background: var(--bg2); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
nav .brand { font-weight: 700; color: var(--fg); font-size: 1.1em; }
nav a { font-size: 0.9em; }
.stats { display: flex; gap: 24px; flex-wrap: wrap; margin: 12px 0; }
.stat { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; min-width: 120px; }
.stat .label { font-size: 0.8em; color: var(--fg3); text-transform: uppercase; }
.stat .value { font-size: 1.4em; font-weight: 600; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 0.9em; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
th { background: var(--bg2); font-weight: 600; font-size: 0.85em; color: var(--fg2); text-transform: uppercase; }
tr:hover { background: var(--bg2); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75em; font-weight: 600;
  background: var(--bg3); color: var(--fg2); }
.badge-architecture { background: #dbeafe; color: #1e40af; }
.badge-pattern { background: #dcfce7; color: #166534; }
.badge-gotcha { background: #fef3c7; color: #92400e; }
.badge-decision { background: #f3e8ff; color: #6b21a8; }
.badge-preference { background: #fce7f3; color: #9d174d; }
@media (prefers-color-scheme: dark) {
  .badge-architecture { background: #1e3a5f; color: #93c5fd; }
  .badge-pattern { background: #14532d; color: #86efac; }
  .badge-gotcha { background: #451a03; color: #fcd34d; }
  .badge-decision { background: #3b0764; color: #d8b4fe; }
  .badge-preference { background: #500724; color: #f9a8d4; }
}
.btn { display: inline-block; padding: 6px 14px; border-radius: var(--radius); font-size: 0.85em;
  font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: var(--bg2); color: var(--fg); text-decoration: none; }
.btn:hover { background: var(--bg3); text-decoration: none; }
.btn-danger { background: var(--danger); color: white; border-color: var(--danger); }
.btn-danger:hover { background: var(--danger-hover); }
.btn-primary { background: var(--accent); color: white; border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); }
pre { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px; overflow-x: auto; font-family: var(--mono); font-size: 0.85em; white-space: pre-wrap; word-break: break-word; }
.field { margin: 6px 0; }
.field .key { font-weight: 600; color: var(--fg2); min-width: 130px; display: inline-block; }
.card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; margin: 8px 0; }
.card h3 { margin: 0 0 4px; font-size: 1em; }
.card .meta { font-size: 0.8em; color: var(--fg3); }
form.inline { display: inline; }
.search-form { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; align-items: end; }
.search-form input[type="text"] { flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 0.95em; background: var(--bg); color: var(--fg); }
.search-form select { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--fg); font-size: 0.9em; }
.msg { padding: 8px 12px; margin: 4px 0; border-radius: var(--radius); font-size: 0.85em; font-family: var(--mono); }
.msg-user { background: var(--bg2); border-left: 3px solid var(--accent); }
.msg-assistant { background: var(--bg2); border-left: 3px solid #10b981; }
.actions { margin: 16px 0; display: flex; gap: 8px; }
.empty { color: var(--fg3); font-style: italic; padding: 24px 0; text-align: center; }
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Lore</title>
<style>${CSS}</style>
</head>
<body>
<nav>
  <span class="brand">Lore</span>
  <a href="/ui">Dashboard</a>
  <a href="/ui/search">Search</a>
</nav>
<div class="container">
${body}
</div>
</body>
</html>`;
}

function badge(text: string): string {
  const cls = `badge badge-${text.toLowerCase().replace(/[^a-z]/g, "")}`;
  return `<span class="${cls}">${esc(text)}</span>`;
}

function deleteForm(action: string, label: string, confirmMsg: string): string {
  return `<form class="inline" method="POST" action="${esc(action)}" onsubmit="return confirm('${esc(confirmMsg)}')">
    <button type="submit" class="btn btn-danger">${esc(label)}</button>
  </form>`;
}

function breadcrumb(items: Array<{ label: string; href?: string }>): string {
  return `<p style="font-size:0.85em;color:var(--fg3);margin:8px 0;">${items
    .map((item, i) =>
      item.href && i < items.length - 1
        ? `<a href="${esc(item.href)}">${esc(item.label)}</a>`
        : `<span>${esc(item.label)}</span>`,
    )
    .join(" &rsaquo; ")}</p>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function redirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: url },
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function pageDashboard(): string {
  const projects = data.listProjects();
  const stats = data.globalStats();

  let body = `<h1>Dashboard</h1>`;
  body += `<div class="stats">
    <div class="stat"><div class="label">Projects</div><div class="value">${stats.project_count}</div></div>
    <div class="stat"><div class="label">Knowledge</div><div class="value">${stats.knowledge_count}</div></div>
    <div class="stat"><div class="label">Sessions</div><div class="value">${stats.session_count}</div></div>
    <div class="stat"><div class="label">Messages</div><div class="value">${stats.message_count}</div></div>
    <div class="stat"><div class="label">Distillations</div><div class="value">${stats.distillation_count}</div></div>
    <div class="stat"><div class="label">DB Size</div><div class="value">${formatBytes(stats.db_size_bytes)}</div></div>
  </div>`;

  if (!projects.length) {
    body += `<p class="empty">No projects found. Start using Lore with an AI agent to create data.</p>`;
  } else {
    body += `<h2>Projects</h2><table>
      <tr><th>Name</th><th>Path</th><th>Knowledge</th><th>Sessions</th><th>Messages</th><th>Created</th></tr>`;
    for (const p of projects) {
      body += `<tr>
        <td><a href="/ui/projects/${esc(p.id)}">${esc(p.name ?? "(unnamed)")}</a></td>
        <td style="font-family:var(--mono);font-size:0.85em">${esc(truncate(p.path, 50))}</td>
        <td>${p.knowledge_count}</td>
        <td>${p.session_count}</td>
        <td>${p.message_count}</td>
        <td>${timeAgo(p.created_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  return layout("Dashboard", body);
}

function pageProject(projectId: string): string | null {
  const projects = data.listProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;

  const knowledge = ltm.forProject(project.path, false);
  const sessions = data.listSessions(project.path, 100);
  const distillations = data.listDistillations(project.path, { limit: 100 });

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: project.name ?? project.path },
  ]);
  body += `<h1>${esc(project.name ?? "(unnamed)")}</h1>`;
  body += `<p style="font-family:var(--mono);font-size:0.85em;color:var(--fg2)">${esc(project.path)}</p>`;

  // Knowledge section
  body += `<h2>Knowledge (${knowledge.length})</h2>`;
  if (knowledge.length) {
    body += `<table>
      <tr><th>Category</th><th>Title</th><th>Confidence</th><th>Updated</th></tr>`;
    for (const e of knowledge) {
      body += `<tr>
        <td>${badge(e.category)}</td>
        <td><a href="/ui/knowledge/${esc(e.id)}">${esc(truncate(e.title, 60))}</a></td>
        <td>${e.confidence.toFixed(2)}</td>
        <td>${timeAgo(e.updated_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  } else {
    body += `<p class="empty">No knowledge entries.</p>`;
  }

  // Sessions section
  body += `<h2>Sessions (${sessions.length})</h2>`;
  if (sessions.length) {
    body += `<table>
      <tr><th>Session</th><th>Messages</th><th>Distilled</th><th>Distillations</th><th>Last Activity</th></tr>`;
    for (const s of sessions) {
      body += `<tr>
        <td><a href="/ui/sessions/${esc(projectId)}/${esc(s.session_id)}">${esc(s.session_id.slice(0, 12))}</a></td>
        <td>${s.message_count}</td>
        <td>${s.distilled_count}</td>
        <td>${s.distillation_count}</td>
        <td>${timeAgo(s.last_message_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  } else {
    body += `<p class="empty">No sessions.</p>`;
  }

  // Distillations section
  body += `<h2>Distillations (${distillations.length})</h2>`;
  if (distillations.length) {
    body += `<table>
      <tr><th>Session</th><th>Gen</th><th>Tokens</th><th>R_comp</th><th>C_norm</th><th>Created</th></tr>`;
    for (const d of distillations) {
      body += `<tr>
        <td><a href="/ui/distillations/${esc(d.id)}">${esc(d.session_id.slice(0, 12))}</a></td>
        <td>${d.generation}</td>
        <td>${d.token_count}</td>
        <td>${d.r_compression?.toFixed(2) ?? "-"}</td>
        <td>${d.c_norm?.toFixed(2) ?? "-"}</td>
        <td>${timeAgo(d.created_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  } else {
    body += `<p class="empty">No distillations.</p>`;
  }

  // Actions
  body += `<div class="actions">
    ${deleteForm(`/ui/api/clear/project/${esc(projectId)}`, "Clear All Project Data", "This will permanently delete ALL data for this project. Continue?")}
  </div>`;

  return layout(project.name ?? "Project", body);
}

function pageKnowledge(id: string): string | null {
  const entry = ltm.get(id);
  if (!entry) return null;

  const projName = entry.project_id ? projectName(entry.project_id) : null;

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    ...(entry.project_id
      ? [{ label: projName ?? "Project", href: `/ui/projects/${entry.project_id}` }]
      : []),
    { label: "Knowledge" },
  ]);

  body += `<h1>${esc(entry.title)}</h1>`;
  body += `<div class="field"><span class="key">Category:</span> ${badge(entry.category)}</div>`;
  body += `<div class="field"><span class="key">Confidence:</span> ${entry.confidence.toFixed(2)}</div>`;
  body += `<div class="field"><span class="key">ID:</span> <code>${esc(entry.id)}</code></div>`;
  body += `<div class="field"><span class="key">Project ID:</span> ${esc(entry.project_id ?? "(global)")}</div>`;
  body += `<div class="field"><span class="key">Cross-project:</span> ${entry.cross_project ? "Yes" : "No"}</div>`;
  body += `<div class="field"><span class="key">Source session:</span> ${esc(entry.source_session ?? "(none)")}</div>`;
  body += `<div class="field"><span class="key">Created:</span> ${formatDate(entry.created_at)}</div>`;
  body += `<div class="field"><span class="key">Updated:</span> ${formatDate(entry.updated_at)}</div>`;
  if (entry.metadata) {
    body += `<div class="field"><span class="key">Metadata:</span></div><pre>${esc(entry.metadata)}</pre>`;
  }
  body += `<h2>Content</h2><pre>${esc(entry.content)}</pre>`;

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/knowledge/${esc(entry.id)}`, "Delete Entry", "Delete this knowledge entry?")}
  </div>`;

  return layout(entry.title, body);
}

function pageSession(pid: string, sessionId: string): string | null {
  // Find the project path from the project ID
  const projects = data.listProjects();
  const project = projects.find((p) => p.id === pid);
  if (!project) return null;

  const messages = temporal.bySession(project.path, sessionId);
  const dists = data.listDistillations(project.path, { sessionId });

  if (!messages.length && !dists.length) return null;

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: project.name ?? "Project", href: `/ui/projects/${esc(pid)}` },
    { label: `Session ${sessionId.slice(0, 12)}` },
  ]);

  body += `<h1>Session ${esc(sessionId.slice(0, 12))}</h1>`;
  body += `<div class="field"><span class="key">Full ID:</span> <code>${esc(sessionId)}</code></div>`;
  body += `<div class="field"><span class="key">Messages:</span> ${messages.length}</div>`;
  body += `<div class="field"><span class="key">Distillations:</span> ${dists.length}</div>`;
  if (messages.length) {
    body += `<div class="field"><span class="key">Time range:</span> ${formatDate(messages[0].created_at)} &mdash; ${formatDate(messages[messages.length - 1].created_at)}</div>`;
  }

  // Messages
  body += `<h2>Messages (${messages.length})</h2>`;
  for (const msg of messages) {
    const cls = msg.role === "user" ? "msg-user" : "msg-assistant";
    body += `<div class="msg ${cls}">
      <strong>${esc(msg.role)}</strong> <span style="color:var(--fg3);font-size:0.8em">${formatDate(msg.created_at)}</span>
      <br>${esc(truncate(msg.content, 500))}
    </div>`;
  }

  // Distillations
  if (dists.length) {
    body += `<h2>Distillations (${dists.length})</h2>`;
    for (const d of dists) {
      const detail = data.getDistillation(d.id);
      body += `<div class="card">
        <h3><a href="/ui/distillations/${esc(d.id)}">Gen ${d.generation}</a>
          <span style="color:var(--fg3);font-size:0.8em;font-weight:normal">${formatDate(d.created_at)} &middot; ${d.token_count} tokens</span></h3>
        ${detail ? `<pre>${esc(truncate(detail.observations, 400))}</pre>` : ""}
      </div>`;
    }
  }

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/session/${esc(pid)}/${esc(sessionId)}`, "Delete Session", "Delete all messages and distillations for this session?")}
  </div>`;

  return layout(`Session ${sessionId.slice(0, 12)}`, body);
}

function pageDistillation(id: string): string | null {
  const dist = data.getDistillation(id);
  if (!dist) return null;

  const projName = projectName(dist.project_id);

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: projName ?? "Project", href: `/ui/projects/${esc(dist.project_id)}` },
    { label: `Distillation` },
  ]);

  body += `<h1>Distillation</h1>`;
  body += `<div class="field"><span class="key">ID:</span> <code>${esc(dist.id)}</code></div>`;
  body += `<div class="field"><span class="key">Session:</span> <a href="/ui/sessions/${esc(dist.project_id)}/${esc(dist.session_id)}">${esc(dist.session_id.slice(0, 12))}</a></div>`;
  body += `<div class="field"><span class="key">Generation:</span> ${dist.generation}</div>`;
  body += `<div class="field"><span class="key">Tokens:</span> ${dist.token_count}</div>`;
  body += `<div class="field"><span class="key">R_compression:</span> ${dist.r_compression?.toFixed(3) ?? "-"}</div>`;
  body += `<div class="field"><span class="key">C_norm:</span> ${dist.c_norm?.toFixed(3) ?? "-"}</div>`;
  body += `<div class="field"><span class="key">Archived:</span> ${dist.archived ? "Yes" : "No"}</div>`;
  body += `<div class="field"><span class="key">Created:</span> ${formatDate(dist.created_at)}</div>`;
  body += `<div class="field"><span class="key">Source IDs:</span></div><pre>${esc(dist.source_ids)}</pre>`;
  body += `<h2>Observations</h2><pre>${esc(dist.observations)}</pre>`;

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/distillation/${esc(dist.id)}`, "Delete Distillation", "Delete this distillation?")}
  </div>`;

  return layout("Distillation", body);
}

async function pageSearch(url: URL): Promise<string> {
  const query = url.searchParams.get("q") ?? "";
  const projectFilter = url.searchParams.get("project") ?? "";
  const scope = (url.searchParams.get("scope") ?? "all") as "all" | "session" | "project" | "knowledge";

  const projects = data.listProjects();

  let body = `<h1>Search</h1>`;
  body += `<form class="search-form" method="GET" action="/ui/search">
    <input type="text" name="q" placeholder="Search query..." value="${esc(query)}" autofocus>
    <select name="project">
      <option value="">All projects</option>
      ${projects.map((p) => `<option value="${esc(p.path)}"${p.path === projectFilter ? " selected" : ""}>${esc(p.name ?? p.path)}</option>`).join("")}
    </select>
    <select name="scope">
      ${(["all", "project", "knowledge"] as const).map((s) => `<option value="${s}"${s === scope ? " selected" : ""}>${s}</option>`).join("")}
    </select>
    <button type="submit" class="btn btn-primary">Search</button>
  </form>`;

  if (query) {
    const projectPath = projectFilter || projects[0]?.path;
    if (!projectPath) {
      body += `<p class="empty">No projects found. Cannot search without a project context.</p>`;
    } else {
      try {
        const searchConfig = {
          ...config().search,
          recallLimit: 20,
          queryExpansion: false,
        };
        const result = await runRecall({
          query,
          scope,
          projectPath,
          searchConfig,
        });
        body += `<h2>Results</h2>`;
        // The recall result is markdown — render as preformatted text
        // (proper markdown rendering would require a dependency)
        body += `<pre>${esc(result)}</pre>`;
      } catch (err) {
        body += `<p style="color:var(--danger)">Search error: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
      }
    }
  }

  return layout("Search", body);
}

// ---------------------------------------------------------------------------
// Route matching helpers
// ---------------------------------------------------------------------------

type RouteParams = Record<string, string>;

function matchRoute(
  pathname: string,
  pattern: string,
): RouteParams | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (patternParts.length !== pathParts.length) return null;

  const params: RouteParams = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

export async function handleUIRequest(
  req: Request,
  url: URL,
): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // --- GET routes ---
  if (method === "GET") {
    // Dashboard
    if (pathname === "/ui" || pathname === "/ui/") {
      return htmlResponse(pageDashboard());
    }

    // Project detail
    const projectMatch = matchRoute(pathname, "/ui/projects/:id");
    if (projectMatch) {
      const html = pageProject(projectMatch.id);
      return html
        ? htmlResponse(html)
        : htmlResponse(layout("Not Found", `<h1>Project not found</h1>`), 404);
    }

    // Knowledge detail
    const knowledgeMatch = matchRoute(pathname, "/ui/knowledge/:id");
    if (knowledgeMatch) {
      const html = pageKnowledge(knowledgeMatch.id);
      return html
        ? htmlResponse(html)
        : htmlResponse(layout("Not Found", `<h1>Knowledge entry not found</h1>`), 404);
    }

    // Session detail
    const sessionMatch = matchRoute(pathname, "/ui/sessions/:projectId/:sessionId");
    if (sessionMatch) {
      const html = pageSession(sessionMatch.projectId, sessionMatch.sessionId);
      return html
        ? htmlResponse(html)
        : htmlResponse(layout("Not Found", `<h1>Session not found</h1>`), 404);
    }

    // Distillation detail
    const distMatch = matchRoute(pathname, "/ui/distillations/:id");
    if (distMatch) {
      const html = pageDistillation(distMatch.id);
      return html
        ? htmlResponse(html)
        : htmlResponse(layout("Not Found", `<h1>Distillation not found</h1>`), 404);
    }

    // Search
    if (pathname === "/ui/search") {
      return htmlResponse(await pageSearch(url));
    }
  }

  // --- POST routes (mutations) ---
  if (method === "POST") {
    // Delete knowledge
    const delKnowledge = matchRoute(pathname, "/ui/api/delete/knowledge/:id");
    if (delKnowledge) {
      const entry = ltm.get(delKnowledge.id);
      data.deleteKnowledge(delKnowledge.id);
      const projectIdVal = entry?.project_id;
      return redirect(projectIdVal ? `/ui/projects/${projectIdVal}` : "/ui");
    }

    // Delete session
    const delSession = matchRoute(pathname, "/ui/api/delete/session/:projectId/:sessionId");
    if (delSession) {
      const projects = data.listProjects();
      const project = projects.find((p) => p.id === delSession.projectId);
      if (project) {
        data.deleteSession(project.path, delSession.sessionId);
      }
      return redirect(`/ui/projects/${delSession.projectId}`);
    }

    // Delete distillation
    const delDist = matchRoute(pathname, "/ui/api/delete/distillation/:id");
    if (delDist) {
      const dist = data.getDistillation(delDist.id);
      data.deleteDistillation(delDist.id);
      const pid = dist?.project_id;
      return redirect(pid ? `/ui/projects/${pid}` : "/ui");
    }

    // Clear project
    const clearProject = matchRoute(pathname, "/ui/api/clear/project/:id");
    if (clearProject) {
      const projects = data.listProjects();
      const project = projects.find((p) => p.id === clearProject.id);
      if (project) {
        data.clearProject(project.path);
      }
      return redirect("/ui");
    }
  }

  // 404
  return htmlResponse(
    layout("Not Found", `<h1>Page not found</h1><p><a href="/ui">Back to dashboard</a></p>`),
    404,
  );
}
