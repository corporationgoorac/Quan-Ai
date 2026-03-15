import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBiGe4qpBZxFdPoiRQm-60UKXK52EE6Hq0",
  authDomain: "quan-ai-cccb7.firebaseapp.com",
  projectId: "quan-ai-cccb7",
  storageBucket: "quan-ai-cccb7.firebasestorage.app",
  messagingSenderId: "278585989811",
  appId: "1:278585989811:web:fdc9a52c5c3759f0252ec6",
  measurementId: "G-MZ4R84ZK7W"
};

// Initialize Services
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider(); // For easy Google Login

export { db, auth, googleProvider };
