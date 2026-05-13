
import React, { useState, useEffect } from 'react';
import { User, UserRole, AuthState } from './types';
import { storage } from './services/storageService';
import Auth from './components/Auth';
import StudentDashboard from './components/StudentDashboard';
import StaffDashboard from './components/StaffDashboard';
import AdminDashboard from './components/AdminDashboard';
import Layout from './components/Layout';

const App: React.FC = () => {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
  });

  useEffect(() => {
    const user = storage.getCurrentUser();
    if (user) {
      setAuthState({ user, isAuthenticated: true });
    }
  }, []);

  const handleLogin = (user: User) => {
    storage.setCurrentUser(user);
    setAuthState({ user, isAuthenticated: true });
  };

  const handleLogout = () => {
    storage.setCurrentUser(null);
    setAuthState({ user: null, isAuthenticated: false });
  };

  if (!authState.isAuthenticated) {
    return <Auth onLogin={handleLogin} />;
  }

  return (
    <Layout user={authState.user} onLogout={handleLogout}>
      {authState.user?.role === UserRole.STUDENT && (
        <StudentDashboard student={authState.user} />
      )}
      {authState.user?.role === UserRole.STAFF && (
        <StaffDashboard staff={authState.user} />
      )}
      {authState.user?.role === UserRole.ADMIN && (
        <AdminDashboard />
      )}
    </Layout>
  );
};

export default App;
