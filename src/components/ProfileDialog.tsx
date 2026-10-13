import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { extractGeminiBodyScan, fileToBodyScanMedia, readGeminiConnection } from '../ai/client';
import type { InventoryState } from '../domain/types';
import type { NutritionTargets } from '../nutrition/types';
import {
  deleteBodyScanFile,
  readBodyScanFile,
  saveBodyScanFile,
  validateBodyScanFile,
} from '../profile/files';
import {
  isBodyScan,
  MAX_BODY_SCANS,
  MAX_BODY_SCAN_TEXT_LENGTH,
  type BodyScan,
  type BodyScanFile,
} from '../profile/types';
import { Modal } from './Modal';
import { NutritionTargetsEditor } from './NutritionTargetsEditor';
import './profile.css';

const nutritionFields = [
  ['caloriesKcal', 'Calories', 'kcal'],
  ['proteinGrams', 'Protein', 'g'],
  ['carbsGrams', 'Carbs', 'g'],
  ['fatGrams', 'Fat', 'g'],
] as const;

interface ProfileDialogProps {
  inventory: InventoryState;
  update: (change: (state: InventoryState) => InventoryState) => Promise<void>;
  onClose: () => void;
  onToast: (message: string) => void;
  onAttach: (scanId: string) => void;
  selectedScanIds?: string[];
  onConfigure: () => void;
}

function hasTargets(targets?: NutritionTargets): targets is NutritionTargets {
  return !!targets && nutritionFields.some(([key]) => targets[key] !== null);
}

