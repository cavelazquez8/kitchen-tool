import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Camera, Check, FoldVertical, Keyboard, LoaderCircle, ScanLine, X } from 'lucide-react';
import { normalizeBarcode } from './lookup';
import { ScanGate } from './scanGate';
import './scanner.css';

export interface ScannerProps {
  onAdd: (code: string) => Promise<void | boolean>;
  onClose: () => void;
  tray?: ReactNode;
  packageCount?: number;
}

export const AUTO_NEXT_PREFERENCE_KEY = 'mise:scanner:auto-next:v1';

function readAutoNextPreference(): boolean {
  try {
    return localStorage.getItem(AUTO_NEXT_PREFERENCE_KEY) !== 'false';
  } catch {
    return true;
  }
}

interface DevicePosture extends EventTarget {
  type: 'continuous' | 'folded';
}

function cameraError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Camera access is off. Allow it in Edge’s site permissions, then try again—or type the barcode below.';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No camera was found. You can still type a barcode below.';
  }
  if (error instanceof DOMException && error.name === 'NotReadableError') {
    return 'Another app may be using your camera. Close it and try again, or type the barcode below.';
  }
  return 'The camera couldn’t start. Try again, or type the barcode below.';
}

function currentPosture(): DevicePosture | undefined {
  return (navigator as Navigator & { devicePosture?: DevicePosture }).devicePosture;
}

