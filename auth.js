// ===== MSAL Configuration =====
const msalConfig = {
  auth: {
    clientId: 'aae64d99-3c77-4c08-8d81-70b28366a42e',
    // Microsoft corp tenant — only @microsoft.com accounts can sign in
    authority: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47',
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: false
  }
};

const loginRequest = {
  scopes: ['User.Read']
};

const graphConfig = {
  graphMeEndpoint: 'https://graph.microsoft.com/v1.0/me'
};

// ── MSAL instance ──
let msalInstance = null;
let msalReady = false;
let currentAccount = null;

async function initAuth() {
  try {
    msalInstance = new msal.PublicClientApplication(msalConfig);
    // MSAL v2 requires explicit initialization
    if (typeof msalInstance.initialize === 'function') {
      await msalInstance.initialize();
    }
    msalReady = true;

    // Handle redirect response
    const response = await msalInstance.handleRedirectPromise();
    if (response) {
      currentAccount = response.account;
    } else {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        currentAccount = accounts[0];
      }
    }

    if (currentAccount) {
      showApp(currentAccount);
    } else {
      showLogin();
    }
  } catch (error) {
    console.error('Auth error:', error);
    showLogin(error.message);
  }
}

async function signIn() {
  try {
    if (!msalReady || !msalInstance) {
      console.log('MSAL not ready yet, waiting...');
      await initAuth();
      if (currentAccount) return;
    }
    await msalInstance.loginRedirect(loginRequest);
  } catch (error) {
    console.error('Login error:', error);
    showLogin(error.message);
  }
}

async function signOut() {
  const account = msalInstance.getAllAccounts()[0];
  if (account) {
    await msalInstance.logoutRedirect({ account });
  }
}

async function getTokenSilent() {
  const account = msalInstance.getAllAccounts()[0];
  if (!account) return null;
  try {
    const response = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account
    });
    return response.accessToken;
  } catch (error) {
    // Fallback to interactive
    await msalInstance.acquireTokenRedirect(loginRequest);
    return null;
  }
}

async function getProfile() {
  const token = await getTokenSilent();
  if (!token) return null;
  try {
    const response = await fetch(graphConfig.graphMeEndpoint, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return await response.json();
  } catch (error) {
    console.error('Graph API error:', error);
    return null;
  }
}

function showLogin(errorMsg) {
  var loginScreen = document.getElementById('login-screen');
  var app = document.getElementById('app');
  if (loginScreen) loginScreen.classList.remove('hidden');
  if (app) app.classList.add('hidden');
  if (errorMsg) {
    var errEl = document.getElementById('login-error');
    if (errEl) {
      errEl.textContent = errorMsg;
      errEl.classList.remove('hidden');
    }
  }
}

function showApp(account) {
  var loginScreen = document.getElementById('login-screen');
  var appEl = document.getElementById('app');
  if (loginScreen) loginScreen.classList.add('hidden');
  if (appEl) appEl.classList.remove('hidden');

  // Display user info in top nav
  const userEl = document.getElementById('userInfo');
  if (userEl && account) {
    const name = account.name || account.username;
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    userEl.innerHTML = `
      <div class="user-avatar">${initials}</div>
      <span class="user-name-top">${name}</span>`;
    userEl.classList.remove('hidden');
  }

  // Load data from API
  if (typeof window.initTimeTracker === 'function') {
    window.initTimeTracker();
  }
}

// Get the ID token for API calls (Bearer token)
async function getIdToken() {
  const account = msalInstance.getAllAccounts()[0];
  if (!account) return null;
  try {
    const response = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account
    });
    return response.idToken;
  } catch (error) {
    // If silent fails, trigger interactive login
    await msalInstance.acquireTokenRedirect(loginRequest);
    return null;
  }
}

// Expose globally so app.js can call it
window.getIdToken = getIdToken;

// Initialize on page load — MSAL script is loaded synchronously via local file
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAuth);
} else {
  initAuth();
}
