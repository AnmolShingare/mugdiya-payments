/**
 * Mugdiya Payments & Proofs - Client Application Logic
 * Integrates Web Share Target, Canvas film-roll stitcher, live Google Sheets sync,
 * and 24/7 Google Apps Script Cloud Engine.
 */

const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbzTppDp1hOHABvwbkNz3mxju013tHcyIUUwC-JfUxiWDHT7tkBtmUAjpgx1NJi4XCQ/exec";

function getBackendUrl() {
  const saved = localStorage.getItem("MUGDIYA_BACKEND_URL");
  if (saved && saved.trim()) return saved.trim();
  return DEFAULT_GAS_URL;
}

function setBackendUrl(url) {
  if (url && url.trim()) {
    localStorage.setItem("MUGDIYA_BACKEND_URL", url.trim());
  } else {
    localStorage.removeItem("MUGDIYA_BACKEND_URL");
  }
}

// Application State
const state = {
  stagedFiles: [],       // Array of { file, dataUrl, category, name }
  transactions: [],      // LIFO transactions from Google Sheets
  selectedRowId: null,   // Explicitly ticked transaction row
  isProcessing: false,
  filterUnlinkedOnly: false,
  searchTerm: ""
};

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const cameraInput = document.getElementById('camera-input');
const stagedContainer = document.getElementById('staged-container');
const stagedList = document.getElementById('staged-list');
const imgCountEl = document.getElementById('img-count');
const btnClearImages = document.getElementById('btn-clear-images');
const userNotes = document.getElementById('user-notes');
const txList = document.getElementById('tx-list');
const txCountEl = document.getElementById('tx-count');
const txSearch = document.getElementById('tx-search');
const btnFilterUnlinked = document.getElementById('btn-filter-unlinked');
const btnProcess = document.getElementById('btn-process');
const processLog = document.getElementById('process-log');
const logText = document.getElementById('log-text');
const btnRefresh = document.getElementById('btn-refresh');
const syncStatus = document.getElementById('sync-status');
const btnPreviewCollage = document.getElementById('btn-preview-collage');
const collageModal = document.getElementById('collage-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const collageCanvas = document.getElementById('collage-canvas');
const toastEl = document.getElementById('toast');
const backlogHeader = document.getElementById('backlog-header');
const backlogBody = document.getElementById('backlog-body');
const backlogCount = document.getElementById('backlog-count');
const backlogList = document.getElementById('backlog-list');
const btnClearBacklog = document.getElementById('btn-clear-backlog');

// Settings Elements
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const btnCloseSettings = document.getElementById('btn-close-settings');
const backendUrlInput = document.getElementById('backend-url-input');
const btnSaveSettings = document.getElementById('btn-save-settings');
const btnResetSettings = document.getElementById('btn-reset-settings');

// ============================================================================
// 1. Service Worker & Web Share Target Retrieval
// ============================================================================
async function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      console.log('Service Worker registered successfully');
    } catch (err) {
      console.warn('Service Worker registration failed:', err);
    }
  }

  // Check if opened via Android Share Target
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('shared') === '1') {
    await retrieveSharedFilesFromDB();
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

async function retrieveSharedFilesFromDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open('MugdiyaShareDB', 1);
    request.onsuccess = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('shared_files')) {
        resolve();
        return;
      }
      const tx = db.transaction('shared_files', 'readwrite');
      const store = tx.objectStore('shared_files');
      const getAll = store.getAll();

      getAll.onsuccess = async () => {
        const items = getAll.result || [];
        if (items.length > 0) {
          showToast(`📥 Received ${items.length} shared photo(s) from phone!`);
          for (const item of items) {
            await addFileToStaging(item.file);
          }
          store.clear();
        }
        resolve();
      };
      getAll.onerror = () => resolve();
    };
    request.onerror = () => resolve();
  });
}

// ============================================================================
// 2. File Staging & Categorization
// ============================================================================
async function addFileToStaging(file) {
  if (!file || !file.type.startsWith('image/')) return;

  const dataUrl = await readFileAsDataURL(file);
  const guessedCategory = guessCategory(file.name);

  state.stagedFiles.push({
    id: Date.now() + Math.random(),
    file: file,
    dataUrl: dataUrl,
    category: guessedCategory,
    name: file.name
  });

  autoSortStagedFiles();
  renderStagedList();
  updateProcessButtonState();
}

