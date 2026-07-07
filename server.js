const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 4600;

// ── Directory setup ──────────────────────────────────────────────
const UPLOADS = path.join(__dirname, 'uploads');
const CONVERTED = path.join(__dirname, 'converted');
const DATA = path.join(__dirname, 'data');

[UPLOADS, CONVERTED, DATA].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── History persistence ──────────────────────────────────────────
const HISTORY_PATH = path.join(DATA, 'history.json');

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH))
      return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch { /* ignore corrupt file */ }
  return [];
}

function saveHistory(h) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2));
}

let history = loadHistory();

// ── Queue engine ─────────────────────────────────────────────────
let queue = [];
let processing = false;

/** Convert a CSV file to TSV. Emit the TSV to disk. */
function convertCsvToTsv(csvPath, tsvPath) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const records = parse(content, {
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: false,
  });
  const tsv = records.map(row => row.join('\t')).join('\n');
  fs.writeFileSync(tsvPath, tsv, 'utf8');
}

async function processNext() {
  if (processing || queue.length === 0) return;

  processing = true;
  const jobId = queue[0];
  const item = history.find(h => h.id === jobId);

  if (!item) {
    queue.shift();
    processing = false;
    return processNext();
  }

  item.status = 'processing';
  item.startedAt = new Date().toISOString();
  saveHistory(history);

  // Small artificial delay so the UI can show the "processing" state visibly
  await new Promise(r => setTimeout(r, 600));

  try {
    const csvPath = path.join(UPLOADS, jobId + '.csv');
    const tsvPath = path.join(CONVERTED, jobId + '.tsv');

    if (!fs.existsSync(csvPath)) throw new Error('File CSV non trovato.');

    convertCsvToTsv(csvPath, tsvPath);

    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    item.fileSize = fs.statSync(tsvPath).size;
    saveHistory(history);
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
    saveHistory(history);
  }

  queue.shift();
  processing = false;
  processNext();
}

function enqueue(jobId) {
  queue.push(jobId);
  processNext();
}

// ── Multer ───────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    if (!req._jobs) req._jobs = [];
    req._jobs.push({
      id,
      originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      size: 0,
    });
    cb(null, id + '.csv');
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const isCsv =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.toLowerCase().endsWith('.csv');
    cb(isCsv ? null : new Error('Solo file CSV (.csv) sono accettati.'), isCsv);
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Static files ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API ──────────────────────────────────────────────────────────

// POST /api/upload  — carica CSV e metti in coda
app.post('/api/upload', (req, res) => {
  upload.array('files', 50)(req, res, err => {
    if (err) {
      const code = err instanceof multer.MulterError ? 400 : 400;
      return res.status(code).json({ error: err.message });
    }

    const jobs = req._jobs || [];
    if (jobs.length === 0)
      return res.status(400).json({ error: 'Nessun file ricevuto.' });

    // Update sizes from disk
    for (const job of jobs) {
      const p = path.join(UPLOADS, job.id + '.csv');
      if (fs.existsSync(p)) job.size = fs.statSync(p).size;
    }

    const now = new Date().toISOString();
    const entries = jobs.map(j => ({
      id: j.id,
      originalName: j.originalName,
      size: j.size,
      status: 'queued',
      createdAt: now,
    }));

    history.push(...entries);
    saveHistory(history);
    jobs.forEach(j => enqueue(j.id));

    res.json({
      message:
        jobs.length === 1
          ? '1 file caricato e in coda.'
          : `${jobs.length} file caricati e in coda.`,
      jobs: entries,
    });
  });
});

// GET /api/queue  — stato coda e cronologia
app.get('/api/queue', (_req, res) => {
  const sorted = [...history].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
  res.json({ history: sorted, queueLength: queue.length, processing });
});

// GET /api/download/:id  — scarica singolo TSV
app.get('/api/download/:id', (req, res) => {
  const item = history.find(h => h.id === req.params.id);
  if (!item || item.status !== 'completed')
    return res.status(404).json({ error: 'File non completato o non trovato.' });

  const tsvPath = path.join(CONVERTED, item.id + '.tsv');
  if (!fs.existsSync(tsvPath))
    return res.status(404).json({ error: 'File TSV non presente su disco.' });

  const name = item.originalName.replace(/\.csv$/i, '.tsv');
  res.download(tsvPath, name);
});

// GET /api/download-all  — archivio ZIP di tutti i TSV completati
app.get('/api/download-all', (_req, res) => {
  const done = history.filter(h => h.status === 'completed');
  if (done.length === 0)
    return res.status(404).json({ error: 'Nessun file completato da scaricare.' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="tsv-convertiti.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => res.status(500).end());
  archive.pipe(res);

  for (const item of done) {
    const tsvPath = path.join(CONVERTED, item.id + '.tsv');
    if (fs.existsSync(tsvPath)) {
      archive.file(tsvPath, { name: item.originalName.replace(/\.csv$/i, '.tsv') });
    }
  }

  archive.finalize();
});

// POST /api/clear  — cancella cronologia e file
app.post('/api/clear', (_req, res) => {
  history = [];
  queue = [];
  processing = false;
  saveHistory(history);
  [UPLOADS, CONVERTED].forEach(dir => {
    if (fs.existsSync(dir))
      fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
  });
  res.json({ message: 'Cronologia cancellata.' });
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 DataFlow attivo su http://0.0.0.0:${PORT}`);

  // Ripristina elementi rimasti in sospeso al riavvio
  const lingering = history.filter(
    h => h.status === 'queued' || h.status === 'processing',
  );
  for (const item of lingering) {
    item.status = 'queued';
    queue.push(item.id);
  }
  saveHistory(history);
  if (queue.length > 0) processNext();
});
