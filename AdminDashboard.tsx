
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { User, UserRole, AttendanceRecord, Period } from '../types';
import { storage } from '../services/storageService';
import { db } from '../services/firebaseConfig';

type SortField = 'fullName' | 'role' | 'email' | 'marks' | 'course';
type SortDirection = 'asc' | 'desc';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error';
}

interface ConfirmState {
  type: 'DELETE' | 'UNBIND' | 'BULK_UNBIND' | null;
  targetId?: string;
  targetName?: string;
  count?: number;
}

const AdminDashboard: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [allPeriods, setAllPeriods] = useState<Period[]>([]);
  const [allAttendance, setAllAttendance] = useState<AttendanceRecord[]>([]);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | 'ALL'>('ALL');
  const [deviceFilter, setDeviceFilter] = useState<'ALL' | 'BOUND' | 'UNBOUND'>('ALL');
  const [branchFilter, setBranchFilter] = useState<string>('ALL');
  const [sortConfig, setSortConfig] = useState<{ field: SortField, direction: SortDirection }>({ 
    field: 'fullName', 
    direction: 'asc' 
  });

  // Bulk Selection State
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Action States
  const [roleUpdateTarget, setRoleUpdateTarget] = useState<User | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>({ type: null });
  const [isCloudModalOpen, setIsCloudModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // Feedback State
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = (message: string, type: 'success' | 'error' = 'success') => {
    const id = storage.generateId();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const refresh = useCallback(() => {
    setUsers(storage.getUsers());
    setAllPeriods(storage.getPeriods());
    setAllAttendance(storage.getAttendance());
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    window.addEventListener('storage', refresh);
    return () => { clearInterval(interval); window.removeEventListener('storage', refresh); };
  }, [refresh]);

  const branches = useMemo(() => {
    const list = Array.from(new Set(users.map(u => u.course).filter(Boolean)));
    return ['ALL', ...(list as string[])];
  }, [users]);

  const stats = useMemo(() => {
    return [
      { label: 'Total Users', value: users.length },
      { label: 'Faculty Active', value: users.filter(u => u.role === UserRole.STAFF).length },
      { label: 'Total Sessions', value: allPeriods.length },
      { label: 'Attendance Records', value: allAttendance.length }
    ];
  }, [users, allPeriods, allAttendance]);

  const toggleSort = (field: SortField) => {
    setSortConfig(prev => ({
      field,
      direction: prev.field === field && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const processedUsers = useMemo(() => {
    let result = users.filter(u => {
      const matchesSearch = u.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          u.admissionNumber?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesRole = roleFilter === 'ALL' || u.role === roleFilter;
      const matchesDevice = deviceFilter === 'ALL' || 
                           (deviceFilter === 'BOUND' ? !!u.deviceId : !u.deviceId);
      const matchesBranch = branchFilter === 'ALL' || u.course === branchFilter;
      
      return matchesSearch && matchesRole && matchesDevice && matchesBranch;
    });

    result.sort((a, b) => {
      let valA: any = a[sortConfig.field as keyof User] || '';
      let valB: any = b[sortConfig.field as keyof User] || '';

      if (sortConfig.field === 'marks') {
        valA = a.role === UserRole.STUDENT ? allAttendance.filter(att => att.studentId === a.id).length : allPeriods.filter(p => p.staffId === a.id).length;
        valB = b.role === UserRole.STUDENT ? allAttendance.filter(att => att.studentId === b.id).length : allPeriods.filter(p => p.staffId === b.id).length;
      }

      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [users, searchQuery, roleFilter, deviceFilter, branchFilter, sortConfig, allAttendance, allPeriods]);

  // Selection Handlers
  const toggleSelectAll = () => {
    if (selectedIds.size === processedUsers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(processedUsers.map(u => u.id)));
    }
  };

  const toggleSelectUser = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  // --- Logic Implementations ---

  const executeUnbind = () => {
    if (!confirmState.targetId) return;
    try {
      const allUsers = storage.getUsers();
      const updatedUsers = allUsers.map(u => {
        if (u.id === confirmState.targetId) {
          return { ...u, deviceId: undefined };
        }
        return u;
      });
      
      storage.saveUsers(updatedUsers);
      setUsers(updatedUsers);
      window.dispatchEvent(new Event('storage'));
      addToast(`Device unbound for ${confirmState.targetName}.`);
    } catch (e) {
      addToast('Operation failed: Database error.', 'error');
    }
    setConfirmState({ type: null });
  };

  const executeBulkUnbind = () => {
    try {
      const allUsers = storage.getUsers();
      const updatedUsers = allUsers.map(u => {
        if (selectedIds.has(u.id)) {
          return { ...u, deviceId: undefined };
        }
        return u;
      });

      storage.saveUsers(updatedUsers);
      setUsers(updatedUsers);
      setSelectedIds(new Set());
      window.dispatchEvent(new Event('storage'));
      addToast(`Devices reset for ${selectedIds.size} users.`);
    } catch (e) {
      addToast('Bulk operation failed.', 'error');
    }
    setConfirmState({ type: null });
  };

  const executeDelete = () => {
    if (!confirmState.targetId) return;
    try {
      const allUsers = storage.getUsers();
      const updatedUsers = allUsers.filter(u => u.id !== confirmState.targetId);
      
      storage.saveUsers(updatedUsers);
      setUsers(updatedUsers);
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(confirmState.targetId!);
        return next;
      });
      window.dispatchEvent(new Event('storage'));
      addToast(`User ${confirmState.targetName} deleted.`);
    } catch (e) {
      addToast('Deletion failed.', 'error');
    }
    setConfirmState({ type: null });
  };

  const handleRoleUpdate = (userId: string, newRole: UserRole) => {
    const target = users.find(u => u.id === userId);
    if (!target) return;

    if (target.role === newRole) {
      setRoleUpdateTarget(null);
      return;
    }

    try {
      const allUsers = storage.getUsers();
      const updatedUsers = allUsers.map(u => {
        if (u.id === userId) {
          const updated = { ...u, role: newRole };
          if (newRole === UserRole.STAFF) {
            updated.deviceId = undefined;
          }
          return updated;
        }
        return u;
      });

      storage.saveUsers(updatedUsers);
      setUsers(updatedUsers);
      setRoleUpdateTarget(null);
      window.dispatchEvent(new Event('storage'));
      addToast(`${target.fullName} role updated to ${newRole}.`);
    } catch (e) {
      addToast('Role update failed.', 'error');
    }
  };

  const handleGlobalExport = () => {
    if (allAttendance.length === 0) {
      addToast('Export aborted: No attendance records found.', 'error');
      return;
    }
    try {
      const headers = "Date,Time,Student Name,Admission ID,Subject,Faculty\n";
      const csvContent = allAttendance.map(r => {
        const timeStr = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `"${r.date}","${timeStr}","${r.studentName}","${r.admissionNumber}","${r.subject}","${r.staffName}"`;
      }).join('\n');
      const blob = new Blob([headers + csvContent], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Attendance_Log_${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
      addToast('Attendance log exported successfully.');
    } catch (e) {
      addToast('Export failed.', 'error');
    }
  };

  // --- Firebase Sync Handlers ---
  
  const handleForceSync = async () => {
    if(!db) {
        addToast("Firebase not configured! Check services/firebaseConfig.ts", "error");
        return;
    }
    setIsSyncing(true);
    try {
        const success = await storage.forceSyncToCloud();
        if(success) {
            addToast("All local data successfully pushed to Cloud.");
            storage.initializeSync(); // Re-bind listeners
        } else {
            addToast("Sync failed. Check console for details.", "error");
        }
    } catch(e) {
        addToast("Network error during sync.", "error");
    } finally {
        setIsSyncing(false);
    }
  };

  return (
    <div className="space-y-8 pb-32 page-transition relative">
      {/* Toast Notification Container */}
      <div className="fixed top-8 right-8 z-[300] flex flex-col gap-3 pointer-events-none">
        {toasts.map(toast => (
          <div key={toast.id} className={`pointer-events-auto px-8 py-5 rounded-[2rem] shadow-2xl flex items-center gap-4 border border-white/20 backdrop-blur-3xl animate-in slide-in-from-right-10 duration-500 ${toast.type === 'success' ? 'bg-emerald-600/90 text-white' : 'bg-rose-600/90 text-white'}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center bg-white/20`}>
              {toast.type === 'success' ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              )}
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest">{toast.message}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <div key={i} className="bg-white p-6 rounded-[2.5rem] border border-gray-100 shadow-sm hover:translate-y-[-2px] transition-all">
            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest leading-none">{s.label}</span>
            <span className="text-3xl font-black text-gray-900 mt-4 tracking-tighter leading-none block">{s.value}</span>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-[4rem] border border-gray-100 shadow-sm overflow-hidden p-8 sm:p-14 relative">
         <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-10 mb-10">
            <div>
               <h2 className="text-3xl font-black text-gray-900 tracking-tighter uppercase leading-none">User Management</h2>
               <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-3">Search & Manage Users</p>
            </div>
            
            <div className="flex flex-col sm:flex-row items-center gap-4 w-full xl:w-auto">
               <div className="relative w-full sm:w-72">
                  <input 
                    type="text" 
                    placeholder="Search Users..." 
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="bg-gray-50 border border-gray-100 p-5 pl-12 rounded-2xl text-xs font-bold w-full focus:bg-white focus:border-indigo-500 outline-none transition-all shadow-inner"
                  />
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 absolute left-4 top-1/2 -translate-y-1/2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
               </div>
               <button onClick={() => setIsCloudModalOpen(true)} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-emerald-600 text-white px-8 py-5 rounded-[1.5rem] text-[10px] font-black uppercase tracking-widest shadow-xl shadow-emerald-100 transition-all hover:scale-105 active:scale-95">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
                  Firebase Sync
               </button>
               <button onClick={handleGlobalExport} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-indigo-600 text-white px-8 py-5 rounded-[1.5rem] text-[10px] font-black uppercase tracking-widest shadow-xl shadow-indigo-100 transition-all hover:scale-105 active:scale-95">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                  CSV Log
               </button>
            </div>
         </div>

         {/* Filtering HUD */}
         <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10 pb-10 border-b border-gray-50">
            <div className="space-y-3">
               <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest block ml-1">User Role</span>
               <div className="flex bg-gray-50 p-1 rounded-2xl">
                  {['ALL', UserRole.STUDENT, UserRole.STAFF].map(r => (
                    <button key={r} onClick={() => { setRoleFilter(r as any); setSelectedIds(new Set()); }} className={`flex-1 py-3 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${roleFilter === r ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>{r === 'ALL' ? 'Total' : r}</button>
                  ))}
               </div>
            </div>
            <div className="space-y-3">
               <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest block ml-1">Device Binding</span>
               <div className="flex bg-gray-50 p-1 rounded-2xl">
                  {['ALL', 'BOUND', 'UNBOUND'].map(d => (
                    <button key={d} onClick={() => { setDeviceFilter(d as any); setSelectedIds(new Set()); }} className={`flex-1 py-3 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${deviceFilter === d ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>{d}</button>
                  ))}
               </div>
            </div>
            <div className="space-y-3">
               <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest block ml-1">Department / Branch</span>
               <select 
                value={branchFilter} 
                onChange={e => { setBranchFilter(e.target.value); setSelectedIds(new Set()); }}
                className="w-full bg-gray-50 border border-gray-100 p-4 rounded-2xl text-[10px] font-black uppercase tracking-widest focus:bg-white transition-all outline-none"
               >
                 {branches.map(b => <option key={b} value={b}>{b === 'ALL' ? 'All Departments' : b}</option>)}
               </select>
            </div>
         </div>

         <div className="overflow-x-auto">
            <table className="w-full text-left">
               <thead className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">
                  <tr>
                    <th className="p-4 w-10">
                      <div 
                        onClick={toggleSelectAll}
                        className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center cursor-pointer transition-all ${selectedIds.size === processedUsers.length && processedUsers.length > 0 ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-200 bg-white hover:border-indigo-400'}`}
                      >
                        {selectedIds.size === processedUsers.length && processedUsers.length > 0 && (
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                        )}
                      </div>
                    </th>
                    <th className="p-4 cursor-pointer hover:text-indigo-600 transition-colors" onClick={() => toggleSort('fullName')}>
                       User Name {sortConfig.field === 'fullName' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'}
                    </th>
                    <th className="p-4 cursor-pointer hover:text-indigo-600 transition-colors" onClick={() => toggleSort('course')}>
                       Branch {sortConfig.field === 'course' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'}
                    </th>
                    <th className="p-4">Device Status</th>
                    <th className="p-4 text-center cursor-pointer hover:text-indigo-600 transition-colors" onClick={() => toggleSort('marks')}>
                       Activity {sortConfig.field === 'marks' ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'}
                    </th>
                    <th className="p-4 text-right">Actions</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-gray-50">
                  {processedUsers.map(user => (
                    <tr 
                      key={user.id} 
                      className={`hover:bg-gray-50/50 transition-all group ${selectedIds.has(user.id) ? 'bg-indigo-50/30' : ''}`}
                    >
                       <td className="p-4">
                        <div 
                          onClick={() => toggleSelectUser(user.id)}
                          className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center cursor-pointer transition-all ${selectedIds.has(user.id) ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-200 bg-white group-hover:border-indigo-400'}`}
                        >
                          {selectedIds.has(user.id) && (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                          )}
                        </div>
                       </td>
                       <td className="p-4 py-6">
                          <div className="flex items-center gap-4">
                             <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-black ${user.role === UserRole.STAFF ? 'bg-amber-50 text-amber-600' : 'bg-indigo-50 text-indigo-600'}`}>{user.fullName.charAt(0)}</div>
                             <div>
                               <span className="text-sm font-black text-gray-900 uppercase block leading-none mb-1.5">{user.fullName}</span>
                               <span className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{user.admissionNumber || 'FACULTY'}</span>
                             </div>
                          </div>
                       </td>
                       <td className="p-4">
                          <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{user.course || 'Institutional'}</span>
                       </td>
                       <td className="p-4">
                          <div className="flex items-center gap-2">
                             <div className={`w-2 h-2 rounded-full ${user.deviceId || user.role === UserRole.STAFF ? 'bg-emerald-500' : 'bg-rose-500 animate-pulse'}`}></div>
                             <span className="text-[9px] font-black uppercase tracking-widest text-gray-500">
                                {user.role === UserRole.STAFF ? 'Staff Account' : (user.deviceId ? 'Device Bound' : 'No Device')}
                             </span>
                          </div>
                       </td>
                       <td className="p-4 text-center">
                          <div className="inline-block bg-gray-50 px-4 py-2 rounded-xl border border-gray-100">
                             <span className="text-[10px] font-black text-gray-800 tabular-nums">
                                {user.role === UserRole.STUDENT 
                                  ? allAttendance.filter(a => a.studentId === user.id).length 
                                  : allPeriods.filter(p => p.staffId === user.id).length} Attendance
                             </span>
                          </div>
                       </td>
                       <td className="p-4 text-right">
                          <div className="flex justify-end gap-2 relative z-10">
                            <button 
                                onClick={(e) => { e.stopPropagation(); setRoleUpdateTarget(user); }}
                                className="p-2 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-600 hover:text-white transition-all shadow-sm"
                                title="Change Role"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                </svg>
                            </button>
                            {user.role === UserRole.STUDENT && user.deviceId && (
                                <button 
                                    onClick={(e) => { e.stopPropagation(); setConfirmState({ type: 'UNBIND', targetId: user.id, targetName: user.fullName }); }}
                                    className="p-2 bg-amber-50 text-amber-600 rounded-lg hover:bg-amber-600 hover:text-white transition-all shadow-sm"
                                    title="Unbind Device"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                </button>
                            )}
                            <button 
                                onClick={(e) => { e.stopPropagation(); setConfirmState({ type: 'DELETE', targetId: user.id, targetName: user.fullName }); }}
                                className="p-2 bg-rose-50 text-rose-500 rounded-lg hover:bg-rose-600 hover:text-white transition-all shadow-sm"
                                title="Delete User"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                            </button>
                          </div>
                       </td>
                    </tr>
                  ))}
               </tbody>
            </table>
         </div>

         {/* Bulk Action Bar */}
         {selectedIds.size > 0 && (
           <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-8 py-5 rounded-[2.5rem] shadow-2xl flex items-center gap-10 animate-in slide-in-from-bottom-10 duration-500 z-[100] border border-white/10">
              <div className="flex items-center gap-4">
                 <div className="bg-indigo-600 w-10 h-10 rounded-2xl flex items-center justify-center font-black text-sm">
                    {selectedIds.size}
                 </div>
                 <div>
                    <p className="text-xs font-black uppercase tracking-widest leading-none">Users Selected</p>
                    <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mt-1">Bulk Actions</p>
                 </div>
              </div>
              <div className="w-px h-10 bg-white/10"></div>
              <div className="flex items-center gap-3">
                 <button 
                    onClick={() => setConfirmState({ type: 'BULK_UNBIND', count: selectedIds.size })}
                    className="bg-white text-gray-900 px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-400 hover:text-white transition-all flex items-center gap-2"
                 >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    Reset Devices
                 </button>
                 <button 
                    onClick={() => setSelectedIds(new Set())}
                    className="text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-white transition-colors px-4"
                 >
                    Deselect
                 </button>
              </div>
           </div>
         )}
      </div>

      {/* Cloud & Backup Modal */}
      {isCloudModalOpen && (
        <div className="fixed inset-0 bg-[#020617]/80 backdrop-blur-xl z-[200] flex items-center justify-center p-6 animate-in fade-in duration-300">
           <div className="bg-[#0f172a] w-full max-w-lg rounded-[3.5rem] p-12 shadow-2xl border border-white/10 animate-in zoom-in-95 duration-500 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-8">
                 <button onClick={() => setIsCloudModalOpen(false)} className="w-12 h-12 rounded-2xl bg-white/5 text-white flex items-center justify-center hover:bg-white/10 transition-all border border-white/5">
                    &times;
                 </button>
              </div>

              <div className="flex flex-col items-center justify-center mb-8 text-center">
                 <div className={`w-24 h-24 rounded-[3rem] flex items-center justify-center shadow-2xl mb-6 transition-colors duration-500 ${isSyncing ? 'bg-amber-500 shadow-amber-500/20' : 'bg-indigo-600 shadow-indigo-600/20'}`}>
                    {isSyncing ? (
                        <svg className="animate-spin h-10 w-10 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
                    )}
                 </div>
                 <h3 className="text-3xl font-black text-white uppercase tracking-tighter leading-none">Firebase Sync</h3>
                 <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-4 leading-relaxed max-w-[280px]">
                    {isSyncing ? 'Synchronizing local database with Cloud Firestore...' : 'Synchronize all local data to the secure cloud database.'}
                 </p>
              </div>

              <button 
                onClick={handleForceSync}
                disabled={isSyncing}
                className={`w-full py-6 rounded-[2.5rem] font-black uppercase tracking-widest text-[11px] shadow-2xl transition-all flex items-center justify-center gap-3 ${isSyncing ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-emerald-500 text-white hover:scale-105 active:scale-95 shadow-emerald-500/20'}`}
              >
                 {isSyncing ? 'Syncing...' : 'Start Cloud Sync'}
              </button>
              
              {!isSyncing && (
                  <p className="text-center mt-6 text-[9px] font-black text-white/20 uppercase tracking-widest">
                     Requires Active Internet Connection
                  </p>
              )}
           </div>
        </div>
      )}

      {/* Role Update Modal */}
      {roleUpdateTarget && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xl z-[200] flex items-center justify-center p-6 animate-in fade-in duration-300">
           <div className="bg-white w-full max-w-md rounded-[3.5rem] p-10 sm:p-12 shadow-2xl border border-white/20 animate-in zoom-in-95 duration-500">
              <div className="text-center mb-10">
                 <div className="w-16 h-16 bg-indigo-50 rounded-[1.8rem] flex items-center justify-center mx-auto mb-6 text-indigo-600">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                 </div>
                 <h3 className="text-2xl font-black text-gray-900 uppercase tracking-tighter leading-none">Edit User Role</h3>
                 <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-2">User: {roleUpdateTarget.fullName}</p>
              </div>

              <div className="space-y-4 mb-10">
                 <button 
                    onClick={() => handleRoleUpdate(roleUpdateTarget.id, UserRole.STUDENT)}
                    className={`w-full p-6 rounded-3xl border-2 transition-all flex items-center justify-between group ${roleUpdateTarget.role === UserRole.STUDENT ? 'bg-indigo-600 border-indigo-600 text-white shadow-xl shadow-indigo-100' : 'bg-gray-50 border-gray-100 text-gray-400 hover:border-indigo-200 hover:text-indigo-600'}`}
                 >
                    <div className="text-left">
                       <span className="block text-xs font-black uppercase tracking-widest leading-none mb-1.5">Student</span>
                       <span className={`text-[9px] font-bold uppercase tracking-widest block opacity-60 ${roleUpdateTarget.role === UserRole.STUDENT ? 'text-white' : 'text-gray-400'}`}>Device binding required</span>
                    </div>
                    {roleUpdateTarget.role === UserRole.STUDENT && (
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    )}
                 </button>

                 <button 
                    onClick={() => handleRoleUpdate(roleUpdateTarget.id, UserRole.STAFF)}
                    className={`w-full p-6 rounded-3xl border-2 transition-all flex items-center justify-between group ${roleUpdateTarget.role === UserRole.STAFF ? 'bg-indigo-600 border-indigo-600 text-white shadow-xl shadow-indigo-100' : 'bg-gray-50 border-gray-100 text-gray-400 hover:border-indigo-200 hover:text-indigo-600'}`}
                 >
                    <div className="text-left">
                       <span className="block text-xs font-black uppercase tracking-widest leading-none mb-1.5">Staff / Faculty</span>
                       <span className={`text-[9px] font-bold uppercase tracking-widest block opacity-60 ${roleUpdateTarget.role === UserRole.STAFF ? 'text-white' : 'text-gray-400'}`}>Full system access</span>
                    </div>
                    {roleUpdateTarget.role === UserRole.STAFF && (
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    )}
                 </button>
              </div>

              <div className="flex gap-4">
                 <button 
                    onClick={() => setRoleUpdateTarget(null)}
                    className="flex-1 py-5 rounded-[1.8rem] bg-gray-100 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:bg-gray-200 transition-all"
                 >
                    Cancel
                 </button>
              </div>
           </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmState.type && (
        <div className="fixed inset-0 bg-gray-950/60 backdrop-blur-xl z-[200] flex items-center justify-center p-6 animate-in fade-in duration-300">
           <div className="bg-white w-full max-w-sm rounded-[3rem] p-10 shadow-2xl border border-white/20 animate-in zoom-in-95 duration-500 text-center">
              <div className={`w-16 h-16 rounded-[1.8rem] flex items-center justify-center mx-auto mb-6 ${confirmState.type === 'DELETE' ? 'bg-rose-50 text-rose-500' : 'bg-amber-50 text-amber-500'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={confirmState.type === 'DELETE' ? "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" : "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"} />
                </svg>
              </div>
              
              <h3 className="text-xl font-black text-gray-900 uppercase tracking-tight leading-none mb-3">
                 {confirmState.type === 'DELETE' ? 'Delete Account' : confirmState.type === 'UNBIND' ? 'Unbind Device' : 'Bulk Unbind'}
              </h3>
              
              <p className="text-gray-500 text-xs font-medium mb-8 leading-relaxed">
                 {confirmState.type === 'DELETE' 
                   ? `Are you sure you want to permanently delete ${confirmState.targetName}?` 
                   : confirmState.type === 'UNBIND'
                   ? `Unbind device for ${confirmState.targetName}? They will need to re-bind on next login.`
                   : `Reset device bindings for ${confirmState.count} selected users?`}
              </p>

              <div className="flex flex-col gap-3">
                 <button 
                    onClick={confirmState.type === 'DELETE' ? executeDelete : confirmState.type === 'UNBIND' ? executeUnbind : executeBulkUnbind}
                    className={`w-full py-5 rounded-[2rem] font-black uppercase tracking-widest text-[10px] text-white shadow-xl hover:scale-105 active:scale-95 transition-all ${confirmState.type === 'DELETE' ? 'bg-rose-600 shadow-rose-200' : 'bg-amber-500 shadow-amber-200'}`}
                 >
                    Confirm Action
                 </button>
                 <button 
                    onClick={() => setConfirmState({ type: null })}
                    className="w-full py-5 rounded-[2rem] bg-gray-50 text-gray-500 font-black uppercase tracking-widest text-[10px] hover:bg-gray-100 transition-colors"
                 >
                    Cancel
                 </button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default AdminDashboard;
