# Privacy Policy for Bookmark Sync

**Effective Date:** April 3, 2026

## 1. Introduction
Bookmark Sync is a browser extension designed to help you synchronize your browser bookmarks to a private GitHub repository. Your privacy is our priority. This document explains how your data is handled.

## 2. Data Collection and Usage
Bookmark Sync is designed to be as private as possible.
*   **No Personal Data Collected**: We do not collect, store, or transmit any of your personal data to our own servers or any third party, except for GitHub as part of the core functionality.
*   **Local Storage**: Your configuration settings, including your GitHub Personal Access Token (PAT), username, and repository name, are stored locally in your browser using `chrome.storage.sync` and `chrome.storage.local`. 
*   **Data Transmission**: The extension reads your browser bookmarks and transmits them directly to the GitHub repository you have configured. This communication happens exclusively between your browser and the GitHub API.

## 3. Permissions Required
The extension requires the following permissions to function:
*   `bookmarks`: To read your bookmark tree so it can be synced to GitHub.
*   `storage`: To save your settings and cache data for faster searching.
*   `alarms`: To perform periodic background synchronization if enabled.
*   `https://api.github.com/*`: To communicate with the GitHub API to save and retrieve your bookmark data.

## 4. Third-Party Services
The only third-party service used by this extension is **GitHub**. 
*   Your bookmark data and GitHub token are sent to GitHub to facilitate the sync.
*   We recommend using a **Private Repository** on GitHub to ensure your bookmarks are not visible to the public.
*   Please review [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement) for information on how they handle data.

## 5. Security
*   Your GitHub Personal Access Token is stored securely in your browser's extension storage.
*   We recommend using a "Fine-grained token" with the minimum necessary permissions (read/write access to code/contents in your specific repository).

## 6. User Control
You can stop the extension from syncing at any time by:
1. Disabling the extension.
2. Removing your GitHub token from the extension settings.
3. Deleting the extension, which will remove all locally stored settings.

## 7. Changes to This Policy
We may update this Privacy Policy from time to time. Any changes will be reflected by the "Effective Date" at the top of this document.

## 8. Contact
If you have any questions about this Privacy Policy, please contact the developer via the support link on the GitHub repository or the Chrome Web Store listing.
