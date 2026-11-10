import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ExternalLink } from 'lucide-react';
import { readGeminiConnection } from '../ai/client';
import { queryRecipeProviders, searchRecipeProviders } from '../recipes/providerClient';
import {
  RECIPE_PROVIDER_INFO,
  type RecipeProviderId,
  type RecipeProviderStatus,
} from '../recipes/providers';
import './recipeProviders.css';
import { publicUrl } from '../lib/publicUrl';

type SearchCheck = {
  state: 'pending' | 'success' | 'empty' | 'error';
  message: string;
  warnings?: string[];
};

export function RecipeProviderSettings({ onToast }: { onToast: (message: string) => void }) {
  const [providers, setProviders] = useState<RecipeProviderStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [searchChecks, setSearchChecks] = useState<Partial<Record<RecipeProviderId, SearchCheck>>>(
    {},
  );
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function check() {
    if (controller.current) return;
    const connection = readGeminiConnection();
    if (!connection) {
      setMessage(
        'Connect your Worker in Gemini settings first. Your built-in cookbook already works.',
      );
      return;
    }
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setMessage('');
    try {
      const status = await queryRecipeProviders(connection, next.signal);
      if (next.signal.aborted) return;
      setProviders(status);
      setSearchChecks({});
      setMessage(
        'Setup checked without calling the recipe APIs. Use Test search to verify each source with a small request from your free allowance.',
      );
      onToast('Recipe source settings checked.');
    } catch (error) {
      if (!next.signal.aborted)
        setMessage(error instanceof Error ? error.message : 'Could not check recipe sources.');
    } finally {
      if (!next.signal.aborted) setBusy(false);
      if (controller.current === next) controller.current = null;
    }
  }
  async function testSearch(provider: RecipeProviderId) {
    if (controller.current) return;
    const connection = readGeminiConnection();
    if (!connection) {
      setSearchChecks((current) => ({
        ...current,
        [provider]: {
          state: 'error',
          message: 'Connect your Worker in Gemini settings, then test this source again.',
        },
      }));
      return;
    }
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setSearchChecks((current) => ({
      ...current,
      [provider]: { state: 'pending', message: 'Searching for “chicken”…' },
    }));
    try {
      const result = await searchRecipeProviders(
        connection,
        { provider, query: 'chicken', page: 1, limit: 1 },
        next.signal,
      );
      if (next.signal.aborted) return;
      const count = result.recipes.length;
      setSearchChecks((current) => ({
        ...current,
        [provider]: {
          state: count ? 'success' : 'empty',
          message: count
            ? `Search verified · ${count} readable recipe${count === 1 ? '' : 's'} returned.`
            : result.warnings.some((warning) => warning.includes('omitted'))
              ? 'Search completed, but no readable recipes were returned. See the source response below.'
              : 'Search completed · No recipes returned for “chicken”. Try another dish in Recipes.',
          warnings: result.warnings,
        },
      }));
    } catch (error) {
      if (!next.signal.aborted)
        setSearchChecks((current) => ({
          ...current,
          [provider]: {
            state: 'error',
            message:
              error instanceof Error
                ? `Search failed · ${error.message}`
                : 'Search failed · Could not search this recipe source.',
          },
        }));
    } finally {
      if (!next.signal.aborted) setBusy(false);
      if (controller.current === next) controller.current = null;
    }
  }
  return (
    <section className="settings-section recipe-provider-settings">
      <div className="settings-section-heading">
        <BookOpen size={21} />
        <div>
          <h3>More recipe sources</h3>
          <p>Optional · Free personal accounts</p>
        </div>
      </div>
      <p className="settings-note">
        Your built-in cookbook and TheMealDB need no extra setup. Add another source when you want
        more variety.
      </p>
      <div className="provider-status-list">
        {RECIPE_PROVIDER_INFO.map((provider) => {
          const status = providers?.find((item) => item.id === provider.id);
          const searchCheck = searchChecks[provider.id];
          return (
            <div key={provider.id}>
              <div className="provider-status-row">
                <div>
                  <strong>{provider.name}</strong>
                  <small>{provider.freeAllowance}</small>
                  {status?.configured && (
                    <button
                      className="text-button"
                      aria-label={`Test ${provider.name} search`}
                      disabled={busy}
                      onClick={() => void testSearch(provider.id)}
                    >
                      {searchCheck?.state === 'pending' ? 'Testing search…' : 'Test search'}
                    </button>
                  )}
                </div>
                <span className={status?.configured ? 'provider-configured' : ''}>
                  {status?.configured ? (
                    <>
                      <Check size={14} /> Configured
                    </>
                  ) : status ? (
                    'Needs setup'
                  ) : (
                    'Not checked'
                  )}
                </span>
              </div>
              {searchCheck && (
                <div
                  className="settings-note"
                  role={searchCheck.state === 'error' ? 'alert' : 'status'}
                  aria-label={`${provider.name} search check`}
                >
                  <p>{searchCheck.message}</p>
                  {searchCheck.warnings?.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => {
          void check();
        }}
      >
        {busy && !Object.values(searchChecks).some((check) => check?.state === 'pending')
          ? 'Checking sources…'
          : 'Check recipe sources'}
      </button>
      {message && (
        <p className="settings-note" role="status">
          {message}
        </p>
      )}
      <details className="gemini-setup provider-setup-guide">
        <summary>Connect a free recipe source</summary>
        <ol>
          <li>
            <a href="https://recipeapi.io/register" target="_blank" rel="noreferrer">
              Create a free RecipeAPI.io account <ExternalLink size={13} />
            </a>
            . Choose Free, without a card or a paid trial.
          </li>
          <li>
            In your Cloudflare Worker, add its key as the secret <code>RECIPEAPI_API_KEY</code>, and
            add a Text variable <code>RECIPEAPI_PLAN</code> with the value <code>free</code>.
          </li>
          <li>
            <a className="text-button" href={publicUrl('mise-gemini-worker.js')} download>
              Download the updated Worker code
            </a>
            , replace your Worker code, and deploy. Keep your existing Gemini settings and secrets.
          </li>
          <li>
            Return here and check recipe sources. In Recipes, choose RecipeAPI.io in Recipe source
            and press Search RecipeAPI.io.
          </li>
        </ol>
        <p className="field-note">
          RecipeAPI.io lets you save selected recipes for this personal, non-commercial kitchen
          library. Source attribution stays attached.
        </p>
        <details className="provider-spoonacular-guide">
          <summary>Also use Spoonacular for discovery</summary>
          <p>
            Register for the Free plan directly at{' '}
            <a
              href="https://spoonacular.com/food-api/console#Dashboard"
              target="_blank"
              rel="noreferrer"
            >
              Spoonacular
            </a>
            , with no card. Add its key as the Cloudflare secret <code>SPOONACULAR_API_KEY</code>{' '}
            and set the Text variable <code>SPOONACULAR_PLAN</code> to <code>free</code>.
          </p>
          <p className="field-note">
            These results link to the original recipe and remain available temporarily.
            Spoonacular’s storage rules prevent saving its API recipes to your library or backups.
          </p>
        </details>
      </details>
    </section>
  );
}
