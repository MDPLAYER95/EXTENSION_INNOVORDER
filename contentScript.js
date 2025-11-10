// Content script pour filtrer les tickets sur kitchen-display.innovorder.fr

const STORAGE_KEY = 'allowedProducts';
const AUTO_PRINT_KEY = 'autoPrintEnabled';
const REFERENCES_URL = chrome.runtime.getURL('references.json');
const TIMER_ENABLED_KEY = 'productTimersEnabled';
const TIMER_CONFIG_URL = chrome.runtime.getURL('productTimers.json');

let allowedProducts = [];
let filterKeywords = [];
const referenceLookup = new Map();
let autoPrintEnabled = false;
let printFrame = null;
const printedTicketSignatures = new Set();
let productTimersEnabled = false;
let productTimerEntries = [];
const activeProductTimers = new Map();
let cachedFrenchVoice = null;

function ensurePrintFrame() {
  if (!printFrame) {
    printFrame = document.createElement('iframe');
    printFrame.style.position = 'fixed';
    printFrame.style.width = '0';
    printFrame.style.height = '0';
    printFrame.style.border = '0';
    printFrame.style.visibility = 'hidden';
    printFrame.setAttribute('aria-hidden', 'true');
  }

  if (document.body && !printFrame.isConnected) {
    document.body.appendChild(printFrame);
  } else if (!document.body) {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        if (printFrame && !printFrame.isConnected && document.body) {
          document.body.appendChild(printFrame);
        }
      },
      { once: true }
    );
  }

  return printFrame;
}

function getTicketSignature(ticket) {
  if (!ticket) {
    return '';
  }

  if (ticket.dataset.printSignature) {
    return ticket.dataset.printSignature;
  }

  const dataset = ticket.dataset || {};
  const datasetKeys = ['ticketId', 'orderId', 'id', 'uuid', 'reference'];
  for (const key of datasetKeys) {
    const value = (dataset[key] || '').trim();
    if (value) {
      const signature = normalizeText(value);
      if (signature) {
        ticket.dataset.printSignature = signature;
        return signature;
      }
    }
  }

  const attributeKeys = ['data-ticket-id', 'data-order-id', 'data-id', 'id'];
  for (const attr of attributeKeys) {
    const value = (ticket.getAttribute(attr) || '').trim();
    if (value) {
      const signature = normalizeText(value);
      if (signature) {
        ticket.dataset.printSignature = signature;
        return signature;
      }
    }
  }

  const ticketNumberRaw = getTicketNumber(ticket);
  if (ticketNumberRaw) {
    const firstLine = ticketNumberRaw.split(/\r?\n/)[0].trim();
    const ticketNumber = normalizeText(firstLine);
    if (ticketNumber) {
      ticket.dataset.printSignature = ticketNumber;
      return ticketNumber;
    }
  }

  const header = ticket.querySelector('[data-testid="ticket-header"]');
  const infoText = ticket.querySelector('[data-testid="ticket-info-text"]');

  const headerContent = [
    header ? header.innerText : '',
    infoText ? infoText.innerText : ''
  ]
    .map(part => (part || '').trim())
    .filter(Boolean)
    .join(' | ');

  const bodySummary = Array.from(
    ticket.querySelectorAll(
      'article[data-testid="ticket-item"], article[data-testid="formula-ticket-item"]'
    )
  )
    .map(node => (node.innerText || '').trim())
    .filter(Boolean)
    .join(' || ');

  let signature = normalizeText(`${headerContent} || ${bodySummary}`);

  if (!signature) {
    signature = normalizeText(ticket.innerText || '');
  }

  if (!signature) {
    signature = `ticket-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  if (signature) {
    ticket.dataset.printSignature = signature;
  }

  return signature;
}

function markTicketAsPrinted(ticket, signature) {
  if (ticket) {
    ticket.dataset.autoPrintDone = 'true';
  }
  if (signature) {
    printedTicketSignatures.add(signature);
  }
}

function pickFrenchVoice() {
  if (!('speechSynthesis' in window)) {
    return null;
  }

  const availableVoices = window.speechSynthesis.getVoices();
  if (availableVoices && availableVoices.length) {
    const primary = availableVoices.find(voice =>
      voice.lang && voice.lang.toLowerCase().startsWith('fr')
    );
    if (primary) {
      cachedFrenchVoice = primary;
      return primary;
    }

    if (cachedFrenchVoice && availableVoices.includes(cachedFrenchVoice)) {
      return cachedFrenchVoice;
    }
  }

  return cachedFrenchVoice || null;
}

function announceProductReady(productLabel, orderNumber) {
  if (!('speechSynthesis' in window)) {
    return;
  }

  const label = productLabel || 'Produit';
  const order = orderNumber || 'commande';
  const message = `${label} de ${order} est prêt.`;
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = 'fr-FR';

  const voice = pickFrenchVoice();
  if (voice) {
    utterance.voice = voice;
  }

  window.speechSynthesis.speak(utterance);
}

function clearActiveProductTimer(timerKey) {
  const info = activeProductTimers.get(timerKey);
  if (!info) {
    return;
  }
  clearTimeout(info.timeoutId);
  activeProductTimers.delete(timerKey);
}

function clearAllProductTimers() {
  Array.from(activeProductTimers.keys()).forEach(clearActiveProductTimer);
}

function ensureProductTimer(timerKey, timerEntry, signature, orderNumber) {
  if (activeProductTimers.has(timerKey)) {
    return;
  }

  const durationMs = timerEntry.durationMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return;
  }

  const timeoutId = setTimeout(() => {
    announceProductReady(timerEntry.announcement || timerEntry.label, orderNumber);
    activeProductTimers.delete(timerKey);
  }, durationMs);

  activeProductTimers.set(timerKey, {
    timeoutId,
    signature,
    timerEntry,
    orderNumber
  });
}

function cleanupTimersForTicket(signature, keepKeys) {
  activeProductTimers.forEach((info, key) => {
    if (info.signature !== signature) {
      return;
    }
    if (!keepKeys.has(key)) {
      clearActiveProductTimer(key);
    }
  });
}

function cleanupOrphanTimers(activeSignatures) {
  activeProductTimers.forEach((info, key) => {
    if (!activeSignatures.has(info.signature)) {
      clearActiveProductTimer(key);
    }
  });
}

if ('speechSynthesis' in window) {
  const synth = window.speechSynthesis;
  const updateVoice = () => {
    pickFrenchVoice();
  };
  if (typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', updateVoice);
  } else if ('onvoiceschanged' in synth) {
    synth.onvoiceschanged = updateVoice;
  }
  pickFrenchVoice();
}

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
  const frame = ensurePrintFrame();
  if (!frame || !frame.contentDocument) {
    return;
  }

  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Commande ${orderNumber}</title><style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 24px; }
    h1 { font-size: 28px; margin-bottom: 16px; text-transform: uppercase; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { font-size: 16px; margin-bottom: 8px; }
    li.group { font-weight: 600; margin-top: 16px; }
    li.custom { font-size: 14px; margin-left: 18px; }
  </style></head><body><div id="print-root"></div></body></html>`);
  doc.close();

  const root = doc.getElementById('print-root');
  if (!root) {
    return;
  }

  root.innerHTML = '';

  const heading = doc.createElement('h1');
  heading.textContent = `Commande ${orderNumber}`;
  root.appendChild(heading);

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
  root.appendChild(list);

  setTimeout(() => {
    const frameWindow = frame.contentWindow;
    if (!frameWindow) {
      return;
    }
    frameWindow.focus();
    frameWindow.print();
  }, 50);
}

