# 🔖 Bookmark Sync

A Chrome extension that syncs your bookmarks to a private GitHub repository — with full folder hierarchy, multi-device profiles, version history, and a fast search UI.

---

## Features

- **Sync to GitHub** — saves your full bookmark tree (folders + bookmarks) to a private repo on a schedule or on demand
- **Multi-device profiles** — each device writes to its own folder; switch between profiles in the popup to browse any device's bookmarks
- **Version history** — every sync that detects a change snapshots the previous state; browse and search across historical versions
- **Version diff** — a dedicated page that compares any two versions of a profile and shows exactly which bookmarks were added, removed, or changed
- **Search** — fuzzy multi-token search across title, URL, and folder path; results ranked by relevance
- **Folder navigation** — browse the full folder tree with breadcrumbs; click any path segment in search results to jump directly to that folder
- **Export** — download your bookmarks as a Netscape HTML file (importable in any browser)
- **Dark / light theme**

---

## Setup

1. **Create a private GitHub repository** to store your bookmarks.

2. **Generate a Personal Access Token** at [GitHub Settings → Personal access tokens](https://github.com/settings/tokens).  
   Fine-grained token with **read access to metadata** and **read/write access to contents**.

3. **Load the extension** in Chrome:  
   `chrome://extensions` → Enable *Developer mode* → *Load unpacked* → select this folder.

4. **Open Settings** (⚙️) and fill in:
   - GitHub username and repository name
   - Personal Access Token
   - Profile Name (e.g. *Work Laptop*, *Home iMac*)
   - Auto-sync interval (minutes; 0 to disable)
   - History snapshots to keep (0 to disable)

5. Click **Save Settings** — an initial sync runs automatically.

---

## Repository Structure

```
bookmarks/
  index.json                          ← registry of all known profiles
  {profile-folder}/
    bookmarks.json                    ← current bookmark tree
    history/
      index.json                      ← list of snapshots with metadata
      {timestamp}.json                ← individual snapshots
```

Each device uses a separate profile folder so multiple devices never overwrite each other.

---

## Timeline / Version History

Every time a sync detects changes, the **previous state is saved as a snapshot** before being overwritten. The number of snapshots kept per profile is configurable in Settings (default: 10).

In the popup, use the **timeline dropdown** to:

| Selection | Behavior |
|-----------|-----------|
| Current | Your live bookmarks (default) |
| All versions | Search across every version; removed bookmarks shown with a 🗑️ badge |
| A specific date | Browse and search that snapshot; export it as HTML |

## Version Diff

To see **what changed** between two versions at a glance, open the **Compare Versions** page (🔀 in the popup header, or the *Compare Versions* button in Settings).

1. Pick a **profile**.
2. Pick a **base** version (older) and a **compare** version (newer).
3. Click **Compare**.

The page groups the differences into **Added**, **Removed**, and **Changed** sections, with a summary bar showing the counts. Changed bookmarks show the old → new title and folder path inline, and every row has an **Open** button to jump to the URL.

---

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3) |
| `src/background/background.js` | Service worker — GitHub API, sync logic, history management |
| `src/popup/popup.html` | Search & browse UI |
| `src/options/options.html` | Settings page |
| `src/diff/diff.html` | Version diff page (compare two snapshots) |
| `src/styles/styles.css` | Shared styles (dark + light theme) |
| `assets/icons/` | Extension icons (16, 48, 128 px) |
| `generate-icons.js` | Script used to generate the PNG icons from scratch |
| `PRIVACY_POLICY.md` | Privacy Policy for Chrome Web Store registration |
