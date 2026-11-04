# Git Baba — Security-First Git Desktop Client

Git Baba is an Electron + TypeScript + React desktop app for managing local Git repositories with one central rule:

> **No commit or push happens silently.** Every operation follows **Review → Authenticate → Confirm → Commit/Push.**

It supports multiple repositories, a guided "new repository" workflow, a line-level diff viewer, staging, branches, stash, fetch, a **pull security review** (fetch → scan → confirm → integrate the exact reviewed commit), conflict resolution, GitHub pull requests, and **GitHub App installation tokens** that are generated per operation, scoped to one repository and revoked right after use.

---

## Contents

- [Installation](#installations)
- [Development](#development)
- [Build & packaging](#build--packaging)
- [Configuration](#configuration)
- [Using the app](#using-the-app)
- [Security model](#security-model)
- [GitHub App setup](#github-app-setup)
- [Architecture](#architecture)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Installation

Requirements:

- **Node.js 20+** (developed with Node 26)
- **Git 2.30+** on your `PATH` (`git --version`)
- Windows 10+, macOS 12+, or a Linux desktop. On Linux, saving credentials requires a keyring (GNOME Keyring / KWallet).

```bash
npm install
```

npm 11 may report that some packages' install scripts are not approved (for example `electron-winstaller`). They are not needed for development. The Electron binary downloads on first launch.

## Development

```bash
npm run dev
```

This starts three processes:

| Process | What it does |
| --- | --- |
| `dev:renderer` | Vite dev server for the React UI on `http://127.0.0.1:5173` |
| `dev:main` | `tsc --watch` for the main process and preload |
| `dev:electron` | Waits for both, then runs `electron . --dev` |

The main process is not hot-reloaded. Restart `npm run dev` after changing `src/main`.

Other scripts:

```bash
npm run typecheck   # main + renderer TypeScript checks
npm test            # unit + integration tests (vitest)
npm start           # production build, then launch
```

For isolated manual testing (development builds only), you can point the app at a separate data folder:

```bash
GG_USER_DATA_DIR=/tmp/gg-data npm start
```

## Build & packaging

```bash
npm run build   # dist/main (tsc) + dist/renderer (vite)
npm run dist    # build + electron-builder installers in release/
```

Targets are configured in `package.json → build`: NSIS (Windows), DMG (macOS), AppImage (Linux). Code signing and notarisation are not configured. Add your certificates through electron-builder's environment variables before distributing.

## Configuration

All configuration happens inside the app. Nothing needs editing by hand.

| Where | What is stored | Contains secrets? |
| --- | --- | --- |
| `<userData>/repositories.json` | Repository list, paths, per-repo settings, GitHub App ID/owner/repo/installation ID | No |
| `<userData>/history.json` | Operation history (time, repo, operation, status, summary) | No. Every summary is passed through the redaction filter. |
| `<userData>/secrets/<repoId>.bin` | **Only if you opt in:** PAT and/or GitHub App private key, encrypted with the OS keychain | Yes, encrypted |
| `<userData>/discard-backups/` | Copies of files taken just before a confirmed "discard changes" | Your file contents |

`<userData>` is `%APPDATA%\Git Baba` on Windows, `~/Library/Application Support/Git Baba` on macOS, and `~/.config/Git Baba` on Linux.

**Per-repository settings** (Settings tab):

- **Run repository Git hooks.** Off by default.
- **Allow saving credentials for this repository.** Off by default. Only possible when OS encryption is available. Turning it off deletes saved credentials.
- **GitHub App details** (App ID, owner, repository, installation ID) prefill auth dialogs. The private key is never stored here.
- **GitHub Enterprise API URL**, for example `https://ghe.example.com/api/v3`.

## Using the app

0. **Layout.** The left sidebar lists only repositories, as *name* plus *account, owner* (e.g. `jahedul-hasan-kaz, inride` or `jahedul-hasan-kaz, personal`). It has a search box when the list grows, and a ✕ that removes a repository **from the app only**: the folder and `.git` are never deleted. The header holds global pages (GitHub App Token, Accounts, Operation History, Git Help) and the **GitHub Account** switcher.
1. **Add a repository** from the sidebar with **+ Add**:
   - **Open existing.** The app detects the repository, remote, branch, GitHub owner/repository, and the matching account (personal account or organisation membership). It never asks you to re-authenticate.
   - **Create repository.** A step-by-step state machine: information → summary → **authenticate the selected account** → validate account and permission → validate the name → create the GitHub repository → create the local repository → configure the remote → status check → ready. Every step shows ✓/✗ with a reason. Retry continues from the failed step after inspecting the current state, so a GitHub repository is never created twice. Targeted fixes are offered, such as "point origin to …", "use the existing repository" or "create it anyway". Half-finished states are explained (e.g. "the GitHub repository was created, but the local setup failed — Retry Local Setup"). A *local-only* option skips GitHub entirely.
   - **Clone repository.** Select an account (or another method such as SSH or a GitHub App token) → **Authenticate & Clone** → access is verified through the API → clone with live progress (Receiving objects / Resolving deltas) and Cancel → verify → the repository is added to the list. A folder left by a cancelled clone is only removed if you confirm.
2. **Changes tab.** Staged, unstaged, untracked and conflicted files, each with a status letter (M/A/D/R/U/!). Click a file to see a unified or side-by-side diff. You can stage or unstage single files or everything. Discarding always asks for confirmation and saves a backup first.
3. **Commit.** Write a message and click **Review & Commit**. The dialog shows the repository, branch, files, author identity, hook status and expected result. You also choose how the commit is recorded: **Git identity only (unsigned)** or **GPG signed** (GPG may ask for its passphrase in its own window). Commits are local and need no token or SSH key. Then confirm.
4. **Push.** Shows the repository, branch, remote and remote branch, the commits and files, and the expected result (the exact commit id). You then pick an authentication method that applies to the remote:

   ```
   Authentication Method
   ├── Git identity only
   ├── SSH
   ├── GitHub App Installation Token
   └── Git Credential / PAT
   ```

   - **Git identity only:** pushes with this computer's existing Git setup (ssh-agent / `~/.ssh` keys for SSH remotes, Git Credential Manager for HTTPS). The app asks for no credentials, but you still review and confirm the push.
   - **SSH:** three ways to choose the key:
     - **Generate SSH key:** creates a new ed25519 (or ecdsa / rsa-4096) pair in `~/.ssh` with an optional passphrase. The passphrase reaches `ssh-keygen` through the askpass helper, never on a command line. Existing files are never overwritten. The public key is shown with Copy and "Add to GitHub…".
     - **Use existing key:** lists the `*.pub` keys in `~/.ssh` (the same content `type %USERPROFILE%\.ssh\id_ed25519.pub` shows) that have their private key next to them.
     - **Enter key manually:** see below.
     The dialog always shows **"Key that will be used"** (path, type, fingerprint, comment, passphrase yes/no) before you continue.

     For manual entry, paste your **public** key (`ssh-ed25519 AAAA…`) or load the `.pub` file. A public key cannot sign in by itself, so the app finds the **matching private key** on this computer (next to the `.pub` file, or in `~/.ssh`, matched by fingerprint), or lets you choose it. Then enter the key's passphrase. The passphrase is checked locally *before* pushing, so a typo gives "Incorrect Passphrase" instead of "Permission denied". The key location can be remembered per repository; the passphrase is asked every time. For GitHub HTTPS remotes, the SSH method pushes to the equivalent `git@github.com:` URL for that operation.
   - **GitHub App Installation Token:** either *generate a token for this operation* (scoped to this repository, revoked right after), or *use an installation token* you paste, or one you **generate instantly** in the dialog (shown masked, copyable, auto-revoked within 10 minutes).
   - For **GitHub repositories with an SSH remote** (`git@github.com:…`), token methods are offered too: that one push/fetch runs over the HTTPS equivalent URL, and the remote URL is not changed.

   Press **Authenticate & Push**. Credentials are always requested again for every push.
4a. **Push rejected by repository rules — guided resolution.** When GitHub refuses a push, the dialog shows exactly which rules were not met instead of a raw error. It covers `GH013` rulesets and secret-scanning push protection, `GH006` branch protection, and `GH001` large files.
   - **Every rule gets:**
     - GitHub's own words;
     - a plain explanation;
     - **what needs to change**;
     - the files (with line and commit) and commits involved. When GitHub doesn't list them, they're found locally: oversized files, restricted extensions or paths, merge commits, unsigned commits.
   - **"Undo this file's change…"** asks first ("This change is preventing the push"), showing the affected commits and the impact. Then:
     - the unpushed commits are recreated without that file's change, with the same messages, authors and dates, and every other change kept;
     - commits that only touched the file are dropped;
     - **your file on disk is never touched** — it becomes an uncommitted change you can fix;
     - other staged and unstaged work is preserved, commits already on GitHub are never changed, and a backup ref allows **Undo**.
   - **Re-check and push again:** the push review reloads, a local re-check marks each rule as *fixed locally*, *still present* or *GitHub decides*, and **Authenticate & Push again** pushes. GitHub's verdict stays final.
   - **Rules that can't be fixed locally** (pull request required, required checks or reviews, restricted branch, signatures, linear history, message or email patterns) get the alternative route: **Push to a new branch & open a pull request**, or Pull first. They also say who can change the rule (repository administrator or organisation owner). For a secret false positive, the app links to GitHub's own *allow secret* page; nothing is bypassed from the app.
4b. **GitHub App setup per repository.** After cloning or adding a GitHub repository, the app offers to link a GitHub App (**Set up GitHub App**, also in Settings). Owner and repository come from the remote. You enter the App ID once, and can optionally validate with the private key (the installation ID is detected) and save the key encrypted. Afterwards, auth dialogs pre-select the GitHub App and only ask for the key (or use the saved one).
4b2. **Branch tree & safe switching.**
   - **Branch tree:** local and remote branches are shown as a tree split on `/` (e.g. `feature/category/enhance` → feature › category › enhance).
     - Folders show branch counts and expand or collapse on click or with the keyboard (Enter/Space/←/→).
     - Expand all and Collapse all are available. Folder state is remembered per repository.
     - The current branch's folders open automatically. A filter box searches names and commit subjects and highlights matches.
     - Branch actions (Switch, Merge into current, Delete, Check out locally) sit on each leaf.
   - **Switching with uncommitted changes** opens a modal. Before anything changes, Git Baba predicts how every file fares on the target, read-only (`git stash create`, `git merge-tree`, `ls-tree`):
     - *comes along*: unchanged on the target;
     - *merges cleanly*: changed on both sides without overlap;
     - *conflict*: your changes and the target's overlap;
     - *exists on target*: an untracked file of yours also exists there.

     You then choose (the safest applicable option is recommended):
     - **Bring my changes along** (only offered when every file comes along);
     - **Stash, switch and re-apply**: conflicts are resolved interactively in the Conflicts tab (per block or per file, or in a manual editor), with a backup stash kept until you **Finish**;
     - **Stash and switch**: the target opens clean, and the changes wait in a named stash;
     - or commit first.

     **Undo** discards the half-merged state and either goes back to the original branch with your changes restored exactly, or stays on the target with the changes kept in the stash. With no uncommitted changes, switching happens directly.
4c. **Branches & Stash: merge, create & publish, delete.** Each operation asks for authentication every time, like push: **Unsigned (Git identity only)**, **SSH** or **GitHub App Installation Token**. Each one uses the same credential resolver as push, with nothing stored. Each preview is bound to the reviewed commits (single-use confirmation, checked again in the main process).
   - **Merge branches:**
     1. Pick the source and the target branch.
     2. Review the summary: fast-forward, merge commit or already up to date; the commits and files; and the conflicts predicted with `git merge-tree` (nothing is touched).
     3. Choose the authentication, then merge. The merge commit uses your Git identity (unsigned).
     4. The target can then be pushed and **verified on the remote**, and you can switch back to your branch.
     - Uncommitted changes block switching branches; nothing is changed in that case.
     - Conflicts stop the merge, nothing is pushed, and the Conflicts tab takes over.
     - If the merge succeeds but the push fails, that is reported separately.
   - **Merge recovery (Detect → Explain → Fix → Re-check → Merge / PR).** Before anything changes, the merge dialog runs a read-only diagnosis. Each finding is labelled *Branch history*, *Git conflict*, *Your working folder*, *Remote state*, *GitHub restriction* or *Authentication / permission*, explained in plain words, and comes with the fix the app can apply. The diagnosis covers:
     - the merge base: none means the branches have **unrelated histories**;
     - commits only on each side, and the files that differ (compared tree-to-tree when no merge base exists);
     - predicted conflicts;
     - uncommitted files;
     - whether the target is behind or has diverged from its remote, and whether the source is behind its own remote.

     Fixes and options:
     - **Fetch & re-check** uses the chosen authentication, then analyses again.
     - **Update target from remote** applies a safe fast-forward, refused if anything would be lost.
     - **Commit or stash** takes you to the Changes tab.
     - **Merge anyway** (`--allow-unrelated-histories`) is only offered for unrelated histories, explains the risk, and needs a tick.
     - **Conflicts** can stop for interactive resolution (the default), or be resolved automatically by keeping the target's or the source's side of each conflicting part (`-X ours` / `-X theirs`), with a warning.
     - **Merge into a new branch & open a pull request** creates `merge/<source>-into-<target>` from the target, merges, publishes and verifies it, then opens *Open a pull request* prefilled. The target is not touched, and GitHub's reviews, checks and protection rules still apply. This also works when GitHub can't compare the branches directly.

     Push failures are classified. For example, a protected branch offers the pull-request route instead. Nothing bypasses GitHub enforcement.
   - **Pull request diagnosis.** When GitHub can't compare two branches (it only answers 404), the app finds out why:
     - the repository isn't visible to the signed-in account;
     - the compare branch isn't on GitHub yet: **Fix: publish it**;
     - the base branch is missing;
     - the branches have **no common history**: **Fix: prepare a merge branch & continue**, after which the form switches to the published merge branch.

     GitHub's create errors are also translated into specific messages: no history in common, nothing to merge, PR already exists.
   - **Create & Publish:**
     1. Enter a name and pick the base.
     2. Choose the authentication.
     3. The branch is created at exactly the reviewed base commit. If you tick the option, your pending changes are committed on it (only when it starts from your current commit).
     4. The branch is pushed with upstream tracking, then the remote is asked where the branch points. Success is shown only if that matches. If publishing fails, the local branch is kept and reused on retry.
     - **Create locally** still creates a branch without pushing.
   - **Delete:** for local and/or remote branches. The dialog shows exactly which branch(es) will go.
     - The default branch is refused. A branch that isn't fully merged needs a forced delete and typing its name. Commits that would no longer be on any branch are counted and also need typing the name.
     - The remote branch is deleted first (protected branches and permission errors come back as clear messages, with nothing local changed), and its removal is verified. A remote branch that is already gone is reported as such.
     - The branch list refreshes afterwards.
5. **Pull (Review).** Authenticate the fetch. The app then downloads and scans the incoming changes, shows a security status, findings, commits and diffs, and asks you to confirm before it fast-forwards, merges or rebases to **exactly the reviewed commit**.
6. **Conflicts tab.** Appears during a merge or rebase. For each conflict block, Current and Incoming are shown side by side with an explanation. You can accept current, incoming or both, per block or per file, or edit the file manually. Then mark files as resolved, and either **Continue** (goes through commit confirmation) or **Abort** (restores the previous state).
6a. **Conflict resolution details.**
   - **Branch names everywhere:** the page always shows **Current** (e.g. `main`) and **Incoming** (e.g. `qa`). For a rebase these are the branch being rebased onto and *your commits from feature/x*; for a cherry-pick, the picked commit; for a branch switch, *your changes from …*. Every button carries the name ("Accept incoming (qa)").
   - **Bulk actions:** **Accept all incoming** / **Keep all current** for every unresolved file. A confirmation lists the files and offers "Also mark them as resolved". **Mark N resolved** marks every file that no longer has markers.
   - **Per file:** accept current or incoming for the whole file, decide block by block (current / incoming / both), or use the manual editor. Each file shows its state: conflict, in progress, ready to mark, or resolved.
   - **Undo:** before the first change to a file, Git Baba saves its original conflict (the three index versions and the file with its markers, kept as Git objects inside `.git`, valid only for this operation). **↶ Undo** restores it exactly, even after **Mark as resolved**, so the decision can be made again. These snapshots are removed when the operation is continued, aborted, finished or undone.
6b. **Git History tab** (GitLens-style, separate from the plain Log tab):
   - **Commit graph** with branch lanes, merge nodes, and badges for branch, remote, tag and HEAD.
   - **Filters:** branch (current / all / remotes / tags / a specific ref), author, date range, and message/SHA search.
   - **Commit details:** subject and body, SHA with Copy, author, email, date, clickable parents, files changed, +/−.
   - **Per-file diffs:** expand/collapse, search inside the changes (highlighted), copy path, view the file at that commit (read-only), and show it in its folder. Files are never *opened* with an external program, so repository scripts can't run.
   - **Navigation:** ↑/↓ between commits.
   - **⇄ Compare:** pick commits A and B to see added/removed/modified/renamed files and line changes.
7. **GitHub features** (repository tabs **Pull Requests**, **Actions**, **Security & Quality**). They load data as the account selected in the header. The first time, you **sign in** to that account with its token. The session stays in main-process memory only, and ends when you sign out (account menu), remove the account, quit, or after 12 hours. Each screen shows the repository, the signed-in account and your role. Controls you lack permission for are disabled with an explanation.
   - **Pull Requests:** open/closed/merged/all; filters for author, label, milestone, review status and assignee; search; sorting (best match, newest, oldest, recently/least recently updated, most/least commented); and "Load more" paging.
   - **New pull request:** pick base and compare branches, then see ahead/behind, the commits and an existing-PR warning. Add title, description, draft, reviewers, assignees, labels, and milestone, then check the "What will happen" summary. The original GitHub App / PAT create flow is still available ("Use GitHub App / PAT instead").
   - **PR details:**
     - **Conversation:** a timeline of comments, reviews, commits and events. You can edit the title, the description and your own comments. Review threads support reply, edit, resolve and unresolve.
     - **Commits:** commit diffs come from your local clone when available.
     - **Checks:** status, workflow, timing and required flag, plus logs and a re-run (confirmed).
     - **Files changed:** a file tree and diffs. Large diffs are collapsed and binary or too-large files are handled. You can comment on a file or a line.
     - **Sidebar:** reviewers with their review state, assignees, labels (with create), milestone and linked issues.
   - **Reviews:** "Start a review" collects pending comments. **Finish your review** summarises changed files, pending and existing comments, and checks. You choose Comment, Approve or Request changes; Approve and Request changes need a confirmation tick and are disabled on your own PR.
   - **Merge:** the Merge button is never disabled. It opens a **pre-merge check** with live passed/failed/pending/warning status for checks, reviews, conflicts, conversations, draft state, branch protection and rulesets. You then choose the merge method and authentication: the signed-in account, or a short-lived repository-scoped **GitHub App installation token** that is revoked afterwards. SSH is shown but disabled, because merges go through the API. You confirm explicitly. The merge is pinned to the reviewed head SHA, so newer pushes make GitHub refuse it. GitHub's answer is final: refusals are shown with GitHub's own reason, and success shows the merge commit SHA.
   - **Actions:** workflows and paged runs (filter by status and branch); run details with jobs, steps and logs; re-run all, re-run failed and cancel (each confirmed); and **Run workflow** with a form built from the workflow's `workflow_dispatch` inputs.
   - **Security & Quality:**
     - **Overview:** enable or disable Dependabot alerts and security updates (admin, confirmed).
     - **Code scanning** and **Code quality:** filters, alert details with rule help and instances, the local file at the flagged line, and dismiss with a reason or reopen.
     - **Dependabot:** advisory details, related Dependabot PRs (open them, or ask Dependabot to rebase or recreate them), and dismiss or reopen.
     - **Vulnerabilities:** open alerts grouped by advisory or rule.
     - **Configure workflows:** CodeQL, dependency review, Dependabot config, Scorecard, Super-Linter and secret scanning (guided). You see and can edit the exact file. An existing file is only replaced if you tick "Replace". By default the change goes through a new branch and pull request.
     - **Views:** table view with inline editing of text, number, date, single-select and iteration fields, plus reordering; board view grouped by a single-select or iteration field, with drag between columns.
     - **Items:** add an issue or PR (`owner/repo#123` or URL), add a draft, archive or restore, remove (confirmed), and set assignees.
     - **Fields:** add text, number, date or single-select fields. Saved views and iteration fields have to be created on GitHub, because the API doesn't support it.
8. **GitHub App Token page.** Generate a token for use in other tools (see below).
9. **Git Help Center.** Covers every command the app uses: what it does, when to use it, when not to, an example, the risks, and whether it changes files or talks to the remote.

---

## Security model

### Electron hardening

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (and `app.enableSandbox()`), `webviewTag: false`, `webSecurity: true`.
- A strict Content-Security-Policy in production (`script-src 'self'`, no remote content).
- The preload exposes **one** function, `gitGuardian.invoke(channel, payload)`, restricted to a channel allow-list. There is no raw `ipcRenderer`, no Node APIs and no event subscriptions.
- Every IPC handler checks that the sender is the app's own top-level frame, validates every field of the payload (`src/main/util/validate.ts`), and converts any failure into a friendly, redacted error. Stack traces never cross the bridge.
- Navigation, new windows, webviews and all permission requests (camera, notifications…) are denied. External links open only for `https://github.com`, GitHub docs and git-scm.com.
- DevTools are disabled in packaged builds.

### Git execution

- Git always runs with `spawn(git, args, { shell: false })`, so command arguments are never built as shell strings. User-supplied paths come after `--`. Branch names, remote names, revisions and folder names are validated (no leading `-`, no `..`, and so on).
- The renderer refers to repositories **by id**. Paths only enter the app through a native folder dialog, which returns a single-use selection id. File paths are resolved inside the repository root, and anything that would escape the root or touch `.git/` is rejected.
- Every git invocation forces settings that stop repository configuration from executing programs: `core.fsmonitor=false`, `protocol.ext.allow=never`, `diff.external=`, plus `--no-ext-diff --no-textconv` on diffs. **Repository hooks are disabled** (`core.hooksPath` points to an empty directory) unless you enable them per repository.
- Remote URLs containing credentials or command-executing transports (`ext::`, `fd::`) are rejected.
- The app never force-pushes and never uses `--discard-changes` or `reset --hard`.

### Credentials

**Nothing is stored by default.** The credential lifecycle is: enter → use → operation completed → removed from memory. Tokens, private keys, passphrases and installation tokens are never written to localStorage, IndexedDB, JSON settings, logs or Git configuration. Only when you tick **"Remember this credential"** is a value saved, and then only in the OS keychain (Electron `safeStorage`). You can forget it at any time (Accounts / repository Settings).

**GitHub accounts** (header → GitHub Account, or Accounts page):
- The app stores only the account identity: login, name and visible organisations.
- Every GitHub-account operation asks for that account's token (or uses the remembered one, if you chose that) and checks with `GET /user` that the token belongs to the selected account. A token of another account is refused, and so is a PAT used for a push to a repository associated with a different account.
- The **application account** is only the default for new operations. Switching it never changes the remote or credentials of existing repositories.
- Removing an account clears the association only; repositories keep working with their own Git configuration.
- **GitHub sessions** (Pull Requests, Actions, Security) keep the verified token in main-process memory, per account, for at most 12 hours. It is never sent to the renderer or written to disk, and is cleared on sign-out, account removal and quit. Requests go only to the account's own API host. Action logs are downloaded without forwarding the token to the storage redirect. Destructive or important GitHub actions (merge, close, dismiss alerts, re-run or cancel workflows, workflow file changes, deleting or removing project items, visibility changes) need an explicit confirmation, which the main process checks too.

- Credentials are **requested per operation** and live in React component state and main-process memory only for that operation. Forms are reset after each attempt.
- Tokens reach Git **through environment-scoped config** (`GIT_CONFIG_COUNT`, `http.<https://host/>.extraHeader`). They never appear on the command line or in the process list, and are never written to `.git/config`. `credential.helper` is reset for that process, so stored OS credentials are not consulted and the token is not saved by a helper.
- The **system credential helper is never used for push** unless you enable it for that repository.
- Saving is **opt-in, per repository**, and encrypted with Electron `safeStorage` (DPAPI / Keychain / libsecret). On Linux without a keyring (`basic_text` backend), saving is refused. Saved credentials are only *offered*: each operation still needs your explicit confirmation. Credentials for one repository are stored in their own file and can never be offered for another.
- GitHub App tokens can only be generated for the repository the remote points to (owner/repo must match). This stops credentials from being used across repositories by accident.
- All error output, history entries and technical details pass through `redactSecrets()`. It removes PEM keys, `ghp_/ghs_/github_pat_…` tokens, JWTs, Authorization headers and URL credentials.

### Confirmations enforced in the main process

A preview call registers what you reviewed and returns a single-use confirmation id that expires after 15 minutes:

| Operation | Bound to |
| --- | --- |
| Commit | A fingerprint of the staged changes + HEAD. If the index changes after review, the commit is refused. |
| Push | The exact commit id, branch and remote. The push sends `<oid>:refs/heads/<branch>`, so a commit made after review is never sent. |
| Pull | The exact fetched commit id. The app merges or rebases that commit, not whatever the remote has now. Flagged reports also require an explicit acknowledgement. |
| Continue merge/rebase | Treated as a commit and goes through the same commit confirmation. |

### Pull security scanner

`src/main/security/` inspects every **incoming** change (lines that would arrive on your machine) before integration:

- **Path rules.** GitHub Actions and other CI configs, hook managers (`.husky`, pre-commit), `.envrc`, install/setup scripts, executables and binaries, shell scripts, dependency manifests, registry configs (`.npmrc`), lockfiles, build scripts, Dockerfiles, IDE auto-run config, `.gitattributes`, `.gitmodules`. Also flags files that become executable, symlinks and submodule bumps.
- **Content rules.** `curl | sh`, `iwr | iex`, encoded PowerShell, base64-decode-and-execute, eval of decoded data, reverse shells, destructive `rm -rf /`, disk wipes, persistence (cron, Run keys, LaunchAgents), Defender/firewall tampering, credential-store access (`~/.ssh`, `.aws/credentials`, browser data), environment exfiltration, known exfil endpoints (Discord webhooks, Telegram bots, ngrok…), raw-IP URLs, miners, obfuscation (long base64, hex/unicode escapes, `_0x` identifiers, very long lines), Trojan-Source bidi characters, npm lifecycle scripts, non-registry dependencies, `setup.py` cmdclass, `pull_request_target` and workflow script injection.

The result is **NO ISSUES DETECTED**, **REVIEW RECOMMENDED** or **REVIEW REQUIRED**, with a reason for every finding. **The scanner is heuristic. It cannot guarantee that code is free of malware, and the UI says so.** You make the decision.

### Known limitations

- JavaScript strings cannot be reliably zeroed in memory. The app keeps secret lifetimes short and drops references, but a memory dump taken during an operation could still contain them.
- GitHub installation tokens have a fixed 1-hour lifetime on GitHub's side. The app revokes them right after each operation and when the token page auto-clears. If revocation fails (network), the token stays valid until GitHub expires it.
- Commits are local, so a "commit credential" means identity plus optional signing. Signing uses your local gpg/ssh-keygen, which may prompt for passphrases in their own UI.
- **SSH passphrases** are handed to `ssh`/`ssh-keygen` through `SSH_ASKPASS` (a small script in a private temp folder that only answers passphrase prompts from an environment variable of that one git process). The passphrase is never written to disk or placed on a command line. This needs OpenSSH 8.4+ (Git for Windows ships 9.x+). Unknown host keys are refused rather than auto-accepted: connect once from a terminal to trust a new host. PuTTY `.ppk` keys must be exported to OpenSSH format first.
- In ssh-agent mode, SSH runs with `BatchMode=yes` unless you configured `core.sshCommand`.

---

## GitHub App setup

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** (or the organisation equivalent).
2. Name: anything. Homepage URL: any URL. Uncheck **Webhook → Active**.
3. **Repository permissions:**
   - **Contents: Read and write** (needed for push; read is enough for fetch and clone)
   - **Pull requests: Read and write** (needed to create PRs)
   - **Metadata: Read-only** (selected automatically)
4. **Where can this GitHub App be installed?** Choose "Only on this account" unless you need more.
5. Create the app and note the **App ID**.
6. Under **Private keys**, click **Generate a private key**. A `.pem` file downloads. Keep it safe: anyone with this file and the App ID can act as the app.
7. Click **Install App** and install it on the account or organisation. Choose **Only select repositories** and pick the repositories you want to manage.
8. In Git Baba, click **Set up GitHub App** on the repository banner (or **Settings → GitHub App**). Enter the App ID. Optionally load the `.pem` to validate: the key, installation and permissions are checked and the installation ID is saved. You can also save the key encrypted for that repository. Push, fetch and PR dialogs then pre-select the GitHub App.

How the app uses it, for each push, fetch or PR:

1. Builds a 9-minute RS256 JWT from the App ID and private key (`iat` back-dated 60 s for clock drift).
2. Finds the installation for `owner/repo` (`GET /repos/{owner}/{repo}/installation`), unless you gave an installation ID.
3. Requests an installation token restricted to **that one repository** and the **minimum permission** (`contents:write` for push, `contents:read` for fetch, `pull_requests:write` for PRs).
4. Gives it to Git through the environment and uses it for the operation.
5. **Revokes** it immediately (`DELETE /installation/token`).

The private key can be loaded from the `.pem` file (read by the main process and held in memory for at most 15 minutes, never sent to the UI), pasted, or saved encrypted per repository if you opt in.

The **GitHub App Token page** generates a token for other tools. The token stays in the main process: the UI shows a masked value, **Reveal** shows it for 15 seconds, **Copy** puts it on the clipboard and clears the clipboard after 30 seconds (only if it still holds the token), and the token is dropped and revoked automatically after a timeout you choose (30 s – 10 min).

---

## Architecture

```
electron-git-manager/
├── src/
│   ├── main/                     Electron main process (all Git, GitHub, filesystem)
│   │   ├── index.ts              Window, hardening, app lifecycle
│   │   ├── context.ts            Shared services, per-repo locks, folder selections
│   │   ├── git/
│   │   │   ├── GitService.ts     init, clone, status, diff, stage, unstage, discard, commit,
│   │   │   │                     fetch, push, merge, rebase, branches, stash, conflicts, abort
│   │   │   ├── runner.ts         Safe spawn wrapper + forced safety config
│   │   │   ├── parsers.ts        porcelain v2 status, unified diff, log, branches
│   │   │   ├── credentials.ts    Env-based credential injection
│   │   │   ├── remoteUrl.ts      URL parsing/validation, applicable auth methods
│   │   │   └── errors.ts         Git/GitHub errors → friendly messages
│   │   ├── github/
│   │   │   ├── GitHubService.ts  authenticate, getInstallations, generateInstallationToken,
│   │   │   │                     revoke, getRepositories, createPullRequest, getPullRequest
│   │   │   └── authResolver.ts   Per-operation credential resolution & isolation
│   │   ├── security/
│   │   │   ├── SecurityScanner.ts scanIncomingChanges, scanFile, scanDiff, generateSecurityReport
│   │   │   ├── rules.ts          Path and content heuristics
│   │   │   ├── ConfirmationRegistry.ts  Single-use review bindings
│   │   │   └── EphemeralVault.ts In-memory, expiring secret handles
│   │   ├── repositories/         RepoStore, SecretStore (safeStorage), HistoryStore
│   │   ├── ipc/                  Handlers, validation of auth input, registration guard
│   │   └── util/                 validate, paths, redact
│   ├── preload/preload.ts        One allow-listed invoke() function
│   ├── shared/                   Types, IPC map, conflict parser, Git help content
│   └── renderer/                 React UI
│       ├── components/  pages/  dialogs/  hooks/  services/  state/
├── tests/                        vitest unit + real-git integration tests
├── package.json  tsconfig.*.json  vite.config.mts  vitest.config.ts
```

The UI never runs Git. It calls typed IPC channels (`src/shared/api.ts`), and handlers call `GitService`, `GitHubService` and `SecurityScanner`.

## Testing

```bash
npm test
```

- `parsers.test.ts`: status (renames, conflicts, detached/initial), unified diff (renames, modes, binary, "---" inside hunks, truncation), log/branches/name-status, quoted paths.
- `conflicts.test.ts`: marker parsing (incl. diff3), per-block/whole-file resolution, CRLF, malformed markers.
- `securityScanner.test.ts`: every major path/content rule, added-lines-only scanning, dedup, excerpt redaction, report status.
- `security-utils.test.ts`: redaction, path traversal, branch/folder validation, remote URL validation, auth applicability, credential env injection, friendly errors, confirmation registry, vault expiry/revocation hook, encrypted per-repo secret store.
- `github.test.ts`: JWT signature and claims, PEM handling, scoped token requests, error mapping (401/404/422), revocation, auth resolution rules (no system creds for push, repo mismatch, saved-credential opt-in, token revoked after use).
- `gitService.integration.test.ts`: uses the real `git` binary with a local bare remote. Covers init/stage/commit/diff, **hooks not executed**, path escapes rejected, discard with backup, branches, push of a pinned commit, fetch + scan detecting a malicious `postinstall`, merge conflict → markers block resolution → resolve → continue, abort restoring state, and dangerous remote URLs rejected.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| **"Git Not Found"** | Install Git and make sure `git --version` works in a new terminal, then restart the app. |
| **Authentication Failed** on push | The token expired or lacks access. For GitHub Apps, check that the app is installed on the repository and has **Contents: Read & write**. For fine-grained PATs, include the repository and grant Contents: write. |
| **GitHub App Not Installed** | Install the app on the repository (or add the repository to "selected repositories"), or check owner/repo spelling. |
| **GitHub rejected the GitHub App credentials** (401) | The App ID and key don't match, the key was revoked, or your system clock is wrong (JWTs are time-based). |
| **Requested permissions exceed the installation** | The app installation does not grant the permission (for example Pull requests: write). Update the app's permissions and accept the new permissions on the installation. |
| **SSH Authentication Failed** | Run `ssh-add` to load your key into ssh-agent, then check with `ssh -T git@github.com`. |
| **SSH Host Not Trusted** | Connect once from a terminal (`ssh -T git@github.com`), verify the fingerprint against GitHub's published fingerprints, and accept it. |
| **Push Rejected — Remote Has New Commits** | Use **Pull (Review)** first, then push again. |
| **Local Changes Would Be Overwritten** | Commit or stash your changes (Branches & Stash tab) before pulling or switching branches. |
| **Repository Ownership Not Trusted** | The folder is owned by another user. Only if you trust it, run `git config --global --add safe.directory <path>`. |
| **Repository Is Busy (index.lock)** | Close other Git tools. If none are running, delete `.git/index.lock`. |
| **Saving credentials is unavailable** | No OS keyring was found (common on minimal Linux). Install and unlock GNOME Keyring or KWallet, or enter credentials per operation. |
| **Hooks/husky don't run** | Intended: hooks are disabled by default. Enable "Run repository Git hooks" in the repository's Settings if you trust them. |
| **Electron download fails on first run** | Check proxy settings, or set `ELECTRON_MIRROR`. Then delete `node_modules/electron` and run `npm install` again. |
