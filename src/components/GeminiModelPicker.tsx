import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  discoverGeminiModels,
  GeminiError,
  normalizeGeminiConnection,
  type GeminiConnection,
} from '../ai/client';
import { ALLOWED_MODELS, isGeminiModel } from '../ai/protocol';
import { GEMINI_PRICING_URL, type GeminiModelCatalogEntry } from '../ai/models';
import {
  isModelCatalogFresh,
  readModelPreferences,
  reviewGeminiModel,
  saveModelCatalog,
} from '../ai/modelPreferences';
import { Choice } from './Choice';
import { Modal } from './Modal';
import './geminiModels.css';
import { publicUrl } from '../lib/publicUrl';

function builtInName(id: string): string {
  return id === 'gemini-3.5-flash-lite'
    ? 'Gemini 3.5 Flash-Lite · Recommended'
    : id === 'gemini-3.1-flash-lite'
      ? 'Gemini 3.1 Flash-Lite'
      : 'Gemini 3.8 Flash';
}

export function GeminiModelPicker({
  connection,
  draft,
  busy,
  onChange,
}: {
  connection: GeminiConnection | null;
  draft: GeminiConnection;
  busy: boolean;
  onChange: (connection: GeminiConnection) => void;
}) {
  const url = connection?.url ?? '';
  const token = connection?.token ?? '';
  const [preferences, setPreferences] = useState(() => readModelPreferences(url));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsWorkerUpdate, setNeedsWorkerUpdate] = useState(false);
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(8);
  const [reviewing, setReviewing] = useState<GeminiModelCatalogEntry | null>(null);
  const [billingDisabled, setBillingDisabled] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const attempt = useRef(0);
  const catalog = preferences.catalog;
  let paired = false;
  try {
    const proposed = normalizeGeminiConnection(draft);
    paired = proposed.url === url && proposed.token === token;
  } catch {
    /* Incomplete settings remain editable without a discovery request. */
  }

  const refresh = useCallback(
    async (force: boolean) => {
      if (!url || !token) return;
      const id = ++attempt.current;
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setLoading(true);
      setError('');
      setNeedsWorkerUpdate(false);
      setNote('');
      try {
        const result = await discoverGeminiModels(
          { url, token },
          { refresh: force },
          current.signal,
        );
        if (current.signal.aborted || id !== attempt.current) return;
        setPreferences((previous) => ({ ...previous, catalog: result }));
        try {
          saveModelCatalog(url, result);
          setPreferences(readModelPreferences(url));
        } catch {
          setNote('Models loaded, but this browser could not remember the list.');
        }
      } catch (reason) {
        if (!current.signal.aborted && id === attempt.current) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not refresh models. Your saved choice is unchanged.',
          );
          setNeedsWorkerUpdate(reason instanceof GeminiError && reason.code === 'worker_update');
        }
      } finally {
        if (!current.signal.aborted && id === attempt.current) setLoading(false);
      }
    },
    [url, token],
  );

  useEffect(() => {
    const saved = readModelPreferences(url);
    setPreferences(saved);
    setReviewing(null);
    setError('');
    setNeedsWorkerUpdate(false);
    setNote('');
    setLoading(false);
    if (url && token && (!saved.catalog || !isModelCatalogFresh(saved.catalog)))
      void refresh(false);
    return () => {
      controller.current?.abort();
    };
  }, [url, token, refresh]);

  const reviewed = new Set(preferences.reviewedIds);
  if (connection?.model && connection.modelReviewed) reviewed.add(connection.model);
  if (draft.model && draft.modelReviewed) reviewed.add(draft.model);
  const options = [
    { value: '', label: 'Worker default' },
    ...ALLOWED_MODELS.map((model) => ({ value: model, label: builtInName(model) })),
    ...(catalog?.models ?? [])
      .filter(
        (model) =>
          !isGeminiModel(model.id) && model.freeTier === 'verified' && reviewed.has(model.id),
      )
      .map((model) => ({ value: model.id, label: model.name })),
  ];
  if (draft.model && !options.some((option) => option.value === draft.model))
    options.push({ value: draft.model, label: `${draft.model} · Saved selection` });
  const discovered = (catalog?.models ?? []).filter((model) => !isGeminiModel(model.id));
  const matches = discovered
    .filter((model) =>
      `${model.name} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.freeTier === 'verified') - Number(a.freeTier === 'verified') ||
        a.name.localeCompare(b.name),
    );
  const fresh = !!catalog && isModelCatalogFresh(catalog);

  function select(model: string) {
    if (busy) return;
    const next = { ...draft };
    delete next.modelReviewed;
    if (!model) delete next.model;
    else {
      next.model = model;
      if (!isGeminiModel(model) && reviewed.has(model)) next.modelReviewed = true;
    }
    onChange(next);
  }

  return (
    <section className="gemini-model-setting" aria-label="Gemini models">
      <div className="model-picker-heading">
        <h4>Gemini model</h4>
        <button
          type="button"
          className="text-button"
          disabled={busy || loading || !paired}
          onClick={() => void refresh(true)}
        >
          <RefreshCw size={15} aria-hidden="true" />{' '}
          {loading ? 'Refreshing models…' : 'Refresh models'}
        </button>
      </div>
      <Choice label="Gemini model" value={draft.model ?? ''} options={options} onChange={select} />
      <p className="settings-note">
        Save below to use your choice for messages and document reading. New models appear for
        review; your choice never changes automatically.
      </p>
      {!connection && (
        <p className="settings-note">Save your connection to discover models from Google.</p>
      )}
      {connection && !paired && (
        <p className="settings-note">
          Save your connection changes before refreshing or reviewing models.
        </p>
      )}
      {loading && (
        <p className="model-discovery-note" role="status">
          Checking Google’s models and free-tier pricing…
        </p>
      )}
      {catalog && (
        <p className="model-discovery-note">
          Last checked {new Date(catalog.checkedAt).toLocaleString()}
          {!fresh ? ' · Refresh to review new models' : ''}
        </p>
      )}
      {error && (
        <p className="model-discovery-error" role="status">
          {error}
        </p>
      )}
      {needsWorkerUpdate && (
        <a className="text-button" href={publicUrl('mise-gemini-worker.js')} download>
          Download updated Worker
        </a>
      )}
      {note && (
        <p className="model-discovery-note" role="status">
          {note}
        </p>
      )}
      {catalog?.warnings.map((warning, index) => (
        <p className="model-discovery-note" key={index}>
          {warning}
        </p>
      ))}
      {catalog && (
        <details className="model-discovery">
          <summary>
            Models from Google <span>{discovered.length}</span>
          </summary>
          <p>
            New choices need a review. Only models with verified free-tier input and output can be
            enabled.
          </p>
          {discovered.length > 0 && (
            <input
              type="search"
              aria-label="Find discovered models"
              placeholder="Find a model"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setShown(8);
              }}
            />
          )}
          <div className="discovered-models">
            {matches.slice(0, shown).map((model) => (
              <article key={model.id} className="discovered-model">
                <div>
                  <h5>{model.name}</h5>
                  <span className={`model-tier ${model.freeTier}`}>
                    {model.freeTier === 'verified'
                      ? 'Free tier listed'
                      : model.freeTier === 'unavailable'
                        ? 'Unavailable on free tier'
                        : 'Pricing unverified'}
                  </span>
                </div>
                <small>{model.id}</small>
                {model.description && <p>{model.description}</p>}
                {model.freeTier === 'verified' ? (
                  reviewed.has(model.id) ? (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !paired}
                      onClick={() => select(model.id)}
                    >
                      Choose {model.name}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || loading || !fresh || !!error || !paired}
                      onClick={() => {
                        setReviewing(model);
                        setBillingDisabled(false);
                        setNote('');
                      }}
                    >
                      Review {model.name}
                    </button>
                  )
                ) : (
                  <span className="model-disabled-note">
                    {model.freeTier === 'unavailable'
                      ? 'Requires a paid tier; kept disabled.'
                      : 'Free-tier pricing could not be confirmed; kept disabled.'}
                  </span>
                )}
              </article>
            ))}
          </div>
          {!matches.length && (
            <p className="model-discovery-note">
              {discovered.length
                ? 'No matching models. Try a different name.'
                : 'No additional chat models were listed. Your existing choices remain available.'}
            </p>
          )}
          {matches.length > shown && (
            <button
              type="button"
              className="text-button"
              onClick={() => setShown((count) => count + 8)}
            >
              Show more models
            </button>
          )}
        </details>
      )}
      <Modal
        open={!!reviewing}
        onClose={() => setReviewing(null)}
        title={reviewing ? `Enable ${reviewing.name}?` : 'Review Gemini model'}
        description="Review this model before adding it to your choices."
        className="model-review-modal"
      >
        {reviewing && (
          <div className="model-review">
            <p>{reviewing.description}</p>
            <p className="settings-note">
              Google’s Standard pricing currently lists free input and output for{' '}
              <strong>{reviewing.id}</strong>. API quotas and document support can vary by model and
              project.
            </p>
            <a href={GEMINI_PRICING_URL} target="_blank" rel="noreferrer" className="text-button">
              View Google’s pricing <ExternalLink size={15} />
            </a>
            <p className="settings-note">
              Free-tier listing does not verify your account’s billing settings. Keep billing
              disabled in your Google API project.
            </p>
            <label className="model-review-check">
              <input
                type="checkbox"
                checked={billingDisabled}
                onChange={(event) => setBillingDisabled(event.target.checked)}
              />{' '}
              My Google API project has billing disabled
            </label>
            <div className="form-footer">
              <button className="button secondary" type="button" onClick={() => setReviewing(null)}>
                Cancel
              </button>
              <button
                className="button primary"
                type="button"
                disabled={!billingDisabled || busy || !paired || !fresh || loading || !!error}
                onClick={() => {
                  try {
                    reviewGeminiModel(url, reviewing.id);
                    setPreferences(readModelPreferences(url));
                    onChange({ ...draft, model: reviewing.id, modelReviewed: true });
                    setNote('Model enabled. Choose Save & check connection below to use it.');
                    setReviewing(null);
                  } catch {
                    setNote(
                      'Your browser could not save this review. Allow local storage and try again.',
                    );
                  }
                }}
              >
                Enable model
              </button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
