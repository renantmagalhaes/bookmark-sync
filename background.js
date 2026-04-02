/**
 * Background Service Worker for Bookmark Sync
 * Handles:
 * - GitHub API calls (read/write per-profile bookmarks.json)
 * - Periodic syncing via alarms
 * - Caching hierarchical bookmark tree for popup browse/search
 */

const SYNC_ALARM = "bookmarkSync";
const INDEX_PATH = "bookmarks/index.json";

function historyIndexPath(profileKey) {
  return `bookmarks/${profileKey}/history/index.json`;
}

function historyFilePath(profileKey, timestamp) {
  // Replace chars that are problematic in some git hosts/filenames
  const safe = timestamp.replace(/[:.]/g, "-");
  return `bookmarks/${profileKey}/history/${safe}.json`;
}

console.log("Bookmark Sync: Service Worker initializing...");

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleMessage(request) {
  switch (request.action) {
    case "syncBookmarks":
      return await syncBookmarksToGitHub();

    case "getStatus": {
      const syncData = await chrome.storage.sync.get([
        "lastSyncTime",
        "lastSyncStatus",
        "profileKey",
        "profileName"
      ]);
      return {
        lastSyncTime: syncData.lastSyncTime || null,
        lastSyncStatus: syncData.lastSyncStatus || null,
        profileKey: syncData.profileKey || null,
        profileName: syncData.profileName || null
      };
    }

    case "setupSync":
      await setupSyncAlarm(request.intervalMinutes);
      return { success: true };

    case "listProfiles": {
      const index = await fetchGitHubJson(INDEX_PATH);
      const profiles = index.exists ? (index.data.profiles || []) : [];
      return { success: true, profiles };
    }

    case "fetchProfileBookmarks": {
      const path = `bookmarks/${request.profileKey}/bookmarks.json`;
      const result = await fetchGitHubJson(path);
      if (!result.exists) {
        return { success: false, error: `Profile "${request.profileKey}" not found on GitHub` };
      }
      return { success: true, data: result.data };
    }

    case "fetchHistoryIndex": {
      const pKey = request.profileKey || (await getProfileKey());
      const result = await fetchGitHubJson(historyIndexPath(pKey));
      if (!result.exists) return { success: true, versions: [] };
      return { success: true, versions: result.data.versions || [] };
    }

    case "fetchHistoryVersion": {
      const pKey = request.profileKey || (await getProfileKey());
      const vPath = `bookmarks/${pKey}/history/${request.file}`;
      const result = await fetchGitHubJson(vPath);
      if (!result.exists) return { success: false, error: "Version not found" };
      return { success: true, data: result.data };
    }

    default:
      return { success: false, error: "Unknown action" };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ success: false, error: error.message }));
  return true;
});

// ─── Alarm Listener ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  console.log("Bookmark Sync: Alarm fired, syncing...");

  let attempts = 0;
  while (attempts < 3) {
    try {
      await syncBookmarksToGitHub();
      return;
    } catch (err) {
      attempts++;
      const isTransient =
        err.message.includes("407") ||
        err.message.includes("408") ||
        err.message.includes("429") ||
        /5\d\d/.test(err.message);
      if (attempts >= 3 || !isTransient) {
        console.error("Bookmark Sync: Alarm sync failed:", err.message);
        await chrome.storage.sync.set({ lastSyncStatus: `error: ${err.message}` });
        return;
      }
      await sleep(10000);
    }
  }
});

// ─── Alarm Setup ──────────────────────────────────────────────────────────────

