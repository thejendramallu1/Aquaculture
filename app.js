const content = document.querySelector("#app-content");
const authScreen = document.querySelector("#auth-screen");
const appShell = document.querySelector("#app-shell");
const dialog = document.querySelector("#app-dialog");
const dialogContent = document.querySelector("#dialog-content");
const toast = document.querySelector("#toast");

const roleOptions = [
  { id: "farmer", title: "Farmer / client", description: "Submit farm needs and view published matches." },
  { id: "management", title: "Management", description: "Approve farmer and vendor onboarding, requests, and stock." },
  { id: "analyst", title: "Analysis team", description: "Compare approved farm needs with available feed stock." },
  { id: "admin", title: "Administrator", description: "Provision team accounts and publish recommendations." },
  { id: "vendor", title: "Feed vendor", description: "List feed stock and traceable supplier details." }
];

const pageTitles = {
  dashboard: "Overview",
  requests: "Farm requests",
  inventory: "Feed inventory",
  review: "Review queue",
  recommendations: "Recommendations",
  team: "Team accounts"
};

const allowedPages = {
  farmer: ["dashboard", "requests", "inventory", "recommendations"],
  vendor: ["dashboard", "inventory"],
  management: ["dashboard", "requests", "inventory", "review"],
  analyst: ["dashboard", "requests", "inventory", "recommendations"],
  admin: ["dashboard", "inventory", "recommendations", "team"]
};

const auth = { user: null, csrfToken: "", setupRequired: false, setupTokenRequired: false, mode: "choose", selectedRole: null, notice: "" };
let state = { requests: [], inventory: [], recommendations: [], pendingAccounts: [], accounts: [] };
let activePage = "dashboard";
let toastTimer;

function roleTitle(role) {
  return roleOptions.find((item) => item.id === role)?.title || "AquaSupply";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

function role() {
  return auth.user?.role || "";
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const requestUserId = auth.user?.id;
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD" && auth.csrfToken) {
    headers["X-CSRF-Token"] = auth.csrfToken;
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch {
    throw new Error("Cannot reach AquaSupply. Start the Python server and refresh this page.");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`The server returned an unreadable response (${response.status}).`);
  }
  if (result.csrfToken) auth.csrfToken = result.csrfToken;
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login" && auth.user?.id === requestUserId) {
      auth.user = null;
      state = { requests: [], inventory: [], recommendations: [], pendingAccounts: [], accounts: [] };
      renderAuth();
    }
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}

function showAuthError(message) {
  const target = document.querySelector("#auth-error");
  if (target) {
    target.textContent = message;
    target.hidden = !message;
  }
}

function renderAuth() {
  appShell.classList.add("hidden");
  authScreen.classList.remove("hidden");

  if (auth.mode === "choose") {
    authScreen.innerHTML = `<section class="auth-layout">
      <div class="auth-brand"><span class="brand-mark" aria-hidden="true">A</span><span class="auth-brand-copy"><strong>AquaSupply</strong><small>FARMING, CONNECTED</small></span></div>
      <div class="auth-main"><div class="auth-intro"><p class="eyebrow">AQUACULTURE OPERATIONS</p><h1>Sign in to your workspace</h1><p>Choose your role to open its separate sign-in page.</p></div>
        ${auth.setupRequired ? `<div class="setup-callout"><span><strong>First-time setup</strong><small>Create your administrator account to get started.</small></span><button class="button small" type="button" data-auth-action="setup">Set up admin</button></div>` : ""}
        <div class="role-cards">${roleOptions.map((item) => `<button class="role-card" type="button" data-auth-role="${item.id}"><span class="role-card-icon" aria-hidden="true">${roleIcon(item.id)}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}</small><span class="role-card-arrow" aria-hidden="true">→</span></button>`).join("")}</div>
        <p class="auth-footnote">Farmer and vendor accounts can register here. Management and analysis accounts are created by an administrator. After initial setup, farmer and vendor registrations require management approval.</p>
        <p id="auth-error" class="auth-error" role="alert" hidden></p>
      </div>
    </section>`;
    return;
  }

  const selected = roleOptions.find((item) => item.id === auth.selectedRole);
  if (!selected) {
    auth.mode = "choose";
    renderAuth();
    return;
  }
  const registering = auth.mode === "register";
  const settingUp = auth.mode === "setup";
  const canRegister = ["farmer", "vendor"].includes(selected.id);
  const title = settingUp ? "Set up administrator" : registering ? `Create ${selected.title.toLowerCase()} account` : `Sign in · ${selected.title}`;
  const description = settingUp
    ? "Create your own administrator login. This one-time setup is only available before an administrator account exists."
    : registering
    ? "New accounts are reviewed by management before they can sign in."
    : `${selected.description} Use the email and password assigned to this role.`;
  const formFields = registering || settingUp
    ? `<div class="form-field"><label for="auth-name">Full name</label><input class="form-control" id="auth-name" name="name" autocomplete="name" required maxlength="80"></div>
       <div class="form-field"><label for="auth-email">Email address</label><input class="form-control" id="auth-email" name="email" type="email" autocomplete="email" required maxlength="254"></div>
       <div class="form-field"><label for="auth-password">Password</label><input class="form-control" id="auth-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><span class="form-hint">Use at least 12 characters.</span></div>
       ${settingUp ? `<div class="form-field"><label for="auth-password-confirm">Confirm password</label><input class="form-control" id="auth-password-confirm" name="passwordConfirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div>
         ${auth.setupTokenRequired ? `<div class="form-field"><label for="auth-setup-token">One-time setup token</label><input class="form-control" id="auth-setup-token" name="setupToken" type="password" autocomplete="off" required><span class="form-hint">Find this generated token in your Render service’s Environment settings.</span></div>` : ""}` : ""}`
    : `<div class="form-field"><label for="auth-email">Email address</label><input class="form-control" id="auth-email" name="email" type="email" autocomplete="username" required maxlength="254"></div>
       <div class="form-field"><label for="auth-password">Password</label><input class="form-control" id="auth-password" name="password" type="password" autocomplete="current-password" required maxlength="128"></div>`;
  authScreen.innerHTML = `<section class="auth-layout auth-single">
    <div class="auth-brand"><span class="brand-mark" aria-hidden="true">A</span><span class="auth-brand-copy"><strong>AquaSupply</strong><small>FARMING, CONNECTED</small></span></div>
    <div class="auth-form-card">
      <button class="back-link" type="button" data-auth-action="${settingUp ? "setup-back" : "back"}">← ${settingUp ? "Administrator sign in" : "All workspaces"}</button>
      <span class="role-card-icon auth-role-icon" aria-hidden="true">${roleIcon(selected.id)}</span>
      <p class="eyebrow">${escapeHtml(selected.title.toUpperCase())} PORTAL</p>
      <h1>${escapeHtml(title)}</h1><p class="auth-description">${escapeHtml(description)}</p>
      <form class="auth-form" data-auth-form="${settingUp ? "setup" : registering ? "register" : "login"}">${formFields}
        <button class="button auth-submit" type="submit">${settingUp ? "Create administrator account" : registering ? "Request account" : "Sign in"}</button>
      </form>
      ${selected.id === "admin" && !settingUp && auth.setupRequired ? `<p class="auth-switch">No administrator account yet? <button type="button" data-auth-action="setup">Set up the first administrator</button></p>` : ""}
      ${canRegister ? `<p class="auth-switch">${registering ? "Already registered?" : "New to AquaSupply?"} <button type="button" data-auth-action="toggle">${registering ? "Sign in" : "Create an account"}</button></p>` : ""}
      <p id="auth-error" class="auth-error" role="alert" ${auth.notice ? "" : "hidden"}>${escapeHtml(auth.notice)}</p>
      <p class="auth-security">Role-specific access is checked by the server. Your account data is not stored in browser local storage.</p>
    </div>
  </section>`;
}

