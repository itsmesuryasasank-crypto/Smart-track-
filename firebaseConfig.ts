
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCyk8yBbyzESq-26WswNbhXBvo2vpZ0uEw",
  authDomain: "smart-track-2f636.firebaseapp.com",
  projectId: "smart-track-2f636",
  storageBucket: "smart-track-2f636.firebasestorage.app",
  messagingSenderId: "1060362441185",
  appId: "1:1060362441185:web:c5a0d29119d4357e2142a0",
  measurementId: "G-PMKNK92MVG"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);

// Initialize Cloud Firestore and export it
export const db = getFirestore(app);

console.log("Firebase Cloud Storage Initialized");
