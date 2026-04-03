# Chrome Web Store Submission Details

## 🎯 Single Purpose
**Statement:**
"Synchronize, back up, and search your browser bookmarks across devices using a private GitHub repository as the storage engine."

---

## 🔑 Permission Justifications

| Permission | Justification |
| :--- | :--- |
| **bookmarks** | "Required to read the user's bookmark hierarchy so it can be synchronized to their configured GitHub repository." |
| **storage** | "Used to securely store user settings (GitHub tokens) and to cache the bookmark tree locally for high-performance searching." |
| **alarms** | "Required to trigger automated synchronization cycles in the background at the user's preferred interval." |
| **https://api.github.com/*** | "Essential for communicating with the GitHub API to upload bookmark snapshots and retrieve cross-profile data." |

---

## 📜 Remote Code
**Question:** Are you using remote code?
**Answer:** **No**
*(The extension only runs code bundled within the package and does not use `eval()` or fetch execution logic from external servers.)*

---

## Data Types 

1.  **Authentication Information**
    *   *Why?* The extension stores the user's **GitHub Personal Access Token (PAT)** locally to authenticate with their GitHub account.
2.  **Website Content**
    *   *Why?* The extension reads **Bookmark Titles and URLs** to facilitate the synchronization.
