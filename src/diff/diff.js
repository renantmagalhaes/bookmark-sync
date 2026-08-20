/**
 * Diff page for Bookmark Sync.
 *
 * Lets you pick a profile and two versions (base = older, compare = newer)
 * and see exactly which bookmarks were added, removed, or changed between them.
 *
 * The "current" version is the profile's live bookmarks.json; historical
 * versions are snapshots from the history index.
 */

// ─── State ────────────────────────────────────────────────────────────────────

let ownProfileKey = "";
let dateFormat = "dmy";
let knownProfiles = [];   // [{ key, name, lastSync, count }]
let versionList = [];     // [{ id, file, sha, count, timestamp }] oldest-first
let versionCache = {};    // { versionId: { tree, count } }

// ─── Theme ────────────────────────────────────────────────────────────────────

async function applyStoredTheme() {
  const { themePreference } = await chrome.storage.sync.get("themePreference");
  const theme = themePreference || "dark";
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("themeToggle").textContent = theme === "dark" ? "☀️" : "🌙";
}

document.getElementById("themeToggle").addEventListener("click", async () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  document.getElementById("themeToggle").textContent = next === "dark" ? "☀️" : "🌙";
  await chrome.storage.sync.set({ themePreference: next });
});

document.getElementById("closeBtn").addEventListener("click", () => window.close());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(isoString, fmt) {
  if (!isoString) return "";
  const date = new Date(isoString);
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (fmt === "mdy") return `${m}/${d}/${y} ${hh}:${mm}`;
  if (fmt === "ymd") return `${y}-${m}-${d} ${hh}:${mm}`;
  return `${d}/${m}/${y} ${hh}:${mm}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function flattenTree(nodes, path = "") {
  const results = [];
  for (const node of nodes) {
    if (node.type === "bookmark") {
      results.push({ title: node.title, url: node.url, path });
    } else if (node.type === "folder") {
      const folderPath = path ? `${path} / ${node.title}` : node.title;
      results.push(...flattenTree(node.children || [], folderPath));
    }
  }
  return results;
}

function countBookmarks(nodes) {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "bookmark") n++;
    else if (node.type === "folder") n += countBookmarks(node.children || []);
  }
  return n;
}

// ─── Profile / Version loading ────────────────────────────────────────────────

async function loadProfiles() {
  const { cachedProfiles: stored } = await chrome.storage.local.get("cachedProfiles");
  if (stored && stored.length > 0) {
    knownProfiles = stored;
  } else {
    try {
      const result = await chrome.runtime.sendMessage({ action: "listProfiles" });
      if (result && result.success && result.profiles.length > 0) {
        knownProfiles = result.profiles;
      }
    } catch {
      // fall through — own profile added below
    }
  }

  // Ensure own profile is present
  if (ownProfileKey && !knownProfiles.find((p) => p.key === ownProfileKey)) {
    const { profileName, lastSyncTime } = await chrome.storage.sync.get([
      "profileName",
      "lastSyncTime"
    ]);
    knownProfiles.unshift({
      key: ownProfileKey,
      name: profileName || ownProfileKey,
      lastSync: lastSyncTime || null,
      count: null
    });
  }

  const select = document.getElementById("diffProfile");
  select.innerHTML = knownProfiles
    .map((p) => {
      const isOwn = p.key === ownProfileKey;
      const label = isOwn ? `${p.name || p.key} (You)` : (p.name || p.key);
      return `<option value="${escHtml(p.key)}">${escHtml(label)}</option>`;
    })
    .join("");

  // Default to own profile
  if (knownProfiles.length > 0) {
    select.value = ownProfileKey;
    await loadVersions(ownProfileKey);
  }
}

async function loadVersions(profileKey) {
  versionList = [];
  versionCache = {};
  const baseSel = document.getElementById("diffBase");
  const cmpSel = document.getElementById("diffCompare");

  baseSel.innerHTML = `<option value="">Loading versions...</option>`;
  cmpSel.innerHTML = `<option value="">Loading versions...</option>`;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "fetchHistoryIndex",
      profileKey
    });
    if (result && result.success) {
      versionList = result.versions || []; // oldest-first
    }
  } catch {
    // history unavailable
  }

  renderVersionOptions();
}

function renderVersionOptions() {
  const baseSel = document.getElementById("diffBase");
  const cmpSel = document.getElementById("diffCompare");

  const options = [
    `<option value="current">Current (${versionList.length ? "live" : "no history"})</option>`
  ];
  for (const v of versionList) {
    const label = formatDate(v.timestamp, dateFormat);
    const countStr = v.count != null ? ` (${v.count})` : "";
    options.push(`<option value="${escHtml(v.id)}">${escHtml(label + countStr)}</option>`);
  }

  baseSel.innerHTML = `<option value="">Select base version</option>` + options.join("");
  cmpSel.innerHTML = `<option value="">Select compare version</option>` + options.join("");

  // Sensible defaults: base = oldest snapshot, compare = current
  if (versionList.length > 0) {
    baseSel.value = versionList[0].id;
  }
  cmpSel.value = "current";

  updateRunState();
}

function updateRunState() {
  const base = document.getElementById("diffBase").value;
  const cmp = document.getElementById("diffCompare").value;
  document.getElementById("diffRun").disabled = !base || !cmp || base === cmp;
}

// ─── Version fetching ─────────────────────────────────────────────────────────

async function getVersionData(profileKey, versionId) {
  if (versionCache[versionId]) return versionCache[versionId];

  let result;
  if (versionId === "current") {
    if (profileKey === ownProfileKey) {
      const { cachedTree } = await chrome.storage.local.get("cachedTree");
      const tree = cachedTree || [];
      versionCache[versionId] = { tree, count: countBookmarks(tree) };
      return versionCache[versionId];
    }
    result = await chrome.runtime.sendMessage({
      action: "fetchProfileBookmarks",
      profileKey
    });
  } else {
    result = await chrome.runtime.sendMessage({
      action: "fetchVersionTree",
      profileKey,
      versionId
    });
  }

  if (!result || !result.success) {
    throw new Error(result?.error || "Could not load version");
  }

  const tree = result.data.tree || [];
  versionCache[versionId] = { tree, count: countBookmarks(tree) };
  return versionCache[versionId];
}

// ─── Diff computation ─────────────────────────────────────────────────────────

/**
 * Compare two bookmark lists (flat, with path info).
 * Returns { added, removed, changed } where each is an array of
 * { title, url, path, oldTitle?, newTitle?, oldPath?, newPath? }.
 */
function computeDiff(baseFlat, compareFlat) {
  const baseMap = new Map(baseFlat.map((b) => [b.url, b]));
  const cmpMap = new Map(compareFlat.map((b) => [b.url, b]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [url, b] of cmpMap) {
    if (!baseMap.has(url)) {
      added.push({ title: b.title, url, path: b.path });
    } else {
      const old = baseMap.get(url);
      const titleChanged = old.title !== b.title;
      const pathChanged = old.path !== b.path;
      if (titleChanged || pathChanged) {
        changed.push({
          title: b.title,
          url,
          path: b.path,
          oldTitle: old.title,
          newTitle: b.title,
          oldPath: old.path,
          newPath: b.path
        });
      }
    }
  }

  for (const [url, b] of baseMap) {
    if (!cmpMap.has(url)) {
      removed.push({ title: b.title, url, path: b.path });
    }
  }

  return { added, removed, changed };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderSummary(baseData, cmpData, diff) {
  const summary = document.getElementById("diffSummary");
  summary.hidden = false;

  const baseLabel = document.getElementById("diffBase").selectedOptions[0]?.textContent || "Base";
  const cmpLabel = document.getElementById("diffCompare").selectedOptions[0]?.textContent || "Compare";

  const total = diff.added.length + diff.removed.length + diff.changed.length;

  summary.innerHTML = `
    <div class="diff-summary-line">
      <span class="diff-summary-title">${escHtml(baseLabel)} → ${escHtml(cmpLabel)}</span>
      <span class="diff-summary-counts">
        <span class="diff-count diff-count-added">+${diff.added.length} added</span>
        <span class="diff-count diff-count-removed">−${diff.removed.length} removed</span>
        <span class="diff-count diff-count-changed">~${diff.changed.length} changed</span>
      </span>
    </div>
    <div class="diff-summary-meta">
      Base: ${baseData.count} bookmarks · Compare: ${cmpData.count} bookmarks
      ${total === 0 ? " · No differences" : ""}
    </div>
  `;
}

function renderResults(diff) {
  const container = document.getElementById("diffResults");

  if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
    container.innerHTML = `
      <div class="state-box">
        <span class="state-icon">✅</span>
        <strong>No differences</strong>
        <span>These two versions are identical.</span>
      </div>`;
    return;
  }

  const sections = [];

  if (diff.added.length > 0) {
    sections.push(renderSection("Added", "diff-added", "➕", diff.added, "added"));
  }
  if (diff.removed.length > 0) {
    sections.push(renderSection("Removed", "diff-removed", "➖", diff.removed, "removed"));
  }
  if (diff.changed.length > 0) {
    sections.push(renderSection("Changed", "diff-changed", "✏️", diff.changed, "changed"));
  }

  container.innerHTML = sections.join("");
}

function renderSection(title, cls, icon, items, kind) {
  const rows = items.map((item) => {
    const path = item.path
      ? `<div class="diff-path">📁 ${escHtml(item.path)}</div>`
      : "";

    if (kind === "changed") {
      const titleLine =
        item.oldTitle !== item.newTitle
          ? `<div class="diff-title"><span class="diff-old">${escHtml(item.oldTitle)}</span> → <span class="diff-new">${escHtml(item.newTitle)}</span></div>`
          : `<div class="diff-title">${escHtml(item.title)}</div>`;
      const pathLine =
        item.oldPath !== item.newPath
          ? `<div class="diff-path"><span class="diff-old">📁 ${escHtml(item.oldPath || "(root)")}</span> → <span class="diff-new">📁 ${escHtml(item.newPath || "(root)")}</span></div>`
          : path;
      return `
        <div class="diff-row ${cls}">
          <div class="diff-row-main">
            ${titleLine}
            <div class="diff-url">${escHtml(item.url)}</div>
            ${pathLine}
          </div>
          <button class="bm-open" data-url="${escHtml(item.url)}">Open</button>
        </div>`;
    }

    return `
      <div class="diff-row ${cls}">
        <div class="diff-row-main">
          <div class="diff-title">${escHtml(item.title)}</div>
          <div class="diff-url">${escHtml(item.url)}</div>
          ${path}
        </div>
        <button class="bm-open" data-url="${escHtml(item.url)}">Open</button>
      </div>`;
  }).join("");

  return `
    <div class="diff-section">
      <div class="diff-section-head">
        <span class="diff-section-icon">${icon}</span>
        <span class="diff-section-title">${title}</span>
        <span class="diff-section-count">${items.length}</span>
      </div>
      <div class="diff-section-body">${rows}</div>
    </div>`;
}

// ─── Run diff ─────────────────────────────────────────────────────────────────

async function runDiff() {
  const profileKey = document.getElementById("diffProfile").value;
  const baseId = document.getElementById("diffBase").value;
  const cmpId = document.getElementById("diffCompare").value;

  if (!profileKey || !baseId || !cmpId || baseId === cmpId) return;

  const results = document.getElementById("diffResults");
  const summary = document.getElementById("diffSummary");
  summary.hidden = true;
  results.innerHTML = `
    <div class="state-box">
      <span class="state-icon">⏳</span>
      <strong>Comparing versions...</strong>
    </div>`;

  try {
    const [baseData, cmpData] = await Promise.all([
      getVersionData(profileKey, baseId),
      getVersionData(profileKey, cmpId)
    ]);

    const baseFlat = flattenTree(baseData.tree);
    const cmpFlat = flattenTree(cmpData.tree);
    const diff = computeDiff(baseFlat, cmpFlat);

    renderSummary(baseData, cmpData, diff);
    renderResults(diff);
  } catch (e) {
    results.innerHTML = `
      <div class="state-box error">
        <span class="state-icon">❌</span>
        <strong>Could not compare versions</strong>
        <span>${escHtml(e.message)}</span>
      </div>`;
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────

document.getElementById("diffProfile").addEventListener("change", (e) => {
  loadVersions(e.target.value);
});

document.getElementById("diffBase").addEventListener("change", updateRunState);
document.getElementById("diffCompare").addEventListener("change", updateRunState);
document.getElementById("diffRun").addEventListener("click", runDiff);

// Open bookmark links
document.getElementById("diffResults").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-url]");
  if (btn) {
    chrome.tabs.create({ url: btn.dataset.url });
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await applyStoredTheme();
  const syncData = await chrome.storage.sync.get(["profileKey", "dateFormat"]);
  ownProfileKey = syncData.profileKey || "default";
  dateFormat = syncData.dateFormat || "dmy";
  await loadProfiles();
});