function guessCategory(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('invoice') || lower.includes('bill') || lower.includes('scan') || lower.includes('receipt') || lower.includes('estimate')) {
    return 'INVOICE';
  } else if (lower.includes('phonepe') || lower.includes('gpay') || lower.includes('screenshot') || lower.includes('paytm') || lower.includes('upi')) {
    return 'UPI_SCREENSHOT';
  } else if (lower.includes('work') || lower.includes('motor') || lower.includes('pipe') || lower.includes('grill') || lower.includes('material')) {
    return 'PRODUCT_PHOTO';
  }
  return 'OTHER';
}

function autoSortStagedFiles() {
  const priority = { 'INVOICE': 1, 'UPI_SCREENSHOT': 2, 'PRODUCT_PHOTO': 3, 'OTHER': 4 };
  state.stagedFiles.sort((a, b) => (priority[a.category] || 4) - (priority[b.category] || 4));
}

function readFileAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

function renderStagedList() {
  const count = state.stagedFiles.length;
  imgCountEl.textContent = count;

  if (count === 0) {
    stagedContainer.classList.add('hidden');
    dropZone.classList.remove('hidden');
    return;
  }

  stagedContainer.classList.remove('hidden');
  stagedList.innerHTML = '';

  state.stagedFiles.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'staged-item';

    let tagClass = 'tag-other';
    let tagLabel = 'Other';
    if (item.category === 'INVOICE') {
      tagClass = 'tag-invoice';
      tagLabel = '1. 📄 Invoice';
    } else if (item.category === 'UPI_SCREENSHOT') {
      tagClass = 'tag-upi';
      tagLabel = '2. 📱 UPI Screenshot';
    } else if (item.category === 'PRODUCT_PHOTO') {
      tagClass = 'tag-product';
      tagLabel = '3. 📷 Work/Material';
    }

    el.innerHTML = `
      <div class="staged-thumb-box">
        <img class="staged-thumb" src="${item.dataUrl}" alt="thumb">
        <div class="staged-meta">
          <span class="staged-name">${item.name || 'Image ' + (index + 1)}</span>
          <span class="staged-tag ${tagClass}">${tagLabel}</span>
        </div>
      </div>
      <div class="staged-actions">
        <button class="btn-arrow" onclick="moveStagedItem(${index}, -1)" ${index === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn-arrow" onclick="moveStagedItem(${index}, 1)" ${index === count - 1 ? 'disabled' : ''}>▼</button>
        <button class="text-btn danger" onclick="removeStagedItem(${index})">✕</button>
      </div>
    `;
    stagedList.appendChild(el);
  });
}

window.moveStagedItem = function(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.stagedFiles.length) return;
  const temp = state.stagedFiles[index];
  state.stagedFiles[index] = state.stagedFiles[target];
  state.stagedFiles[target] = temp;
  renderStagedList();
};

window.removeStagedItem = function(index) {
  state.stagedFiles.splice(index, 1);
  renderStagedList();
  updateProcessButtonState();
};

btnClearImages.addEventListener('click', () => {
  state.stagedFiles = [];
  renderStagedList();
  updateProcessButtonState();
});

// Drop Zone Events
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files) {
    for (const file of e.dataTransfer.files) {
      await addFileToStaging(file);
    }
  }
});

fileInput.addEventListener('change', async (e) => {
  if (e.target.files) {
    for (const file of e.target.files) {
      await addFileToStaging(file);
    }
  }
  fileInput.value = '';
});

cameraInput.addEventListener('change', async (e) => {
  if (e.target.files) {
    for (const file of e.target.files) {
      await addFileToStaging(file);
    }
  }
  cameraInput.value = '';
});

window.addEventListener('paste', async (e) => {
  if (e.clipboardData && e.clipboardData.items) {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          showToast('📋 Image pasted from clipboard!');
          await addFileToStaging(file);
        }
      }
    }
  }
});

