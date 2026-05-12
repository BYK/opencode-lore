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
  searchRecall,
  recallById,
  config,
  projectName,
  ensureProject,
  renderMarkdown,
  type TaggedResult,
} from "@loreai/core";
import {
  computeHistoricalEstimates,
  getSessionCosts,
  getAllSessionCosts,
  totalActualCost,
  totalWorkerCost,
  totalSavings,
  costWithoutLore,
  type SessionCosts,
} from "./cost-tracker";
import { getActiveSessions } from "./pipeline";
import {
  computeWarmingSnapshot,
  getCircuitBreakerStatus,
  getGlobalHistogramsSnapshot,
  HISTOGRAM_BINS,
  BLEND_PSEUDOCOUNT,
  type WarmingSnapshot,
} from "./cache-warmer";
import type { InterTurnHistogram } from "./translate/types";

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

/** Render markdown to HTML, wrapped in a scoped container. */
function md(markdown: string): string {
  return `<div class="md">${renderMarkdown(markdown)}</div>`;
}

/**
 * Truncate text to maxChars, breaking at the last sentence boundary or
 * whitespace before the limit. Appends "..." if truncated.
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  // Try to break at last sentence boundary
  const sentenceEnd = truncated.search(/[.!?]\s[^.!?]*$/);
  if (sentenceEnd > maxChars * 0.5) return truncated.slice(0, sentenceEnd + 1) + " ...";
  // Fall back to last whitespace
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.5) return truncated.slice(0, lastSpace) + " ...";
  return truncated + "...";
}

/** Render truncated markdown to HTML for search results. */
function mdTruncated(markdown: string, maxChars = 500): string {
  return md(truncateText(markdown, maxChars));
}