function roleIcon(role) {
  return ({ farmer: "⌂", vendor: "◈", management: "✓", analyst: "✳", admin: "♙" })[role] || "A";
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 4200);
}

async function loadData() {
  const userId = auth.user?.id;
  if (!userId) return;
  const nextState = await api("/api/data");
  if (!auth.user || auth.user.id !== userId) return;
  state = nextState;
  const pages = allowedPages[role()] || [];
  if (!pages.includes(activePage)) activePage = "dashboard";
  render();
}

function render() {
  if (!auth.user) {
    renderAuth();
    return;
  }
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  document.querySelector("#topbar-page").textContent = pageTitles[activePage] || "Overview";
  document.querySelector("#role-label").textContent = roleTitle(role());
  document.querySelector("#topbar-user-name").textContent = auth.user.name;
  document.querySelector("#sidebar-user-name").textContent = auth.user.name;
  document.querySelector("#sidebar-user-role").textContent = auth.user.email;

  const pages = allowedPages[role()] || [];
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.hidden = !pages.includes(link.dataset.page);
    link.classList.toggle("active", link.dataset.page === activePage);
  });
  const reviewCount = role() === "management"
    ? state.requests.filter((item) => item.status === "awaiting").length
      + state.inventory.filter((item) => item.status === "awaiting").length
      + state.pendingAccounts.length
    : 0;
  document.querySelector("#review-count").textContent = String(reviewCount);

  if (activePage === "dashboard") content.innerHTML = renderDashboard();
  else if (activePage === "requests") content.innerHTML = renderRequests();
  else if (activePage === "inventory") content.innerHTML = renderInventory();
  else if (activePage === "review") content.innerHTML = renderReview();
  else if (activePage === "team") content.innerHTML = renderTeam();
  else content.innerHTML = renderRecommendations();
}

