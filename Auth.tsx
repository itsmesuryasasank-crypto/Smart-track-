
import React, { useState } from 'react';
import { UserRole, User } from '../types';
import { storage } from '../services/storageService';
import { ADMIN_CREDENTIALS } from '../constants';

interface AuthProps {
  onLogin: (user: User) => void;
}

const Auth: React.FC<AuthProps> = ({ onLogin }) => {
  const [view, setView] = useState<'login' | 'register' | 'binding'>('login');
  const [role, setRole] = useState<UserRole>(UserRole.STUDENT);
  const [error, setError] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<{user: User, index: number} | null>(null);
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [admissionNumber, setAdmissionNumber] = useState('');
  const [staffId, setStaffId] = useState('');
  const [course, setCourse] = useState('');

  const resetForm = () => {
    setEmail(''); setPassword(''); setFullName(''); setAdmissionNumber(''); setStaffId(''); setCourse(''); setError(null);
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (role === UserRole.ADMIN) {
      setError('Administrative access restricted.');
      return;
    }

    const users = storage.getUsers();
    if (users.some(u => u.email === email)) {
      setError('Account already exists.');
      return;
    }

    const newUser: User = {
      id: storage.generateId(), fullName, email, password, role, admissionNumber, course, staffId
    };

    users.push(newUser);
    storage.saveUsers(users);
    setView('login');
    alert('Account created. Please bind your device on first login.');
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (role === UserRole.ADMIN) {
      if (email === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        onLogin({ id: 'admin', fullName: 'System Administrator', email: email, role: UserRole.ADMIN });
      } else {
        setError('Invalid admin credentials.');
      }
      return;
    }

    const users = storage.getUsers();
    const userIndex = users.findIndex(u => u.email === email && u.password === password && u.role === role);

    if (userIndex === -1) {
      setError('Access denied. Please check your credentials.');
      return;
    }

    const user = users[userIndex];
    const currentDevice = storage.getDeviceFingerprint();

    // Secure Device Anchoring Logic
    if (user.role === UserRole.STUDENT) {
      if (!user.deviceId) {
        // Trigger Binding View
        setPendingUser({ user, index: userIndex });
        setView('binding');
        return;
      } else if (user.deviceId !== currentDevice) {
        setError('SECURITY WARNING: This account is bound to another device. Login prevented.');
        return;
      }
    }

    onLogin(user);
  };

  const confirmBinding = () => {
    if (!pendingUser) return;
    const users = storage.getUsers();
    const currentDevice = storage.getDeviceFingerprint();
    
    users[pendingUser.index].deviceId = currentDevice;
    storage.saveUsers(users);
    onLogin(users[pendingUser.index]);
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-4 sm:p-6 overflow-hidden relative">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-100/40 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-indigo-200/30 rounded-full blur-[120px] pointer-events-none"></div>
      
      <div className="bg-white/80 backdrop-blur-2xl p-8 sm:p-12 rounded-[3.5rem] shadow-[0_40px_100px_-20px_rgba(79,70,229,0.15)] border border-white/50 w-full max-w-md relative z-10 animate-in zoom-in-95 duration-500">
        
        {view === 'binding' ? (
          <div className="text-center animate-in slide-in-from-bottom-4">
            <div className="inline-flex bg-amber-100 w-20 h-20 rounded-[2.5rem] items-center justify-center mb-8 shadow-inner">
               <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
               </svg>
            </div>
            <h2 className="text-2xl font-black text-gray-900 tracking-tight mb-4">Device Security</h2>
            <p className="text-gray-500 text-xs font-medium leading-relaxed mb-8">
              To ensure attendance integrity, your account must be linked to this specific device.
              <br/><br/>
              <span className="text-indigo-600 font-bold">Device ID: {storage.getDeviceFingerprint().slice(0, 8)}...</span>
              <br/><br/>
              Once bound, you cannot log in from other devices without admin reset.
            </p>
            <button 
              onClick={confirmBinding}
              className="w-full bg-indigo-600 text-white py-5 rounded-[2rem] font-black uppercase tracking-widest text-[10px] shadow-2xl shadow-indigo-200 hover:scale-[1.02] active:scale-95 transition-all mb-4"
            >
              Bind This Device
            </button>
            <button 
              onClick={() => setView('login')}
              className="text-[10px] font-black text-gray-400 uppercase tracking-widest hover:text-gray-600"
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="text-center mb-10">
              <div className="inline-flex bg-indigo-600 w-16 h-16 rounded-[2rem] shadow-xl shadow-indigo-200 items-center justify-center mb-6">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-3xl font-black text-gray-900 tracking-tight">SmartTrack</h2>
              <p className="text-indigo-400 font-bold text-[10px] mt-1 uppercase tracking-[0.4em]">Login Portal</p>
            </div>

            <div className="flex bg-gray-100/50 p-1.5 rounded-2xl mb-10">
              <button onClick={() => { setView('login'); resetForm(); }} className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${view === 'login' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>Sign In</button>
              <button onClick={() => { setView('register'); resetForm(); if (role === UserRole.ADMIN) setRole(UserRole.STUDENT); }} className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${view === 'register' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>Register</button>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); view === 'login' ? handleLogin(e) : handleRegister(e); }} className="space-y-6">
              <div className="grid grid-cols-2 gap-3 mb-4">
                <button type="button" onClick={() => setRole(UserRole.STUDENT)} className={`py-3 rounded-2xl border transition-all text-[9px] font-black uppercase tracking-widest ${role === UserRole.STUDENT ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'border-gray-100 text-gray-400 hover:border-gray-200'}`}>Student</button>
                <button type="button" onClick={() => setRole(UserRole.STAFF)} className={`py-3 rounded-2xl border transition-all text-[9px] font-black uppercase tracking-widest ${role === UserRole.STAFF ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'border-gray-100 text-gray-400 hover:border-gray-200'}`}>Staff</button>
              </div>

              <div className="space-y-4">
                {view === 'register' && (
                  <>
                    <input type="text" required value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full Name" className="w-full p-4 bg-gray-50 border border-gray-100 rounded-2xl text-xs font-bold focus:border-indigo-500 outline-none transition-all shadow-inner" />
                    {role === UserRole.STUDENT && (
                      <div className="grid grid-cols-2 gap-4">
                        <input type="text" required value={admissionNumber} onChange={(e) => setAdmissionNumber(e.target.value)} placeholder="Admission No." className="w-full p-4 bg-gray-50 border border-gray-100 rounded-2xl text-xs font-bold focus:border-indigo-500 outline-none transition-all shadow-inner" />
                        <input type="text" required value={course} onChange={(e) => setCourse(e.target.value)} placeholder="Course/Branch" className="w-full p-4 bg-gray-50 border border-gray-100 rounded-2xl text-xs font-bold focus:border-indigo-500 outline-none transition-all shadow-inner" />
                      </div>
                    )}
                  </>
                )}

                <input type={role === UserRole.ADMIN ? 'text' : 'email'} required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={role === UserRole.ADMIN ? 'Admin Username' : 'Email Address'} className="w-full p-4 bg-gray-50 border border-gray-100 rounded-2xl text-xs font-bold focus:border-indigo-500 outline-none transition-all shadow-inner" />
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="w-full p-4 bg-gray-50 border border-gray-100 rounded-2xl text-xs font-bold focus:border-indigo-500 outline-none transition-all shadow-inner" />
              </div>

              {error && <p className="text-rose-500 text-[10px] font-black uppercase text-center tracking-widest bg-rose-50 p-3 rounded-xl border border-rose-100">{error}</p>}

              <button type="submit" className="w-full bg-indigo-600 text-white py-5 rounded-[2rem] font-black uppercase tracking-widest text-[10px] shadow-2xl shadow-indigo-100 hover:scale-[1.02] active:scale-95 transition-all">
                {view === 'login' ? 'Sign In' : 'Create Account'}
              </button>
              
              {view === 'login' && (
                <button type="button" onClick={() => setRole(UserRole.ADMIN)} className="w-full text-[9px] font-black text-gray-300 uppercase tracking-widest hover:text-indigo-400 transition-colors">Admin Access</button>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default Auth;
