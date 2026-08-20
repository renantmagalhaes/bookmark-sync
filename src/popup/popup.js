/**
 * Popup Script for Bookmark Sync
 *
 * Two modes:
 *  Browse  (search empty)  — navigate folder tree with breadcrumb
 *  Search  (search active) — flat filtered results across all bookmarks
 *
 * Profile switching:
 *  - Sync always writes to the configured profile (own device only)
 *  - Popup lets you switch profiles to browse/search any device's bookmarks
 *  - Own profile served from local cache (fast)
 *  - Other profiles fetched from GitHub on first select, then cached 1 hour
 */

const MAX_RESULTS = 150;
const OTHER_PROFILE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── State ────────────────────────────────────────────────────────────────────

let ownProfileKey = "";       // this device's profile key (from settings)
let selectedProfileKey = "";  // profile currently being viewed
let knownProfiles = [];       // [{ key, name, lastSync, count }] — all known profiles
let activeTree = [];          // tree of the selected profile
let activeFlat = [];          // flat list for search
let navStack = [];            // browse navigation: [{ title, children }, ...]
let dateFormat = "dmy";
let focusedIndex = -1;        // keyboard-focused result index (-1 = none)

// Timeline state
let versionList = [];               // [{ id, file, sha, count, timestamp }] newest-first after load
let selectedVersionId = "current";  // "current" | "all" | version id
const versionTreeCache = {};        // { versionId: tree[] } — in-memory for popup session
let allVersionsFlat = [];           // merged flat list for "all versions" search mode

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

function highlight(text, query) {
  if (!query) return escHtml(text);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escHtml(text).replace(new RegExp(`(${escaped})`, "gi"), "<mark>$1</mark>");
}

function flattenTree(nodes, path = "") {
  const results = [];
  for (const node of nodes) {
    if (node.type === "bookmark") {
      results.push({ type: "bookmark", title: node.title, url: node.url, path, dateAdded: node.dateAdded || 0 });
    } else if (node.type === "folder") {
      const folderPath = path ? `${path} / ${node.title}` : node.title;
      results.push({ type: "folder", title: node.title, path, navPath: folderPath, childCount: countAll(node.children || []) });
      results.push(...flattenTree(node.children || [], folderPath));
    }
  }
  return results;
}

function countAll(children) {
  let n = 0;
  for (const node of children) {
    if (node.type === "bookmark") n++;
    else if (node.type === "folder") n += countAll(node.children || []);
  }
  return n;
}

/**
 * Returns true if every char in query appears in text in order AND
 * the matched characters are reasonably close together.
 * The span (first→last matched char) must not exceed query.length × 5,
 * which prevents scattered false-positive matches across long strings.
 */
function fuzzyMatch(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0, first = -1, last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (first < 0) first = ti;
      last = ti;
      qi++;
    }
  }
  if (qi < q.length) return false;
  return (last - first + 1) <= q.length * 5;
}

/** Higher score = better match. Prefers exact substrings, then start-of-word, then fuzzy. */
function fuzzyScore(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 10000;
  if (t.startsWith(q)) return 5000;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx; // earlier exact match = higher
  // Consecutive fuzzy chars score higher
  let score = 0, qi = 0, run = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { score += 1 + run; run++; qi++; }
    else run = 0;
  }
  return qi === q.length ? score : 0;
}

/**
 * Collect char positions to highlight in `text` for a single token.
 * Returns a Set of indices.
 */
function highlightPositions(text, token) {
  const lt = text.toLowerCase();
  const lq = token.toLowerCase();
  const positions = new Set();

  // Exact substring → range
  const idx = lt.indexOf(lq);
  if (idx >= 0) {
    for (let i = idx; i < idx + lq.length; i++) positions.add(i);
    return positions;
  }

  // Fuzzy → individual matched chars (same span limit as fuzzyMatch)
  const candidates = [];
  let qi = 0;
  for (let ti = 0; ti < lt.length && qi < lq.length; ti++) {
    if (lt[ti] === lq[qi]) { candidates.push(ti); qi++; }
  }
  if (qi < lq.length) return new Set();
  const span = candidates[candidates.length - 1] - candidates[0] + 1;
  if (span > lq.length * 5) return new Set();
  candidates.forEach((p) => positions.add(p));
  return positions;
}

/**
 * Highlight all tokens in text. Each token's matching chars are wrapped in <mark>.
 * Tokens can match different parts of the text independently.
 */
function multiTokenHighlight(text, tokens) {
  if (!tokens.length) return escHtml(text);

  const marked = new Set();
  for (const token of tokens) {
    for (const pos of highlightPositions(text, token)) marked.add(pos);
  }

  return Array.from(text)
    .map((ch, i) => (marked.has(i) ? `<mark>${escHtml(ch)}</mark>` : escHtml(ch)))
    .join("");
}