function processTicketTimers(ticket, activeSignatures) {
  const signature = getTicketSignature(ticket);
  if (!signature) {
    return;
  }

  activeSignatures.add(signature);

  if (!productTimersEnabled || !productTimerEntries.length) {
    cleanupTimersForTicket(signature, new Set());
    return;
  }

  const doingIcon = ticket.querySelector('svg[data-testid="DOING"]');
  if (!doingIcon) {
    cleanupTimersForTicket(signature, new Set());
    return;
  }

  const orderNumber = getTicketNumber(ticket);
  const details = extractTicketDetails(ticket).filter(entry => entry.type === 'item');
  const keepKeys = new Set();
  const occurrenceCount = new Map();

  details.forEach(entry => {
    const normalizedText = normalizeText(entry.text);
    if (!normalizedText) {
      return;
    }

    productTimerEntries.forEach(timerEntry => {
      if (!timerEntry.matchers.some(keyword => normalizedText.includes(keyword))) {
        return;
      }

      const baseKey = `${signature}::${timerEntry.id}`;
      const occurrence = (occurrenceCount.get(baseKey) || 0) + 1;
      occurrenceCount.set(baseKey, occurrence);
      const timerKey = `${baseKey}#${occurrence}`;
      keepKeys.add(timerKey);
      ensureProductTimer(timerKey, timerEntry, signature, orderNumber);
    });
  });

  cleanupTimersForTicket(signature, keepKeys);
}

