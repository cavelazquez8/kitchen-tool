import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ALLOWED_MODELS, isGeminiModel } from '../ai/protocol';
import { Choice } from './Choice';
import {
  generateGeminiAccessToken,
  checkGeminiConnection,
  clearGeminiConnection,
  readGeminiConnection,
  readGeminiConnectionDraft,
  saveGeminiConnectionDraft,
  saveGeminiConnection,
  normalizeGeminiConnection,
  type GeminiConnection,
} from '../ai/client';
export function GeminiSettings({ onToast }: { onToast: (message: string) => void }) {
  const initial = readGeminiConnection();
  const [draft, setDraft] = useState(
    () => readGeminiConnectionDraft() ?? initial ?? { url: '', token: '' },
  );
  const { url, token } = draft;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const checkController = useRef<AbortController | null>(null);
  useEffect(() => () => checkController.current?.abort(), []);
  function updateDraft(next: GeminiConnection) {
    setDraft(next);
    setMessage('');
    try {
      saveGeminiConnectionDraft(next);
    } catch {
      setMessage(
        'Your browser could not remember these settings. Allow local storage to save them.',
      );
    }
  }
  async function connect() {
    const controller = new AbortController();
    checkController.current = controller;
    setBusy(true);
    setMessage('');
    try {
      const connection = normalizeGeminiConnection(draft);
      await checkGeminiConnection(connection, controller.signal);
      if (controller.signal.aborted) return;
      saveGeminiConnection(connection);
      setDraft(connection);
      setMessage('Backend connected. Send your first request to verify Gemini access.');
      onToast('Gemini connection saved on this device.');
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not connect. Check the address and pairing token.',
      );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (checkController.current === controller) checkController.current = null;
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
      <p className="settings-note">
        {initial
          ? 'Connection saved on this device. You can send a message in the Gemini tab.'
          : 'Connection not saved yet. Enter your details below, then check the connection.'}
      </p>
      <label>
        Backend address
        <input
          type="url"
          disabled={busy}
          value={url}
          onChange={(e) => updateDraft({ ...draft, url: e.target.value })}
          placeholder="https://mise-gemini.your-name.workers.dev"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <p className="field-note">
        Use the full Worker address: mise-gemini.your-name.workers.dev. The https:// prefix is
        optional.
      </p>
      <label>
        Pairing token
        <input
          type="password"
          disabled={busy}
          value={token}
          onChange={(e) => updateDraft({ ...draft, token: e.target.value })}
          placeholder="Your personal Mise access token"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <button
        className="text-button"
        disabled={busy}
        onClick={() => {
          const generated = generateGeminiAccessToken();
          updateDraft({ ...draft, token: generated });
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
      <div className="gemini-model-setting">
        <h4>Gemini model</h4>
        <Choice
          label="Gemini model"
          value={draft.model ?? ''}
          options={[
            { value: '', label: 'Worker default' },
            ...ALLOWED_MODELS.map((model) => ({
              value: model,
              label:
                model === 'gemini-3.5-flash-lite'
                  ? 'Gemini 3.5 Flash-Lite · Recommended'
                  : model === 'gemini-3.1-flash-lite'
                    ? 'Gemini 3.1 Flash-Lite'
                    : 'Gemini 3.8 Flash',
            })),
          ]}
          onChange={(model) => {
            if (busy) return;
            const next = { ...draft };
            if (isGeminiModel(model)) next.model = model;
            else delete next.model;
            updateDraft(next);
          }}
        />
        <p className="settings-note">
          Save below to use this model for messages and document reading. These models offer a free
          API tier with usage limits. Model switching needs the latest Worker code above.
        </p>
      </div>
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
              setDraft({ url: '', token: '' });
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
