<div align="center">
  <img src="assets/app-icon.svg" alt="Lore Client app icon" width="112" height="112">
  <h1>Lore Client</h1>
  <p><strong>A visual desktop workspace for <a href="https://github.com/EpicGames/lore">Epic Games Lore</a>.</strong></p>
  <p>Explore revisions, prepare changes, and manage large game projects and binary assets in one focused workspace.</p>
  <p>
    <img src="https://img.shields.io/badge/status-preview-d99a2b" alt="Project status: Preview">
    <img src="https://img.shields.io/github/package-json/v/ArnoChenFx/lore-client?color=78a4ff&amp;label=version" alt="Version from package.json">
    <img src="https://img.shields.io/badge/desktop-Tauri%202-24c8d8?logo=tauri&amp;logoColor=white" alt="Desktop framework: Tauri 2">
    <img src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-59636e" alt="Platforms: Windows, Linux, and macOS">
    <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-MIT-3f8f6b" alt="License: MIT"></a>
  </p>
  <p>English · <a href="docs/zh/README-zh.md">简体中文</a></p>
</div>

---

![Lore Client revision history](docs/img/lore-client-revision-history-dark.png)

## What you can do

### Explore project history

Revision History opens in Flat mode by default, focusing on the current branch’s revisions, its local/remote pointers, and the exact workspace HEAD. Switch to the multi-lane topology graph to follow merged lines of work and inspect revision messages, authors, labels, verification status, changed files, and complete file trees. Filter topology history by starting revision, branch, date, or branch ancestry, tune shared Diff context and whitespace preferences, and collapse or restore the revision Diff pane independently. Your lane presentation is remembered across restarts.

---

### Prepare and commit changes

Review local changes in a flat list or folder tree, select files and directories with familiar desktop shortcuts, stage or unstage them, inspect file Diffs, independently collapse or restore the right-side Diff pane, and create a new revision with the intended identity and message. File context menus also expose advisory collaborative-lock status and actions, with branch-wide management in Repository Tools.

Configure multiple External Diff and External Merge tools from client settings. Built-in presets resolve command names from the system `PATH`, custom tools may use explicit executable paths and argument templates, and only tools that are actually available appear in file menus. Local Changes and Revision Changes can launch two-file comparisons; conflict files can launch a four-way merge with temporary BASE, LOCAL, and REMOTE versions when those files are not present in the workspace.

![Local changes, staging areas, and file Diff](docs/img/lore-client-local-changes-light.png)

---

### Manage branches, labels, and conflicts

Work with local, remote, and archived branches without losing track of the current checkout. Create and switch branches, merge lines of work, cherry-pick or revert revisions, compare branches, and create or manage labels. Guided conflict sessions help you resolve, restart, or abort Merge, Cherry-pick, and Revert operations.

![Branch overview and revision file tree](docs/img/lore-client-branch-overview-dark.png)

---

### Work with large and composite repositories

- Edit and apply selective Views for the files needed in the current workspace.
- Explore exact file dependency graphs in both directions, pan freely with the left mouse button, zoom around the pointer with the wheel, inspect tagged edges and cycles, and configure dependency-driven Clone or Sync with guided scope controls.
- Clone an exact Revision or Branch, create a Bare workspace, opt into Direct File I/O for compatibility diagnostics, and compose an initial Layer with an optional Revision-matching metadata key.
- Inspect and manage Layers and linked repositories.
- Preview modern DDS/KTX2/EXR textures, WAV/OGG/MP3/FLAC audio, ZIP/PAK/AssetBundle and Godot PCK directories, TTF/OTF fonts, common 3D assets, editor-embedded Blender and Unreal thumbnails, and Unreal/Unity/Godot/Blender metadata inside the app.

---

### Manage repositories from one place

Open or initialize local repositories, browse a Lore server with repository descriptions, inspect remote details before cloning, publish existing work with the connected repository description prefilled, Sync and Push branches, and follow operation progress from a shared activity view. Publishing can use any signed-in account or explicitly proceed without one on anonymous servers. The device-level Accounts center manages multiple Lore identities, keeps JWTs inside Lore's credential store, and assigns different accounts to different local repositories. Protected server browsing opens browser authentication when credentials are required and retries automatically.

Repository Configuration is the only place that persistently changes a repository's server. The server browser, account sign-in form, and Shared Store form use independent temporary targets.

---

### Use a desktop workspace that remembers you

Keep multiple repositories open in tabs, resize and restore your layout, switch between light and dark themes, and use keyboard-accessible menus and navigation. The interface is available in English and Simplified Chinese.

For troubleshooting, bounded application logs collect command timing and errors in the platform log directory; open that fixed location directly from Client Settings → Maintenance.

---

## Get started

1. Download the build for Windows x64, Linux x64, or macOS Universal from this repository's Releases page.
2. Launch Lore Client and open an existing Lore repository, initialize a regular folder, or connect to a Lore server and clone a repository.
3. Start with Revision History to understand the project, Local Changes to prepare the next revision, and Branch Overview to manage lines of work.

Lore is included with the desktop application, so a separate Lore CLI installation is not required. Server browsing, Clone, Publish, Push, and other online features require access to a Lore service.

---

## Preview status

Lore Client is still under active development. Test important workflows before using it for production repositories.

---

## Documentation

- [User manual](docs/en/manual/README.md)
- [Developer guide](docs/en/DEVELOPMENT.md)
- [中文说明](docs/zh/README-zh.md)
- [中文使用手册](docs/zh/manual/README.md)
- [中文开发者指南](docs/zh/DEVELOPMENT.md)
