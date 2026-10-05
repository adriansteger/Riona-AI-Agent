import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { AccountEdit } from './pages/AccountEdit';
import { JobBotPage } from './pages/JobBotPage';
import { CharactersPage } from './pages/CharactersPage';
import { SystemLogsPage } from './pages/SystemLogsPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Overview />} />
        <Route path="/accounts/new" element={<AccountEdit />} />
        <Route path="/accounts/:id/edit" element={<AccountEdit />} />
        <Route path="/accounts/:id" element={<Overview />} />
        <Route path="/jobbot" element={<JobBotPage />} />
        <Route path="/characters" element={<CharactersPage />} />
        <Route path="/logs" element={<SystemLogsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
