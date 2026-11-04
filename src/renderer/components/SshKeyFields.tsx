import { useEffect, useState } from 'react';
import type { SavedSshKey, SshKeyInfo, SshKeyInput, SshKeyMatch, SshKeyType, SshLocalKey } from '../../shared/types';
import { call, toFriendly } from '../services/api';
import { useApp } from '../state/AppState';

interface Props {
  savedKey: SavedSshKey | null;
  onChange: (input: SshKeyInput | null, summary: string) => void;
}

/** "ssh-ed25519 AAAAC3Nz…QxY9 you@example.com" — type, first/last few characters and comment only. */
export function maskPublicKey(key: string): string {
  const [type, body = '', ...comment] = key.trim().split(/\s+/);
  if (!body) return key.length > 16 ? `${key.slice(0, 8)}••••••${key.slice(-4)}` : '••••••';
  const masked = body.length > 16 ? `${body.slice(0, 8)}${'•'.repeat(12)}${body.slice(-6)}` : '•'.repeat(12);
  return [type, masked, ...comment].join(' ');
}

/** A public key shown masked by default, with an explicit reveal toggle. */
function MaskedKey({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="masked-key">
      <span className="mono small grow" style={revealed ? { wordBreak: 'break-all' } : undefined}>
        {revealed ? value : maskPublicKey(value)}
      </span>
      <button type="button" className="btn sm ghost" onClick={() => setRevealed((r) => !r)} title={revealed ? 'Hide the key' : 'Show the full public key'}>
        {revealed ? '🙈 Hide' : '👁 Show'}
      </button>
    </div>
  );
}

type KeyRef = Pick<SshKeyInfo, 'fileName' | 'path' | 'encrypted' | 'fingerprint'> & { handle: string };
type Mode = 'generate' | 'existing' | 'manual';

/**
 * SSH for one operation. Three ways to say which key to use:
 *  - Generate a new key pair (ed25519 by default) in ~/.ssh,
 *  - Use an existing key found in ~/.ssh,
 *  - Enter the public key manually (paste or load a .pub file).
 * The app always resolves the matching PRIVATE key on this computer and shows exactly which key
 * will be used. The passphrase lives in this component's state and is sent only with the operation.
 */