async function setupSyncAlarm(intervalMinutes) {
  await chrome.alarms.clear(SYNC_ALARM);
  if (intervalMinutes > 0) {
    chrome.alarms.create(SYNC_ALARM, {
      delayInMinutes: intervalMinutes,
      periodInMinutes: intervalMinutes
    });
    console.log(`Bookmark Sync: Alarm set for every ${intervalMinutes} minutes`);
  }
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function slugifyProfileKey(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function getProfileKey() {
  const { profileKey, profileName } = await chrome.storage.sync.get([
    "profileKey",
    "profileName"
  ]);
  const key =
    slugifyProfileKey(profileKey) || slugifyProfileKey(profileName) || "default";

  // Keep stored profileKey normalised
  if (key !== profileKey) {
    await chrome.storage.sync.set({ profileKey: key });
  }
  return key;
}

async function getBookmarksPath() {
  const profileKey = await getProfileKey();
  return `bookmarks/${profileKey}/bookmarks.json`;
}

// ─── GitHub API Utilities ─────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGitHubHeaders() {
  const { githubToken } = await chrome.storage.sync.get("githubToken");
  if (!githubToken) throw new Error("GitHub token not configured");
  return {
    Authorization: `token ${githubToken}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json"
  };
}

async function getRepoUrl() {
  const { githubUsername, githubRepo } = await chrome.storage.sync.get([
    "githubUsername",
    "githubRepo"
  ]);
  if (!githubUsername || !githubRepo) {
    throw new Error("GitHub credentials not configured. Open Settings to configure.");
  }
  return `https://api.github.com/repos/${githubUsername}/${githubRepo}`;
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(base64) {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function parseGitHubError(response) {
  try {
    const err = await response.json();
    return err.message || `GitHub API error (${response.status})`;
  } catch {
    return `GitHub API error (${response.status})`;
  }
}

async function fetchGitHubJson(path) {
  const repoUrl = await getRepoUrl();
  const headers = await getGitHubHeaders();
  const response = await fetch(`${repoUrl}/contents/${path}`, {
    headers,
    cache: "no-store"
  });

  if (response.status === 404) return { exists: false };
  if (!response.ok) throw new Error(await parseGitHubError(response));

  const payload = await response.json();
  if (Array.isArray(payload)) throw new Error(`Expected file at ${path}, got directory`);

  return {
    exists: true,
    sha: payload.sha,
    data: JSON.parse(decodeBase64Utf8(payload.content || ""))
  };
}

async function putGitHubJson(path, data, message, sha) {
  const repoUrl = await getRepoUrl();
  const headers = await getGitHubHeaders();
  let currentSha = sha;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${repoUrl}/contents/${path}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message,
        content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
        ...(currentSha ? { sha: currentSha } : {})
      })
    });

    if (response.ok) return await response.json();

    const errorMessage = await parseGitHubError(response);
    const isConflict =
      response.status === 409 ||
      response.status === 422 ||
      errorMessage.toLowerCase().includes("sha") ||
      errorMessage.toLowerCase().includes("conflict");

    if (attempt >= 2 || !isConflict) throw new Error(errorMessage);

    console.warn(`Bookmark Sync: Conflict on ${path} (attempt ${attempt + 1}), retrying...`);
    await sleep(200 + Math.random() * 1300);

    const existing = await fetchGitHubJson(path);
    currentSha = existing.exists ? existing.sha : undefined;
  }

  throw new Error(`Failed to write ${path}`);
}

// ─── History Utilities ────────────────────────────────────────────────────────

