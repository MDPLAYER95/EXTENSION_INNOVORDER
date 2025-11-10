const AUTO_PRINT_KEY = 'autoPrintEnabled';
const input = document.getElementById('product-input');
const listEl = document.getElementById('product-list');
const form = document.getElementById('add-form');
const emptyHelp = document.getElementById('empty-help');
const referenceSection = document.getElementById('reference-section');
const referenceList = document.getElementById('reference-list');
const autoPrintToggle = document.getElementById('auto-print-toggle');
const autoPrintHelp = document.getElementById('auto-print-help');

let products = [];
let references = [];

function save() {
  chrome.storage.sync.set({ allowedProducts: products });
  updateEmptyHelp();
}

function updateEmptyHelp() {
  emptyHelp.style.display = products.length ? 'none' : 'block';
}

function updateAutoPrintHelp() {
  if (!autoPrintHelp || !autoPrintToggle) {
    return;
  }
  autoPrintHelp.style.display = autoPrintToggle.checked ? 'block' : 'none';
}

function render() {
  listEl.innerHTML = '';
  products.forEach((name, index) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = name;
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.className = 'remove';
    btn.title = 'Supprimer ce produit';
    btn.addEventListener('click', () => {
      products.splice(index, 1);
      save();
      render();
    });
    li.appendChild(span);
    li.appendChild(btn);
    listEl.appendChild(li);
  });
  renderReferences();
}

function load() {
  chrome.storage.sync.get({ allowedProducts: [], [AUTO_PRINT_KEY]: false }, data => {
    const stored = Array.isArray(data.allowedProducts) ? data.allowedProducts : [];
    products = stored;
    if (autoPrintToggle) {
      autoPrintToggle.checked = Boolean(data[AUTO_PRINT_KEY]);
    }
    render();
    updateEmptyHelp();
    updateAutoPrintHelp();
  });
}

function renderReferences() {
  if (!referenceSection || !referenceList) {
    return;
  }

  referenceList.innerHTML = '';

  if (!references.length) {
    referenceSection.hidden = true;
    return;
  }

  referenceSection.hidden = false;

  references.forEach(ref => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = ref.label;
    btn.className = 'reference-button';

    const alreadyAdded = products.includes(ref.value);
    if (alreadyAdded) {
      btn.disabled = true;
      btn.title = 'Référence déjà ajoutée';
    }

    btn.addEventListener('click', () => {
      if (products.includes(ref.value)) {
        return;
      }
      products.push(ref.value);
      save();
      render();
    });

    li.appendChild(btn);
    referenceList.appendChild(li);
  });
}

function loadReferences() {
  if (!referenceSection || !referenceList) {
    return;
  }

  const url = chrome.runtime.getURL('references.json');
  fetch(url)
    .then(response => {
      if (!response.ok) {
        throw new Error('Unable to load references');
      }
      return response.json();
    })
    .then(data => {
      const targets = Array.isArray(data.targets) ? data.targets : [];
      references = targets
        .map(target => {
          const label = target.label || target.value;
          const value = target.value || target.label;
          if (!label || !value) {
            return null;
          }
          return {
            label,
            value
          };
        })
        .filter(Boolean);
      renderReferences();
    })
    .catch(() => {
      references = [];
      renderReferences();
    });
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const value = (input.value || '').trim();
  if (!value) return;
  if (!products.includes(value)) {
    products.push(value);
    save();
    render();
  }
  input.value = '';
  input.focus();
});

document.addEventListener('DOMContentLoaded', () => {
  if (autoPrintToggle) {
    autoPrintToggle.addEventListener('change', () => {
      chrome.storage.sync.set({ [AUTO_PRINT_KEY]: autoPrintToggle.checked });
      updateAutoPrintHelp();
    });
  }
  load();
  loadReferences();
});