function pageHeading(eyebrow, title, subtitle, action = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p></div>${action}</div>`;
}

function emptyState(title, message, icon = "✳") {
  return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">${icon}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;
}

function statCard(label, value, detail, symbol) {
  return `<div class="stat-card"><div class="stat-top"><span>${escapeHtml(label)}</span><span class="stat-symbol" aria-hidden="true">${symbol}</span></div><strong class="stat-value">${escapeHtml(value)}</strong><div class="stat-detail">${escapeHtml(detail)}</div></div>`;
}

function statusLabel(status) {
  return ({
    awaiting: "Needs review",
    pending: "Awaiting approval",
    approved: "Approved",
    active: "Active",
    rejected: "Declined",
    awaitingAdmin: "Admin review",
    published: "Published",
    declined: "Declined"
  })[status] || status;
}

function badge(status) {
  const css = status === "approved" || status === "published" || status === "active"
    ? "approved"
    : status === "rejected" || status === "declined" ? "rejected" : "pending";
  return `<span class="badge ${css}">${escapeHtml(statusLabel(status))}</span>`;
}

function roleBadge(role) {
  return `<span class="tag">${escapeHtml(roleTitle(role))}</span>`;
}

function requestById(id) {
  return state.requests.find((item) => item.id === id);
}

function recommendationByRequest(id) {
  return state.recommendations.some((item) => item.requestId === id && item.status !== "declined");
}

function renderDashboard() {
  const openRequests = state.requests.filter((item) => item.status === "awaiting").length;
  const approvedStock = state.inventory.filter((item) => item.status === "approved");
  const awaitingPublication = state.recommendations.filter((item) => item.status === "awaitingAdmin").length;
  const pendingAccounts = state.pendingAccounts.length;
  const requestAction = role() === "farmer"
    ? `<button class="button" type="button" data-action="new-request">＋ Create a farm request</button>`
    : role() === "vendor"
      ? `<button class="button" type="button" data-action="new-feed">＋ Add feed stock</button>`
      : role() === "admin"
        ? `<button class="button" type="button" data-page="team">Manage team accounts&nbsp; →</button>`
        : role() === "analyst"
          ? `<button class="button" type="button" data-page="recommendations">Review matches&nbsp; →</button>`
          : `<button class="button" type="button" data-page="review">Open review queue&nbsp; →</button>`;
  const visibleRequests = state.requests;
  const approvedCount = approvedStock.length;
  const partnerCount = new Set(state.inventory.map((item) => item.vendor)).size;
  const roleCaption = role() === "farmer" ? "Your operation" : `${roleTitle(role())} workspace`;

  return `<section class="hero"><div class="hero-copy"><p class="eyebrow">A better-connected food supply</p><h1>Good decisions start with the right match.</h1><p>Connect farm requirements with traceable feed supply. Review every match before it reaches the farm.</p>${requestAction}</div><div class="hero-art" aria-hidden="true"><span class="ring"></span><span class="hero-fish">≈</span></div></section>
    <div class="stats-grid">
      ${statCard("Farm requests", String(state.requests.length), role() === "management" ? `${openRequests} waiting for review` : roleCaption, "▤")}
      ${statCard("Approved feed stock", String(approvedCount), `${formatNumber(approvedStock.reduce((sum, item) => sum + Number(item.quantityKg), 0))} kg available`, "◈")}
      ${statCard("Recommendations", String(state.recommendations.length), `${awaitingPublication} awaiting admin review`, "✳")}
      ${statCard(role() === "management" ? "Accounts to review" : "Supply partners", role() === "management" ? String(pendingAccounts) : String(partnerCount), role() === "management" ? "Farmer / vendor registrations" : "In this role's workspace", "⌁")}
    </div>
    <div class="content-grid">
      <section class="panel"><div class="panel-header"><div><h2>Recent farm requests</h2><p>Visible to your role</p></div>${allowedPages[role()].includes("requests") ? `<button class="text-button" type="button" data-page="requests">View all →</button>` : ""}</div>${requestRows(visibleRequests)}</section>
      <section class="panel"><div class="panel-header"><div><h2>${role() === "vendor" ? "Your listed stock" : "Approved feed stock"}</h2><p>Supplier source and availability</p></div><button class="text-button" type="button" data-page="inventory">Browse →</button></div>${feedRows(role() === "vendor" ? state.inventory : approvedStock)}</section>
    </div>
    <div class="note"><span class="note-mark">ⓘ</span><span><strong>Use professional judgment.</strong> Match scores are a hand-weighted baseline, not validated nutritional or veterinary advice. Confirm feed suitability and local requirements with a qualified aquaculture professional.</span></div>`;
}

function requestRows(requests) {
  if (!requests.length) return `<div class="list-row"><div class="row-main"><strong>No farm requests yet</strong><small>Requests appear here after a farmer submits them.</small></div></div>`;
  return requests.slice(0, 4).map((item) => `<div class="list-row">
    <span class="feed-avatar" aria-hidden="true">🐟</span>
    <div class="row-main"><strong>${escapeHtml(item.farm)}</strong><small>${escapeHtml(item.fish)} · ${escapeHtml(item.water)} · ${formatNumber(item.fishCount)} fish</small></div>
    <div class="row-meta">${badge(item.status)}<small>${formatDate(item.createdAt)}</small></div>
  </div>`).join("");
}

function feedRows(feeds) {
  if (!feeds.length) return `<div class="list-row"><div class="row-main"><strong>No approved inventory yet</strong><small>Approved supplier stock will appear here.</small></div></div>`;
  return feeds.slice(0, 4).map((item) => `<div class="list-row">
    <span class="feed-avatar" aria-hidden="true">◉</span>
    <div class="row-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category)} · ${escapeHtml(item.vendor)}</small></div>
    <div class="row-meta"><strong>${formatNumber(item.quantityKg)} kg</strong><small>${escapeHtml(item.source)}</small></div>
  </div>`).join("");
}

function renderRequests() {
  const action = role() === "farmer" ? `<button class="button" type="button" data-action="new-request">＋ New farm request</button>` : "";
  const rows = state.requests.length ? `<div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Farm / client</th><th>Species & water</th><th>Stock details</th><th>Preference</th><th>Submitted</th><th>Status</th></tr></thead><tbody>${state.requests.map((item) => `<tr><td><span class="table-primary">${escapeHtml(item.farm)}</span><br><span class="form-hint">${escapeHtml(item.owner)}</span></td><td>${escapeHtml(item.fish)}<br><span class="form-hint">${escapeHtml(item.water)} · ${escapeHtml(item.culture)}</span></td><td>${formatNumber(item.fishCount)} fish<br><span class="form-hint">${formatNumber(item.feedNeedKg)} kg needed</span></td><td>${escapeHtml(item.feedPreference)}</td><td>${formatDate(item.createdAt)}</td><td>${badge(item.status)}</td></tr>`).join("")}</tbody></table></div></div>` : emptyState("No farm requests yet", "New requirements will appear here after submission.", "▤");
  const intro = role() === "analyst" ? "Management-approved farm requirements ready for feed matching." : role() === "management" ? "Review and approve farm requirements before analysis." : "Share your species, culture system, and feed needs with the supply network.";
  return `${pageHeading("FARM REQUIREMENTS", "Farm requests", intro, action)}${rows}`;
}

function inventoryCards(feeds) {
  return feeds.length ? `<div class="card-grid">${feeds.map((item) => `<article class="item-card">
    <div class="item-card-top"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.vendor)} · Added ${formatDate(item.createdAt)}</p></div>${badge(item.status)}</div>
    <p class="item-description">${escapeHtml(item.source)}</p>
    <div class="card-tags"><span class="tag">${escapeHtml(item.category)}</span>${item.species.map((species) => `<span class="tag">${escapeHtml(species)}</span>`).join("")}${item.waters.map((water) => `<span class="tag">${escapeHtml(water)}</span>`).join("")}</div>
    <div class="card-footer"><small>${formatNumber(item.quantityKg)} kg available</small><small>$${Number(item.pricePerKg).toFixed(2)} / kg</small></div>
  </article>`).join("")}</div>` : emptyState("No feed stock listed", "Approved supplier stock and your own submissions will appear here.", "◈");
}

function renderInventory() {
  const action = role() === "vendor" ? `<button class="button" type="button" data-action="new-feed">＋ Add feed stock</button>` : "";
  return `${pageHeading("SUPPLIER NETWORK", "Feed inventory", role() === "vendor" ? "List traceable feed supply and keep stock availability up to date." : "Browse supplier stock, sources, species suitability, and approval status.", action)}
    <div class="filter-row"><input class="search-box" id="inventory-search" type="search" placeholder="Search feed, species, or vendor" aria-label="Search feed inventory"><select class="filter-select" id="inventory-status" aria-label="Filter by approval"><option value="all">All approval statuses</option><option value="approved">Approved stock</option><option value="awaiting">Needs review</option><option value="rejected">Declined</option></select></div>
    <div id="inventory-results">${inventoryCards(state.inventory)}</div>`;
}

function renderReview() {
  if (role() !== "management") return emptyState("Management access only", "Sign in using a management account to review submissions.", "✓");
  const pendingRequests = state.requests.filter((item) => item.status === "awaiting");
  const pendingFeeds = state.inventory.filter((item) => item.status === "awaiting");
  const accountCards = state.pendingAccounts.map((item) => `<article class="review-card">
    <div class="review-card-head"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.email)} · registered ${formatDate(item.createdAt)}</p></div>${roleBadge(item.role)}</div>
    <div class="review-actions"><button class="button small danger" type="button" data-action="account-status" data-id="${item.id}" data-status="rejected">Decline account</button><button class="button small" type="button" data-action="account-status" data-id="${item.id}" data-status="approved">Approve account</button></div>
  </article>`).join("");
  const requestCards = pendingRequests.map((item) => `<article class="review-card">
    <div class="review-card-head"><div><h3>${escapeHtml(item.farm)}</h3><p>${escapeHtml(item.owner)} · submitted ${formatDate(item.createdAt)}</p></div>${badge(item.status)}</div>
    <div class="review-details"><span class="tag">${escapeHtml(item.fish)}</span><span class="tag">${escapeHtml(item.water)} · ${escapeHtml(item.culture)}</span><span class="tag">${formatNumber(item.fishCount)} fish</span><span class="tag">${formatNumber(item.feedNeedKg)} kg feed needed</span><span class="tag">${escapeHtml(item.feedPreference)}</span></div>
    ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
    <div class="review-actions"><button class="button small danger" type="button" data-action="request-status" data-id="${escapeHtml(item.id)}" data-status="rejected">Decline</button><button class="button small" type="button" data-action="request-status" data-id="${escapeHtml(item.id)}" data-status="approved">Approve for analysis</button></div>
  </article>`).join("");
  const feedCards = pendingFeeds.map((item) => `<article class="review-card">
    <div class="review-card-head"><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.vendor)} · ${escapeHtml(item.source)}</p></div>${badge(item.status)}</div>
    <div class="review-details"><span class="tag">${escapeHtml(item.category)}</span><span class="tag">${formatNumber(item.quantityKg)} kg listed</span><span class="tag">$${Number(item.pricePerKg).toFixed(2)} / kg</span>${item.species.map((species) => `<span class="tag">${escapeHtml(species)}</span>`).join("")}</div>
    <div class="review-actions"><button class="button small danger" type="button" data-action="feed-status" data-id="${escapeHtml(item.id)}" data-status="rejected">Decline</button><button class="button small" type="button" data-action="feed-status" data-id="${escapeHtml(item.id)}" data-status="approved">Approve supplier stock</button></div>
  </article>`).join("");
  return `${pageHeading("MANAGEMENT", "Review queue", "Approve farmer and vendor accounts, farm requirements, and supplier stock.")}
    <section class="section-spacer"><div class="panel-header"><div><h2>New accounts <span class="badge pending">${state.pendingAccounts.length} pending</span></h2><p>Approved farmer and vendor accounts can sign in.</p></div></div><div class="approval-stack">${accountCards || emptyState("No accounts to review", "Farmer and vendor registrations appear here.", "♙")}</div></section>
    <section class="section-spacer"><div class="panel-header"><div><h2>Farm requirements <span class="badge pending">${pendingRequests.length} pending</span></h2><p>Approved requests become available to the analysis team.</p></div></div><div class="approval-stack">${requestCards || emptyState("No farm requests to review", "New client submissions will appear here.", "✓")}</div></section>
    <section class="section-spacer"><div class="panel-header"><div><h2>Supplier stock <span class="badge pending">${pendingFeeds.length} pending</span></h2><p>Only approved stock can be included in recommendations.</p></div></div><div class="approval-stack">${feedCards || emptyState("No supplier stock to review", "New vendor listings will appear here.", "◈")}</div></section>`;
}

function renderTeam() {
  if (role() !== "admin") return emptyState("Administrator access only", "Sign in using an administrator account to manage team accounts.", "♙");
  const accounts = state.accounts.length ? `<div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th></tr></thead><tbody>${state.accounts.map((item) => `<tr><td class="table-primary">${escapeHtml(item.name)}</td><td>${escapeHtml(item.email)}</td><td>${roleBadge(item.role)}</td><td>${badge(item.status)}</td><td>${formatDate(item.createdAt)}</td></tr>`).join("")}</tbody></table></div></div>` : emptyState("No accounts yet", "Created accounts will appear here.", "♙");
  return `${pageHeading("ADMINISTRATION", "Team accounts", "Create separate management and analysis team logins. Farmer and vendor accounts register separately and require management approval.")}
    <section class="panel team-form-panel"><div class="panel-header"><div><h2>Create a team login</h2><p>Admin-created staff accounts are active immediately. Use a unique email and a 12+ character password.</p></div></div>
    <form class="team-form" data-form="team"><div class="form-grid">
      <div class="form-field"><label for="team-name">Full name</label><input class="form-control" id="team-name" name="name" required maxlength="80"></div>
      <div class="form-field"><label for="team-email">Work email</label><input class="form-control" id="team-email" name="email" type="email" required maxlength="254"></div>
      <div class="form-field"><label for="team-role">Role</label><select class="form-control" id="team-role" name="role" required><option value="management">Management</option><option value="analyst">Analysis team</option></select></div>
      <div class="form-field"><label for="team-password">Temporary password</label><input class="form-control" id="team-password" name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></div>
    </div><div class="form-actions"><button class="button" type="submit">Create account</button></div></form></section>
    <section class="section-spacer"><div class="panel-header"><div><h2>Accounts</h2><p>Passwords are never shown in this list.</p></div></div>${accounts}</section>`;
}

function matchInventory(farmRequest) {
  return state.inventory.filter((feed) => feed.status === "approved").map((feed) => {
    let score = 0;
    const reasons = [];
    if (feed.species.includes(farmRequest.fish)) {
      score += 45;
      reasons.push(`Species listed for ${farmRequest.fish} (+45)`);
    } else if (feed.species.includes("All species")) {
      score += 25;
      reasons.push("Supplier lists broad species compatibility (+25)");
    } else {
      reasons.push("Species not listed by supplier (+0)");
    }
    if (feed.waters.includes(farmRequest.water)) {
      score += 25;
      reasons.push(`${farmRequest.water} water type listed (+25)`);
    } else {
      reasons.push(`${farmRequest.water} water type not listed (+0)`);
    }
    if (farmRequest.feedPreference === "Any suitable feed" || farmRequest.feedPreference === feed.category) {
      score += 20;
      reasons.push(`${feed.category} feed matches preference (+20)`);
    } else {
      reasons.push(`${feed.category} feed differs from preference (+0)`);
    }
    if (Number(feed.quantityKg) >= Number(farmRequest.feedNeedKg)) {
      score += 10;
      reasons.push("Listed stock meets requested quantity (+10)");
    } else {
      reasons.push(`Only ${formatNumber(feed.quantityKg)} kg listed; less than requested (+0)`);
    }
    return { feed, score, reasons };
  }).sort((a, b) => b.score - a.score || a.feed.name.localeCompare(b.feed.name));
}

function renderRecommendations() {
  if (role() === "analyst") {
    const cards = state.requests.map((farmRequest) => {
      const alreadyPrepared = recommendationByRequest(farmRequest.id);
      const matches = matchInventory(farmRequest).slice(0, 3);
      return `<article class="review-card"><div class="review-card-head"><div><h3>${escapeHtml(farmRequest.farm)} · ${escapeHtml(farmRequest.fish)}</h3><p>${escapeHtml(farmRequest.water)} · ${formatNumber(farmRequest.feedNeedKg)} kg requested · ${escapeHtml(farmRequest.owner)}</p></div>${alreadyPrepared ? `<span class="badge awaiting">Prepared</span>` : `<span class="badge approved">Ready to analyze</span>`}</div>
        ${matches.length ? `<div class="recommendation-stack section-spacer">${matches.map((match, index) => `<div class="item-card"><div class="item-card-top"><div><h3>${index === 0 ? "Best listed match · " : ""}${escapeHtml(match.feed.name)}</h3><p>${escapeHtml(match.feed.vendor)} · ${formatNumber(match.feed.quantityKg)} kg listed</p></div><span class="score-box"><strong>${match.score}</strong><small>of 100</small></span></div><div class="progress-track"><span style="width:${match.score}%"></span></div><div class="match-reasons">${match.reasons.map(escapeHtml).join(" · ")}</div></div>`).join("")}</div>` : emptyState("No approved feed stock", "Ask management to approve supplier inventory before generating a recommendation.", "◈")}
        <div class="review-actions"><button class="button small" type="button" data-action="generate-recommendation" data-id="${escapeHtml(farmRequest.id)}" ${alreadyPrepared || !matches.length ? "disabled" : ""}>Prepare recommendation for admin</button></div>
      </article>`;
    }).join("");
    return `${pageHeading("ANALYSIS TEAM", "Recommendations", "Compare approved farm needs with approved vendor stock.")}
      <div class="model-note"><strong>Transparent match score:</strong> species (45), water type (25), feed preference (20), and listed quantity (10). This is a hand-weighted baseline—not a trained or validated Linear Discriminant Analysis model or nutritional advice.</div>
      ${cards ? `<div class="recommendation-stack">${cards}</div>` : emptyState("No approved requests ready", "Management-approved farm requests will appear here for analysis.", "✳")}`;
  }

  if (role() === "admin") {
    const cards = state.recommendations.map((recommendation) => {
      const farmRequest = recommendation.request;
      const feed = recommendation.feed;
      return `<article class="review-card"><div class="review-card-head"><div><h3>${escapeHtml(farmRequest.farm)} · ${escapeHtml(farmRequest.fish)}</h3><p>${escapeHtml(feed.name)} from ${escapeHtml(feed.vendor)}</p></div><span class="score-box"><strong>${recommendation.score}</strong><small>of 100</small></span></div>
        <div class="review-details"><span class="tag">${escapeHtml(farmRequest.water)}</span><span class="tag">${formatNumber(farmRequest.feedNeedKg)} kg requested</span><span class="tag">${formatNumber(feed.quantityKg)} kg listed</span><span class="tag">$${Number(feed.pricePerKg).toFixed(2)} / kg</span></div>
        <p>${recommendation.reasons.map(escapeHtml).join(" · ")}</p>
        <div class="review-actions"><button class="button small danger" type="button" data-action="recommendation-status" data-id="${escapeHtml(recommendation.id)}" data-status="declined">Decline</button><button class="button small" type="button" data-action="recommendation-status" data-id="${escapeHtml(recommendation.id)}" data-status="published">Publish to client</button></div>
      </article>`;
    }).join("");
    return `${pageHeading("ADMIN", "Recommendations", "Review an analyst-prepared match and publish it to the farmer.")}${cards ? `<div class="recommendation-stack">${cards}</div>` : emptyState("No recommendations to review", "Analyst-prepared matches will appear here for admin approval.", "✳")}`;
  }

  if (role() === "farmer") {
    const cards = state.recommendations.map((recommendation) => {
      const farmRequest = recommendation.request;
      const feed = recommendation.feed;
      return `<article class="review-card"><div class="review-card-head"><div><p class="eyebrow">PUBLISHED MATCH · ${formatDate(recommendation.publishedAt)}</p><h3>${escapeHtml(feed.name)}</h3><p>For ${escapeHtml(farmRequest.farm)} · ${escapeHtml(farmRequest.fish)}</p></div><span class="score-box"><strong>${recommendation.score}</strong><small>of 100</small></span></div>
        <div class="review-details"><span class="tag">${escapeHtml(feed.category)}</span><span class="tag">${escapeHtml(feed.vendor)}</span><span class="tag">${formatNumber(feed.quantityKg)} kg listed</span><span class="tag">$${Number(feed.pricePerKg).toFixed(2)} / kg</span></div><p>${escapeHtml(feed.source)}</p>
        <div class="recommendation-match"><span class="badge published">Admin approved</span><span class="form-hint">${escapeHtml(farmRequest.water)} · ${escapeHtml(farmRequest.culture)}</span><div class="match-reasons">${recommendation.reasons.map(escapeHtml).join(" · ")}</div></div>
      </article>`;
    }).join("");
    return `${pageHeading("YOUR FARM", "Recommendations", "View matches that have completed analyst review and admin approval.")}
      <div class="model-note"><strong>Important:</strong> Matches are based on listed stock attributes. Confirm the feed label and feeding plan with a qualified aquaculture professional.</div>
      ${cards ? `<div class="recommendation-stack">${cards}</div>` : emptyState("No published matches yet", "Approved recommendations for your farm will appear here.", "✳")}`;
  }

  return emptyState("Recommendations are not available", "Your account cannot access this page.", "✳");
}

function optionList(values, selected = "") {
  return values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}

function openModal(type) {
  if (type === "request") {
    dialogContent.innerHTML = `<div class="dialog-head"><div><h2>New farm request</h2><p>Describe your operation and what you need from suppliers.</p></div><button class="dialog-close" type="button" data-action="close-modal" aria-label="Close dialog">×</button></div>
      <form class="dialog-form" data-form="request"><div class="form-grid">
        <div class="form-field full"><label for="farm-name">Farm or operation name</label><input class="form-control" id="farm-name" name="farm" required maxlength="80" placeholder="e.g. Greenbank Pond Farm"></div>
        <div class="form-field"><label for="fish-species">Fish species</label><select class="form-control" id="fish-species" name="fish" required>${optionList(["Nile tilapia", "Atlantic salmon", "Common carp", "Other"])}</select></div>
        <div class="form-field"><label for="water-type">Water type</label><select class="form-control" id="water-type" name="water" required>${optionList(["Freshwater", "Brackish", "Saltwater"])}</select></div>
        <div class="form-field"><label for="culture-system">Culture system</label><select class="form-control" id="culture-system" name="culture" required>${optionList(["Pond", "Cage", "Tank", "Raceway", "Other"])}</select></div>
        <div class="form-field"><label for="fish-count">Fish stocked</label><input class="form-control" id="fish-count" name="fishCount" type="number" min="1" step="1" required placeholder="e.g. 12000"></div>
        <div class="form-field"><label for="feed-need">Feed quantity needed (kg)</label><input class="form-control" id="feed-need" name="feedNeedKg" type="number" min="1" step="0.1" required placeholder="e.g. 320"></div>
        <div class="form-field"><label for="feed-preference">Feed preference</label><select class="form-control" id="feed-preference" name="feedPreference" required>${optionList(["Any suitable feed", "Natural", "Organic", "Artificial"])}</select></div>
        <div class="form-field full"><label for="request-notes">Additional notes <span class="form-hint">(optional)</span></label><textarea class="form-control" id="request-notes" name="notes" maxlength="400" placeholder="Add sourcing or operation details for the review team."></textarea></div>
      </div><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button" type="submit">Submit for review</button></div></form>`;
  } else {
    dialogContent.innerHTML = `<div class="dialog-head"><div><h2>Add feed stock</h2><p>List feed details and a traceable source for management review.</p></div><button class="dialog-close" type="button" data-action="close-modal" aria-label="Close dialog">×</button></div>
      <form class="dialog-form" data-form="feed"><div class="form-grid">
        <div class="form-field full"><label for="feed-name">Feed product name</label><input class="form-control" id="feed-name" name="name" required maxlength="80" placeholder="e.g. Grower protein pellets"></div>
        <div class="form-field"><label for="vendor-name">Vendor / supplier name</label><input class="form-control" id="vendor-name" name="vendor" required maxlength="80" placeholder="Your supplier name"></div>
        <div class="form-field"><label for="feed-category">Feed variety</label><select class="form-control" id="feed-category" name="category" required>${optionList(["Natural", "Organic", "Artificial"])}</select></div>
        <div class="form-field"><label for="supported-species">Compatible species</label><select class="form-control" id="supported-species" name="species" required>${optionList(["Nile tilapia", "Atlantic salmon", "Common carp", "All species"])}</select></div>
        <div class="form-field"><label for="supported-water">Water type</label><select class="form-control" id="supported-water" name="water" required>${optionList(["Freshwater", "Brackish", "Saltwater"])}</select></div>
        <div class="form-field"><label for="feed-quantity">Available stock (kg)</label><input class="form-control" id="feed-quantity" name="quantityKg" type="number" min="0.1" step="0.1" required placeholder="e.g. 500"></div>
        <div class="form-field"><label for="feed-price">Price per kg (USD)</label><input class="form-control" id="feed-price" name="pricePerKg" type="number" min="0" step="0.01" required placeholder="e.g. 1.45"></div>
        <div class="form-field full"><label for="feed-source">Source / traceability details</label><input class="form-control" id="feed-source" name="source" required maxlength="140" placeholder="Ingredient source, origin, or supplier reference"></div>
        <p class="form-hint form-field full">New inventory remains unavailable for matching until management reviews it.</p>
      </div><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button" type="submit">Submit stock for review</button></div></form>`;
  }
  dialog.showModal();
}

