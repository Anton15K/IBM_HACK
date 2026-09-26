// Placement requires one primary-pointer click that starts and ends on the pane.
export class PlacementGesture {
  private gesture: { id: number; x: number; y: number; valid: boolean; released: boolean; endX?: number; endY?: number } | null = null;

  start(id: number, x: number, y: number, onPane: boolean) {
    this.gesture = { id, x, y, valid: onPane, released: false };
  }

  move(id: number, x: number, y: number) {
    const g = this.gesture;
    if (!g) return;
    if (g.id !== id || Math.hypot(x - g.x, y - g.y) > 5) g.valid = false;
  }

  end(id: number, x: number, y: number, onPane: boolean) {
    this.move(id, x, y);
    const g = this.gesture;
    if (!g) return;
    g.valid = g.valid && onPane;
    g.released = true;
    g.endX = x;
    g.endY = y;
  }

  cancel() {
    this.gesture = null;
  }

  consume(x: number, y: number) {
    const g = this.gesture;
    this.cancel();
    // Browsers may floor click coordinates while pointerup keeps fractions.
    const matches = (pointer: number | undefined, click: number) =>
      pointer !== undefined && (pointer === click || Math.floor(pointer) === click);
    return !!g && g.valid && g.released && matches(g.endX, x) && matches(g.endY, y);
  }
}