// Keep single-query variant used in browse mode
function fuzzyHighlight(text, query) {
  return multiTokenHighlight(text, query ? [query] : []);
}

function stateBox(icon, title, body = "") {
  return `
    <div class="state-box">
      <span class="state-icon">${icon}</span>
      <strong>${escHtml(title)}</strong>
      ${body ? `<span>${escHtml(body)}</span>` : ""}
    </div>`;
}

/**
 * Apply the .result-focused class to the item at focusedIndex and scroll it
 * into view. Only operates on .bm-row elements (search results).
 */
function applyFocus() {
  const items = Array.from(document.querySelectorAll("#resultsList .bm-row"));
  // clamp
  if (focusedIndex >= items.length) focusedIndex = items.length - 1;
  items.forEach((el, i) => el.classList.toggle("result-focused", i === focusedIndex));
  if (focusedIndex >= 0 && items[focusedIndex]) {
    items[focusedIndex].scrollIntoView({ block: "nearest" });
  }
}

// ─── Status Bar ───────────────────────────────────────────────────────────────

async function loadStatus() {
  const syncData = await chrome.storage.sync.get([
    "lastSyncTime",
    "lastSyncStatus",
    "dateFormat",
    "profileKey",
    "profileName"
  ]);
  dateFormat = syncData.dateFormat || "dmy";
  ownProfileKey = syncData.profileKey || "default";

  const statusEl = document.getElementById("statusMessage");
  const lastSyncEl = document.getElementById("lastSync");
  const label = syncData.profileName || syncData.profileKey || null;
  const status = syncData.lastSyncStatus || "";

  if (!syncData.lastSyncTime) {
    statusEl.textContent = "Not synced yet";
    statusEl.className = "status-message";
    lastSyncEl.textContent = "Open ⚙️ to configure GitHub";
  } else if (status.startsWith("error")) {
    statusEl.textContent = "Sync error";
    statusEl.className = "status-message error";
    lastSyncEl.textContent = `Last attempt: ${formatDate(syncData.lastSyncTime, dateFormat)}`;
  } else {
    statusEl.textContent = label ? `Synced · ${label}` : "Synced";
    statusEl.className = "status-message success";
    lastSyncEl.textContent = `Last sync: ${formatDate(syncData.lastSyncTime, dateFormat)}`;
  }
}

// ─── Profile Management ───────────────────────────────────────────────────────

/**
 * Load own profile's tree from local cache and set it as the active tree.
 */
async function loadOwnProfileTree() {
  const { cachedTree: stored } = await chrome.storage.local.get("cachedTree");
  setActiveTree(stored || []);
}

/**
 * Replace active tree + flat + navStack, reset browse to root.
 */
function setActiveTree(tree) {
  activeTree = tree;
  activeFlat = flattenTree(tree);
  navStack = [{ title: "Bookmarks", children: tree }];
}

/**
 * Load the known profiles list.
 * Uses the locally cached list first; falls back to fetching from GitHub.
 * Always ensures the own profile appears in the list.
 */
async function loadKnownProfiles() {
  const { cachedProfiles: stored } = await chrome.storage.local.get("cachedProfiles");

  if (stored && stored.length > 0) {
    knownProfiles = stored;
  } else {
    // Try fetching from GitHub
    try {
      const result = await chrome.runtime.sendMessage({ action: "listProfiles" });
      if (result && result.success && result.profiles.length > 0) {
        knownProfiles = result.profiles;
        await chrome.storage.local.set({ cachedProfiles: knownProfiles });
      }
    } catch {
      // Silently continue — own profile will be added below
    }
  }

  // Ensure own profile is always present
  if (ownProfileKey && !knownProfiles.find((p) => p.key === ownProfileKey)) {
    const { profileName, lastSyncTime } = await chrome.storage.sync.get([
      "profileName",
      "lastSyncTime"
    ]);
    knownProfiles.unshift({
      key: ownProfileKey,
      name: profileName || ownProfileKey,
      lastSync: lastSyncTime || null,
      count: activeFlat.length
    });
  }

  renderProfileFilter();
  loadVersionList(); // async — populates version dropdown in background
}

/**
 * Render the profile dropdown, marking own profile with "(You)".
 */
