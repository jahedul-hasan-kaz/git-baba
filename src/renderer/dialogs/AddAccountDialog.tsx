import { useEffect, useRef, useState } from "react";
import type {
  AccountSummary,
  CliAccountsStatus,
  FriendlyError,
  SshLocalKey,
  SshWhoAmI,
} from "../../shared/types";
import {
  detectTokenKind,
  GH_CLI_INSTALL_URL,
  NEW_CLASSIC_TOKEN_URL,
  NEW_FINE_GRAINED_TOKEN_URL,
} from "../../shared/tokenKind";
import { ErrorPanel } from "../components/ErrorPanel";
import { Avatar } from "../components/github/common";
import { openExternal } from "../components/github/SecureActionDialog";
import { Modal, Spinner } from "../components/Modal";
import { Select } from "../components/Select";
import { call, toFriendly } from "../services/api";
import { useApp } from "../state/AppState";

export type SignInMethod = "browser" | "pat" | "ssh";
type Step = "choose" | SignInMethod | "done";

interface Done {
  account: AccountSummary;
  detail: string;
  signedIn: boolean;
}

const METHODS: {
  id: SignInMethod;
  icon: string;
  title: string;
  text: string;
  tag?: string;
}[] = [
  {
    id: "browser",
    icon: "🌐",
    title: "Sign in with browser",
    text: "Use your GitHub username, password & 2FA on github.com.",
    tag: "Recommended",
  },
  {
    id: "pat",
    icon: "🎫",
    title: "Personal access token",
    text: "Paste a classic or fine-grained token.",
  },
  {
    id: "ssh",
    icon: "🔑",
    title: "SSH key",
    text: "Prove who you are with your SSH key. Push & pull only.",
  },
];

/**
 * Adds (or re-signs-in / upgrades) a GitHub account. Three ways in:
 *  - Browser: the GitHub device flow (via the GitHub CLI). The password is typed on github.com — never here.
 *  - Personal access token, with live kind detection and links that create one with good defaults.
 *  - SSH key: `ssh -T` tells which login the key belongs to → an "SSH only" account (no API features).
 * Git Baba stores only the account identity; the verified token is kept encrypted in the OS keychain so the account stays signed in until you sign out.
 */
