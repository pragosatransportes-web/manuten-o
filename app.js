const STORAGE_KEY = "gestao-avarias-state-v1";
const ATTACHMENT_BUCKET = "avarias-anexos";
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
// Data sentinela para representar "N/A" nos campos de data da frota.
// As colunas são do tipo `date` na base de dados, por isso usamos uma data válida
// (e impossível na prática) em vez do texto "N/A", para a sincronização funcionar.
const FLEET_NA_DATE = "9999-12-31";

// A coluna "driver" da frota depende da migração 002. Até ela existir na base,
// não podemos incluir o campo nas gravações (partiria todo o upsert da frota).
// Detetado no carregamento remoto: ver loadRemoteState().
let remoteFleetHasDriver = true;

// Tipos de ausência de motorista (calendário de ausências, migração 003).
const ABSENCE_TYPES = ["Férias", "Baixa médica"];

// Descrições padronizadas dos equipamentos (menu na Frota).
const FLEET_DESCRIPTIONS = [
  "Trator",
  "Semi-reboque basculante",
  "Semi-reboque cisterna",
  "Porta-máquinas",
  "Carro Grua",
  "Xico",
  "Carro Cola",
  "Carro Água",
  "Estrado"
];

// Mês em foco no calendário de ausências, no formato "YYYY-MM".
function currentMonthISO() {
  return todayISO().slice(0, 7);
}

// Importação inicial de motoristas por equipamento (afetação trator + reboque).
// Enquanto a coluna "driver" não existe na base, o motorista vive localmente:
// esta importação preenche-o uma vez por dispositivo, e SÓ onde ainda está vazio
// (não sobrepõe nomes já escritos manualmente).
const DRIVER_IMPORT_KEY = "avarias-driver-import-2026-07c";
const DRIVER_ASSIGNMENTS = {
  "856": "José Marçal",        "815": "José Marçal",
  "882": "Miguel Quaresma",    "829": "Miguel Quaresma",
  "859": "Tiago Reis",         "836": "Tiago Reis",
  "868": "Ricardo Campos",     "860": "Ricardo Campos",
  "881": "Inácio Martins",     "841": "Inácio Martins",     "894": "Inácio Martins",
  "857": "Guilherme Marques",  "845": "Guilherme Marques",
  "883": "Paulo Vala",         "854": "Paulo Vala",
  "884": "Paulo Monteiro",     "834": "Paulo Monteiro",
  "885": "Nuno Lopes",         "832": "Nuno Lopes",
  "886": "Licinio Ovelheiro",  "839": "Licinio Ovelheiro",
  "887": "Igor Silva",         "844": "Igor Silva",         "855": "Igor Silva",
  "888": "Júlio Rodrigues",    "818": "Júlio Rodrigues",
  "889": "Álvaro Silva",       "825": "Álvaro Silva",
  "890": "Carlos Carvalho",    "830": "Carlos Carvalho",
  "893": "Diogo Santos",       "870": "Diogo Santos",
  "864": "Ricardo Figueira",   "876": "Ricardo Figueira",   "848": "Ricardo Figueira",
  "866": "Vitor Ribeiro",      "40145": "Vitor Ribeiro",
  "891": "José Vilela",        "849": "José Vilela",         "896": "José Vilela",
  "892": "Sérgio Cunha",       "40146": "Sérgio Cunha",
  "867": "Bruno Silva",        "862": "Bruno Silva",
  // 2ª leva (indicada por matrícula, resolvida para nº de equipamento)
  "70030": "Vitor Januário",     "5270": "Vitor Januário",
  "5269": "Amilcar Carreira",    "5204": "Amilcar Carreira",
  "5380": "Francisco Leitão",    "5115": "Francisco Leitão",
  "5381": "Agostinho Louro",     "5330": "Agostinho Louro",
  "5379": "Nuno Amaro",          "40143": "Nuno Amaro",
  "5378": "Carmino Calixto",     "40144": "Carmino Calixto",
  "5258": "Bernardo Fale",       "70029": "Bernardo Fale",
  "5295": "Celso Cristo",        "5303": "Celso Cristo",
  "5296": "João Maximiano",      "5337": "João Maximiano",
  "70259": "Suplente",
  "5348": "João Almeida",
  "5298": "José Miguel Ferreira",
  "70025": "Andressa Oliveira",
  "70023": "Pedro Henriques",
  "5347": "António Luís",
  "70021": "Luís Bernardo",
  "5299": "Adriano Machado",
  "70024": "Carlos Cerejo",
  "70027": "Mário Gomes",
  "70022": "Cátia Romão",
  "5206": "Rúben Ferreira",
  "5196": "Alex",
  "5104": "José Pascoal",
  "5323": "Paulo Fritz",
  "5245": "Tiago Faria",
  "5297": "Adriano Sousa",       "5276": "Adriano Sousa",
  "5316": "José Pereira",
  "70028": "Ricardo Machado"
};

function applyDriverImport() {
  try { if (localStorage.getItem(DRIVER_IMPORT_KEY)) return 0; } catch { /* localStorage indisponível */ }
  let applied = 0;
  for (const [equip, driver] of Object.entries(DRIVER_ASSIGNMENTS)) {
    const item = state.fleet.find((f) => String(f.equipment) === equip);
    if (item && !(item.driver || "").trim()) {
      item.driver = driver;
      applied += 1;
    }
  }
  try { localStorage.setItem(DRIVER_IMPORT_KEY, new Date().toISOString()); } catch { /* ignore */ }
  return applied;
}

// Checklist de vistoria baseado no modelo "checklist_vistoria_frota.xlsx".
// Secções sem `types` aplicam-se a todos os equipamentos; com `types` só aos tipos indicados.
// (Definidas aqui no topo porque render() é chamado no arranque e pode renderizar a Vistoria.)
const VISTORIA_SECTIONS = [
  { name: "1. Verificação Geral", items: ["Estado geral de limpeza", "Danos visíveis na estrutura/chassis", "Corrosão ou fissuras", "Matrículas legíveis e fixas", "Guarda-lamas e proteções"] },
  { name: "2. Pneus e Rodas", items: ["Desgaste irregular", "Danos/cortes/bolhas", "Pressão aparente", "Estado das jantes"] },
  { name: "3. Sinalização", items: ["Refletores e sinalização"] },
  { name: "4. Fugas e Componentes", items: ["Tubagens e mangueiras", "Cablagens visíveis"] },
  { name: "5. Segurança e Cabina", types: ["Trator/Camião"], items: ["Para-brisas e espelhos", "Escovas limpa-vidros", "Buzina", "Cinto de segurança", "Extintor válido", "Colete refletor / triângulo"] },
  { name: "6. Trator", types: ["Trator/Camião"], items: ["Estado da roda suplente", "Sistema de bloqueio", "Degraus e pega-mãos"] },
  { name: "7. Semi-reboque Basculante", types: ["Semi-reboque Basculante"], items: ["Estado da caixa", "Fissuras estruturais", "Fechos porta traseira", "Lona/cobertura", "Articulações e pivôs"] },
  { name: "8. Porta-Máquinas", types: ["Porta-Máquinas"], items: ["Estrutura geral", "Estado das rampas", "Pontos de amarração", "Piso antiderrapante", "Estado do piso"] },
  { name: "9. Estrados", types: ["Estrados"], items: ["Estado do piso", "Estrutura geral", "Pontos de amarração", "Laterais/rebordos", "Estado do chassis"] }
];

const VISTORIA_TYPES = ["Trator/Camião", "Semi-reboque Basculante", "Porta-Máquinas", "Estrados", "Semi-reboque Caixa", "Cisterna", "Outro"];
const VISTORIA_STATES = ["OK", "SOB OBS", "CRÍTICO", "N/A"];
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
  sort: '<svg viewBox="0 0 24 24"><path d="m3 8 4-4 4 4"></path><path d="M7 4v16"></path><path d="m21 16-4 4-4-4"></path><path d="M17 20V4"></path></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>'
};

