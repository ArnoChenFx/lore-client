# Client Settings Reference

Client Settings has General, Default Commit Identity, Integrations, Storage, and
Maintenance. Most changes apply and persist immediately without a Save button.

![Lore Client General settings page in English](../../img/lore-client-settings-general-en.png)

_Choose a category on the left; the current category is shown on the right, and language or theme changes apply immediately._

## 1. General

### Appearance

Choose Use System Setting, Dark, or Light. Theme does not affect repository content.

### Interface Language

Choose Simplified Chinese (`zh-CN`) or English (`en-US`). It changes immediately. With
no saved preference, an operating-system language beginning with `zh` selects Chinese;
other recognized languages select English.

## 2. Default Commit Identity

Enter Author name (up to 240 characters) and Email (up to 254), or **Clear**. It is
encoded as a Lore identity and used only when the repository has no identity.

Priority is repository identity, client default, then structured failure. The default is
not written back into a repository and never replaces historical authors. Gravatar is
requested transiently from email; text and local initials remain when unavailable.

## 3. Integrations

Configure separate **External Merge Tools** and **External Diff Tools**. Add Visual Studio
Code, Cursor, Beyond Compare, P4Merge, or Custom. Each group supports several tools.

### List actions

Select a row to edit. **Add external tool** creates a preset/custom entry. **Set as
primary** controls the default context-menu tool. **Remove** deletes it, promoting the
next entry when needed. Availability shows whether the command resolves on this system.

### Tool name and executable

Name is user-facing and limited to 128 characters. Executable accepts an absolute path
or a command resolved from system `PATH`; **Choose** opens a file picker. Do not put
arguments in this field.

### Argument template

Each line is one independent argument and never passes through a Shell.

Diff requires:

- `{before}` and `{after}`;
- optional `{beforeLabel}` and `{afterLabel}`.

Merge requires:

- `{base}`, `{local}`, `{remote}`, and `{merged}`;
- optional corresponding `*Label` title placeholders.

An empty name/command or missing required placeholder marks the configuration incomplete
and prevents a silent incorrect launch.

## 4. Storage

### Use Shared Store automatically

Lore reuses one Fragment Store by remote for future Clones. Existing repositories are not
silently migrated, and the current supported Lore version cannot turn it off per Clone.

### Refresh

Rescans configured Stores, size, file count, directory existence, and scan errors.

### Create Shared Store

| Parameter                         | Meaning                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| **Target server**                 | Required, e.g. `lore://127.0.0.1:41337`; used only for this creation. |
| **Device-level parent directory** | Optional; blank uses Lore’s default location.                         |
| **Choose/Clear**                  | Select or reset the parent.                                           |
| **Create Shared Store**           | Create, then reload status; disabled with no target server.           |

This server does not edit repository configuration or the server browser’s temporary
address.

The summary shows Store count and current unique Fragment usage. Lore Client does not
display invented savings without a reliable non-deduplicated baseline. Each row reports
remote, local path, size/file count, missing directory, and scan errors.

## 5. Maintenance

### Workspace panes

**Restore defaults** resets sidebar and Inspector widths only. It does not clear
repositories, theme, language, View, selection, or history.

### Application Logs

The desktop app writes startup events, IPC command names and durations, outcomes, and
unhandled errors to `lore-client.log`. **Open Log Directory** opens the fixed platform
location in the system file manager:

- Windows: `%LOCALAPPDATA%\com.lore.client\logs`;
- macOS: `~/Library/Logs/com.lore.client`;
- Linux: `$XDG_DATA_HOME/com.lore.client/logs`, or
  `~/.local/share/com.lore.client/logs` when XDG data home is unset.

Each file is limited to 5 MiB, with five active or rotated files retained in total. Lore
Client does not log IPC arguments and redacts common Token, JWT, password, and URL
credential patterns. Logs can still contain local repository paths or error details, so
review them before sharing. Browser demo mode does not create log files.

### Application Updates

**Automatically check for updates** is enabled by default. When disabled, release desktop builds do not query GitHub
Releases after startup;

The section reports current version, checking, up-to-date, available, check failure,
install failure, or an unsupported runtime. **Check for updates** is available in a
desktop release with no update task running. **Download, install, and restart** exits the
current application, so finish or save active work first.

## Scope boundaries

| Setting                                                          | Scope                                   |
| ---------------------------------------------------------------- | --------------------------------------- |
| Theme, language, layout, external tools, automatic update checks | This device/client                      |
| Default identity                                                 | This device; fallback only              |
| Shared Store automatic policy                                    | This device                             |
| Repository identity and remote URL                               | Current repository, in Repository Tools |
| Server browsing address                                          | Current dialog only                     |
| Clone advanced parameters                                        | One Clone only                          |

[Previous: Repository Tools](08-repository-tools-reference.md) · [Next: Troubleshooting](10-troubleshooting-and-safety.md)