function formatUSD(amount: number): string {
  if (amount === 0) return "$0.00";
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}K`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function renderCostSummary(sessionId: string): string {
  const costs = getSessionCosts(sessionId);
  if (!costs || costs.conversation.turns === 0) return "";

  const actual = totalActualCost(costs);
  const workerCost = totalWorkerCost(costs);
  const savings = totalSavings(costs);
  const withoutLore = costWithoutLore(costs);

  const totalInput = costs.conversation.inputTokens +
    costs.conversation.cacheReadTokens +
    costs.conversation.cacheWriteTokens;
  const cacheHitRate = totalInput > 0
    ? (costs.conversation.cacheReadTokens / totalInput * 100).toFixed(0)
    : "0";

  const savingsPct = withoutLore > 0
    ? (savings / withoutLore * 100).toFixed(0)
    : "0";

  let html = `<div class="card" style="margin-bottom:1.5em">
    <h2 style="margin-top:0">Cost Intelligence</h2>
    <table class="cost-table">
      <tr class="section-header"><td colspan="2"><strong>Your Spend</strong></td></tr>
      <tr>
        <td>Conversation</td>
        <td>${formatUSD(costs.conversation.cost)}
          <span style="color:var(--fg3);font-size:0.85em">(${formatTokens(totalInput)} in, ${formatTokens(costs.conversation.outputTokens)} out, ${cacheHitRate}% cache hit)</span></td>
      </tr>`;

  if (workerCost > 0) {
    html += `<tr>
        <td>+ Lore overhead</td>
        <td>${formatUSD(workerCost)}`;
    const parts: string[] = [];
    if (costs.workers.distillation.cost > 0) parts.push(`distill: ${formatUSD(costs.workers.distillation.cost)}`);
    if (costs.workers.curation.cost > 0) parts.push(`curate: ${formatUSD(costs.workers.curation.cost)}`);
    if (costs.workers.compaction.cost > 0) parts.push(`compact: ${formatUSD(costs.workers.compaction.cost)}`);
    if (costs.workers.warmup.cost > 0) parts.push(`warmup: ${formatUSD(costs.workers.warmup.cost)}`);
    if (costs.workers.recall.cost > 0) parts.push(`recall: ${formatUSD(costs.workers.recall.cost)}`);
    if (parts.length) html += ` <span style="color:var(--fg3);font-size:0.85em">(${parts.join(", ")})</span>`;
    html += `</td></tr>`;
  }

  html += `<tr style="border-top:1px solid var(--border)">
        <td><strong>Total</strong></td>
        <td><strong>${formatUSD(actual)}</strong></td>
      </tr>`;

  // Counterfactual section
  if (withoutLore > actual) {
    html += `<tr class="section-header"><td colspan="2" style="padding-top:0.8em"><strong>Without Lore (estimated)</strong></td></tr>
      <tr>
        <td>Estimated total</td>
        <td>${formatUSD(withoutLore)}</td>
      </tr>`;
  }

  // Savings breakdown
  const hasSavings = savings > 0;
  if (hasSavings) {
    html += `<tr class="section-header"><td colspan="2" style="padding-top:0.8em"><strong>Savings: ${formatUSD(savings)} (${savingsPct}%)</strong></td></tr>`;
    if (costs.counterfactual.warmupSavings > 0) {
      html += `<tr><td>Cache warming</td><td>${formatUSD(costs.counterfactual.warmupSavings)} <span style="color:var(--fg3);font-size:0.85em">(${costs.counterfactual.warmupHits} hits)</span></td></tr>`;
    }
    if (costs.counterfactual.ttlSavings > 0) {
      html += `<tr><td>1h TTL</td><td>${formatUSD(costs.counterfactual.ttlSavings)} <span style="color:var(--fg3);font-size:0.85em">(${costs.counterfactual.ttlHits} turns with &gt;5m gaps)</span></td></tr>`;
    }
    if (costs.batchSavings > 0) {
      html += `<tr><td>Batch API</td><td>${formatUSD(costs.batchSavings)}</td></tr>`;
    }
    if (costs.counterfactual.avoidedCompactionCost > 0) {
      html += `<tr><td>Avoided compactions</td><td>${formatUSD(costs.counterfactual.avoidedCompactionCost)} <span style="color:var(--fg3);font-size:0.85em">(&times;${costs.counterfactual.avoidedCompactions} compactions)</span></td></tr>`;
    }
  } else if (savings < 0) {
    html += `<tr class="section-header"><td colspan="2" style="padding-top:0.8em;color:#e06c75"><strong>Net overhead: ${formatUSD(-savings)}</strong> (Lore overhead exceeds savings this session)</td></tr>`;
  }

  html += `</table></div>`;
  return html;
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
.result-list { list-style: none; padding: 0; margin: 0; }
.result-item { padding: 8px 12px; margin: 4px 0; background: var(--bg2); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 0.9em; line-height: 1.5; }
.result-item .score { float: right; font-size: 0.75em; color: var(--fg3); opacity: 0.6; font-family: var(--mono); }
.result-item .meta { font-size: 0.8em; color: var(--fg3); }
.result-item .id-link { font-size: 0.75em; color: var(--accent); font-family: var(--mono); opacity: 0.7;
  text-decoration: none; margin-left: 4px; }
.result-item .id-link:hover { opacity: 1; text-decoration: underline; }
.result-summary { font-size: 0.9em; color: var(--fg3); margin: 8px 0; }
.cost-table td { padding: 4px 10px; font-size: 0.9em; }
.cost-table .section-header td { padding-top: 0.6em; }
.actions { margin: 16px 0; display: flex; gap: 8px; }
.empty { color: var(--fg3); font-style: italic; padding: 24px 0; text-align: center; }
.md { font-size: 0.9em; line-height: 1.6; overflow-wrap: break-word; }
.md h1, .md h2, .md h3, .md h4 { margin: 12px 0 6px; font-weight: 600; }
.md h1 { font-size: 1.3em; } .md h2 { font-size: 1.15em; } .md h3 { font-size: 1.05em; }
.md p { margin: 6px 0; }
.md ul, .md ol { margin: 6px 0; padding-left: 24px; }
.md li { margin: 2px 0; }
.md pre { background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px 12px; overflow-x: auto; font-family: var(--mono); font-size: 0.9em; margin: 6px 0; }
.md code { font-family: var(--mono); font-size: 0.9em; background: var(--bg3); padding: 1px 4px; border-radius: 3px; }
.md pre code { background: none; padding: 0; font-size: 1em; }
.md blockquote { border-left: 3px solid var(--border); padding-left: 12px; margin: 6px 0; color: var(--fg2); }
.md a { color: var(--accent); }
.md hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.md table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 0.9em; }
.md th, .md td { text-align: left; padding: 6px 8px; border: 1px solid var(--border); }
.md th { background: var(--bg2); font-weight: 600; }
.md img { max-width: 100%; }
th[data-sort] { cursor: pointer; user-select: none; white-space: nowrap; }
th[data-sort]:hover { color: var(--accent); }
th[data-sort]::after { content: " \\21C5"; font-size: 0.7em; opacity: 0.3; }
th[data-sort].asc::after { content: " \\25B2"; opacity: 0.8; }
th[data-sort].desc::after { content: " \\25BC"; opacity: 0.8; }
.table-filter { margin: 8px 0 4px; display: flex; gap: 8px; align-items: center; }
.table-filter input { padding: 6px 10px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--bg); color: var(--fg);
  font-size: 0.85em; width: 260px; }
.table-filter .count { font-size: 0.8em; color: var(--fg3); }
/* --- Cache warming histogram bars --- */
.histogram { margin: 8px 0; }
.histogram .bin {
  display: flex; align-items: center; gap: 6px;
  font-size: 0.8em; font-family: var(--mono); line-height: 1.8;
}
.histogram .bin-label {
  width: 48px; text-align: right; color: var(--fg3); flex-shrink: 0;
}
.histogram .bin-bars {
  flex: 1; position: relative; height: 14px;
  background: var(--bg3); border-radius: 2px; overflow: hidden;
}
.histogram .bin-bar {
  position: absolute; top: 0; left: 0; height: 100%;
  border-radius: 2px; opacity: 0.7;
}
.histogram .bin-bar.session { background: #60a5fa; z-index: 2; }
.histogram .bin-bar.global  { background: #888; z-index: 1; }
.histogram .bin-bar.blended { background: #34d399; z-index: 3; }
.histogram .bin-pct {
  width: 42px; font-size: 0.75em; color: var(--fg3); flex-shrink: 0;
}
.histogram .bin-ttl-marker {
  color: var(--danger); font-weight: 600; font-size: 0.75em; margin-left: 4px;
}
.histogram-legend {
  display: flex; gap: 16px; font-size: 0.75em; color: var(--fg3); margin: 4px 0 8px;
}
.histogram-legend span::before {
  content: ""; display: inline-block; width: 10px; height: 10px;
  border-radius: 2px; margin-right: 4px; vertical-align: middle;
}
.histogram-legend .leg-session::before { background: #60a5fa; }
.histogram-legend .leg-global::before  { background: #888; }
.histogram-legend .leg-blended::before { background: #34d399; }
/* --- Expandable details --- */
details.warming { margin: 8px 0; }
details.warming summary {
  cursor: pointer; font-weight: 600; font-size: 0.9em;
  color: var(--fg2); padding: 6px 0;
}
details.warming summary:hover { color: var(--accent); }
details.warming[open] summary { margin-bottom: 8px; }
/* --- Circuit breaker bar --- */
.cb-bar {
  display: inline-block; width: 120px; height: 12px;
  background: var(--bg3); border-radius: 6px; overflow: hidden;
  vertical-align: middle; margin: 0 8px;
}
.cb-bar-fill { height: 100%; border-radius: 6px; transition: width 0.3s; }
.cb-ok .cb-bar-fill { background: #34d399; }
.cb-warn .cb-bar-fill { background: #fbbf24; }
.cb-tripped .cb-bar-fill { background: #f87171; }
/* --- Warming status badges --- */
.badge-warming { background: #dcfce7; color: #166534; }
.badge-waiting { background: #dbeafe; color: #1e40af; }
.badge-dead { background: #fef2f2; color: #991b1b; }
.badge-forced { background: #f3e8ff; color: #6b21a8; }
.badge-disabled { background: var(--bg3); color: var(--fg3); }
@media (prefers-color-scheme: dark) {
  .badge-warming { background: #14532d; color: #86efac; }
  .badge-waiting { background: #1e3a5f; color: #93c5fd; }
  .badge-dead { background: #450a0a; color: #fca5a5; }
  .badge-forced { background: #3b0764; color: #d8b4fe; }
  .badge-disabled { background: var(--bg3); color: var(--fg3); }
}
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
  <a href="/ui/knowledge">Knowledge</a>
  <a href="/ui/search">Search</a>
  <a href="/ui/costs">Costs</a>
  <a href="/ui/warming">Warming</a>
</nav>
<div class="container">
${body}
</div>
<script>
document.addEventListener("DOMContentLoaded",function(){
  function parseNum(s){
    s=s.replace(/[$,]/g,"");
    var m=s.match(/([-\\d.]+)\\s*([KMB])?/i);
    if(!m)return 0;
    var n=parseFloat(m[1])||0;
    if(m[2])n*={K:1e3,M:1e6,B:1e9}[m[2].toUpperCase()]||1;
    return n;
  }
  function parseDateVal(s){
    s=s.trim();
    if(s==="just now")return 0;
    var m=s.match(/^(\\d+)([mhd])\\s+ago$/);
    if(m){var n=parseInt(m[1]);return n*({m:1,h:60,d:1440}[m[2]]||1);}
    var ts=Date.parse(s);
    return isNaN(ts)?Infinity:(Date.now()-ts)/60000;
  }
  // Sorting
  document.querySelectorAll("th[data-sort]").forEach(function(th){
    th.addEventListener("click",function(){
      var table=th.closest("table");
      var tbody=table.querySelector("tbody")||table;
      var idx=Array.from(th.parentNode.children).indexOf(th);
      var type=th.dataset.sort;
      var isAsc=th.classList.contains("asc");
      th.parentNode.querySelectorAll("th").forEach(function(h){h.classList.remove("asc","desc");});
      th.classList.add(isAsc?"desc":"asc");
      var rows=Array.from(tbody.querySelectorAll("tr")).filter(function(r){return!r.querySelector("th");});
      rows.sort(function(a,b){
        var aT=(a.children[idx]||{textContent:""}).textContent.trim();
        var bT=(b.children[idx]||{textContent:""}).textContent.trim();
        var cmp=0;
        if(type==="num"){cmp=parseNum(aT)-parseNum(bT);}
        else if(type==="date"){cmp=parseDateVal(aT)-parseDateVal(bT);}
        else{cmp=aT.localeCompare(bT,undefined,{sensitivity:"base"});}
        return isAsc?-cmp:cmp;
      });
      rows.forEach(function(r){tbody.appendChild(r);});
    });
  });
  // Filtering
  document.querySelectorAll(".table-filter input").forEach(function(input){
    var wrapper=input.closest(".table-filter");
    var table=wrapper.nextElementSibling;
    if(!table||table.tagName!=="TABLE")return;
    var countEl=wrapper.querySelector(".count");
    var allRows=Array.from(table.querySelectorAll("tr")).filter(function(r){return!r.querySelector("th");});
    input.addEventListener("input",function(){
      var q=input.value.toLowerCase();
      var shown=0;
      allRows.forEach(function(r){
        var match=!q||r.textContent.toLowerCase().indexOf(q)!==-1;
        r.style.display=match?"":"none";
        if(match)shown++;
      });
      if(countEl)countEl.textContent=q?shown+"/"+allRows.length:"";
    });
  });
});
</script>
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
// Cache warming helpers
// ---------------------------------------------------------------------------

/** Format a duration in ms to a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** Human-readable histogram bin label. */
function binLabel(index: number): string {
  if (index >= HISTOGRAM_BINS.length) return ">4h";
  const ms = HISTOGRAM_BINS[index];
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Return a TTL boundary label if this bin edge is a TTL boundary. */
function ttlMarker(index: number): string | null {
  if (index >= HISTOGRAM_BINS.length) return null;
  const ms = HISTOGRAM_BINS[index];
  if (ms === 300_000) return "5m TTL";
  if (ms === 3_600_000) return "1h TTL";
  return null;
}

/**
 * Render a CSS bar chart for up to 3 overlaid histograms.
 * Bars are scaled relative to the max count across all provided histograms.
 */
function renderHistogram(opts: {
  session?: InterTurnHistogram;
  global?: InterTurnHistogram;
  blended?: InterTurnHistogram;
}): string {
  let maxCount = 1;
  for (const h of [opts.session, opts.global, opts.blended]) {
    if (!h) continue;
    for (const c of h.counts) {
      if (c > maxCount) maxCount = c;
    }
  }

  const binCount = HISTOGRAM_BINS.length + 1;
  let html = `<div class="histogram">`;

  for (let i = 0; i < binCount; i++) {
    const label = binLabel(i);
    const marker = ttlMarker(i);

    const sPct = opts.session ? (opts.session.counts[i] / maxCount) * 100 : 0;
    const gPct = opts.global ? (opts.global.counts[i] / maxCount) * 100 : 0;
    const bPct = opts.blended ? (opts.blended.counts[i] / maxCount) * 100 : 0;

    const displayHist = opts.blended ?? opts.session ?? opts.global;
    const displayPct =
      displayHist && displayHist.total > 0
        ? ((displayHist.counts[i] / displayHist.total) * 100).toFixed(0) + "%"
        : "";

    html += `<div class="bin">`;
    html += `<span class="bin-label">${esc(label)}</span>`;
    html += `<span class="bin-bars">`;
    if (gPct > 0) html += `<span class="bin-bar global" style="width:${gPct.toFixed(1)}%"></span>`;
    if (sPct > 0) html += `<span class="bin-bar session" style="width:${sPct.toFixed(1)}%"></span>`;
    if (bPct > 0) html += `<span class="bin-bar blended" style="width:${bPct.toFixed(1)}%"></span>`;
    html += `</span>`;
    html += `<span class="bin-pct">${displayPct}</span>`;
    if (marker) html += `<span class="bin-ttl-marker">${esc(marker)}</span>`;
    html += `</div>`;
  }

  html += `</div>`;

  // Legend
  const layers: string[] = [];
  if (opts.session) layers.push(`<span class="leg-session">Session (${opts.session.total} obs)</span>`);
  if (opts.global) layers.push(`<span class="leg-global">Global (${opts.global.total} obs)</span>`);
  if (opts.blended) layers.push(`<span class="leg-blended">Blended</span>`);
  if (layers.length > 1) {
    html += `<div class="histogram-legend">${layers.join("")}</div>`;
  }

  return html;
}

/** Render a warming status badge from a snapshot. */
function warmingStatusBadge(snap: WarmingSnapshot): string {
  if (snap.circuitBreaker.tripped)
    return `<span class="badge badge-dead">TRIPPED</span>`;
  if (snap.disabled)
    return `<span class="badge badge-dead">dead</span>`;
  if (snap.forceKeepWarm)
    return `<span class="badge badge-forced">forced</span>`;
  if (snap.shouldWarmNow)
    return `<span class="badge badge-warming">warming</span>`;
  return `<span class="badge badge-waiting">waiting</span>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function pageDashboard(): string {
  const projects = data.listProjects();
  const stats = data.globalStats();

  let body = `<h1>Dashboard</h1>`;
  // Aggregate cost stats across all tracked sessions
  const allCosts = getAllSessionCosts();
  let totalSpend = 0;
  let totalSaved = 0;
  for (const [, c] of allCosts) {
    totalSpend += totalActualCost(c);
    const s = totalSavings(c);
    if (s > 0) totalSaved += s;
  }

  body += `<div class="stats">
    <div class="stat"><div class="label">Projects</div><div class="value">${stats.project_count}</div></div>
    <div class="stat"><div class="label">Knowledge</div><div class="value">${stats.knowledge_count}</div></div>
    <div class="stat"><div class="label">Sessions</div><div class="value">${stats.session_count}</div></div>
    <div class="stat"><div class="label">Messages</div><div class="value">${stats.message_count}</div></div>
    <div class="stat"><div class="label">Distillations</div><div class="value">${stats.distillation_count}</div></div>
    <div class="stat"><div class="label">DB Size</div><div class="value">${formatBytes(stats.db_size_bytes)}</div></div>
    ${allCosts.size > 0 ? `<div class="stat"><div class="label">Session Spend</div><div class="value">${formatUSD(totalSpend)}</div></div>` : ""}
    ${totalSaved > 0 ? `<div class="stat"><div class="label">Est. Saved</div><div class="value" style="color:#10b981">${formatUSD(totalSaved)}</div></div>` : ""}
  </div>`;

  if (!projects.length) {
    body += `<p class="empty">No projects found. Start using Lore with an AI agent to create data.</p>`;
  } else {
    body += `<h2>Projects</h2>
    <div class="table-filter"><input type="text" placeholder="Filter projects\u2026"><span class="count"></span></div>
    <table>
      <tr><th data-sort="text">Name</th><th data-sort="text">Path</th><th data-sort="text">Git Remote</th><th data-sort="num">Knowledge</th><th data-sort="num">Sessions</th><th data-sort="num">Messages</th><th data-sort="date">Created</th></tr>`;
    for (const p of projects) {
      body += `<tr>
        <td><a href="/ui/projects/${esc(p.id)}">${esc(p.name ?? "(unnamed)")}</a></td>
        <td style="font-family:var(--mono);font-size:0.85em">${esc(truncate(p.path, 50))}</td>
        <td style="font-family:var(--mono);font-size:0.85em">${esc(p.git_remote ? truncate(p.git_remote, 40) : "-")}</td>
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
  body += `<form method="POST" action="/ui/api/rename/project/${esc(projectId)}" style="margin:4px 0 12px;display:flex;gap:8px;align-items:center">
    <input type="text" name="name" value="${esc(project.name ?? "")}" placeholder="Project name"
      style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--fg);font-size:0.9em;width:300px">
    <button type="submit" class="btn btn-primary">Rename</button>
  </form>`;
  body += `<p style="font-family:var(--mono);font-size:0.85em;color:var(--fg2)">${esc(project.path)}</p>`;
  if (project.git_remote) {
    body += `<p style="font-family:var(--mono);font-size:0.85em;color:var(--fg2)">Git: ${esc(project.git_remote)}</p>`;
  }

  // Knowledge section
  body += `<h2>Knowledge (${knowledge.length})</h2>`;
  if (knowledge.length) {
    body += `<div class="table-filter"><input type="text" placeholder="Filter knowledge\u2026"><span class="count"></span></div>
    <table>
      <tr><th data-sort="text">Category</th><th data-sort="text">Title</th><th data-sort="num">Confidence</th><th data-sort="date">Updated</th></tr>`;
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
      <tr><th>Session</th><th data-sort="num">Messages</th><th data-sort="num">Distilled</th><th data-sort="num">Distillations</th><th data-sort="date">Last Activity</th></tr>`;
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
      <tr><th>Session</th><th data-sort="num">Gen</th><th data-sort="num">Tokens</th><th data-sort="num">R_comp</th><th data-sort="num">C_norm</th><th data-sort="date">Created</th></tr>`;
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
    ${deleteForm(`/ui/api/clear/project/${esc(projectId)}`, "Clear All Project Data", "This will permanently delete ALL data for this project but keep the project entry. Continue?")}
    ${deleteForm(`/ui/api/delete/project/${esc(projectId)}`, "Delete Project", "This will PERMANENTLY DELETE this project and ALL its data. This cannot be undone. Continue?")}
  </div>`;

  return layout(project.name ?? "Project", body);
}

function pageUserKnowledge(): string {
  const entries = ltm.crossProject();

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Knowledge" },
  ]);
  body += `<h1>User Knowledge (${entries.length})</h1>`;

  if (!entries.length) {
    body += `<p class="empty">No cross-project or global knowledge entries found. These are created automatically when the curator identifies knowledge worth sharing across projects.</p>`;
    return layout("User Knowledge", body);
  }

  // Category breakdown stats
  const cats: Record<string, number> = {};
  for (const e of entries) {
    cats[e.category] = (cats[e.category] || 0) + 1;
  }
  body += `<div class="stats">
    <div class="stat"><div class="label">Total</div><div class="value">${entries.length}</div></div>`;
  for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
    body += `<div class="stat"><div class="label">${esc(cat)}</div><div class="value">${count}</div></div>`;
  }
  body += `</div>`;

  body += `<div class="table-filter"><input type="text" placeholder="Filter knowledge\u2026"><span class="count"></span></div>
  <table>
    <tr><th data-sort="text">Category</th><th data-sort="text">Title</th><th data-sort="text">Source Project</th><th data-sort="num">Confidence</th><th data-sort="date">Updated</th></tr>`;
  for (const e of entries) {
    const projName = e.project_id ? projectName(e.project_id) : null;
    const projDisplay = e.project_id
      ? `<a href="/ui/projects/${esc(e.project_id)}">${esc(projName ?? "(unknown)")}</a>`
      : "(global)";
    body += `<tr>
      <td>${badge(e.category)}</td>
      <td><a href="/ui/knowledge/${esc(e.id)}">${esc(truncate(e.title, 60))}</a></td>
      <td>${projDisplay}</td>
      <td>${e.confidence.toFixed(2)}</td>
      <td>${timeAgo(e.updated_at)}</td>
    </tr>`;
  }
  body += `</table>`;

  return layout("User Knowledge", body);
}

