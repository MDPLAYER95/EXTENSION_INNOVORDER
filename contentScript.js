// Content script pour filtrer les tickets sur kitchen-display.innovorder.fr

const STORAGE_KEY = 'allowedProducts';
let allowedProducts = [];

function normalizeText(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function elementMatchesFilter(el) {
  if (!allowedProducts.length) {
    return true;
  }
  const text = normalizeText(el.innerText || '');
  return allowedProducts.some(p => text.includes(p));
}

function showElement(el) {
  if (!el) return;
  el.style.display = '';
}

function hideElement(el) {
  if (!el) return;
  el.style.display = 'none';
}

function applyFilter() {
  const tickets = document.querySelectorAll('div[data-testid="simple-ticket"]');
  if (!tickets.length) {
    return;
  }

  tickets.forEach(ticket => {
    const allTicketItems = ticket.querySelectorAll(
      'article[data-testid="ticket-item"], article[data-testid="formula-ticket-item"]'
    );
    const allFormulas = ticket.querySelectorAll('[data-testid="formula"]');

    if (!allowedProducts.length) {
      showElement(ticket);
      ticket.dataset.productFilterHidden = 'false';
      allTicketItems.forEach(showElement);
      allFormulas.forEach(showElement);
      return;
    }

    allTicketItems.forEach(item => {
      if (elementMatchesFilter(item)) {
        showElement(item);
      } else {
        hideElement(item);
      }
    });

    // Si un en-tête de formule correspond au filtre, on affiche toute la formule
    ticket.querySelectorAll('[data-testid="formula-header"]').forEach(header => {
      const formula = header.closest('[data-testid="formula"]');
      if (!formula) return;
      if (elementMatchesFilter(header)) {
        showElement(formula);
        formula
          .querySelectorAll('article[data-testid="formula-ticket-item"]')
          .forEach(showElement);
      }
    });

    // Masquer les formules sans élément visible
    allFormulas.forEach(formula => {
      const hasVisibleChild = Array.from(
        formula.querySelectorAll('article[data-testid="formula-ticket-item"]')
      ).some(item => item.style.display !== 'none');
      const header = formula.querySelector('[data-testid="formula-header"]');
      const headerMatches = header ? elementMatchesFilter(header) : false;
      if (hasVisibleChild || headerMatches) {
        showElement(formula);
      } else {
        hideElement(formula);
      }
    });

    const hasVisibleTicketItem = Array.from(
      ticket.querySelectorAll('article[data-testid="ticket-item"]')
    ).some(item => item.style.display !== 'none');
    const hasVisibleFormula = Array.from(allFormulas).some(
      formula => formula.style.display !== 'none'
    );

    if (hasVisibleTicketItem || hasVisibleFormula) {
      showElement(ticket);
      ticket.dataset.productFilterHidden = 'false';
    } else {
      hideElement(ticket);
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