function renderProfileFilter() {
  const select = document.getElementById("profileFilter");
  if (knownProfiles.length === 0) {
    select.innerHTML = `<option value="${escHtml(ownProfileKey)}" selected>${escHtml(ownProfileKey)} (You)</option>`;
    return;
  }

  select.innerHTML = knownProfiles
    .map((p) => {
      const isOwn = p.key === ownProfileKey;
      const label = isOwn ? `${p.name || p.key} (You)` : (p.name || p.key);
      const selected = p.key === selectedProfileKey ? " selected" : "";
      return `<option value="${escHtml(p.key)}"${selected}>${escHtml(label)}</option>`;
    })
    .join("");
}

/**
 * Switch the popup to display a different profile's bookmarks.
 * Own profile → local cache.
 * Other profile → check 1-hour cache, otherwise fetch from GitHub.
 */
async function switchProfile(profileKey) {
  if (profileKey === selectedProfileKey) return;
  selectedProfileKey = profileKey;

  // Reset timeline to current when switching profiles
  selectedVersionId = "current";
  versionList = [];
  allVersionsFlat = [];
  updateVersionBanner();

  // Own profile: use local cache immediately
  if (profileKey === ownProfileKey) {
    await loadOwnProfileTree();
    document.getElementById("searchInput").value = "";
    document.getElementById("searchClear").hidden = true;
    render();
    return;
  }

  // Other profile: check local cache first
  const { cachedOtherProfiles } = await chrome.storage.local.get("cachedOtherProfiles");
  const cached = cachedOtherProfiles?.[profileKey];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < OTHER_PROFILE_TTL_MS) {
    setActiveTree(cached.tree || []);
    document.getElementById("searchInput").value = "";
    document.getElementById("searchClear").hidden = true;
    render();
    return;
  }

  // Fetch from GitHub via background
  showProfileLoading(profileKey);

  try {
    const result = await chrome.runtime.sendMessage({
      action: "fetchProfileBookmarks",
      profileKey
    });

    if (result && result.success) {
      setActiveTree(result.data.tree || []);

      // Cache it
      const existing = cachedOtherProfiles || {};
      existing[profileKey] = { tree: activeTree, fetchedAt: new Date().toISOString() };
      await chrome.storage.local.set({ cachedOtherProfiles: existing });

      document.getElementById("searchInput").value = "";
      document.getElementById("searchClear").hidden = true;
      render();
    } else {
      document.getElementById("resultsList").innerHTML = stateBox(
        "❌",
        "Could not load profile",
        result?.error || "Unknown error"
      );
      document.getElementById("resultsMeta").textContent = "";
    }
  } catch (e) {
    document.getElementById("resultsList").innerHTML = stateBox(
      "❌",
      "Could not load profile",
      e.message
    );
    document.getElementById("resultsMeta").textContent = "";
  }
}

function showProfileLoading(profileKey) {
  const profile = knownProfiles.find((p) => p.key === profileKey);
  const label = profile?.name || profileKey;
  document.getElementById("resultsList").innerHTML = stateBox("⏳", `Loading ${label}...`);
  document.getElementById("resultsMeta").textContent = "";
  document.getElementById("breadcrumb").hidden = true;
}

// ─── Timeline / Version Management ───────────────────────────────────────────

async function loadVersionList() {
  versionList = [];
  renderVersionFilter();

  try {
    const result = await chrome.runtime.sendMessage({
      action: "fetchHistoryIndex",
      profileKey: selectedProfileKey
    });
    if (result && result.success) {
      // Store newest-first for display; index on GitHub is oldest-first
      versionList = [...(result.versions || [])].reverse();
    }
  } catch {
    // silently fail — history unavailable or not configured
  }

  renderVersionFilter();
}

function renderVersionFilter() {
  const select = document.getElementById("versionFilter");

  if (versionList.length === 0) {
    const sel = selectedVersionId === "current" ? " selected" : "";
    select.innerHTML = `<option value="current"${sel}>Current</option>`;
    return;
  }

  const curSel  = selectedVersionId === "current" ? " selected" : "";
  const allSel  = selectedVersionId === "all"     ? " selected" : "";

  const versionOptions = versionList.map((v) => {
    const label   = formatDate(v.timestamp, dateFormat);
    const countStr = v.count != null ? ` (${v.count})` : "";
    const sel     = selectedVersionId === v.id ? " selected" : "";
    return `<option value="${escHtml(v.id)}"${sel}>${escHtml(label + countStr)}</option>`;
  }).join("");

  select.innerHTML =
    `<option value="current"${curSel}>Current</option>` +
    `<option value="all"${allSel}>All versions</option>` +
    `<option disabled>──────────────</option>` +
    versionOptions;
}