function pageKnowledge(id: string): string | null {
  const entry = ltm.get(id);
  if (!entry) return null;

  const projName = entry.project_id ? projectName(entry.project_id) : null;

  const isCrossOrGlobal = entry.cross_project || !entry.project_id;
  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    ...(isCrossOrGlobal
      ? [{ label: "Knowledge", href: "/ui/knowledge" }]
      : entry.project_id
        ? [{ label: projName ?? "Project", href: `/ui/projects/${entry.project_id}` }]
        : []),
    { label: truncate(entry.title, 40) },
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
  body += `<h2>Content</h2>${md(entry.content)}`;

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/knowledge/${esc(entry.id)}`, "Delete Entry", "Delete this knowledge entry?")}
  </div>`;

  return layout(entry.title, body);
}

/** Render cache warming heuristics section for a live session. */
function renderWarmingSection(sessionId: string): string {
  const sessions = getActiveSessions();
  const state = [...sessions.values()].find((s) => s.sessionID === sessionId);
  if (!state) return ""; // historical session — no live warming data

  const snap = computeWarmingSnapshot(state);
  const hitRate =
    snap.warmupCount > 0
      ? `${snap.warmupHits}/${snap.warmupCount} (${((snap.warmupHits / snap.warmupCount) * 100).toFixed(0)}%)`
      : "0";

  let html = `<h2>Cache Warming</h2>`;

  // Stat cards
  html += `<div class="stats">
    <div class="stat"><div class="label">Status</div><div class="value">${warmingStatusBadge(snap)}</div></div>
    <div class="stat"><div class="label">Warmups</div><div class="value">${snap.warmupCount}</div></div>
    <div class="stat"><div class="label">Hits</div><div class="value">${hitRate}</div></div>
    <div class="stat"><div class="label">P(return)</div><div class="value">${(snap.pReturnDampened * 100).toFixed(1)}%</div></div>
    <div class="stat"><div class="label">S(t)</div><div class="value">${(snap.survivalAtIdle * 100).toFixed(1)}%</div></div>
  </div>`;

  // Expandable decision details
  html += `<details class="warming"><summary>Decision Details</summary>
    <div class="card">
      <div class="field"><span class="key">Idle:</span> ${formatDuration(snap.idleMs)}</div>
      <div class="field"><span class="key">TTL:</span> ${snap.ttl ?? "5m (default)"}</div>
      <div class="field"><span class="key">Turns:</span> ${snap.messageCount}</div>
      <div class="field"><span class="key">Text-only runs:</span> ${snap.consecutiveTextOnlyTurns}</div>
      <div class="field"><span class="key">Threshold:</span> ${(snap.costThreshold * 100).toFixed(1)}%</div>
      <div class="field"><span class="key">P(return) raw:</span> ${(snap.pReturn * 100).toFixed(1)}%</div>
      <div class="field"><span class="key">P(return) dampened:</span> ${(snap.pReturnDampened * 100).toFixed(1)}%</div>
      <div class="field"><span class="key">Session weight:</span> ${snap.sessionWeight.toFixed(2)} (${snap.sessionHistogram.total} obs / ${BLEND_PSEUDOCOUNT} pseudocount)</div>
      ${snap.notWarmingReason ? `<div class="field"><span class="key">Not warming:</span> ${esc(snap.notWarmingReason)}</div>` : ""}
      <div class="field"><span class="key">Circuit breaker:</span> ${snap.circuitBreaker.tripped ? '<span style="color:var(--danger)">TRIPPED</span>' : `OK (${snap.circuitBreaker.failures}/${snap.circuitBreaker.maxFailures})`}</div>
    </div>
  </details>`;

  // Expandable histogram
  html += `<details class="warming"><summary>Survival Histogram</summary>
    ${renderHistogram({
      session: snap.sessionHistogram,
      global: snap.globalHistogram,
      blended: snap.blendedHistogram,
    })}
  </details>`;

  return html;
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

  // Cost intelligence
  body += renderCostSummary(sessionId);

  // Cache warming heuristics (live sessions only)
  body += renderWarmingSection(sessionId);

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
  body += `<h2>Observations</h2>${md(dist.observations)}`;

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/distillation/${esc(dist.id)}`, "Delete Distillation", "Delete this distillation?")}
  </div>`;

  return layout("Distillation", body);
}