async function runAction(actionButton) {
  const { action, id, status } = actionButton.dataset;
  if (action === "new-request") openModal("request");
  else if (action === "new-feed") openModal("feed");
  else if (action === "close-modal") dialog.close();
  else if (action === "logout") {
    try {
      await api("/api/logout", { method: "POST" });
      auth.user = null;
      auth.mode = "choose";
      auth.selectedRole = null;
      state = { requests: [], inventory: [], recommendations: [], pendingAccounts: [], accounts: [] };
      renderAuth();
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (action === "request-status") {
    await mutate(`/api/requests/${encodeURIComponent(id)}/status`, "PATCH", { status }, "Farm request status updated.");
  } else if (action === "feed-status") {
    await mutate(`/api/inventory/${encodeURIComponent(id)}/status`, "PATCH", { status }, "Supplier stock status updated.");
  } else if (action === "account-status") {
    await mutate(`/api/accounts/${encodeURIComponent(id)}/status`, "PATCH", { status }, "Account status updated.");
  } else if (action === "generate-recommendation") {
    const result = await api("/api/recommendations", { method: "POST", body: { requestId: id } });
    showToast(result.message);
    await loadData();
  } else if (action === "recommendation-status") {
    await mutate(`/api/recommendations/${encodeURIComponent(id)}/status`, "PATCH", { status }, "Recommendation status updated.");
  }
}

async function mutate(path, method, body, message) {
  const result = await api(path, { method, body });
  showToast(result.message || message);
  await loadData();
}

async function handleAppSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  if (form.dataset.busy === "true") return;
  if (!form.reportValidity()) return;
  form.dataset.busy = "true";
  form.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = true; });
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.form === "request") {
      const result = await api("/api/requests", { method: "POST", body: values });
      dialog.close();
      activePage = "requests";
      showToast(result.message);
      await loadData();
    } else if (form.dataset.form === "feed") {
      const result = await api("/api/inventory", { method: "POST", body: values });
      dialog.close();
      activePage = "inventory";
      showToast(result.message);
      await loadData();
    } else if (form.dataset.form === "team") {
      const result = await api("/api/accounts", { method: "POST", body: values });
      form.reset();
      showToast(result.message);
      await loadData();
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (form.isConnected) {
      delete form.dataset.busy;
      form.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = false; });
    }
  }
}

