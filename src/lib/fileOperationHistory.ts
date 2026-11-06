type Operation = { undo: () => Promise<void>; redo: () => Promise<void> };

// A failed replay stays on its stack so a name conflict can be resolved and retried.
export class FileOperationHistory {
  private undoStack: Operation[] = [];
  private redoStack: Operation[] = [];
  private replaying = false;
  private project: string | null = null;
  private group: Operation[] | null = null;

  selectProject(project: string | null) {
    if (this.project !== project) {
      this.project = project;
      this.clear();
    }
  }
  clear() { this.undoStack = []; this.redoStack = []; this.group = null; }
  beginGroup() { if (!this.replaying) this.group = []; }
  endGroup() {
    const operations = this.group;
    this.group = null;
    if (!operations?.length) return;
    // Keep progress on partial failure so retry does not repeat completed steps.
    let applied = operations.length;
    this.record({
      undo: async () => {
        while (applied > 0) { await operations[applied - 1].undo(); applied--; }
      },
      redo: async () => {
        while (applied < operations.length) { await operations[applied].redo(); applied++; }
      },
    });
  }
  record(operation: Operation) {
    if (this.replaying) return;
    if (this.group) { this.group.push(operation); return; }
    this.undoStack.push(operation);
    this.redoStack = [];
  }
  async replay(redo = false) {
    if (this.replaying) return;
    const source = redo ? this.redoStack : this.undoStack;
    const target = redo ? this.undoStack : this.redoStack;
    const operation = source[source.length - 1];
    if (!operation) return;
    this.replaying = true;
    try {
      await (redo ? operation.redo() : operation.undo());
      source.pop();
      target.push(operation);
    } finally { this.replaying = false; }
  }
}

export const fileOperationHistory = new FileOperationHistory();
