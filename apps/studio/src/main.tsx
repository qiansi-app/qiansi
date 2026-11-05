import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './modules.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installApiAuth } from './api-auth';

// Must run before App mounts: it upgrades every /api call to header auth, which
// is what makes the page work inside the VS Code webview's cross-site iframe.
installApiAuth();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </ErrorBoundary>
  </StrictMode>
);
