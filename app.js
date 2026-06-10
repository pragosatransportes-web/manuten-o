const STORAGE_KEY = "gestao-avarias-state-v1";
let tollPreview = null; // { rows: [{plate, month, amount}], fileName } | null
const ATTACHMENT_BUCKET = "avarias-anexos";
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const seed = window.AVARIAS_SEED || {};
const remoteConfig = window.AVARIAS_REMOTE_CONFIG || {};
const options = seed.options || {
  types: ["Motor", "Transmissao", "Travoes", "Eletrica", "Suspensao", "Pneus", "Hidraulico", "Carroceria", "Climatizacao", "Revisão", "Outro"],
  workshopTypes: ["Interna", "Externa"]
};
options.statuses = ["Parado", "Pode circular", "Agendado", "Concluido"];
options.situations = ["Aguarda peças", "Aguarda entrada na oficina", "Em oficina"];

const main = document.querySelector("#main");
const toast = document.querySelector("#toast");
let remoteClient = null;
let remoteChannel = null;
let remoteStatus = {
  label: "Modo local",
  className: "",
  ready: false
};

const icons = {
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>',
  rotate: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"></path><path d="M21 3v6h-6"></path></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path><path d="M17 21v-8H7v8"></path><path d="M7 3v5h8"></path></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m20 6-11 11-5-5"></path></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  paperclip: '<svg viewBox="0 0 24 24"><path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5"></path></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>',
  sort: '<svg viewBox="0 0 24 24"><path d="m3 8 4-4 4 4"></path><path d="M7 4v16"></path><path d="m21 16-4 4-4-4"></path><path d="M17 20V4"></path></svg>'
};

let state = loadState();
render();
initRemote();

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const view = button.dataset.view;
  if (view) {
    state.currentView = view;
    saveState();
    render();
    return;
  }

  const selectId = button.dataset.selectId;
  if (selectId) {
    state.selectedId = selectId;
    saveState();
    render();
    return;
  }

  const action = button.dataset.action;
  if (action === "export-data") exportActivePanelExcel();
  if (action === "sync-trello" && typeof syncAllBreakdownsToTrello === "function") {
    await syncAllBreakdownsToTrello();
  }
  if (action === "dashboard-filter") {
    const filterKey   = button.dataset.filterKey;
    const filterValue = button.dataset.filterValue;
    const statusValue = button.dataset.statusValue || "";
    // Reset all filters first
    state.filters.search    = "";
    state.filters.status    = statusValue;
    state.filters.situation = "";
    state.filters.type      = "";
    // Apply the specific filter for this card
    if (filterKey === "search")    state.filters.search    = filterValue;
    if (filterKey === "situation") state.filters.situation = filterValue;
    if (filterKey === "status")    state.filters.status    = filterValue;
    if (filterKey === "type")      state.filters.type      = filterValue;
    state.currentView = "breakdowns";
    saveState();
    render();
  }
  if (action === "select-breakdown") {
    state.selectedId = button.dataset.id;
    state.currentView = "meeting";
    saveState();
    render();
  }
  if (action === "close-breakdown") {
    await closeBreakdown(button.dataset.id);
  }
  if (action === "toggle-breakdown-sort") {
    state.breakdownsSort = state.breakdownsSort === "desc" ? "asc" : "desc";
    saveState();
    render();
  }
  if (action === "delete-fleet") {
    await deleteFleetItem(button.dataset.equipment);
  }
  if (action === "import-tolls") {
    await handleTollsImport();
  }
  if (action === "clear-toll-preview") {
    tollPreview = null;
    render();
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.filter) {
    setFilter(target.dataset.filter, target.value);
  }
  if (target.id === "new-plate") {
    fillFleetMatchFromPlate(target.value, false);
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.dataset.filter) {
    setFilter(target.dataset.filter, target.value);
  }
  if (target.dataset.fleetDate) {
    await updateFleetDate(target.dataset.equipment, target.dataset.fleetDate, target.value);
  }
  if (target.dataset.fleetCompany) {
    await updateFleetCompany(target.dataset.equipment, target.value);
  }
  if (target.id === "new-plate") {
    fillFleetMatchFromPlate(target.value, true);
  }
  if (target.dataset.tollFile) {
    const file = target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const rows = parseTollsCSV(e.target.result);
        if (!rows.length) { showToast("Nenhum registo válido encontrado no ficheiro."); return; }
        tollPreview = { rows, fileName: file.name };
        render();
      } catch (err) {
        console.error(err);
        showToast("Erro ao ler o ficheiro CSV.");
      }
    };
    reader.readAsText(file, "ISO-8859-1");
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.dataset.form === "quick-update") {
    event.preventDefault();
    await handleQuickUpdate(form, event.submitter?.dataset.intent || "update");
  }
  if (form.dataset.form === "new-breakdown") {
    event.preventDefault();
    await handleNewBreakdown(form);
  }
  if (form.dataset.form === "new-fleet") {
    event.preventDefault();
    await handleNewFleet(form);
  }
});

function loadState() {
  const saved = readStoredState();
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return {
        ...makeInitialState(),
        ...parsed,
        filters: { ...makeInitialState().filters, ...(parsed.filters || {}) }
      };
    } catch {
      clearStoredState();
    }
  }
  return makeInitialState();
}

function makeInitialState() {
  const breakdowns = (seed.breakdowns || []).map((item) => {
    const normalized = normalizeBreakdownFields(item);
    return {
      ...normalized,
      id: String(item.id),
      historyNotes: item.historyNotes || "",
      status: normalized.status || "Parado",
      attachments: normalizeAttachments(normalized.attachments)
    };
  });
  const selected = sortedBreakdowns(breakdowns.filter((item) => item.status !== "Concluido"))[0] || breakdowns[0];
  return {
    currentView: "meeting",
    selectedId: selected?.id || "",
    breakdownsSort: "desc",
    sourceGeneratedAt: seed.generatedAt || "",
    fleet: seed.fleet || [],
    custos: [],
    breakdowns,
    snapshots: seed.snapshots || [],
    audit: buildAudit(breakdowns),
    filters: {
      search: "",
      status: "",
      situation: "",
      type: "",
      fleetSearch: "",
      auditSearch: ""
    }
  };
}

function normalizeBreakdownFields(item) {
  const rawStatus = item.status || "";
  const rawSituation = item.situation || item.situacao || "";
  const normalizedStatus = normalizeText(rawStatus);
  let status = rawStatus;
  let situation = rawSituation;

  if (normalizedStatus.includes("aguarda entrada")) {
    status = "Parado";
    situation = "Aguarda entrada na oficina";
  } else if (normalizedStatus.includes("aguarda pecas")) {
    status = "Parado";
    situation = "Aguarda peças";
  } else if (!options.statuses.includes(status)) {
    status = "Parado";
  }

  if (!situation && status !== "Concluido" && item.workshopEntryAt) {
    situation = "Em oficina";
  }

  return {
    ...item,
    status,
    situation,
    attachments: normalizeAttachments(item.attachments)
  };
}

function buildAudit(breakdowns) {
  return breakdowns
    .flatMap((breakdown) => parseHistory(breakdown.historyNotes).map((entry, index) => ({
      id: `${breakdown.id}-${index}`,
      breakdownId: breakdown.id,
      equipment: breakdown.equipment,
      plate: breakdown.plate,
      at: `${entry.date || breakdown.reportedAt || todayISO()}T09:00:00`,
      action: entry.status ? `Estado: ${entry.status}` : "Nota histórica",
      status: entry.status || "",
      note: entry.note
    })))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

function saveState() {
  writeStoredState(JSON.stringify(state));
}

function readStoredState() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredState(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    return false;
  }
  return true;
}

function clearStoredState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    return false;
  }
  return true;
}

async function initRemote() {
  if (!remoteConfig.supabaseUrl || !remoteConfig.supabaseAnonKey) {
    updateSyncStatus("Modo local", "", false);
    return;
  }
  if (!window.supabase?.createClient) {
    updateSyncStatus("Base partilhada indisponível", "error", false);
    return;
  }

  try {
    updateSyncStatus("A ligar à base partilhada", "syncing", false);
    remoteClient = window.supabase.createClient(remoteConfig.supabaseUrl, remoteConfig.supabaseAnonKey);
    await loadRemoteState();
    subscribeRemoteChanges();
    updateSyncStatus("Partilhado em tempo real", "remote", true);
    showToast("Base partilhada ligada.");
  } catch (error) {
    console.error(error);
    updateSyncStatus(`Erro: ${formatRemoteError(error)}`, "error", false);
    showToast("Não foi possível ligar à base partilhada.");
  }
}

function updateSyncStatus(label, className, ready) {
  remoteStatus = { label, className, ready };
  const syncLine = document.querySelector("#sync-line");
  if (!syncLine) return;
  syncLine.textContent = label;
  syncLine.className = className || "";
}

async function loadRemoteState() {
  const [fleetResult, breakdownsResult, snapshotsResult, auditResult, custosResult] = await Promise.all([
    remoteClient.from("avarias_fleet").select("*").order("equipment", { ascending: true }),
    remoteClient.from("avarias_breakdowns").select("*").order("updated_at", { ascending: false }),
    remoteClient.from("avarias_snapshots").select("*").order("date", { ascending: true }),
    remoteClient.from("avarias_audit_events").select("*").order("at", { ascending: false }),
    remoteClient.from("avarias_custos_portagens").select("*").order("month", { ascending: false })
  ]);

  [fleetResult, breakdownsResult, snapshotsResult, auditResult].forEach((result) => {
    if (result.error) throw result.error;
  });
  // custos table may not exist yet — ignore error silently

  if (!fleetResult.data.length && !breakdownsResult.data.length) {
    await seedRemoteDatabase();
    return loadRemoteState();
  }

  const previousView = state.currentView;
  const previousFilters = state.filters;
  const previousSelectedId = state.selectedId;
  const breakdowns = breakdownsResult.data.map(dbBreakdownToApp);
  const selectedExists = breakdowns.some((item) => item.id === previousSelectedId);

  state = {
    ...state,
    currentView: previousView,
    selectedId: selectedExists ? previousSelectedId : (sortedBreakdowns(breakdowns.filter((item) => item.status !== "Concluido"))[0]?.id || breakdowns[0]?.id || ""),
    fleet: fleetResult.data.map(dbFleetToApp),
    custos: custosResult.error ? [] : custosResult.data.map(dbCustoToApp),
    breakdowns,
    snapshots: snapshotsResult.data.map(dbSnapshotToApp),
    audit: auditResult.data.length ? auditResult.data.map(dbAuditToApp) : buildAudit(breakdowns),
    filters: previousFilters
  };
  saveState();
  render();
}

