
import React from 'react';
import { User } from '../types';

interface LayoutProps {
  user: User | null;
  onLogout: () => void;
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ user, onLogout, children }) => {
  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col">
      {/* Desktop Navigation */}
      <header className="hidden md:flex bg-white/80 backdrop-blur-md border-b border-gray-100 py-4 px-8 justify-between items-center sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="bg-indigo-600 w-10 h-10 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-200">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-black text-gray-900 tracking-tight leading-none">SmartTrack</h1>
            <p className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest mt-1">Attendance Management</p>
          </div>
        </div>
        
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3 bg-gray-50 px-4 py-2 rounded-2xl border border-gray-100">
            <div className="w-8 h-8 bg-indigo-100 rounded-xl flex items-center justify-center text-indigo-600 font-bold text-xs">
              {user?.fullName.charAt(0)}
            </div>
            <div>
              <p className="text-xs font-black text-gray-800 leading-none">{user?.fullName}</p>
              <p className="text-[9px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">{user?.role}</p>
            </div>
          </div>
          <button 
            onClick={onLogout}
            className="text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-rose-500 transition-colors"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Mobile Top Header */}
      <div className="md:hidden flex justify-between items-center p-6 pb-2">
        <h1 className="text-2xl font-black text-gray-900 tracking-tight">SmartTrack</h1>
        <div className="w-10 h-10 bg-white rounded-2xl border border-gray-100 flex items-center justify-center shadow-sm">
           <span className="text-xs font-black text-indigo-600">{user?.fullName.charAt(0)}</span>
        </div>
      </div>
      
      <main className="flex-1 container mx-auto p-4 md:p-8 max-w-6xl page-transition">
        {children}
      </main>

      {/* Mobile Bottom Navigation (Simulated spacing) */}
      <div className="md:hidden h-24"></div>
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white/90 backdrop-blur-xl border-t border-gray-100 px-8 py-4 flex justify-between items-center z-50">
        <button className="flex flex-col items-center gap-1 text-indigo-600">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
          <span className="text-[9px] font-black uppercase tracking-widest">Dash</span>
        </button>
        <button onClick={onLogout} className="flex flex-col items-center gap-1 text-gray-400">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
          <span className="text-[9px] font-black uppercase tracking-widest">Exit</span>
        </button>
      </nav>
      
      <footer className="hidden md:block py-8 text-center text-[10px] text-gray-300 font-bold uppercase tracking-[0.3em]">
        System Ver. 2.4.0 &bull; Secure Connection
      </footer>
    </div>
  );
};

export default Layout;