export function Scanner({ onAdd, onClose, tray, packageCount = 0 }: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const startAttemptRef = useRef(0);
  const busyRef = useRef(false);
  const gateRef = useRef(new ScanGate());
  const onAddRef = useRef(onAdd);
  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'active' | 'error'>('idle');
  const [cameraMessage, setCameraMessage] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(true);
  const [autoNext, setAutoNext] = useState(readAutoNextPreference);
  const autoNextRef = useRef(autoNext);
  const [feedback, setFeedback] = useState('');
  const [formError, setFormError] = useState('');
  const [folded, setFolded] = useState(() => currentPosture()?.type === 'folded');
  const [manualLayout, setManualLayout] = useState<boolean | null>(null);
  const isTabletop = manualLayout ?? folded;

  useEffect(() => {
    onAddRef.current = onAdd;
  }, [onAdd]);

  const stopCamera = useCallback(() => {
    startAttemptRef.current++;
    controlsRef.current?.stop();
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    const posture = currentPosture();
    if (!posture) return;
    const update = () => setFolded(posture.type === 'folded');
    posture.addEventListener('change', update);
    return () => posture.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopCamera();
        setCameraState('idle');
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [stopCamera]);

  const addCode = useCallback(async (normalizedCode: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFormError('');
    setFeedback('Finding this item…');
    try {
      const added = await onAddRef.current(normalizedCode);
      if (mountedRef.current) {
        setFeedback(
          added === false
            ? 'Item not added. You can scan again when ready.'
            : 'Package added to your review.',
        );
        if (added !== false) setCode('');
      }
    } catch (error) {
      if (mountedRef.current) {
        setFeedback('');
        setFormError(
          error instanceof Error ? error.message : 'This item couldn’t be added. Try again.',
        );
      }
    } finally {
      gateRef.current.resetObservations();
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const startCamera = async () => {
    stopCamera();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraMessage(
        'Camera scanning needs a secure website connection. You can type the barcode below.',
      );
      setCameraState('error');
      return;
    }
    const attempt = ++startAttemptRef.current;
    gateRef.current.rearm();
    setArmed(true);
    setFeedback('');
    setCameraState('starting');
    setCameraMessage('');
    let stream: MediaStream | null = null;
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, NotFoundException }] =
        await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
      if (!mountedRef.current || attempt !== startAttemptRef.current) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1_280 },
          height: { ideal: 720 },
        },
      });
      if (!mountedRef.current || attempt !== startAttemptRef.current || !videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const reader = new BrowserMultiFormatReader(undefined, {
        delayBetweenScanSuccess: 350,
        delayBetweenScanAttempts: 250,
      });
      reader.possibleFormats = [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
      ];
      const controls = await reader.decodeFromStream(stream, videoRef.current, (result, error) => {
        if (busyRef.current || !mountedRef.current || attempt !== startAttemptRef.current) return;
        const gate = gateRef.current;
        const now = performance.now();
        if (!result) {
          // Checksum/format errors may still describe a visible barcode. Only a
          // no-barcode observation contributes to automatic absence detection.
          if (error instanceof NotFoundException) {
            const wasArmed = gate.isArmed;
            gate.observe(null, now, autoNextRef.current);
            if (!wasArmed && gate.isArmed) {
              setArmed(true);
              setFeedback('Ready for the next package.');
            }
          } else {
            gate.resetObservations();
          }
          return;
        }
        const normalized = normalizeBarcode(
          result.getText(),
          result.getBarcodeFormat() === BarcodeFormat.UPC_E ? 'UPC_E' : undefined,
        );
        if (!normalized) {
          gate.resetObservations();
          return;
        }
        if (!gate.observe(normalized, now, autoNextRef.current)) return;
        setArmed(false);
        void addCode(normalized);
      });
      if (!mountedRef.current || attempt !== startAttemptRef.current) {
        controls.stop();
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      controlsRef.current = controls;
      setCameraState('active');
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (mountedRef.current && attempt === startAttemptRef.current) {
        streamRef.current = null;
        setCameraMessage(cameraError(error));
        setCameraState('error');
      }
    }
  };

  const rearm = () => {
    gateRef.current.rearm();
    setArmed(true);
    setFeedback('Ready for the next package.');
  };

  const submitBarcode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeBarcode(code);
    if (!normalized) {
      setFormError('Enter the complete UPC or EAN barcode, including its first and last digits.');
      return;
    }
    if (busyRef.current) return;
    gateRef.current.capture(normalized, performance.now());
    setArmed(false);
    void addCode(normalized);
  };

  return (
    <section
      className={`scanner${isTabletop ? ' scanner--tabletop' : ''}`}
      aria-label="Scan groceries"
    >
      <header className="scanner__header">
        <div>
          <span className="scanner__eyebrow">GROCERY CHECK-IN</span>
          <h2>Scan your groceries</h2>
          <p>One scan, one package. Review everything before adding it.</p>
        </div>
        <button
          type="button"
          className="scanner__icon-button"
          aria-label="Close scanner"
          onClick={() => {
            stopCamera();
            onClose();
          }}
        >
          <X size={22} />
        </button>
      </header>
      <div className="scanner__layout">
        <div className="scanner__capture">
          <div className={`scanner__preview${!armed ? ' scanner__preview--captured' : ''}`}>
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              aria-label="Live barcode camera"
              className={cameraState === 'active' ? '' : 'scanner__video--inactive'}
            />
            {cameraState === 'active' ? (
              <>
                <div className="scanner__target" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <span className="scanner__camera-label">
                  <span className={armed ? 'scanner__live-dot' : 'scanner__paused-dot'} />
                  {busy ? 'Reviewing item…' : armed ? 'Ready to scan' : 'Package captured'}
                </span>
              </>
            ) : (
              <div className="scanner__camera-placeholder">
                <div className="scanner__camera-symbol">
                  <Camera size={34} strokeWidth={1.5} />
                </div>
                <h3>
                  {cameraState === 'error' ? 'Let’s try another way' : 'Point. Scan. Put away.'}
                </h3>
                <p>{cameraMessage || 'Hold the barcode in front of your rear camera.'}</p>
                <button
                  type="button"
                  className="scanner__button scanner__button--primary"
                  onClick={() => {
                    void startCamera();
                  }}
                  disabled={cameraState === 'starting' || busy}
                >
                  {cameraState === 'starting' ? (
                    <LoaderCircle size={18} className="scanner__spinner" />
                  ) : (
                    <Camera size={18} />
                  )}
                  {cameraState === 'starting'
                    ? 'Starting camera…'
                    : cameraState === 'error'
                      ? 'Try camera again'
                      : 'Start camera'}
                </button>
              </div>
            )}
          </div>
          <div className="scanner__status" role="status" aria-live="polite">
            {busy ? (
              <LoaderCircle size={18} className="scanner__spinner" />
            ) : !armed && feedback ? (
              <Check size={18} />
            ) : (
              <ScanLine size={18} />
            )}
            <span>{feedback || 'Position the entire barcode inside the frame.'}</span>
          </div>
          {cameraState === 'active' && !armed && (
            <button
              type="button"
              className="scanner__button scanner__button--primary scanner__next"
              onClick={rearm}
              disabled={busy}
            >
              <ScanLine size={18} />
              Scan next package
            </button>
          )}
          {cameraState === 'active' && !armed && (
            <p className="scanner__hint">
              {autoNext
                ? 'Move this barcode out of view, then show the next item. Or tap above to scan another identical package.'
                : 'Move to the next package, then tap to scan.'}
            </p>
          )}
          <form className="scanner__manual" onSubmit={submitBarcode}>
            <label htmlFor="scanner-barcode">
              <Keyboard size={17} />
              Or enter a barcode
            </label>
            <div className="scanner__manual-row">
              <input
                id="scanner-barcode"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setFormError('');
                }}
                placeholder="e.g. 012345678905"
                inputMode="numeric"
                autoComplete="off"
                maxLength={24}
                aria-describedby={formError ? 'scanner-error' : undefined}
              />
              <button
                type="submit"
                className="scanner__button scanner__button--secondary"
                disabled={busy || !code.trim()}
              >
                Add
              </button>
            </div>
            {formError && (
              <p id="scanner-error" className="scanner__error" role="alert">
                {formError}
              </p>
            )}
          </form>
          <label className="scanner__auto-next">
            <span>
              <strong>Automatically scan next item</strong>
              <span>Pause while reviewing; resume when you move to the next item.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={autoNext}
              onChange={(event) => {
                const enabled = event.target.checked;
                autoNextRef.current = enabled;
                setAutoNext(enabled);
                gateRef.current.resetObservations();
                try {
                  localStorage.setItem(AUTO_NEXT_PREFERENCE_KEY, String(enabled));
                } catch {
                  // Keep the preference for this session when storage is unavailable.
                }
              }}
            />
          </label>
          <div className="scanner__options">
            <button
              type="button"
              className="scanner__layout-button"
              aria-pressed={isTabletop}
              onClick={() => setManualLayout(!isTabletop)}
            >
              <FoldVertical size={17} />
              Tabletop layout
            </button>
            {cameraState === 'active' && (
              <button
                type="button"
                className="scanner__layout-button"
                onClick={() => {
                  stopCamera();
                  setCameraState('idle');
                }}
              >
                Stop camera
              </button>
            )}
          </div>
          <p className="scanner__source">
            Product suggestions from{' '}
            <a href="https://world.openfoodfacts.org" target="_blank" rel="noreferrer">
              Open Food Facts
            </a>
            . You can correct every item.
          </p>
        </div>
        {tray && (
          <aside className="scanner__tray" aria-label="Groceries to review">
            <div className="scanner__tray-heading">
              <h3>Your groceries</h3>
              <span>
                {packageCount} {packageCount === 1 ? 'package' : 'packages'}
              </span>
            </div>
            {tray}
          </aside>
        )}
      </div>
    </section>
  );
}

export default Scanner;
