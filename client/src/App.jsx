import { Component } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useApp } from './context/AppContext.jsx';
import Layout from './components/Layout.jsx';
import { Loading } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Items from './pages/Items.jsx';
import Receipt from './pages/Receipt.jsx';
import Issue from './pages/Issue.jsx';
import LoanStore from './pages/LoanStore.jsx';
import MasterLedger from './pages/MasterLedger.jsx';
import Reports from './pages/Reports.jsx';
import SettingsPage from './pages/Settings.jsx';
import Backup from './pages/Backup.jsx';
import Orders from './pages/Orders.jsx';
import DemandPage from './pages/Demand.jsx';

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="spinner-page" style={{ flexDirection: 'column', gap: 12 }}>
          <div>Something went wrong while showing this page.</div>
          <button type="button" className="btn btn-blue" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const { user, meta, loading, isAdmin } = useApp();
  if (loading) return <Loading />;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  if (!meta) return <Loading />;
  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="items" element={<Items />} />
          <Route path="receipt" element={<Receipt />} />
          <Route path="issue" element={<Issue />} />
          <Route path="loan" element={<LoanStore />} />
          <Route path="ledger" element={<MasterLedger />} />
          <Route path="reports" element={<Reports />} />
          <Route path="orders" element={<Orders />} />
          <Route path="demand" element={<DemandPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {isAdmin && <Route path="backup" element={<Backup />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
