import './styles.css';
import { mountLayout } from './layout.js';

function bootstrap() {
  const root = document.getElementById('app');
  if (!root) {
    console.error('PitchTerminal: #app root element not found');
    return;
  }
  mountLayout(root);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
