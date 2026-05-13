
import React, { useState, useEffect } from 'react';
import { User, UserRole, AuthState } from '../types';
import { storage } from '../services/storageService';
import Auth from './components/Auth';
import StudentDashboard from './components/StudentDashboard';
import StaffDashboard from './components/StaffDashboard';
import AdminDashboard from './components/AdminDashboard';
import Layout from './components/Layout';

const App: React.FC = () => {
  const [isInitializing, setIsInitializing] = useState(true);
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
  });

  useEffect(() => {
    // Initialize storage (connect to Firebase and fetch initial data)
    storage.initializeSync().then(() => {
      setIsInitializing(false);
      
      const user = storage.getCurrentUser();
      if (user) {
        setAuthState({ user, isAuthenticated: true });
      }
    });
  }, []);

  const handleLogin = (user: User) => {
    storage.setCurrentUser(user);
    setAuthState({ user, isAuthenticated: true });
  };

  const handleLogout = () => {
    storage.setCurrentUser(null);
    setAuthState({ user: null, isAuthenticated: false });
  };

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center">
        <div className="flex flex-col items-center gap-6 animate-pulse">
           <div className="w-16 h-16 bg-indigo-600 rounded-3xl flex items-center justify-center shadow-2xl shadow-indigo-200">
             <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
             </svg>
           </div>
           <p className="text-[10px] font-black uppercase tracking-[0.3em] text-indigo-400">Connecting to Secure Cloud...</p>
        </div>
      </div>
    );
  }

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
