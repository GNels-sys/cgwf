import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Last line of defence: a render bug shows a reload button instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("render error", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="page narrow">
        <h2>Something went wrong</h2>
        <p className="muted small">{this.state.error.message}</p>
        <p className="muted small">The game itself is safe on the server. Reload to pick up where you were.</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
