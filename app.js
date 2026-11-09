/**
 * Mugdiya Payments & Proofs - Client Application Logic (v2.1)
 * Features:
 * 1. Persistent IndexedDB Staging Store (never loses files when switching apps on Android).
 * 2. Web Share Target Integration (PhonePe, GPay, Gallery).
 * 3. Amount & Text Search Normalization (matches "1215" to "1,215", row IDs, particulars).
 * 4. 3 Filter Tabs: All, Needs Proof ⚠️, Has Proof ✅ with real-time badges.
 * 5. High-Resolution Film-Roll Canvas Generator with document framing and rotation (90°).
 * 6. Interactive Pinch/Touch/Button Zoom & Pan in Modal Viewer.
 * 7. 24/7 Cloud Google Apps Script Engine Integration.
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
  stagedFiles: [],       // Array of { id, file, dataUrl, category, name, rotation }
  transactions: [],      // LIFO transactions from Google Sheets
  selectedRowId: null,   // Explicitly referenced transaction row
  isProcessing: false,
  activeFilter: 'all',   // 'all' | 'needs_proof' | 'has_proof'
  searchTerm: "",
  zoomLevel: 1.0,        // Modal canvas zoom level
  aiActive: true         // AI Enabled for verification & filename generation
};

// Initialize PDF.js worker for client-side scanned document extraction
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

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
const btnClearSearch = document.getElementById('btn-clear-search');
const btnProcess = document.getElementById('btn-process');
const processLog = document.getElementById('process-log');
const logText = document.getElementById('log-text');
const btnRefresh = document.getElementById('btn-refresh');
const syncStatus = document.getElementById('sync-status');
const btnPreviewCollage = document.getElementById('btn-preview-collage');
const collageModal = document.getElementById('collage-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const collageCanvas = document.getElementById('collage-canvas');
const canvasTransformWrapper = document.getElementById('canvas-transform-wrapper');
const canvasDimEl = document.getElementById('canvas-dim');
const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnZoomReset = document.getElementById('btn-zoom-reset');
const zoomLevelEl = document.getElementById('zoom-level');
const selectedTxBanner = document.getElementById('selected-tx-banner');
const aiModeToggle = document.getElementById('ai-mode-toggle');
const aiToggleSub = document.getElementById('ai-toggle-sub');
const errorBanner = document.getElementById('error-banner');
const errorBannerText = document.getElementById('error-banner-text');
const errorBannerActions = document.getElementById('error-banner-actions');
const btnCloseError = document.getElementById('btn-close-error');
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

// Tab Filter Buttons
const tabButtons = document.querySelectorAll('.tab-btn');
const countAllEl = document.getElementById('count-all');
const countNeedsProofEl = document.getElementById('count-needs-proof');
const countHasProofEl = document.getElementById('count-has-proof');

// ============================================================================
// 1. Persistent IndexedDB Storage (Never Lose Staged Photos Across Shares)
// ============================================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MugdiyaShareDB', 2);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('shared_files')) {
        db.createObjectStore('shared_files', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('staged_session_files')) {
        db.createObjectStore('staged_session_files', { keyPath: 'id' });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (err) => reject(err);
  });
}

async function saveStagedSession() {
  try {
    const db = await openDB();
    const tx = db.transaction('staged_session_files', 'readwrite');
    const store = tx.objectStore('staged_session_files');
    await new Promise((resolve, reject) => {
      const clearReq = store.clear();
      clearReq.onsuccess = resolve;
      clearReq.onerror = reject;
    });

    for (const item of state.stagedFiles) {
      // Store plain serializable object in IndexedDB
      store.add({
        id: item.id,
        name: item.name,
        category: item.category,
        dataUrl: item.dataUrl,
        type: item.file ? item.file.type : 'image/jpeg',
        rotation: item.rotation || 0
      });
    }
  } catch (err) {
    console.warn('Error saving staged session to IndexedDB:', err);
  }
}

async function loadStagedSession() {
  try {
    const db = await openDB();
    const tx = db.transaction('staged_session_files', 'readonly');
    const store = tx.objectStore('staged_session_files');
    const items = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = reject;
    });

    if (items.length > 0) {
      state.stagedFiles = items.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        dataUrl: item.dataUrl,
        rotation: item.rotation || 0,
        file: dataURLtoFile(item.dataUrl, item.name)
      }));
      renderStagedList();
      updateProcessButtonState();
    }
  } catch (err) {
    console.warn('Error loading staged session from IndexedDB:', err);
  }
}

async function clearStagedSession() {
  state.stagedFiles = [];
  renderStagedList();
  updateProcessButtonState();
  try {
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction(['staged_session_files', 'shared_files'], 'readwrite');
      tx.objectStore('staged_session_files').clear();
      tx.objectStore('shared_files').clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    addDebugLog('Staging area & shared queue cleared in IndexedDB', 'info');
  } catch (err) {
    console.warn('Error clearing staged session:', err);
  }
}

// Convert dataURL back to File object
function dataURLtoFile(dataurl, filename) {
  const arr = dataurl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], filename, { type: mime });
}

// Retrieve any newly shared files from the Service Worker
async function retrieveSharedFilesFromDB() {
  try {
    const db = await openDB();
    // Atomically read and clear the shared_files object store in the same transaction before yielding to event loop
    const items = await new Promise((resolve, reject) => {
      const tx = db.transaction('shared_files', 'readwrite');
      const store = tx.objectStore('shared_files');
      const getReq = store.getAll();
      getReq.onsuccess = () => {
        store.clear(); // Cleared in the exact same transaction before control yields!
        tx.oncomplete = () => resolve(getReq.result || []);
        tx.onerror = (e) => reject(e);
      };
      getReq.onerror = (e) => reject(e);
    });

    if (items && items.length > 0) {
      showToast(`📥 Received ${items.length} shared photo(s) from phone!`);
      addDebugLog(`📥 Retrieved ${items.length} shared file(s) from phone share menu`, 'info');
      for (const item of items) {
        await addFileToStaging(item.file);
      }
      await saveStagedSession();
    }
  } catch (err) {
    console.error('Error retrieving shared files:', err);
    addDebugLog(`Error retrieving shared files: ${err.message}`, 'error');
  }
}

// ============================================================================
// 2. Service Worker Registration & Initialization
// ============================================================================
async function initApp() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      console.log('Service Worker active');
    } catch (err) {
      console.warn('Service Worker registration note:', err);
    }
  }

  // 1. Load any persistent staged photos from previous app session
  await loadStagedSession();

  // 2. Check if launched via Android Web Share Target
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('shared') === '1') {
    await retrieveSharedFilesFromDB();
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // 3. Load transactions from Google Sheets
  await loadTransactions();
  await loadPendingBacklog();
}

// ============================================================================
// 3. File Staging, Categorization & Rotation
// ============================================================================

async function extractImagesFromPdf(file) {
  if (!window.pdfjsLib) {
    throw new Error('PDF processing library (pdf.js) is not loaded.');
  }
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;
  const results = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    // 2.0x scale gives crisp ~1600-2400px images for high clarity of receipt text & figures
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    await page.render({
      canvasContext: ctx,
      viewport: viewport
    }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const cleanBase = file.name.replace(/\.pdf$/i, '');
    const pageName = numPages > 1 
      ? `${cleanBase}_Page_${pageNum}.jpg`
      : `${cleanBase}.jpg`;

    results.push({
      name: pageName,
      dataUrl: dataUrl,
      category: 'INVOICE' // Scanned PDFs from Adobe Scan are bills/invoices
    });
  }

  return results;
}

async function addFileToStaging(file) {
  if (!file) return;

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImage = file.type.startsWith('image/');

  if (!isPdf && !isImage) {
    showToast(`Skipped non-image/non-pdf file: ${file.name}`, 3000, true);
    return;
  }

  if (isPdf) {
    showToast(`📄 Extracting page image(s) from ${file.name}...`, 2500);
    try {
      const extractedPages = await extractImagesFromPdf(file);
      for (const page of extractedPages) {
        state.stagedFiles.push({
          id: Date.now() + Math.random(),
          file: dataURLtoFile(page.dataUrl, page.name),
          dataUrl: page.dataUrl,
          category: page.category,
          name: page.name,
          rotation: 0
        });
      }
      showToast(`✅ Extracted ${extractedPages.length} scanned page(s) from PDF!`);
    } catch (pdfErr) {
      console.error('PDF extraction failed:', pdfErr);
      showToast(`❌ Could not extract pages from PDF: ${pdfErr.message}`, 6000, true);
      return;
    }
  } else {
    const dataUrl = await readFileAsDataURL(file);
    const guessedCategory = guessCategory(file.name);

    state.stagedFiles.push({
      id: Date.now() + Math.random(),
      file: file,
      dataUrl: dataUrl,
      category: guessedCategory,
      name: file.name,
      rotation: 0
    });
  }

  autoSortStagedFiles();
  await saveStagedSession();
  renderStagedList();
  updateProcessButtonState();
}

function guessCategory(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('invoice') || lower.includes('bill') || lower.includes('estimate') || lower.includes('receipt') && !lower.includes('phonepe') && !lower.includes('gpay')) {
    return 'INVOICE';
  }
  if (lower.includes('phonepe') || lower.includes('gpay') || lower.includes('paytm') || lower.includes('screenshot') || lower.includes('upi') || lower.includes('transaction')) {
    return 'UPI_SCREENSHOT';
  }
  if (lower.includes('photo') || lower.includes('work') || lower.includes('material') || lower.includes('pipe') || lower.includes('motor')) {
    return 'PRODUCT_PHOTO';
  }
  return 'OTHER_DOC';
}

function autoSortStagedFiles() {
  const priority = {
    'INVOICE': 1,
    'UPI_SCREENSHOT': 2,
    'PRODUCT_PHOTO': 3,
    'OTHER_DOC': 4
  };
  state.stagedFiles.sort((a, b) => {
    return (priority[a.category] || 99) - (priority[b.category] || 99);
  });
}

function renderStagedList() {
  if (state.stagedFiles.length === 0) {
    stagedContainer.classList.add('hidden');
    imgCountEl.textContent = '0';
    return;
  }

  stagedContainer.classList.remove('hidden');
  imgCountEl.textContent = state.stagedFiles.length;
  stagedList.innerHTML = '';

  state.stagedFiles.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'staged-item';

    let tagClass = 'tag-other';
    let tagLabel = 'Doc';
    if (item.isExistingProof) {
      tagClass = 'tag-existing';
      tagLabel = '💳 Existing Proof (from Sheet)';
    } else if (item.category === 'INVOICE') {
      tagClass = 'tag-invoice';
      tagLabel = '1. 📄 Invoice';
    } else if (item.category === 'UPI_SCREENSHOT') {
      tagClass = 'tag-upi';
      tagLabel = '2. 💳 UPI Proof';
    } else if (item.category === 'PRODUCT_PHOTO') {
      tagClass = 'tag-product';
      tagLabel = '3. 📷 Work/Photo';
    }

    el.innerHTML = `
      <div class="staged-thumb-box">
        <img src="${item.dataUrl}" class="staged-thumb" alt="${item.name}">
        <div class="staged-meta">
          <span class="staged-name" title="${item.name}">${item.name}</span>
          <span class="staged-tag ${tagClass}">${tagLabel}</span>
        </div>
      </div>
      <div class="staged-actions">
        <button type="button" class="btn-rotate" title="Rotate 90° Clockwise" onclick="rotateFile(${item.id})">🔄</button>
        <button type="button" class="btn-arrow" title="Move Up" ${index === 0 ? 'disabled style="opacity:0.3"' : ''} onclick="moveFile(${index}, -1)">▲</button>
        <button type="button" class="btn-arrow" title="Move Down" ${index === state.stagedFiles.length - 1 ? 'disabled style="opacity:0.3"' : ''} onclick="moveFile(${index}, 1)">▼</button>
        <button type="button" class="btn-arrow danger" title="Remove" onclick="removeFile(${item.id})">✕</button>
      </div>
    `;
    stagedList.appendChild(el);
  });
}

window.moveFile = async function(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.stagedFiles.length) return;
  const temp = state.stagedFiles[index];
  state.stagedFiles[index] = state.stagedFiles[target];
  state.stagedFiles[target] = temp;
  await saveStagedSession();
  renderStagedList();
};

window.removeFile = async function(id) {
  state.stagedFiles = state.stagedFiles.filter(item => item.id !== id);
  await saveStagedSession();
  renderStagedList();
  updateProcessButtonState();
};

window.rotateFile = async function(id) {
  const item = state.stagedFiles.find(f => f.id === id);
  if (!item) return;

  showToast('Rotating photo 90°...');
  const img = new Image();
  img.src = item.dataUrl;
  await new Promise(r => img.onload = r);

  const canvas = document.createElement('canvas');
  // Swap width & height for 90 degree rotation
  canvas.width = img.height;
  canvas.height = img.width;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(90 * Math.PI / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);

  item.dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  item.rotation = ((item.rotation || 0) + 90) % 360;
  item.file = dataURLtoFile(item.dataUrl, item.name);

  await saveStagedSession();
  renderStagedList();
};

btnClearImages.addEventListener('click', async () => {
  if (confirm('Clear all staged photos?')) {
    await clearStagedSession();
    showToast('Staged photos cleared.');
  }
});

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Upload & Camera Listeners
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
  const files = Array.from(e.dataTransfer.files);
  for (const f of files) {
    await addFileToStaging(f);
  }
});

fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  for (const f of files) {
    await addFileToStaging(f);
  }
  fileInput.value = '';
});

cameraInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  for (const f of files) {
    await addFileToStaging(f);
  }
  cameraInput.value = '';
});

// ============================================================================
// 4. Enhanced High-Resolution Film Roll Canvas Stitcher (Bug 1 Fix)
// ============================================================================
async function renderCollageOnCanvas() {
  if (state.stagedFiles.length === 0) return null;

  const targetWidth = 1200;
  const paddingX = 24;
  const cardSpacing = 28;
  const headerHeight = 44;
  const innerContentWidth = targetWidth - (paddingX * 2);

  // Load all images asynchronously
  const loadedImages = await Promise.all(
    state.stagedFiles.map((item) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ img, item });
        img.src = item.dataUrl;
      });
    })
  );

  // Calculate scaled dimensions with aspect ratio preservation
  let totalHeight = cardSpacing;
  const renderedCards = loadedImages.map(({ img, item }, idx) => {
    const scaledH = Math.round((innerContentWidth / img.width) * img.height);
    const cardHeight = scaledH + headerHeight;
    totalHeight += cardHeight + cardSpacing;
    return { img, item, scaledH, cardHeight, idx };
  });

  collageCanvas.width = targetWidth;
  collageCanvas.height = totalHeight;
  const ctx = collageCanvas.getContext('2d');

  // 1. Draw modern dark background
  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, targetWidth, totalHeight);

  // 2. Draw each document inside a clean card frame
  let currentY = cardSpacing;

  renderedCards.forEach(({ img, item, scaledH, cardHeight, idx }) => {
    // Card Container Background & Shadow
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;

    // Rounded rectangle card
    const cardX = paddingX;
    const cardY = currentY;
    const cardW = innerContentWidth;
    const cardH = cardHeight;
    const radius = 12;

    ctx.beginPath();
    ctx.moveTo(cardX + radius, cardY);
    ctx.lineTo(cardX + cardW - radius, cardY);
    ctx.quadraticCurveTo(cardX + cardW, cardY, cardX + cardW, cardY + radius);
    ctx.lineTo(cardX + cardW, cardY + cardH - radius);
    ctx.quadraticCurveTo(cardX + cardW, cardY + cardH, cardX + cardW - radius, cardY + cardH);
    ctx.lineTo(cardX + radius, cardY + cardH);
    ctx.quadraticCurveTo(cardX, cardY + cardH, cardX, cardY + cardH - radius);
    ctx.lineTo(cardX, cardY + radius);
    ctx.quadraticCurveTo(cardX, cardY, cardX + radius, cardY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Document Header Bar
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(cardX + 2, cardY + 2, cardW - 4, headerHeight - 2);

    // Header Label & Category
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 18px system-ui, -apple-system, sans-serif';
    let categoryTitle = `Document ${idx + 1}`;
    if (item.category === 'INVOICE') categoryTitle = `📄 ${idx + 1}. INVOICE / BILL ESTIMATE`;
    if (item.category === 'UPI_SCREENSHOT') categoryTitle = `💳 ${idx + 1}. PHONEPE / GPAY PAYMENT PROOF`;
    if (item.category === 'PRODUCT_PHOTO') categoryTitle = `📷 ${idx + 1}. SITE WORK / MATERIAL PHOTO`;
    ctx.fillText(categoryTitle, cardX + 16, cardY + 28);

    // Draw Document Image inside Card
    ctx.drawImage(img, cardX, cardY + headerHeight, cardW, scaledH);

    currentY += cardHeight + cardSpacing;
  });

  if (canvasDimEl) {
    canvasDimEl.textContent = `${targetWidth} × ${totalHeight}px`;
  }

  return new Promise((resolve) => {
    collageCanvas.toBlob((blob) => {
      resolve(blob);
    }, 'image/jpeg', 0.92);
  });
}

// Modal Zoom & Pan Handlers
function updateModalZoom() {
  if (canvasTransformWrapper) {
    canvasTransformWrapper.style.transform = `scale(${state.zoomLevel})`;
  }
  if (zoomLevelEl) {
    zoomLevelEl.textContent = `${Math.round(state.zoomLevel * 100)}%`;
  }
}

btnZoomIn.addEventListener('click', () => {
  if (state.zoomLevel < 3.0) {
    state.zoomLevel = Math.min(3.0, state.zoomLevel + 0.25);
    updateModalZoom();
  }
});

btnZoomOut.addEventListener('click', () => {
  if (state.zoomLevel > 0.4) {
    state.zoomLevel = Math.max(0.4, state.zoomLevel - 0.25);
    updateModalZoom();
  }
});

btnZoomReset.addEventListener('click', () => {
  state.zoomLevel = 1.0;
  updateModalZoom();
});

btnPreviewCollage.addEventListener('click', async () => {
  showToast('Generating film roll preview...');
  await renderCollageOnCanvas();
  state.zoomLevel = 1.0;
  updateModalZoom();
  collageModal.classList.remove('hidden');
});

btnCloseModal.addEventListener('click', () => {
  collageModal.classList.add('hidden');
});

// ============================================================================
// 5. Google Sheets Transactions (Robust Search & 3-Tab Filter)
// ============================================================================
async function loadTransactions() {
  syncStatus.className = 'status-pill';
  syncStatus.innerHTML = '<span class="dot"></span> Syncing...';

  const backendUrl = getBackendUrl();
  const isGAS = backendUrl.includes("script.google.com");

  try {
    let res, data;
    if (isGAS) {
      res = await fetch(`${backendUrl}?action=get_transactions&limit=80`);
      data = await res.json();
    } else {
      res = await fetch('/api/transactions?limit=80');
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
    syncStatus.innerHTML = '<span class="dot" style="background:#ef4444"></span> Offline';
  }
}

function renderTransactionList() {
  let list = [...state.transactions];

  // 1. Calculate Real-Time Tab Counts
  const countAll = state.transactions.length;
  const countNeedsProof = state.transactions.filter(t => !t.has_proof).length;
  const countHasProof = state.transactions.filter(t => t.has_proof).length;

  if (countAllEl) countAllEl.textContent = countAll;
  if (countNeedsProofEl) countNeedsProofEl.textContent = countNeedsProof;
  if (countHasProofEl) countHasProofEl.textContent = countHasProof;

  // 2. Apply Segmented Tab Filter
  if (state.activeFilter === 'needs_proof') {
    list = list.filter((t) => !t.has_proof);
  } else if (state.activeFilter === 'has_proof') {
    list = list.filter((t) => t.has_proof);
  }

  // 3. Apply Robust Amount, Row ID & Text Search (Bug 3 Fix)
  if (state.searchTerm) {
    const rawQ = state.searchTerm.trim().toLowerCase();
    const numQ = rawQ.replace(/[^0-9.]/g, ''); // Digits only for amounts/rows

    list = list.filter((t) => {
      // Amount match (normalized without commas)
      const cleanAmt = String(t.amount || '').replace(/[^0-9.]/g, '');
      const amtMatch = numQ.length > 0 && cleanAmt.includes(numQ);

      // Row ID match (#118 or 118)
      const rowMatch = numQ.length > 0 && String(t.row_id) === numQ;

      // Text matches
      const partMatch = t.particulars && t.particulars.toLowerCase().includes(rawQ);
      const dateMatch = t.date && t.date.toLowerCase().includes(rawQ);
      const infoMatch = t.additional_info && t.additional_info.toLowerCase().includes(rawQ);

      return amtMatch || rowMatch || partMatch || dateMatch || infoMatch;
    });
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
        chipHtml = `<span class="tx-chip chip-raw-url" title="Raw URL: click to update">🔴 Raw Link</span>`;
      } else {
        chipHtml = `<span class="tx-chip chip-has-proof" title="${t.proof_value || ''}">🟢 Proof Attached</span>`;
      }
    } else {
      chipHtml = `<span class="tx-chip chip-needs-proof">🟡 Needs Proof</span>`;
    }

    item.innerHTML = `
      <div class="tx-target-pill">${isSelected ? '🎯' : '○'}</div>
      <div class="tx-info">
        <div class="tx-row-top">
          <span class="tx-particulars">${t.particulars || 'Untitled'}</span>
          <span class="tx-amount">₹${t.amount || '0'}</span>
        </div>
        <div class="tx-row-sub">
          <span>Row #${t.row_id} • ${t.date}</span>
          ${chipHtml}
        </div>
        ${t.additional_info ? `<div class="tx-extra-notes">${t.additional_info}</div>` : ''}
      </div>
    `;
    txList.appendChild(item);
  });

  updateSelectedBanner();
}

function updateSelectedBanner() {
  if (!selectedTxBanner) return;

  if (state.selectedRowId) {
    const selectedTx = state.transactions.find(t => t.row_id === state.selectedRowId);
    if (!selectedTx) {
      state.selectedRowId = null;
      updateSelectedBanner();
      return;
    }

    selectedTxBanner.classList.remove('hidden');
    selectedTxBanner.className = 'selected-tx-banner is-targeted' + (selectedTx.has_proof ? ' has-proof' : '');

    let aiNote = state.aiActive
      ? `🤖 <strong>AI Context:</strong> Gemini will cross-examine your receipt against this row, check for extra labour / partial refunds, and format the audit filename.`
      : `⚡ <strong>Direct Link:</strong> Receipt will link directly to Row #${selectedTx.row_id} without AI call.`;

    if (selectedTx.has_proof) {
      aiNote += `<br><span style="font-size:10px; color:#fde68a;">⚠️ Existing proof attached. Uploading will merge into an updated film roll.</span>`;
    }

    selectedTxBanner.innerHTML = `
      <div class="selected-tx-content">
        <div>🎯 <strong>Target Row #${selectedTx.row_id}:</strong> ${selectedTx.particulars || 'Untitled'} (₹${selectedTx.amount || 0} on ${selectedTx.date || ''})</div>
        <div style="font-size:10px; margin-top:2px;">${aiNote}</div>
      </div>
      <button type="button" class="btn-clear-target" onclick="clearTargetSelection()">✕ Auto-Match</button>
    `;
  } else {
    selectedTxBanner.classList.remove('hidden');
    selectedTxBanner.className = 'selected-tx-banner';
    if (state.aiActive) {
      selectedTxBanner.innerHTML = `
        <span>🤖 <strong>AI Auto-Match Mode:</strong> Gemini AI will scan your receipt and match it to the correct row in Google Sheets. (Or tap any transaction below to target it explicitly).</span>
      `;
    } else {
      selectedTxBanner.innerHTML = `
        <span>⚠️ <strong>Direct Link Mode:</strong> Please tap a transaction below to select which row to attach your proof to, or turn ON Gemini AI above.</span>
      `;
    }
  }
}

window.clearTargetSelection = function() {
  state.selectedRowId = null;
  state.stagedFiles = state.stagedFiles.filter(f => !f.isExistingProof);
  renderStagedList();
  renderTransactionList();
  updateSelectedBanner();
  updateProcessButtonState();
};

async function selectTransaction(rowId) {
  if (state.selectedRowId === rowId) {
    state.selectedRowId = null;
    state.stagedFiles = state.stagedFiles.filter(f => !f.isExistingProof);
    renderStagedList();
  } else {
    state.selectedRowId = rowId;
    const tx = state.transactions.find(t => t.row_id === rowId);
    if (tx && tx.has_proof) {
      state.stagedFiles = state.stagedFiles.filter(f => !f.isExistingProof);
      addDebugLog(`🔍 Row #${rowId} has an existing proof in Sheet. Loading it for merged film roll...`, 'info');
      showToast(`📥 Loading existing proof from Row #${rowId} to merge...`, 3000);
      try {
        const backendUrl = getBackendUrl();
        const resp = await fetch(`${backendUrl}?action=get_proof_image&row_id=${rowId}`);
        const data = await resp.json();
        if (data && data.success && data.data_url) {
          const proofFile = dataURLtoFile(data.data_url, data.file_name || 'Existing_Proof.jpg');
          state.stagedFiles.push({
            id: 'existing-proof-' + rowId,
            file: proofFile,
            name: data.file_name || 'Existing Payment Proof.jpg',
            dataUrl: data.data_url,
            category: 'UPI_SCREENSHOT',
            isExistingProof: true,
            sourceRowId: rowId
          });
          renderStagedList();
          addDebugLog(`✅ Existing proof loaded as Card #2! Both will be stitched into a unified film roll.`, 'success');
          showToast(`✅ Existing proof loaded! Both will be merged into a single film roll.`, 4000);
        }
      } catch (e) {
        addDebugLog(`Notice: Could not load existing proof: ${e.message}`, 'warning');
      }
    } else {
      state.stagedFiles = state.stagedFiles.filter(f => !f.isExistingProof);
      renderStagedList();
    }
  }
  renderTransactionList();
  updateSelectedBanner();
  updateProcessButtonState();
}

if (aiModeToggle) {
  aiModeToggle.addEventListener('change', (e) => {
    state.aiActive = e.target.checked;
    if (aiToggleSub) {
      aiToggleSub.textContent = state.aiActive
        ? "Active: Uses AI to cross-check receipts against sheet and auto-format audit filenames"
        : "Disabled: Fast direct link mode without calling Gemini AI";
    }
    updateSelectedBanner();
  });
}

// Filter Tab Click Handlers
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeFilter = btn.getAttribute('data-filter') || 'all';
    renderTransactionList();
  });
});

// Search Input Listener
txSearch.addEventListener('input', (e) => {
  state.searchTerm = e.target.value;
  if (btnClearSearch) {
    btnClearSearch.classList.toggle('hidden', !state.searchTerm);
  }
  renderTransactionList();
});

if (btnClearSearch) {
  btnClearSearch.addEventListener('click', () => {
    txSearch.value = '';
    state.searchTerm = '';
    btnClearSearch.classList.add('hidden');
    renderTransactionList();
  });
}

btnRefresh.addEventListener('click', async () => {
  showToast('Refreshing sheet records...');
  await loadTransactions();
});

// ============================================================================
// 6. Action Processing & 24/7 Cloud Linking
// ============================================================================
function updateProcessButtonState() {
  btnProcess.disabled = state.stagedFiles.length === 0 || state.isProcessing;
}

btnProcess.addEventListener('click', async () => {
  if (state.stagedFiles.length === 0 || state.isProcessing) return;

  if (!state.aiActive && !state.selectedRowId) {
    showToast('⚠️ Please tap a row to link, or enable Gemini AI above!', 4000, true);
    return;
  }

  state.isProcessing = true;
  updateProcessButtonState();
  processLog.classList.remove('hidden');
  const enteredNotes = userNotes.value.trim();
  addDebugLog(`📝 User Notes included: ${enteredNotes ? ('"' + enteredNotes + '"') : '(None)'}`, 'info');
  logText.textContent = '1/4 Assembling vertical film roll...';

  try {
    const collageBlob = await renderCollageOnCanvas();

    logText.textContent = state.aiActive 
      ? '2/4 Analyzing with Gemini AI...' 
      : '2/4 Linking proof directly to row...';

    const backendUrl = getBackendUrl();
    const isGAS = backendUrl.includes("script.google.com");
    let result;

    if (isGAS) {
      // Google Apps Script 24/7 Engine
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
        stitchedImageBase64: stitchedBase64,
        userInstructions: userNotes.value.trim(),
        tickedRowId: state.selectedRowId || null,
        fileNames: state.stagedFiles.map(f => f.name),
        useAi: state.aiActive
      };

      logText.textContent = '3/4 Uploading to Google Drive & updating sheet...';

      const resp = await fetch(backendUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      result = await resp.json();
    } else {
      // Local Flask Fallback
      const formData = new FormData();
      formData.append("count", state.stagedFiles.length);
      formData.append("user_notes", userNotes.value.trim());
      formData.append("ticked_row_id", state.selectedRowId || "");
      formData.append("use_ai", state.aiActive ? "true" : "false");

      state.stagedFiles.forEach((item, idx) => {
        formData.append(`file_${idx}`, item.file);
        formData.append(`category_${idx}`, item.category);
      });

      logText.textContent = '3/4 Uploading to Google Drive & updating sheet...';

      const resp = await fetch("/api/process", {
        method: "POST",
        body: formData
      });
      result = await resp.json();
    }

    if (result && result.needs_client_merge) {
      logText.textContent = `✨ Auto-merging with existing proof on Row #${result.matched_row_id}...`;
      addDebugLog(`📥 Row #${result.matched_row_id} has existing payment proof in Sheet. Auto-stitching composite film roll...`, 'info');

      const existingProofFile = dataURLtoFile(result.existing_proof_b64, result.existing_proof_name || 'Existing_Proof.jpg');
      state.stagedFiles.push({
        id: 'existing-proof-' + result.matched_row_id,
        file: existingProofFile,
        name: result.existing_proof_name || 'Existing Payment Proof.jpg',
        dataUrl: result.existing_proof_b64,
        category: 'UPI_SCREENSHOT',
        isExistingProof: true,
        sourceRowId: result.matched_row_id
      });
      renderStagedList();

      const mergedCollageBlob = await renderCollageOnCanvas();
      const mergedDataUrl = await readFileAsDataURL(mergedCollageBlob);
      const mergedBase64 = mergedDataUrl.split(',')[1];

      logText.textContent = '3/4 Uploading merged film roll to Google Drive & updating sheet...';
      const mergePayload = {
        action: "process_and_link",
        stitchedImageBase64: mergedBase64,
        stitchedMime: "image/jpeg",
        tickedRowId: result.matched_row_id,
        skipMergeHandshake: true,
        fileName: result.suggested_filename,
        userInstructions: userNotes.value.trim(),
        useAi: false
      };

      const mergeResp = await fetch(backendUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(mergePayload)
      });
      result = await mergeResp.json();
    }

    logText.textContent = '4/4 Finalizing records...';

    if (result && result.success) {
      if (result.pending) {
        showToast('📦 Saved to Pending Backlog (no matching row found in sheet)', 6000);
        addDebugLog('📦 Server saved proof to Pending Backlog (no matching row found in sheet)', 'warning');
      } else {
        const rowId = result.matched_row_id;
        showToast(`✅ Linked to Row ${rowId}! Drive proof uploaded.`, 6000);
        addDebugLog(`✅ Successfully linked proof to Row #${rowId}! File: ${result.file_name}`, 'success');
      }

      if (result.gemini_model && result.gemini_model !== 'none') {
        addDebugLog(`Gemini AI Model used: ${result.gemini_model}`, 'info');
      }
      if (result.gemini_error) {
        addDebugLog(`Gemini Notice: ${result.gemini_error}`, 'warning');
      }

      dismissErrorBanner();

      // Clear staged photos upon successful upload
      await clearStagedSession();
      userNotes.value = '';
      state.selectedRowId = null;

      // Refresh data
      await loadTransactions();
      await loadPendingBacklog();
    } else {
      const errDetail = (result && (result.error || result.message)) || 'Server processing error';
      addDebugLog(`❌ Server returned failure: ${errDetail}`, 'error');
      throw new Error(errDetail);
    }

  } catch (err) {
    console.error('Process error:', err);
    addDebugLog(`❌ Process error: ${err.message}`, 'error');
    showErrorBanner(err.message);
    showToast(`❌ ${err.message}`, 8000, true);
  } finally {
    state.isProcessing = false;
    updateProcessButtonState();
    processLog.classList.add('hidden');
  }
});

function showErrorBanner(msg) {
  if (!errorBanner) return;
  errorBanner.classList.remove('hidden');

  const lower = String(msg).toLowerCase();
  if (lower.includes('drive') || lower.includes('permission')) {
    errorBannerText.innerHTML = `
      <strong>Google Drive Authorization Required:</strong><br>
      Google Apps Script requires one-time permission to create folders and save receipt images in your Google Drive.
      <br><br>
      <strong>Quick Fix (10 seconds):</strong><br>
      1. Open your <a href="https://docs.google.com/spreadsheets/d/1cuCEboha8hScEnzrfSbQlAjeKbxVi-2uKDos8Bz1Hu8/edit" target="_blank" style="color:#38bdf8; text-decoration:underline; font-weight:700;">Google Sheet</a> on desktop or phone.<br>
      2. In the top navigation menu, click <strong>🤖 AI Agent Context</strong> ➔ <strong>📂 Authorize Google Drive & PWA Access</strong>.<br>
      3. Click <strong>OK / Allow</strong> on the Google permission popup.<br>
      4. Return here and tap <strong>Retry Now</strong> below!
    `;
    errorBannerActions.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" onclick="retryProcess()">🔄 Retry Now</button>
      <button type="button" class="btn btn-secondary btn-sm" onclick="dismissErrorBanner()">Dismiss</button>
    `;
  } else {
    errorBannerText.textContent = msg;
    errorBannerActions.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" onclick="retryProcess()">🔄 Retry Now</button>
      <button type="button" class="btn btn-secondary btn-sm" onclick="dismissErrorBanner()">Dismiss</button>
    `;
  }
}

window.dismissErrorBanner = function() {
  if (errorBanner) errorBanner.classList.add('hidden');
};

window.retryProcess = function() {
  window.dismissErrorBanner();
  btnProcess.click();
};

if (btnCloseError) {
  btnCloseError.addEventListener('click', window.dismissErrorBanner);
}

// ============================================================================
// 7. Pending Backlog Management
// ============================================================================
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
      renderPendingBacklog(data.pending);
    }
  } catch (err) {
    console.warn('Backlog load note:', err);
  }
}

function renderPendingBacklog(items) {
  backlogCount.textContent = items.length;
  if (items.length === 0) {
    backlogList.innerHTML = '<p class="empty-text">No pending receipts.</p>';
    return;
  }

  backlogList.innerHTML = '';
  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'backlog-item';
    el.innerHTML = `
      <div class="backlog-meta">
        <strong>${item.file_name || 'Receipt'}</strong>
        <span class="backlog-sub">₹${item.amount || 'Unknown'} • ${item.date || 'Pending'}</span>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="reconcileBacklogItem('${item.id}')">Link</button>
    `;
    backlogList.appendChild(el);
  });
}

backlogHeader.addEventListener('click', () => {
  backlogBody.classList.toggle('hidden');
  document.getElementById('backlog-chevron').textContent = backlogBody.classList.contains('hidden') ? '▼' : '▲';
});

btnClearBacklog.addEventListener('click', async () => {
  showToast('Reconciling backlog items with Google Sheet...');
  const backendUrl = getBackendUrl();
  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "clear_backlog" })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`⚡ ${data.message || 'Backlog reconciled successfully!'}`);
      await loadTransactions();
      await loadPendingBacklog();
    }
  } catch (err) {
    showToast('Failed to reconcile backlog.');
  }
});

// ============================================================================
// 8. Settings Modal (Cloud URL Configuration)
// ============================================================================
btnSettings.addEventListener('click', () => {
  backendUrlInput.value = getBackendUrl();
  settingsModal.classList.remove('hidden');
});

btnCloseSettings.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

btnSaveSettings.addEventListener('click', () => {
  const newUrl = backendUrlInput.value.trim();
  setBackendUrl(newUrl);
  settingsModal.classList.add('hidden');
  showToast('Settings saved. Refreshing sync...');
  loadTransactions();
});

btnResetSettings.addEventListener('click', () => {
  setBackendUrl(DEFAULT_GAS_URL);
  backendUrlInput.value = DEFAULT_GAS_URL;
  settingsModal.classList.add('hidden');
  showToast('Reset to default Cloud Engine.');
  loadTransactions();
});

// ============================================================================
// 9. Toast Notification Helper
// ============================================================================
function showToast(message, duration = 3000, isError = false) {
  toastEl.textContent = message;
  toastEl.className = isError ? 'toast toast-error show' : 'toast toast-success show';
  toastEl.classList.remove('hidden');
  setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => toastEl.classList.add('hidden'), 300);
  }, duration);
}

// ============================================================================
// 10. Live Diagnostics & Debug Console
// ============================================================================
const debugHeader = document.getElementById('debug-header');
const debugBody = document.getElementById('debug-body');
const debugChevron = document.getElementById('debug-chevron');
const debugConsole = document.getElementById('debug-console');
const debugStatusBadge = document.getElementById('debug-status-badge');
const btnCopyDebugLog = document.getElementById('btn-copy-debug-log');
const btnClearDebugLog = document.getElementById('btn-clear-debug-log');

function addDebugLog(msg, type = 'info') {
  if (!debugConsole) return;
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const line = document.createElement('div');
  line.className = `debug-line ${type}`;
  line.textContent = `[${timeStr}] ${msg}`;
  debugConsole.appendChild(line);
  debugConsole.scrollTop = debugConsole.scrollHeight;

  if (debugStatusBadge) {
    if (type === 'error') {
      debugStatusBadge.textContent = 'Error';
      debugStatusBadge.style.background = '#ef4444';
      if (debugBody && debugBody.classList.contains('hidden')) {
        debugBody.classList.remove('hidden');
        if (debugChevron) debugChevron.textContent = '▲';
      }
    } else if (type === 'success') {
      debugStatusBadge.textContent = 'Success';
      debugStatusBadge.style.background = '#10b981';
    }
  }
}

if (debugHeader) {
  debugHeader.addEventListener('click', () => {
    debugBody.classList.toggle('hidden');
    debugChevron.textContent = debugBody.classList.contains('hidden') ? '▼' : '▲';
  });
}

if (btnCopyDebugLog) {
  btnCopyDebugLog.addEventListener('click', () => {
    const text = Array.from(debugConsole.querySelectorAll('.debug-line'))
      .map(el => el.textContent)
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 Debug log copied to clipboard!');
    }).catch(() => {
      showToast('Log copied (fallback)');
    });
  });
}

if (btnClearDebugLog) {
  btnClearDebugLog.addEventListener('click', () => {
    debugConsole.innerHTML = '<div class="debug-line info">[System] Log cleared. Ready.</div>';
    if (debugStatusBadge) {
      debugStatusBadge.textContent = 'Ready';
      debugStatusBadge.style.background = '';
    }
  });
}

// Start application
window.addEventListener('DOMContentLoaded', initApp);