function updateVersionBanner() {
  const banner = document.getElementById("versionBanner");

  if (selectedVersionId === "current") {
    banner.hidden = true;
    banner.innerHTML = "";
  } else if (selectedVersionId === "all") {
    banner.hidden = false;
    const total = versionList.length + 1;
    banner.innerHTML = `🔍 Searching across all ${total} version${total !== 1 ? "s" : ""}`;
    banner.className = "version-banner version-banner-all";
  } else {
    const v = versionList.find((v) => v.id === selectedVersionId);
    if (v) {
      const label = formatDate(v.timestamp, dateFormat);
      banner.hidden = false;
      banner.innerHTML =
        `📅 Snapshot: <strong>${escHtml(label)}</strong> · ${v.count || 0} bookmarks` +
        ` — <button class="version-banner-link" id="backToCurrent">Back to current</button>`;
      banner.className = "version-banner version-banner-snapshot";
      document.getElementById("backToCurrent").addEventListener("click", () => {
        document.getElementById("versionFilter").value = "current";
        switchVersion("current");
      });
    } else {
      banner.hidden = true;
    }
  }
}

async function switchVersion(versionId) {
  if (versionId === selectedVersionId) return;
  selectedVersionId = versionId;
  allVersionsFlat = [];
  updateVersionBanner();

  if (versionId === "current") {
    if (selectedProfileKey === ownProfileKey) {
      await loadOwnProfileTree();
    }
    // For other profiles, activeTree is already the profile's current tree
    render();
    return;
  }

  if (versionId === "all") {
    // Keep activeTree as-is (browse still shows current), but build merged flat for search
    document.getElementById("resultsList").innerHTML = stateBox("⏳", "Loading history...");
    document.getElementById("resultsMeta").textContent = "";
    await loadAllVersionsForSearch();
    render();
    return;
  }

  // Specific version: load its tree
  const v = versionList.find((v) => v.id === versionId);
  if (!v) return;

  if (!versionTreeCache[versionId]) {
    document.getElementById("resultsList").innerHTML = stateBox("⏳", "Loading snapshot...");
    document.getElementById("resultsMeta").textContent = "";

    try {
      const result = await chrome.runtime.sendMessage({
        action: "fetchHistoryVersion",
        profileKey: selectedProfileKey,
        file: v.file
      });
      if (result && result.success) {
        versionTreeCache[versionId] = result.data.tree || [];
      } else {
        document.getElementById("resultsList").innerHTML =
          stateBox("❌", "Could not load snapshot", result?.error || "Unknown error");
        return;
      }
    } catch (e) {
      document.getElementById("resultsList").innerHTML =
        stateBox("❌", "Could not load snapshot", e.message);
      return;
    }
  }

  setActiveTree(versionTreeCache[versionId]);
  render();
}

async function loadAllVersionsForSearch() {
  // Ensure current profile tree is set
  if (selectedProfileKey === ownProfileKey) {
    const { cachedTree } = await chrome.storage.local.get("cachedTree");
    versionTreeCache["current"] = cachedTree || activeTree;
  } else {
    versionTreeCache["current"] = activeTree;
  }

  // Load each version tree (in parallel, max 5 at a time to avoid rate limits)
  const toLoad = versionList.filter((v) => !versionTreeCache[v.id]);
  const BATCH  = 5;
  for (let i = 0; i < toLoad.length; i += BATCH) {
    await Promise.all(
      toLoad.slice(i, i + BATCH).map(async (v) => {
        try {
          const result = await chrome.runtime.sendMessage({
            action: "fetchHistoryVersion",
            profileKey: selectedProfileKey,
            file: v.file
          });
          if (result && result.success) {
            versionTreeCache[v.id] = result.data.tree || [];
          }
        } catch {
          // silently skip
        }
      })
    );
  }

  buildAllVersionsFlat();
}

function buildAllVersionsFlat() {
  // Map URL → merged bookmark info with version list
  const urlMap = new Map();

  // Current version (highest priority)
  const curFlat = flattenTree(versionTreeCache["current"] || activeTree)
    .filter((i) => i.type === "bookmark");
  for (const item of curFlat) {
    urlMap.set(item.url, {
      ...item,
      _inCurrent: true,
      _versions: [{ id: "current", label: "current" }]
    });
  }

  // Historical versions (already newest-first)
  for (const v of versionList) {
    const tree = versionTreeCache[v.id];
    if (!tree) continue;
    const label = formatDate(v.timestamp, dateFormat);
    for (const item of flattenTree(tree).filter((i) => i.type === "bookmark")) {
      if (urlMap.has(item.url)) {
        urlMap.get(item.url)._versions.push({ id: v.id, label });
      } else {
        urlMap.set(item.url, {
          ...item,
          _inCurrent: false,
          _versions: [{ id: v.id, label }]
        });
      }
    }
  }

  allVersionsFlat = Array.from(urlMap.values());
}

