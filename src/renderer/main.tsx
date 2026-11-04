import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installSpotlight } from './services/spotlight';
import { applyTheme, getTheme } from './services/theme';
import './styles.css';

// Before the first render, so there is no flash of the wrong theme.
applyTheme(getTheme());
installSpotlight();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
