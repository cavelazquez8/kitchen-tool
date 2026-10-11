/**
 * A successful decoded frame is not another package. Automatic rearming needs
 * repeated observations of absence, or a stable different barcode. Time alone
 * never rearms a barcode held in front of the camera.
 */
export class ScanGate {
  private armed = true;
  private capturedCode: string | null = null;
  private capturedAt = 0;
  private absenceStartedAt: number | null = null;
  private absenceFrames = 0;
  private candidateCode: string | null = null;
  private candidateStartedAt = 0;
  private candidateFrames = 0;

  observe(code: string | null, now: number, automatic: boolean): boolean {
    if (code === null) {
      this.resetCandidate();
      if (!this.armed && automatic) {
        this.absenceStartedAt ??= now;
        this.absenceFrames++;
        if (
          this.absenceFrames >= 4 &&
          now - this.absenceStartedAt >= 1_200 &&
          now - this.capturedAt >= 1_500
        ) {
          this.armed = true;
        }
      }
      return false;
    }

    this.absenceStartedAt = null;
    this.absenceFrames = 0;
    if (this.armed) {
      this.capture(code, now);
      return true;
    }
    if (!automatic || code === this.capturedCode || now - this.capturedAt < 800) {
      this.resetCandidate();
      return false;
    }

    if (this.candidateCode !== code) {
      this.candidateCode = code;
      this.candidateStartedAt = now;
      this.candidateFrames = 1;
      return false;
    }
    this.candidateFrames++;
    if (this.candidateFrames < 2 || now - this.candidateStartedAt < 250) return false;
    this.capture(code, now);
    return true;
  }

  /** Explicit manual entry is an intentional scan, even for the same barcode. */
  capture(code: string, now: number): void {
    this.armed = false;
    this.capturedCode = code;
    this.capturedAt = now;
    this.resetObservations();
  }

  rearm(): void {
    this.armed = true;
    this.resetObservations();
  }

  /** Ignore observations made while a lookup or an item-review dialog is open. */
  resetObservations(): void {
    this.absenceStartedAt = null;
    this.absenceFrames = 0;
    this.resetCandidate();
  }

  private resetCandidate(): void {
    this.candidateCode = null;
    this.candidateStartedAt = 0;
    this.candidateFrames = 0;
  }

  get isArmed(): boolean {
    return this.armed;
  }
}