function versionBadgeHtml(versions, inCurrent) {
  // Only show badge when the item spans multiple versions OR was removed
  if (!versions || versions.length <= 1 && inCurrent) return "";
  const labels = versions.map((v) => escHtml(v.label)).join(", ");
  const cls    = inCurrent ? "version-badge version-badge-multi" : "version-badge version-badge-removed";
  const icon   = inCurrent ? "🕐" : "🗑️";
  return `<span class="${cls}">${icon} ${labels}</span>`;
}

function renderSearchAllVersions(query) {
  document.getElementById("breadcrumb").hidden = true;

  const list = document.getElementById("resultsList");
  const meta = document.getElementById("resultsMeta");

  if (allVersionsFlat.length === 0) {
    meta.textContent = "";
    list.innerHTML = stateBox("⏳", "Loading history...");
    loadAllVersionsForSearch().then(render);
    return;
  }

  const q      = query.trim();
  const tokens = q.split(/\s+/).filter(Boolean);

  const scored = [];
  for (const item of allVersionsFlat) {
    const title = item.title || "";
    const url   = item.url   || "";
    const path  = item.path  || "";

    const allMatch = tokens.every(
      (t) => fuzzyMatch(title, t) || fuzzyMatch(url, t) || fuzzyMatch(path, t)
    );
    if (!allMatch) continue;

    const score = tokens.reduce(
      (sum, t) => sum + Math.max(fuzzyScore(title, t), fuzzyScore(url, t), fuzzyScore(path, t)),
      0
    ) + (item._inCurrent ? 10 : 0);

    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const totalCount = scored.length;
  if (totalCount === 0) {
    meta.textContent = "";
    list.innerHTML = stateBox("🔍", "No matches", `Nothing matches "${q}" in any version`);
    return;
  }

  const removedCount = scored.filter(({ item }) => !item._inCurrent).length;
  meta.textContent =
    `${totalCount.toLocaleString()} result${totalCount !== 1 ? "s" : ""} across all versions` +
    (removedCount > 0 ? ` (${removedCount} removed)` : "");

  const html = scored.slice(0, MAX_RESULTS).map(({ item }) => {
    const tokens2 = q.split(/\s+/).filter(Boolean);
    const hl      = (text) => multiTokenHighlight(text, tokens2);
    const badge   = versionBadgeHtml(item._versions, item._inCurrent);
    const path    = renderClickablePath(item.path, tokens2);
    const cls     = item._inCurrent ? "" : " bm-removed";

    return `
      <div class="bm-row${cls}" data-url="${escHtml(item.url)}" role="button" tabindex="0">
        <div class="bm-info">
          <div class="bm-title">${hl(item.title || item.url)}${badge ? ` ${badge}` : ""}</div>
          <div class="bm-url">${hl(item.url)}</div>
          ${path}
        </div>
        <button class="bm-open" data-url="${escHtml(item.url)}">Open</button>
      </div>`;
  }).join("");

  list.innerHTML = html;
  applyFocus();
}

// ─── Browse Mode ──────────────────────────────────────────────────────────────

function renderBreadcrumb() {
  const bc = document.getElementById("breadcrumb");
  bc.innerHTML = navStack
    .map((seg, i) => {
      const isLast = i === navStack.length - 1;
      if (isLast) {
        return `<span class="bc-segment bc-active">${escHtml(seg.title)}</span>`;
      }
      return (
        `<button class="bc-segment bc-link" data-idx="${i}">${escHtml(seg.title)}</button>` +
        `<span class="bc-sep">›</span>`
      );
    })
    .join("");
  bc.hidden = false;
}

function renderBrowse() {
  focusedIndex = -1;
  renderBreadcrumb();

  const folder = navStack[navStack.length - 1];
  const children = folder.children || [];
  const list = document.getElementById("resultsList");
  const meta = document.getElementById("resultsMeta");

  if (activeTree.length === 0) {
    meta.textContent = "";
    const isOwn = selectedProfileKey === ownProfileKey;
    list.innerHTML = stateBox(
      "🔄",
      "No bookmarks cached",
      isOwn ? "Click 🔄 to sync your bookmarks." : "Select your own profile and sync first."
    );
    return;
  }

  const folders = children.filter((n) => n.type === "folder");
  const bookmarks = children.filter((n) => n.type === "bookmark");
  const total = folders.length + bookmarks.length;

  meta.textContent =
    total === 0
      ? "Empty folder"
      : `${folders.length} folder${folders.length !== 1 ? "s" : ""}, ` +
        `${bookmarks.length} bookmark${bookmarks.length !== 1 ? "s" : ""}`;

  if (total === 0) {
    list.innerHTML = stateBox("📂", "Empty folder");
    return;
  }

  list.innerHTML =
    folders.map((f) => folderRow(f)).join("") +
    bookmarks.map((b) => bookmarkRow(b, "")).join("");
}

function folderRow(folder) {
  const children = folder.children || [];
  const total = countAll(children);
  const subFolders = children.filter((n) => n.type === "folder").length;
  const summary =
    total === 0
      ? "Empty"
      : `${total} item${total !== 1 ? "s" : ""}` +
        (subFolders > 0 ? `, ${subFolders} folder${subFolders !== 1 ? "s" : ""}` : "");

  return `
    <div class="folder-row" data-folder="${escHtml(folder.title)}" role="button" tabindex="0">
      <span class="folder-icon">📁</span>
      <div class="folder-info">
        <span class="folder-title">${escHtml(folder.title)}</span>
        <span class="folder-meta">${summary}</span>
      </div>
      <span class="folder-chevron">›</span>
    </div>`;
}

/**
 * Render a folder path string as individually clickable breadcrumb segments.
 * Each segment navigates to that cumulative folder path when clicked.
 */
function renderClickablePath(path, tokens) {
  if (!path) return "";
  const segments = path.split(" / ");
  const parts = segments.map((seg, i) => {
    const navPath = escHtml(segments.slice(0, i + 1).join(" / "));
    const label = multiTokenHighlight(seg, tokens);
    return `<button class="bm-path-seg" data-folder-navpath="${navPath}">${label}</button>`;
  });
  return (
    `<div class="bm-path">📁 ` +
    parts.join(`<span class="bm-path-sep"> / </span>`) +
    `</div>`
  );
}

function bookmarkRow(bookmark, query) {
  const tokens = query ? query.split(/\s+/).filter(Boolean) : [];
  const hl = (text) => multiTokenHighlight(text, tokens);
  const title = hl(bookmark.title || bookmark.url);
  const url = hl(bookmark.url);
  const path = renderClickablePath(bookmark.path, tokens);

  return `
    <div class="bm-row" data-url="${escHtml(bookmark.url)}" role="button" tabindex="0">
      <div class="bm-info">
        <div class="bm-title">${title}</div>
        <div class="bm-url">${url}</div>
        ${path}
      </div>
      <button class="bm-open" data-url="${escHtml(bookmark.url)}">Open</button>
    </div>`;
}

function folderSearchResult(folder, query) {
  const tokens = query ? query.split(/\s+/).filter(Boolean) : [];
  const hl = (text) => multiTokenHighlight(text, tokens);
  const title = hl(folder.title);
  const path = folder.path
    ? `<div class="bm-path">📁 ${hl(folder.path)}</div>`
    : "";
  const count = folder.childCount
    ? `<span class="folder-meta">${folder.childCount} item${folder.childCount !== 1 ? "s" : ""}</span>`
    : "";

  return `
    <div class="folder-result" data-folder-navpath="${escHtml(folder.navPath)}" role="button" tabindex="0">
      <div class="bm-info">
        <div class="bm-title">📁 ${title} ${count}</div>
        ${path}
      </div>
      <button class="bm-open" data-folder-navpath="${escHtml(folder.navPath)}">Browse</button>
    </div>`;
}

/** Navigate navStack to a specific folder given its full "/"-separated path. */
function navigateToFolderByPath(navPath) {
  const segments = navPath.split(" / ").filter(Boolean);
  const root = { title: "Bookmarks", children: activeTree };
  navStack = [root];
  let current = root;
  for (const seg of segments) {
    const next = (current.children || []).find((n) => n.type === "folder" && n.title === seg);
    if (!next) break;
    const node = { title: next.title, children: next.children || [] };
    navStack.push(node);
    current = next;
  }
}

// ─── Search Mode ──────────────────────────────────────────────────────────────

function renderSearch(query) {
  document.getElementById("breadcrumb").hidden = true;

  const list = document.getElementById("resultsList");
  const meta = document.getElementById("resultsMeta");

  if (activeFlat.length === 0) {
    meta.textContent = "";
    list.innerHTML = stateBox("🔄", "No bookmarks", "Sync this profile first.");
    return;
  }

  const q = query.trim();
  const tokens = q.split(/\s+/).filter(Boolean);

  // Fuzzy-match and score each item.
  // Every token must match at least one of: title, url, or path.
  // Score = sum of the best-field score per token.
  const scoredBookmarks = [];
  const scoredFolders = [];

  for (const item of activeFlat) {
    const title = item.title || "";
    const url   = item.url   || "";
    const path  = item.path  || "";

    const allMatch = tokens.every(
      (t) => fuzzyMatch(title, t) || fuzzyMatch(url, t) || fuzzyMatch(path, t)
    );
    if (!allMatch) continue;

    const score = tokens.reduce(
      (sum, t) => sum + Math.max(fuzzyScore(title, t), fuzzyScore(url, t), fuzzyScore(path, t)),
      0
    );

    if (item.type === "folder") {
      scoredFolders.push({ item, score });
    } else {
      scoredBookmarks.push({ item, score });
    }
  }

  scoredBookmarks.sort((a, b) => b.score - a.score);
  scoredFolders.sort((a, b) => b.score - a.score);

  const totalCount = scoredBookmarks.length + scoredFolders.length;
  meta.textContent =
    totalCount === 0
      ? ""
      : `${totalCount.toLocaleString()} result${totalCount !== 1 ? "s" : ""} for "${q}"`;

  if (totalCount === 0) {
    list.innerHTML = stateBox("🔍", "No matches", `Nothing matches "${q}"`);
    return;
  }

  const shownBm = scoredBookmarks.slice(0, MAX_RESULTS).map(({ item }) => bookmarkRow(item, q));
  const shownFolders = scoredFolders.slice(0, 30).map(({ item }) => folderSearchResult(item, q));

  let html = shownBm.join("");

  if (shownFolders.length > 0) {
    html += `<div class="search-section-label">Folders</div>` + shownFolders.join("");
  }

  if (scoredBookmarks.length > MAX_RESULTS) {
    html += `<div class="state-box" style="padding:12px 16px;"><span>+${(scoredBookmarks.length - MAX_RESULTS).toLocaleString()} more bookmarks. Refine your search.</span></div>`;
  }

  list.innerHTML = html;
  applyFocus();
}

// ─── Render Entry Point ───────────────────────────────────────────────────────

function render() {
  document.getElementById("resultsList").scrollTop = 0;
  const query = document.getElementById("searchInput").value;
  if (query.trim()) {
    if (selectedVersionId === "all") {
      renderSearchAllVersions(query);
    } else {
      renderSearch(query);
    }
  } else {
    renderBrowse();
  }
}

function navigateUp() {
  if (navStack.length > 1) {
    navStack.pop();
    render();
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────

// Clicks in results list
document.getElementById("resultsList").addEventListener("click", (e) => {
  // ── Folder navigation (path breadcrumb or folder result card) ──
  // Must be checked BEFORE [data-url] because .bm-path-seg lives inside
  // a .bm-row which also carries data-url, and closest() would reach it.
  const folderNav = e.target.closest("[data-folder-navpath]");
  if (folderNav) {
    navigateToFolderByPath(folderNav.dataset.folderNavpath);
    document.getElementById("searchInput").value = "";
    document.getElementById("searchClear").hidden = true;
    focusedIndex = -1;
    render();
    return;
  }

  // ── Bookmark open ──
  const bmBtn = e.target.closest("[data-url]");
  if (bmBtn) {
    chrome.tabs.create({ url: bmBtn.dataset.url });
    window.close();
    return;
  }

  // ── Folder row in browse mode → drill in ──
  const folderEl = e.target.closest(".folder-row[data-folder]");
  if (folderEl && !document.getElementById("searchInput").value.trim()) {
    const title = folderEl.dataset.folder;
    const current = navStack[navStack.length - 1];
    const folder = (current.children || []).find(
      (n) => n.type === "folder" && n.title === title
    );
    if (folder) {
      navStack.push({ title: folder.title, children: folder.children || [] });
      render();
    }
  }
});

// Keyboard in results list
document.getElementById("resultsList").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const bm = e.target.closest(".bm-row[data-url]");
    if (bm) { chrome.tabs.create({ url: bm.dataset.url }); window.close(); return; }
    const folder = e.target.closest(".folder-row");
    if (folder) folder.click();
  }
});