async function seedRemoteDatabase() {
  updateSyncStatus("A carregar dados iniciais", "syncing", false);
  const auditEvents = state.audit.length ? state.audit : buildAudit(state.breakdowns);
  const operations = [
    remoteClient.from("avarias_fleet").upsert(state.fleet.map(appFleetToDb), { onConflict: "equipment" }),
    remoteClient.from("avarias_breakdowns").upsert(state.breakdowns.map(appBreakdownToDb), { onConflict: "id" }),
    remoteClient.from("avarias_snapshots").upsert(state.snapshots.map(appSnapshotToDb), { onConflict: "date" }),
    remoteClient.from("avarias_audit_events").upsert(auditEvents.map(appAuditToDb), { onConflict: "id" })
  ];
  const results = await Promise.all(operations);
  results.forEach((result) => {
    if (result.error) throw result.error;
  });
}

function subscribeRemoteChanges() {
  if (remoteChannel) remoteClient.removeChannel(remoteChannel);
  remoteChannel = remoteClient
    .channel("avarias-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_breakdowns" }, (payload) => {
      applyRemoteRow(payload, "breakdowns", dbBreakdownToApp);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_audit_events" }, (payload) => {
      applyRemoteRow(payload, "audit", dbAuditToApp);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_fleet" }, (payload) => {
      applyRemoteRow(payload, "fleet", dbFleetToApp);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_snapshots" }, (payload) => {
      applyRemoteRow(payload, "snapshots", dbSnapshotToApp);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_custos_portagens" }, (payload) => {
      applyRemoteRow(payload, "custos", dbCustoToApp);
    })
    .subscribe();
}

function applyRemoteRow(payload, collection, mapper) {
  const row = payload.eventType === "DELETE" ? payload.old : payload.new;
  if (!row) return;
  const item = mapper(row);
  const idField = collection === "snapshots" ? "date" : collection === "fleet" ? "equipment" : "id";
  // custos use "id" — already handled by the default above
  const itemId = String(item[idField]);
  const index = state[collection].findIndex((existing) => String(existing[idField]) === itemId);

  if (payload.eventType === "DELETE") {
    if (index >= 0) state[collection].splice(index, 1);
  } else if (index >= 0) {
    state[collection][index] = item;
  } else {
    state[collection].unshift(item);
  }

  if (collection === "breakdowns") state.breakdowns = sortedBreakdowns(state.breakdowns);
  if (collection === "audit") state.audit.sort((a, b) => new Date(b.at) - new Date(a.at));
  saveState();
  render();
}

async function persistBreakdownRemote(breakdown) {
  if (!remoteStatus.ready || !remoteClient) return;
  updateSyncStatus("A guardar na base partilhada", "syncing", true);
  const { error } = await remoteClient
    .from("avarias_breakdowns")
    .upsert(appBreakdownToDb(breakdown), { onConflict: "id" });
  if (error) throw error;
  updateSyncStatus("Partilhado em tempo real", "remote", true);
}

async function persistAuditRemote(auditEvent) {
  if (!remoteStatus.ready || !remoteClient || !auditEvent) return;
  const { error } = await remoteClient
    .from("avarias_audit_events")
    .upsert(appAuditToDb(auditEvent), { onConflict: "id" });
  if (error) throw error;
}

async function persistFleetRemote(fleetItem) {
  if (!remoteStatus.ready || !remoteClient || !fleetItem) return;
  updateSyncStatus("A guardar frota", "syncing", true);
  const { error } = await remoteClient
    .from("avarias_fleet")
    .upsert(appFleetToDb(fleetItem), { onConflict: "equipment" });
  if (error) throw error;
  updateSyncStatus("Partilhado em tempo real", "remote", true);
}

async function persistRemoteSafely(work) {
  if (!remoteStatus.ready || !remoteClient) return;
  try {
    await work();
  } catch (error) {
    console.error(error);
    updateSyncStatus(`Falhou partilha: ${formatRemoteError(error)}`, "error", false);
    showToast("Guardado localmente, mas a partilha falhou.");
  }
}

function formatRemoteError(error) {
  if (!error) return "sem detalhe";
  if (typeof error === "string") return error;
  return error.message || error.details || error.hint || error.code || "sem detalhe";
}

// --- CUSTOS / PORTAGENS ---

function appCustoToDb(item) {
  return {
    id: item.id,
    plate: item.plate,
    month: item.month,
    amount: item.amount,
    source_file: item.sourceFile || null,
    imported_at: item.importedAt || new Date().toISOString(),
    imported_by: item.importedBy || remoteConfig.operator || "Utilizador"
  };
}

function dbCustoToApp(row) {
  return {
    id: String(row.id),
    plate: row.plate || "",
    month: row.month || "",
    amount: Number(row.amount) || 0,
    sourceFile: row.source_file || "",
    importedAt: row.imported_at || "",
    importedBy: row.imported_by || ""
  };
}

function parseTollsCSV(text) {
  const lines = text.split(/\r?\n/);
  // Primeira linha de dados = índice 8 (7 linhas de cabeçalho + 1 linha de colunas)
  const dataLines = lines.slice(8);
  const totals = {};
  for (const line of dataLines) {
    if (!line.trim()) continue;
    const cols = line.split(";");
    const plate = (cols[1] || "").trim();
    if (!plate) continue;
    // Data: preferir col D (índice 3), fallback col G (índice 6)
    const rawDate = (cols[3] || cols[6] || "").trim();
    if (!rawDate) continue;
    const dateParts = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!dateParts) continue;
    const month = `${dateParts[3]}-${dateParts[2]}`; // YYYY-MM
    // Valor: col J (índice 9), vírgula → ponto
    const rawAmount = (cols[9] || "").trim().replace(",", ".");
    const amount = parseFloat(rawAmount);
    if (isNaN(amount) || amount <= 0) continue;
    const key = `${plate}|${month}`;
    totals[key] = (totals[key] || 0) + amount;
  }
  return Object.entries(totals)
    .map(([key, amount]) => {
      const [plate, month] = key.split("|");
      return { plate, month, amount: Math.round(amount * 100) / 100 };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || a.plate.localeCompare(b.plate));
}

function formatMonth(yyyyMM) {
  if (!yyyyMM || !yyyyMM.includes("-")) return yyyyMM || "";
  const [year, month] = yyyyMM.split("-");
  const months = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return `${months[parseInt(month, 10) - 1] || month}/${year}`;
}

