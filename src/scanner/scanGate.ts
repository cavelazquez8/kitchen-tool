/** A decoded video frame is not a new package. Rearm only on an explicit action. */
export class ScanGate {
  private armed = true;

  accept(): boolean {
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }

  rearm(): void {
    this.armed = true;
  }

  get isArmed(): boolean {
    return this.armed;
  }
}