// Breadcrumb navigation
document.getElementById("breadcrumb").addEventListener("click", (e) => {
  const btn = e.target.closest(".bc-link[data-idx]");
  if (!btn) return;
  navStack = navStack.slice(0, parseInt(btn.dataset.idx, 10) + 1);
  render();
});

// Profile switcher
document.getElementById("profileFilter").addEventListener("change", (e) => {
  switchProfile(e.target.value);
});

// Version / timeline switcher
document.getElementById("versionFilter").addEventListener("change", (e) => {
  switchVersion(e.target.value);
});

// Search input
document.getElementById("searchInput").addEventListener("input", (e) => {
  document.getElementById("searchClear").hidden = !e.target.value.trim();
  // Auto-select first result when there's a query
  focusedIndex = e.target.value.trim() ? 0 : -1;
  render();
});

document.getElementById("searchInput").addEventListener("keydown", (e) => {
  const items = Array.from(document.querySelectorAll("#resultsList .bm-row"));

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (items.length > 0) {
      focusedIndex = Math.min(focusedIndex + 1, items.length - 1);
      applyFocus();
    }
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (focusedIndex > 0) {
      focusedIndex--;
      applyFocus();
    }
    return;
  }

  if (e.key === "Enter") {
    const idx = focusedIndex >= 0 ? focusedIndex : 0;
    const item = items[idx];
    if (item?.dataset.url) {
      e.preventDefault();
      chrome.tabs.create({ url: item.dataset.url });
      window.close();
    }
    return;
  }

  if (e.key === "Escape") {
    if (e.target.value) {
      e.target.value = "";
      document.getElementById("searchClear").hidden = true;
      focusedIndex = -1;
      render();
    } else {
      navigateUp();
    }
  }
});

