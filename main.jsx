import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Helper to create a chainable Google Apps Script run Proxy
function createAppsScriptRunner(successHandler = null, failureHandler = null) {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'withSuccessHandler') {
        return (cb) => createAppsScriptRunner(cb, failureHandler);
      }
      if (prop === 'withFailureHandler') {
        return (cb) => createAppsScriptRunner(successHandler, cb);
      }
      
      // Return a function representing the remote server-side function
      return function(...args) {
        const isGH = typeof window !== 'undefined' && window.location.hostname.includes('github.io');
        const baseUrl = isGH ? 'https://rocket-sci.onrender.com' : '';
        fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ functionName: prop, args })
        })
        .then(async res => {
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Server error');
            return json.data;
          } else {
            const text = await res.text();
            throw new Error(text || 'Server error');
          }
        })
        .then(data => {
          if (successHandler) successHandler(data);
        })
        .catch(err => {
          console.error(`[API Proxy Error] "${prop}":`, err);
          if (failureHandler) failureHandler(err.message || err);
        });
      };
    }
  });
}

// Mock Google Apps Script API when running outside of Apps Script environment
if (typeof window !== 'undefined' && (!window.google || !window.google.script)) {
  window.isNodeJS = true;
  window.google = {
    script: {
      run: createAppsScriptRunner()
    }
  };
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