async function handleAuthSubmit(event) {
  const form = event.target.closest("form[data-auth-form]");
  if (!form) return;
  event.preventDefault();
  if (form.dataset.busy === "true") return;
  if (!form.reportValidity()) return;
  form.dataset.busy = "true";
  form.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = true; });
  const values = Object.fromEntries(new FormData(form).entries());
  showAuthError("");
  try {
    if (form.dataset.authForm === "setup") {
      if (values.password !== values.passwordConfirm) {
        showAuthError("The passwords do not match.");
        return;
      }
      const result = await api("/api/setup/administrator", {
        method: "POST",
        body: { name: values.name, email: values.email, password: values.password, setupToken: values.setupToken }
      });
      auth.user = result.user;
      auth.setupRequired = false;
      auth.mode = "choose";
      auth.notice = "";
      activePage = "dashboard";
      await loadData();
    } else if (form.dataset.authForm === "register") {
      const result = await api("/api/register", {
        method: "POST",
        body: { ...values, role: auth.selectedRole }
      });
      auth.mode = "login";
      auth.notice = result.message;
      renderAuth();
    } else {
      const result = await api("/api/login", {
        method: "POST",
        body: { ...values, role: auth.selectedRole }
      });
      auth.user = result.user;
      auth.mode = "choose";
      auth.notice = "";
      activePage = "dashboard";
      await loadData();
    }
  } catch (error) {
    showAuthError(error.message);
  } finally {
    if (form.isConnected) {
      delete form.dataset.busy;
      form.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = false; });
    }
  }
}

