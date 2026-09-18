import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('no #root element');
createRoot(host).render(<App />);