export function AddAccountDialog({
  onClose,
  onAdded,
  account,
  initial,
  expectLogin,
  expectApiBaseUrl,
}: {
  onClose: () => void;
  onAdded?: (a: AccountSummary) => void;
  account?: AccountSummary;
  initial?: SignInMethod;
  /** Signing back in to an account that was signed out (e.g. a repository needs it): shown in the title and checked after. */
  expectLogin?: string;
  expectApiBaseUrl?: string;
}) {
  const { setAccounts, refreshSession, toast } = useApp();
  const [step, setStep] = useState<Step>(initial ?? "choose");
  // Sign-ins are always remembered (OS keychain) so the account stays signed in.
  const remember = true;
  const [enterpriseOn, setEnterpriseOn] = useState(!!(account?.apiBaseUrl ?? expectApiBaseUrl));
  const [enterprise, setEnterprise] = useState(account?.apiBaseUrl ?? expectApiBaseUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const apiBaseUrl =
    enterpriseOn && enterprise.trim() ? enterprise.trim() : undefined;
  const host = apiBaseUrl ? safeHost(apiBaseUrl) : "github.com";
  const upgrading = !!account;

  const finish = async (
    a: AccountSummary,
    detail: string,
    signedIn: boolean,
  ) => {
    await refreshSession().catch(() => undefined);
    setDone({ account: a, detail, signedIn });
    setStep("done");
    if (expectLogin && a.login.toLowerCase() !== expectLogin.toLowerCase())
      toast(`Signed in as ${a.login}, not ${expectLogin}. Sign in to ${expectLogin} to open its repositories.`, "warning");
    else toast(upgrading || expectLogin ? `${a.login} signed in` : `Added ${a.login}`);
    onAdded?.(a);
  };

  const go = (s: Step) => {
    setError(null);
    setStep(s);
  };

  const title =
    step === "done"
      ? upgrading
        ? "Signed In"
        : "Account Added"
      : upgrading
        ? `Sign in to ${account.login}`
        : expectLogin && step === "choose"
          ? `Sign in to ${expectLogin}`
          : step === "choose"
          ? "Add a GitHub Account"
          : METHODS.find((m) => m.id === step)!.title;

  return (
    <Modal
      title={title}
      icon={step === "done" ? "✓" : undefined}
      size="narrow"
      onClose={onClose}
      locked={busy}
      footer={
        step === "done" ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : step === "choose" ? (
          <button className="btn cancel" onClick={onClose}>
            Cancel
          </button>
        ) : undefined
      }
    >
      {error && <ErrorPanel error={error} />}

      {step === "choose" && (
        <div className="ax-add">
          <p className="small muted ax-lead">
            {upgrading
              ? `Choose how to sign in to ${account.login}.`
              : expectLogin
                ? `Choose how to sign in to ${expectLogin}. Make sure you sign in as ${expectLogin} — the browser and GitHub CLI use whoever is signed in there.`
                : "Choose how to sign in. Repositories keep working without an account — this adds GitHub features (PRs, Actions, cloning private repos)."}
          </p>
          <div className="ax-methods">
            {METHODS.filter((m) => !(upgrading && m.id === "ssh")).map((m) => (
              <button
                key={m.id}
                className={`ax-method ${m.tag ? "rec" : ""}`}
                onClick={() => go(m.id)}
                disabled={
                  m.id !== "ssh" && enterpriseOn && !validEnterprise(enterprise)
                }
              >
                <span className="ax-method-ico">{m.icon}</span>
                <span className="ax-method-text">
                  <strong>
                    {m.title}{" "}
                    {m.tag && <span className="badge ok">{m.tag}</span>}
                  </strong>
                  <span className="small muted">{m.text}</span>
                </span>
                <span className="ax-method-go">›</span>
              </button>
            ))}
          </div>
          <div className="ax-add-opts">
            <label className="check small">
              <input
                type="checkbox"
                checked={enterpriseOn}
                onChange={(e) => setEnterpriseOn(e.target.checked)}
              />
              <span>GitHub Enterprise Server</span>
            </label>
          </div>
          {enterpriseOn && (
            <div
              className={`field ax-ent ${enterprise && !validEnterprise(enterprise) ? "invalid" : ""}`}
            >
              <input
                value={enterprise}
                onChange={(e) => setEnterprise(e.target.value)}
                placeholder="https://github.example.com/api/v3"
                spellCheck={false}
                autoFocus
              />
              <span className="hint">
                The API URL of your server. Other Git servers (GitLab, Azure
                DevOps, Bitbucket…) don’t need an account here: Git Credential
                Manager asks for your username & password when you push.
              </span>
            </div>
          )}
        </div>
      )}

      {step === "browser" && (
        <BrowserStep
          apiBaseUrl={apiBaseUrl}
          host={host}
          remember={remember}
          accountId={account?.id}
          accountLogin={account?.login}
          busy={busy}
          setBusy={setBusy}
          onError={setError}
          onBack={() => go("choose")}
          onUseToken={() => go("pat")}
          onDone={(r) => {
            setAccounts(r.state);
            void finish(r.account, r.scopes, true);
          }}
        />
      )}

      {step === "pat" && (
        <TokenStep
          apiBaseUrl={apiBaseUrl}
          host={host}
          remember={remember}
          account={account}
          busy={busy}
          setBusy={setBusy}
          onError={setError}
          onBack={() => go("choose")}
          onDone={(a, detail) => void finish(a, detail, true)}
        />
      )}

      {step === "ssh" && (
        <SshStep
          apiBaseUrl={apiBaseUrl}
          host={host}
          busy={busy}
          setBusy={setBusy}
          onError={setError}
          onBack={() => go("choose")}
          onUpgrade={() => go("browser")}
          onDone={(a) =>
            void finish(
              a,
              "SSH only — git push / pull over SSH work. Sign in with a browser or token to use pull requests, Actions and your profile.",
              false,
            )
          }
        />
      )}


      {step === "done" && done && (
        <div className="ax-done">
          <Avatar login={done.account.login} size={40} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div>
              <strong>{done.account.login}</strong>{" "}
              {done.account.name && (
                <span className="muted">· {done.account.name}</span>
              )}
            </div>
            <div className="small muted">{done.detail}</div>
            <div className="ax-done-chips">
              {done.signedIn && <span className="badge ok">Signed in</span>}
              {done.account.method === "ssh" && (
                <span className="badge warn">SSH only</span>
              )}
              {done.account.remembered ? (
                <span className="badge info">🔑 Remembered</span>
              ) : (
                done.signedIn && <span className="badge">Until you quit</span>
              )}
              {done.account.orgs.length > 0 && (
                <span className="badge">
                  {done.account.orgs.length} organisation
                  {done.account.orgs.length > 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function safeHost(url: string): string {
  try {
    const h = new URL(url).host;
    return h === "api.github.com" ? "github.com" : h.replace(/^api\./, "");
  } catch {
    return "github.com";
  }
}

function validEnterprise(url: string): boolean {
  return /^https:\/\/[^\s/]+(\/\S*)?$/.test(url.trim());
}

interface StepProps {
  apiBaseUrl?: string;
  host: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onError: (e: FriendlyError | null) => void;
  onBack: () => void;
}

function BackLink({
  onBack,
  disabled,
}: {
  onBack: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="btn ghost sm ax-back"
      onClick={onBack}
      disabled={disabled}
    >
      ‹ Other ways to sign in
    </button>
  );
}

// ---------------------------------------------------------------------------
// Browser (device flow through the GitHub CLI)
// ---------------------------------------------------------------------------

function BrowserStep({
  apiBaseUrl,
  host,
  remember,
  accountId,
  accountLogin,
  busy,
  setBusy,
  onError,
  onBack,
  onUseToken,
  onDone,
}: StepProps & {
  remember: boolean;
  accountId?: string;
  accountLogin?: string;
  onUseToken: () => void;
  onDone: (r: {
    state: import("../../shared/types").AccountsState;
    account: AccountSummary;
    scopes: string;
  }) => void;
}) {
  const { toast, accounts } = useApp();
  const added = new Set((accounts?.accounts ?? []).filter((a) => a.method !== "ssh").map((a) => a.login.toLowerCase()));
  const [cli, setCli] = useState<CliAccountsStatus | null>(null);
  const [code, setCode] = useState<{
    loginId: string;
    code: string;
    url: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const live = useRef<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    let alive = true;
    call("accounts:cliStatus", { apiBaseUrl })
      .then((s) => alive && setCli(s))
      .catch((e) => alive && onError(toFriendly(e)));
    return () => {
      alive = false;
      // Leaving the step stops a sign-in that is still waiting.
      if (live.current)
        void call("accounts:browserLoginCancel", {
          loginId: live.current,
        }).catch(() => undefined);
    };
  }, [apiBaseUrl, onError]);

  const start = async () => {
    onError(null);
    cancelled.current = false;
    setBusy(true);
    try {
      const c = await call("accounts:browserLoginStart", { apiBaseUrl });
      live.current = c.loginId;
      setCode(c);
      void call("app:copyText", { text: c.code })
        .then(() => setCopied(true))
        .catch(() => undefined);
      openExternal(c.url);
      const r = await call("accounts:browserLoginFinish", {
        loginId: c.loginId,
        remember,
        apiBaseUrl,
        accountId,
      });
      live.current = null;
      onDone(r);
    } catch (err) {
      live.current = null;
      setCode(null);
      onError(cancelled.current ? null : toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const useCli = async (login: string) => {
    onError(null);
    setBusy(true);
    try {
      onDone(
        await call("accounts:addFromCli", {
          login,
          remember,
          apiBaseUrl,
          accountId,
        }),
      );
    } catch (err) {
      onError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    cancelled.current = true;
    if (live.current)
      await call("accounts:browserLoginCancel", {
        loginId: live.current,
      }).catch(() => undefined);
  };

  // Signing in to a known account: only its own CLI login. Adding a new one: CLI logins not added yet.
  const usable = (cli?.logins ?? []).filter((l) =>
    accountLogin
      ? l.toLowerCase() === accountLogin.toLowerCase()
      : !added.has(l.toLowerCase()),
  );
  const addingAnother = !accountLogin && added.size > 0;

  if (!cli) {
    return (
      <div className="ax-step">
        <Spinner label="Checking the GitHub CLI…" />
      </div>
    );
  }

  if (!cli.installed) {
    return (
      <div className="ax-step">
        <div className="banner info small">
          <span className="icon">ℹ</span>
          <div>
            Browser sign-in uses the free <strong>GitHub CLI</strong> (gh),
            which isn’t installed on this computer. Install it, then come back —
            or use a token for now.
            <div className="small muted mt">
              GitHub no longer accepts account passwords inside apps (since
              2021), so the password is always typed on github.com.
            </div>
          </div>
        </div>
        <div className="row">
          <button
            className="btn primary"
            onClick={() => openExternal(GH_CLI_INSTALL_URL)}
          >
            Get the GitHub CLI ↗
          </button>
          <button className="btn" onClick={onUseToken}>
            Use a token instead
          </button>
          <span className="spacer" />
          <BackLink onBack={onBack} />
        </div>
      </div>
    );
  }

  return (
    <div className="ax-step">
      {!code ? (
        <>
          <ol className="ax-steps small">
            <li>
              Git Baba shows a one-time code and opens{" "}
              <strong>{host}/login/device</strong>.
            </li>
            <li>
              Sign in there with your username, password and 2FA, and enter the
              code.
            </li>
            <li>
              Come back — you’re signed in. Your password never passes through
              Git Baba.
            </li>
          </ol>
          {addingAnother && (
            <div className="banner info small">
              <span className="icon">ℹ</span>
              <div>
                Adding another account? {host} approves the code as whoever is
                signed in there. Sign in to the other account first — GitHub’s
                avatar menu → <strong>Switch account</strong>, or open the code page in a
                private window.
              </div>
            </div>
          )}
          {usable.length > 0 && (
            <div className="ax-cli-quick">
              <div className="small muted">
                Already signed in with the GitHub CLI — no browser needed:
              </div>
              {usable.map((l) => (
                <div key={l} className="ax-cli-row">
                  <Avatar login={l} size={22} />
                  <strong className="grow">{l}</strong>
                  <button
                    className="btn sm primary"
                    disabled={busy}
                    onClick={() => void useCli(l)}
                  >
                    {busy ? "Checking…" : "Use this account"}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <button
              className={`btn ${usable.length ? "" : "primary"}`}
              onClick={start}
              disabled={busy}
            >
              🌐{" "}
              {usable.length
                ? "Sign in as someone else"
                : `Get my code & open ${host}`}
            </button>
            <span className="spacer" />
            <BackLink onBack={onBack} disabled={busy} />
          </div>
        </>
      ) : (
        <div className="ax-device">
          <div className="small muted">Enter this code on {host}</div>
          <div className="ax-code mono">{code.code}</div>
          <div className="row" style={{ justifyContent: "center" }}>
            <button
              className="btn sm"
              onClick={() =>
                void call("app:copyText", { text: code.code })
                  .then(() => {
                    setCopied(true);
                    toast("Code copied");
                  })
                  .catch(() => undefined)
              }
            >
              {copied ? "✓ Copied" : "Copy code"}
            </button>
            <button className="btn sm" onClick={() => openExternal(code.url)}>
              Open {host}/login/device ↗
            </button>
          </div>
          {addingAnother && (
            <div className="small muted center">
              Make sure {host} shows the account you want to add — not one
              that’s already in Git Baba.
            </div>
          )}
          <div className="ax-wait small">
            <span className="spinner" /> Waiting for you to finish on GitHub…
            <button className="btn sm cancel" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Personal access token
// ---------------------------------------------------------------------------

function TokenStep({
  apiBaseUrl,
  host,
  remember,
  account,
  busy,
  setBusy,
  onError,
  onBack,
  onDone,
}: StepProps & {
  remember: boolean;
  account?: AccountSummary;
  onDone: (a: AccountSummary, detail: string) => void;
}) {
  const { setAccounts } = useApp();
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const kind = detectTokenKind(token);
  const isPassword =
    !!kind &&
    kind.kind === "unknown" &&
    !/^gh[a-z]_|^github_pat_/.test(token.trim()) &&
    token.trim().length < 30;
  const base = host === "github.com" ? "https://github.com" : `https://${host}`;

  const add = async () => {
    setBusy(true);
    onError(null);
    try {
      if (account) {
        // Re-sign-in / upgrade of a known account: the token must belong to it.
        await call("session:signIn", {
          credential: { accountId: account.id, token: token.trim(), remember },
        });
        const state = await call("accounts:list");
        setAccounts(state);
        setToken("");
        onDone(
          state.accounts.find((a) => a.id === account.id) ?? account,
          kind ? kind.label : "Token verified",
        );
      } else {
        const r = await call("accounts:add", {
          token: token.trim(),
          remember,
          apiBaseUrl,
          signIn: true,
        });
        setToken("");
        setAccounts(r.state);
        onDone(r.account, r.scopes);
      }
    } catch (err) {
      onError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ax-step">
      <div className={`field ${kind && !kind.usable ? "invalid" : ""}`}>
        <div className="ax-token-row">
          <input
            type={show ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && kind?.usable && !busy && void add()
            }
            placeholder="ghp_… or github_pat_…"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <button
            className="btn ghost sm"
            onClick={() => setShow((s) => !s)}
            title={show ? "Hide" : "Show"}
            type="button"
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
        {kind ? (
          <span className={`ax-kind ${kind.usable ? "ok" : "bad"}`}>
            <strong>
              {kind.usable ? "✓" : "✕"} {kind.label}
            </strong>{" "}
            —{" "}
            {isPassword
              ? "this looks like a password. GitHub only accepts tokens here; use “Sign in with browser” for your password."
              : kind.hint}
          </span>
        ) : (
          <span className="hint">
            Your token is checked with GitHub to find the account.{" "}
            {account ? `It must belong to ${account.login}.` : ""}
          </span>
        )}
      </div>
      <div className="ax-create">
        <span className="small muted">Need one?</span>
        <button
          className="btn sm"
          onClick={() =>
            openExternal(
              host === "github.com"
                ? NEW_CLASSIC_TOKEN_URL
                : `${base}/settings/tokens/new?scopes=repo,read:org,workflow&description=Git%20Baba`,
            )
          }
          title="Pre-filled with repo, read:org and workflow scopes"
        >
          Create classic token ↗
        </button>
        <button
          className="btn sm"
          onClick={() =>
            openExternal(
              host === "github.com"
                ? NEW_FINE_GRAINED_TOKEN_URL
                : `${base}/settings/personal-access-tokens/new`,
            )
          }
          title="Pick repositories and permissions"
        >
          Create fine-grained ↗
        </button>
      </div>
      <div className="row mt">
        <BackLink onBack={onBack} disabled={busy} />
        <span className="spacer" />
        <button
          className="btn primary"
          onClick={add}
          disabled={busy || !kind?.usable}
        >
          {busy ? "Verifying…" : account ? "Verify & sign in" : "Verify & add"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SSH key
// ---------------------------------------------------------------------------

function SshStep({
  apiBaseUrl,
  host,
  busy,
  setBusy,
  onError,
  onBack,
  onUpgrade,
  onDone,
}: StepProps & { onUpgrade: () => void; onDone: (a: AccountSummary) => void }) {
  const { setAccounts } = useApp();
  const [keys, setKeys] = useState<SshLocalKey[] | null>(null);
  const [keyHandle, setKeyHandle] = useState("");
  const [who, setWho] = useState<SshWhoAmI | null>(null);

  useEffect(() => {
    call("ssh:listKeys")
      .then((r) => setKeys(r.keys.filter((k) => k.match)))
      .catch(() => setKeys([]));
  }, []);

  const check = async () => {
    setBusy(true);
    onError(null);
    setWho(null);
    try {
      setWho(
        await call("accounts:sshWhoAmI", {
          apiBaseUrl,
          keyHandle: keyHandle || undefined,
        }),
      );
    } catch (err) {
      onError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    onError(null);
    try {
      const r = await call("accounts:addSsh", {
        apiBaseUrl,
        keyHandle: keyHandle || undefined,
      });
      setAccounts(r.state);
      onDone(r.account);
    } catch (err) {
      onError(toFriendly(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ax-step">
      <div className="ax-note small">
        <span>ℹ</span>
        <span>
          An SSH key works for <strong>push & pull</strong>. Pull requests,
          Actions and your profile need GitHub’s API, which only accepts a
          browser sign-in or a token — you can upgrade any time.
        </span>
      </div>
      <div className="field">
        <label>Key</label>
        <Select
          value={keyHandle}
          onChange={(e) => {
            setKeyHandle(e.target.value);
            setWho(null);
          }}
          disabled={busy}
        >
          <option
            value=""
            data-icon="🔐"
            data-desc="ssh-agent and the default keys in ~/.ssh"
          >
            Any key this computer offers
          </option>
          {(keys ?? []).map((k) => (
            <option
              key={k.match!.handle}
              value={k.match!.handle}
              data-icon="🔑"
              data-desc={`${k.type.replace("ssh-", "")}${k.comment ? ` · ${k.comment}` : ""}${k.match!.encrypted ? " · passphrase-protected" : ""}`}
            >
              {k.match!.fileName}
            </option>
          ))}
        </Select>
        <span className="hint">
          Runs <span className="mono">ssh -T git@{host}</span> — GitHub replies
          with the login the key belongs to. Passphrase-protected keys must be
          loaded in ssh-agent.
        </span>
      </div>
      {who && (
        <div className={`ax-who ${who.ok ? "ok" : "bad"}`}>
          {who.ok && who.login ? (
            <>
              <Avatar login={who.login} size={28} />
              <div className="grow">
                <strong>@{who.login}</strong>
                <div className="small muted">
                  {who.accountId
                    ? "Already in Git Baba — this confirms SSH works for it."
                    : "This key signs in as this account."}
                </div>
              </div>
            </>
          ) : (
            <div className="small">✕ {who.message}</div>
          )}
        </div>
      )}
      <div className="row mt">
        <BackLink onBack={onBack} disabled={busy} />
        <span className="spacer" />
        {who?.ok ? (
          <>
            <button
              className="btn"
              onClick={onUpgrade}
              disabled={busy}
              title="Full access: PRs, Actions, profile"
            >
              Sign in with browser instead
            </button>
            <button className="btn primary" onClick={add} disabled={busy}>
              {who.accountId ? "Done" : "Add as SSH-only account"}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={check} disabled={busy}>
            {busy ? "Checking…" : "Check key"}
          </button>
        )}
      </div>
    </div>
  );
}