function filterInventory() {
  const search = document.querySelector("#inventory-search");
  const statusFilter = document.querySelector("#inventory-status");
  const result = document.querySelector("#inventory-results");
  if (!search || !statusFilter || !result) return;
  const term = search.value.trim().toLowerCase();
  const status = statusFilter.value;
  const filtered = state.inventory
    .filter((item) => status === "all" || item.status === status)
    .filter((item) => [item.name, item.vendor, item.source, ...item.species, ...item.waters].join(" ").toLowerCase().includes(term));
  result.innerHTML = inventoryCards(filtered);
}

authScreen.addEventListener("click", (event) => {
  const roleButton = event.target.closest("[data-auth-role]");
  if (roleButton) {
    auth.selectedRole = roleButton.dataset.authRole;
    auth.mode = "login";
    auth.notice = "";
    renderAuth();
    document.querySelector("#auth-email")?.focus();
    return;
  }
  const actionButton = event.target.closest("[data-auth-action]");
  if (!actionButton) return;
  if (actionButton.dataset.authAction === "back") {
    auth.mode = "choose";
    auth.selectedRole = null;
    auth.notice = "";
  } else if (actionButton.dataset.authAction === "toggle") {
    auth.mode = auth.mode === "register" ? "login" : "register";
    auth.notice = "";
  } else if (actionButton.dataset.authAction === "setup") {
    auth.selectedRole = "admin";
    auth.mode = "setup";
    auth.notice = "";
  } else if (actionButton.dataset.authAction === "setup-back") {
    auth.mode = "login";
    auth.selectedRole = "admin";
    auth.notice = "";
  }
  renderAuth();
});

authScreen.addEventListener("submit", handleAuthSubmit);
document.addEventListener("submit", handleAppSubmit);
document.addEventListener("click", async (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton && appShell.contains(pageButton)) {
    if (!allowedPages[role()]?.includes(pageButton.dataset.page)) return;
    activePage = pageButton.dataset.page;
    render();
    return;
  }
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton || (!appShell.contains(actionButton) && !dialog.contains(actionButton))) return;
  if (actionButton.disabled) return;
  actionButton.disabled = true;
  try {
    await runAction(actionButton);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (actionButton.isConnected) actionButton.disabled = false;
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#inventory-search")) filterInventory();
});
document.addEventListener("change", (event) => {
  if (event.target.matches("#inventory-status")) filterInventory();
});

async function initialize() {
  try {
    const sessionData = await api("/api/session");
    auth.user = sessionData.user;
    auth.setupRequired = sessionData.setupRequired;
    auth.setupTokenRequired = sessionData.setupTokenRequired;
    if (auth.user) await loadData();
    else renderAuth();
  } catch (error) {
    renderAuth();
    showAuthError(error.message);
  }
}

initialize();
