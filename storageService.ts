
import { User, Period, AttendanceRecord, ClassGroup } from '../types';
import { STORAGE_KEYS } from '../constants';
import { db } from './firebaseConfig';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';

const STORAGE_KEYS_EXT = {
  ...STORAGE_KEYS,
  GROUPS: 'smart_track_groups',
  DEVICE_FINGERPRINT: 'smart_track_hw_id'
};

const COLLECTION_NAME = 'smartTrackData';

// In-Memory State (Source of Truth)
// Data is loaded here STRICTLY from Firestore.
// NO LocalStorage is used for domain data.
const state = {
  users: [] as User[],
  periods: [] as Period[],
  attendance: [] as AttendanceRecord[],
  groups: [] as ClassGroup[]
};

let isInitialized = false;

// Helper to save to Cloud Firestore
const saveToCloud = async (key: string, data: any) => {
  if (!db) {
      console.error("CRITICAL: Firestore instance not found. Data CANNOT be saved to Cloud.");
      throw new Error("Cloud Storage Not Available");
  }
  try {
    // Write to Firestore - Source of Truth
    await setDoc(doc(db, COLLECTION_NAME, key), { data });
    console.log(`[Cloud Storage] Successfully persisted ${key} (${Array.isArray(data) ? data.length : 0} records)`);
  } catch (e) {
    console.error(`[Cloud Storage] Write FAILED for ${key}:`, e);
    throw e; // Propagate error so UI knows save failed
  }
};

export const storage = {
  // Initialize Real-time Listeners and wait for first fetch from Cloud
  initializeSync: (): Promise<void> => {
    if (isInitialized) return Promise.resolve();
    
    if (!db) {
        console.error("Firestore not available - Application cannot sync data.");
        // We do not resolve here to intentionally block the app if cloud is critical
        return Promise.reject("Firestore Configuration Error");
    }
    
    return new Promise((resolve) => {
        let loadedCount = 0;
        const totalKeys = 4; // users, periods, attendance, groups

        const checkCompletion = () => {
            loadedCount++;
            if (loadedCount >= totalKeys) {
                isInitialized = true;
                console.log("SUCCESS: All domain data synchronized from Cloud Storage.");
                resolve();
            }
        };

        const setupListener = (key: string, stateKey: keyof typeof state) => {
            onSnapshot(doc(db, COLLECTION_NAME, key), (docSnap) => {
                if (docSnap.exists()) {
                    const cloudData = docSnap.data().data;
                    state[stateKey] = Array.isArray(cloudData) ? cloudData : [];
                    console.log(`[Cloud Storage] Incoming Update for ${stateKey}: ${state[stateKey].length} records`);
                } else {
                    console.log(`[Cloud Storage] No existing data for ${stateKey}, initializing empty collection.`);
                    state[stateKey] = [];
                }
                
                // Notify React components to re-render
                window.dispatchEvent(new Event('storage'));
                
                // Handle initialization promise
                if (!isInitialized) checkCompletion();
            }, (error) => {
                console.error(`[Cloud Storage] Listener Error for ${key}:`, error);
                // Even on error, we resolve to let app start (maybe with empty data or cached data if we added persistence)
                if (!isInitialized) checkCompletion();
            });
        };

        setupListener(STORAGE_KEYS.USERS, 'users');
        setupListener(STORAGE_KEYS.PERIODS, 'periods');
        setupListener(STORAGE_KEYS.ATTENDANCE, 'attendance');
        setupListener(STORAGE_KEYS_EXT.GROUPS, 'groups');
    });
  },

  // Getters - Return in-memory data (synced from Cloud)
  getUsers: (): User[] => state.users,
  getPeriods: (): Period[] => state.periods,
  getAttendance: (): AttendanceRecord[] => state.attendance,
  getGroups: (): ClassGroup[] => state.groups,

  // Setters - Update memory immediately for UX, then push to Cloud
  saveUsers: async (users: User[]) => {
    state.users = [...users];
    window.dispatchEvent(new Event('storage'));
    await saveToCloud(STORAGE_KEYS.USERS, users);
  },
  
  savePeriods: async (periods: Period[]) => {
    state.periods = [...periods];
    window.dispatchEvent(new Event('storage'));
    await saveToCloud(STORAGE_KEYS.PERIODS, periods);
  },
  
  saveAttendance: async (records: AttendanceRecord[]) => {
    state.attendance = [...records];
    window.dispatchEvent(new Event('storage'));
    await saveToCloud(STORAGE_KEYS.ATTENDANCE, records);
  },
  
  saveGroups: async (groups: ClassGroup[]) => {
    state.groups = [...groups];
    window.dispatchEvent(new Event('storage'));
    await saveToCloud(STORAGE_KEYS_EXT.GROUPS, groups);
  },

  // Session Persistence (Kept in LocalStorage for maintaining login state only - NOT domain data)
  getCurrentUser: (): User | null => {
      try {
          return JSON.parse(localStorage.getItem(STORAGE_KEYS.CURRENT_USER) || 'null');
      } catch (e) { return null; }
  },
  setCurrentUser: (user: User | null) => localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user)),

  // Device Binding (Hardware-specific ID stays local)
  getDeviceFingerprint: (): string => {
    let fp = localStorage.getItem(STORAGE_KEYS_EXT.DEVICE_FINGERPRINT);
    if (!fp) {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = debugInfo ? gl?.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown';
      const screenProfile = `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}`;
      
      const rawId = `${renderer}-${screenProfile}-${navigator.userAgent}`;
      fp = `ST-${btoa(rawId).slice(0, 12).toUpperCase()}`;
      localStorage.setItem(STORAGE_KEYS_EXT.DEVICE_FINGERPRINT, fp);
    }
    return fp;
  },

  generateId: (): string => {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (e) {}
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  },

  // Manual Trigger to force push data (Used by Admin Dashboard)
  forceSyncToCloud: async () => {
    if(!db) return false;
    try {
        console.log("Forcing full sync to Cloud...");
        await saveToCloud(STORAGE_KEYS.USERS, state.users);
        await saveToCloud(STORAGE_KEYS.PERIODS, state.periods);
        await saveToCloud(STORAGE_KEYS.ATTENDANCE, state.attendance);
        await saveToCloud(STORAGE_KEYS_EXT.GROUPS, state.groups);
        return true;
    } catch(e) {
        console.error("Force Sync Failed:", e);
        return false;
    }
  }
};
