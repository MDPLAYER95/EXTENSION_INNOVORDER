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
let readyBeepContext = null;
let timerStylesInjected = false;
let timerStylesPending = false;

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

function ensureTimerStyles() {
  if (timerStylesInjected) {
    return;
  }

  const styleContent = `
    .io-product-timer-host {
      position: relative;
    }

    .io-product-timer-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 8px;
      padding: 2px 8px;
      border-radius: 999px;
      background-color: #2563eb;
      color: #ffffff;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
      min-width: 48px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.2);
    }

    .io-product-timer-ready {
      background-color: #dc2626;
    }

    .io-product-ready {
      animation: io-product-ready-blink 1s ease-in-out infinite;
      background-color: rgba(220, 38, 38, 0.16);
      border-radius: 8px;
    }

    .io-product-ready .io-product-timer-badge {
      background-color: #dc2626;
    }

    @keyframes io-product-ready-blink {
      0% {
        box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.55);
      }
      50% {
        box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.2);
        background-color: rgba(220, 38, 38, 0.32);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.55);
      }
    }
  `;

  const attachStyles = () => {
    if (timerStylesInjected) {
      return;
    }
    const target = document.head || document.documentElement || document.body;
    if (!target) {
      return;
    }
    const style = document.createElement('style');
    style.type = 'text/css';
    style.textContent = styleContent;
    target.appendChild(style);
    timerStylesInjected = true;
  };

  attachStyles();

  if (!timerStylesInjected && !timerStylesPending) {
    timerStylesPending = true;
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        timerStylesPending = false;
        attachStyles();
      },
      { once: true }
    );
  }
}

function formatTimerDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    ms = 0;
  }
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function playReadyBeep() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    return;
  }

  if (!readyBeepContext) {
    try {
      readyBeepContext = new AudioContextConstructor();
    } catch (error) {
      readyBeepContext = null;
      return;
    }
  }

  const context = readyBeepContext;
  const startBeep = () => {
    if (!context) {
      return;
    }
    const duration = 2;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.connect(gain);
    gain.connect(context.destination);
    const now = context.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.05);
    gain.gain.setValueAtTime(0.3, now + duration - 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.start(now);
    oscillator.stop(now + duration);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  };

  if (context.state === 'suspended') {
    context
      .resume()
      .then(startBeep)
      .catch(startBeep);
  } else {
    startBeep();
  }
}

function ensureTimerBadge(instance) {
  if (!instance) {
    return null;
  }

  let target = instance.target;
  if (!(target instanceof HTMLElement) || !target.isConnected) {
    target = instance.host instanceof HTMLElement ? instance.host : null;
  }

  if (!target) {
    return null;
  }

  let badge = instance.badge;
  if (badge && !badge.isConnected) {
    badge = null;
  }

  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'io-product-timer-badge';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    target.appendChild(badge);
    instance.badge = badge;
  }

  return badge;
}

function cleanupTimerInstance(instance) {
  if (!instance) {
    return;
  }
  if (instance.badge && instance.badge.parentNode) {
    instance.badge.classList.remove('io-product-timer-ready');
    instance.badge.remove();
  }
  instance.badge = null;
  if (instance.host && instance.host.classList) {
    instance.host.classList.remove('io-product-ready', 'io-product-timer-host');
  }
}

function updateTimerInstance(info, instance, ready, displayText) {
  if (!instance) {
    return;
  }

  const host = instance.host;
  if (!(host instanceof HTMLElement) || !host.isConnected) {
    cleanupTimerInstance(instance);
    if (host && info.instances.has(host)) {
      info.instances.delete(host);
    }
    return;
  }

  host.classList.add('io-product-timer-host');
  host.classList.toggle('io-product-ready', ready);

  const badge = ensureTimerBadge(instance);
  if (!badge) {
    return;
  }

  badge.textContent = displayText;
  badge.classList.toggle('io-product-timer-ready', ready);
  if (ready) {
    badge.setAttribute('aria-label', 'Produit prêt');
    badge.title = 'Produit prêt';
  } else {
    const label = `Temps restant : ${displayText}`;
    badge.setAttribute('aria-label', label);
    badge.title = label;
  }
}

function updateProductTimerInfo(info, remainingMs) {
  if (!info) {
    return;
  }

  const ready = info.ready || remainingMs <= 0;
  const displayText = ready ? 'Prêt' : formatTimerDuration(remainingMs);
  info.instances.forEach(instance => {
    updateTimerInstance(info, instance, ready, displayText);
  });
}

function markProductTimerReady(timerKey) {
  const info = activeProductTimers.get(timerKey);
  if (!info || info.ready) {
    return;
  }

  info.ready = true;
  if (info.intervalId) {
    clearInterval(info.intervalId);
    info.intervalId = null;
  }

  if (!info.beeped) {
    playReadyBeep();
    info.beeped = true;
  }

  updateProductTimerInfo(info, 0);
}