function maybeAutoPrintTickets() {
  if (!autoPrintEnabled) {
    return;
  }
  const tickets = document.querySelectorAll('div[data-testid="simple-ticket"]');
  tickets.forEach(ticket => {
    const signature = getTicketSignature(ticket);

    if (signature && printedTicketSignatures.has(signature)) {
      ticket.dataset.autoPrintDone = 'true';
      return;
    }
    if (ticket.dataset.autoPrintDone === 'true') {
      return;
    }
    if (ticket.querySelector('svg[data-testid="DOING"]')) {
      markTicketAsPrinted(ticket, signature);
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
  const activeSignatures = new Set();
  if (!tickets.length) {
    cleanupOrphanTimers(activeSignatures);
    maybeAutoPrintTickets();
    return;
  }

  tickets.forEach(ticket => {
    processTicketTimers(ticket, activeSignatures);
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
  cleanupOrphanTimers(activeSignatures);
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
  chrome.storage.sync.get(
    { [STORAGE_KEY]: [], [AUTO_PRINT_KEY]: false, [TIMER_ENABLED_KEY]: false },
    data => {
      const raw = data[STORAGE_KEY] || [];
      allowedProducts = raw
        .filter(Boolean)
        .map(String)
        .map(str => str.trim())
        .filter(Boolean);
      autoPrintEnabled = Boolean(data[AUTO_PRINT_KEY]);
      productTimersEnabled = Boolean(data[TIMER_ENABLED_KEY]);
      if (!productTimersEnabled) {
        clearAllProductTimers();
      }
      rebuildFilterKeywords();
      applyFilter();
    }
  );
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

function loadTimerConfig() {
  fetch(TIMER_CONFIG_URL)
    .then(response => {
      if (!response.ok) {
        throw new Error('Unable to load timers');
      }
      return response.json();
    })
    .then(data => {
      const timers = Array.isArray(data.timers) ? data.timers : [];
      productTimerEntries = timers
        .map((timer, index) => {
          const rawDurationMs = (() => {
            if (typeof timer.durationMs === 'number') {
              return timer.durationMs;
            }
            if (typeof timer.durationMs === 'string' && timer.durationMs.trim()) {
              const parsed = Number(timer.durationMs);
              if (!Number.isNaN(parsed)) {
                return parsed;
              }
            }
            if (typeof timer.durationSeconds === 'number') {
              return timer.durationSeconds * 1000;
            }
            if (typeof timer.durationSeconds === 'string' && timer.durationSeconds.trim()) {
              const parsed = Number(timer.durationSeconds);
              if (!Number.isNaN(parsed)) {
                return parsed * 1000;
              }
            }
            if (typeof timer.durationMinutes === 'number') {
              return timer.durationMinutes * 60 * 1000;
            }
            if (typeof timer.durationMinutes === 'string' && timer.durationMinutes.trim()) {
              const parsed = Number(timer.durationMinutes);
              if (!Number.isNaN(parsed)) {
                return parsed * 60 * 1000;
              }
            }
            return 0;
          })();

          const durationMs = Number.isFinite(rawDurationMs) ? rawDurationMs : 0;
          if (!durationMs || durationMs <= 0) {
            return null;
          }

          const collected = new Set();
          ['label', 'value', 'name', 'announcement'].forEach(key => {
            const value = timer[key];
            if (typeof value === 'string' && value.trim()) {
              collected.add(value);
            }
          });
          if (Array.isArray(timer.references)) {
            timer.references.forEach(ref => {
              if (typeof ref === 'string' && ref.trim()) {
                collected.add(ref);
              }
            });
          }
          if (Array.isArray(timer.keywords)) {
            timer.keywords.forEach(ref => {
              if (typeof ref === 'string' && ref.trim()) {
                collected.add(ref);
              }
            });
          }

          const matchers = Array.from(collected)
            .map(value => normalizeText(String(value)))
            .filter(Boolean);

          if (!matchers.length) {
            return null;
          }

          const firstCollected = collected.size ? collected.values().next().value : '';

          const label = (typeof timer.label === 'string' && timer.label.trim())
            ? timer.label.trim()
            : firstCollected || matchers[0];

          const announcement = (typeof timer.announcement === 'string' && timer.announcement.trim())
            ? timer.announcement.trim()
            : label;

          const idSource = typeof timer.id === 'string' && timer.id.trim()
            ? timer.id.trim()
            : matchers[0];

          const id = idSource || `timer-${index}`;

          return {
            id,
            label: label || announcement || 'Produit',
            announcement: announcement || label || 'Produit',
            durationMs,
            matchers
          };
        })
        .filter(Boolean);

      applyFilter();
    })
    .catch(() => {
      productTimerEntries = [];
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
  loadTimerConfig();
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
  if (Object.prototype.hasOwnProperty.call(changes, TIMER_ENABLED_KEY)) {
    productTimersEnabled = Boolean(changes[TIMER_ENABLED_KEY].newValue);
    if (!productTimersEnabled) {
      clearAllProductTimers();
    }
    applyFilter();
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
