import { useEffect, useRef, useState } from "react";
import type { AccountSummary } from "../../shared/types";
import {
  AddAccountDialog,
  type SignInMethod,
} from "../dialogs/AddAccountDialog";
import { SignOutDialog } from "../dialogs/SignOutDialog";
import { call } from "../services/api";
import { useApp } from "../state/AppState";
import { Avatar } from "./github/common";

export function accountLabel(a: AccountSummary): string {
  return a.orgs.length
    ? `Personal · ${a.orgs.slice(0, 3).join(", ")}${a.orgs.length > 3 ? "…" : ""}`
    : "Personal";
}

export type AccountTone = "ok" | "info" | "warn" | "muted";

/** One short status for an account: signed in now / token remembered / SSH only / needs sign-in. */
export function accountStatus(
  a: AccountSummary,
  signedIn: boolean,
): { tone: AccountTone; label: string; title: string } {
  if (signedIn)
    return {
      tone: "ok",
      label: "Signed in",
      title: "GitHub features are available (session kept in memory)",
    };
  if (a.method === "ssh" && !a.remembered)
    return {
      tone: "warn",
      label: "SSH only",
      title:
        "Push & pull over SSH work. Sign in with a browser or token for pull requests, Actions and profile.",
    };
  if (a.remembered)
    return {
      tone: "info",
      label: "Remembered",
      title:
        "A token is remembered in the OS keychain — signing in needs no typing",
    };
  return {
    tone: "muted",
    label: "Needs sign-in",
    title:
      "Sign in when a GitHub feature needs it. Git operations on your repositories work without it.",
  };
}

function hostOf(a: AccountSummary): string | null {
  if (!a.apiBaseUrl) return null;
  try {
    return new URL(a.apiBaseUrl).host.replace(/^api\./, "");
  } catch {
    return null;
  }
}

/**
 * Global "application account" switcher. Switching only changes the default account for
 * NEW operations (create / clone / GitHub pages); repositories keep their own remotes and credentials.
 */
export function AccountSwitcher() {
  const {
    accounts,
    activeAccount,
    setAccounts,
    setView,
    showError,
    toast,
    session,
    refreshSession,
  } = useApp();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<{
    account?: AccountSummary;
    initial?: SignInMethod;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const list = accounts?.accounts ?? [];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const switchTo = async (a: AccountSummary) => {
    setOpen(false);
    if (a.active) return;
    try {
      setAccounts(await call("accounts:setActive", { accountId: a.id }));
      await refreshSession().catch(() => undefined);
      toast(
        `Now using ${a.login} for new clones, repositories and GitHub pages. Existing repositories are unchanged.`,
        "info",
      );
    } catch (err) {
      showError(err);
    }
  };

  // Signing out asks which account first (the one in use is preselected).
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const signOut = (a: AccountSummary) => {
    setOpen(false);
    setSigningOut(a.id);
  };

  const activeSignedIn = !!session?.active;
  const st = activeAccount
    ? accountStatus(activeAccount, activeSignedIn)
    : null;

  return (
    <div className="account-switcher ax-switch" ref={ref}>
      <button
        className={`ax-switch-btn ${open ? "on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="GitHub account used for new clones, repositories and GitHub pages"
        aria-expanded={open}
      >
        {activeAccount ? (
          <>
            <span className="ax-av-wrap">
              <Avatar login={activeAccount.login} size={22} />
              <span className={`ax-dot ${st!.tone}`} />
            </span>
            <span className="ax-switch-login">{activeAccount.login}</span>
          </>
        ) : (
          <>
            <span className="ax-av-empty">＋</span>
            <span className="ax-switch-login">Sign in</span>
          </>
        )}
        <span className="ax-caret">▾</span>
      </button>
      {open && (
        <div className="dropdown ax-switch-pop pop-in">
          {list.length === 0 ? (
            <div className="ax-switch-empty">
              <strong>No GitHub account yet</strong>
              <div className="small muted">
                Your repositories work without one. Add an account for pull
                requests, Actions and cloning private repositories.
              </div>
              <button
                className="btn primary sm mt"
                onClick={() => {
                  setOpen(false);
                  setAdding({});
                }}
              >
                ＋ Add account
              </button>
            </div>
          ) : (
            <>
              <div className="dropdown-title">Accounts · {list.length}</div>
              {list.map((a) => {
                const s = accountStatus(a, a.active && activeSignedIn);
                const host = hostOf(a);
                return (
                  <div
                    key={a.id}
                    className={`ax-acct ${a.active ? "active" : ""}`}
                    onClick={() => switchTo(a)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && switchTo(a)}
                    title={
                      a.active ? "Current account" : `Switch to ${a.login}`
                    }
                  >
                    <span className="ax-av-wrap">
                      <Avatar login={a.login} size={28} />
                      <span className={`ax-dot ${s.tone}`} />
                    </span>
                    <span className="ax-acct-text">
                      <span className="ax-acct-login">{a.login}</span>
                      <span className="ax-acct-sub">
                        {host && <span className="ax-host">{host}</span>} {a.name || accountLabel(a)}
                      </span>
                    </span>
                    <span className={`ax-chip ${s.tone}`} title={s.title}>
                      {s.label}
                    </span>
                    {a.active ? (
                      <span className="ax-check" aria-label="current">
                        ✓
                      </span>
                    ) : (
                      <span className="ax-check" />
                    )}
                  </div>
                );
              })}
              {activeAccount && st && (
                <div
                  className={`ax-switch-actions ${activeSignedIn ? "" : st.tone}`}
                >
                  {activeSignedIn ? (
                    <>
                      <span className="small muted grow">
                        {session?.expiresAt
                          ? `Session until ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                          : "Signed in"}
                      </span>
                      <button
                        className="btn ghost sm"
                        onClick={() => signOut(activeAccount)}
                      >
                        Sign out
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="small grow">
                        {activeAccount.method === "ssh"
                          ? "Push & pull only — upgrade for PRs & Actions"
                          : "Sign in for PRs, Actions & profile"}
                      </span>
                      <button
                        className="btn sm primary"
                        onClick={() => {
                          setOpen(false);
                          setAdding({ account: activeAccount });
                        }}
                      >
                        {activeAccount.method === "ssh"
                          ? "⬆ Upgrade"
                          : "Sign in"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          <div className="dropdown-sep" />
          <div className="ax-switch-foot">
            {list.length > 0 && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  setOpen(false);
                  setAdding({});
                }}
              >
                ＋ Add account
              </button>
            )}
            <span className="spacer" />
            {/* The session row above has its own Sign out while signed in. */}
            {list.length > 0 && !activeSignedIn && (
              <button
                className="btn ghost sm ax-signout"
                onClick={() => signOut(activeAccount ?? list[0])}
                title="Choose an account to sign out of"
              >
                ⎋ Sign out…
              </button>
            )}
            <button
              className="btn ghost sm"
              onClick={() => {
                setOpen(false);
                setView("accounts");
              }}
            >
              Manage ›
            </button>
          </div>
        </div>
      )}
      {signingOut && (
        <SignOutDialog
          initial={signingOut}
          onClose={() => setSigningOut(null)}
        />
      )}
      {adding && (
        <AddAccountDialog
          account={adding.account}
          initial={adding.initial}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  );
}
