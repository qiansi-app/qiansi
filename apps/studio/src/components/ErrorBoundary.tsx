import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a renderer crash from leaving a black window: show the error and a
 * reload action instead of unmounting the whole tree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <h1>界面出错了</h1>
          <p>画布渲染时遇到异常。重新加载不会丢失已保存的模型连接。</p>
          <pre>{this.state.error.message}</pre>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <button
              className="btn ghost"
              onClick={() => this.setState({ error: null })}
            >
              尝试继续
            </button>
          </div>
        </div>
      </div>
    );
  }
}
