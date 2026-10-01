import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const isGASHost = typeof window !== 'undefined' && (
  window.location.hostname.includes('googleusercontent.com') ||
  window.location.hostname.includes('script.google.com')
);

const CF_WORKER_BASE_URL = 'https://rocket-science-cf-worker.rnbtransolution.workers.dev';

const getApiBaseUrl = () => {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('rocket_api_base_url');
    if (stored) return stored.replace(/\/+$/, '');
    const { hostname, port } = window.location;
    if (port === '3001') return '';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:3001';
    }
    if (hostname.includes('github.io')) {
      // GitHub Pages admin portal: talk directly to the Cloudflare Worker (LINE webhook authority)
      return CF_WORKER_BASE_URL;
    }
  }
  return (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) || '';
};

const API_BASE_URL = getApiBaseUrl();

const getAdminApiKey = () => {
  if (typeof window !== 'undefined') {
    const fromStorage = sessionStorage.getItem('rocket_admin_key') || localStorage.getItem('rocket_admin_key');
    if (fromStorage) return fromStorage;
  }
  return '';
};

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
        const apiKey = getAdminApiKey();
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
          headers['x-admin-key'] = apiKey;
          headers['x-admin-api-key'] = apiKey;
        }

        fetch(`${API_BASE_URL}/api/run`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ functionName: prop, args, adminKey: apiKey, apiKey })
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

// Mock Google Apps Script API strictly when running outside of Apps Script environment
if (typeof window !== 'undefined' && !isGASHost && (!window.google || !window.google.script)) {
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