function updateProductTimerDisplay(timerKey) {
  const info = activeProductTimers.get(timerKey);
  if (!info) {
    return;
  }

  if (info.ready) {
    updateProductTimerInfo(info, 0);
    return;
  }

  const remaining = Math.max(0, info.expiresAt - Date.now());
  if (remaining <= 0) {
    markProductTimerReady(timerKey);
    return;
  }

  updateProductTimerInfo(info, remaining);
}

function registerTimerElement(info, hostElement, badgeTarget, timerKey) {
  if (!(hostElement instanceof HTMLElement)) {
    return;
  }

  const host = hostElement;
  const target = badgeTarget instanceof HTMLElement ? badgeTarget : hostElement;
  let instance = info.instances.get(host);
  if (!instance) {
    instance = { host, target, badge: null, key: timerKey };
    info.instances.set(host, instance);
  } else {
    instance.key = timerKey;
    if (target !== instance.target) {
      instance.target = target;
      if (instance.badge && instance.badge.parentNode !== target) {
        instance.badge.remove();
        instance.badge = null;
      }
    }
  }
}

function clearActiveProductTimer(timerKey) {
  const info = activeProductTimers.get(timerKey);
  if (!info) {
    return;
  }

  clearTimeout(info.timeoutId);
  if (info.intervalId) {
    clearInterval(info.intervalId);
  }

  if (info.instances) {
    info.instances.forEach(instance => {
      cleanupTimerInstance(instance);
    });
    info.instances.clear();
  }

  activeProductTimers.delete(timerKey);
}

function clearAllProductTimers() {
  Array.from(activeProductTimers.keys()).forEach(clearActiveProductTimer);
}

function ensureProductTimer(
  timerKey,
  timerEntry,
  signature,
  orderNumber,
  hostElement,
  badgeTarget
) {
  const durationMs = timerEntry.durationMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return;
  }

  ensureTimerStyles();

  let info = activeProductTimers.get(timerKey);
  if (!info) {
    const startedAt = Date.now();
    const expiresAt = startedAt + durationMs;
    const timeoutId = setTimeout(() => {
      markProductTimerReady(timerKey);
    }, durationMs);
    const intervalId = setInterval(() => {
      updateProductTimerDisplay(timerKey);
    }, 1000);

    info = {
      timeoutId,
      intervalId,
      signature,
      timerEntry,
      orderNumber,
      startedAt,
      expiresAt,
      ready: false,
      beeped: false,
      instances: new Map()
    };
    activeProductTimers.set(timerKey, info);
  }

  info.signature = signature;
  info.orderNumber = orderNumber;
  info.timerEntry = timerEntry;
  if (!Number.isFinite(info.expiresAt)) {
    const base = Number.isFinite(info.startedAt) ? info.startedAt : Date.now();
    info.expiresAt = base + durationMs;
  }
  registerTimerElement(info, hostElement, badgeTarget, timerKey);
  updateProductTimerDisplay(timerKey);
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

function getArticleStatus(article) {
  if (!(article instanceof HTMLElement)) {
    return 'unknown';
  }

  if (article.classList.contains('io-product-ready')) {
    return 'done';
  }

  const statusIcon = article.querySelector('svg[data-testid]');
  const rawStatus =
    (statusIcon && (statusIcon.dataset.testid || statusIcon.getAttribute('data-testid'))) || '';
  const normalizedStatus = rawStatus
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');

  if (!normalizedStatus) {
    return 'unknown';
  }

  if (normalizedStatus.includes('doing') || normalizedStatus.includes('progress')) {
    return 'doing';
  }
  if (normalizedStatus.includes('todo')) {
    return 'todo';
  }
  if (normalizedStatus.includes('done')) {
    return 'done';
  }

  return normalizedStatus;
}

function collectArticleDetails(article) {
  const lines = [];
  if (!article) {
    return lines;
  }
  const labelEl = article.querySelector('p');
  const label = (labelEl ? labelEl.innerText : article.innerText || '').trim();
  if (label) {
    lines.push({
      type: 'item',
      text: label,
      element: article,
      timerTarget: labelEl || article,
      status: getArticleStatus(article)
    });
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

  const orderNumber = getTicketNumber(ticket);
  const details = extractTicketDetails(ticket).filter(entry => entry.type === 'item');
  const activeItems = details.filter(entry => entry.status === 'doing');

  if (!activeItems.length) {
    cleanupTimersForTicket(signature, new Set());
    return;
  }

  const keepKeys = new Set();
  const occurrenceCount = new Map();

  activeItems.forEach(entry => {
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
      ensureProductTimer(
        timerKey,
        timerEntry,
        signature,
        orderNumber,
        entry.element,
        entry.timerTarget
      );
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
