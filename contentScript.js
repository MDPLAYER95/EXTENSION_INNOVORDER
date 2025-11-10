// Content script pour filtrer les tickets sur kitchen-display.innovorder.fr

const STORAGE_KEY = 'allowedProducts';
let allowedProducts = [];

function normalizeText(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function ticketMatches(ticket) {
  if (!allowedProducts.length) {
    // Aucun filtre : toujours visible
    return true;
  }
  const text = normalizeText(ticket.innerText || '');
  return allowedProducts.some(p => text.includes(p));
}

function applyFilter() {
  const tickets = document.querySelectorAll('div[data-testid="simple-ticket"]');
  if (!tickets.length) {
    return;
  }

  // Si pas de filtres, tout est visible
  if (!allowedProducts.length) {
    tickets.forEach(ticket => {
      ticket.style.display = '';
      ticket.dataset.productFilterHidden = 'false';
    });
    return;
  }

  tickets.forEach(ticket => {
    if (ticketMatches(ticket)) {
      ticket.style.display = '';
      ticket.dataset.productFilterHidden = 'false';
    } else {
      ticket.style.display = 'none';
      ticket.dataset.productFilterHidden = 'true';
    }
  });
}

function loadFilters() {
  chrome.storage.sync.get({ [STORAGE_KEY]: [] }, data => {
    const raw = data[STORAGE_KEY] || [];
    allowedProducts = raw
      .filter(Boolean)
      .map(String)
      .map(normalizeText);
    applyFilter();
  });
}

let debounceTimer = null;
function scheduleFilter() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilter, 200);
}

function initObserver() {
  if (!document.body) return;
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.addedNodes.length || m.removedNodes.length) {
        scheduleFilter();
        break;
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function init() {
  loadFilters();
  initObserver();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes[STORAGE_KEY]) {
    const raw = changes[STORAGE_KEY].newValue || [];
    allowedProducts = raw
      .filter(Boolean)
      .map(String)
      .map(normalizeText);
    applyFilter();
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
