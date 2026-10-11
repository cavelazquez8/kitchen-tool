import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  generateGeminiAccessToken,
  checkGeminiConnection,
  clearGeminiConnection,
  readGeminiConnection,
  saveGeminiConnection,
} from '../ai/client';
export function GeminiSettings({ onToast }: { onToast: (message: string) => void }) {
  const initial = readGeminiConnection();
  const [url, setUrl] = useState(initial?.url ?? '');
  const [token, setToken] = useState(initial?.token ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function connect() {
    setBusy(true);
    setMessage('');
    try {
      const connection = { url: url.trim(), token: token.trim() };
      const result = await checkGeminiConnection(connection);
      saveGeminiConnection(connection);
      setMessage('Backend connected. Send your first request to verify Gemini access.');
      onToast('Gemini connection saved on this device.');
      if (!result.ok) throw new Error('Could not connect.');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not connect. Check the address and pairing token.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section gemini-settings">
      <div className="settings-section-heading">
        <Sparkles size={21} />
        <div>
          <h3>Gemini inside Mise</h3>
          <p>Optional · Free-tier connection</p>
        </div>
      </div>
      <details className="gemini-setup">
        <summary>Set up the free connection</summary>
        <ol>
          <li>
            <a className="text-button" href="/mise-gemini-worker.js" download>
              Download Worker code
            </a>{' '}
            and paste it into a Worker named mise-gemini in your Cloudflare dashboard.
          </li>
          <li>
            Keep Google AI Studio on the free tier with billing disabled. Save its API key in
            Cloudflare as the secret GEMINI_API_KEY.
          </li>
          <li>
            Generate a pairing token below. Copy it into the Cloudflare secret MISE_ACCESS_TOKEN.
          </li>
          <li>
            Set ALLOWED_ORIGIN to https://mise-kitchen-cv8.expertroot3.chatgpt.site and GEMINI_MODEL
            to gemini-3.5-flash-lite. Deploy, enter your Worker address below, and connect.
          </li>
        </ol>
      </details>
      <p className="settings-note">
        Add your Cloudflare backend address and personal pairing token. Your Google API key stays in
        Cloudflare.
      </p>
      <label>
        Backend address
        <input
          type="url"
          disabled={busy}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mise-gemini.your-name.workers.dev"
          autoComplete="off"
        />
      </label>
      <label>
        Pairing token
        <input
          type="password"
          disabled={busy}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Your personal Mise access token"
          autoComplete="off"
        />
      </label>
      <button
        className="text-button"
        disabled={busy}
        onClick={() => {
          const generated = generateGeminiAccessToken();
          setToken(generated);
          setMessage(
            'New pairing token generated. Copy it into the MISE_ACCESS_TOKEN secret in Cloudflare before connecting.',
          );
        }}
      >
        Generate pairing token
      </button>
      <button
        className="text-button"
        disabled={!token}
        onClick={() => {
          void navigator.clipboard
            .writeText(token)
            .then(() =>
              onToast('Pairing token copied. Paste it into Cloudflare as MISE_ACCESS_TOKEN.'),
            )
            .catch(() => setMessage('Could not copy. Please copy the token manually.'));
        }}
      >
        Copy pairing token
      </button>
      <p className="field-note">
        Connection credentials stay on this device and are excluded from backups. Free-tier requests
        may be used by Google for product improvement.
      </p>
      <div className="hub-actions">
        <button
          className="button primary"
          disabled={busy || !url.trim() || !token.trim()}
          onClick={() => {
            void connect();
          }}
        >
          {busy ? 'Checking…' : 'Save & check connection'}
        </button>
        {initial && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              clearGeminiConnection();
              setUrl('');
              setToken('');
              setMessage('Disconnected.');
              onToast('Gemini disconnected.');
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      {message && (
        <p className="settings-note" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
