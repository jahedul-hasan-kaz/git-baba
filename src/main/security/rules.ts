import type { Severity } from '../../shared/types';

// Heuristic rules for reviewing incoming changes. They flag things a human
// should look at; they cannot prove that code is safe or malicious.

export interface PathRule {
  id: string;
  pattern: RegExp;
  severity: Severity;
  title: string;
  reason: string;
}

export interface ContentRule {
  id: string;
  pattern: RegExp;
  /** Optional second pattern that must also match the same line. */
  alsoRequires?: RegExp;
  /** Restrict to files whose path matches. */
  onlyPaths?: RegExp;
  /** Skip files whose path matches (e.g. lockfiles, minified bundles). */
  skipPaths?: RegExp;
  severity: Severity;
  title: string;
  reason: string;
}

export const PATH_RULES: PathRule[] = [
  {
    id: 'ci-github-actions',
    pattern: /^\.github\/(workflows\/[^/]+\.ya?ml|actions\/)/i,
    severity: 'high',
    title: 'GitHub Actions workflow changed',
    reason: 'Workflows run automatically in CI and can access repository secrets and write tokens.',
  },
  {
    id: 'ci-config',
    pattern: /(^|\/)(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml|\.circleci\/|\.buildkite\/|\.drone\.ya?ml|cloudbuild\.ya?ml|appveyor\.ya?ml)/i,
    severity: 'high',
    title: 'CI/CD pipeline changed',
    reason: 'CI configuration executes commands with access to build secrets and deployment credentials.',
  },
  {
    id: 'git-hooks-manager',
    pattern: /(^|\/)(\.husky\/|\.githooks\/|\.pre-commit-config\.ya?ml$|lefthook\.ya?ml$|\.lefthook\/|\.simple-git-hooks)/i,
    severity: 'high',
    title: 'Git hook configuration changed',
    reason: 'Hook managers run scripts automatically on commit, push or checkout on developer machines.',
  },
  {
    id: 'direnv',
    pattern: /(^|\/)\.envrc$/,
    severity: 'high',
    title: 'direnv script changed',
    reason: '.envrc is executed automatically by direnv when you enter the directory.',
  },
  {
    id: 'install-script',
    pattern: /(^|\/)[^/]*(install|setup|bootstrap|postinstall|preinstall|init)[^/]*\.(sh|bash|ps1|psm1|bat|cmd|py|js|cjs|mjs|rb|pl)$/i,
    severity: 'high',
    title: 'Installation script changed',
    reason: 'Install/setup scripts are commonly run with elevated trust during project setup.',
  },
  {
    id: 'executable-binary',
    pattern: /\.(exe|dll|so|dylib|bin|msi|com|scr|jar|apk|deb|rpm|pkg|dmg|elf|pyc|pyd|class|node|sys|drv|cpl|ocx)$/i,
    severity: 'high',
    title: 'Executable or compiled binary',
    reason: 'Binary files cannot be reviewed as source code and may contain arbitrary programs.',
  },
  {
    id: 'shell-script',
    pattern: /\.(sh|bash|zsh|ksh|ps1|psm1|psd1|bat|cmd|vbs|vbe|js[ex]|wsf|wsh|hta|applescript|scpt|command|reg|lnk)$/i,
    severity: 'medium',
    title: 'Script file changed',
    reason: 'Shell and system scripts can execute arbitrary commands on your machine.',
  },
  {
    id: 'package-manifest',
    pattern: /(^|\/)(package\.json|requirements[^/]*\.txt|setup\.py|setup\.cfg|pyproject\.toml|Pipfile|Gemfile|[^/]+\.gemspec|Cargo\.toml|go\.mod|composer\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^/]+\.csproj|packages\.config|Directory\.Build\.(props|targets)|deno\.jsonc?|pubspec\.yaml|mix\.exs|Package\.swift|Podfile|conanfile\.(txt|py)|vcpkg\.json)$/i,
    severity: 'medium',
    title: 'Dependency configuration changed',
    reason: 'New or changed dependencies and their scripts run code during install or build.',
  },
  {
    id: 'package-registry-config',
    pattern: /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pypirc|pip\.conf|nuget\.config|\.bunfig\.toml|bunfig\.toml)$/i,
    severity: 'medium',
    title: 'Package registry configuration changed',
    reason: 'Registry settings can redirect dependency downloads to an untrusted server.',
  },
  {
    id: 'lockfile',
    pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|packages\.lock\.json|uv\.lock)$/i,
    severity: 'low',
    title: 'Lockfile changed',
    reason: 'Lockfiles pin exact dependency sources; unexpected changes can introduce different packages.',
  },
  {
    id: 'build-script',
    pattern: /(^|\/)(Makefile|GNUmakefile|CMakeLists\.txt|[^/]*\.cmake|build\.(sh|ps1|bat|cmd|js|ts|mjs|rs|gradle|xml)|webpack\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|esbuild\.config\.[cm]?[jt]s|gulpfile\.[cm]?[jt]s|Gruntfile\.[cm]?[jt]s|Rakefile|meson\.build|BUILD(\.bazel)?|WORKSPACE|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Taskfile\.ya?ml|justfile|Justfile|tox\.ini|noxfile\.py|conftest\.py)$/,
    severity: 'medium',
    title: 'Build script changed',
    reason: 'Build scripts execute when you build, test or run the project.',
  },
  {
    id: 'editor-autorun',
    pattern: /(^|\/)(\.vscode\/(tasks|settings|launch|extensions)\.json|\.devcontainer\/|\.idea\/[^/]+\.xml|\.idea\/runConfigurations\/)/i,
    severity: 'medium',
    title: 'Editor/IDE configuration changed',
    reason: 'Editor tasks and dev-container settings can run commands when the folder is opened.',
  },
  {
    id: 'git-attributes',
    pattern: /(^|\/)(\.gitattributes|\.gitmodules|\.lfsconfig)$/,
    severity: 'medium',
    title: 'Git attributes / submodules changed',
    reason: 'These files can add submodules from new URLs or attach filter/diff drivers to files.',
  },
];