export function SshKeyFields({ savedKey, onChange }: Props) {
  const { toast } = useApp();
  const [useSaved, setUseSaved] = useState(!!savedKey);
  const [mode, setMode] = useState<Mode>('existing');
  const [localKeys, setLocalKeys] = useState<{ directory: string; keys: SshLocalKey[] } | null>(null);
  const [selectedPub, setSelectedPub] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState('');
  /** Set when the public key came from a .pub file (shown instead of the textarea text). */
  const [fromFile, setFromFile] = useState<string | null>(null);
  const [match, setMatch] = useState<SshKeyMatch | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [manual, setManual] = useState<SshKeyInfo | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  // Generate
  const [genType, setGenType] = useState<SshKeyType>('ed25519');
  const [genName, setGenName] = useState('');
  const [genComment, setGenComment] = useState('');
  const [genPass, setGenPass] = useState('');
  const [genPass2, setGenPass2] = useState('');
  const [generated, setGenerated] = useState<SshLocalKey | null>(null);
  const [generating, setGenerating] = useState(false);

  const loadLocal = async () => {
    try {
      const l = await call('ssh:listKeys');
      setLocalKeys(l);
      return l;
    } catch (err) {
      setMatchError(toFriendly(err).message);
      return null;
    }
  };

  // Detect keys in ~/.ssh once; choose "existing" if there is a usable key, otherwise "generate".
  useEffect(() => {
    void loadLocal().then((l) => {
      if (!l) return;
      const usable = l.keys.filter((k) => k.match);
      if (usable.length === 0) setMode((m) => (m === 'existing' ? 'generate' : m));
      // Exactly one usable key: preselect it (the user still sees and can change it).
      else if (usable.length === 1) {
        setSelectedPub((s) => s ?? usable[0].pubPath);
        setMatch((m) => m ?? usable[0]);
      }
    });
  }, []);

  // Suggest a file name that does not exist yet (existing keys are never overwritten).
  useEffect(() => {
    if (genName || !localKeys) return;
    const taken = new Set(localKeys.keys.map((k) => k.pubPath.replace(/^.*[\\/]/, '').replace(/\.pub$/, '')));
    const baseName = `id_${genType}`;
    let name = baseName;
    for (let i = 2; taken.has(name); i++) name = `${baseName}_gitbaba${i === 2 ? '' : i}`;
    setGenName(name);
  }, [localKeys, genType, genName]);

  // Match a pasted public key after the user stops typing.
  useEffect(() => {
    if (useSaved || mode !== 'manual' || fromFile) return;
    const text = publicKey.trim();
    if (!text) {
      setMatch(null);
      setMatchError(null);
      return;
    }
    const t = setTimeout(() => {
      setBusy(true);
      call('ssh:matchPublicKey', { publicKey: text })
        .then((m) => {
          setMatch(m);
          setManual(null);
          setMatchError(null);
        })
        .catch((err) => {
          setMatch(null);
          setMatchError(toFriendly(err).message);
        })
        .finally(() => setBusy(false));
    }, 400);
    return () => clearTimeout(t);
  }, [publicKey, useSaved, fromFile, mode]);

  const key: KeyRef | null = useSaved && savedKey ? { ...savedKey, handle: 'saved' } : (manual ?? match?.match ?? null);

  useEffect(() => {
    // A freshly generated key keeps the passphrase the user just chose.
    setPassphrase(generated && match?.match?.path === key?.path ? genPass : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key?.path]);

  useEffect(() => {
    if (!key) return onChange(null, '');
    if (key.encrypted && !passphrase) return onChange(null, '');
    onChange(
      { keySource: 'file', keyHandle: key.handle, passphrase: passphrase || undefined, rememberKeyPath: !useSaved && remember },
      `SSH key ${key.fileName}${key.fingerprint ? ` (${key.fingerprint.slice(0, 20)}…)` : ''}${key.encrypted ? ' + passphrase' : ''}`,
    );
  }, [key, passphrase, remember, useSaved, onChange]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setMatch(null);
    setManual(null);
    setMatchError(null);
    setSelectedPub(null);
    setFromFile(null);
    setPublicKey('');
    if (m === 'generate' && generated) setMatch(generated);
  };

  const pickExisting = (k: SshLocalKey) => {
    setSelectedPub(k.pubPath);
    setMatch(k);
    setManual(null);
    setMatchError(null);
  };

  const loadPubFile = async () => {
    try {
      const m = await call('ssh:loadPublicKeyFile');
      if (!m) return;
      setUseSaved(false);
      setPublicKey('');
      setFromFile(`${m.type} ${m.fingerprint}${m.comment ? ` (${m.comment})` : ''}`);
      setMatch(m);
      setManual(null);
      setMatchError(null);
    } catch (err) {
      setMatchError(toFriendly(err).message);
    }
  };

  const chooseManually = async () => {
    try {
      const k = await call('ssh:pickKeyFile', { fingerprint: match?.fingerprint });
      if (k) setManual(k);
    } catch (err) {
      setMatchError(toFriendly(err).message);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setMatchError(null);
    try {
      const k = await call('ssh:generateKey', { type: genType, fileName: genName.trim(), comment: genComment.trim(), passphrase: genPass });
      setGenerated(k);
      setMatch(k);
      void loadLocal();
      toast(`New ${genType} key created: ${k.pubPath}`);
    } catch (err) {
      setMatchError(toFriendly(err).message);
    } finally {
      setGenerating(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await call('app:copyText', { text });
      toast('Public key copied');
    } catch (err) {
      setMatchError(toFriendly(err).message);
    }
  };

  const shownPublicKey = mode === 'existing' ? localKeys?.keys.find((k) => k.pubPath === selectedPub)?.publicKey : mode === 'generate' ? generated?.publicKey : null;
  const genPassMismatch = genPass !== genPass2;
  const canGenerate = !!genName.trim() && /^[A-Za-z0-9._-]+$/.test(genName.trim()) && !genPassMismatch && (genPass.length === 0 || genPass.length >= 5);

  const shortFp = (fp?: string | null) => (fp ? fp.replace(/^SHA256:/, '').slice(0, 10) : '');
  const keyName = (p: string) => p.replace(/^.*[\\/]/, '').replace(/\.pub$/, '');

  return (
    <div className="ssk">
      {savedKey && useSaved ? (
        <div className="ssk-bar">
          <span className="ssk-bar-ico">🔑</span>
          <span className="grow ssk-bar-text">
            <strong>{savedKey.fileName}</strong>
            <span className="ssk-tag">remembered</span>
            {savedKey.fingerprint && <span className="mono muted ssk-fp">{shortFp(savedKey.fingerprint)}…</span>}
          </span>
          <button className="ssk-link" onClick={() => setUseSaved(false)}>
            Change
          </button>
        </div>
      ) : (
        <>
          {/* Every key on this computer as a tile, plus "new" and "other" — one click to choose. */}
          <div className="ssk-wallet" role="radiogroup" aria-label="SSH key">
            {!localKeys && <div className="ssk-tile ghost">Looking for keys…</div>}
            {localKeys?.keys.map((k) => (
              <button
                key={k.pubPath}
                role="radio"
                aria-checked={mode === 'existing' && selectedPub === k.pubPath}
                className={`ssk-tile ${mode === 'existing' && selectedPub === k.pubPath ? 'on' : ''}`}
                disabled={!k.match}
                onClick={() => {
                  setMode('existing');
                  pickExisting(k);
                }}
                title={k.match ? `${k.pubPath}\n${k.fingerprint}${k.comment ? `\n${k.comment}` : ''}` : 'The private key next to this .pub file was not found'}
              >
                <span className="ssk-tile-top">
                  <strong className="ellipsis">{keyName(k.pubPath)}</strong>
                  {k.match?.encrypted && <span title="Passphrase protected">🔒</span>}
                </span>
                <span className="ssk-tile-sub ellipsis">
                  {k.type.replace('ssh-', '')}
                  {k.comment ? ` · ${k.comment}` : ''}
                </span>
              </button>
            ))}
            <button className={`ssk-tile add ${mode === 'generate' ? 'on' : ''}`} onClick={() => switchMode('generate')}>
              <span className="ssk-tile-top">
                <strong>＋ New key</strong>
              </span>
              <span className="ssk-tile-sub">generate in ~/.ssh</span>
            </button>
            <button className={`ssk-tile add ${mode === 'manual' ? 'on' : ''}`} onClick={() => switchMode('manual')}>
              <span className="ssk-tile-top">
                <strong>⋯ Other</strong>
              </span>
              <span className="ssk-tile-sub">paste or load .pub</span>
            </button>
            {localKeys && (
              <button className="ssk-rescan" onClick={() => void loadLocal()} title={`Rescan ${localKeys.directory}`}>
                ⟳
              </button>
            )}
          </div>

          {mode === 'generate' && !generated && (
            <div className="ssk-gen">
              <div className="segmented ssk-types">
                {(
                  [
                    ['ed25519', 'ed25519 ★', 'Modern, fast, short — recommended'],
                    ['ecdsa', 'ecdsa', 'Elliptic curve (521-bit)'],
                    ['rsa', 'rsa', 'RSA 4096-bit, for older servers'],
                  ] as [SshKeyType, string, string][]
                ).map(([t, l, d]) => (
                  <button
                    key={t}
                    className={genType === t ? 'on' : ''}
                    title={d}
                    onClick={() => {
                      setGenType(t);
                      setGenName('');
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <input value={genComment} onChange={(e) => setGenComment(e.target.value)} placeholder="Email or label (optional)" spellCheck={false} aria-label="Key comment" />
              <div className="ssk-pass">
                <input type="password" value={genPass} onChange={(e) => setGenPass(e.target.value)} placeholder="Passphrase (recommended)" autoComplete="new-password" aria-label="Passphrase" />
                {genPass && <input type="password" value={genPass2} onChange={(e) => setGenPass2(e.target.value)} placeholder="Repeat passphrase" autoComplete="new-password" aria-label="Repeat passphrase" />}
              </div>
              <div className="ssk-gen-foot">
                <span className={`small grow ${genPassMismatch && genPass2 ? 'text-danger' : genPass && genPass.length < 5 ? 'text-danger' : 'muted'}`}>
                  {genPassMismatch && genPass2 ? 'Passphrases do not match' : genPass && genPass.length < 5 ? 'At least 5 characters' : !genPass ? 'No passphrase: anyone with the file can use it' : '✓ Protected'}
                </span>
                <span className="small muted mono" title="File name in ~/.ssh — existing files are never overwritten">
                  <input className="ssk-name" value={genName} onChange={(e) => setGenName(e.target.value)} spellCheck={false} aria-label="File name" />
                </span>
                <button className="btn sm primary" disabled={!canGenerate || generating} onClick={generate}>
                  {generating ? 'Generating…' : 'Generate'}
                </button>
              </div>
            </div>
          )}

          {mode === 'manual' && (
            <div className="ssk-manual">
              {fromFile ? (
                <div className="ssk-bar">
                  <span className="grow">
                    <MaskedKey value={fromFile} />
                  </span>
                  <button
                    className="ssk-link"
                    onClick={() => {
                      setFromFile(null);
                      setMatch(null);
                      setManual(null);
                    }}
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <textarea
                  className="code"
                  rows={2}
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  placeholder="Paste your public key: ssh-ed25519 AAAA… you@example.com (never the private key)"
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
              <button className="btn sm" onClick={loadPubFile}>
                Load .pub…
              </button>
            </div>
          )}

          {busy && <div className="small muted">Finding the matching private key…</div>}
          {matchError && <div className="banner danger small">{matchError}</div>}
          {mode === 'manual' && match && !key && (
            <div className="ssk-bar warn">
              <span className="ssk-bar-ico">⚠</span>
              <span className="grow small">No private key for this public key on this computer.</span>
              <button className="btn sm" onClick={chooseManually}>
                Choose private key…
              </button>
            </div>
          )}
        </>
      )}

      {/* The chosen key, in one line — with what to do next. */}
      {key && !(savedKey && useSaved) && (
        <div className={`ssk-bar ok ${generated && mode === 'generate' ? 'fresh' : ''}`}>
          <span className="ssk-bar-ico">🔑</span>
          <span className="grow ssk-bar-text" title={`${key.path}\n${key.fingerprint ?? ''}`}>
            <strong>{key.fileName}</strong>
            {match?.type && <span className="ssk-tag">{match.type.replace('ssh-', '')}</span>}
            <span className="mono muted ssk-fp">{shortFp(key.fingerprint)}…</span>
          </span>
          {shownPublicKey && (
            <>
              <button className="ssk-link" onClick={() => copy(shownPublicKey)} title="Copy the public key">
                ⧉ Copy
              </button>
              <button className="ssk-link" onClick={() => call('shell:openExternal', { url: 'https://github.com/settings/ssh/new' }).catch(() => undefined)} title="Open GitHub → Settings → SSH keys">
                Add to GitHub ↗
              </button>
            </>
          )}
          {generated && mode === 'generate' && (
            <button className="ssk-link" onClick={() => setGenerated(null)} title="Make another key">
              ＋
            </button>
          )}
        </div>
      )}
      {key && generated && mode === 'generate' && <div className="small text-warn">New key: add it to GitHub before pushing, or GitHub will refuse it.</div>}

      {key && (key.encrypted || !useSaved) && (
        <div className="ssk-foot">
          {key.encrypted && (
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={`🔒 Passphrase for ${key.fileName}`}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              title="Checked on this computer before connecting; never stored"
            />
          )}
          {!useSaved && (
            <label className="check small ssk-remember" title="Only the file location is remembered — the passphrase is asked every time">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember for this repo</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
