// Content script pour filtrer les tickets sur kitchen-display.innovorder.fr

const STORAGE_KEY = 'allowedProducts';
const AUTO_PRINT_KEY = 'autoPrintEnabled';
const REFERENCES_URL = chrome.runtime.getURL('references.json');

let allowedProducts = [];
let filterKeywords = [];
const referenceLookup = new Map();
let autoPrintEnabled = false;

function getTicketNumber(ticket) {
  const numberEl = ticket.querySelector('[data-testid="ticket-number"]');
  return (numberEl ? numberEl.innerText : '').trim() || 'Commande';
}

function collectCustomisations(container) {
  const items = [];
  if (!container) {
    return items;
  }
  container.querySelectorAll('[data-testid="customisation-item"]').forEach(el => {
    const text = (el.innerText || '').trim();
    if (text) {
      items.push({ type: 'custom', text });
    }
  });
  return items;
}

function collectArticleDetails(article) {
  const lines = [];
  if (!article) {
    return lines;
  }
  const labelEl = article.querySelector('p');
  const label = (labelEl ? labelEl.innerText : article.innerText || '').trim();
  if (label) {
    lines.push({ type: 'item', text: label });
  }
  const customisations = collectCustomisations(
    article.querySelector('[data-testid="customisation-container"]')
  );
  return lines.concat(customisations);
}

function collectFormulaDetails(formula) {
  const details = [];
  if (!formula) {
    return details;
  }
  const header = formula.querySelector(':scope > [data-testid="formula-header"]') ||
    formula.querySelector('[data-testid="formula-header"]');
  if (header) {
    const headerLabelEl = header.querySelector('p');
    const headerLabel = (headerLabelEl ? headerLabelEl.innerText : header.innerText || '').trim();
    if (headerLabel) {
      details.push({ type: 'group', text: headerLabel });
    }
    details.push(...collectCustomisations(header.querySelector('[data-testid="customisation-container"]')));
  }
  formula
    .querySelectorAll(':scope article[data-testid="formula-ticket-item"]')
    .forEach(article => {
      details.push(...collectArticleDetails(article));
    });
  return details;
}

function extractTicketDetails(ticket) {
  const lines = [];
  ticket.querySelectorAll('[data-testid="formula"]').forEach(formula => {
    lines.push(...collectFormulaDetails(formula));
  });

  ticket.querySelectorAll('article[data-testid="ticket-item"]').forEach(article => {
    if (article.closest('[data-testid="formula"]')) {
      return;
    }
    lines.push(...collectArticleDetails(article));
  });

  return lines.filter(entry => Boolean(entry.text));
}

function renderPrintDocument(ticket) {
  const orderNumber = getTicketNumber(ticket);
  const lines = extractTicketDetails(ticket);
  const printWindow = window.open('', '', 'width=600,height=800');
  if (!printWindow) {
    return;
  }

  const doc = printWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Commande ${orderNumber}</title><style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 24px; }
    h1 { font-size: 28px; margin-bottom: 16px; text-transform: uppercase; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { font-size: 16px; margin-bottom: 8px; }
    li.group { font-weight: 600; margin-top: 16px; }
    li.custom { font-size: 14px; margin-left: 18px; }
  </style></head><body></body></html>`);
  doc.close();

  const heading = doc.createElement('h1');
  heading.textContent = `Commande ${orderNumber}`;
  doc.body.appendChild(heading);

  const list = doc.createElement('ul');
  lines.forEach(entry => {
    const li = doc.createElement('li');
    if (entry.type === 'group') {
      li.classList.add('group');
    }
    if (entry.type === 'custom') {
      li.classList.add('custom');
      li.textContent = `• ${entry.text}`;
    } else {
      li.textContent = entry.text;
    }
    list.appendChild(li);
  });
  doc.body.appendChild(list);

  printWindow.focus();
  setTimeout(() => {
    try {
      printWindow.print();
    } finally {
      printWindow.close();
    }
  }, 200);
}

function maybeAutoPrintTickets() {
  if (!autoPrintEnabled) {
    return;
  }
  const tickets = document.querySelectorAll('div[data-testid="simple-ticket"]');
  tickets.forEach(ticket => {
    if (ticket.dataset.autoPrintDone === 'true') {
      return;
    }
    if (ticket.querySelector('svg[data-testid="DOING"]')) {
      ticket.dataset.autoPrintDone = 'true';
      renderPrintDocument(ticket);
    }
  });
}

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
    maybeAutoPrintTickets();
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

      if (headerMatches) {
        showElement(container);
        return;
      }

      if (elementMatchesFilter(container)) {
        showElement(container);
        return;
      }

      const parentArticle = container.closest('article');
      const parentFormula = container.closest('[data-testid="formula"]');
      const parentArticleVisible = parentArticle && parentArticle.style.display !== 'none';
      const parentFormulaVisible = parentFormula && parentFormula.style.display !== 'none';

      if (parentArticleVisible) {
        showElement(container);
        return;
      }

      if (parentFormulaVisible) {
        hideElement(container);
        return;
      }

      hideElement(container);
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
  maybeAutoPrintTickets();
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
  chrome.storage.sync.get({ [STORAGE_KEY]: [], [AUTO_PRINT_KEY]: false }, data => {
    const raw = data[STORAGE_KEY] || [];
    allowedProducts = raw
      .filter(Boolean)
      .map(String)
      .map(str => str.trim())
      .filter(Boolean);
    autoPrintEnabled = Boolean(data[AUTO_PRINT_KEY]);
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
      if (
        m.addedNodes.length ||
        m.removedNodes.length ||
        (m.type === 'attributes' && m.attributeName === 'data-testid')
      ) {
        scheduleFilter();
        break;
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-testid']
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
  if (Object.prototype.hasOwnProperty.call(changes, AUTO_PRINT_KEY)) {
    autoPrintEnabled = Boolean(changes[AUTO_PRINT_KEY].newValue);
    if (autoPrintEnabled) {
      maybeAutoPrintTickets();
    }
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
