import { useCallback, useEffect, useState } from "react";
import type { SessionStatus } from "../../shared/github";
import type { AccountsState, AccountSummary } from "../../shared/types";
import { accountLabel, accountStatus } from "../components/AccountSwitcher";
import { Avatar } from "../components/github/common";
import {
  AddAccountDialog,
  type SignInMethod,
} from "../dialogs/AddAccountDialog";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { call } from "../services/api";
import { shortDate } from "../services/format";
import { useApp } from "../state/AppState";

/**
 * Accounts known to Git Baba, one compact row each: status at a glance (signed in / remembered / SSH only /
 * needs sign-in), and the actions that apply — sign in or upgrade, make default, forget the token, remove.
 */
export function AccountsPage() {
  const { accounts, repos, setAccounts, showError, toast, refreshSession } =
    useApp();
  const [dialog, setDialog] = useState<{
    account?: AccountSummary;
    initial?: SignInMethod;
  } | null>(null);
  const [removing, setRemoving] = useState<AccountSummary | null>(null);
  const [sessions, setSessions] = useState<
    Record<string, SessionStatus | null>
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const list = accounts?.accounts ?? [];

  const loadSessions = useCallback(async () => {
    const entries = await Promise.all(
      list.map(
        async (a) =>
          [
            a.id,
            await call("session:status", { accountId: a.id }).catch(() => null),
          ] as const,
      ),
    );
    setSessions(Object.fromEntries(entries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) =>
      !(e.target as HTMLElement).closest?.(".ax-more") && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const act = async (fn: () => Promise<AccountsState>, msg: string) => {
    try {
      setAccounts(await fn());
      await refreshSession().catch(() => undefined);
      toast(msg);
    } catch (err) {
      showError(err);
    }
  };

  const quickSignIn = async (a: AccountSummary) => {
    setBusyId(a.id);
    try {
      await call("session:signIn", {
        credential: { accountId: a.id, useRemembered: true },
      });
      setAccounts(await call("accounts:list"));
      await refreshSession();
      toast(`Signed in as ${a.login}`);
    } catch (err) {
      showError(err);
    } finally {
      setBusyId(null);
    }
  };

  const signOut = async (a: AccountSummary) => {
    try {
      await call("session:signOut", { accountId: a.id });
      await refreshSession();
      await loadSessions();
      toast(`Signed out of ${a.login}`, "info");
    } catch (err) {
      showError(err);
    }
  };

  return (
    <div className="ax-accounts">
      <div className="ax-acc-head">
        <div className="grow small muted">
          The <strong>default</strong> account is used for new clones, new
          repositories and GitHub pages. Existing repositories keep their own
          remote and credentials — and work without any account.
        </div>
        <button className="btn primary sm" onClick={() => setDialog({})}>
          ＋ Add account
        </button>
      </div>

      {list.length === 0 && (
        <div className="ax-acc-empty">
          <div className="ax-acc-empty-ico">👋</div>
          <div className="grow">
            <strong>No GitHub account yet</strong>
            <div className="small muted">
              Your repositories already work. Sign in to add pull requests,
              Actions, your profile and private-repository cloning.
            </div>
          </div>
          <button
            className="btn primary sm"
            onClick={() => setDialog({ initial: "browser" })}
          >
            🌐 Sign in with browser
          </button>
          <button className="btn sm" onClick={() => setDialog({})}>
            Other ways…
          </button>
        </div>
      )}

      <div className="ax-acc-list">
        {list.map((a) => {
          const signedIn = !!sessions[a.id]?.active;
          const s = accountStatus(a, signedIn);
          const used = repos.filter((r) => r.account?.id === a.id);
          const host = a.apiBaseUrl
            ? a.apiBaseUrl
                .replace(/^https:\/\//, "")
                .replace(/\/api\/v3\/?$/, "")
            : null;
          return (
            <div
              key={a.id}
              className={`ax-acc-row ${a.active ? "active" : ""}`}
            >
              <span className="ax-av-wrap">
                <Avatar login={a.login} size={34} />
                <span className={`ax-dot ${s.tone}`} />
              </span>
              <div className="ax-acc-main">
                <div className="ax-acc-title">
                  <strong>{a.login}</strong>
                  {a.name && <span className="muted">{a.name}</span>}
                  {a.active && <span className="badge ok">default</span>}
                  <span className={`ax-chip ${s.tone}`} title={s.title}>
                    {s.label}
                  </span>
                </div>
                <div className="ax-acc-meta">
                  <span>{accountLabel(a)}</span>
                  {host && <span>{host}</span>}
                  <span title={used.map((r) => r.name).join(", ")}>
                    {used.length} repo{used.length === 1 ? "" : "s"}
                  </span>
                  <span>
                    {a.method === "browser"
                      ? "via browser"
                      : a.method === "ssh"
                        ? "via SSH key"
                        : "via token"}
                  </span>
                  {a.lastVerifiedAt && (
                    <span>verified {shortDate(a.lastVerifiedAt)}</span>
                  )}
                </div>
              </div>
              <div className="ax-acc-actions">
                {signedIn ? (
                  <button className="btn ghost sm" onClick={() => signOut(a)}>
                    Sign out
                  </button>
                ) : a.remembered ? (
                  <button
                    className="btn sm"
                    disabled={busyId === a.id}
                    onClick={() => quickSignIn(a)}
                  >
                    {busyId === a.id ? "Signing in…" : "Sign in"}
                  </button>
                ) : (
                  <button
                    className={`btn sm ${a.method === "ssh" ? "primary" : ""}`}
                    onClick={() => setDialog({ account: a })}
                    title={
                      a.method === "ssh"
                        ? "Add a browser sign-in or token for PRs, Actions and profile"
                        : undefined
                    }
                  >
                    {a.method === "ssh" ? "⬆ Upgrade" : "Sign in…"}
                  </button>
                )}
                {!a.active && (
                  <button
                    className="btn ghost sm"
                    onClick={() =>
                      act(
                        () => call("accounts:setActive", { accountId: a.id }),
                        `${a.login} is now the default account`,
                      )
                    }
                  >
                    Make default
                  </button>
                )}
                <div className="pop-anchor ax-more">
                  <button
                    className={`btn ghost sm ${menu === a.id ? "nav-active" : ""}`}
                    aria-label={`More actions for ${a.login}`}
                    aria-expanded={menu === a.id}
                    onClick={() => setMenu((m) => (m === a.id ? null : a.id))}
                  >
                    ⋯
                  </button>
                  {menu === a.id && (
                    <div
                      className="dropdown ax-more-pop pop-in"
                      onClick={() => setMenu(null)}
                    >
                      <div
                        className="dropdown-item"
                        onClick={() =>
                          setDialog({ account: a, initial: "browser" })
                        }
                      >
                        🌐 Sign in again with browser
                      </div>
                      <div
                        className="dropdown-item"
                        onClick={() =>
                          setDialog({ account: a, initial: "pat" })
                        }
                      >
                        🎫 Use a new token
                      </div>
                      {a.remembered && (
                        <div
                          className="dropdown-item"
                          onClick={() =>
                            act(
                              () =>
                                call("accounts:forgetCredential", {
                                  accountId: a.id,
                                }),
                              `Credential of ${a.login} forgotten`,
                            )
                          }
                        >
                          🧹 Forget remembered token
                        </div>
                      )}
                      <div className="dropdown-sep" />
                      <div
                        className="dropdown-item ax-danger"
                        onClick={() => setRemoving(a)}
                      >
                        Remove account…
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {dialog && (
        <AddAccountDialog
          account={dialog.account}
          initial={dialog.initial}
          onClose={() => {
            setDialog(null);
            void loadSessions();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Remove GitHub Account"
          explanation={
            <>
              Removes <strong>{removing.login}</strong> from Git Baba
              {removing.remembered
                ? " and deletes its remembered credential"
                : ""}
              .
            </>
          }
          impact="Repositories, their folders, remotes and Git credentials are not changed. Repositories associated with this account simply show no account until you choose another."
          affected={repos
            .filter((r) => r.account?.id === removing.id)
            .map((r) => r.name)}
          confirmLabel="Remove account"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await act(
              () =>
                call("accounts:remove", {
                  accountId: removing.id,
                  confirmed: true,
                }),
              `${removing.login} removed`,
            );
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}