document.getElementById("searchClear").addEventListener("click", () => {
  document.getElementById("searchInput").value = "";
  document.getElementById("searchClear").hidden = true;
  render();
  document.getElementById("searchInput").focus();
});

// Settings
document.getElementById("openSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Open the version diff page
document.getElementById("openDiff").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/diff/diff.html") });
});

// Manual sync (only syncs own profile)
const syncBtn = document.getElementById("syncBtn");
syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = "⏳";

  const statusEl = document.getElementById("statusMessage");
  statusEl.textContent = "Syncing...";
  statusEl.className = "status-message syncing";

  try {
    const result = await chrome.runtime.sendMessage({ action: "syncBookmarks" });
    if (result && result.success) {
      // Reload own tree + profile list
      await loadOwnProfileTree();
      await loadStatus();
      // Refresh profile list in case a new profile appeared
      const { cachedProfiles: fresh } = await chrome.storage.local.get("cachedProfiles");
      if (fresh) {
        knownProfiles = fresh;
        renderProfileFilter();
      }
      // Refresh version list (a new snapshot may have been created)
      await loadVersionList();
      if (selectedVersionId === "all") {
        allVersionsFlat = []; // force rebuild next search
      }
      // If currently viewing own profile, re-render
      if (selectedProfileKey === ownProfileKey) render();
    } else {
      statusEl.textContent = `Sync failed: ${result?.error || "Unknown error"}`;
      statusEl.className = "status-message error";
    }
  } catch (e) {
    statusEl.textContent = `Sync failed: ${e.message}`;
    statusEl.className = "status-message error";
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = "🔄";
  }
});

