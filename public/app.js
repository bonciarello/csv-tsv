/* DataFlow — Frontend logic
   Gestisce upload, polling della coda, rendering file, download. */

const $ = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

// ── DOM refs ────────────────────────────────────────────────────
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const uploadForm = $('#uploadForm');
const uploadBtn = $('#uploadBtn');
const uploadError = $('#uploadError');
const selectedFiles = $('#selectedFiles');
const headerStatus = $('#headerStatus');
const pipelineSection = $('#pipelineSection');
const countQueued = $('#countQueued');
const countProcessing = $('#countProcessing');
const countCompleted = $('#countCompleted');
const historySection = $('#historySection');
const fileList = $('#fileList');
const downloadAllBtn = $('#downloadAllBtn');
const clearBtn = $('#clearBtn');

let selectedFileList = []; // File objects selected by the user
let pollingTimer = null;

// ── Format helpers ──────────────────────────────────────────────
function fmtSize(bytes) {
  if (!bytes || bytes === 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) +
    ' · ' + d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

// ── Upload zone ─────────────────────────────────────────────────
dropzone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  selectedFileList = [...fileInput.files];
  renderSelectedFiles();
  updateUploadButton();
});

dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const files = [...e.dataTransfer.files].filter(f =>
    f.name.toLowerCase().endsWith('.csv'),
  );
  if (files.length === 0) return;

  // Merge with existing selection (not native input, so we replace)
  selectedFileList = files;
  // Update the file input so form submission works
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  fileInput.files = dt.files;

  renderSelectedFiles();
  updateUploadButton();
});

function renderSelectedFiles() {
  if (selectedFileList.length === 0) {
    selectedFiles.innerHTML = '';
    return;
  }
  selectedFiles.innerHTML = selectedFileList
    .map(
      (f, i) => `
    <span class="file-chip">
      <span class="file-chip-name" title="${escAttr(f.name)}">${escHtml(f.name)}</span>
      <span style="font-size:.6875rem;color:var(--color-text-muted);white-space:nowrap">${fmtSize(f.size)}</span>
      <button type="button" class="file-chip-remove" data-idx="${i}" aria-label="Rimuovi ${escAttr(f.name)}">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </span>`,
    )
    .join('');

  // Remove handlers
  $$('.file-chip-remove', selectedFiles).forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      selectedFileList.splice(idx, 1);
      // Rebuild DataTransfer
      const dt = new DataTransfer();
      selectedFileList.forEach(f => dt.items.add(f));
      fileInput.files = dt.files;
      renderSelectedFiles();
      updateUploadButton();
    });
  });
}

function updateUploadButton() {
  uploadBtn.disabled = selectedFileList.length === 0;
  uploadError.textContent = '';
}

// ── Form submit ─────────────────────────────────────────────────
uploadForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (selectedFileList.length === 0) return;

  uploadBtn.disabled = true;
  uploadBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" class="spin">
      <circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" stroke-dasharray="10 30" stroke-linecap="round"/>
    </svg>
    <span>Caricamento…</span>`;
  uploadError.textContent = '';

  const formData = new FormData();
  selectedFileList.forEach(f => formData.append('files', f));

  try {
    const resp = await fetch('api/upload', { method: 'POST', body: formData });
    const data = await resp.json();

    if (!resp.ok) {
      uploadError.textContent = data.error || 'Errore durante il caricamento.';
      resetUploadButton();
      return;
    }

    // Clear selection
    selectedFileList = [];
    fileInput.value = '';
    renderSelectedFiles();
    updateUploadButton();

    // Start polling
    startPolling();

  } catch (err) {
    uploadError.textContent = 'Errore di rete. Riprova.';
    resetUploadButton();
  }
});

function resetUploadButton() {
  uploadBtn.disabled = selectedFileList.length === 0;
  uploadBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 3v9M5 8l4-5 4 5M3 14h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span>Carica e converti</span>`;
}

