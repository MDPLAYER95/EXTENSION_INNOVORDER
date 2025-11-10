// Content script pour filtrer les tickets sur kitchen-display.innovorder.fr

const STORAGE_KEY = 'allowedProducts';
const REFERENCES_URL = chrome.runtime.getURL('references.json');

let allowedProducts = [];
let filterKeywords = [];
const referenceLookup = new Map();

function normalizeText(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function elementMatchesFilter(el) {
  if (!filterKeywords.length) {
    return true;
  }
  const text = normalizeText(el.innerText || '');
  return filterKeywords.some(p => text.includes(p));
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

    if (!filterKeywords.length) {
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

    // Gérer les en-têtes de formules pour n'afficher que les informations pertinentes.
    ticket.querySelectorAll('[data-testid="formula-header"]').forEach(header => {
      const formula = header.closest('[data-testid="formula"]');
      if (!formula) return;

      const formulaItems = Array.from(
        formula.querySelectorAll('article[data-testid="formula-ticket-item"]')
      );
      const headerMatches = elementMatchesFilter(header);

      if (!filterKeywords.length) {
        showElement(header);
        const customisations = header.querySelector('[data-testid="customisation-container"]');
        if (customisations) {
          showElement(customisations);
        }
        return;
      }

      if (headerMatches) {
        showElement(header);
        const customisations = header.querySelector('[data-testid="customisation-container"]');
        if (customisations) {
          showElement(customisations);
        }
        showElement(formula);
        formulaItems.forEach(showElement);
      } else {
        hideElement(header);
        const customisations = header.querySelector('[data-testid="customisation-container"]');
        if (customisations) {
          hideElement(customisations);
        }
      }
    });

    // Masquer les blocs de customisation autonomes qui ne correspondent pas.
    ticket.querySelectorAll('[data-testid="customisation-container"]').forEach(container => {
      if (!filterKeywords.length) {
        showElement(container);
        return;
      }

      const parentHeader = container.closest('[data-testid="formula-header"]');
      const headerMatches = parentHeader ? elementMatchesFilter(parentHeader) : false;

      if (headerMatches || elementMatchesFilter(container)) {
        showElement(container);
        return;
      }

      const parentArticle = container.closest('article');
      const parentFormula = container.closest('[data-testid="formula"]');
      const parentVisible = (parentArticle && parentArticle.style.display !== 'none') ||
        (parentFormula && parentFormula.style.display !== 'none');

      if (parentVisible) {
        hideElement(container);
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

function rebuildFilterKeywords() {
  const normalized = allowedProducts
    .filter(Boolean)
    .map(String)
    .map(normalizeText)
    .filter(Boolean);

  const keywords = new Set(normalized);

  normalized.forEach(value => {
    const related = referenceLookup.get(value);
    if (related) {
      related.forEach(item => keywords.add(item));
    }
  });

  filterKeywords = Array.from(keywords);
}

function loadFilters() {
  chrome.storage.sync.get({ [STORAGE_KEY]: [] }, data => {
    const raw = data[STORAGE_KEY] || [];
    allowedProducts = raw
      .filter(Boolean)
      .map(String)
      .map(str => str.trim())
      .filter(Boolean);
    rebuildFilterKeywords();
    applyFilter();
  });
}

function loadReferenceFile() {
  fetch(REFERENCES_URL)
    .then(response => {
      if (!response.ok) {
        throw new Error('Unable to load references');
      }
      return response.json();
    })
    .then(data => {
      referenceLookup.clear();
      const targets = Array.isArray(data.targets) ? data.targets : [];
      targets.forEach(target => {
        const collected = new Set();
        if (target.label) {
          collected.add(target.label);
        }
        if (target.value) {
          collected.add(target.value);
        }
        if (Array.isArray(target.references)) {
          target.references.forEach(ref => {
            if (ref) {
              collected.add(ref);
            }
          });
        }

        const normalizedRefs = Array.from(collected)
          .map(String)
          .map(normalizeText)
          .filter(Boolean);

        if (!normalizedRefs.length) {
          return;
        }

        normalizedRefs.forEach(alias => {
          referenceLookup.set(alias, normalizedRefs);
        });
      });
      rebuildFilterKeywords();
      applyFilter();
    })
    .catch(() => {
      referenceLookup.clear();
      rebuildFilterKeywords();
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
  loadReferenceFile();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes[STORAGE_KEY]) {
    const raw = changes[STORAGE_KEY].newValue || [];
    allowedProducts = raw
      .filter(Boolean)
      .map(String)
      .map(str => str.trim())
      .filter(Boolean);
    rebuildFilterKeywords();
    applyFilter();
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