// ============================================================================
// 3. Client-Side HTML5 Canvas Vertical Film Roll Stitcher
// ============================================================================
async function renderCollageOnCanvas() {
  if (state.stagedFiles.length === 0) return null;

  const targetWidth = 1200;
  const dividerHeight = 8;
  const dividerColor = '#1e293b';

  const loadedImages = await Promise.all(
    state.stagedFiles.map((item) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.src = item.dataUrl;
      });
    })
  );

  let totalHeight = 0;
  const scaledHeights = loadedImages.map((img) => {
    const scaledH = Math.round((targetWidth / img.width) * img.height);
    totalHeight += scaledH;
    return scaledH;
  });

  totalHeight += dividerHeight * (loadedImages.length - 1);

  collageCanvas.width = targetWidth;
  collageCanvas.height = totalHeight;
  const ctx = collageCanvas.getContext('2d');

  let currentY = 0;
  loadedImages.forEach((img, idx) => {
    const h = scaledHeights[idx];
    ctx.drawImage(img, 0, currentY, targetWidth, h);
    currentY += h;

    if (idx < loadedImages.length - 1) {
      ctx.fillStyle = dividerColor;
      ctx.fillRect(0, currentY, targetWidth, dividerHeight);
      currentY += dividerHeight;
    }
  });

  return new Promise((resolve) => {
    collageCanvas.toBlob((blob) => {
      resolve(blob);
    }, 'image/jpeg', 0.88);
  });
}

btnPreviewCollage.addEventListener('click', async () => {
  showToast('Generating film roll preview...');
  await renderCollageOnCanvas();
  collageModal.classList.remove('hidden');
});

btnCloseModal.addEventListener('click', () => {
  collageModal.classList.add('hidden');
});

// ============================================================================
// 4. Google Sheets Transactions (LIFO Sync)
// ============================================================================
async function loadTransactions() {
  syncStatus.className = 'status-pill';
  syncStatus.innerHTML = '<span class="dot"></span> Syncing...';

  const backendUrl = getBackendUrl();
  const isGAS = backendUrl.includes("script.google.com");

  try {
    let res, data;
    if (isGAS) {
      res = await fetch(`${backendUrl}?action=get_transactions&limit=60`);
      data = await res.json();
    } else {
      res = await fetch('/api/transactions?limit=60');
      data = await res.json();
    }

    if (data.success && Array.isArray(data.transactions)) {
      state.transactions = data.transactions;
      renderTransactionList();
      syncStatus.className = 'status-pill status-online';
      syncStatus.innerHTML = '<span class="dot"></span> Live';
    } else {
      throw new Error(data.error || 'Failed to fetch');
    }
  } catch (err) {
    console.error('Transactions load error:', err);
    syncStatus.className = 'status-pill';
    syncStatus.style.color = '#ef4444';
    syncStatus.innerHTML = '⚠️ Offline';
    txList.innerHTML = `<p class="empty-text">Error loading transactions: ${err.message}. Check Cloud Engine Settings.</p>`;
  }
}

function renderTransactionList() {
  let list = [...state.transactions];

  if (state.filterUnlinkedOnly) {
    list = list.filter((t) => !t.has_proof);
  }

  if (state.searchTerm) {
    const q = state.searchTerm.toLowerCase();
    list = list.filter((t) => 
      t.particulars.toLowerCase().includes(q) ||
      t.amount.toLowerCase().includes(q) ||
      t.date.toLowerCase().includes(q) ||
      (t.additional_info && t.additional_info.toLowerCase().includes(q))
    );
  }

  txCountEl.textContent = `${list.length} shown`;

  if (list.length === 0) {
    txList.innerHTML = '<p class="empty-text">No matching transactions found.</p>';
    return;
  }

  txList.innerHTML = '';
  list.forEach((t) => {
    const item = document.createElement('div');
    const isSelected = state.selectedRowId === t.row_id;
    item.className = `tx-item ${isSelected ? 'selected' : ''}`;
    item.onclick = () => selectTransaction(t.row_id);

    let chipHtml = '';
    if (t.has_proof) {
      if (t.is_raw_url) {
        chipHtml = `<span class="tx-chip chip-raw-url" title="Raw URL: click to fix">🔗 Raw Link</span>`;
      } else {
        chipHtml = `<span class="tx-chip chip-has-proof" title="${t.proof_value}">🟢 Has Proof</span>`;
      }
    } else {
      chipHtml = `<span class="tx-chip chip-missing">🟠 Needs Proof</span>`;
    }

    item.innerHTML = `
      <input type="radio" name="tx-select" class="tx-radio" value="${t.row_id}" ${isSelected ? 'checked' : ''}>
      <div class="tx-info">
        <div class="tx-row-top">
          <span class="tx-particulars">${t.particulars || 'Untitled'}</span>
          <span class="tx-amount">₹${t.amount || '0'}</span>
        </div>
        <div class="tx-row-sub">
          <span>Row ${t.row_id} • ${t.date}</span>
          ${chipHtml}
        </div>
        ${t.additional_info ? `<div class="tx-extra-notes">${t.additional_info}</div>` : ''}
      </div>
    `;
    txList.appendChild(item);
  });
}

