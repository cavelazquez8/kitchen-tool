import { useState } from 'react';
import { fileToGeminiMedia, readGeminiConnection, extractGeminiNutrition } from '../ai/client';
import { isNutritionTargets, type NutritionTargets } from '../nutrition/types';
import { Modal } from './Modal';

const fields = [
  ['caloriesKcal', 'Calories', 'kcal'],
  ['proteinGrams', 'Protein', 'g'],
  ['carbsGrams', 'Carbohydrates', 'g'],
  ['fatGrams', 'Fat', 'g'],
] as const;
export function NutritionTargetsEditor({
  targets,
  onClose,
  onSave,
  onConfigure,
}: {
  targets?: NutritionTargets;
  onClose: () => void;
  onSave: (targets: NutritionTargets) => Promise<void>;
  onConfigure: () => void;
}) {
  const [values, setValues] = useState<Record<keyof NutritionTargets, string>>(
    () =>
      Object.fromEntries(fields.map(([key]) => [key, String(targets?.[key] ?? '')])) as Record<
        keyof NutritionTargets,
        string
      >,
  );
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  async function extract() {
    const connection = readGeminiConnection();
    if (!connection) {
      onConfigure();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await extractGeminiNutrition(connection, {
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(file ? { media: await fileToGeminiMedia(file) } : {}),
      });
      setValues(
        Object.fromEntries(
          fields.map(([key]) => [key, String(result.targets[key] ?? '')]),
        ) as Record<keyof NutritionTargets, string>,
      );
      setNotes([result.sourceText, ...result.warnings].filter(Boolean));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not read these targets. You can enter them below.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const next = Object.fromEntries(
      fields.map(([key]) => [key, values[key].trim() ? Number(values[key]) : null]),
    );
    if (!isNutritionTargets(next)) {
      setError('Enter positive numbers, or leave a target blank.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save targets.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Your daily nutrition targets"
      description="Use the daily values recommended to you. Review extracted values before saving."
      className="nutrition-modal"
    >
      <form
        className="nutrition-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <details className="nutrition-extraction">
          <summary>Read targets from text or a report picture</summary>
          <label>
            Recommended targets or report text
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={24000}
              rows={4}
              placeholder="Paste your recommended daily calories and macros…"
            />
          </label>
          <label>
            Report picture · JPG, PNG or WebP up to 1 MB
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <p className="field-note">
            The picture goes to Gemini when you choose Extract. Mise saves only the values you
            approve. Body measurements alone won’t be turned into daily targets.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy || (!text.trim() && !file)}
            onClick={() => void extract()}
          >
            {busy ? 'Reading…' : 'Extract for review'}
          </button>
        </details>
        {notes.length > 0 && (
          <div className="nutrition-review" role="status">
            {notes.map((note, index) => (
              <p key={index}>{note}</p>
            ))}
          </div>
        )}
        <div className="nutrition-target-grid">
          {fields.map(([key, label, unit]) => (
            <label key={key}>
              {label} per day <span>{unit}</span>
              <input
                type="number"
                min={key === 'caloriesKcal' ? '0.1' : '0'}
                step="any"
                value={values[key]}
                onChange={(e) => setValues((current) => ({ ...current, [key]: e.target.value }))}
                placeholder="Optional"
              />
            </label>
          ))}
        </div>
        <p className="field-note">
          These are daily targets. Gemini can help you decide how much to allocate to this meal.
          Unknown recipe nutrition stays unknown.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="hub-actions">
          <button type="submit" className="button primary" disabled={busy}>
            Save reviewed targets
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              setValues({ caloriesKcal: '', proteinGrams: '', carbsGrams: '', fatGrams: '' })
            }
          >
            Clear values
          </button>
        </div>
      </form>
    </Modal>
  );
}