function renderTollPreview(preview) {
  const total = preview.rows.reduce((s, r) => s + r.amount, 0);
  return `
    <div class="toll-preview">
      <div class="panel-header">
        <div>
          <h3>Pré-visualização — ${escapeHtml(preview.fileName)}</h3>
          <p>${preview.rows.length} matrículas · Total: <strong>${total.toFixed(2)} €</strong></p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Matrícula</th><th>Mês</th><th style="text-align:right">Total portagens (€)</th></tr>
          </thead>
          <tbody>
            ${preview.rows.map((row) => `
              <tr>
                <td><strong>${escapeHtml(row.plate)}</strong></td>
                <td>${escapeHtml(formatMonth(row.month))}</td>
                <td style="text-align:right">${escapeHtml(row.amount.toFixed(2))} €</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="form-actions">
        <button class="primary-button" type="button" data-action="import-tolls">
          <span data-icon="save"></span>
          <span>Importar ${preview.rows.length} registos</span>
        </button>
        <button class="ghost-button" type="button" data-action="clear-toll-preview">Cancelar</button>
      </div>
    </div>
  `;
}

function renderCustos() {
  const history = [...state.custos].sort((a, b) => b.month.localeCompare(a.month) || a.plate.localeCompare(b.plate));

  // Totais por mês
  const byMonth = Object.values(
    state.custos.reduce((acc, item) => {
      if (!acc[item.month]) acc[item.month] = { month: item.month, total: 0, count: 0 };
      acc[item.month].total += item.amount;
      acc[item.month].count++;
      return acc;
    }, {})
  ).sort((a, b) => b.month.localeCompare(a.month));

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Custos</p>
          <h2>Portagens — Via Verde</h2>
          <p>Importação de relatórios mensais por viatura.</p>
        </div>
      </div>

      <details class="fleet-add" ${tollPreview ? "open" : ""}>
        <summary><span data-icon="plus"></span> Importar ficheiro CSV</summary>
        <div class="data-form">
          <div class="form-grid">
            <label class="field">
              <span>Ficheiro CSV Via Verde</span>
              <input type="file" accept=".csv,.CSV" data-toll-file="1">
            </label>
          </div>
          ${tollPreview ? renderTollPreview(tollPreview) : ""}
        </div>
      </details>

      ${byMonth.length ? `
        <div class="panel-header" style="margin-top:2rem">
          <div><h3>Resumo por mês</h3></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Mês</th><th style="text-align:right">Total (€)</th><th>N.º registos</th></tr>
            </thead>
            <tbody>
              ${byMonth.map((item) => `
                <tr>
                  <td><strong>${escapeHtml(formatMonth(item.month))}</strong></td>
                  <td style="text-align:right">${escapeHtml(item.total.toFixed(2))} €</td>
                  <td>${escapeHtml(String(item.count))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        <div class="panel-header" style="margin-top:2rem">
          <div><h3>Detalhe por viatura</h3></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Mês</th><th>Matrícula</th><th style="text-align:right">Total (€)</th><th>Ficheiro</th><th>Importado em</th></tr>
            </thead>
            <tbody>
              ${history.map((item) => `
                <tr>
                  <td>${escapeHtml(formatMonth(item.month))}</td>
                  <td><strong>${escapeHtml(item.plate)}</strong></td>
                  <td style="text-align:right">${escapeHtml(item.amount.toFixed(2))} €</td>
                  <td class="compact-cell">${escapeHtml(item.sourceFile)}</td>
                  <td>${escapeHtml(formatDate(item.importedAt?.slice(0, 10)))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : '<p class="empty-state">Sem portagens importadas. Usa o botão acima para importar o primeiro relatório.</p>'}
    </section>
  `;
}

async function handleTollsImport() {
  if (!tollPreview || !tollPreview.rows.length) return;
  if (!remoteStatus.ready || !remoteClient) {
    showToast("Sem ligação à base partilhada. Liga antes de importar.");
    return;
  }
  const now = new Date().toISOString();
  const rows = tollPreview.rows.map((row) => ({
    id: `PORTAGEM-${row.plate}-${row.month}-${tollPreview.fileName}`,
    plate: row.plate,
    month: row.month,
    amount: row.amount,
    sourceFile: tollPreview.fileName,
    importedAt: now,
    importedBy: remoteConfig.operator || "Utilizador"
  }));
  try {
    updateSyncStatus("A importar portagens", "syncing", true);
    const { error } = await remoteClient
      .from("avarias_custos_portagens")
      .upsert(rows.map(appCustoToDb), { onConflict: "id" });
    if (error) throw error;
    for (const row of rows) {
      const idx = state.custos.findIndex((c) => c.id === row.id);
      if (idx >= 0) state.custos[idx] = row;
      else state.custos.unshift(row);
    }
    tollPreview = null;
    saveState();
    updateSyncStatus("Partilhado em tempo real", "remote", true);
    showToast(`${rows.length} registos importados.`);
    render();
  } catch (error) {
    console.error(error);
    updateSyncStatus(`Erro: ${formatRemoteError(error)}`, "error", false);
    showToast("Erro ao importar portagens.");
  }
}

// --- FIM CUSTOS ---

function appFleetToDb(item) {
  return {
    equipment: String(item.equipment ?? ""),
    plate: item.plate || null,
    description: item.description || null,
    brand: item.brand || null,
    model: item.model || null,
    year: item.year || null,
    status: item.status || null,
    fleet_entry_at: item.fleetEntryAt || null,
    fleet_exit_at: item.fleetExitAt || null,
    exit_reason: item.exitReason || null,
    notes: item.notes || null,
    fleet_company: item.fleetCompany || null,
    inspection_at: item.inspectionAt || null,
    tachograph_calibration_at: item.tachographAt || null,
    compressor_review_at: item.compressorReviewAt || null,
    wheel_hub_review_at: item.wheelHubReviewAt || null
  };
}

function dbFleetToApp(row) {
  return {
    equipment: normalizeEquipment(row.equipment),
    plate: row.plate || "",
    description: row.description || "",
    brand: row.brand || "",
    model: row.model || "",
    year: row.year,
    status: row.status || "",
    fleetEntryAt: row.fleet_entry_at || null,
    fleetExitAt: row.fleet_exit_at || null,
    exitReason: row.exit_reason || "",
    notes: row.notes || "",
    fleetCompany: row.fleet_company || "",
    inspectionAt: row.inspection_at || null,
    tachographAt: row.tachograph_calibration_at || null,
    compressorReviewAt: row.compressor_review_at || null,
    wheelHubReviewAt: row.wheel_hub_review_at || null
  };
}

function appBreakdownToDb(item) {
  const row = {
    id: String(item.id),
    equipment: String(item.equipment ?? ""),
    plate: item.plate || null,
    type: item.type || null,
    status: item.status || null,
    reported_at: item.reportedAt || null,
    workshop_entry_at: item.workshopEntryAt || null,
    expected_exit_at: item.expectedExitAt || null,
    situation: item.situation || null,
    workshop_type: item.workshopType || null,
    workshop: item.workshop || null,
    driver: item.driver || null,
    cost: item.cost || null,
    description: item.description || null,
    last_note: item.lastNote || null,
    last_note_at: item.lastNoteAt || null,
    history_notes: item.historyNotes || "",
    updated_at: new Date().toISOString(),
    updated_by: remoteConfig.operator || "Utilizador"
  };
  const attachments = normalizeAttachments(item.attachments);
  if (attachments.length) row.attachments = attachments;
  return row;
}

function dbBreakdownToApp(row) {
  return normalizeBreakdownFields({
    id: String(row.id),
    equipment: normalizeEquipment(row.equipment),
    plate: row.plate || "",
    type: row.type || "",
    status: row.status || "Parado",
    reportedAt: row.reported_at || null,
    workshopEntryAt: row.workshop_entry_at || null,
    expectedExitAt: row.expected_exit_at || null,
    situation: row.situation || "",
    workshopType: row.workshop_type || "",
    workshop: row.workshop || "",
    driver: row.driver || "",
    cost: row.cost,
    description: row.description || "",
    lastNote: row.last_note || "",
    lastNoteAt: row.last_note_at || null,
    historyNotes: row.history_notes || "",
    attachments: normalizeAttachments(row.attachments)
  });
}

function appSnapshotToDb(item) {
  return {
    date: item.date,
    active: item.active || 0,
    stopped: item.stopped || 0,
    waiting_workshop: item.waitingWorkshop || 0,
    can_circulate: item.canCirculate || 0,
    overdue: item.overdue || 0,
    meeting_note: item.meetingNote || null
  };
}

function dbSnapshotToApp(row) {
  return {
    date: row.date,
    active: row.active || 0,
    stopped: row.stopped || 0,
    waitingWorkshop: row.waiting_workshop || 0,
    canCirculate: row.can_circulate || 0,
    overdue: row.overdue || 0,
    meetingNote: row.meeting_note || ""
  };
}

function appAuditToDb(item) {
  return {
    id: String(item.id),
    breakdown_id: item.breakdownId || null,
    equipment: String(item.equipment ?? ""),
    plate: item.plate || null,
    at: item.at || new Date().toISOString(),
    action: item.action || null,
    status: item.status || null,
    note: item.note || null
  };
}

function dbAuditToApp(row) {
  return {
    id: String(row.id),
    breakdownId: row.breakdown_id || "",
    equipment: normalizeEquipment(row.equipment),
    plate: row.plate || "",
    at: row.at,
    action: row.action || "",
    status: row.status || "",
    note: row.note || ""
  };
}

function render(focusSelector = "") {
  const metrics = getMetrics();
  document.querySelector("#data-line").textContent =
    `${state.breakdowns.length} avarias, ${state.fleet.length} viaturas, ${metrics.active} abertas`;
  updateSyncStatus(remoteStatus.label, remoteStatus.className, remoteStatus.ready);

  document.querySelectorAll(".view-tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.currentView);
  });

  const views = {
    dashboard: renderDashboard,
    meeting: renderMeeting,
    breakdowns: renderBreakdowns,
    new: renderNewBreakdown,
    fleet: renderFleet,
    audit: renderAudit,
    custos: renderCustos
  };
  main.innerHTML = (views[state.currentView] || renderMeeting)();
  hydrateIcons();

  if (focusSelector) {
    const element = document.querySelector(focusSelector);
    if (element) {
      element.focus();
      if (element.setSelectionRange) {
        const length = element.value.length;
        element.setSelectionRange(length, length);
      }
    }
  }
}

function renderDashboard() {
  const management = getManagementMetrics();
  const upcoming = getFleetDateAlerts().slice(0, 12);

  return `
    <section class="dashboard-layout">
      <div class="panel dashboard-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Gestão</p>
            <h2>Dashboard operacional</h2>
            <p>Indicadores principais de avarias e oficina.</p>
          </div>
        </div>
        <div class="dashboard-grid">
          ${renderDashboardCard("Aguarda oficina", management.waitingWorkshop, "Avarias abertas a aguardar entrada na oficina",
            {"filter-key": "situation", "filter-value": "Aguarda entrada na oficina", "status-value": ""})}
          ${renderDashboardCard("Em oficina", management.inWorkshop, "Avarias abertas com viatura em oficina",
            {"filter-key": "situation", "filter-value": "Em oficina", "status-value": ""})}
          ${renderDashboardCard("Aguarda peças", management.waitingParts, "Avarias abertas a aguardar peças",
            {"filter-key": "situation", "filter-value": "Aguarda peças", "status-value": ""})}
          ${renderDashboardCard("Oficina externa", management.externalWorkshop, "Avarias abertas em oficina externa",
            {"filter-key": "search", "filter-value": "Externa", "status-value": ""})}
          ${renderDashboardCard("Tempo médio interna", formatDaysMetric(management.avgInternalResolution), "Entrada em oficina até conclusão")}
          ${renderDashboardCard("Tempo médio externa", formatDaysMetric(management.avgExternalResolution), "Entrada em oficina até conclusão")}
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Frota</p>
            <h2>Próximas datas</h2>
            <p>Contagem decrescente das inspeções, aferições e revisões registadas.</p>
          </div>
        </div>
        <div class="deadline-list">
          ${upcoming.length ? upcoming.map((item) => `
            <article class="deadline-row">
              <div>
                <strong>Equip. ${escapeHtml(item.equipment)} · ${escapeHtml(item.plate || "-")}</strong>
                <span>${escapeHtml(item.label)}</span>
              </div>
              ${renderDueBadge(item.date)}
            </article>
          `).join("") : '<p class="empty-state">Sem datas de frota registadas.</p>'}
        </div>
      </div>
    </section>
  `;
}

function renderDashboardCard(label, value, detail, filterData) {
  if (filterData) {
    const attrs = Object.entries(filterData)
      .map(([k, v]) => `data-${k}="${escapeAttr(v)}"`).join(" ");
    return `
      <button class="dashboard-card dashboard-card--clickable" type="button"
        data-action="dashboard-filter" ${attrs}
        title="Ver ${escapeAttr(label)}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value))}</strong>
        <em>${escapeHtml(detail)}</em>
        <span class="dashboard-card__cta">Ver avarias →</span>
      </button>
    `;
  }
  return `
    <article class="dashboard-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
      <em>${escapeHtml(detail)}</em>
    </article>
  `;
}

function renderMeeting() {
  const metrics = getMetrics();
  const list = getFilteredBreakdowns(true);
  let selected = state.breakdowns.find((item) => item.id === state.selectedId);
  if (!selected) {
    ensureSelected(list);
    selected = state.breakdowns.find((item) => item.id === state.selectedId);
  }

  return `
    ${renderMetrics(metrics)}
    <section class="meeting-layout">
      <div class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Reunião diária</p>
            <h2>Avarias abertas</h2>
            <p>${list.length} registos em análise</p>
          </div>
          <button class="ghost-button" type="button" data-view="new">
            <span data-icon="plus"></span>
            <span>Nova</span>
          </button>
        </div>
        ${renderFilters("meeting")}
        <div class="meeting-list">
          ${list.length ? list.map(renderMeetingRow).join("") : '<p class="empty-state">Sem avarias abertas para estes filtros.</p>'}
        </div>
      </div>
      <aside class="panel detail-panel">
        ${renderDetail(selected)}
      </aside>
    </section>
  `;
}

function renderMetrics(metrics) {
  const cards = [
    ["Com avaria", metrics.active, `${metrics.activePercent}% da frota ativa`],
    ["Paradas", metrics.stopped, `${metrics.overdue} em atraso`],
    ["Ag. entrada of.", metrics.waitingWorkshop, "aguardam triagem"],
    ["Podem circular", metrics.canCirculate, "acompanhar sem parar"],
    ["Concluídas", metrics.closed, "registadas no histórico"]
  ];

  return `
    <section class="metrics-grid">
      ${cards.map(([label, value, detail]) => `
        <article class="metric-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <em>${escapeHtml(detail)}</em>
        </article>
      `).join("")}
    </section>
  `;
}

function renderFilters(context) {
  const searchPlaceholder = context === "meeting" ? "Pesquisar equipamento, matrícula, oficina ou nota" : "Pesquisar avarias";
  const sortButton = context === "breakdowns" ? `
      <button class="ghost-button" type="button" data-action="toggle-breakdown-sort" title="Inverter ordenação por data de avaria">
        <span data-icon="sort"></span>
        <span>${state.breakdownsSort === "asc" ? "Mais antigas primeiro" : "Mais recentes primeiro"}</span>
      </button>` : "";
  return `
    <div class="toolbar">
      <input type="search" data-filter="search" value="${escapeAttr(state.filters.search)}" placeholder="${searchPlaceholder}">
      <select data-filter="status" aria-label="Estado">
        <option value="">Todos os estados</option>
        ${options.statuses.map((status) => `<option value="${escapeAttr(status)}" ${state.filters.status === status ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}
      </select>
      <select data-filter="situation" aria-label="Situação">
        <option value="">Todas as situações</option>
        ${options.situations.map((situation) => `<option value="${escapeAttr(situation)}" ${state.filters.situation === situation ? "selected" : ""}>${escapeHtml(situation)}</option>`).join("")}
      </select>
      <select data-filter="type" aria-label="Tipo">
        <option value="">Todos os tipos</option>
        ${options.types.map((type) => `<option value="${escapeAttr(type)}" ${state.filters.type === type ? "selected" : ""}>${escapeHtml(type)}</option>`).join("")}
      </select>
      ${sortButton}
    </div>
  `;
}

function renderMeetingRow(breakdown) {
  const overdue = isOverdue(breakdown);
  const days = daysOpen(breakdown);
  return `
    <button class="meeting-row ${state.selectedId === breakdown.id ? "selected" : ""}" type="button" data-select-id="${escapeAttr(breakdown.id)}">
      <div>
        <div class="row-title">
          <strong>Equip. ${escapeHtml(breakdown.equipment || "-")}</strong>
          <span>${escapeHtml(breakdown.plate || "-")}</span>
          ${statusBadge(breakdown.status)}
        </div>
        <p class="row-desc">${escapeHtml(breakdown.description || breakdown.lastNote || "-")}</p>
        <div class="row-meta">
          <span>${escapeHtml(breakdown.type || "Sem tipo")}</span>
          <span>Prev. ${formatDate(breakdown.expectedExitAt)}</span>
          <span>${escapeHtml(breakdown.workshop || breakdown.workshopType || "Oficina por definir")}</span>
          ${renderAttachmentMeta(breakdown)}
        </div>
      </div>
      <span class="days-pill ${overdue ? "overdue" : ""}">${days} dias</span>
    </button>
  `;
}

function renderDetail(breakdown) {
  if (!breakdown) {
    return '<p class="empty-state">Sem registo selecionado.</p>';
  }

  const timeline = parseHistory(breakdown.historyNotes);
  return `
    <div class="detail-head">
      <div>
        <p class="eyebrow">Atualização rápida</p>
        <h2>Equip. ${escapeHtml(breakdown.equipment || "-")}</h2>
      </div>
      <div class="detail-subtitle">
        <span>${escapeHtml(breakdown.plate || "-")}</span>
        ${statusBadge(breakdown.status)}
      </div>
    </div>

    <dl class="mini-grid">
      <div><dt>Data avaria</dt><dd>${formatDate(breakdown.reportedAt)}</dd></div>
      <div><dt>Prev. saída</dt><dd>${formatDate(breakdown.expectedExitAt)}</dd></div>
      <div><dt>Entrada oficina</dt><dd>${formatDate(breakdown.workshopEntryAt)}</dd></div>
      <div><dt>Última nota</dt><dd>${escapeHtml(breakdown.lastNote || "-")}</dd></div>
    </dl>

    ${renderAttachments(breakdown)}

    <form class="quick-form" data-form="quick-update">
      <div class="form-grid">
        <label class="field">
          <span>Estado</span>
          <select name="status">
            ${options.statuses.map((status) => `<option value="${escapeAttr(status)}" ${breakdown.status === status ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Situação</span>
          <select name="situation">
            <option value="" ${!breakdown.situation ? "selected" : ""}></option>
            ${options.situations.map((situation) => `<option value="${escapeAttr(situation)}" ${breakdown.situation === situation ? "selected" : ""}>${escapeHtml(situation)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Prev. saída</span>
          <input type="date" name="expectedExitAt" value="${escapeAttr(breakdown.expectedExitAt || "")}">
        </label>
        <label class="field">
          <span>Entrada oficina</span>
          <input type="date" name="workshopEntryAt" value="${escapeAttr(breakdown.workshopEntryAt || "")}">
        </label>
        <label class="field">
          <span>Oficina</span>
          <input name="workshop" value="${escapeAttr(breakdown.workshop || "")}" placeholder="Oficina">
        </label>
        <label class="field">
          <span>Tipo</span>
          <select name="type">
            <option value="" ${!breakdown.type ? "selected" : ""}></option>
            ${options.types.map((type) => `<option value="${escapeAttr(type)}" ${breakdown.type === type ? "selected" : ""}>${escapeHtml(type)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Motorista</span>
          <input name="driver" value="${escapeAttr(breakdown.driver || "")}" placeholder="Motorista">
        </label>
        <label class="field full-span">
          <span>Descrição</span>
          <textarea name="description" placeholder="Descrição da avaria">${escapeHtml(breakdown.description || "")}</textarea>
        </label>
        <label class="field full-span">
          <span>Nota</span>
          <textarea name="note" placeholder="Atualização para guardar no histórico"></textarea>
        </label>
        <label class="field file-field full-span">
          <span>Adicionar ficheiros/fotografias</span>
          <input type="file" name="attachments" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" multiple>
        </label>
      </div>
      <div class="button-row">
        <button class="primary-button" type="submit" data-intent="update">
          <span data-icon="save"></span>
          <span>Atualizar</span>
        </button>
        ${breakdown.status !== "Concluido" ? `
          <button class="danger-button" type="submit" data-intent="close">
            <span data-icon="check"></span>
            <span>Concluir</span>
          </button>
        ` : ""}
        ${breakdown.status === "Concluido" ? `
          <button class="ghost-button" type="submit" data-intent="reopen">
            <span data-icon="rotate"></span>
            <span>Reabrir ocorrência</span>
          </button>
        ` : ""}
      </div>
    </form>

    <div class="timeline">
      <h3>Histórico</h3>
      ${timeline.length ? timeline.map((item) => `
        <article class="timeline-item">
          <time>${formatDate(item.date)}${item.status ? ` · ${escapeHtml(item.status)}` : ""}</time>
          <p>${escapeHtml(item.note)}</p>
        </article>
      `).join("") : '<p class="empty-state">Sem histórico registado.</p>'}
    </div>
  `;
}

function renderBreakdowns() {
  const list = sortBreakdownsByDate(getFilteredBreakdowns(false), state.breakdownsSort);
  return `
    <section class="page-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Registos</p>
            <h2>Avarias</h2>
            <p>${list.length} registos encontrados</p>
          </div>
        </div>
        ${renderFilters("breakdowns")}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Equip.</th>
                <th>Matrícula</th>
                  <th>Tipo</th>
                  <th>Estado</th>
                  <th>Situação</th>
                  <th>Anexos</th>
                  <th>Datas</th>
                <th>Oficina</th>
                <th>Nota</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${list.map((item) => `
                <tr>
                  <td><strong>${escapeHtml(item.equipment || "-")}</strong></td>
                  <td>${escapeHtml(item.plate || "-")}</td>
                  <td>${escapeHtml(item.type || "-")}</td>
                  <td>${statusBadge(item.status)}</td>
                  <td>${escapeHtml(item.situation || "-")}</td>
                  <td>${renderAttachmentSummary(item)}</td>
                  <td>Avaria: ${formatDate(item.reportedAt)}<br>Prev.: ${formatDate(item.expectedExitAt)}</td>
                  <td>${escapeHtml(item.workshop || item.workshopType || "-")}</td>
                  <td class="compact-cell">${escapeHtml(item.lastNote || item.description || "-")}</td>
                  <td>
                    <div class="button-row">
                      <button class="icon-button" type="button" data-action="select-breakdown" data-id="${escapeAttr(item.id)}" title="Abrir">
                        <span data-icon="eye"></span>
                      </button>
                      ${item.status !== "Concluido" ? `
                        <button class="icon-button" type="button" data-action="close-breakdown" data-id="${escapeAttr(item.id)}" title="Concluir">
                          <span data-icon="check"></span>
                        </button>
                      ` : ""}
                    </div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderNewBreakdown() {
  const today = todayISO();
  return `
    <section class="panel form-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Entrada</p>
          <h2>Nova avaria</h2>
          <p>Registo com data, estado inicial e primeira nota.</p>
        </div>
      </div>
      <form class="data-form" data-form="new-breakdown">
        <div class="form-grid">
          <label class="field">
            <span>Matrícula</span>
            <input id="new-plate" name="plate" list="plate-options" autocomplete="off" required>
          </label>
          <label class="field">
            <span>Equipamento</span>
            <input id="new-equipment" name="equipment" placeholder="Preenchido pela matrícula" readonly>
          </label>
          <label class="field">
            <span>Tipo</span>
            <select name="type" required>
              ${options.types.map((type) => `<option value="${escapeAttr(type)}">${escapeHtml(type)}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span>Estado</span>
          <select name="status" required>
            ${options.statuses.filter((status) => status !== "Concluido").map((status) => `<option value="${escapeAttr(status)}">${escapeHtml(status)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Situação</span>
          <select name="situation">
            <option value=""></option>
            ${options.situations.map((situation) => `<option value="${escapeAttr(situation)}">${escapeHtml(situation)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
            <span>Data avaria</span>
            <input type="date" name="reportedAt" value="${today}" required>
          </label>
          <label class="field">
            <span>Entrada oficina</span>
            <input type="date" name="workshopEntryAt">
          </label>
          <label class="field">
            <span>Prev. saída</span>
            <input type="date" name="expectedExitAt">
          </label>
          <label class="field">
            <span>Tipo oficina</span>
            <select name="workshopType">
              <option value=""></option>
              ${options.workshopTypes.map((type) => `<option value="${escapeAttr(type)}">${escapeHtml(type)}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span>Oficina</span>
            <input name="workshop">
          </label>
          <label class="field">
            <span>Motorista</span>
            <input name="driver">
          </label>
          <label class="field full-span">
            <span>Descrição</span>
            <textarea name="description" required></textarea>
          </label>
          <label class="field file-field full-span">
            <span>Ficheiro/fotografia</span>
            <input type="file" name="attachments" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" multiple>
          </label>
        </div>
        <div class="form-actions">
          <button class="primary-button" type="submit">
            <span data-icon="plus"></span>
            <span>Criar avaria</span>
          </button>
        </div>
      </form>
      <datalist id="plate-options">
        ${state.fleet.filter((item) => item.plate).map((item) => `<option value="${escapeAttr(item.plate)}">${escapeHtml(`Equip. ${item.equipment || "-"} · ${item.description || ""}`)}</option>`).join("")}
      </datalist>
    </section>
  `;
}

function renderFleet() {
  const activeCounts = state.breakdowns.reduce((acc, item) => {
    if (item.status !== "Concluido") acc[item.equipment] = (acc[item.equipment] || 0) + 1;
    return acc;
  }, {});
  const list = getFilteredFleet();

  const fleetStatuses = seed.options?.fleetStatuses || ["Ativa", "Manutencao preventiva", "Vendida", "Abatida", "Cedida", "Inativa", "Alugada"];

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Frota</p>
          <h2>Viaturas</h2>
          <p>${list.length} registos encontrados</p>
        </div>
      </div>
      <details class="fleet-add">
        <summary><span data-icon="plus"></span> Adicionar viatura</summary>
        <form class="data-form" data-form="new-fleet">
          <div class="form-grid">
            <label class="field">
              <span>Equipamento</span>
              <input name="equipment" required placeholder="N.º equipamento">
            </label>
            <label class="field">
              <span>Matrícula</span>
              <input name="plate" required placeholder="AA-00-AA">
            </label>
            <label class="field">
              <span>Descrição</span>
              <input name="description" required placeholder="Ex.: Camião basculante">
            </label>
            <label class="field">
              <span>Marca</span>
              <input name="brand">
            </label>
            <label class="field">
              <span>Ano</span>
              <input name="year" type="number" min="1980" max="2100">
            </label>
            <label class="field">
              <span>Estado</span>
              <select name="status">
                ${fleetStatuses.map((status) => `<option value="${escapeAttr(status)}" ${status === "Ativa" ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}
              </select>
            </label>
            <label class="field">
              <span>Empresa</span>
              <select name="fleetCompany">
                <option value=""></option>
                <option value="CPSA">CPSA</option>
                <option value="PTSA">PTSA</option>
              </select>
            </label>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">
              <span data-icon="plus"></span>
              <span>Criar viatura</span>
            </button>
          </div>
        </form>
      </details>
      <div class="toolbar">
        <input type="search" data-filter="fleetSearch" value="${escapeAttr(state.filters.fleetSearch)}" placeholder="Pesquisar equipamento, matrícula ou marca">
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Equip.</th>
              <th>Matrícula</th>
              <th>Descrição</th>
              <th>Marca</th>
              <th>Ano</th>
              <th>Estado</th>
              <th>Empresa</th>
              <th>Avarias abertas</th>
              <th>Inspeção</th>
              <th>Aferição tacógrafo</th>
              <th>Revisão compressor</th>
              <th>Cubos de roda</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${list.map((item) => `
              <tr>
                <td><strong>${escapeHtml(item.equipment || "-")}</strong></td>
                <td>${escapeHtml(item.plate || "-")}</td>
                <td class="compact-cell">${escapeHtml(item.description || "-")}</td>
                <td>${escapeHtml(item.brand || item.model || "-")}</td>
                <td>${escapeHtml(item.year || "-")}</td>
                <td>${escapeHtml(item.status || "-")}</td>
                <td>${renderFleetCompanyCell(item)}</td>
                <td>${activeCounts[item.equipment] || 0}</td>
                <td>${renderFleetDateCell(item, "inspectionAt", "Data de inspeção")}</td>
                <td>${renderFleetDateCell(item, "tachographAt", "Data de aferição tacógrafo")}</td>
                <td>${renderFleetDateCell(item, "compressorReviewAt", "Data de revisão compressor")}</td>
                <td>${renderFleetDateCell(item, "wheelHubReviewAt", "Data de revisão cubos de roda")}</td>
                <td>
                  <button class="icon-button" type="button" data-action="delete-fleet" data-equipment="${escapeAttr(item.equipment)}" title="Remover viatura">
                    <span data-icon="trash"></span>
                  </button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderFleetDateCell(item, field, label) {
  if (!isFleetDateApplicable(item, field)) {
    return '<span class="not-applicable">N/A</span>';
  }

  return `
    <div class="fleet-date-cell">
      <input
        type="date"
        aria-label="${escapeAttr(`${label} equip. ${item.equipment}`)}"
        value="${escapeAttr(item[field] || "")}"
        data-equipment="${escapeAttr(item.equipment)}"
        data-fleet-date="${escapeAttr(field)}"
      >
      ${renderDueBadge(item[field])}
    </div>
  `;
}

function renderFleetCompanyCell(item) {
  return `
    <select class="fleet-company-select" data-equipment="${escapeAttr(item.equipment)}" data-fleet-company="true" aria-label="Empresa equip. ${escapeAttr(item.equipment)}">
      <option value="" ${!item.fleetCompany ? "selected" : ""}></option>
      <option value="CPSA" ${item.fleetCompany === "CPSA" ? "selected" : ""}>CPSA</option>
      <option value="PTSA" ${item.fleetCompany === "PTSA" ? "selected" : ""}>PTSA</option>
    </select>
  `;
}

function renderDueBadge(dateValue) {
  const due = getDueState(dateValue);
  return `<span class="due-badge ${due.className}">${escapeHtml(due.label)}</span>`;
}

async function updateFleetDate(equipment, field, value) {
  const item = state.fleet.find((fleetItem) => String(fleetItem.equipment) === String(equipment));
  if (!item || !isFleetDateApplicable(item, field)) return;
  const previous = item[field] || "";
  item[field] = emptyToNull(value);
  const auditEvent = logFleetAudit(item, field, previous, item[field] || "");
  saveState();
  showToast("Data da frota guardada.");
  render();
  await persistRemoteSafely(async () => {
    await persistFleetRemote(item);
    await persistAuditRemote(auditEvent);
  });
}

async function updateFleetCompany(equipment, value) {
  const item = state.fleet.find((fleetItem) => String(fleetItem.equipment) === String(equipment));
  if (!item) return;
  const previous = item.fleetCompany || "";
  item.fleetCompany = value || "";
  const auditEvent = logFleetAudit(item, "fleetCompany", previous, item.fleetCompany);
  saveState();
  showToast("Empresa da frota guardada.");
  render();
  await persistRemoteSafely(async () => {
    await persistFleetRemote(item);
    await persistAuditRemote(auditEvent);
  });
}


async function handleNewFleet(form) {
  const data = new FormData(form);
  const equipmentInput = String(data.get("equipment") || "").trim();
  const plateInput = String(data.get("plate") || "").trim();
  const equipment = normalizeEquipment(equipmentInput);

  if (equipment === "") {
    showToast("Indique o número de equipamento.");
    return;
  }
  if (state.fleet.some((item) => String(item.equipment) === String(equipment))) {
    showToast(`Já existe uma viatura com o equipamento ${equipment}.`);
    return;
  }
  if (plateInput && state.fleet.some((item) => normalizePlate(item.plate) === normalizePlate(plateInput))) {
    showToast(`Já existe uma viatura com a matrícula ${plateInput}.`);
    return;
  }

  const yearValue = Number(data.get("year"));
  const item = {
    equipment,
    plate: plateInput,
    description: String(data.get("description") || "").trim(),
    brand: String(data.get("brand") || "").trim(),
    model: "",
    year: Number.isFinite(yearValue) && yearValue > 0 ? yearValue : null,
    status: String(data.get("status") || "Ativa"),
    fleetEntryAt: todayISO(),
    fleetExitAt: null,
    exitReason: "",
    notes: "",
    fleetCompany: String(data.get("fleetCompany") || ""),
    inspectionAt: null,
    tachographAt: null,
    compressorReviewAt: null,
    wheelHubReviewAt: null
  };

  state.fleet.push(item);
  state.fleet.sort((a, b) => String(a.equipment).localeCompare(String(b.equipment), undefined, { numeric: true }));
  const auditEvent = {
    id: `FROTA-${equipment}-criada-${Date.now()}`,
    breakdownId: "",
    equipment: item.equipment,
    plate: item.plate,
    at: new Date().toISOString(),
    action: "Frota: viatura adicionada",
    status: "",
    note: `${item.plate || "-"} · ${item.description || "-"}`
  };
  state.audit.unshift(auditEvent);
  saveState();
  showToast("Viatura adicionada à frota.");
  render();
  await persistRemoteSafely(async () => {
    await persistFleetRemote(item);
    await persistAuditRemote(auditEvent);
  });
}

async function deleteFleetItem(equipment) {
  const item = state.fleet.find((fleetItem) => String(fleetItem.equipment) === String(equipment));
  if (!item) return;

  const hasOpenBreakdowns = state.breakdowns.some((breakdown) =>
    String(breakdown.equipment) === String(item.equipment) && breakdown.status !== "Concluido");
  if (hasOpenBreakdowns) {
    showToast("Não é possível remover: a viatura tem avarias abertas.");
    return;
  }
  if (!window.confirm(`Remover a viatura equip. ${item.equipment} (${item.plate || "sem matrícula"}) da frota?`)) {
    return;
  }

  state.fleet = state.fleet.filter((fleetItem) => fleetItem !== item);
  const auditEvent = {
    id: `FROTA-${item.equipment}-removida-${Date.now()}`,
    breakdownId: "",
    equipment: item.equipment,
    plate: item.plate,
    at: new Date().toISOString(),
    action: "Frota: viatura removida",
    status: "",
    note: `${item.plate || "-"} · ${item.description || "-"}`
  };
  state.audit.unshift(auditEvent);
  saveState();
  showToast("Viatura removida da frota.");
  render();
  await persistRemoteSafely(async () => {
    const { error } = await remoteClient.from("avarias_fleet").delete().eq("equipment", String(item.equipment));
    if (error) throw error;
    await persistAuditRemote(auditEvent);
  });
}

function renderAudit() {
  const audit = getFilteredAudit();
  const maxActive = Math.max(1, ...state.snapshots.map((item) => item.active || 0));

  return `
    <section class="page-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Evolução</p>
            <h2>Histórico de reunião</h2>
            <p>${state.snapshots.length} snapshots importados</p>
          </div>
        </div>
        <div class="snapshot-list">
          ${state.snapshots.slice(-12).map((item) => `
            <div class="snapshot-row">
              <strong>${formatDate(item.date)}</strong>
              <div class="bar-track"><div class="bar-fill" style="--bar-width: ${Math.round(((item.active || 0) / maxActive) * 100)}%"></div></div>
              <span>${escapeHtml(item.active || 0)} abertas · ${escapeHtml(item.stopped || 0)} paradas</span>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Rastreabilidade</p>
            <h2>Eventos</h2>
            <p>${audit.length} eventos encontrados</p>
          </div>
        </div>
        <div class="toolbar">
          <input type="search" data-filter="auditSearch" value="${escapeAttr(state.filters.auditSearch)}" placeholder="Pesquisar evento, equipamento ou nota">
        </div>
        <div class="timeline" style="padding: 16px; margin-top: 0;">
          ${audit.slice(0, 160).map((item) => `
            <article class="timeline-item">
              <time>${formatDateTime(item.at)} · Equip. ${escapeHtml(item.equipment || "-")} · ${escapeHtml(item.action)}</time>
              <p>${escapeHtml(item.note || "-")}</p>
            </article>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

async function handleQuickUpdate(form, intent) {
  const breakdown = state.breakdowns.find((item) => item.id === state.selectedId);
  if (!breakdown) return;

  const data = new FormData(form);
  const previous = { ...breakdown };
  const nextStatus = intent === "close" ? "Concluido" : String(data.get("status") || breakdown.status);
  const finalStatus = intent === "reopen" && nextStatus === "Concluido" ? "Parado" : nextStatus;
  const note = String(data.get("note") || "").trim();
  let auditEvent = null;

  let newAttachments = [];
  const files = form.elements.attachments?.files;
  if (files && files.length) {
    try {
      newAttachments = await uploadBreakdownAttachments(breakdown.id, files);
    } catch (error) {
      console.error(error);
      updateSyncStatus(`Falhou anexo: ${formatRemoteError(error)}`, "error", remoteStatus.ready);
      showToast(`Não foi possível guardar o anexo: ${formatRemoteError(error)}`);
      return;
    }
  }

  breakdown.status = finalStatus;
  breakdown.situation = finalStatus === "Concluido" ? "" : String(data.get("situation") || "").trim();
  breakdown.expectedExitAt = emptyToNull(data.get("expectedExitAt"));
  breakdown.workshopEntryAt = emptyToNull(data.get("workshopEntryAt"));
  breakdown.workshop = String(data.get("workshop") || "").trim();
  breakdown.type = String(data.get("type") || breakdown.type || "").trim();
  breakdown.driver = String(data.get("driver") || "").trim();
  breakdown.description = String(data.get("description") || "").trim();

  if (newAttachments.length) {
    breakdown.attachments = [...normalizeAttachments(breakdown.attachments), ...newAttachments];
  }

  const changes = summarizeChanges(previous, breakdown);
  if (newAttachments.length) {
    changes.push(`anexos adicionados: ${formatAttachmentNames(newAttachments)}`);
  }
  let trelloNote = "";
  if (note || changes.length || intent === "close" || intent === "reopen") {
    const finalNote = note || (intent === "close" ? "Concluido" : intent === "reopen" ? "Ocorrência reaberta" : changes.join("; "));
    const historyNote = note && changes.length ? `${note} (${changes.join("; ")})` : finalNote;
    appendHistory(breakdown, finalStatus, historyNote, todayISO());
    auditEvent = logAudit(breakdown, intent === "close" ? "Concluída" : intent === "reopen" ? "Reaberta" : "Atualização", historyNote);
    trelloNote = historyNote;
  }

  saveState();
  showToast(intent === "close" ? "Avaria concluída." : intent === "reopen" ? "Ocorrência reaberta." : "Atualização guardada.");
  render();
  if (typeof syncBreakdownToTrello === "function" && trelloNote) {
    syncBreakdownToTrello(breakdown, trelloNote);
  }
  await persistRemoteSafely(async () => {
    await persistBreakdownRemote(breakdown);
    await persistAuditRemote(auditEvent);
  });
}

async function uploadBreakdownAttachments(breakdownId, fileList) {
  const files = Array.from(fileList || []).filter((file) => file && file.size > 0);
  if (!files.length) return [];
  if (!remoteStatus.ready || !remoteClient) {
    throw new Error("base partilhada não ligada");
  }

  updateSyncStatus("A carregar anexos", "syncing", true);
  const uploaded = [];
  for (const [index, file] of files.entries()) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new Error(`${file.name} excede 10 MB`);
    }

    const path = `${breakdownId}/${Date.now()}-${index}-${cleanStorageFileName(file.name)}`;
    const { error } = await remoteClient.storage
      .from(ATTACHMENT_BUCKET)
      .upload(path, file, {
        cacheControl: "3600",
        contentType: file.type || "application/octet-stream",
        upsert: false
      });
    if (error) throw error;

    const { data } = remoteClient.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);
    uploaded.push({
      name: file.name || "Anexo",
      path,
      url: data?.publicUrl || "",
      type: file.type || "",
      size: file.size || 0,
      uploadedAt: new Date().toISOString()
    });
  }
  updateSyncStatus("Partilhado em tempo real", "remote", true);
  return uploaded;
}

async function handleNewBreakdown(form) {
  const data = new FormData(form);
  const plateInput = String(data.get("plate") || "").trim();
  const fleetItem = findFleetByPlate(plateInput);
  const plateField = form.querySelector("#new-plate");
  if (!fleetItem) {
    if (plateField) {
      plateField.setCustomValidity("Escolha uma matrícula existente na frota.");
      plateField.reportValidity();
    }
    showToast("Matrícula não encontrada na frota.");
    return;
  }
  if (plateField) plateField.setCustomValidity("");
  const equipment = fleetItem.equipment;
  const reportedAt = String(data.get("reportedAt") || todayISO());
  const description = String(data.get("description") || "").trim();
  const id = generateId();
  const wasRemoteReady = remoteStatus.ready;
  let attachments = [];
  try {
    attachments = await uploadBreakdownAttachments(id, form.elements.attachments?.files || []);
  } catch (error) {
    console.error(error);
    updateSyncStatus(`Falhou anexo: ${formatRemoteError(error)}`, "error", wasRemoteReady);
    showToast(`Não foi possível guardar o anexo: ${formatRemoteError(error)}`);
    return;
  }
  const attachmentNote = formatAttachmentNames(attachments);
  const breakdown = {
    id,
    equipment,
    plate: fleetItem.plate || plateInput,
    type: String(data.get("type") || "Outro"),
    status: String(data.get("status") || "Parado"),
    situation: String(data.get("situation") || "").trim(),
    reportedAt,
    workshopEntryAt: emptyToNull(data.get("workshopEntryAt")),
    expectedExitAt: emptyToNull(data.get("expectedExitAt")),
    workshopType: String(data.get("workshopType") || ""),
    workshop: String(data.get("workshop") || ""),
    driver: String(data.get("driver") || ""),
    cost: null,
    description,
    lastNote: description,
    lastNoteAt: reportedAt,
    historyNotes: [
      `${reportedAt}: ${description}`,
      attachmentNote ? `${reportedAt}: [Anexos] ${attachmentNote}` : ""
    ].filter(Boolean).join("\n"),
    attachments
  };

  state.breakdowns.unshift(breakdown);
  state.selectedId = breakdown.id;
  state.currentView = "meeting";
  const auditEvent = logAudit(breakdown, "Nova avaria", attachmentNote ? `${description} | Anexos: ${attachmentNote}` : description);
  saveState();
  showToast("Nova avaria criada.");
  render();
  if (typeof syncBreakdownToTrello === "function") {
    syncBreakdownToTrello(breakdown, "");
  }
  await persistRemoteSafely(async () => {
    await persistBreakdownRemote(breakdown);
    await persistAuditRemote(auditEvent);
  });
}

async function closeBreakdown(id) {
  const breakdown = state.breakdowns.find((item) => item.id === id);
  if (!breakdown || breakdown.status === "Concluido") return;
  breakdown.status = "Concluido";
  appendHistory(breakdown, "Concluido", "Concluido pela lista", todayISO());
  const auditEvent = logAudit(breakdown, "Concluída", "Concluido pela lista");
  saveState();
  showToast("Avaria concluída.");
  render();
  if (typeof syncBreakdownToTrello === "function") {
    syncBreakdownToTrello(breakdown, "Concluído pela lista");
  }
  await persistRemoteSafely(async () => {
    await persistBreakdownRemote(breakdown);
    await persistAuditRemote(auditEvent);
  });
}

function appendHistory(breakdown, status, note, date) {
  const cleanNote = note.trim() || "Atualização registada";
  const line = `${date}: [${status}] ${cleanNote}`;
  breakdown.historyNotes = [breakdown.historyNotes, line].filter(Boolean).join("\n");
  breakdown.lastNote = cleanNote;
  breakdown.lastNoteAt = date;
}

function logAudit(breakdown, action, note) {
  const auditEvent = {
    id: `${breakdown.id}-${Date.now()}`,
    breakdownId: breakdown.id,
    equipment: breakdown.equipment,
    plate: breakdown.plate,
    at: new Date().toISOString(),
    action,
    status: breakdown.status,
    note
  };
  state.audit.unshift(auditEvent);
  return auditEvent;
}

function logFleetAudit(item, field, previous, next) {
  const labels = {
    fleetCompany: "Empresa",
    inspectionAt: "Data de inspeção",
    tachographAt: "Data de aferição tacógrafo",
    compressorReviewAt: "Data de revisão compressor",
    wheelHubReviewAt: "Data revisão cubos de roda"
  };
  const auditEvent = {
    id: `FROTA-${item.equipment}-${field}-${Date.now()}`,
    breakdownId: "",
    equipment: item.equipment,
    plate: item.plate,
    at: new Date().toISOString(),
    action: `Frota: ${labels[field] || field}`,
    status: "",
    note: `${previous || "-"} > ${next || "-"}`
  };
  state.audit.unshift(auditEvent);
  return auditEvent;
}

function getMetrics() {
  const active = state.breakdowns.filter((item) => item.status !== "Concluido");
  const activeFleet = state.fleet.filter((item) => item.status === "Ativa").length || state.fleet.length || 1;
  return {
    active: active.length,
    activePercent: Math.round((active.length / activeFleet) * 100),
    stopped: active.filter((item) => item.status === "Parado").length,
    waitingWorkshop: active.filter((item) => item.situation === "Aguarda entrada na oficina").length,
    canCirculate: active.filter((item) => item.status === "Pode circular").length,
    overdue: active.filter(isOverdue).length,
    closed: state.breakdowns.filter((item) => item.status === "Concluido").length
  };
}

function getManagementMetrics() {
  const active = state.breakdowns.filter((item) => item.status !== "Concluido");
  return {
    waitingWorkshop: active.filter((item) => item.situation === "Aguarda entrada na oficina").length,
    inWorkshop: active.filter((item) => item.situation === "Em oficina").length,
    waitingParts: active.filter((item) => item.situation === "Aguarda peças").length,
    externalWorkshop: active.filter((item) => normalizeText(item.workshopType) === "externa").length,
    avgInternalResolution: averageResolutionDays("Interna"),
    avgExternalResolution: averageResolutionDays("Externa")
  };
}

function averageResolutionDays(workshopType) {
  const values = state.breakdowns
    .filter((item) => item.status === "Concluido" && normalizeText(item.workshopType) === normalizeText(workshopType))
    .map((item) => {
      const start = item.workshopEntryAt || item.reportedAt;
      const end = item.lastNoteAt;
      if (!start || !end) return null;
      return Math.max(0, daysBetween(start, end));
    })
    .filter((value) => Number.isFinite(value));

  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatDaysMetric(value) {
  if (!Number.isFinite(value)) return "-";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} dias`;
}

function getFleetDateAlerts() {
  const fields = [
    ["inspectionAt", "Inspeção"],
    ["tachographAt", "Aferição tacógrafo"],
    ["compressorReviewAt", "Revisão compressor"],
    ["wheelHubReviewAt", "Cubos de roda"]
  ];

  return state.fleet
    .flatMap((item) => fields
      .filter(([field]) => item[field] && isFleetDateApplicable(item, field))
      .map(([field, label]) => ({
        equipment: item.equipment,
        plate: item.plate,
        label,
        date: item[field],
        days: daysUntil(item[field])
      })))
    .sort((a, b) => a.days - b.days);
}

function isFleetDateApplicable(item, field) {
  if (field === "inspectionAt") return true;
  const isTruck = isTruckEquipment(item);
  if (field === "tachographAt" || field === "wheelHubReviewAt") return isTruck;
  if (field === "compressorReviewAt") return isPlainTruck(item);
  return false;
}

function isTruckEquipment(item) {
  return normalizeText(item.description).includes("camiao");
}

function isPlainTruck(item) {
  const description = normalizeText(item.description);
  return description.includes("camiao") && !description.includes("rigido") && !description.includes("grua");
}

function getDueState(dateValue) {
  if (!dateValue) return { className: "empty", label: "Sem data" };
  const days = daysUntil(dateValue);
  if (!Number.isFinite(days)) return { className: "empty", label: "Sem data" };
  if (days < 0) return { className: "red", label: `Vencido há ${Math.abs(days)} d` };
  if (days < 60) return { className: "red", label: `${days} d` };
  if (days <= 120) return { className: "yellow", label: `${days} d` };
  return { className: "green", label: `${days} d` };
}

function daysUntil(dateValue) {
  if (!dateValue) return Number.NaN;
  return daysBetween(todayISO(), dateValue);
}

function getFilteredBreakdowns(activeOnly) {
  const search = normalizeText(state.filters.search);
  let list = state.breakdowns.filter((item) => !activeOnly || item.status !== "Concluido");
  if (state.filters.status) list = list.filter((item) => item.status === state.filters.status);
  if (state.filters.situation) list = list.filter((item) => item.situation === state.filters.situation);
  if (state.filters.type) list = list.filter((item) => item.type === state.filters.type);
  if (search) {
    list = list.filter((item) => {
      const haystack = normalizeText(`${item.id} ${item.equipment} ${item.plate} ${item.type} ${item.status} ${item.situation} ${item.workshop} ${item.description} ${item.lastNote} ${formatAttachmentNames(item.attachments)}`);
      return haystack.includes(search);
    });
  }
  return sortedBreakdowns(list);
}

function getFilteredFleet() {
  const search = normalizeText(state.filters.fleetSearch);
  return state.fleet.filter((item) => {
    const haystack = normalizeText(`${item.equipment} ${item.plate} ${item.description} ${item.brand} ${item.status} ${item.fleetCompany}`);
    return !search || haystack.includes(search);
  });
}

function getFilteredAudit() {
  const search = normalizeText(state.filters.auditSearch);
  return state.audit.filter((item) => {
    const haystack = normalizeText(`${item.breakdownId} ${item.equipment} ${item.plate} ${item.action} ${item.note}`);
    return !search || haystack.includes(search);
  });
}

function sortBreakdownsByDate(list, direction) {
  const factor = direction === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const dateA = a.reportedAt || "";
    const dateB = b.reportedAt || "";
    if (dateA !== dateB) {
      if (!dateA) return 1;
      if (!dateB) return -1;
      return dateA < dateB ? -factor : factor;
    }
    return String(a.id) < String(b.id) ? -factor : factor;
  });
}

function sortedBreakdowns(list) {
  const priority = {
    Parado: 1,
    Agendado: 2,
    "Pode circular": 3,
    Concluido: 6
  };
  return [...list].sort((a, b) => {
    if (isOverdue(a) !== isOverdue(b)) return isOverdue(a) ? -1 : 1;
    const statusDiff = (priority[a.status] || 9) - (priority[b.status] || 9);
    if (statusDiff) return statusDiff;
    return daysOpen(b) - daysOpen(a);
  });
}

function ensureSelected(list) {
  if (list.some((item) => item.id === state.selectedId)) return;
  state.selectedId = list[0]?.id || state.breakdowns[0]?.id || "";
}

function parseHistory(historyNotes) {
  if (!historyNotes) return [];
  return String(historyNotes)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d{4}-\d{2}-\d{2}):\s*(?:\[(.+?)\]\s*)?(.*)$/);
      if (!match) return { date: "", status: "", note: line };
      return { date: match[1], status: match[2] || "", note: match[3] || "" };
    })
    .reverse();
}

function renderAttachments(breakdown) {
  const attachments = normalizeAttachments(breakdown.attachments);
  if (!attachments.length) return "";
  return `
    <div class="attachments-panel">
      <h3>Anexos</h3>
      <div class="attachment-list">
        ${attachments.map((attachment) => renderAttachmentItem(attachment)).join("")}
      </div>
    </div>
  `;
}

function renderAttachmentItem(attachment) {
  const url = getAttachmentUrl(attachment);
  const name = attachment.name || "Anexo";
  const preview = isImageAttachment(attachment) && url
    ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(name)}">`
    : `<span data-icon="paperclip"></span>`;
  const linkContent = `
    <span class="attachment-preview">${preview}</span>
    <span class="attachment-text">
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(formatFileSize(attachment.size))}</small>
    </span>
  `;

  if (!url) {
    return `<article class="attachment-item">${linkContent}</article>`;
  }

  return `
    <a class="attachment-item" href="${escapeAttr(url)}" target="_blank" rel="noopener">
      ${linkContent}
    </a>
  `;
}

function renderAttachmentMeta(breakdown) {
  const count = normalizeAttachments(breakdown.attachments).length;
  if (!count) return "";
  return `<span>Anexos: ${count}</span>`;
}

function renderAttachmentSummary(breakdown) {
  const count = normalizeAttachments(breakdown.attachments).length;
  if (!count) return "-";
  return `<span class="attachment-count"><span data-icon="paperclip"></span>${count}</span>`;
}

function statusBadge(status) {
  return `<span class="badge ${statusClass(status)}">${escapeHtml(status || "Sem estado")}</span>`;
}

function statusClass(status) {
  const normalized = normalizeText(status);
  if (normalized.includes("parado")) return "parado";
  if (normalized.includes("pode circular")) return "circula";
  if (normalized.includes("agendado")) return "agendado";
  if (normalized.includes("concluido")) return "concluido";
  return "";
}

function isOverdue(breakdown) {
  return breakdown.status !== "Concluido" && breakdown.expectedExitAt && breakdown.expectedExitAt < todayISO();
}

function daysOpen(breakdown) {
  const end = breakdown.status === "Concluido" ? (breakdown.lastNoteAt || todayISO()) : todayISO();
  return Math.max(0, daysBetween(breakdown.reportedAt || todayISO(), end));
}

function daysBetween(start, end) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  return Math.round((endDate - startDate) / 86400000);
}

function summarizeChanges(previous, next) {
  const changes = [];
  if (previous.status !== next.status) changes.push(`estado: ${previous.status || "-"} > ${next.status || "-"}`);
  if ((previous.situation || "") !== (next.situation || "")) changes.push(`situação: ${previous.situation || "-"} > ${next.situation || "-"}`);
  if ((previous.expectedExitAt || "") !== (next.expectedExitAt || "")) changes.push(`prev. saída: ${formatDate(previous.expectedExitAt)} > ${formatDate(next.expectedExitAt)}`);
  if ((previous.workshopEntryAt || "") !== (next.workshopEntryAt || "")) changes.push(`entrada oficina: ${formatDate(previous.workshopEntryAt)} > ${formatDate(next.workshopEntryAt)}`);
  if ((previous.workshop || "") !== (next.workshop || "")) changes.push(`oficina: ${previous.workshop || "-"} > ${next.workshop || "-"}`);
  if ((previous.type || "") !== (next.type || "")) changes.push(`tipo: ${previous.type || "-"} > ${next.type || "-"}`);
  if ((previous.driver || "") !== (next.driver || "")) changes.push(`motorista: ${previous.driver || "-"} > ${next.driver || "-"}`);
  if ((previous.description || "") !== (next.description || "")) changes.push(`descrição: ${truncateForHistory(previous.description)} > ${truncateForHistory(next.description)}`);
  return changes;
}

function truncateForHistory(value) {
  const clean = String(value || "").trim();
  if (!clean) return "-";
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

function fillFleetMatchFromPlate(value, commitPlate) {
  const match = findFleetByPlate(value);
  const equipment = document.querySelector("#new-equipment");
  const plate = document.querySelector("#new-plate");
  if (equipment) equipment.value = match?.equipment || "";
  if (plate) {
    plate.setCustomValidity("");
    if (commitPlate && match?.plate) plate.value = match.plate;
  }
}

function findFleetByPlate(value) {
  const plate = normalizePlate(value);
  if (!plate) return null;
  return state.fleet.find((item) => normalizePlate(item.plate) === plate) || null;
}

function setFilter(name, value) {
  state.filters[name] = value;
  saveState();
  render(`[data-filter="${name}"]`);
}

function exportActivePanelExcel() {
  const workbook = buildActivePanelWorkbook();

  if (window.XLSX) {
    const xlsxWorkbook = XLSX.utils.book_new();
    const usedNames = new Set();
    workbook.tables.forEach((table, index) => {
      const rows = [table.columns, ...table.rows.map((row) => row.map((cell) => cell ?? ""))];
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      sheet["!cols"] = table.columns.map((column, columnIndex) => {
        const longest = Math.max(
          String(column).length,
          ...table.rows.map((row) => String(row[columnIndex] ?? "").length)
        );
        return { wch: Math.min(50, longest + 2) };
      });
      let name = sanitizeSheetName(table.title || `Folha${index + 1}`);
      while (usedNames.has(name)) name = sanitizeSheetName(`${name.slice(0, 28)}_${index + 1}`);
      usedNames.add(name);
      XLSX.utils.book_append_sheet(xlsxWorkbook, sheet, name);
    });
    XLSX.writeFile(xlsxWorkbook, `${workbook.fileName}.xlsx`);
    showToast("Excel preparado.");
    return;
  }

  const html = buildExcelHtml(workbook);
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${workbook.fileName}.xls`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("Excel preparado.");
}

function sanitizeSheetName(name) {
  return String(name).replace(/[\\\/\?\*\[\]:]/g, " ").trim().slice(0, 31) || "Folha";
}

function buildActivePanelWorkbook() {
  const view = state.currentView;
  const builders = {
    dashboard: buildDashboardExport,
    meeting: buildMeetingExport,
    breakdowns: buildBreakdownsExport,
    new: buildMeetingExport,
    fleet: buildFleetExport,
    audit: buildAuditExport,
    custos: buildCustosExport
  };
  return (builders[view] || buildBreakdownsExport)();
}

function buildDashboardExport() {
  const management = getManagementMetrics();
  return {
    title: "Dashboard",
    fileName: `dashboard-avarias-${todayISO()}`,
    tables: [
      {
        title: "Indicadores de gestão",
        columns: ["Indicador", "Valor", "Descrição"],
        rows: [
          ["Aguarda oficina", management.waitingWorkshop, "Avarias abertas a aguardar entrada na oficina"],
          ["Em oficina", management.inWorkshop, "Avarias abertas com viatura em oficina"],
          ["Aguarda peças", management.waitingParts, "Avarias abertas a aguardar peças"],
          ["Oficina externa", management.externalWorkshop, "Avarias abertas em oficina externa"],
          ["Tempo médio interna", formatDaysMetric(management.avgInternalResolution), "Entrada em oficina até conclusão"],
          ["Tempo médio externa", formatDaysMetric(management.avgExternalResolution), "Entrada em oficina até conclusão"]
        ]
      },
      {
        title: "Próximas datas de frota",
        columns: ["Equipamento", "Matrícula", "Tipo", "Data", "Dias", "Estado"],
        rows: getFleetDateAlerts().map((item) => [
          item.equipment,
          item.plate || "",
          item.label,
          item.date,
          item.days,
          getDueState(item.date).label
        ])
      }
    ]
  };
}

function buildMeetingExport() {
  return {
    title: "Reunião",
    fileName: `reuniao-avarias-${todayISO()}`,
    tables: [buildBreakdownsTable("Avarias abertas", getFilteredBreakdowns(true))]
  };
}

function buildBreakdownsExport() {
  return {
    title: "Avarias",
    fileName: `avarias-${todayISO()}`,
    tables: [buildBreakdownsTable("Avarias", sortBreakdownsByDate(getFilteredBreakdowns(false), state.breakdownsSort))]
  };
}

function buildFleetExport() {
  const activeCounts = state.breakdowns.reduce((acc, item) => {
    if (item.status !== "Concluido") acc[item.equipment] = (acc[item.equipment] || 0) + 1;
    return acc;
  }, {});
  return {
    title: "Frota",
    fileName: `frota-${todayISO()}`,
    tables: [
      {
        title: "Frota",
        columns: [
          "Equipamento",
          "Matrícula",
          "Descrição",
          "Marca",
          "Ano",
          "Estado",
          "Empresa",
          "Avarias abertas",
          "Data inspeção",
          "Dias inspeção",
          "Data aferição tacógrafo",
          "Dias tacógrafo",
          "Data revisão compressor",
          "Dias compressor",
          "Data cubos roda",
          "Dias cubos roda"
        ],
        rows: getFilteredFleet().map((item) => [
          item.equipment,
          item.plate || "",
          item.description || "",
          item.brand || item.model || "",
          item.year || "",
          item.status || "",
          item.fleetCompany || "",
          activeCounts[item.equipment] || 0,
          item.inspectionAt || "",
          formatDueForExport(item.inspectionAt, item, "inspectionAt"),
          isFleetDateApplicable(item, "tachographAt") ? item.tachographAt || "" : "N/A",
          isFleetDateApplicable(item, "tachographAt") ? formatDueForExport(item.tachographAt, item, "tachographAt") : "N/A",
          isFleetDateApplicable(item, "compressorReviewAt") ? item.compressorReviewAt || "" : "N/A",
          isFleetDateApplicable(item, "compressorReviewAt") ? formatDueForExport(item.compressorReviewAt, item, "compressorReviewAt") : "N/A",
          isFleetDateApplicable(item, "wheelHubReviewAt") ? item.wheelHubReviewAt || "" : "N/A",
          isFleetDateApplicable(item, "wheelHubReviewAt") ? formatDueForExport(item.wheelHubReviewAt, item, "wheelHubReviewAt") : "N/A"
        ])
      }
    ]
  };
}

function buildAuditExport() {
  return {
    title: "Rastreio",
    fileName: `rastreio-avarias-${todayISO()}`,
    tables: [
      {
        title: "Eventos",
        columns: ["Data", "Avaria", "Equipamento", "Matrícula", "Ação", "Estado", "Nota"],
        rows: getFilteredAudit().map((item) => [
          formatDateTime(item.at),
          item.breakdownId || "",
          item.equipment || "",
          item.plate || "",
          item.action || "",
          item.status || "",
          item.note || ""
        ])
      },
      {
        title: "Histórico de reunião",
        columns: ["Data", "Com avaria", "Paradas", "Aguarda oficina", "Podem circular", "Em atraso", "Nota"],
        rows: state.snapshots.map((item) => [
          item.date,
          item.active || 0,
          item.stopped || 0,
          item.waitingWorkshop || 0,
          item.canCirculate || 0,
          item.overdue || 0,
          item.meetingNote || ""
        ])
      }
    ]
  };
}

function buildCustosExport() {
  const sorted = [...state.custos].sort((a, b) => b.month.localeCompare(a.month) || a.plate.localeCompare(b.plate));
  return {
    title: "Portagens",
    fileName: `portagens-${todayISO()}`,
    tables: [{
      title: "Portagens por viatura e mês",
      columns: ["Mês", "Matrícula", "Total (€)", "Ficheiro", "Importado em", "Por"],
      rows: sorted.map((item) => [
        formatMonth(item.month),
        item.plate,
        item.amount.toFixed(2),
        item.sourceFile,
        formatDate(item.importedAt?.slice(0, 10)),
        item.importedBy
      ])
    }]
  };
}

function buildBreakdownsTable(title, list) {
  return {
    title,
    columns: ["ID", "Equipamento", "Matrícula", "Tipo", "Estado", "Situação", "Anexos", "Links anexos", "Data avaria", "Entrada oficina", "Prev. saída", "Tipo oficina", "Oficina", "Motorista", "Custo", "Descrição", "Última nota", "Data nota"],
    rows: list.map((item) => [
      item.id,
      item.equipment || "",
      item.plate || "",
      item.type || "",
      item.status || "",
      item.situation || "",
      formatAttachmentNames(item.attachments),
      formatAttachmentLinks(item.attachments),
      item.reportedAt || "",
      item.workshopEntryAt || "",
      item.expectedExitAt || "",
      item.workshopType || "",
      item.workshop || "",
      item.driver || "",
      item.cost || "",
      item.description || "",
      item.lastNote || "",
      item.lastNoteAt || ""
    ])
  };
}

function buildExcelHtml(workbook) {
  const tables = workbook.tables.map((table) => `
    <h2>${escapeHtml(table.title)}</h2>
    <table>
      <thead>
        <tr>${table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell ?? "")}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
    <br>
  `).join("");

  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; }
          h1 { font-size: 20px; }
          h2 { font-size: 16px; margin-top: 18px; }
          table { border-collapse: collapse; }
          th, td { border: 1px solid #999; padding: 6px; mso-number-format:"\\@"; }
          th { background: #e8f3f1; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(workbook.title)} · ${formatDate(todayISO())}</h1>
        ${tables}
      </body>
    </html>`;
}

function formatDueForExport(dateValue, item, field) {
  if (!isFleetDateApplicable(item, field)) return "N/A";
  if (!dateValue) return "Sem data";
  return getDueState(dateValue).label;
}

function hydrateIcons() {
  document.querySelectorAll("[data-icon]").forEach((element) => {
    const name = element.dataset.icon;
    if (icons[name]) element.innerHTML = icons[name];
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 2400);
}

function generateId() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
  return `AV${stamp}${Math.floor(Math.random() * 90 + 10)}`;
}

function todayISO() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-PT").format(date);
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-PT", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function normalizeEquipment(value) {
  const clean = String(value || "").trim();
  const numeric = Number(clean);
  return Number.isFinite(numeric) && clean !== "" ? numeric : clean;
}

function normalizePlate(value) {
  return normalizeText(value).replace(/[\s-]/g, "");
}

function emptyToNull(value) {
  const clean = String(value || "").trim();
  return clean || null;
}

function normalizeAttachments(value) {
  let items = value;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      name: String(item?.name || item?.fileName || item?.path || "Anexo"),
      path: String(item?.path || ""),
      url: String(item?.url || ""),
      type: String(item?.type || item?.mimeType || ""),
      size: Number(item?.size || 0),
      uploadedAt: item?.uploadedAt || item?.uploaded_at || ""
    }))
    .filter((item) => item.name || item.path || item.url);
}

function cleanStorageFileName(name) {
  const safeName = String(name || "ficheiro").trim() || "ficheiro";
  const parts = safeName.split(".");
  const extension = parts.length > 1 ? `.${parts.pop()}` : "";
  const base = parts.join(".") || "ficheiro";
  const cleanBase = normalizeText(base)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "ficheiro";
  const cleanExtension = normalizeText(extension).replace(/[^a-z0-9.]+/g, "").slice(0, 12);
  return `${cleanBase}${cleanExtension}`;
}

function isImageAttachment(attachment) {
  const type = String(attachment.type || "");
  const name = String(attachment.name || attachment.path || "");
  return type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

function getAttachmentUrl(attachment) {
  if (attachment.url) return attachment.url;
  if (!attachment.path || !remoteClient) return "";
  const { data } = remoteClient.storage.from(ATTACHMENT_BUCKET).getPublicUrl(attachment.path);
  return data?.publicUrl || "";
}

function formatAttachmentNames(value) {
  return normalizeAttachments(value).map((item) => item.name || item.path || "Anexo").join(", ");
}

function formatAttachmentLinks(value) {
  return normalizeAttachments(value).map((item) => getAttachmentUrl(item)).filter(Boolean).join(" | ");
}

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return "Tamanho não registado";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