// ─── Export ───────────────────────────────────────────────────────────────────

function escAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function treeToNetscape(nodes, depth = 1) {
  const indent = "    ".repeat(depth);
  const lines = [];
  for (const node of nodes) {
    if (node.type === "bookmark") {
      const addDate = node.dateAdded ? Math.floor(node.dateAdded / 1000) : 0;
      lines.push(`${indent}<DT><A HREF="${escAttr(node.url)}" ADD_DATE="${addDate}">${escAttr(node.title || node.url)}</A>`);
    } else if (node.type === "folder") {
      lines.push(`${indent}<DT><H3>${escAttr(node.title || "Folder")}</H3>`);
      lines.push(`${indent}<DL><p>`);
      lines.push(treeToNetscape(node.children || [], depth + 1));
      lines.push(`${indent}</DL><p>`);
    }
  }
  return lines.join("\n");
}

function generateNetscapeHtml(tree) {
  return (
    `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n` +
    `<!-- This is an automatically generated file.\n` +
    `     It will be read and overwritten.\n` +
    `     DO NOT EDIT! -->\n` +
    `<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n` +
    `<TITLE>Bookmarks</TITLE>\n` +
    `<H1>Bookmarks</H1>\n` +
    `<DL><p>\n` +
    treeToNetscape(tree, 1) + "\n" +
    `</DL><p>\n`
  );
}

document.getElementById("exportBtn").addEventListener("click", () => {
  const tree = activeTree;
  if (!tree || tree.length === 0) {
    alert("No bookmarks to export. Sync first.");
    return;
  }

  const html     = generateNetscapeHtml(tree);
  const blob     = new Blob([html], { type: "text/html;charset=utf-8" });
  const url      = URL.createObjectURL(blob);
  const profile  = selectedProfileKey || "bookmarks";
  const now      = new Date().toISOString().slice(0, 10);
  const filename = `bookmarks-${profile}-${now}.html`;

  const a = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await applyStoredTheme();
  await loadStatus();               // sets ownProfileKey + dateFormat
  selectedProfileKey = ownProfileKey;
  await loadOwnProfileTree();       // populate activeTree/activeFlat/navStack
  render();                         // show immediately with cached data
  await loadKnownProfiles();        // async: populates profile dropdown
  document.getElementById("searchInput").focus();
});