async function deleteGitHubFile(path, sha, message) {
  const repoUrl = await getRepoUrl();
  const headers = await getGitHubHeaders();
  const response = await fetch(`${repoUrl}/contents/${path}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ message, sha })
  });
  if (!response.ok) {
    const msg = await parseGitHubError(response);
    throw new Error(`Delete ${path}: ${msg}`);
  }
}

/**
 * Save a snapshot of existingData to history and prune old snapshots.
 * Called after writing a new main file so orphans are never created.
 */
async function saveHistorySnapshot(profileKey, existingData, maxVersions) {
  if (!maxVersions || maxVersions <= 0) return;

  // Use the existing data's own timestamp as the version id (represents when it was synced).
  // Use current time for the filename to ensure uniqueness even on clock-tied syncs.
  const versionId  = existingData.timestamp || new Date().toISOString();
  const fileTs     = new Date().toISOString();
  const filePath   = historyFilePath(profileKey, fileTs);

  // Write the snapshot
  let snapshotSha;
  try {
    const written = await putGitHubJson(
      filePath,
      existingData,
      `history [${profileKey}]: ${versionId}`,
      undefined // always a new file
    );
    snapshotSha = written?.content?.sha;
  } catch (e) {
    console.warn("Bookmark Sync: Could not write history snapshot:", e.message);
    return;
  }

  // Read-modify-write history index
  const idxPath      = historyIndexPath(profileKey);
  const existingIdx  = await fetchGitHubJson(idxPath);
  const versions     = existingIdx.exists ? (existingIdx.data.versions || []) : [];

  versions.push({
    id:        versionId,
    file:      filePath.split("/").pop(),
    sha:       snapshotSha,
    count:     existingData.count || 0,
    timestamp: versionId
  });

  // Prune: keep only the newest maxVersions entries (oldest are at front of array)
  const toDelete = versions.length > maxVersions
    ? versions.splice(0, versions.length - maxVersions)
    : [];

  await putGitHubJson(
    idxPath,
    { versions },
    `history-index [${profileKey}]: ${versions.length} snapshot${versions.length !== 1 ? "s" : ""}`,
    existingIdx.exists ? existingIdx.sha : undefined
  );

  // Delete pruned files (best-effort)
  for (const old of toDelete) {
    const oldPath = `bookmarks/${profileKey}/history/${old.file}`;
    try {
      let sha = old.sha;
      if (!sha) {
        const f = await fetchGitHubJson(oldPath);
        sha = f.exists ? f.sha : null;
      }
      if (sha) await deleteGitHubFile(oldPath, sha, `prune history [${profileKey}]`);
    } catch (err) {
      console.warn(`Bookmark Sync: Could not prune ${old.file}:`, err.message);
    }
  }

  console.log(`Bookmark Sync: History snapshot saved (${versions.length} kept).`);
}

// ─── Bookmark Tree Utilities ──────────────────────────────────────────────────

/**
 * Build a clean, serialisable bookmark tree from Chrome's raw nodes.
 * Strips Chrome-internal IDs; preserves folder hierarchy.
 */
function buildBookmarkTree(nodes) {
  const result = [];
  for (const node of nodes) {
    if (node.url) {
      result.push({
        type: "bookmark",
        title: node.title || node.url,
        url: node.url,
        dateAdded: node.dateAdded || 0
      });
    } else if (node.children !== undefined) {
      result.push({
        type: "folder",
        title: node.title || "Untitled",
        children: buildBookmarkTree(node.children)
      });
    }
  }
  return result;
}

/**
 * Recursively flatten tree nodes into a list for signature computation.
 */
function flattenForSignature(nodes) {
  const flat = [];
  for (const node of nodes) {
    if (node.type === "bookmark") {
      flat.push(node);
    } else if (node.type === "folder") {
      flat.push(...flattenForSignature(node.children || []));
    }
  }
  return flat;
}

/**
 * SHA-256 hash of all bookmark urls+titles. Used to detect changes.
 */
async function computeSignature(flatBookmarks) {
  const content = flatBookmarks.map((b) => `${b.url}|${b.title}`).join("\n");
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Profile Index ────────────────────────────────────────────────────────────

/**
 * Read-modify-write bookmarks/index.json to keep a registry of all known profiles.
 * Returns the updated profiles array.
 */
async function updateProfileIndex(profileKey, profileName, count) {
  const existing = await fetchGitHubJson(INDEX_PATH);
  const profiles = existing.exists ? (existing.data.profiles || []) : [];

  const entry = {
    key: profileKey,
    name: profileName || profileKey,
    lastSync: new Date().toISOString(),
    count
  };

  const idx = profiles.findIndex((p) => p.key === profileKey);
  if (idx >= 0) {
    profiles[idx] = entry;
  } else {
    profiles.push(entry);
  }

  await putGitHubJson(
    INDEX_PATH,
    { profiles },
    `index: ${profileKey} (${count} bookmarks)`,
    existing.exists ? existing.sha : undefined
  );

  return profiles;
}

// ─── Main Sync Function ───────────────────────────────────────────────────────

async function syncBookmarksToGitHub() {
  console.log("Bookmark Sync: Starting sync...");

  // 1. Read Chrome bookmarks — tree[0] is the virtual root, skip it
  const chromeTree = await chrome.bookmarks.getTree();
  const tree = buildBookmarkTree(chromeTree[0].children || []);
  const flat = flattenForSignature(tree);
  const signature = await computeSignature(flat);

  // 2. Fetch current file from GitHub — need SHA for update, and to detect deletion
  const bookmarksPath = await getBookmarksPath();
  const profileKey = await getProfileKey();
  const existing = await fetchGitHubJson(bookmarksPath);

  // 3. Skip write only if file exists on GitHub AND content hasn't changed
  const { lastSyncSignature } = await chrome.storage.local.get("lastSyncSignature");
  if (existing.exists && lastSyncSignature === signature) {
    console.log("Bookmark Sync: No changes, skipping write.");
    await chrome.storage.sync.set({
      lastSyncTime: new Date().toISOString(),
      lastSyncStatus: "success (no changes)"
    });
    return { success: true, changed: false };
  }

  // 4. Write hierarchical tree to GitHub
  const payload = {
    timestamp: new Date().toISOString(),
    profile: profileKey,
    signature,
    count: flat.length,
    tree
  };

  await putGitHubJson(
    bookmarksPath,
    payload,
    `sync [${profileKey}]: ${flat.length} bookmarks`,
    existing.exists ? existing.sha : undefined
  );

  // 5. Save history snapshot (copy of the state that was just overwritten)
  if (existing.exists) {
    const { maxVersions } = await chrome.storage.sync.get("maxVersions");
    // Default to 10 if the user has never saved the setting
    const maxV = maxVersions != null ? Number(maxVersions) : 10;
    if (maxV > 0) {
      try {
        await saveHistorySnapshot(profileKey, existing.data, maxV);
      } catch (e) {
        console.warn("Bookmark Sync: History snapshot failed:", e.message);
      }
    }
  }

  // 6. Update the shared profile index (bookmarks/index.json)
  const { profileName } = await chrome.storage.sync.get("profileName");
  const updatedProfiles = await updateProfileIndex(profileKey, profileName, flat.length);

  // 7. Update local cache
  await chrome.storage.local.set({
    lastSyncSignature: signature,
    cachedTree: tree,
    cachedProfiles: updatedProfiles,
    cacheTimestamp: new Date().toISOString()
  });

  await chrome.storage.sync.set({
    lastSyncTime: new Date().toISOString(),
    lastSyncStatus: "success"
  });

  console.log(`Bookmark Sync: Synced ${flat.length} bookmarks (profile: ${profileKey}).`);
  return { success: true, changed: true, count: flat.length };
}

console.log("Bookmark Sync: Service Worker ready.");