function reportDate(date: string | null): string {
  if (!date) return 'Date not recorded';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

async function downloadOriginal(reference: BodyScanFile): Promise<void> {
  const blob = await readBodyScanFile(reference.id);
  if (!blob)
    throw new Error('The original file is missing. You can still edit the saved report text.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = reference.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function ProfileDialog({
  inventory,
  update,
  onClose,
  onToast,
  onAttach,
  selectedScanIds = [],
  onConfigure,
}: ProfileDialogProps) {
  const [editing, setEditing] = useState<BodyScan | 'new' | null>(null);
  const [targetDraft, setTargetDraft] = useState<{ targets?: NutritionTargets } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scans = [...(inventory.bodyScans ?? [])].sort((a, b) =>
    (b.recordedOn ?? '').localeCompare(a.recordedOn ?? ''),
  );

  async function remove(scan: BodyScan) {
    setBusy(true);
    setError('');
    try {
      await update((current) => ({
        ...current,
        bodyScans: (current.bodyScans ?? []).filter((item) => item.id !== scan.id),
      }));
      setDeleting(null);
      if (scan.file) {
        try {
          await deleteBodyScanFile(scan.file.id);
        } catch {
          onToast(
            'Report removed. Its unused original will stay in this browser until storage is cleared.',
          );
          return;
        }
      }
      onToast('Body scan removed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove this body scan.');
    } finally {
      setBusy(false);
    }
  }

  if (targetDraft) {
    return (
      <NutritionTargetsEditor
        targets={targetDraft.targets}
        onClose={() => setTargetDraft(null)}
        onConfigure={onConfigure}
        onSave={async (targets) => {
          await update((current) => ({ ...current, nutritionTargets: targets }));
          onToast('Daily nutrition targets saved.');
        }}
      />
    );
  }

  if (editing) {
    return (
      <BodyScanEditor
        scan={editing === 'new' ? undefined : editing}
        update={update}
        onClose={() => setEditing(null)}
        onToast={onToast}
        onConfigure={onConfigure}
      />
    );
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Your profile"
      description="Your nutrition goals and body scans, saved on this device."
      className="profile-modal"
    >
      <div className="profile-content">
        <section className="profile-targets" aria-label="Daily nutrition targets">
          <div className="profile-section-heading">
            <div>
              <h3>Daily targets</h3>
              <p>Use the values recommended to you.</p>
            </div>
            <button
              className="text-button"
              onClick={() => setTargetDraft({ targets: inventory.nutritionTargets })}
              disabled={busy}
            >
              {hasTargets(inventory.nutritionTargets) ? 'Edit targets' : 'Set targets'}
            </button>
          </div>
          {hasTargets(inventory.nutritionTargets) ? (
            <div className="profile-target-grid">
              {nutritionFields.map(([key, label, unit]) => (
                <div key={key}>
                  <span>{label}</span>
                  <strong>
                    {inventory.nutritionTargets?.[key]?.toLocaleString() ?? '—'}{' '}
                    <small>{unit}</small>
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="profile-note">
              Add daily calories and macros to help Gemini recommend portions.
            </p>
          )}
        </section>

        <section className="profile-scans" aria-label="Saved body scans">
          <div className="profile-section-heading">
            <div>
              <h3>
                Body scans <span className="profile-count">{scans.length}</span>
              </h3>
              <p>Keep reports and choose what Gemini can see.</p>
            </div>
            <button
              className="button secondary profile-add"
              onClick={() => setEditing('new')}
              disabled={busy || scans.length >= MAX_BODY_SCANS}
            >
              <Plus size={17} aria-hidden="true" /> Add scan
            </button>
          </div>
          {scans.length === 0 ? (
            <div className="profile-empty">
              <FileText size={28} aria-hidden="true" />
              <h4>Your reports belong here</h4>
              <p>
                Upload a PDF or picture, or paste report text. Add a report to Gemini when you want
                help choosing meals and portions.
              </p>
            </div>
          ) : (
            <div className="profile-scan-list">
              {scans.map((scan) => (
                <article className="profile-scan-card" key={scan.id}>
                  <div className="profile-scan-heading">
                    <span className="profile-file-icon">
                      <FileText size={20} aria-hidden="true" />
                    </span>
                    <div>
                      <h4>{scan.name}</h4>
                      <p>
                        {reportDate(scan.recordedOn)}
                        {scan.file
                          ? ` · ${scan.file.mimeType === 'application/pdf' ? 'PDF' : 'Picture'}`
                          : ' · Text'}
                      </p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label={`Delete ${scan.name}`}
                      onClick={() => {
                        setDeleting(scan.id);
                        setError('');
                      }}
                      disabled={busy}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                  <p className="profile-scan-preview">
                    {scan.text.trim() ||
                      'Original saved. Read the report or add text before sending it to Gemini.'}
                  </p>
                  <div className="profile-card-actions">
                    <button
                      className="button secondary"
                      onClick={() => setEditing(scan)}
                      disabled={busy}
                    >
                      View & edit
                    </button>
                    <button
                      className="button primary"
                      onClick={() => onAttach(scan.id)}
                      disabled={busy || !scan.text.trim()}
                    >
                      <Sparkles size={16} aria-hidden="true" />
                      {selectedScanIds.includes(scan.id) ? 'Open in Gemini' : 'Add to Gemini'}
                    </button>
                  </div>
                  {hasTargets(scan.targets) && (
                    <button
                      className="text-button profile-use-targets"
                      onClick={() => setTargetDraft({ targets: scan.targets })}
                      disabled={busy}
                    >
                      Review recommended targets from this report
                    </button>
                  )}
                  {deleting === scan.id && (
                    <div
                      className="profile-delete-confirm"
                      role="group"
                      aria-label={`Confirm deletion of ${scan.name}`}
                    >
                      <p>Delete this report and its original file?</p>
                      <div className="profile-card-actions">
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => setDeleting(null)}
                        >
                          Keep report
                        </button>
                        <button
                          className="button profile-danger"
                          disabled={busy}
                          onClick={() => void remove(scan)}
                        >
                          {busy ? 'Deleting…' : 'Delete report'}
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {scans.length >= MAX_BODY_SCANS && (
            <p className="profile-note">
              You can keep up to {MAX_BODY_SCANS} reports. Remove an older report to add another.
            </p>
          )}
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="profile-privacy">
          Reports stay on this device and are included in your backup. Gemini receives a report only
          when you choose to read it or attach it to a conversation.
        </p>
      </div>
    </Modal>
  );
}

function BodyScanEditor({
  scan,
  update,
  onClose,
  onToast,
  onConfigure,
}: {
  scan?: BodyScan;
  update: ProfileDialogProps['update'];
  onClose: () => void;
  onToast: (message: string) => void;
  onConfigure: () => void;
}) {
  const [name, setName] = useState(scan?.name ?? '');
  const [date, setDate] = useState(scan?.recordedOn ?? '');
  const [text, setText] = useState(scan?.text ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [targets, setTargets] = useState<NutritionTargets | undefined>(scan?.targets);
  const [action, setAction] = useState<'reading' | 'saving' | 'file' | null>(null);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = action !== null;
  const savedFile = keepOriginal ? scan?.file : undefined;

  useEffect(() => () => controller.current?.abort(), []);

  async function chooseFile(next?: File) {
    if (!next) return;
    setAction('file');
    setError('');
    try {
      const mimeType = await validateBodyScanFile(next, next.name);
      if (file || savedFile) {
        setText('');
        setDate('');
      }
      setFile(new File([next], next.name, { type: mimeType, lastModified: next.lastModified }));
      setWarnings([]);
      setTargets(undefined);
      if (!name.trim()) setName(next.name.replace(/\.[^.]+$/, '').slice(0, 160));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open this file.');
      if (fileInput.current) fileInput.current.value = '';
    } finally {
      setAction(null);
    }
  }

  async function extract() {
    const connection = readGeminiConnection();
    if (!connection) {
      onConfigure();
      return;
    }
    const nextController = new AbortController();
    controller.current = nextController;
    setAction('reading');
    setError('');
    setWarnings([]);
    try {
      let source = file;
      if (!source && savedFile) {
        const original = await readBodyScanFile(savedFile.id);
        if (!original)
          throw new Error(
            'The original file is missing. Paste the report text below or choose the file again.',
          );
        source = new File([original], savedFile.name, { type: savedFile.mimeType });
      }
      const result = await extractGeminiBodyScan(
        connection,
        {
          ...(text.trim() ? { text: text.trim() } : {}),
          ...(source ? { media: await fileToBodyScanMedia(source) } : {}),
        },
        nextController.signal,
      );
      if (nextController.signal.aborted) return;
      setText(result.text);
      if (result.recordedOn) setDate(result.recordedOn);
      setTargets(result.targets);
      setWarnings(result.warnings);
    } catch (reason) {
      if (!nextController.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not read this report. You can paste or enter its text instead.',
        );
    } finally {
      if (!nextController.signal.aborted) setAction(null);
      if (controller.current === nextController) controller.current = null;
    }
  }

  async function save() {
    setError('');
    if (!name.trim()) {
      setError('Give this report a name.');
      return;
    }
    if (!text.trim() && !file && !savedFile) {
      setError('Choose a file or add report text.');
      return;
    }
    setAction('saving');
    let newFile: BodyScanFile | undefined;
    try {
      if (file) newFile = await saveBodyScanFile(file);
      const original = newFile ?? savedFile;
      const next: BodyScan = {
        id: scan?.id ?? crypto.randomUUID(),
        name: name.trim(),
        recordedOn: date || null,
        text: text.trim(),
        ...(original ? { file: original } : {}),
        ...(targets ? { targets } : {}),
      };
      if (!isBodyScan(next))
        throw new Error('Check the report date and text, then try saving again.');
      await update((current) => {
        const existing = current.bodyScans ?? [];
        if (scan && !existing.some((item) => item.id === scan.id))
          throw new Error('This report was removed. Close this editor and add it again.');
        if (!scan && existing.length >= MAX_BODY_SCANS)
          throw new Error(
            `You can keep up to ${MAX_BODY_SCANS} reports. Remove an older report first.`,
          );
        return {
          ...current,
          bodyScans: scan
            ? existing.map((item) => (item.id === scan.id ? next : item))
            : [...existing, next],
        };
      });
      newFile = undefined; // Metadata now owns the original; later failures must not remove it.
      if (scan?.file && scan.file.id !== original?.id) {
        try {
          await deleteBodyScanFile(scan.file.id);
        } catch {
          onToast('Report saved. Its previous original could not be cleared from browser storage.');
          onClose();
          return;
        }
      }
      onToast(scan ? 'Body scan updated.' : 'Body scan saved.');
      onClose();
    } catch (reason) {
      if (newFile) {
        try {
          await deleteBodyScanFile(newFile.id);
        } catch {
          /* An unreferenced original can be cleared with browser storage. */
        }
      }
      setError(reason instanceof Error ? reason.message : 'Could not save this report.');
    } finally {
      setAction(null);
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={scan ? 'Your body scan' : 'Add a body scan'}
      description="Save the original and review its text before adding it to Gemini."
      className="profile-modal profile-editor-modal"
    >
      <form
        className="profile-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <button
          type="button"
          className="text-button profile-back"
          disabled={busy}
          onClick={onClose}
        >
          <ArrowLeft size={16} aria-hidden="true" /> Your profile
        </button>
        <div className="profile-editor-heading">
          <label>
            Report name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={160}
              disabled={busy}
              placeholder="e.g. October body scan"
            />
          </label>
          <label>
            Report date <span>Optional</span>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              disabled={busy}
            />
          </label>
        </div>
        <div className="profile-upload-area">
          <Upload size={24} aria-hidden="true" />
          <strong>{file?.name ?? savedFile?.name ?? 'Choose a PDF or picture'}</strong>
          <p>PDF, JPG, PNG or WebP · Up to 4 MB</p>
          <label className={`button secondary profile-file-button${busy ? ' is-disabled' : ''}`}>
            {file || savedFile ? 'Choose another file' : 'Choose file'}
            <input
              ref={fileInput}
              type="file"
              aria-label="Body scan file"
              accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp"
              disabled={busy}
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
          </label>
          {(file || savedFile) && (
            <div className="profile-original-actions">
              {savedFile && !file && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    void downloadOriginal(savedFile).catch((reason: unknown) =>
                      setError(
                        reason instanceof Error ? reason.message : 'Could not download this file.',
                      ),
                    );
                  }}
                >
                  Download original
                </button>
              )}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setFile(null);
                  setKeepOriginal(false);
                  if (fileInput.current) fileInput.current.value = '';
                }}
              >
                Remove file
              </button>
            </div>
          )}
        </div>
        <div className="profile-read-section">
          <div>
            <h3>Make the report readable</h3>
            <p>Gemini can read PDFs and pictures. You can also paste the text below.</p>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={busy || (!text.trim() && !file && !savedFile)}
            onClick={() => void extract()}
          >
            <Sparkles size={17} aria-hidden="true" />
            {action === 'reading' ? 'Reading report…' : 'Read with Gemini'}
          </button>
          {action === 'reading' && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                controller.current?.abort();
                setAction(null);
              }}
            >
              Cancel reading
            </button>
          )}
        </div>
        <label className="profile-report-text">
          Report text
          <textarea
            rows={8}
            maxLength={MAX_BODY_SCAN_TEXT_LENGTH}
            value={text}
            disabled={busy}
            onChange={(event) => {
              setText(event.target.value);
              setTargets(undefined);
            }}
            placeholder="Paste report text, enter it yourself, or choose Read with Gemini…"
          />
          <span className="profile-text-count">
            {text.length.toLocaleString()} / {MAX_BODY_SCAN_TEXT_LENGTH.toLocaleString()}
          </span>
        </label>
        {warnings.length > 0 && (
          <div className="profile-review-notes" role="status">
            {warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </div>
        )}
        {hasTargets(targets) && (
          <p className="profile-note">
            Recommended daily targets were found in this report. Saving the report keeps them for
            review; your daily targets will stay as you set them.
          </p>
        )}
        <p className="profile-note">
          Check the readings and date before saving. Keep ranges as written; you can set your daily
          goals separately in your profile.
        </p>
        <p className="profile-privacy">
          The file goes to Gemini only when you choose Read with Gemini. Saving a report keeps it on
          this device.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="profile-editor-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {action === 'saving' ? 'Saving…' : scan ? 'Save changes' : 'Save report'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
