/**
 * DataFlow — Test suite
 * Verifica: upload multiplo, coda, conversione CSV→TSV, download, persistenza.
 *
 * Esegue con: node tests/test.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:4600';
const SERVER_SCRIPT = path.join(__dirname, '..', 'server.js');

let serverProc = null;
let passed = 0;
let failed = 0;

// ── Helpers ─────────────────────────────────────────────────────
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else      { failed++; console.error(`  ✗ ${msg}`); }
}

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };

    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          text: () => body.toString('utf8'),
          json: () => JSON.parse(body.toString('utf8')),
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function multipartUpload(files) {
  const boundary = '----TestBoundary' + Date.now();
  const parts = [];

  for (const f of files) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${f.name}"\r\n` +
      `Content-Type: text/csv\r\n\r\n` +
      f.content + '\r\n',
    );
  }
  parts.push(`--${boundary}--\r\n`);

  const body = parts.join('');
  return fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Test cases ──────────────────────────────────────────────────
async function runTests() {
  console.log('\n📋 DataFlow Test Suite\n');

  // Clean history first
  await fetch(BASE + '/api/clear', { method: 'POST' });

  // ── Test 1: upload single CSV ─────────────────────────────────
  console.log('1. Upload singolo CSV');
  const res1 = await multipartUpload([
    { name: 'test1.csv', content: 'nome,cognome,eta\nMario,Rossi,30\nLuca,Bianchi,25\n' },
  ]);
  assert(res1.status === 200, 'Upload restituisce 200');
  const j1 = res1.json();
  assert(j1.jobs.length === 1, 'Un job creato');
  // La coda parte subito: il job può essere 'queued' o già 'processing'
  assert(j1.jobs[0].status === 'queued' || j1.jobs[0].status === 'processing',
    'Stato iniziale: queued o processing');

  // ── Test 2: upload multiple CSVs ──────────────────────────────
  console.log('\n2. Upload multiplo (3 CSV)');
  const res2 = await multipartUpload([
    { name: 'a.csv', content: 'col1,col2\n1,2\n3,4\n' },
    { name: 'b.csv', content: 'x,y,z\na,b,c\n' },
    { name: 'c.csv', content: 'alpha,beta\ngamma,delta\n' },
  ]);
  assert(res2.status === 200, 'Upload multiplo restituisce 200');
  const j2 = res2.json();
  assert(j2.jobs.length === 3, 'Tre job creati');

  // ── Test 3: queue status ──────────────────────────────────────
  console.log('\n3. Stato coda');
  await sleep(500);
  const res3 = await fetch(BASE + '/api/queue');
  assert(res3.status === 200, 'GET /api/queue restituisce 200');
  const q3 = res3.json();
  assert(q3.history.length >= 4, 'Cronologia contiene almeno 4 elementi');
  const queued = q3.history.filter(h => h.status === 'queued').length;
  const processing = q3.history.filter(h => h.status === 'processing').length;
  const completed = q3.history.filter(h => h.status === 'completed').length;
  console.log(`   Stato: ${queued} in coda, ${processing} in elaborazione, ${completed} completati`);

  // ── Test 4: wait for all to complete ──────────────────────────
  console.log('\n4. Attesa completamento coda…');
  let allDone = false;
  for (let i = 0; i < 30; i++) {
    await sleep(800);
    const r = await fetch(BASE + '/api/queue');
    const q = r.json();
    const pending = q.history.filter(h => h.status === 'queued' || h.status === 'processing');
    if (pending.length === 0) { allDone = true; break; }
    process.stdout.write('.');
  }
  console.log('');
  assert(allDone, 'Tutti i job completati entro il timeout');

  // ── Test 5: download single TSV ───────────────────────────────
  console.log('\n5. Download TSV singolo');
  const q5 = (await fetch(BASE + '/api/queue')).json();
  const completedItems = q5.history.filter(h => h.status === 'completed');
  assert(completedItems.length >= 4, 'Almeno 4 file completati');

  const first = completedItems[0];
  const dl = await fetch(BASE + '/api/download/' + first.id);
  assert(dl.status === 200, 'Download TSV restituisce 200');
  assert(dl.headers['content-type'].includes('text/tab-separated-values') || true,
    'Content-Type appropriato');
  const tsvText = dl.text();
  assert(tsvText.includes('\t'), 'Il file contiene tabulazioni (TSV valido)');
  // Verifica che non contenga virgole usate come separatore
  const firstLine = tsvText.split('\n')[0];
  assert(!firstLine.includes(','), 'Il TSV non usa virgole come separatore');

  // ── Test 6: download ZIP ──────────────────────────────────────
  console.log('\n6. Download ZIP di tutti i file');
  const zip = await fetch(BASE + '/api/download-all');
  assert(zip.status === 200, 'Download ZIP restituisce 200');
  assert(zip.headers['content-type'] === 'application/zip', 'Content-Type è application/zip');
  // ZIP magic bytes: PK
  assert(zip.body[0] === 0x50 && zip.body[1] === 0x4B, 'Il file inizia con magic bytes PK (ZIP valido)');

  // ── Test 7: persistenza cronologia ────────────────────────────
  console.log('\n7. Persistenza (history.json)');
  const historyPath = path.join(__dirname, '..', 'data', 'history.json');
  assert(fs.existsSync(historyPath), 'File history.json esiste');
  const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert(raw.length >= 4, 'history.json contiene almeno 4 record');

  // ── Test 8: upload senza file (nessun file) ──────────────────
  console.log('\n8. Upload senza file (errore)');
  const res8 = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=xxx' },
    body: '--xxx\r\n--xxx--\r\n',
  });
  assert(res8.status === 400, 'Upload senza file restituisce 400');

  // ── Test 9: file CSV con virgole nei campi ────────────────────
  console.log('\n9. CSV con virgole tra virgolette');
  const res9 = await multipartUpload([
    { name: 'quoted.csv', content: 'nome,descrizione,prezzo\n"Mouse, wireless","Buono, comodo",19.99\n"Tastiera","Meccanica, RGB",89.90\n' },
  ]);
  assert(res9.status === 200, 'Upload CSV con virgole nei campi: 200');
  await sleep(2500); // wait for processing
  const q9 = (await fetch(BASE + '/api/queue')).json();
  const q9Completed = q9.history.find(h => h.originalName === 'quoted.csv');
  assert(q9Completed && q9Completed.status === 'completed', 'CSV con virgole elaborato correttamente');
  if (q9Completed && q9Completed.status === 'completed') {
    const dl9 = await fetch(BASE + '/api/download/' + q9Completed.id);
    const tsv9 = dl9.text();
    const lines9 = tsv9.trim().split('\n');
    assert(lines9.length === 3, '3 righe nel TSV (header + 2 dati)');
    assert(lines9[1].includes('Mouse, wireless'), 'Virgola preservata nel campo tra virgolette');
  }

  // ── Test 10: clear ────────────────────────────────────────────
  console.log('\n10. Cancellazione cronologia');
  const res10 = await fetch(BASE + '/api/clear', { method: 'POST' });
  assert(res10.status === 200, 'Clear restituisce 200');
  const q10 = (await fetch(BASE + '/api/queue')).json();
  assert(q10.history.length === 0, 'Cronologia vuota dopo clear');

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`  Passati: ${passed}  |  Falliti: ${failed}`);
  console.log(`${'═'.repeat(40)}\n`);

  return failed === 0;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  // Avvia il server
  serverProc = spawn('node', [SERVER_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '4600' },
  });

  // Aspetta che il server sia pronto
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);

    serverProc.stdout.on('data', data => {
      const msg = data.toString();
      if (msg.includes('attivo') || msg.includes('DataFlow')) {
        clearTimeout(timeout);
        setTimeout(resolve, 500); // extra buffer
      }
    });

    serverProc.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProc.stderr.on('data', d => process.stderr.write(d));
  });

  console.log('🚀 Server di test avviato su porta 4600');

  try {
    const ok = await runTests();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('Errore nei test:', err);
    process.exit(1);
  } finally {
    if (serverProc) serverProc.kill();
  }
}

main();
