const input = document.getElementById('product-input');
const listEl = document.getElementById('product-list');
const form = document.getElementById('add-form');
const emptyHelp = document.getElementById('empty-help');

let products = [];

function save() {
  chrome.storage.sync.set({ allowedProducts: products });
  updateEmptyHelp();
}

function updateEmptyHelp() {
  emptyHelp.style.display = products.length ? 'none' : 'block';
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
}

function load() {
  chrome.storage.sync.get({ allowedProducts: [] }, data => {
    const stored = Array.isArray(data.allowedProducts) ? data.allowedProducts : [];
    products = stored;
    render();
    updateEmptyHelp();
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

document.addEventListener('DOMContentLoaded', load);