/** Format a relative age string from a timestamp. */
function relativeAge(createdAt: number): string {
  const diffMs = Date.now() - createdAt;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Build an ID link for a search result. */
function idLink(prefix: string, id: string): string {
  const short = id.slice(0, 8);
  return `<a href="/ui/search/detail/${esc(prefix)}:${esc(id)}" class="id-link" title="${esc(prefix)}:${esc(id)}">${esc(prefix)}:${esc(short)}</a>`;
}

/** Format a single search result as a compact snippet with ID link. */
function formatSearchResult(tagged: TaggedResult, score?: number): string {
  const scoreStr = score != null
    ? `<span class="score" title="RRF score">${score.toFixed(4)}</span>`
    : "";
  switch (tagged.source) {
    case "knowledge":
    case "cross-knowledge": {
      const k = tagged.item;
      const prefix = tagged.source === "cross-knowledge" ? "xk" : "k";
      const from = tagged.source === "cross-knowledge"
        ? ` <span class="meta">from: ${esc(tagged.projectLabel)}</span>`
        : "";
      return `<li class="result-item">
        ${scoreStr}${badge(k.category)}${from}
        <strong><a href="/ui/knowledge/${esc(k.id)}">${esc(k.title)}</a></strong>:
        ${esc(truncateText(k.content, 200))}
        ${idLink(prefix, k.id)}
      </li>`;
    }
    case "distillation": {
      const d = tagged.item;
      return `<li class="result-item">
        ${scoreStr}${badge("distilled")}
        <span class="meta">gen ${d.generation} &middot; ${relativeAge(d.created_at)}</span>
        ${esc(truncateText(d.observations, 250))}
        ${idLink("d", d.id)}
      </li>`;
    }
    case "temporal": {
      const m = tagged.item;
      return `<li class="result-item">
        ${scoreStr}${badge(m.role)}
        <span class="meta">${relativeAge(m.created_at)} &middot; ${esc(m.session_id.slice(0, 8))}</span>
        ${esc(truncateText(m.content, 200))}
        ${idLink("t", m.id)}
      </li>`;
    }
    case "lat-section": {
      const s = tagged.item;
      return `<li class="result-item">
        ${scoreStr}${badge("lat.md")}
        <strong>${esc(s.file)} &sect; ${esc(s.heading)}</strong>:
        ${esc(truncateText(s.content, 200))}
        ${idLink("lat", s.id)}
      </li>`;
    }
  }
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
        const rawResults = await searchRecall({
          query,
          scope,
          projectPath,
          searchConfig,
        });

        // Apply relevance floor: drop results below 15% of top score.
        const topScore = rawResults[0]?.score ?? 0;
        const floor = topScore * 0.15;
        const results = topScore > 0
          ? rawResults.filter((r) => r.score >= floor)
          : rawResults;

        const displayed = results.slice(0, 30);

        if (!displayed.length) {
          body += `<p class="empty">No results found for this query.</p>`;
        } else {
          const scoreRange = displayed.length > 1
            ? `score: ${displayed[0].score.toFixed(4)}–${displayed[displayed.length - 1].score.toFixed(4)}`
            : "";
          body += `<p class="result-summary">Found ${rawResults.length} results, showing ${displayed.length}${scoreRange ? ` (${scoreRange})` : ""}.</p>`;

          // Group into tiers by relative score (same thresholds as recall)
          const strong = displayed.filter((r) => r.score >= topScore * 0.6);
          const supporting = displayed.filter((r) => r.score >= topScore * 0.3 && r.score < topScore * 0.6);
          const peripheral = displayed.filter((r) => r.score < topScore * 0.3);

          if (strong.length) {
            body += `<h3>Strong Matches</h3><ul class="result-list">`;
            for (const { item: tagged, score } of strong) body += formatSearchResult(tagged, score);
            body += `</ul>`;
          }
          if (supporting.length) {
            body += `<h3>Supporting</h3><ul class="result-list">`;
            for (const { item: tagged, score } of supporting) body += formatSearchResult(tagged, score);
            body += `</ul>`;
          }
          if (peripheral.length) {
            body += `<h3>Peripheral</h3><ul class="result-list">`;
            for (const { item: tagged, score } of peripheral) body += formatSearchResult(tagged, score);
            body += `</ul>`;
          }
        }
      } catch (err) {
        body += `<p style="color:var(--danger)">Search error: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
      }
    }
  }

  return layout("Search", body);
}

/** Detail page for a search result by source-prefixed ID (e.g. k:019e..., d:019e...). */
function pageSearchDetail(fullId: string): string | null {
  const result = recallById(fullId);
  if (result.startsWith("No entry found") || result.startsWith("Unknown source")) {
    return null;
  }

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Search", href: "/ui/search" },
    { label: fullId },
  ]);

  body += `<div class="card">${md(result)}</div>`;

  return layout(`Detail: ${fullId}`, body);
}


// ---------------------------------------------------------------------------
// Cache Warming page
// ---------------------------------------------------------------------------

function pageWarming(): string {
  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Cache Warming" },
  ]);
  body += `<h1>Cache Warming</h1>`;

  const sessions = getActiveSessions();
  const cbStatus = getCircuitBreakerStatus();

  // Collect snapshots for all live sessions
  const snapshots: WarmingSnapshot[] = [];
  for (const [, state] of sessions) {
    snapshots.push(computeWarmingSnapshot(state));
  }

  // Aggregate stats
  const totalWarmups = snapshots.reduce((s, x) => s + x.warmupCount, 0);
  const totalHits = snapshots.reduce((s, x) => s + x.warmupHits, 0);
  const warmingNow = snapshots.filter((x) => x.shouldWarmNow).length;
  const deadCount = snapshots.filter((x) => x.disabled).length;

  // Summary stat cards
  body += `<div class="stats">
    <div class="stat"><div class="label">Live Sessions</div><div class="value">${snapshots.length}</div></div>
    <div class="stat"><div class="label">Warming Now</div><div class="value">${warmingNow}</div></div>
    <div class="stat"><div class="label">Dead</div><div class="value">${deadCount}</div></div>
    <div class="stat"><div class="label">Total Warmups</div><div class="value">${totalWarmups}</div></div>
    <div class="stat"><div class="label">Hit Rate</div><div class="value">${totalWarmups > 0 ? ((totalHits / totalWarmups) * 100).toFixed(0) + "%" : "N/A"}</div></div>
    <div class="stat"><div class="label">Circuit Breaker</div><div class="value">${
      cbStatus.tripped
        ? '<span style="color:var(--danger)">TRIPPED</span>'
        : `OK <span style="color:var(--fg3)">${cbStatus.failures}/${cbStatus.maxFailures}</span>`
    }</div></div>
  </div>`;

  // Circuit breaker detail (if non-zero failures or tripped)
  if (cbStatus.failures > 0 || cbStatus.tripped) {
    const cls = cbStatus.tripped ? "cb-tripped" : cbStatus.failures > 1 ? "cb-warn" : "cb-ok";
    const pct = (cbStatus.failures / cbStatus.maxFailures) * 100;
    body += `<div class="card ${cls}">
      <strong>Circuit Breaker:</strong> ${cbStatus.failures}/${cbStatus.maxFailures} uncached warmups
      <span class="cb-bar"><span class="cb-bar-fill" style="width:${pct}%"></span></span>
      ${cbStatus.tripped ? '<strong style="color:var(--danger)">ALL WARMING DISABLED</strong>' : ""}
    </div>`;
  }

  // Live sessions table
  body += `<h2>Live Sessions</h2>`;
  if (snapshots.length === 0) {
    body += `<p class="empty">No active sessions. Cache warming data appears when sessions are processed through the gateway.</p>`;
  } else {
    body += `<div class="table-filter"><input type="text" placeholder="Filter sessions\u2026"><span class="count"></span></div>
    <table>
      <tr>
        <th>Session</th>
        <th data-sort="num">Turns</th>
        <th data-sort="num">Idle</th>
        <th data-sort="text">TTL</th>
        <th data-sort="num">S(t)</th>
        <th data-sort="num">P(return)</th>
        <th data-sort="text">Status</th>
        <th data-sort="num">Warmups</th>
        <th data-sort="num">Hits</th>
      </tr>`;
    for (const snap of snapshots) {
      body += `<tr>
        <td><code>${esc(snap.sessionId.slice(0, 16))}</code></td>
        <td>${snap.messageCount}</td>
        <td>${formatDuration(snap.idleMs)}</td>
        <td>${snap.ttl ?? "5m"}</td>
        <td>${(snap.survivalAtIdle * 100).toFixed(1)}%</td>
        <td>${(snap.pReturnDampened * 100).toFixed(1)}%</td>
        <td>${warmingStatusBadge(snap)}</td>
        <td>${snap.warmupCount}</td>
        <td>${snap.warmupHits}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  // Global histograms
  const globalHists = getGlobalHistogramsSnapshot();
  if (globalHists.size > 0) {
    body += `<h2>Global Histograms</h2>`;
    body += `<p style="color:var(--fg3);font-size:0.9em">
      Per-project inter-turn gap distributions from all historical sessions.
      Used as Bayesian prior for sessions with few observations.
    </p>`;

    for (const [projectPath, hist] of globalHists) {
      const name = projectPath.split("/").pop() ?? projectPath;
      body += `<details class="warming">
        <summary>${esc(name)} &mdash; ${hist.total} observations</summary>`;
      if (hist.total > 0) {
        body += renderHistogram({ global: hist });
      }
      body += `</details>`;
    }
  }

  return layout("Cache Warming", body);
}

// ---------------------------------------------------------------------------
// Global Costs page
// ---------------------------------------------------------------------------

function pageCosts(): string {
  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Costs" },
  ]);

  body += `<h1>Cost Intelligence</h1>`;

  // --- Live session costs ---
  const allCosts = getAllSessionCosts();
  let liveTotalSpend = 0;
  let liveTotalSavings = 0;
  let liveTotalWithout = 0;
  let liveTotalWorker = 0;
  let liveTotalConversation = 0;
  let liveTotalTurns = 0;
  let liveBatchSavings = 0;
  let liveWarmupSavings = 0;
  let liveTtlSavings = 0;
  let liveAvoidedCompactions = 0;
  let liveAvoidedCompactionCost = 0;

  for (const [, c] of allCosts) {
    liveTotalSpend += totalActualCost(c);
    const s = totalSavings(c);
    liveTotalSavings += s;
    liveTotalWithout += costWithoutLore(c);
    liveTotalWorker += totalWorkerCost(c);
    liveTotalConversation += c.conversation.cost;
    liveTotalTurns += c.conversation.turns;
    liveBatchSavings += c.batchSavings;
    liveWarmupSavings += c.counterfactual.warmupSavings;
    liveTtlSavings += c.counterfactual.ttlSavings;
    liveAvoidedCompactions += c.counterfactual.avoidedCompactions;
    liveAvoidedCompactionCost += c.counterfactual.avoidedCompactionCost;
  }

  // --- Historical (backdated) estimates ---
  const historical = computeHistoricalEstimates();
  const hist = historical.totals;

  // --- Combined totals ---
  // Use totalWorkerCost (persisted real API data where available, heuristic
  // distillation estimate as fallback) instead of distillationCost alone.
  const combinedWorkerCost = liveTotalWorker + hist.totalWorkerCost;
  const combinedAvoidedCompactions = liveAvoidedCompactions + hist.avoidedCompactions;
  const combinedAvoidedCompactionCost = liveAvoidedCompactionCost + hist.avoidedCompactionCost;
  const combinedWarmupSavings = liveWarmupSavings + hist.warmupSavings;
  const combinedTtlSavings = liveTtlSavings + hist.ttlSavings;
  const combinedBatchSavings = liveBatchSavings + hist.batchSavings;
  // Net savings = counterfactual savings - worker overhead
  const combinedNetSavings =
    combinedWarmupSavings + combinedTtlSavings + combinedBatchSavings +
    combinedAvoidedCompactionCost - combinedWorkerCost;

  // Summary stats
  body += `<div class="stats">
    <div class="stat"><div class="label">Live Sessions</div><div class="value">${allCosts.size}</div></div>
    <div class="stat"><div class="label">Historical Sessions</div><div class="value">${hist.sessionCount}</div></div>
    <div class="stat"><div class="label">Live Spend</div><div class="value">${formatUSD(liveTotalSpend)}</div></div>
    <div class="stat"><div class="label">Avoided Compactions</div><div class="value">${combinedAvoidedCompactions}</div></div>
    ${combinedNetSavings > 0 ? `<div class="stat"><div class="label">Net Savings</div><div class="value" style="color:#10b981">${formatUSD(combinedNetSavings)}</div></div>` : ""}
    ${combinedNetSavings < 0 ? `<div class="stat"><div class="label">Net Overhead</div><div class="value" style="color:#e06c75">${formatUSD(-combinedNetSavings)}</div></div>` : ""}
  </div>`;

  // =====================================================
  // LIVE SESSIONS section
  // =====================================================
  body += `<h2>Live Sessions (since gateway start)</h2>`;

  if (allCosts.size === 0) {
    body += `<p class="empty">No active sessions yet. Cost tracking begins when the first conversation turn is processed.</p>`;
  } else {
    body += `<div class="card">
      <table class="cost-table">
        <tr class="section-header"><td colspan="2"><strong>Aggregated Spend</strong></td></tr>
        <tr><td>Conversation</td><td>${formatUSD(liveTotalConversation)} <span style="color:var(--fg3);font-size:0.85em">(${liveTotalTurns} turns)</span></td></tr>
        <tr><td>+ Lore overhead</td><td>${formatUSD(liveTotalWorker)}</td></tr>
        <tr style="border-top:1px solid var(--border)"><td><strong>Total</strong></td><td><strong>${formatUSD(liveTotalSpend)}</strong></td></tr>`;

    if (liveTotalSavings !== 0) {
      body += `<tr class="section-header"><td colspan="2" style="padding-top:0.8em"><strong>Savings Breakdown</strong></td></tr>`;
      if (liveWarmupSavings > 0) body += `<tr><td>Cache warming</td><td>${formatUSD(liveWarmupSavings)}</td></tr>`;
      if (liveTtlSavings > 0) body += `<tr><td>1h TTL</td><td>${formatUSD(liveTtlSavings)}</td></tr>`;
      if (liveBatchSavings > 0) body += `<tr><td>Batch API</td><td>${formatUSD(liveBatchSavings)}</td></tr>`;
      if (liveAvoidedCompactionCost > 0) body += `<tr><td>Avoided compactions</td><td>${formatUSD(liveAvoidedCompactionCost)} <span style="color:var(--fg3);font-size:0.85em">(&times;${liveAvoidedCompactions})</span></td></tr>`;
      body += `<tr style="border-top:1px solid var(--border)"><td><strong>Net savings</strong></td><td><strong style="color:${liveTotalSavings >= 0 ? "#10b981" : "#e06c75"}">${formatUSD(liveTotalSavings)}</strong></td></tr>`;
    }
    body += `</table></div>`;

    // Per-session table
    body += `<h3>Per Session</h3><table>
      <tr><th>Session</th><th data-sort="num">Turns</th><th data-sort="num">Conversation</th><th data-sort="num">Worker</th><th data-sort="num">Total</th><th data-sort="num">Savings</th></tr>`;
    for (const [sid, c] of allCosts) {
      const actual = totalActualCost(c);
      const saved = totalSavings(c);
      body += `<tr>
        <td><code>${esc(sid.slice(0, 16))}</code></td>
        <td>${c.conversation.turns}</td>
        <td>${formatUSD(c.conversation.cost)}</td>
        <td>${formatUSD(totalWorkerCost(c))}</td>
        <td>${formatUSD(actual)}</td>
        <td style="color:${saved >= 0 ? "#10b981" : "#e06c75"}">${formatUSD(saved)}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  // =====================================================
  // HISTORICAL (BACKDATED) section
  // =====================================================
  body += `<h2>Historical Estimates (from stored data)</h2>`;
  body += `<p style="color:var(--fg3);font-size:0.9em">
    Aggregated from ${hist.sessionCount} sessions (${hist.messageCount.toLocaleString()} messages).
    Worker overhead and savings use persisted live-session data where available,
    with heuristic estimates as fallback for sessions without a snapshot.
  </p>`;

  if (hist.sessionCount === 0) {
    body += `<p class="empty">No historical sessions found in the database.</p>`;
  } else {
    const histNetSavings = hist.avoidedCompactionCost + hist.warmupSavings + hist.ttlSavings + hist.batchSavings - hist.totalWorkerCost;
    body += `<div class="card">
      <table class="cost-table">`;
    if (hist.persistedConversationCost > 0) {
      body += `<tr class="section-header"><td colspan="2"><strong>Historical Spend</strong></td></tr>
        <tr><td>Conversation</td><td>${formatUSD(hist.persistedConversationCost)}</td></tr>`;
    }
    body += `<tr class="section-header"><td colspan="2"${hist.persistedConversationCost > 0 ? ' style="padding-top:0.8em"' : ""}><strong>Lore Overhead</strong></td></tr>
        <tr><td>Total worker cost</td><td>${formatUSD(hist.totalWorkerCost)}`;
    if (hist.totalWorkerCost !== hist.distillationCost) {
      body += ` <span style="color:var(--fg3);font-size:0.85em">(distillation-only estimate: ${formatUSD(hist.distillationCost)})</span>`;
    }
    body += `</td></tr>
        <tr class="section-header"><td colspan="2" style="padding-top:0.8em"><strong>Estimated Savings</strong></td></tr>
        <tr><td>Avoided compactions</td><td>${formatUSD(hist.avoidedCompactionCost)} <span style="color:var(--fg3);font-size:0.85em">(&times;${hist.avoidedCompactions})</span></td></tr>
        ${hist.warmupSavings > 0 ? `<tr><td>Cache warming</td><td>${formatUSD(hist.warmupSavings)} <span style="color:var(--fg3);font-size:0.85em">(${hist.warmupHits} hits)</span></td></tr>` : ""}
        ${hist.ttlSavings > 0 ? `<tr><td>1h TTL extension</td><td>${formatUSD(hist.ttlSavings)} <span style="color:var(--fg3);font-size:0.85em">(${hist.ttlHits} hits)</span></td></tr>` : ""}
        ${hist.batchSavings > 0 ? `<tr><td>Batch API discount</td><td>${formatUSD(hist.batchSavings)}</td></tr>` : ""}
        <tr style="border-top:1px solid var(--border)"><td><strong>Net estimated savings</strong></td><td><strong style="color:${histNetSavings >= 0 ? "#10b981" : "#e06c75"}">${formatUSD(histNetSavings)}</strong></td></tr>
      </table>
    </div>`;

    // Per-session historical table (top 50)
    const displayed = historical.sessions.slice(0, 50);
    body += `<h3>Per Session (top ${displayed.length} by recency)</h3>
    <div class="table-filter"><input type="text" placeholder="Filter sessions\u2026"><span class="count"></span></div>
    <table>
      <tr><th data-sort="text">Project</th><th>Session</th><th data-sort="num">Messages</th><th data-sort="text">Model</th><th data-sort="num">Worker Cost</th><th data-sort="num">Avoided Compactions</th><th data-sort="date">Last Active</th></tr>`;
    for (const s of displayed) {
      const sessionWorkerCost = s.persisted?.workerCost ?? s.distillationCost;
      body += `<tr>
        <td><a href="/ui/projects/${esc(s.projectId)}">${esc(s.projectName ?? "(unnamed)")}</a></td>
        <td><a href="/ui/sessions/${esc(s.projectId)}/${esc(s.sessionId)}"><code>${esc(s.sessionId.slice(0, 12))}</code></a></td>
        <td>${s.messageCount}</td>
        <td style="font-size:0.85em">${esc(s.model.replace("claude-", "").slice(0, 20))}</td>
        <td>${formatUSD(sessionWorkerCost)}</td>
        <td>${s.avoidedCompactions > 0 ? `${s.avoidedCompactions} (${formatUSD(s.avoidedCompactionCost)})` : "-"}</td>
        <td>${timeAgo(s.lastMessage)}</td>
      </tr>`;
    }
    body += `</table>`;
    if (historical.sessions.length > 50) {
      body += `<p style="color:var(--fg3);font-size:0.85em">Showing 50 of ${historical.sessions.length} sessions.</p>`;
    }
  }

  return layout("Costs", body);
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

    // User knowledge list (cross-project + global entries)
    if (pathname === "/ui/knowledge") {
      return htmlResponse(pageUserKnowledge());
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

    // Costs
    if (pathname === "/ui/costs") {
      return htmlResponse(pageCosts());
    }

    // Cache warming
    if (pathname === "/ui/warming") {
      return htmlResponse(pageWarming());
    }

    // Search detail (by source-prefixed ID)
    const searchDetailMatch = matchRoute(pathname, "/ui/search/detail/:fullId");
    if (searchDetailMatch) {
      const html = pageSearchDetail(searchDetailMatch.fullId);
      return html
        ? htmlResponse(html)
        : htmlResponse(layout("Not Found", `<h1>Entry not found</h1><p>No entry found for ID: ${esc(searchDetailMatch.fullId)}</p>`), 404);
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
      if (entry?.cross_project || !entry?.project_id) {
        return redirect("/ui/knowledge");
      }
      return redirect(`/ui/projects/${entry.project_id}`);
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

    // Delete project (full removal)
    const delProject = matchRoute(pathname, "/ui/api/delete/project/:id");
    if (delProject) {
      data.deleteProject(delProject.id);
      return redirect("/ui");
    }

    // Rename project
    const renameProjectMatch = matchRoute(pathname, "/ui/api/rename/project/:id");
    if (renameProjectMatch) {
      const formData = await req.formData();
      const newName = formData.get("name");
      if (typeof newName === "string" && newName.trim()) {
        data.renameProject(renameProjectMatch.id, newName);
      }
      return redirect(`/ui/projects/${renameProjectMatch.id}`);
    }
  }

  // 404
  return htmlResponse(
    layout("Not Found", `<h1>Page not found</h1><p><a href="/ui">Back to dashboard</a></p>`),
    404,
  );
}
