import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function FoundationStatus() {
  return <main className="foundation">
    <span>SGB 2.0</span>
    <h1>Nueva base en construcción</h1>
    <p>El sistema actual continúa funcionando mientras construimos y probamos esta versión.</p>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><FoundationStatus /></StrictMode>);