function selectTransaction(rowId) {
  if (state.selectedRowId === rowId) {
    state.selectedRowId = null;
    document.querySelector('input[name="tx-select"][value="auto"]').checked = true;
  } else {
    state.selectedRowId = rowId;
  }
  renderTransactionList();
}

document.querySelectorAll('input[name="tx-select"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    if (e.target.value === 'auto') {
      state.selectedRowId = null;
      renderTransactionList();
    }
  });
});

txSearch.addEventListener('input', (e) => {
  state.searchTerm = e.target.value.trim();
  renderTransactionList();
});

btnFilterUnlinked.addEventListener('click', () => {
  state.filterUnlinkedOnly = !state.filterUnlinkedOnly;
  btnFilterUnlinked.setAttribute('data-active', state.filterUnlinkedOnly ? 'true' : 'false');
  renderTransactionList();
});

btnRefresh.addEventListener('click', async () => {
  showToast('Refreshing sheet records...');
  await loadTransactions();
});

// ============================================================================
// 5. Processing & Linking Action
// ============================================================================
function updateProcessButtonState() {
  btnProcess.disabled = state.stagedFiles.length === 0 || state.isProcessing;
}

btnProcess.addEventListener('click', async () => {
  if (state.stagedFiles.length === 0 || state.isProcessing) return;

  state.isProcessing = true;
  updateProcessButtonState();
  processLog.classList.remove('hidden');
  logText.textContent = '1/4 Assembling film roll collage...';

  try {
    const collageBlob = await renderCollageOnCanvas();

    logText.textContent = '2/4 Analyzing with Gemini AI...';

    const backendUrl = getBackendUrl();
    const isGAS = backendUrl.includes("script.google.com");
    let result;

    if (isGAS) {
      // 24/7 Cloud Google Apps Script Engine
      const imagesBase64 = state.stagedFiles.map(f => f.dataUrl.split(',')[1]);
      const mimeTypes = state.stagedFiles.map(f => f.file.type || 'image/jpeg');
      let stitchedBase64 = null;
      if (collageBlob) {
        const collageDataUrl = await readFileAsDataURL(collageBlob);
        stitchedBase64 = collageDataUrl.split(',')[1];
      }

      const payload = {
        action: "process_and_link",
        imagesBase64: imagesBase64,
        mimeTypes: mimeTypes,
        stitchedImageBase64: stitchedBase64,
        stitchedMime: "image/jpeg",
        userInstructions: userNotes.value.trim(),
        tickedRowId: state.selectedRowId
      };

      logText.textContent = '3/4 Uploading to Drive & updating Sheet...';

      const res = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      result = await res.json();
    } else {
      // Local Flask Server
      const formData = new FormData();
      state.stagedFiles.forEach((item, idx) => {
        formData.append(`raw_image_${idx}`, item.file);
        formData.append(`category_${idx}`, item.category);
      });
      formData.append('count', state.stagedFiles.length);
      formData.append('stitched_collage', collageBlob, 'stitched_collage.jpg');
      formData.append('user_notes', userNotes.value.trim());

      if (state.selectedRowId) {
        formData.append('forced_row_id', state.selectedRowId);
      }

      logText.textContent = '3/4 Uploading & matching with Google Sheets...';

      const res = await fetch('/api/process', {
        method: 'POST',
        body: formData
      });
      result = await res.json();
    }

    if (!result.success) {
      throw new Error(result.error || 'Processing failed');
    }

    logText.textContent = '4/4 Complete! Updating UI...';

    if (result.pending) {
      showToast(`📦 Saved to Pending Backlog (Transaction not in Sheet yet).`, 'warning');
    } else {
      showToast(`✅ Successfully linked proof to Row ${result.matched_row_id}!`, 'success');
    }

    // Reset staging
    state.stagedFiles = [];
    userNotes.value = '';
    state.selectedRowId = null;
    renderStagedList();

    await loadTransactions();
    await loadPendingBacklog();

  } catch (err) {
    console.error('Process error:', err);
    showToast(`❌ Error: ${err.message}`, 'error');
  } finally {
    state.isProcessing = false;
    updateProcessButtonState();
    processLog.classList.add('hidden');
  }
});