let state = loadState();

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const view = button.dataset.view;
  if (view) {
    // Abandonar uma ligação vistoria→avaria pendente se sair sem registar a avaria.
    if (view !== "new") state.avariaFromVistoria = null;
    // Ao clicar no separador Reunião: workspace se houver reunião a decorrer, senão o ecrã inicial.
    if (view === "meeting") state.meetingView = getActiveMeeting() ? "work" : "home";
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
  if (action === "import-drivers-trello" && typeof importDriversFromTrello === "function") {
    await importDriversFromTrello();
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
    state.meetingView = "work";
    saveState();
    render();
  }
  if (action === "open-meeting") {
    openMeeting();
  }
  if (action === "close-meeting") {
    await closeMeeting();
  }
  if (action === "dock-toggle") {
    state.meetingDockCollapsed = !state.meetingDockCollapsed;
    saveState();
    updateMeetingDock();
  }
  if (action === "dock-task-toggle") {
    toggleMeetingTask(button.dataset.id);
  }
  if (action === "meeting-consult") {
    state.meetingView = "consult";
    state.currentView = "meeting";
    saveState();
    render();
  }
  if (action === "meeting-home") {
    state.meetingView = "home";
    saveState();
    render();
  }
  if (action === "select-meeting") {
    state.selectedMeetingId = button.dataset.id;
    state.meetingView = "report";
    state.currentView = "meeting";
    saveState();
    render();
  }
  if (action === "export-meeting") {
    exportMeetingReportExcel(button.dataset.id);
  }
  if (action === "email-meeting") {
    emailMeetingReport(button.dataset.id);
  }
  if (action === "close-breakdown") {
    await closeBreakdown(button.dataset.id);
  }
  if (action === "dashboard-date-tab") {
    state.dashboardDateTab = button.dataset.field;
    saveState();
    render();
  }
  if (action === "toggle-breakdown-sort") {
    state.breakdownsSort = state.breakdownsSort === "desc" ? "asc" : "desc";
    saveState();
    render();
  }
  if (action === "delete-fleet") {
    await deleteFleetItem(button.dataset.equipment);
  }
  if (action === "ausencia-prev-month") shiftAusenciaMonth(-1);
  if (action === "ausencia-next-month") shiftAusenciaMonth(1);
  if (action === "ausencia-today") {
    state.ausenciaMonth = currentMonthISO();
    saveState();
    render();
  }
  if (action === "delete-ausencia") {
    await deleteAusencia(button.dataset.id);
  }
  if (action === "fleet-date-na") {
    await updateFleetDate(button.dataset.equipment, button.dataset.field, FLEET_NA_DATE);
  }
  if (action === "fleet-date-reset") {
    await updateFleetDate(button.dataset.equipment, button.dataset.field, "");
  }
  if (action === "vistoria-subview") {
    state.vistoriaSubView = button.dataset.subview;
    saveState();
    render();
  }
  if (action === "select-vistoria") {
    state.selectedVistoriaId = button.dataset.id;
    state.vistoriaSubView = "detail";
    state.currentView = "vistoria";
    saveState();
    render();
  }
  if (action === "delete-vistoria") {
    await deleteVistoria(button.dataset.id);
  }
  if (action === "edit-vistoria") {
    state.selectedVistoriaId = button.dataset.id || state.selectedVistoriaId;
    state.vistoriaSubView = "edit";
    saveState();
    render();
  }
  if (action === "avaria-from-vistoria") {
    startAvariaFromVistoria(button.dataset.id, button.dataset.section, button.dataset.item);
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
  if (target.dataset.fleetDriver) {
    await updateFleetDriver(target.dataset.equipment, target.value);
  }
  if (target.dataset.fleetDescription) {
    await updateFleetDescription(target.dataset.equipment, target.value);
  }
  if (target.id === "new-plate") {
    fillFleetMatchFromPlate(target.value, true);
  }
  if (target.id === "vistoria-plate") {
    fillVistoriaFromPlate(target.value);
  }
  if (target.id === "vistoria-type") {
    applyVistoriaTypeVisibility(target.value);
  }
  if (target.dataset.viPhoto !== undefined && target.type === "file") {
    const label = target.closest(".vistoria-item__photo");
    const n = target.files?.length || 0;
    if (label) {
      label.classList.toggle("has-photos", n > 0);
      label.title = n > 0 ? `${n} foto(s) selecionada(s)` : "Anexar foto (opcional)";
    }
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
  if (form.dataset.form === "new-vistoria") {
    event.preventDefault();
    await handleNewVistoria(form);
  }
  if (form.dataset.form === "dock-note") {
    event.preventDefault();
    const data = new FormData(form);
    addMeetingNote(String(data.get("type") || "note"), String(data.get("text") || ""));
  }
  if (form.dataset.form === "new-ausencia") {
    event.preventDefault();
    await handleNewAusencia(form);
  }
  if (form.dataset.form === "edit-vistoria") {
    event.preventDefault();
    await handleEditVistoria(form);
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
    vistoriaSubView: "kpis",
    selectedVistoriaId: "",
    avariaFromVistoria: null,
    meetingView: "home",
    activeMeetingId: "",
    selectedMeetingId: "",
    meetingDockCollapsed: false,
    dockNoteType: "note",
    meetings: [],
    dashboardDateTab: "inspectionAt",
    sourceGeneratedAt: seed.generatedAt || "",
    fleet: seed.fleet || [],
    vistorias: [],
    ausencias: [],
    ausenciaMonth: currentMonthISO(),
    breakdowns,
    snapshots: seed.snapshots || [],
    audit: buildAudit(breakdowns),
    filters: {
      search: "",
      status: "",
      situation: "",
      type: "",
      company: "",
      fleetSearch: "",
      auditSearch: "",
      vistoriaType: "",
      vistoriaResult: ""
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
  const [fleetResult, breakdownsResult, snapshotsResult, auditResult, vistoriasResult, meetingsResult, ausenciasResult] = await Promise.all([
    remoteClient.from("avarias_fleet").select("*").order("equipment", { ascending: true }),
    remoteClient.from("avarias_breakdowns").select("*").order("updated_at", { ascending: false }),
    remoteClient.from("avarias_snapshots").select("*").order("date", { ascending: true }),
    remoteClient.from("avarias_audit_events").select("*").order("at", { ascending: false }),
    remoteClient.from("avarias_vistorias").select("*").order("date", { ascending: false }),
    remoteClient.from("avarias_reunioes").select("*").order("started_at", { ascending: false }),
    remoteClient.from("avarias_ausencias").select("*").order("start_at", { ascending: true })
  ]);

  [fleetResult, breakdownsResult, snapshotsResult, auditResult].forEach((result) => {
    if (result.error) throw result.error;
  });
  // as tabelas de vistorias/reuniões podem ainda não existir — ignora o erro silenciosamente

  // Deteta se a coluna "driver" já existe na base (migração 002). Se as linhas
  // vierem sem a chave, não a enviamos nas gravações para não partir o upsert.
  if (fleetResult.data.length) {
    remoteFleetHasDriver = Object.prototype.hasOwnProperty.call(fleetResult.data[0], "driver");
  }

  if (!fleetResult.data.length && !breakdownsResult.data.length) {
    await seedRemoteDatabase();
    return loadRemoteState();
  }

  const previousView = state.currentView;
  const previousFilters = state.filters;
  const previousSelectedId = state.selectedId;
  const breakdowns = breakdownsResult.data.map(dbBreakdownToApp);
  const selectedExists = breakdowns.some((item) => item.id === previousSelectedId);

  // Enquanto a coluna "driver" não existir na base, o motorista vive só
  // localmente (localStorage). Preserva os nomes já escritos ao recarregar a frota.
  const localDrivers = new Map((state.fleet || []).map((f) => [String(f.equipment), f.driver || ""]));
  const mapFleetRow = (row) => {
    const item = dbFleetToApp(row);
    if (!remoteFleetHasDriver) {
      const localDriver = localDrivers.get(String(item.equipment));
      if (localDriver) item.driver = localDriver;
    }
    return item;
  };

  state = {
    ...state,
    currentView: previousView,
    selectedId: selectedExists ? previousSelectedId : (sortedBreakdowns(breakdowns.filter((item) => item.status !== "Concluido"))[0]?.id || breakdowns[0]?.id || ""),
    fleet: fleetResult.data.map(mapFleetRow),
    vistorias: vistoriasResult.error ? (state.vistorias || []) : vistoriasResult.data.map(dbVistoriaToApp),
    meetings: meetingsResult.error ? (state.meetings || []) : meetingsResult.data.map(dbMeetingToApp),
    ausencias: ausenciasResult.error ? (state.ausencias || []) : ausenciasResult.data.map(dbAusenciaToApp),
    breakdowns,
    snapshots: snapshotsResult.data.map(dbSnapshotToApp),
    audit: auditResult.data.length ? auditResult.data.map(dbAuditToApp) : buildAudit(breakdowns),
    filters: previousFilters
  };
  applyDriverImport();
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
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_vistorias" }, (payload) => {
      applyRemoteRow(payload, "vistorias", dbVistoriaToApp);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_reunioes" }, (payload) => {
      applyRemoteRow(payload, "meetings", dbMeetingToApp);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_ausencias" }, (payload) => {
      applyRemoteRow(payload, "ausencias", dbAusenciaToApp);
    })
    .subscribe();
}

function applyRemoteRow(payload, collection, mapper) {
  const row = payload.eventType === "DELETE" ? payload.old : payload.new;
  if (!row) return;
  const item = mapper(row);
  const idField = collection === "snapshots" ? "date" : collection === "fleet" ? "equipment" : "id";
  const itemId = String(item[idField]);
  const index = state[collection].findIndex((existing) => String(existing[idField]) === itemId);

  if (payload.eventType === "DELETE") {
    if (index >= 0) state[collection].splice(index, 1);
  } else if (index >= 0) {
    // Sem a coluna "driver" na base, o echo do realtime traria o motorista vazio
    // e apagaria o valor local — preserva-o até a migração 002 ser corrida.
    if (collection === "fleet" && !remoteFleetHasDriver) {
      item.driver = state.fleet[index].driver || item.driver;
    }
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

async function persistVistoriaRemote(vistoria) {
  if (!remoteStatus.ready || !remoteClient || !vistoria) return;
  updateSyncStatus("A guardar vistoria", "syncing", true);
  const { error } = await remoteClient
    .from("avarias_vistorias")
    .upsert(appVistoriaToDb(vistoria), { onConflict: "id" });
  if (error) throw error;
  updateSyncStatus("Partilhado em tempo real", "remote", true);
}

async function deleteVistoriaRemote(id) {
  if (!remoteStatus.ready || !remoteClient) return;
  const { error } = await remoteClient.from("avarias_vistorias").delete().eq("id", String(id));
  if (error) throw error;
}

async function persistAusenciaRemote(ausencia) {
  if (!remoteStatus.ready || !remoteClient || !ausencia) return;
  updateSyncStatus("A guardar ausência", "syncing", true);
  const { error } = await remoteClient
    .from("avarias_ausencias")
    .upsert(appAusenciaToDb(ausencia), { onConflict: "id" });
  if (error) throw error;
  updateSyncStatus("Partilhado em tempo real", "remote", true);
}

async function deleteAusenciaRemote(id) {
  if (!remoteStatus.ready || !remoteClient) return;
  const { error } = await remoteClient.from("avarias_ausencias").delete().eq("id", String(id));
  if (error) throw error;
}

function appAusenciaToDb(item) {
  return {
    id: String(item.id),
    driver: item.driver || "",
    type: item.type || null,
    start_at: item.startAt || null,
    end_at: item.endAt || null,
    notes: item.notes || null,
    created_at: item.createdAt || new Date().toISOString(),
    created_by: item.createdBy || remoteConfig.operator || "Utilizador"
  };
}

function dbAusenciaToApp(row) {
  return {
    id: String(row.id),
    driver: row.driver || "",
    type: row.type || "",
    startAt: row.start_at || "",
    endAt: row.end_at || "",
    notes: row.notes || "",
    createdAt: row.created_at || "",
    createdBy: row.created_by || ""
  };
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

// --- VISTORIA (constantes do checklist no topo do ficheiro) ---

function vistoriaSectionsForType(type) {
  return VISTORIA_SECTIONS.filter((section) => !section.types || section.types.includes(type));
}

function buildVistoriaItems(type) {
  return vistoriaSectionsForType(type).flatMap((section) =>
    section.items.map((item) => ({ section: section.name, item, state: "OK", note: "" })));
}

function scoreVistoria(items) {
  let penalty = 0, ok = 0, obs = 0, crit = 0, na = 0;
  for (const it of items || []) {
    if (it.state === "SOB OBS") { penalty += 1; obs += 1; }
    else if (it.state === "CRÍTICO") { penalty += 3; crit += 1; }
    else if (it.state === "N/A") { na += 1; } // não avaliado — não conta
    else { ok += 1; }
  }
  // "total" só conta os pontos efetivamente avaliados (exclui N/A)
  return { penalty, ok, obs, crit, na, total: (items || []).length - na };
}

// Critério (sobre os pontos avaliados, excluindo N/A):
//  > 40% em CRÍTICO            -> REPROVADO
//  tem críticos, mas <= 40%    -> APROVADO C/ ANOTAÇÕES
//  sem críticos, com observações -> APROVADO C/ OBSERVAÇÕES
//  sem críticos e sem observações -> APROVADO
function vistoriaResult(items) {
  const { crit, obs, total } = scoreVistoria(items);
  if (total === 0) return "APROVADO";
  if (crit / total > 0.40) return "REPROVADO";
  if (crit > 0) return "APROVADO C/ ANOTAÇÕES";
  if (obs > 0) return "APROVADO C/ OBSERVAÇÕES";
  return "APROVADO";
}

function appVistoriaToDb(item) {
  return {
    id: String(item.id),
    date: item.date || null,
    time: item.time || null,
    company: item.company || null,
    location: item.location || null,
    inspector: item.inspector || null,
    driver: item.driver || null,
    plate: item.plate || null,
    equipment: String(item.equipment ?? ""),
    equipment_type: item.equipmentType || null,
    items: item.items || [],
    score: item.score || 0,
    result: item.result || null,
    created_at: item.createdAt || new Date().toISOString(),
    created_by: item.createdBy || remoteConfig.operator || "Utilizador"
  };
}

function dbVistoriaToApp(row) {
  let items = row.items;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  return {
    id: String(row.id),
    date: row.date || "",
    time: row.time || "",
    company: row.company || "",
    location: row.location || "",
    inspector: row.inspector || "",
    driver: row.driver || "",
    plate: row.plate || "",
    equipment: (row.equipment ?? "") === "" ? "" : normalizeEquipment(row.equipment),
    equipmentType: row.equipment_type || "",
    items: Array.isArray(items) ? items : [],
    score: Number(row.score) || 0,
    result: row.result || "",
    createdAt: row.created_at || "",
    createdBy: row.created_by || ""
  };
}

// --- Vistoria: filtros, inferência e UI ---

function getFilteredVistorias() {
  let list = [...(state.vistorias || [])];
  if (state.filters.vistoriaType) list = list.filter((v) => v.equipmentType === state.filters.vistoriaType);
  if (state.filters.vistoriaResult) list = list.filter((v) => v.result === state.filters.vistoriaResult);
  return list.sort((a, b) =>
    (b.date || "").localeCompare(a.date || "") ||
    (b.time || "").localeCompare(a.time || "") ||
    (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function inferVistoriaType(description) {
  const d = normalizeText(description);
  if (d.includes("porta") && d.includes("maquina")) return "Porta-Máquinas";
  if (d.includes("basculante")) return "Semi-reboque Basculante";
  if (d.includes("estrado")) return "Estrados";
  if (d.includes("cisterna")) return "Cisterna";
  if (d.includes("caixa") || d.includes("reboque")) return "Semi-reboque Caixa";
  if (d.includes("camiao")) return "Trator/Camião";
  return "Outro";
}

function fillVistoriaFromPlate(value) {
  const match = findFleetByPlate(value);
  const equipment = document.querySelector("#vistoria-equipment");
  const typeSelect = document.querySelector("#vistoria-type");
  if (equipment) equipment.value = match?.equipment ?? "";
  if (match && typeSelect) {
    const inferred = inferVistoriaType(match.description);
    typeSelect.value = inferred;
    applyVistoriaTypeVisibility(inferred);
  }
}

function applyVistoriaTypeVisibility(type) {
  document.querySelectorAll("[data-section-types]").forEach((el) => {
    const types = el.getAttribute("data-section-types").split("|");
    el.style.display = types.includes(type) ? "" : "none";
  });
}

function renderVistoria() {
  const sub = state.vistoriaSubView || "kpis";
  const tabs = [["kpis", "KPIs"], ["list", "Vistorias"], ["new", "Nova vistoria"]];
  const subnav = `
    <nav class="subview-tabs" aria-label="Vistas de vistoria">
      ${tabs.map(([k, label]) => `<button type="button" class="${sub === k ? "active" : ""}" data-action="vistoria-subview" data-subview="${k}">${label}</button>`).join("")}
    </nav>`;
  let body;
  if (sub === "new") body = renderVistoriaForm();
  else if (sub === "list") body = renderVistoriaList();
  else if (sub === "detail") body = renderVistoriaDetail();
  else if (sub === "edit") body = renderVistoriaEdit();
  else body = renderVistoriaKpis();
  return `<section class="vistoria-view">${subnav}${body}${renderVistoriaLegend()}</section>`;
}

function renderVistoriaTypeFilter() {
  return `
    <div class="toolbar">
      <select data-filter="vistoriaType" aria-label="Tipo de equipamento">
        <option value="">Todos os tipos de equipamento</option>
        ${VISTORIA_TYPES.map((t) => `<option value="${escapeAttr(t)}" ${state.filters.vistoriaType === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
      </select>
      <select data-filter="vistoriaResult" aria-label="Resultado">
        <option value="">Todos os resultados</option>
        ${["APROVADO", "APROVADO C/ OBSERVAÇÕES", "APROVADO C/ ANOTAÇÕES", "REPROVADO"].map((r) => `<option value="${escapeAttr(r)}" ${state.filters.vistoriaResult === r ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
      </select>
    </div>`;
}

function renderVistoriaList() {
  const list = getFilteredVistorias();
  return `
    <div class="panel">
      <div class="panel-header">
        <div><p class="eyebrow">Registos</p><h2>Vistorias</h2><p>${list.length} vistorias</p></div>
        <button class="ghost-button" type="button" data-action="vistoria-subview" data-subview="new"><span data-icon="plus"></span><span>Nova</span></button>
      </div>
      ${renderVistoriaTypeFilter()}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Data</th><th>Equip.</th><th>Matrícula</th><th>Empresa</th><th>Tipo</th><th>Inspetor</th><th>Resultado</th><th>Anomalias</th><th></th></tr></thead>
          <tbody>
            ${list.length ? list.map((v) => {
              const s = scoreVistoria(v.items);
              return `<tr>
                <td>${formatDate(v.date)}${v.time ? ` ${escapeHtml(v.time)}` : ""}</td>
                <td><strong>${escapeHtml(String(v.equipment || "-"))}</strong></td>
                <td>${escapeHtml(v.plate || "-")}</td>
                <td>${escapeHtml(v.company || "-")}</td>
                <td>${escapeHtml(v.equipmentType || "-")}</td>
                <td>${escapeHtml(v.inspector || "-")}</td>
                <td>${vistoriaResultBadge(v.result)}</td>
                <td>${s.obs + s.crit > 0 ? `${s.obs} obs · ${s.crit} crít.` : "—"}</td>
                <td><div class="button-row">
                  <button class="icon-button" type="button" data-action="select-vistoria" data-id="${escapeAttr(v.id)}" title="Ver"><span data-icon="eye"></span></button>
                  <button class="icon-button" type="button" data-action="delete-vistoria" data-id="${escapeAttr(v.id)}" title="Eliminar"><span data-icon="trash"></span></button>
                </div></td>
              </tr>`;
            }).join("") : `<tr><td colspan="9"><p class="empty-state">Sem vistorias para estes filtros.</p></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderVistoriaForm() {
  const today = todayISO();
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const defaultType = VISTORIA_TYPES[0];
  const plates = state.fleet.filter((i) => i.plate);
  return `
    <section class="panel form-panel">
      <div class="panel-header"><div><p class="eyebrow">Inspeção visual</p><h2>Nova vistoria</h2><p>Registo de inspeção visual à viatura, em dia aleatório.</p></div></div>
      <form class="data-form" data-form="new-vistoria">
        <div class="form-grid">
          <label class="field"><span>Data</span><input type="date" name="date" value="${today}" required></label>
          <label class="field"><span>Hora</span><input type="time" name="time" value="${hhmm}"></label>
          <label class="field"><span>Matrícula</span><input id="vistoria-plate" name="plate" list="vistoria-plate-options" autocomplete="off" required></label>
          <label class="field"><span>Equipamento</span><input id="vistoria-equipment" name="equipment" placeholder="Preenchido pela matrícula" readonly></label>
          <label class="field"><span>Empresa</span><select name="company"><option value=""></option><option value="CPSA">CPSA</option><option value="PTSA">PTSA</option></select></label>
          <label class="field"><span>Tipo de equipamento</span><select id="vistoria-type" name="equipmentType">${VISTORIA_TYPES.map((t) => `<option value="${escapeAttr(t)}" ${t === defaultType ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select></label>
          <label class="field"><span>Inspetor</span><input name="inspector"></label>
          <label class="field"><span>Motorista</span><input name="driver"></label>
          <label class="field"><span>Local</span><input name="location"></label>
        </div>
        <datalist id="vistoria-plate-options">${plates.map((i) => `<option value="${escapeAttr(i.plate)}">${escapeHtml(`Equip. ${i.equipment || "-"} · ${i.description || ""}`)}</option>`).join("")}</datalist>
        ${VISTORIA_SECTIONS.map((section) => renderVistoriaSection(section, defaultType)).join("")}
        <div class="form-actions"><button class="primary-button" type="submit"><span data-icon="check"></span><span>Guardar vistoria</span></button></div>
      </form>
    </section>`;
}

function renderVistoriaSection(section, currentType) {
  const visible = !section.types || section.types.includes(currentType);
  const typesAttr = section.types ? ` data-section-types="${escapeAttr(section.types.join("|"))}"` : "";
  return `
    <fieldset class="vistoria-section"${typesAttr}${visible ? "" : ' style="display:none"'}>
      <legend>${escapeHtml(section.name)}</legend>
      ${section.items.map((item) => `
        <div class="vistoria-item" data-section="${escapeAttr(section.name)}" data-item="${escapeAttr(item)}">
          <span class="vistoria-item__label">${escapeHtml(item)}</span>
          <select class="vistoria-item__state" data-vi-state>${VISTORIA_STATES.map((st) => `<option value="${escapeAttr(st)}">${escapeHtml(st)}</option>`).join("")}</select>
          <input class="vistoria-item__note" data-vi-note placeholder="Observações">
          <label class="vistoria-item__photo" title="Anexar foto (opcional)">
            <span data-icon="paperclip"></span>
            <input type="file" data-vi-photo accept="image/*" multiple hidden>
          </label>
        </div>`).join("")}
    </fieldset>`;
}

function renderVistoriaDetail() {
  const v = state.vistorias.find((x) => String(x.id) === String(state.selectedVistoriaId));
  if (!v) return `<div class="panel"><p class="empty-state">Vistoria não encontrada.</p></div>`;
  const s = scoreVistoria(v.items);
  const linked = getVistoriaBreakdowns(v.id);
  const bySection = {};
  (v.items || []).forEach((it) => { (bySection[it.section] = bySection[it.section] || []).push(it); });
  return `
    <div class="panel">
      <div class="panel-header">
        <div><p class="eyebrow">Vistoria</p><h2>Equip. ${escapeHtml(String(v.equipment || "-"))} · ${escapeHtml(v.plate || "-")}</h2>
          <p>${formatDate(v.date)}${v.time ? ` ${escapeHtml(v.time)}` : ""} · ${escapeHtml(v.equipmentType || "-")} · ${escapeHtml(v.company || "-")}</p></div>
        <div class="detail-subtitle">${vistoriaResultBadge(v.result)}</div>
      </div>
      <dl class="mini-grid">
        <div><dt>Inspetor</dt><dd>${escapeHtml(v.inspector || "-")}</dd></div>
        <div><dt>Motorista</dt><dd>${escapeHtml(v.driver || "-")}</dd></div>
        <div><dt>Local</dt><dd>${escapeHtml(v.location || "-")}</dd></div>
        <div><dt>Pontuação</dt><dd>${s.penalty} (${s.obs} obs · ${s.crit} crít.${s.na ? ` · ${s.na} N/A` : ""})</dd></div>
      </dl>
      ${linked.length ? `
        <div class="link-banner">
          <strong>Avarias geradas a partir desta vistoria (${linked.length}):</strong>
          ${linked.map((b) => `<button class="chip-link" type="button" data-action="select-breakdown" data-id="${escapeAttr(b.id)}" title="Abrir avaria">🔧 ${escapeHtml(b.type || "Avaria")} · ${escapeHtml(b.status)}${b.vistoriaItem ? ` · ${escapeHtml(b.vistoriaItem)}` : ""}</button>`).join("")}
        </div>` : ""}
      ${Object.entries(bySection).map(([name, items]) => `
        <fieldset class="vistoria-section">
          <legend>${escapeHtml(name)}</legend>
          ${items.map((it) => {
            const photos = normalizeAttachments(it.photos);
            const itemBreakdowns = linked.filter((b) => b.vistoriaItem === it.item && b.vistoriaSection === it.section);
            return `<div class="vistoria-item vistoria-item--readonly">
            <span class="vistoria-item__label">${escapeHtml(it.item)}</span>
            ${vistoriaStateBadge(it.state)}
            <span class="vistoria-item__noteview">${escapeHtml(it.note || "")}</span>
            ${photos.length ? `<div class="vistoria-item__photos">${photos.map(renderAttachmentItem).join("")}</div>` : ""}
            <div class="vistoria-item__actions">
              <button class="link-button" type="button" data-action="avaria-from-vistoria" data-id="${escapeAttr(v.id)}" data-section="${escapeAttr(it.section)}" data-item="${escapeAttr(it.item)}">+ Criar avaria deste ponto</button>
              ${itemBreakdowns.map((b) => `<button class="chip-link" type="button" data-action="select-breakdown" data-id="${escapeAttr(b.id)}" title="Abrir avaria associada">🔧 ${escapeHtml(b.type || "Avaria")} · ${escapeHtml(b.status)}</button>`).join("")}
            </div>
          </div>`;
          }).join("")}
        </fieldset>`).join("")}
      <div class="form-actions">
        <button class="primary-button" type="button" data-action="edit-vistoria" data-id="${escapeAttr(v.id)}"><span data-icon="pencil"></span><span>Editar</span></button>
        <button class="ghost-button" type="button" data-action="vistoria-subview" data-subview="list">Voltar à lista</button>
        <button class="danger-button" type="button" data-action="delete-vistoria" data-id="${escapeAttr(v.id)}"><span data-icon="trash"></span><span>Eliminar</span></button>
      </div>
    </div>`;
}

function renderVistoriaEdit() {
  const v = state.vistorias.find((x) => String(x.id) === String(state.selectedVistoriaId));
  if (!v) return `<div class="panel"><p class="empty-state">Vistoria não encontrada.</p></div>`;
  const items = v.items || [];
  const sections = [];
  const sIndex = {};
  items.forEach((it, idx) => {
    if (!(it.section in sIndex)) { sIndex[it.section] = sections.length; sections.push({ name: it.section, rows: [] }); }
    sections[sIndex[it.section]].rows.push({ it, idx });
  });
  return `
    <section class="panel form-panel">
      <div class="panel-header"><div><p class="eyebrow">Vistoria</p><h2>Editar vistoria — ${escapeHtml(v.plate || "-")} (Equip. ${escapeHtml(String(v.equipment || "-"))})</h2>
        <p>${escapeHtml(v.equipmentType || "-")} · matrícula e tipo não são editáveis aqui.</p></div></div>
      <form class="data-form" data-form="edit-vistoria">
        <input type="hidden" name="id" value="${escapeAttr(v.id)}">
        <div class="form-grid">
          <label class="field"><span>Data</span><input type="date" name="date" value="${escapeAttr(v.date || "")}" required></label>
          <label class="field"><span>Hora</span><input type="time" name="time" value="${escapeAttr(v.time || "")}"></label>
          <label class="field"><span>Empresa</span><select name="company"><option value="" ${!v.company ? "selected" : ""}></option><option value="CPSA" ${v.company === "CPSA" ? "selected" : ""}>CPSA</option><option value="PTSA" ${v.company === "PTSA" ? "selected" : ""}>PTSA</option></select></label>
          <label class="field"><span>Inspetor</span><input name="inspector" value="${escapeAttr(v.inspector || "")}"></label>
          <label class="field"><span>Motorista</span><input name="driver" value="${escapeAttr(v.driver || "")}"></label>
          <label class="field"><span>Local</span><input name="location" value="${escapeAttr(v.location || "")}"></label>
        </div>
        ${sections.map((sec) => `
          <fieldset class="vistoria-section">
            <legend>${escapeHtml(sec.name)}</legend>
            ${sec.rows.map(({ it, idx }) => {
              const photos = normalizeAttachments(it.photos);
              return `<div class="vistoria-item" data-vi-index="${idx}">
                <span class="vistoria-item__label">${escapeHtml(it.item)}</span>
                <select class="vistoria-item__state" data-vi-state>${VISTORIA_STATES.map((st) => `<option value="${escapeAttr(st)}" ${it.state === st ? "selected" : ""}>${escapeHtml(st)}</option>`).join("")}</select>
                <input class="vistoria-item__note" data-vi-note value="${escapeAttr(it.note || "")}" placeholder="Observações">
                <label class="vistoria-item__photo${photos.length ? " has-photos" : ""}" title="Adicionar foto (opcional)"><span data-icon="paperclip"></span><input type="file" data-vi-photo accept="image/*" multiple hidden></label>
                ${photos.length ? `<div class="vistoria-item__photos">${photos.map(renderAttachmentItem).join("")}</div>` : ""}
              </div>`;
            }).join("")}
          </fieldset>`).join("")}
        <div class="form-actions">
          <button class="primary-button" type="submit"><span data-icon="save"></span><span>Guardar alterações</span></button>
          <button class="ghost-button" type="button" data-action="select-vistoria" data-id="${escapeAttr(v.id)}">Cancelar</button>
        </div>
      </form>
    </section>`;
}

async function handleEditVistoria(form) {
  const id = form.querySelector('[name="id"]')?.value;
  const v = state.vistorias.find((x) => String(x.id) === String(id));
  if (!v) return;
  const data = new FormData(form);
  v.date = String(data.get("date") || v.date);
  v.time = String(data.get("time") || "");
  v.company = String(data.get("company") || "");
  v.inspector = String(data.get("inspector") || "").trim();
  v.driver = String(data.get("driver") || "").trim();
  v.location = String(data.get("location") || "").trim();

  let photoWarning = false;
  const rows = Array.from(form.querySelectorAll(".vistoria-item"));
  for (const row of rows) {
    const idx = Number(row.dataset.viIndex);
    const it = v.items[idx];
    if (!it) continue;
    it.state = row.querySelector("[data-vi-state]")?.value || it.state;
    it.note = (row.querySelector("[data-vi-note]")?.value || "").trim();
    const files = row.querySelector("[data-vi-photo]")?.files;
    if (files && files.length) {
      try {
        const uploaded = await uploadBreakdownAttachments(`vistorias/${v.id}/${idx}`, files);
        if (uploaded.length) it.photos = [...normalizeAttachments(it.photos), ...uploaded];
      } catch (error) {
        console.error("Falha ao carregar fotos da vistoria:", error);
        photoWarning = true;
      }
    }
  }

  const score = scoreVistoria(v.items);
  v.score = score.penalty;
  v.result = vistoriaResult(v.items);
  if (photoWarning) showToast("Algumas fotos não foram carregadas (alterações guardadas na mesma).");

  state.vistoriaSubView = "detail";
  const auditEvent = logVistoriaAudit(v, "Vistoria atualizada");
  saveState();
  showToast(`Vistoria atualizada — ${v.result}.`);
  render();
  await persistRemoteSafely(async () => {
    await persistVistoriaRemote(v);
    await persistAuditRemote(auditEvent);
  });
}

function renderVistoriaLegend() {
  return `
    <div class="panel vistoria-legend">
      <div class="panel-header"><div><p class="eyebrow">Legenda</p><h3>Critério de resultado</h3></div></div>
      <div class="legend-body">
        <ul class="legend-list">
          <li>${vistoriaResultBadge("REPROVADO")} mais de 40% dos pontos avaliados em CRÍTICO</li>
          <li>${vistoriaResultBadge("APROVADO C/ ANOTAÇÕES")} tem pontos críticos, mas ≤ 40%</li>
          <li>${vistoriaResultBadge("APROVADO C/ OBSERVAÇÕES")} sem críticos, com observações</li>
          <li>${vistoriaResultBadge("APROVADO")} sem críticos e sem observações</li>
        </ul>
        <ul class="legend-list">
          <li>${vistoriaStateBadge("OK")} ponto conforme</li>
          <li>${vistoriaStateBadge("SOB OBS")} sob observação (anomalia menor)</li>
          <li>${vistoriaStateBadge("CRÍTICO")} anomalia grave</li>
          <li>${vistoriaStateBadge("N/A")} não avaliado (fora da pontuação)</li>
        </ul>
      </div>
    </div>`;
}

function vistoriaResultBadge(result) {
  const r = result || "";
  const cls = r === "REPROVADO" ? "reprovado"
    : r.includes("ANOTA") ? "anotacoes"
    : r.includes("OBSERVA") ? "observacoes"
    : "aprovado";
  return `<span class="badge vistoria-${cls}">${escapeHtml(result || "—")}</span>`;
}

function vistoriaStateBadge(stt) {
  const cls = stt === "CRÍTICO" ? "reprovado" : stt === "SOB OBS" ? "observacoes" : stt === "N/A" ? "na" : "aprovado";
  return `<span class="badge vistoria-${cls}">${escapeHtml(stt)}</span>`;
}

function renderVistoriaKpis() {
  const list = getFilteredVistorias();
  const k = computeVistoriaKpis(list);
  return `
    <div class="panel">
      <div class="panel-header"><div><p class="eyebrow">Indicadores</p><h2>KPIs da frota — vistorias</h2><p>${list.length} vistorias${state.filters.vistoriaType ? ` · ${escapeHtml(state.filters.vistoriaType)}` : ""}</p></div></div>
      ${renderVistoriaTypeFilter()}
      <div class="dashboard-grid">
        ${kpiCard("Taxa de falha (itens)", `${k.itemFailPct}%`, `${k.failedItems} de ${k.totalItems} itens com OBS/crítico`)}
        ${kpiCard("Vistorias reprovadas", `${k.reprovedPct}%`, `${k.reproved} de ${list.length} com item crítico`)}
        ${kpiCard("Itens críticos", String(k.critItems), "anomalias graves registadas")}
        ${kpiCard("Viaturas inspecionadas", String(k.distinctVehicles), "matrículas distintas")}
      </div>
      <div class="page-grid" style="margin-top:16px">
        <div class="panel">
          <div class="panel-header"><div><h3>Top de anomalias</h3><p>Itens mais sinalizados (OBS/crítico)</p></div></div>
          <div class="table-wrap"><table><thead><tr><th>Item</th><th>Secção</th><th>Ocorrências</th><th>Críticos</th></tr></thead>
          <tbody>${k.topAnomalies.length ? k.topAnomalies.map((a) => `<tr><td><strong>${escapeHtml(a.item)}</strong></td><td>${escapeHtml(a.section)}</td><td>${a.count}</td><td>${a.crit}</td></tr>`).join("") : `<tr><td colspan="4"><p class="empty-state">Sem anomalias registadas.</p></td></tr>`}</tbody></table></div>
        </div>
        <div class="panel">
          <div class="panel-header"><div><h3>Reincidências por matrícula</h3><p>Mesma anomalia repetida em vistorias diferentes</p></div></div>
          <div class="table-wrap"><table><thead><tr><th>Matrícula</th><th>Equip.</th><th>Anomalias reincidentes</th><th>Vistorias</th></tr></thead>
          <tbody>${k.recurrences.length ? k.recurrences.map((r) => `<tr><td><strong>${escapeHtml(r.plate)}</strong></td><td>${escapeHtml(String(r.equipment || "-"))}</td><td>${r.recurringItems}</td><td>${r.inspections}</td></tr>`).join("") : `<tr><td colspan="4"><p class="empty-state">Sem reincidências.</p></td></tr>`}</tbody></table></div>
        </div>
      </div>
    </div>`;
}

function kpiCard(label, value, detail) {
  return `<article class="dashboard-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><em>${escapeHtml(detail)}</em></article>`;
}

function computeVistoriaKpis(list) {
  let totalItems = 0, failedItems = 0, critItems = 0, reproved = 0;
  const anomalyMap = {};
  const plateMap = {};
  for (const v of list) {
    if (v.result === "REPROVADO") reproved += 1;
    const p = plateMap[v.plate] || (plateMap[v.plate] = { equipment: v.equipment, inspections: 0, itemCounts: {} });
    p.inspections += 1;
    const seen = new Set();
    for (const it of v.items || []) {
      if (it.state === "N/A") continue; // não avaliado — não entra na taxa de falha
      totalItems += 1;
      if (it.state === "OK") continue;
      failedItems += 1;
      if (it.state === "CRÍTICO") critItems += 1;
      const key = `${it.item}|${it.section}`;
      const a = anomalyMap[key] || (anomalyMap[key] = { item: it.item, section: it.section, count: 0, crit: 0 });
      a.count += 1;
      if (it.state === "CRÍTICO") a.crit += 1;
      if (!seen.has(it.item)) {
        p.itemCounts[it.item] = (p.itemCounts[it.item] || 0) + 1;
        seen.add(it.item);
      }
    }
  }
  const topAnomalies = Object.values(anomalyMap).sort((a, b) => b.count - a.count || b.crit - a.crit).slice(0, 10);
  const recurrences = Object.entries(plateMap)
    .map(([plate, p]) => ({ plate, equipment: p.equipment, inspections: p.inspections, recurringItems: Object.values(p.itemCounts).filter((c) => c >= 2).length }))
    .filter((r) => r.recurringItems > 0)
    .sort((a, b) => b.recurringItems - a.recurringItems)
    .slice(0, 10);
  return {
    totalItems, failedItems, critItems,
    itemFailPct: totalItems ? Math.round((failedItems / totalItems) * 100) : 0,
    reproved, reprovedPct: list.length ? Math.round((reproved / list.length) * 100) : 0,
    distinctVehicles: Object.keys(plateMap).length,
    topAnomalies, recurrences
  };
}

function generateVistoriaId() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
  return `VS${stamp}${Math.floor(Math.random() * 90 + 10)}`;
}

function logVistoriaAudit(vistoria, action) {
  const auditEvent = {
    id: `VISTORIA-${vistoria.id}-${Date.now()}`,
    breakdownId: "",
    equipment: vistoria.equipment,
    plate: vistoria.plate,
    at: new Date().toISOString(),
    action: `Vistoria: ${action}`,
    status: vistoria.result,
    note: `${vistoria.equipmentType} · pontuação ${vistoria.score}`
  };
  state.audit.unshift(auditEvent);
  return auditEvent;
}

async function handleNewVistoria(form) {
  const data = new FormData(form);
  const plateInput = String(data.get("plate") || "").trim();
  const fleetItem = findFleetByPlate(plateInput);
  const plateField = form.querySelector("#vistoria-plate");
  if (!fleetItem) {
    if (plateField) {
      plateField.setCustomValidity("Escolha uma matrícula existente na frota.");
      plateField.reportValidity();
    }
    showToast("Matrícula não encontrada na frota.");
    return;
  }
  if (plateField) plateField.setCustomValidity("");

  const type = String(data.get("equipmentType") || VISTORIA_TYPES[0]);
  const applicable = new Set(vistoriaSectionsForType(type).map((s) => s.name));
  const id = generateVistoriaId();
  const items = [];
  const pendingPhotos = [];
  form.querySelectorAll(".vistoria-item").forEach((row, index) => {
    if (!applicable.has(row.dataset.section)) return;
    const entry = {
      section: row.dataset.section,
      item: row.dataset.item,
      state: row.querySelector("[data-vi-state]")?.value || "OK",
      note: (row.querySelector("[data-vi-note]")?.value || "").trim()
    };
    const files = row.querySelector("[data-vi-photo]")?.files;
    if (files && files.length) pendingPhotos.push({ entry, files, index });
    items.push(entry);
  });

  // Upload das fotos (opcionais) por ponto. Se falhar, regista a vistoria na mesma.
  let photoWarning = false;
  for (const { entry, files, index } of pendingPhotos) {
    try {
      const uploaded = await uploadBreakdownAttachments(`vistorias/${id}/${index}`, files);
      if (uploaded.length) entry.photos = uploaded;
    } catch (error) {
      console.error("Falha ao carregar fotos da vistoria:", error);
      photoWarning = true;
    }
  }
  if (photoWarning) showToast("Algumas fotos não foram carregadas (vistoria guardada na mesma).");

  const score = scoreVistoria(items);
  const vistoria = {
    id,
    date: String(data.get("date") || todayISO()),
    time: String(data.get("time") || ""),
    company: String(data.get("company") || "") || fleetItem.fleetCompany || "",
    location: String(data.get("location") || "").trim(),
    inspector: String(data.get("inspector") || "").trim(),
    driver: String(data.get("driver") || "").trim(),
    plate: fleetItem.plate || plateInput,
    equipment: fleetItem.equipment,
    equipmentType: type,
    items,
    score: score.penalty,
    result: vistoriaResult(items),
    createdAt: new Date().toISOString(),
    createdBy: remoteConfig.operator || "Utilizador"
  };

  state.vistorias.unshift(vistoria);
  state.selectedVistoriaId = vistoria.id;
  state.vistoriaSubView = "detail";
  const auditEvent = logVistoriaAudit(vistoria, "Vistoria registada");
  saveState();
  showToast(`Vistoria registada — ${vistoria.result}.`);
  render();
  await persistRemoteSafely(async () => {
    await persistVistoriaRemote(vistoria);
    await persistAuditRemote(auditEvent);
  });
}

function startAvariaFromVistoria(vistoriaId, section, item) {
  const v = state.vistorias.find((x) => String(x.id) === String(vistoriaId));
  if (!v) return;
  const entry = (v.items || []).find((it) => it.section === section && it.item === item);
  state.avariaFromVistoria = {
    vistoriaId: v.id,
    section: section || "",
    item: item || "",
    date: v.date || "",
    plate: v.plate || "",
    equipment: v.equipment,
    note: entry?.note || "",
    state: entry?.state || ""
  };
  state.currentView = "new";
  saveState();
  render();
}

function getVistoriaBreakdowns(vistoriaId) {
  return state.breakdowns.filter((b) => String(b.vistoriaId || "") === String(vistoriaId));
}

async function deleteVistoria(id) {
  const v = state.vistorias.find((x) => String(x.id) === String(id));
  if (!v) return;
  if (!window.confirm(`Eliminar a vistoria de ${formatDate(v.date)} à viatura ${v.plate || v.equipment}?`)) return;
  state.vistorias = state.vistorias.filter((x) => x !== v);
  if (state.selectedVistoriaId === String(id)) {
    state.selectedVistoriaId = "";
    state.vistoriaSubView = "list";
  }
  const auditEvent = logVistoriaAudit(v, "Vistoria eliminada");
  saveState();
  showToast("Vistoria eliminada.");
  render();
  await persistRemoteSafely(async () => {
    await deleteVistoriaRemote(id);
    await persistAuditRemote(auditEvent);
  });
}

function appFleetToDb(item) {
  const row = {
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
  // Só envia "driver" quando a coluna já existe na base (migração 002 corrida).
  if (remoteFleetHasDriver) row.driver = item.driver || null;
  return row;
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
    driver: row.driver || "",
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
  // Ligação à vistoria de origem — só envia as colunas quando existe ligação,
  // para não exigir as colunas nas avarias antigas (sem ligação).
  if (item.vistoriaId) {
    row.vistoria_id = String(item.vistoriaId);
    row.vistoria_item = item.vistoriaItem || null;
    row.vistoria_section = item.vistoriaSection || null;
    row.vistoria_date = item.vistoriaDate || null;
  }
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
    attachments: normalizeAttachments(row.attachments),
    vistoriaId: row.vistoria_id || "",
    vistoriaItem: row.vistoria_item || "",
    vistoriaSection: row.vistoria_section || "",
    vistoriaDate: row.vistoria_date || ""
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

// --- Reuniões ---

function appMeetingToDb(item) {
  return {
    id: String(item.id),
    started_at: item.startedAt || null,
    ended_at: item.endedAt || null,
    duration_min: item.durationMin || 0,
    operator: item.operator || null,
    events: item.events || []
  };
}

function dbMeetingToApp(row) {
  let events = row.events;
  if (typeof events === "string") {
    try { events = JSON.parse(events); } catch { events = []; }
  }
  return {
    id: String(row.id),
    startedAt: row.started_at || "",
    endedAt: row.ended_at || "",
    durationMin: Number(row.duration_min) || 0,
    operator: row.operator || "",
    events: Array.isArray(events) ? events : []
  };
}

async function persistMeetingRemote(meeting) {
  if (!remoteStatus.ready || !remoteClient || !meeting) return;
  const { error } = await remoteClient
    .from("avarias_reunioes")
    .upsert(appMeetingToDb(meeting), { onConflict: "id" });
  if (error) throw error;
}

function generateMeetingId() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
  return `RU${stamp}${Math.floor(Math.random() * 90 + 10)}`;
}

function getActiveMeeting() {
  if (!state.activeMeetingId) return null;
  return state.meetings.find((m) => m.id === state.activeMeetingId && !m.endedAt) || null;
}

function openMeeting() {
  if (getActiveMeeting()) { state.meetingView = "work"; saveState(); render(); return; }
  const meeting = {
    id: generateMeetingId(),
    startedAt: new Date().toISOString(),
    endedAt: "",
    durationMin: 0,
    operator: remoteConfig.operator || "Utilizador",
    events: []
  };
  state.meetings.unshift(meeting);
  state.activeMeetingId = meeting.id;
  state.meetingView = "work";
  saveState();
  showToast("Reunião iniciada.");
  render();
  persistRemoteSafely(() => persistMeetingRemote(meeting));
}

async function closeMeeting() {
  const meeting = getActiveMeeting();
  if (!meeting) return;
  if (!window.confirm("Encerrar a reunião? Vai ser gerado o relatório com o resumo das atualizações.")) return;
  meeting.endedAt = new Date().toISOString();
  meeting.durationMin = Math.max(1, Math.round((new Date(meeting.endedAt) - new Date(meeting.startedAt)) / 60000));
  state.activeMeetingId = "";
  state.selectedMeetingId = meeting.id;
  state.meetingView = "report";
  saveState();
  showToast(`Reunião encerrada (${meeting.durationMin} min).`);
  render();
  await persistRemoteSafely(() => persistMeetingRemote(meeting));
}

// Regista uma ação na reunião a decorrer (se houver). type: "new" | "update" | "close" | "reopen"
function recordMeetingEvent(type, breakdown, summary) {
  const meeting = getActiveMeeting();
  if (!meeting || !breakdown) return;
  meeting.events.push({
    at: new Date().toISOString(),
    type,
    breakdownId: breakdown.id,
    equipment: breakdown.equipment,
    plate: breakdown.plate,
    status: breakdown.status,
    summary: summary || ""
  });
  saveState();
  persistRemoteSafely(() => persistMeetingRemote(meeting));
}

// Painel flutuante ("volante") de notas/tarefas durante a reunião a decorrer.
function updateMeetingDock() {
  const dock = document.querySelector("#meeting-dock");
  if (!dock) return;
  const m = getActiveMeeting();
  if (!m) { dock.innerHTML = ""; dock.classList.remove("visible"); return; }
  dock.classList.add("visible");
  const entries = (m.events || []).filter((e) => e.type === "note" || e.type === "task");

  if (state.meetingDockCollapsed) {
    dock.innerHTML = `<button class="dock-bubble" type="button" data-action="dock-toggle" title="Notas e tarefas da reunião">📝<span class="dock-bubble__n">${entries.length}</span></button>`;
    return;
  }

  const type = state.dockNoteType === "task" ? "task" : "note";
  dock.innerHTML = `
    <div class="dock-panel">
      <div class="dock-head">
        <strong>🟢 Reunião · notas &amp; tarefas</strong>
        <button class="dock-min" type="button" data-action="dock-toggle" title="Minimizar">–</button>
      </div>
      <div class="dock-log" id="dock-log">
        ${entries.length ? entries.map((e) => `
          <div class="dock-item dock-item--${e.type}${e.done ? " done" : ""}">
            ${e.type === "task"
              ? `<button class="dock-check" type="button" data-action="dock-task-toggle" data-id="${escapeAttr(e.id)}" title="Marcar concluída">${e.done ? "✅" : "⬜"}</button>`
              : `<span class="dock-ic">🗒️</span>`}
            <span class="dock-text">${escapeHtml(e.summary || "")}</span>
            <time>${escapeHtml(formatTimeOnly(e.at))}</time>
          </div>`).join("") : `<p class="dock-empty">Sem notas nem tarefas ainda. Escreve abaixo. ✍️</p>`}
      </div>
      <form class="dock-form" data-form="dock-note">
        <select name="type" class="dock-type" aria-label="Tipo">
          <option value="note" ${type === "note" ? "selected" : ""}>Nota</option>
          <option value="task" ${type === "task" ? "selected" : ""}>Tarefa</option>
        </select>
        <input id="dock-input" name="text" placeholder="Escrever…" autocomplete="off" required>
        <button class="dock-send" type="submit">Adicionar</button>
      </form>
    </div>`;
  const log = document.querySelector("#dock-log");
  if (log) log.scrollTop = log.scrollHeight;
}

function addMeetingNote(type, text) {
  const m = getActiveMeeting();
  const clean = String(text || "").trim();
  if (!m || !clean) return;
  state.dockNoteType = type === "task" ? "task" : "note";
  m.events.push({
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    type: state.dockNoteType,
    summary: clean,
    done: false,
    breakdownId: "", equipment: "", plate: "", status: ""
  });
  saveState();
  updateMeetingDock();
  document.querySelector("#dock-input")?.focus();
  showToast(state.dockNoteType === "task" ? "Tarefa adicionada." : "Nota adicionada.");
  persistRemoteSafely(() => persistMeetingRemote(m));
}

function toggleMeetingTask(id) {
  const m = getActiveMeeting();
  if (!m) return;
  const e = (m.events || []).find((x) => x.id === id);
  if (!e) return;
  e.done = !e.done;
  saveState();
  updateMeetingDock();
  persistRemoteSafely(() => persistMeetingRemote(m));
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
    vistoria: renderVistoria,
    ausencias: renderAusencias,
    audit: renderAudit
  };
  let html;
  try {
    html = (views[state.currentView] || renderMeeting)();
  } catch (error) {
    console.error("Erro ao renderizar a vista", state.currentView, error);
    html = `<section class="panel"><div class="panel-header"><div><p class="eyebrow">Erro</p><h2>Não foi possível mostrar esta vista</h2><p>Escolha outra vista no menu acima. Detalhe técnico: ${escapeHtml(String((error && error.message) || error))}</p></div></div></section>`;
  }
  main.innerHTML = html;
  hydrateIcons();
  try { updateMeetingDock(); } catch (e) { console.error("dock:", e); }

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

const DASHBOARD_DATE_TABS = [
  ["inspectionAt", "Inspeção"],
  ["tachographAt", "Aferição tacógrafo"],
  ["compressorReviewAt", "Revisão compressor"],
  ["wheelHubReviewAt", "Cubos de roda"]
];

function renderDashboard() {
  const management = getManagementMetrics();
  const alerts = getFleetDateAlerts();
  const activeTab = DASHBOARD_DATE_TABS.some(([f]) => f === state.dashboardDateTab) ? state.dashboardDateTab : "inspectionAt";
  const filtered = alerts.filter((a) => a.field === activeTab);

  const tabs = DASHBOARD_DATE_TABS.map(([field, label]) => {
    const count = alerts.filter((a) => a.field === field).length;
    return `<button type="button" class="${activeTab === field ? "active" : ""}" data-action="dashboard-date-tab" data-field="${escapeAttr(field)}">${escapeHtml(label)}${count ? ` (${count})` : ""}</button>`;
  }).join("");

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
            <p>Contagem decrescente por tipo de registo.</p>
          </div>
        </div>
        <nav class="subview-tabs" style="padding:12px 16px 0">${tabs}</nav>
        <div class="deadline-list">
          ${filtered.length ? filtered.map((item) => `
            <article class="deadline-row">
              <div>
                <strong>Equip. ${escapeHtml(item.equipment)} · ${escapeHtml(item.plate || "-")}</strong>
                <span>${escapeHtml(item.label)}</span>
              </div>
              ${renderDueBadge(item.date)}
            </article>
          `).join("") : '<p class="empty-state">Sem datas registadas para este tipo.</p>'}
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
  const active = getActiveMeeting();
  if (state.meetingView === "consult") return renderMeetingConsult();
  if (state.meetingView === "report") return renderMeetingReport();
  if (state.meetingView === "work" || active) return renderMeetingWork(active);
  return renderMeetingHome();
}

function renderMeetingHome() {
  const past = [...state.meetings].filter((m) => m.endedAt).length;
  return `
    <section class="meeting-home">
      <div class="panel meeting-hero">
        <p class="eyebrow">Reunião de manutenção</p>
        <h2>Gerir reunião</h2>
        <p>Abra uma reunião para registar as ações tomadas (atualizações e novas avarias) e gerar um relatório no fim.</p>
        <div class="meeting-home__actions">
          <button class="primary-button" type="button" data-action="open-meeting"><span data-icon="plus"></span><span>Abrir reunião</span></button>
          <button class="ghost-button" type="button" data-action="meeting-consult"><span data-icon="eye"></span><span>Consultar reuniões${past ? ` (${past})` : ""}</span></button>
        </div>
      </div>
    </section>`;
}

function renderMeetingBanner(active) {
  const since = active ? formatDateTime(active.startedAt) : "";
  const mins = active ? Math.max(0, Math.round((Date.now() - new Date(active.startedAt)) / 60000)) : 0;
  return `
    <div class="meeting-banner${active ? " is-active" : ""}">
      <div>
        ${active
          ? `<strong>🟢 Reunião a decorrer</strong><span> · início ${escapeHtml(since)} · ${active.events.length} ações registadas</span>`
          : `<strong>Sem reunião a decorrer</strong><span> · abra uma reunião para registar as ações</span>`}
      </div>
      <div class="button-row">
        <button class="ghost-button" type="button" data-action="meeting-consult"><span data-icon="eye"></span><span>Consultar</span></button>
        ${active
          ? `<button class="danger-button" type="button" data-action="close-meeting"><span data-icon="check"></span><span>Encerrar reunião</span></button>`
          : `<button class="primary-button" type="button" data-action="open-meeting"><span data-icon="plus"></span><span>Abrir reunião</span></button>`}
      </div>
    </div>`;
}

function renderMeetingWork(active) {
  const metrics = getMetrics();
  const list = getFilteredBreakdowns(true);
  let selected = state.breakdowns.find((item) => item.id === state.selectedId);
  if (!selected) {
    ensureSelected(list);
    selected = state.breakdowns.find((item) => item.id === state.selectedId);
  }

  return `
    ${renderMeetingBanner(active)}
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

function renderMeetingConsult() {
  const past = [...state.meetings].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return `
    <section class="panel">
      <div class="panel-header">
        <div><p class="eyebrow">Reuniões</p><h2>Consultar reuniões</h2><p>${past.length} reuniões registadas</p></div>
        <button class="ghost-button" type="button" data-action="meeting-home"><span>Voltar</span></button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Data</th><th>Início</th><th>Duração</th><th>Estado</th><th>Ações</th><th>Operador</th><th></th></tr></thead>
          <tbody>
            ${past.length ? past.map((m) => {
              const ended = !!m.endedAt;
              const counts = meetingCounts(m);
              return `<tr>
                <td><strong>${formatDate((m.startedAt || "").slice(0, 10))}</strong></td>
                <td>${escapeHtml(formatTimeOnly(m.startedAt))}</td>
                <td>${ended ? `${m.durationMin} min` : "—"}</td>
                <td>${ended ? '<span class="badge concluido">Encerrada</span>' : '<span class="badge circula">A decorrer</span>'}</td>
                <td>${counts.novas} novas · ${counts.updates} atualizações · ${counts.tarefas} tarefas</td>
                <td>${escapeHtml(m.operator || "-")}</td>
                <td><button class="icon-button" type="button" data-action="select-meeting" data-id="${escapeAttr(m.id)}" title="Ver relatório"><span data-icon="eye"></span></button></td>
              </tr>`;
            }).join("") : `<tr><td colspan="7"><p class="empty-state">Ainda não há reuniões registadas.</p></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;
}

function meetingCounts(m) {
  const ev = m.events || [];
  return {
    novas: ev.filter((e) => e.type === "new").length,
    updates: ev.filter((e) => e.type === "update" || e.type === "close" || e.type === "reopen").length,
    tarefas: ev.filter((e) => e.type === "task").length,
    notas: ev.filter((e) => e.type === "note").length
  };
}

function meetingEventLabel(type) {
  return type === "new" ? "Nova avaria"
    : type === "close" ? "Concluída"
    : type === "reopen" ? "Reaberta"
    : type === "task" ? "Tarefa"
    : type === "note" ? "Nota"
    : "Atualização";
}

function renderMeetingReport() {
  const m = state.meetings.find((x) => String(x.id) === String(state.selectedMeetingId));
  if (!m) return `<div class="panel"><p class="empty-state">Reunião não encontrada.</p></div>`;
  const ev = m.events || [];
  const novas = ev.filter((e) => e.type === "new");
  const updates = ev.filter((e) => e.type === "update" || e.type === "close" || e.type === "reopen");
  const tarefas = ev.filter((e) => e.type === "task");
  const notas = ev.filter((e) => e.type === "note");
  const rowsHtml = (arr) => arr.length ? arr.map((e) => `
    <article class="timeline-item">
      <time>${formatTimeOnly(e.at)} · Equip. ${escapeHtml(String(e.equipment || "-"))} · ${escapeHtml(e.plate || "-")} · ${escapeHtml(meetingEventLabel(e.type))}</time>
      <p>${escapeHtml(e.summary || "-")}</p>
    </article>`).join("") : '<p class="empty-state">Sem registos.</p>';
  const noteRows = (arr) => arr.length ? arr.map((e) => `
    <article class="timeline-item">
      <time>${formatTimeOnly(e.at)}${e.type === "task" ? (e.done ? " · ✅ concluída" : " · ⬜ pendente") : ""}</time>
      <p>${escapeHtml(e.summary || "-")}</p>
    </article>`).join("") : '<p class="empty-state">Sem registos.</p>';

  return `
    <section class="panel">
      <div class="panel-header">
        <div><p class="eyebrow">Relatório de reunião</p><h2>${formatDate((m.startedAt || "").slice(0, 10))}</h2>
          <p>${escapeHtml(formatTimeOnly(m.startedAt))}${m.endedAt ? ` – ${escapeHtml(formatTimeOnly(m.endedAt))}` : ""} · ${m.endedAt ? `${m.durationMin} min` : "a decorrer"} · ${escapeHtml(m.operator || "-")}</p></div>
        <div class="button-row">
          <button class="primary-button" type="button" data-action="export-meeting" data-id="${escapeAttr(m.id)}"><span data-icon="download"></span><span>Excel</span></button>
          <button class="ghost-button" type="button" data-action="email-meeting" data-id="${escapeAttr(m.id)}"><span data-icon="paperclip"></span><span>Enviar por e-mail</span></button>
          <button class="ghost-button" type="button" data-action="meeting-consult"><span>Voltar à lista</span></button>
        </div>
      </div>
      <div class="metrics-grid" style="padding:14px 16px">
        <article class="metric-card"><span>Duração</span><strong>${m.endedAt ? `${m.durationMin}m` : "—"}</strong><em>tempo da reunião</em></article>
        <article class="metric-card"><span>Novas avarias</span><strong>${novas.length}</strong><em>criadas na reunião</em></article>
        <article class="metric-card"><span>Atualizações</span><strong>${updates.length}</strong><em>em avarias abertas</em></article>
        <article class="metric-card"><span>Tarefas</span><strong>${tarefas.length}</strong><em>${tarefas.filter((t) => !t.done).length} pendentes</em></article>
        <article class="metric-card"><span>Notas</span><strong>${notas.length}</strong><em>observações</em></article>
      </div>
      <div class="panel-header"><div><h3>Novas avarias (${novas.length})</h3></div></div>
      <div class="timeline" style="padding:0 16px 8px">${rowsHtml(novas)}</div>
      <div class="panel-header"><div><h3>Atualizações em avarias abertas (${updates.length})</h3></div></div>
      <div class="timeline" style="padding:0 16px 8px">${rowsHtml(updates)}</div>
      <div class="panel-header"><div><h3>Tarefas (${tarefas.length})</h3></div></div>
      <div class="timeline" style="padding:0 16px 8px">${noteRows(tarefas)}</div>
      <div class="panel-header"><div><h3>Notas / observações (${notas.length})</h3></div></div>
      <div class="timeline" style="padding:0 16px 16px">${noteRows(notas)}</div>
    </section>`;
}

function formatTimeOnly(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-PT", { hour: "2-digit", minute: "2-digit" }).format(d);
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
      <select data-filter="company" aria-label="Empresa">
        <option value="">Todas as empresas</option>
        ${["CPSA", "PTSA"].map((company) => `<option value="${escapeAttr(company)}" ${state.filters.company === company ? "selected" : ""}>${escapeHtml(company)}</option>`).join("")}
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

    ${breakdown.vistoriaId ? `
      <div class="link-banner">
        <span>🔗 Origem: <strong>vistoria de ${escapeHtml(formatDate(breakdown.vistoriaDate))}</strong>${breakdown.vistoriaItem ? ` — ponto <strong>${escapeHtml(breakdown.vistoriaItem)}</strong>` : ""}.</span>
        <button class="chip-link" type="button" data-action="select-vistoria" data-id="${escapeAttr(breakdown.vistoriaId)}">Ver vistoria</button>
      </div>` : ""}

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

function getBreakdownCompany(breakdown) {
  const plate = normalizePlate(breakdown.plate);
  const fleetItem = state.fleet.find((item) =>
    String(item.equipment) === String(breakdown.equipment) ||
    (plate && normalizePlate(item.plate) === plate));
  return fleetItem?.fleetCompany || "";
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
                  <th>Empresa</th>
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
                  <td>${escapeHtml(getBreakdownCompany(item) || "-")}</td>
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
  const link = state.avariaFromVistoria;
  const descPrefill = link
    ? `[Vistoria ${formatDate(link.date)}] ${link.item}${link.state ? ` (${link.state})` : ""}${link.note ? ` — ${link.note}` : ""}`
    : "";
  const banner = link ? `
    <div class="link-banner">
      <span>🔗 Esta avaria fica ligada à <strong>vistoria de ${escapeHtml(formatDate(link.date))}</strong> — ponto <strong>${escapeHtml(link.item)}</strong>${link.state ? ` [${escapeHtml(link.state)}]` : ""}.</span>
      <button class="chip-link" type="button" data-action="select-vistoria" data-id="${escapeAttr(link.vistoriaId)}">Ver vistoria</button>
    </div>` : "";
  return `
    <section class="panel form-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Entrada</p>
          <h2>Nova avaria${link ? " (origem: vistoria)" : ""}</h2>
          <p>Registo com data, estado inicial e primeira nota.</p>
        </div>
      </div>
      ${banner}
      <form class="data-form" data-form="new-breakdown">
        <div class="form-grid">
          <label class="field">
            <span>Matrícula</span>
            <input id="new-plate" name="plate" list="plate-options" autocomplete="off" value="${escapeAttr(link?.plate || "")}" required>
          </label>
          <label class="field">
            <span>Equipamento</span>
            <input id="new-equipment" name="equipment" placeholder="Preenchido pela matrícula" value="${escapeAttr(link?.equipment ?? "")}" readonly>
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
            <textarea name="description" required>${escapeHtml(descPrefill)}</textarea>
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
        ${(typeof trelloSettings !== "undefined" && trelloSettings.key) ? `
        <button class="ghost-button" type="button" data-action="import-drivers-trello"
          title="Importar o motorista de cada viatura a partir do cartão &quot;motorista associado&quot; no Trello">
          <span data-icon="rotate"></span>
          <span>Importar motoristas (Trello)</span>
        </button>` : ""}
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
            <label class="field">
              <span>Motorista</span>
              <input name="driver" placeholder="Motorista responsável">
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
              <th>Motorista</th>
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
                <td>${renderFleetDescriptionCell(item)}</td>
                <td>${escapeHtml(item.brand || item.model || "-")}</td>
                <td>${escapeHtml(item.year || "-")}</td>
                <td>${escapeHtml(item.status || "-")}</td>
                <td>${renderFleetCompanyCell(item)}</td>
                <td>${renderFleetDriverCell(item)}</td>
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
  const value = item[field] || "";

  if (isFleetNA(value)) {
    return `
      <div class="fleet-date-cell fleet-date-cell--na">
        <span class="not-applicable">N/A</span>
        <button class="link-button" type="button" data-action="fleet-date-reset"
          data-equipment="${escapeAttr(item.equipment)}" data-field="${escapeAttr(field)}"
          title="Tornar o campo editável novamente">repor</button>
      </div>
    `;
  }

  return `
    <div class="fleet-date-cell">
      <input
        type="date"
        aria-label="${escapeAttr(`${label} equip. ${item.equipment}`)}"
        value="${escapeAttr(value)}"
        data-equipment="${escapeAttr(item.equipment)}"
        data-fleet-date="${escapeAttr(field)}"
      >
      <div class="fleet-date-cell__foot">
        ${renderDueBadge(value)}
        <button class="link-button" type="button" data-action="fleet-date-na"
          data-equipment="${escapeAttr(item.equipment)}" data-field="${escapeAttr(field)}"
          title="Marcar como não aplicável">N/A</button>
      </div>
    </div>
  `;
}

function isFleetNA(value) {
  return value === FLEET_NA_DATE;
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

function renderFleetDriverCell(item) {
  return `
    <input
      class="fleet-driver-input"
      type="text"
      value="${escapeAttr(item.driver || "")}"
      placeholder="—"
      data-equipment="${escapeAttr(item.equipment)}"
      data-fleet-driver="true"
      aria-label="Motorista equip. ${escapeAttr(item.equipment)}"
    >
  `;
}

function renderFleetDescriptionCell(item) {
  const current = (item.description || "").trim();
  const match = current ? FLEET_DESCRIPTIONS.find((o) => normalizeText(o) === normalizeText(current)) : null;
  const parts = [`<option value="">—</option>`];
  for (const o of FLEET_DESCRIPTIONS) {
    parts.push(`<option value="${escapeAttr(o)}"${o === match ? " selected" : ""}>${escapeHtml(o)}</option>`);
  }
  // Descrição atual fora da lista: preserva-a como opção até ser reclassificada.
  if (current && !match) {
    parts.push(`<option value="${escapeAttr(current)}" selected>${escapeHtml(current)} (atual)</option>`);
  }
  return `
    <select
      class="fleet-desc-select"
      data-equipment="${escapeAttr(item.equipment)}"
      data-fleet-description="true"
      aria-label="Descrição equip. ${escapeAttr(item.equipment)}"
    >${parts.join("")}</select>
  `;
}

function renderDueBadge(dateValue) {
  const due = getDueState(dateValue);
  return `<span class="due-badge ${due.className}">${escapeHtml(due.label)}</span>`;
}

async function updateFleetDate(equipment, field, value) {
  const item = state.fleet.find((fleetItem) => String(fleetItem.equipment) === String(equipment));
  if (!item) return;
  const previous = item[field] || "";
  item[field] = value === FLEET_NA_DATE ? FLEET_NA_DATE : emptyToNull(value);
  const auditEvent = logFleetAudit(item, field, fleetDateLabel(previous), fleetDateLabel(item[field] || ""));
  saveState();
  showToast(value === FLEET_NA_DATE ? "Campo marcado como N/A." : "Data da frota guardada.");
  render();
  await persistRemoteSafely(async () => {
    await persistFleetRemote(item);
    await persistAuditRemote(auditEvent);
  });
}

function fleetDateLabel(value) {
  return isFleetNA(value) ? "N/A" : (value || "");
}

async function updateFleetDriver(equipment, value) {
  const item = state.fleet.find((fleetItem) => String(fleetItem.equipment) === String(equipment));
  if (!item) return;
  const next = String(value || "").trim();
  const previous = item.driver || "";
  if (next === previous) return;
  item.driver = next;
  const auditEvent = logFleetAudit(item, "driver", previous, next);
  saveState();
  showToast("Motorista guardado.");
  await persistRemoteSafely(async () => {
    await persistFleetRemote(item);
    await persistAuditRemote(auditEvent);
  });
}

async function updateFleetDescription(equipment, value) {
  const item = state.fleet.find((fleetItem) => String(fleetItem.equipment) === String(equipment));
  if (!item) return;
  const next = String(value || "").trim();
  const previous = item.description || "";
  if (next === previous) return;
  item.description = next;
  const auditEvent = logFleetAudit(item, "description", previous, next);
  saveState();
  showToast("Descrição guardada.");
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
    driver: String(data.get("driver") || "").trim(),
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

  recordMeetingEvent(intent === "close" ? "close" : intent === "reopen" ? "reopen" : "update", breakdown, trelloNote || (changes.length ? changes.join("; ") : "Atualização"));

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

  // Ligação à vistoria de origem, se a avaria foi criada a partir de um ponto da vistoria.
  const link = state.avariaFromVistoria;
  if (link && String(link.equipment) === String(equipment)) {
    breakdown.vistoriaId = link.vistoriaId;
    breakdown.vistoriaItem = link.item || "";
    breakdown.vistoriaSection = link.section || "";
    breakdown.vistoriaDate = link.date || "";
  }
  state.avariaFromVistoria = null;

  state.breakdowns.unshift(breakdown);
  state.selectedId = breakdown.id;
  state.currentView = "meeting";
  const originNote = breakdown.vistoriaId ? ` | Origem: vistoria ${formatDate(breakdown.vistoriaDate)} (${breakdown.vistoriaItem})` : "";
  const auditEvent = logAudit(breakdown, "Nova avaria", `${attachmentNote ? `${description} | Anexos: ${attachmentNote}` : description}${originNote}`);
  recordMeetingEvent("new", breakdown, description);
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
  recordMeetingEvent("close", breakdown, "Concluída pela lista");
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
    driver: "Motorista",
    description: "Descrição",
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

// ── AUSÊNCIAS (calendário + cruzamento com manutenções) ───────────────────

function distinctFleetDrivers() {
  return [...new Set(state.fleet.map((f) => (f.driver || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt"));
}

function fleetForDriver(driver) {
  const key = normalizeText(driver || "");
  if (!key) return [];
  return state.fleet.filter((f) => f.driver && normalizeText(f.driver) === key);
}

function absenceClass(type) {
  const t = normalizeText(type || "");
  if (t.includes("ferias")) return "ferias";
  if (t.includes("baixa")) return "baixa";
  return "outro";
}

function dateWithin(dateISO, startISO, endISO) {
  if (!startISO || !endISO) return false;
  return dateISO >= startISO && dateISO <= endISO;
}

function monthBounds(monthISO) {
  const [y, m] = monthISO.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { first: `${monthISO}-01`, last: `${monthISO}-${String(last).padStart(2, "0")}`, daysInMonth: last, year: y, month: m };
}

function absenceOverlapsMonth(a, monthISO) {
  if (!a.startAt || !a.endAt) return false;
  const { first, last } = monthBounds(monthISO);
  return a.startAt <= last && a.endAt >= first;
}

function absenceDays(a) {
  if (!a.startAt || !a.endAt) return "-";
  const ms = new Date(`${a.endAt}T00:00:00`) - new Date(`${a.startAt}T00:00:00`);
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) + 1 : "-";
}

function fleetDueList(f) {
  return [
    { label: "Inspeção", value: f.inspectionAt },
    { label: "Tacógrafo", value: f.tachographAt },
    { label: "Compressor", value: f.compressorReviewAt },
    { label: "Cubos", value: f.wheelHubReviewAt }
  ].filter((x) => x.value && !isFleetNA(x.value));
}

function renderAusencias() {
  const monthISO = state.ausenciaMonth || currentMonthISO();
  const list = [...state.ausencias].sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
  const drivers = distinctFleetDrivers();
  const monthAbs = list.filter((a) => absenceOverlapsMonth(a, monthISO));

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Ausências</p>
          <h2>Calendário de ausências</h2>
          <p>${list.length} ausência(s) registada(s)</p>
        </div>
      </div>

      <details class="fleet-add">
        <summary><span data-icon="plus"></span> Registar ausência</summary>
        <form class="data-form" data-form="new-ausencia">
          <div class="form-grid">
            <label class="field">
              <span>Motorista</span>
              <input name="driver" list="ausencia-drivers" required placeholder="Nome do motorista">
              <datalist id="ausencia-drivers">${drivers.map((d) => `<option value="${escapeAttr(d)}"></option>`).join("")}</datalist>
            </label>
            <label class="field">
              <span>Tipo</span>
              <select name="type">${ABSENCE_TYPES.map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("")}</select>
            </label>
            <label class="field"><span>Início</span><input type="date" name="startAt" required></label>
            <label class="field"><span>Fim</span><input type="date" name="endAt" required></label>
            <label class="field"><span>Notas</span><input name="notes" placeholder="Opcional"></label>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit"><span data-icon="plus"></span><span>Registar ausência</span></button>
          </div>
        </form>
      </details>

      ${renderAusenciaCalendar(monthISO, list)}
      ${renderAusenciaPlanning(monthAbs, monthISO)}
      ${renderAusenciaList(list)}
    </section>
  `;
}

function renderAusenciaCalendar(monthISO, list) {
  const { daysInMonth, year, month } = monthBounds(monthISO);
  const first = new Date(year, month - 1, 1);
  const startWeekday = (first.getDay() + 6) % 7; // 0 = Segunda
  const monthLabel = new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric" }).format(first);
  const today = todayISO();
  const weekdays = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(`<div class="cal-cell cal-cell--empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateISO = `${monthISO}-${String(d).padStart(2, "0")}`;
    const dayAbs = list.filter((a) => dateWithin(dateISO, a.startAt, a.endAt));
    const chips = dayAbs
      .map((a) => `<span class="cal-abs cal-abs--${absenceClass(a.type)}" title="${escapeAttr(`${a.driver} · ${a.type}`)}">${escapeHtml(a.driver)}</span>`)
      .join("");
    cells.push(`<div class="cal-cell${dateISO === today ? " cal-cell--today" : ""}"><span class="cal-day">${d}</span>${chips}</div>`);
  }

  return `
    <div class="cal-toolbar">
      <button class="ghost-button" type="button" data-action="ausencia-prev-month" aria-label="Mês anterior">‹</button>
      <strong class="cal-month">${escapeHtml(monthLabel)}</strong>
      <button class="ghost-button" type="button" data-action="ausencia-next-month" aria-label="Mês seguinte">›</button>
      <button class="link-button" type="button" data-action="ausencia-today">Hoje</button>
    </div>
    <div class="cal-grid cal-grid--head">${weekdays.map((w) => `<div class="cal-head">${w}</div>`).join("")}</div>
    <div class="cal-grid">${cells.join("")}</div>
  `;
}

function renderAusenciaPlanning(monthAbs, monthISO) {
  const label = new Intl.DateTimeFormat("pt-PT", { month: "long" }).format(new Date(`${monthISO}-01T00:00:00`));
  if (!monthAbs.length) {
    return `<div class="panel-sub"><h3>Janelas de manutenção</h3><p class="muted">Sem ausências em ${escapeHtml(label)}.</p></div>`;
  }
  const cards = monthAbs.map((a) => {
    const equips = fleetForDriver(a.driver);
    const equipHtml = equips.length
      ? equips.map((f) => {
          const dues = fleetDueList(f);
          const badges = dues.length
            ? dues.map((x) => `<span class="plan-due">${escapeHtml(x.label)} ${renderDueBadge(x.value)}</span>`).join("")
            : `<span class="muted">sem datas de manutenção</span>`;
          return `<div class="plan-equip"><strong>Equip. ${escapeHtml(f.equipment)}</strong> · ${escapeHtml(f.plate || "-")} <span class="muted">${escapeHtml(f.description || "")}</span><div class="plan-dues">${badges}</div></div>`;
        }).join("")
      : `<div class="plan-equip plan-equip--none muted">Sem equipamento associado a este motorista.</div>`;
    return `
      <div class="plan-card">
        <div class="plan-head">
          <span class="cal-abs cal-abs--${absenceClass(a.type)}">${escapeHtml(a.type)}</span>
          <strong>${escapeHtml(a.driver)}</strong>
          <span class="plan-dates">${formatDate(a.startAt)} → ${formatDate(a.endAt)} · ${absenceDays(a)} d</span>
        </div>
        ${equipHtml}
      </div>`;
  }).join("");
  return `
    <div class="panel-sub">
      <h3>Janelas de manutenção durante ausências</h3>
      <p class="muted">Equipamentos livres enquanto o motorista está ausente, e as próximas datas a vencer.</p>
      ${cards}
    </div>`;
}

function renderAusenciaList(list) {
  if (!list.length) return `<div class="panel-sub"><p class="muted">Ainda não há ausências registadas.</p></div>`;
  return `
    <div class="panel-sub">
      <h3>Todas as ausências</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Motorista</th><th>Tipo</th><th>Início</th><th>Fim</th><th>Dias</th><th>Notas</th><th></th></tr></thead>
          <tbody>
            ${list.map((a) => `
              <tr>
                <td><strong>${escapeHtml(a.driver)}</strong></td>
                <td><span class="cal-abs cal-abs--${absenceClass(a.type)}">${escapeHtml(a.type)}</span></td>
                <td>${formatDate(a.startAt)}</td>
                <td>${formatDate(a.endAt)}</td>
                <td>${absenceDays(a)}</td>
                <td class="compact-cell">${escapeHtml(a.notes || "-")}</td>
                <td><button class="icon-button" type="button" data-action="delete-ausencia" data-id="${escapeAttr(a.id)}" title="Eliminar ausência"><span data-icon="trash"></span></button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function shiftAusenciaMonth(delta) {
  const [y, m] = (state.ausenciaMonth || currentMonthISO()).split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.ausenciaMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  saveState();
  render();
}

async function handleNewAusencia(form) {
  const data = new FormData(form);
  const driver = String(data.get("driver") || "").trim();
  const startAt = String(data.get("startAt") || "");
  const endAt = String(data.get("endAt") || "");
  const type = String(data.get("type") || ABSENCE_TYPES[0]);
  if (!driver) { showToast("Indique o motorista."); return; }
  if (!startAt || !endAt) { showToast("Indique as datas de início e fim."); return; }
  if (endAt < startAt) { showToast("A data de fim é anterior à de início."); return; }

  const item = {
    id: `AUS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    driver,
    type,
    startAt,
    endAt,
    notes: String(data.get("notes") || "").trim(),
    createdAt: new Date().toISOString(),
    createdBy: remoteConfig.operator || "Utilizador"
  };
  state.ausencias.push(item);
  const auditEvent = {
    id: `AUS-${item.id}-criada`,
    breakdownId: "",
    equipment: "",
    plate: "",
    at: new Date().toISOString(),
    action: "Ausência registada",
    status: type,
    note: `${driver} · ${formatDate(startAt)} → ${formatDate(endAt)}`
  };
  state.audit.unshift(auditEvent);
  saveState();
  showToast("Ausência registada.");
  render();
  await persistRemoteSafely(async () => {
    await persistAusenciaRemote(item);
    await persistAuditRemote(auditEvent);
  });
}

async function deleteAusencia(id) {
  const a = state.ausencias.find((x) => String(x.id) === String(id));
  if (!a) return;
  if (!window.confirm(`Eliminar a ausência de ${a.driver} (${formatDate(a.startAt)} → ${formatDate(a.endAt)})?`)) return;
  state.ausencias = state.ausencias.filter((x) => x !== a);
  const auditEvent = {
    id: `AUS-${id}-eliminada-${Date.now()}`,
    breakdownId: "",
    equipment: "",
    plate: "",
    at: new Date().toISOString(),
    action: "Ausência eliminada",
    status: a.type,
    note: `${a.driver} · ${formatDate(a.startAt)} → ${formatDate(a.endAt)}`
  };
  state.audit.unshift(auditEvent);
  saveState();
  showToast("Ausência eliminada.");
  render();
  await persistRemoteSafely(async () => {
    await deleteAusenciaRemote(id);
    await persistAuditRemote(auditEvent);
  });
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
      .filter(([field]) => item[field] && !isFleetNA(item[field]))
      .map(([field, label]) => ({
        equipment: item.equipment,
        plate: item.plate,
        field,
        label,
        date: item[field],
        days: daysUntil(item[field])
      })))
    .sort((a, b) => a.days - b.days);
}

function getDueState(dateValue) {
  if (isFleetNA(dateValue)) return { className: "empty", label: "N/A" };
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
  if (state.filters.company) list = list.filter((item) => getBreakdownCompany(item) === state.filters.company);
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
  downloadWorkbook(buildActivePanelWorkbook());
}

function downloadWorkbook(workbook) {
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

function getMeetingById(id) {
  return state.meetings.find((m) => String(m.id) === String(id));
}

function buildMeetingReportWorkbook(meeting) {
  const ev = meeting.events || [];
  const novas = ev.filter((e) => e.type === "new");
  const updates = ev.filter((e) => e.type === "update" || e.type === "close" || e.type === "reopen");
  const tarefas = ev.filter((e) => e.type === "task");
  const notas = ev.filter((e) => e.type === "note");
  const dia = formatDate((meeting.startedAt || "").slice(0, 10));
  return {
    title: "Relatório de reunião",
    fileName: `reuniao-${(meeting.startedAt || "").slice(0, 10)}`,
    tables: [
      {
        title: "Resumo",
        columns: ["Campo", "Valor"],
        rows: [
          ["Data", dia],
          ["Início", formatTimeOnly(meeting.startedAt)],
          ["Fim", meeting.endedAt ? formatTimeOnly(meeting.endedAt) : "—"],
          ["Duração (min)", meeting.endedAt ? meeting.durationMin : "—"],
          ["Operador", meeting.operator || "-"],
          ["Novas avarias", novas.length],
          ["Atualizações", updates.length],
          ["Tarefas", tarefas.length],
          ["Notas", notas.length]
        ]
      },
      {
        title: "Novas avarias",
        columns: ["Hora", "Equip.", "Matrícula", "Descrição"],
        rows: novas.map((e) => [formatTimeOnly(e.at), String(e.equipment || ""), e.plate || "", e.summary || ""])
      },
      {
        title: "Atualizações",
        columns: ["Hora", "Equip.", "Matrícula", "Ação", "Resumo"],
        rows: updates.map((e) => [formatTimeOnly(e.at), String(e.equipment || ""), e.plate || "", meetingEventLabel(e.type), e.summary || ""])
      },
      {
        title: "Tarefas",
        columns: ["Hora", "Estado", "Tarefa"],
        rows: tarefas.map((e) => [formatTimeOnly(e.at), e.done ? "Concluída" : "Pendente", e.summary || ""])
      },
      {
        title: "Notas",
        columns: ["Hora", "Nota / observação"],
        rows: notas.map((e) => [formatTimeOnly(e.at), e.summary || ""])
      }
    ]
  };
}

function exportMeetingReportExcel(id) {
  const meeting = getMeetingById(id);
  if (!meeting) return;
  downloadWorkbook(buildMeetingReportWorkbook(meeting));
}

function meetingReportText(meeting) {
  const ev = meeting.events || [];
  const novas = ev.filter((e) => e.type === "new");
  const updates = ev.filter((e) => e.type === "update" || e.type === "close" || e.type === "reopen");
  const tarefas = ev.filter((e) => e.type === "task");
  const notas = ev.filter((e) => e.type === "note");
  const heading = (t) => `${t}\n${"─".repeat(Math.min(60, t.length))}`;
  const lines = [];
  lines.push(heading(`Relatório de Reunião — ${formatDate((meeting.startedAt || "").slice(0, 10))}`));
  if (meeting.endedAt) lines.push(`Duração: ${meeting.durationMin} min`);
  lines.push(`Operador: ${meeting.operator || "-"}`);
  lines.push("");
  lines.push(heading(`Novas Avarias (${novas.length})`));
  if (novas.length) novas.forEach((e) => lines.push(`- Equip. ${e.equipment || "-"} · ${e.plate || "-"}: ${e.summary || "-"}`));
  else lines.push("- (nenhuma)");
  lines.push("");
  lines.push(heading(`Atualizações em Avarias Abertas (${updates.length})`));
  if (updates.length) updates.forEach((e) => lines.push(`- Equip. ${e.equipment || "-"} · ${e.plate || "-"} · ${meetingEventLabel(e.type)}: ${e.summary || "-"}`));
  else lines.push("- (nenhuma)");
  lines.push("");
  lines.push(heading(`Tarefas (${tarefas.length})`));
  if (tarefas.length) tarefas.forEach((e) => lines.push(`- [${e.done ? "x" : " "}] ${e.summary || "-"}`));
  else lines.push("- (nenhuma)");
  lines.push("");
  lines.push(heading(`Notas / Observações (${notas.length})`));
  if (notas.length) notas.forEach((e) => lines.push(`- ${e.summary || "-"}`));
  else lines.push("- (nenhuma)");
  return lines.join("\n");
}

function workbookToXlsxBase64(workbook) {
  if (!window.XLSX) return "";
  const x = XLSX.utils.book_new();
  const used = new Set();
  workbook.tables.forEach((table, index) => {
    const sheet = XLSX.utils.aoa_to_sheet([table.columns, ...table.rows.map((r) => r.map((c) => c ?? ""))]);
    let name = sanitizeSheetName(table.title || `Folha${index + 1}`);
    while (used.has(name)) name = sanitizeSheetName(`${name.slice(0, 28)}_${index + 1}`);
    used.add(name);
    XLSX.utils.book_append_sheet(x, sheet, name);
  });
  return XLSX.write(x, { type: "base64", bookType: "xlsx" });
}

function meetingReportHtml(meeting) {
  const ev = meeting.events || [];
  const novas = ev.filter((e) => e.type === "new");
  const updates = ev.filter((e) => e.type === "update" || e.type === "close" || e.type === "reopen");
  const tarefas = ev.filter((e) => e.type === "task");
  const notas = ev.filter((e) => e.type === "note");
  const rows = (arr) => arr.length
    ? arr.map((e) => `<tr><td>${escapeHtml(formatTimeOnly(e.at))}</td><td>${escapeHtml(String(e.equipment || "-"))}</td><td>${escapeHtml(e.plate || "-")}</td><td>${escapeHtml(meetingEventLabel(e.type))}</td><td>${escapeHtml(e.summary || "-")}</td></tr>`).join("")
    : `<tr><td colspan="5">(nenhuma)</td></tr>`;
  const simpleRows = (arr, withState) => arr.length
    ? arr.map((e) => `<tr><td>${escapeHtml(formatTimeOnly(e.at))}</td>${withState ? `<td>${e.done ? "Concluída" : "Pendente"}</td>` : ""}<td>${escapeHtml(e.summary || "-")}</td></tr>`).join("")
    : `<tr><td colspan="${withState ? 3 : 2}">(nenhuma)</td></tr>`;
  return `
    <div style="font-family:Arial,sans-serif;color:#111827">
      <h2 style="margin:0 0 4px">Relatório de reunião — ${escapeHtml(formatDate((meeting.startedAt || "").slice(0, 10)))}</h2>
      <p style="color:#6b7280;margin:0 0 12px">
        ${escapeHtml(formatTimeOnly(meeting.startedAt))}${meeting.endedAt ? ` – ${escapeHtml(formatTimeOnly(meeting.endedAt))} · ${meeting.durationMin} min` : " (a decorrer)"} · ${escapeHtml(meeting.operator || "-")}
      </p>
      <p><strong>${novas.length}</strong> novas avarias · <strong>${updates.length}</strong> atualizações · <strong>${tarefas.length}</strong> tarefas · <strong>${notas.length}</strong> notas</p>
      <h3 style="margin:14px 0 6px">Novas avarias (${novas.length})</h3>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#e8f3f1"><th>Hora</th><th>Equip.</th><th>Matrícula</th><th>Ação</th><th>Resumo</th></tr></thead>
        <tbody>${rows(novas)}</tbody>
      </table>
      <h3 style="margin:14px 0 6px">Atualizações em avarias abertas (${updates.length})</h3>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#e8f3f1"><th>Hora</th><th>Equip.</th><th>Matrícula</th><th>Ação</th><th>Resumo</th></tr></thead>
        <tbody>${rows(updates)}</tbody>
      </table>
      <h3 style="margin:14px 0 6px">Tarefas (${tarefas.length})</h3>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#e8f3f1"><th>Hora</th><th>Estado</th><th>Tarefa</th></tr></thead>
        <tbody>${simpleRows(tarefas, true)}</tbody>
      </table>
      <h3 style="margin:14px 0 6px">Notas / observações (${notas.length})</h3>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#e8f3f1"><th>Hora</th><th>Nota</th></tr></thead>
        <tbody>${simpleRows(notas, false)}</tbody>
      </table>
    </div>`;
}

async function emailMeetingReport(id) {
  const meeting = getMeetingById(id);
  if (!meeting) return;
  const dia = formatDate((meeting.startedAt || "").slice(0, 10));
  const subject = `Relatório de Reunião Manutenção Logística - ${dia}`;
  const emailCfg = remoteConfig.email || {};

  // Envio automático via Edge Function do Supabase (se configurado)
  if (emailCfg.enabled && remoteConfig.supabaseUrl) {
    const to = window.prompt("Enviar relatório para (e-mail, separar vários por vírgula):", emailCfg.to || "");
    if (!to) return;
    try {
      showToast("A enviar e-mail…");
      const fileBase64 = workbookToXlsxBase64(buildMeetingReportWorkbook(meeting));
      const res = await fetch(`${remoteConfig.supabaseUrl}/functions/v1/${emailCfg.functionName || "send-meeting-report"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: remoteConfig.supabaseAnonKey || "",
          Authorization: `Bearer ${remoteConfig.supabaseAnonKey || ""}`
        },
        body: JSON.stringify({
          to,
          subject,
          html: meetingReportHtml(meeting),
          filename: `reuniao-${(meeting.startedAt || "").slice(0, 10)}.xlsx`,
          fileBase64
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      showToast("E-mail enviado.");
      return;
    } catch (error) {
      console.error("Falha no envio automático:", error);
      showToast(`Falha no envio automático (${formatRemoteError(error)}) — a abrir o e-mail manual.`);
    }
  }

  // Recurso: abrir o cliente de e-mail (mailto)
  const href = `mailto:${encodeURIComponent(emailCfg.to || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(meetingReportText(meeting))}`;
  window.location.href = href;
  showToast("A abrir o e-mail…");
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
    vistoria: buildVistoriaExport,
    audit: buildAuditExport
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
          fleetDateForExport(item.inspectionAt),
          formatDueForExport(item.inspectionAt),
          fleetDateForExport(item.tachographAt),
          formatDueForExport(item.tachographAt),
          fleetDateForExport(item.compressorReviewAt),
          formatDueForExport(item.compressorReviewAt),
          fleetDateForExport(item.wheelHubReviewAt),
          formatDueForExport(item.wheelHubReviewAt)
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

function vistoriaSevRank(st) {
  if (st === "N/A") return -1; // não avaliado — fora da comparação
  return st === "CRÍTICO" ? 2 : st === "SOB OBS" ? 1 : 0;
}

function buildVistoriaExport() {
  const list = getFilteredVistorias();

  // Resumo por vistoria
  const resumoRows = list.map((v) => {
    const s = scoreVistoria(v.items);
    return [v.date || "", v.time || "", v.company || "", v.plate || "", String(v.equipment || ""), v.equipmentType || "", v.inspector || "", v.driver || "", v.location || "", s.penalty, v.result || "", s.ok, s.obs, s.crit, s.na];
  });

  // Pontos negativos (destaque) — críticos primeiro, depois sob observação (exclui N/A e OK)
  const negRows = list.flatMap((v) => (v.items || [])
    .filter((it) => it.state === "SOB OBS" || it.state === "CRÍTICO")
    .map((it) => [it.state === "CRÍTICO" ? "🔴" : "🟡", it.state, v.date || "", v.plate || "", String(v.equipment || ""), v.equipmentType || "", it.section, it.item, it.note || "", formatAttachmentLinks(it.photos)]));
  negRows.sort((a, b) => (vistoriaSevRank(b[1]) - vistoriaSevRank(a[1])) || (b[2] || "").localeCompare(a[2] || ""));

  // Agrupar por viatura, por ordem cronológica
  const byPlate = {};
  for (const v of list) (byPlate[v.plate] = byPlate[v.plate] || []).push(v);
  const chrono = (arr) => arr.sort((a, b) =>
    (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || "") || (a.createdAt || "").localeCompare(b.createdAt || ""));

  // Evolução: última vistoria vs anterior, ponto a ponto
  const evoRows = [];
  for (const arr of Object.values(byPlate)) {
    chrono(arr);
    if (arr.length < 2) continue;
    const prev = arr[arr.length - 2];
    const curr = arr[arr.length - 1];
    const prevMap = {};
    (prev.items || []).forEach((it) => { prevMap[it.item] = it; });
    for (const it of (curr.items || [])) {
      const p = prevMap[it.item];
      if (!p) continue;
      const pr = vistoriaSevRank(p.state);
      const cr = vistoriaSevRank(it.state);
      if (pr < 0 || cr < 0) continue; // algum lado N/A (não avaliado) — não compara
      if (pr === 0 && cr === 0) continue; // sempre OK, nada a relatar
      let tend;
      if (cr > pr) tend = "🔴 ALERTA (piorou)";
      else if (cr < pr) tend = "🟢 Ponto positivo (melhorou)";
      else tend = "Mantém";
      evoRows.push([curr.plate || "", String(curr.equipment || ""), it.section, it.item, prev.date || "", p.state, curr.date || "", it.state, tend]);
    }
  }
  const tendOrder = (t) => (t.startsWith("🔴") ? 0 : t.startsWith("🟢") ? 1 : 2);
  evoRows.sort((a, b) => tendOrder(a[8]) - tendOrder(b[8]) || (a[0] || "").localeCompare(b[0] || ""));

  // Histórico por ponto (timeline completa dos pontos que alguma vez tiveram anomalia)
  const histRows = [];
  for (const arr of Object.values(byPlate)) {
    chrono(arr);
    const flagged = new Set();
    arr.forEach((v) => (v.items || []).forEach((it) => { if (it.state === "SOB OBS" || it.state === "CRÍTICO") flagged.add(it.item); }));
    for (const v of arr) {
      for (const it of (v.items || [])) {
        if (!flagged.has(it.item)) continue;
        histRows.push([v.plate || "", String(v.equipment || ""), v.date || "", it.section, it.item, it.state, it.note || ""]);
      }
    }
  }
  histRows.sort((a, b) => (a[0] || "").localeCompare(b[0] || "") || (a[4] || "").localeCompare(b[4] || "") || (a[2] || "").localeCompare(b[2] || ""));

  return {
    title: "Vistorias",
    fileName: `vistorias-${todayISO()}`,
    tables: [
      {
        title: "Resumo vistorias",
        columns: ["Data", "Hora", "Empresa", "Matrícula", "Equip.", "Tipo equipamento", "Inspetor", "Motorista", "Local", "Pontuação", "Resultado", "Itens OK", "Observações", "Críticos", "N/A"],
        rows: resumoRows
      },
      {
        title: "Pontos negativos",
        columns: ["", "Estado", "Data", "Matrícula", "Equip.", "Tipo equipamento", "Secção", "Item", "Observações", "Fotos (links)"],
        rows: negRows
      },
      {
        title: "Evolução (última vs anterior)",
        columns: ["Matrícula", "Equip.", "Secção", "Item", "Data anterior", "Estado anterior", "Data última", "Estado última", "Tendência"],
        rows: evoRows
      },
      {
        title: "Histórico por ponto",
        columns: ["Matrícula", "Equip.", "Data", "Secção", "Item", "Estado", "Observações"],
        rows: histRows
      }
    ]
  };
}

function buildBreakdownsTable(title, list) {
  return {
    title,
    columns: ["ID", "Equipamento", "Matrícula", "Empresa", "Tipo", "Estado", "Situação", "Anexos", "Links anexos", "Data avaria", "Entrada oficina", "Prev. saída", "Tipo oficina", "Oficina", "Motorista", "Custo", "Descrição", "Última nota", "Data nota"],
    rows: list.map((item) => [
      item.id,
      item.equipment || "",
      item.plate || "",
      getBreakdownCompany(item) || "",
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

function fleetDateForExport(value) {
  if (isFleetNA(value)) return "N/A";
  return value || "";
}

function formatDueForExport(dateValue) {
  if (isFleetNA(dateValue)) return "N/A";
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

// Arranque no fim do ficheiro: garante que todos os listeners já estão registados
// antes do primeiro render, para que um erro de renderização nunca deixe a app
// sem interação (ecrã em branco e botões mortos).
function bootstrap() {
  try {
    render();
  } catch (error) {
    console.error("Falha no arranque, a recuperar para a vista de reunião:", error);
    state.currentView = "meeting";
    try { saveState(); render(); } catch (e2) { console.error(e2); }
  }
  initRemote();
}

bootstrap();
