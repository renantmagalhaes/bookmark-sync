/**
 * Options Script for Bookmark Sync
 */

async function applyStoredTheme() {
  const { themePreference } = await chrome.storage.sync.get("themePreference");
  document.documentElement.setAttribute("data-theme", themePreference || "dark");
}

function formatDate(date, fmt) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (fmt === "mdy") return `${m}/${d}/${y} ${hh}:${mm}`;
  if (fmt === "ymd") return `${y}-${m}-${d} ${hh}:${mm}`;
  return `${d}/${m}/${y} ${hh}:${mm}`;
}

function slugifyProfileKey(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get([
    "githubUsername",
    "githubRepo",
    "githubToken",
    "profileName",
    "profileKey",
    "syncInterval",
    "maxVersions",
    "lastSyncTime",
    "lastSyncStatus",
    "dateFormat"
  ]);
  const local = await chrome.storage.local.get(["cachedTree", "cacheTimestamp"]);

  if (settings.githubUsername)
    document.getElementById("githubUsername").value = settings.githubUsername;
  if (settings.githubRepo)
    document.getElementById("githubRepo").value = settings.githubRepo;
  if (settings.githubToken)
    document.getElementById("githubToken").value = settings.githubToken;
  if (settings.profileName)
    document.getElementById("profileName").value = settings.profileName;

  const derivedKey =
    settings.profileKey ||
    slugifyProfileKey(settings.profileName) ||
    "";
  if (derivedKey)
    document.getElementById("profileKey").value = derivedKey;

  if (settings.syncInterval !== undefined)
    document.getElementById("syncInterval").value = settings.syncInterval;

  if (settings.maxVersions !== undefined)
    document.getElementById("maxVersions").value = settings.maxVersions;

  document.getElementById("dateFormat").value = settings.dateFormat || "dmy";

  const fmt = settings.dateFormat || "dmy";

  if (settings.lastSyncTime) {
    const d = new Date(settings.lastSyncTime);
    const status = settings.lastSyncStatus || "";
    document.getElementById("lastSyncDisplay").textContent =
      `Last sync: ${formatDate(d, fmt)} — ${status}`;
  } else {
    document.getElementById("lastSyncDisplay").textContent = "No syncs yet";
  }

  if (derivedKey) {
    document.getElementById("profileKeyDisplay").textContent =
      `GitHub path: bookmarks/${derivedKey}/bookmarks.json`;
  }

  if (local.cachedTree) {
    const count = countBookmarksInTree(local.cachedTree);
    document.getElementById("bookmarkCountDisplay").textContent =
      `Cached bookmarks: ${count}`;
  }
}

function countBookmarksInTree(nodes) {
  let count = 0;
  for (const node of nodes) {
    if (node.type === "bookmark") count++;
    else if (node.type === "folder") count += countBookmarksInTree(node.children || []);
  }
  return count;
}

async function saveSettings() {
  const form = document.getElementById("settingsForm");
  if (!form.checkValidity()) {
    showMessage("Please fill in all required fields.", "error");
    return false;
  }

  const rawKey = document.getElementById("profileKey").value.trim();
  const rawName = document.getElementById("profileName").value.trim();
  const profileKey = slugifyProfileKey(rawKey || rawName) || "default";

  if (!profileKey) {
    showMessage("Please enter a Profile Name or Profile Folder.", "error");
    return false;
  }

  const settings = {
    githubUsername: document.getElementById("githubUsername").value.trim(),
    githubRepo: document.getElementById("githubRepo").value.trim(),
    githubToken: document.getElementById("githubToken").value.trim(),
    profileName: rawName,
    profileKey,
    syncInterval: parseInt(document.getElementById("syncInterval").value, 10),
    maxVersions: Math.max(0, parseInt(document.getElementById("maxVersions").value, 10) || 0),
    dateFormat: document.getElementById("dateFormat").value
  };

  try {
    await chrome.storage.sync.set(settings);

    await chrome.runtime.sendMessage({
      action: "setupSync",
      intervalMinutes: settings.syncInterval
    });

    showMessage("✅ Settings saved. Triggering initial sync...", "success");

    try {
      const result = await chrome.runtime.sendMessage({ action: "syncBookmarks" });
      if (result && result.success) {
        const msg = result.changed
          ? `✅ Synced ${result.count} bookmarks to GitHub (${profileKey})!`
          : "✅ Synced — no changes since last sync.";
        showMessage(msg, "success");
        await loadSettings();
      } else {
        showMessage(`⚠️ Settings saved, but sync failed: ${result?.error || "Unknown error"}`, "error");
      }
    } catch (e) {
      showMessage(`⚠️ Settings saved, but could not connect to background: ${e.message}`, "error");
    }

    return true;
  } catch (error) {
    showMessage(`Error: ${error.message}`, "error");
    return false;
  }
}