// ── Polling ─────────────────────────────────────────────────────
function startPolling() {
  if (pollingTimer) return;
  poll();
  pollingTimer = setInterval(poll, 1500);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function poll() {
  try {
    const resp = await fetch('api/queue');
    if (!resp.ok) return;
    const data = await resp.json();
    renderAll(data);
  } catch {
    // Silently ignore polling errors
  }
}

// ── Render ──────────────────────────────────────────────────────
function renderAll(data) {
  const { history, queueLength, processing } = data;

  if (!history || history.length === 0) {
    pipelineSection.hidden = true;
    historySection.hidden = true;
    headerStatus.querySelector('.status-dot').classList.remove('busy');
    headerStatus.querySelector('.status-label').textContent = 'Pronto';
    return;
  }

  pipelineSection.hidden = false;
  historySection.hidden = false;

  // Counts
  const queued = history.filter(h => h.status === 'queued').length;
  const proc = history.filter(h => h.status === 'processing').length;
  const done = history.filter(h => h.status === 'completed').length;

  countQueued.textContent = queued;
  countProcessing.textContent = proc;
  countCompleted.textContent = done;

  // Header status
  const dot = headerStatus.querySelector('.status-dot');
  const label = headerStatus.querySelector('.status-label');
  if (processing || proc > 0) {
    dot.classList.add('busy');
    label.textContent = 'Elaborazione in corso…';
  } else if (queued > 0) {
    dot.classList.add('busy');
    label.textContent = `${queued} file in coda`;
  } else {
    dot.classList.remove('busy');
    label.textContent = done > 0 ? `${done} file completati` : 'Pronto';
  }

  // Download all button
  downloadAllBtn.hidden = done === 0;

  // File list
  renderFileList(history);
}

function renderFileList(history) {
  fileList.innerHTML = history
    .map(item => {
      const status = item.status;
      const name = escHtml(item.originalName);
      const badge =
        status === 'queued'
          ? '<span class="file-row-badge badge-queued">In coda</span>'
          : status === 'processing'
            ? '<span class="file-row-badge badge-processing">In elaborazione</span>'
            : status === 'completed'
              ? '<span class="file-row-badge badge-completed">Completato</span>'
              : '<span class="file-row-badge badge-error">Errore</span>';

      const meta = [];
      meta.push(fmtSize(item.size));
      if (item.createdAt) meta.push(fmtTime(item.createdAt));
      if (item.completedAt && status === 'completed')
        meta.push('Completato alle ' + fmtTime(item.completedAt));

      let actions = '';
      if (status === 'completed') {
        actions = `
        <a href="api/download/${item.id}" class="btn btn-primary btn-sm" download>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 2v7M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Scarica TSV
        </a>`;
      }

      let errorMsg = '';
      if (status === 'error' && item.error) {
        errorMsg = `<span class="file-row-error">${escHtml(item.error)}</span>`;
      }

      return `
      <div class="file-row" role="listitem">
        <span class="file-row-status ${status}" aria-label="${status}"></span>
        <div class="file-row-info">
          <div class="file-row-name" title="${escAttr(item.originalName)}">${name}</div>
          <div class="file-row-meta">
            ${badge}
            ${meta.map(m => `<span>${m}</span>`).join('')}
            ${errorMsg}
          </div>
        </div>
        <div class="file-row-actions">${actions}</div>
      </div>`;
    })
    .join('');
}

// ── Download all ────────────────────────────────────────────────
downloadAllBtn.addEventListener('click', () => {
  window.location.href = 'api/download-all';
});

// ── Clear ───────────────────────────────────────────────────────
clearBtn.addEventListener('click', async () => {
  if (!confirm('Cancellare tutta la cronologia e i file convertiti? Questa azione non è reversibile.'))
    return;

  try {
    await fetch('api/clear', { method: 'POST' });
    stopPolling();
    pipelineSection.hidden = true;
    historySection.hidden = true;
    fileList.innerHTML = '';
    headerStatus.querySelector('.status-dot').classList.remove('busy');
    headerStatus.querySelector('.status-label').textContent = 'Pronto';
  } catch {
    // ignore
  }
});

// ── Escape helpers ──────────────────────────────────────────────
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Initial load ────────────────────────────────────────────────
// Load history on page open
(async function init() {
  try {
    const resp = await fetch('api/queue');
    if (resp.ok) {
      const data = await resp.json();
      if (data.history && data.history.length > 0) {
        renderAll(data);
        // Start polling if there are pending items
        const hasPending = data.history.some(h => h.status === 'queued' || h.status === 'processing');
        if (hasPending) startPolling();
      }
    }
  } catch { /* ignore */ }
})();

// ── Spinner animation ───────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin .8s linear infinite; transform-origin: center; }
`;
document.head.appendChild(style);