// ============================================================================
// 6. Backlog Management
// ============================================================================
backlogHeader.addEventListener('click', () => {
  backlogBody.classList.toggle('hidden');
});

async function loadPendingBacklog() {
  const backendUrl = getBackendUrl();
  const isGAS = backendUrl.includes("script.google.com");

  try {
    let res, data;
    if (isGAS) {
      res = await fetch(`${backendUrl}?action=get_pending`);
      data = await res.json();
    } else {
      res = await fetch('/api/pending');
      data = await res.json();
    }

    if (data.success && Array.isArray(data.pending)) {
      backlogCount.textContent = data.pending.length;
      if (data.pending.length > 0) {
        backlogList.innerHTML = '';
        data.pending.forEach((item) => {
          const div = document.createElement('div');
          div.className = 'staged-item';
          div.innerHTML = `
            <div class="staged-meta">
              <span class="staged-name">${item.file_name}</span>
              <span class="staged-tag tag-upi">₹${item.amount || 'Pending'}</span>
            </div>
          `;
          backlogList.appendChild(div);
        });
      } else {
        backlogList.innerHTML = '<p class="empty-text">No pending receipts.</p>';
      }
    }
  } catch (err) {
    console.warn('Backlog load error:', err);
  }
}

btnClearBacklog.addEventListener('click', async () => {
  showToast('Reconciling pending receipts with Google Sheet...');
  const backendUrl = getBackendUrl();
  const isGAS = backendUrl.includes("script.google.com");

  try {
    let res, data;
    if (isGAS) {
      res = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: "clear_backlog" })
      });
      data = await res.json();
    } else {
      res = await fetch('/api/clear_backlog', { method: 'POST' });
      data = await res.json();
    }

    if (data.success) {
      showToast(`⚡ ${data.message}`);
      await loadPendingBacklog();
      await loadTransactions();
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// ============================================================================
// 7. Settings Modal Actions
// ============================================================================
btnSettings.addEventListener('click', () => {
  backendUrlInput.value = getBackendUrl();
  settingsModal.classList.remove('hidden');
});

btnCloseSettings.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

btnSaveSettings.addEventListener('click', async () => {
  const val = backendUrlInput.value.trim();
  if (val) {
    setBackendUrl(val);
    showToast('Saved Cloud Engine URL! Re-syncing...');
    settingsModal.classList.add('hidden');
    await loadTransactions();
  }
});

btnResetSettings.addEventListener('click', async () => {
  setBackendUrl(DEFAULT_GAS_URL);
  backendUrlInput.value = DEFAULT_GAS_URL;
  showToast('Reset to default Cloud Engine URL.');
  settingsModal.classList.add('hidden');
  await loadTransactions();
});

// Toast helper
function showToast(message, type = '') {
  toastEl.textContent = message;
  toastEl.className = `toast ${type ? 'toast-' + type : ''}`;
  toastEl.classList.remove('hidden');
  setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 4000);
}

// ============================================================================
// Initialization on page load
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  await initServiceWorker();
  await loadTransactions();
  await loadPendingBacklog();
});