async function testConnection() {
  const btn = document.getElementById("testConnection");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "⏳ Testing...";

  try {
    const username = document.getElementById("githubUsername").value.trim();
    const repo = document.getElementById("githubRepo").value.trim();
    const token = document.getElementById("githubToken").value.trim();

    if (!username || !repo || !token) {
      showMessage("Please fill in GitHub credentials first.", "error");
      return;
    }

    const response = await fetch(`https://api.github.com/repos/${username}/${repo}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json"
      }
    });

    if (response.ok) {
      const repoData = await response.json();
      if (repoData.private) {
        showMessage(`✅ Connected! Repo: ${repoData.full_name} (private)`, "success");
      } else {
        showMessage("⚠️ Repository is public — consider making it private for security.", "warning");
      }
    } else if (response.status === 401) {
      showMessage("❌ Unauthorized — check your token.", "error");
    } else if (response.status === 404) {
      showMessage("❌ Repository not found — check username and repo name.", "error");
    } else {
      const err = await response.json().catch(() => ({}));
      showMessage(`❌ Error: ${err.message || response.status}`, "error");
    }
  } catch (error) {
    showMessage(`❌ Connection failed: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function syncNow() {
  const btn = document.getElementById("syncNow");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "⏳ Syncing...";

  try {
    const result = await chrome.runtime.sendMessage({ action: "syncBookmarks" });
    if (result && result.success) {
      const msg = result.changed
        ? `✅ Synced ${result.count} bookmarks to GitHub!`
        : "✅ No changes — bookmarks are up to date.";
      showMessage(msg, "success");
      await loadSettings();
    } else {
      showMessage(`❌ Sync failed: ${result?.error || "Unknown error"}`, "error");
    }
  } catch (e) {
    showMessage(`❌ Sync failed: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function showMessage(text, type = "info") {
  const el = document.getElementById("message");
  el.textContent = text;
  el.className = `message ${type}`;
  if (type === "success") {
    setTimeout(() => {
      el.textContent = "";
      el.className = "message";
    }, 4000);
  }
}

// Auto-sync profileKey from profileName while untouched
function syncProfileKeyFromName() {
  const keyInput = document.getElementById("profileKey");
  if (keyInput.dataset.touched === "true") return;
  keyInput.value = slugifyProfileKey(
    document.getElementById("profileName").value
  );
}

// Wire up events
document.getElementById("settingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  saveSettings();
});

document.getElementById("showToken").addEventListener("change", (e) => {
  document.getElementById("githubToken").type = e.target.checked ? "text" : "password";
});

document.getElementById("testConnection").addEventListener("click", testConnection);
document.getElementById("syncNow").addEventListener("click", syncNow);

document.getElementById("profileName").addEventListener("input", syncProfileKeyFromName);

document.getElementById("profileKey").addEventListener("input", (e) => {
  e.target.dataset.touched = e.target.value.trim() ? "true" : "false";
  e.target.value = slugifyProfileKey(e.target.value);
});

document.addEventListener("DOMContentLoaded", async () => {
  await applyStoredTheme();
  await loadSettings();
});