const LOCK_OR_MIN = /(\.min\.(js|css)|\.map|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|Gemfile\.lock|bun\.lock|uv\.lock))$/i;
const DOCS = /\.(md|mdx|rst|txt|adoc)$/i;

export const CONTENT_RULES: ContentRule[] = [
  // --- Remote code execution / downloaders ---
  {
    id: 'pipe-to-shell',
    pattern: /\b(curl|wget|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b|\|\s*(iex|Invoke-Expression)\b/i,
    severity: 'high',
    title: 'Downloads and executes remote code',
    reason: 'Output from the network is piped directly into a shell interpreter.',
  },
  {
    id: 'powershell-encoded',
    pattern: /\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i,
    severity: 'high',
    title: 'Encoded PowerShell command',
    reason: 'Base64-encoded PowerShell is a common way to hide what a command does.',
  },
  {
    id: 'powershell-iex',
    pattern: /\bInvoke-Expression\b|\biex\s*\(|\bDownloadString\s*\(|\bDownloadFile\s*\(|\bStart-BitsTransfer\b/i,
    severity: 'medium',
    title: 'PowerShell dynamic execution or download',
    reason: 'Invoke-Expression/DownloadString execute or fetch code at runtime.',
  },
  {
    id: 'base64-exec',
    pattern: /base64\s+(-d|--decode|-D)\b[^\n]*\|\s*(ba|z)?sh|FromBase64String\([^\n]*\)[^\n]*(Invoke-Expression|iex|Start-Process)/i,
    severity: 'high',
    title: 'Decodes and executes hidden payload',
    reason: 'A base64 payload is decoded and executed.',
  },
  {
    id: 'eval-decoded',
    pattern: /\b(eval|Function|exec|execSync)\s*\(\s*(atob|Buffer\.from|unescape|decodeURIComponent|String\.fromCharCode|require\(['"]zlib|base64\.b64decode|zlib\.decompress|codecs\.decode|marshal\.loads|bytes\.fromhex)/,
    severity: 'high',
    title: 'Executes decoded/obfuscated code',
    reason: 'Code is decoded at runtime and passed to an evaluator, hiding its real behaviour.',
  },
  {
    id: 'dynamic-eval',
    pattern: /(^|[^\w.])(eval|new\s+Function)\s*\(/,
    skipPaths: DOCS,
    severity: 'low',
    title: 'Dynamic code evaluation',
    reason: 'eval/new Function run strings as code.',
  },
  {
    id: 'python-exec-shell',
    pattern: /subprocess\.\w+\([^\n]*shell\s*=\s*True|\bos\.system\s*\(|\bos\.popen\s*\(|\bpty\.spawn\s*\(/,
    severity: 'medium',
    title: 'Python runs shell commands',
    reason: 'Shell execution from Python can run arbitrary commands.',
  },
  {
    id: 'node-child-process',
    pattern: /require\(\s*['"](node:)?child_process['"]\s*\)|from\s+['"](node:)?child_process['"]/,
    severity: 'medium',
    title: 'Node.js child_process imported',
    reason: 'The code can launch external programs.',
  },
  // --- Destructive / persistence / reverse shells ---
  {
    id: 'destructive-rm',
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*|\$\{?HOME\}?)(\s|$|\/)|Remove-Item\s+[^\n]*-Recurse[^\n]*(C:\\|\$env:USERPROFILE|~)\s*$/i,
    severity: 'high',
    title: 'Destructive delete command',
    reason: 'Recursively deletes the home or root directory.',
  },
  {
    id: 'disk-wipe',
    pattern: /\bdd\s+if=[^\n]*of=\/dev\/(sd|nvme|disk|hd)|\bmkfs(\.\w+)?\s+\/dev\/|\bformat\s+[a-z]:\s*\/[qy]/i,
    severity: 'high',
    title: 'Disk overwrite command',
    reason: 'Writes directly to a disk device or formats a drive.',
  },
  {
    id: 'reverse-shell',
    pattern: /\/dev\/tcp\/|\bnc(at)?\s+(-\w+\s+)*-e\s|\bbash\s+-i\s*>&|\bmkfifo\b[^\n]*\bnc\b|socket\.socket\([^\n]*\)[^\n]*(subprocess|pty|os\.dup2)|New-Object\s+System\.Net\.Sockets\.TCPClient/i,
    severity: 'high',
    title: 'Possible reverse shell',
    reason: 'Pattern commonly used to give a remote attacker an interactive shell.',
  },
  {
    id: 'fork-bomb',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    severity: 'high',
    title: 'Fork bomb',
    reason: 'Exhausts system resources by spawning processes endlessly.',
  },
  {
    id: 'permissions-777',
    pattern: /\bchmod\s+(-R\s+)?(0?777|a\+rwx)\b|\bchmod\s+[ug]?\+s\b/,
    severity: 'medium',
    title: 'Insecure permission change',
    reason: 'Makes files world-writable or sets setuid/setgid bits.',
  },
  {
    id: 'persistence',
    pattern: /\bcrontab\s+-|\/etc\/cron|\bschtasks\s+\/create|reg(\.exe)?\s+add\s+[^\n]*\\(Run|RunOnce)\b|\\CurrentVersion\\Run\b|LaunchAgents|LaunchDaemons|systemctl\s+enable|\.bashrc|\.zshrc|\.profile\b|Microsoft\\Windows\\Start Menu\\Programs\\Startup/i,
    skipPaths: DOCS,
    severity: 'medium',
    title: 'Startup/persistence mechanism',
    reason: 'Installs something that runs automatically at login or on a schedule.',
  },
  {
    id: 'defender-tamper',
    pattern: /Set-MpPreference\s+[^\n]*-Disable|Add-MpPreference\s+[^\n]*-Exclusion|DisableRealtimeMonitoring|netsh\s+advfirewall\s+set\s+[^\n]*state\s+off|spctl\s+--master-disable|setenforce\s+0/i,
    severity: 'high',
    title: 'Security software tampering',
    reason: 'Disables antivirus, firewall or OS security protections.',
  },
  {
    id: 'sudo',
    pattern: /(^|[\s;&|])sudo\s/,
    skipPaths: DOCS,
    severity: 'low',
    title: 'Elevated privileges (sudo)',
    reason: 'Command runs with administrator rights.',
  },
  // --- Credential harvesting / exfiltration ---
  {
    id: 'credential-files',
    pattern: /\.ssh\/(id_[a-z0-9]+|authorized_keys)|\.aws\/credentials|\.git-credentials|\.docker\/config\.json|\.kube\/config|\.netrc|\.pypirc|\/etc\/(shadow|passwd)\b|Login Data|Local State|\bCookies\b[^\n]*(Chrome|Firefox|Edge)|\bwallet\.dat\b|\bkeychain\b|security\s+find-(generic|internet)-password|\bLaZagne\b|\bmimikatz\b|\blsass\b/i,
    skipPaths: DOCS,
    severity: 'high',
    title: 'Accesses credential stores',
    reason: 'Reads SSH keys, cloud credentials, browser data or OS password stores.',
  },
  {
    id: 'env-exfiltration',
    pattern: /JSON\.stringify\(\s*process\.env\s*\)|os\.environ\.copy\(\)|dict\(os\.environ\)|\bprintenv\b|Get-ChildItem\s+env:|\benv\s*\|/i,
    alsoRequires: /\b(fetch|axios|https?\.(request|get)|XMLHttpRequest|requests\.(post|get|put)|urllib|curl|wget|Invoke-WebRequest|Invoke-RestMethod|nc\s|sendBeacon|WebSocket)\b/i,
    severity: 'high',
    title: 'Sends environment variables over the network',
    reason: 'Environment variables often contain tokens and secrets.',
  },
  {
    id: 'env-dump',
    pattern: /JSON\.stringify\(\s*process\.env\s*\)|os\.environ\.copy\(\)|dict\(os\.environ\)/,
    severity: 'medium',
    title: 'Collects all environment variables',
    reason: 'Bulk access to environment variables can be used to harvest secrets.',
  },
  {
    id: 'exfil-endpoints',
    pattern: /discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com\/services|pastebin\.com|paste\.ee|hastebin|transfer\.sh|file\.io|ngrok(-free)?\.(io|app)|webhook\.site|requestbin|pipedream\.net|interact\.sh|oast\.(fun|live|me|pro|site|online)|burpcollaborator|\.onion\b/i,
    skipPaths: DOCS,
    severity: 'high',
    title: 'Known data-exfiltration endpoint',
    reason: 'Sends data to a service commonly abused to collect stolen information.',
  },
  {
    id: 'raw-ip-url',
    pattern: /\b(https?|tcp|udp):\/\/(?!127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}(\.\d{1,3}){3}/,
    skipPaths: DOCS,
    severity: 'medium',
    title: 'Connects to a raw IP address',
    reason: 'Hard-coded public IP addresses are typical for command-and-control servers.',
  },
  {
    id: 'crypto-miner',
    pattern: /stratum\+(tcp|ssl):\/\/|\bxmrig\b|\bcoinhive\b|\bcryptonight\b|\bminexmr\b|\bnicehash\b/i,
    severity: 'high',
    title: 'Cryptocurrency miner',
    reason: 'References mining software or mining pools.',
  },
  // --- Obfuscation ---
  {
    id: 'long-base64',
    pattern: /["'`=:(\s][A-Za-z0-9+/]{300,}={0,2}["'`)\s;,]/,
    skipPaths: /\.(svg|lock|map|pem|crt|cer|key|snap)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$/i,
    severity: 'medium',
    title: 'Large encoded blob',
    reason: 'Long base64 strings can hide payloads inside source files.',
  },
  {
    id: 'hex-escapes',
    pattern: /(\\x[0-9a-fA-F]{2}){24,}|(\\u[0-9a-fA-F]{4}){16,}|(\\[0-7]{3}){24,}/,
    severity: 'medium',
    title: 'Escaped/encoded string',
    reason: 'Long runs of hex/unicode escapes are a common obfuscation technique.',
  },
  {
    id: 'charcode-chain',
    pattern: /String\.fromCharCode\(\s*(\d+\s*,\s*){15,}|chr\(\d+\)\s*\+\s*chr\(\d+\)\s*\+\s*chr\(\d+\)\s*\+\s*chr\(\d+\)/,
    severity: 'medium',
    title: 'Character-code obfuscation',
    reason: 'Builds strings from character codes to avoid detection.',
  },
  {
    id: 'js-obfuscator',
    pattern: /\b_0x[0-9a-f]{4,6}\b[^\n]*\b_0x[0-9a-f]{4,6}\b[^\n]*\b_0x[0-9a-f]{4,6}\b/,
    severity: 'high',
    title: 'Obfuscated JavaScript',
    reason: 'Identifiers like _0xabc123 are produced by JavaScript obfuscators.',
  },
  {
    id: 'bidi-control',
    pattern: /[\u202A-\u202E\u2066-\u2069]/,
    severity: 'high',
    title: 'Hidden bidirectional text (Trojan Source)',
    reason: 'Invisible Unicode direction characters can make code look different from what it does.',
  },
  {
    id: 'zero-width',
    pattern: /[\u200B-\u200D\u2060\uFEFF](?!$)/,
    skipPaths: DOCS,
    severity: 'medium',
    title: 'Invisible characters',
    reason: 'Zero-width characters can disguise identifiers or strings.',
  },
  // --- Package manager lifecycle scripts ---
  {
    id: 'npm-lifecycle',
    pattern: /"(preinstall|install|postinstall|preuninstall|postuninstall|prepare|prepublish|prepack|postpack)"\s*:/,
    onlyPaths: /(^|\/)package\.json$/,
    severity: 'high',
    title: 'Package install script added/changed',
    reason: 'npm/yarn/pnpm run this script automatically during install.',
  },
  {
    id: 'npm-remote-dependency',
    pattern: /"[^"]+"\s*:\s*"(git\+|git:\/\/|github:|gitlab:|bitbucket:|https?:\/\/|file:|link:)/,
    onlyPaths: /(^|\/)package\.json$/,
    severity: 'medium',
    title: 'Dependency from URL/Git/local path',
    reason: 'Dependencies outside the registry bypass normal package integrity checks.',
  },
  {
    id: 'python-install-hook',
    pattern: /\bcmdclass\b|class\s+\w+\(\s*(install|develop|egg_info|build_py)\s*\)/,
    onlyPaths: /(^|\/)setup\.py$/,
    severity: 'high',
    title: 'Custom Python install command',
    reason: 'Overriding setuptools commands runs code during pip install.',
  },
  {
    id: 'pip-extra-index',
    pattern: /--(extra-)?index-url\s+\S+|--trusted-host/,
    onlyPaths: /(requirements[^/]*\.txt|pip\.conf)$/,
    severity: 'medium',
    title: 'Custom package index',
    reason: 'Packages may be installed from a non-default index (dependency confusion risk).',
  },
  {
    id: 'cargo-build-script',
    pattern: /^\s*build\s*=\s*"/,
    onlyPaths: /Cargo\.toml$/,
    severity: 'medium',
    title: 'Cargo build script configured',
    reason: 'build.rs scripts run on every build.',
  },
  // --- CI specific ---
  {
    id: 'gha-pull-request-target',
    pattern: /\bpull_request_target\b|\bworkflow_run\b/,
    onlyPaths: /^\.github\/workflows\//,
    severity: 'high',
    title: 'Privileged workflow trigger',
    reason: 'pull_request_target / workflow_run run with secrets in response to untrusted contributions.',
  },
  {
    id: 'gha-script-injection',
    pattern: /\$\{\{\s*github\.(event\.(issue|pull_request|comment|review|review_comment|pages|commits|head_commit|discussion)[^}]*\.(title|body|message|name|email|label|ref)|head_ref)\s*\}\}/,
    onlyPaths: /^\.github\//,
    severity: 'high',
    title: 'Untrusted input interpolated into workflow',
    reason: 'Attacker-controlled text inserted into run: steps can execute arbitrary commands.',
  },
  {
    id: 'gha-permissions',
    pattern: /permissions:\s*write-all|^\s*(contents|packages|id-token|actions|deployments):\s*write/,
    onlyPaths: /^\.github\//,
    severity: 'medium',
    title: 'Workflow requests write permissions',
    reason: 'Write permissions let workflow code modify the repository or publish packages.',
  },
  {
    id: 'gha-secrets',
    pattern: /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/,
    onlyPaths: /^\.github\//,
    severity: 'low',
    title: 'Workflow uses secrets',
    reason: 'Check that secrets are only passed to trusted steps.',
  },
  {
    id: 'vscode-folder-open',
    pattern: /"runOn"\s*:\s*"folderOpen"/,
    onlyPaths: /\.vscode\/tasks\.json$/,
    severity: 'high',
    title: 'Task runs automatically when folder opens',
    reason: 'VS Code can execute this task as soon as the repository is opened.',
  },
  {
    id: 'gitattributes-filter',
    pattern: /\b(filter|diff|merge)=/,
    onlyPaths: /\.gitattributes$/,
    severity: 'medium',
    title: 'Git filter/driver assigned',
    reason: 'Filters and drivers can run programs when files are checked out or diffed (if configured locally).',
  },
  {
    id: 'gitmodules-url',
    pattern: /^\s*url\s*=/,
    onlyPaths: /\.gitmodules$/,
    severity: 'medium',
    title: 'Submodule URL changed',
    reason: 'Submodules pull code from another repository.',
  },
  {
    id: 'download-executable',
    pattern: /\b(curl|wget)\b[^\n]*\s-[oO]\s*\S+\.(exe|sh|ps1|bin|dll|so|msi|bat|cmd|py)\b|\bcertutil\b[^\n]*-urlcache|\bbitsadmin\b[^\n]*\/transfer|\bmshta\b\s+https?:/i,
    severity: 'medium',
    title: 'Downloads an executable or script',
    reason: 'A program or script is downloaded during execution.',
  },
];

export { LOCK_OR_MIN };
