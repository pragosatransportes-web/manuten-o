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
let remoteFleetHasRevision = true;
let remoteFleetHasWorkshop = true;
let remoteFleetHasPartner = true;
let remoteFleetHasLogisticsResp = true;
let remoteBreakdownHasOccurrence = true;
let remoteBreakdownHasDetails = true;
let remoteBreakdownHasWorkshopExit = true;
let remoteBreakdownHasFaults = true;
let remoteBreakdownHasPreventive = true;

// Tipos de ausência de motorista (calendário de ausências, migração 003).
const ABSENCE_TYPES = ["Férias", "Baixa médica"];

const ENTIDADE_TIPOS = ["Externa", "Interna"];
const ENTIDADE_CATEGORIAS = ["Oficina", "Fornecedor", "Motorista", "Resp. Logística", "Cliente", "Seguradora", "Outro"];

// Ocorrências (redesign ARGOS): tipo de intervenção + numeração + prioridade.
const INTERVENTION_TYPES = ["Corretiva", "Garantia", "Preditiva", "Preventiva", "Sinistro"];
const INTERVENTION_PREFIX = { "Corretiva": "CRT", "Garantia": "GRT", "Preditiva": "PRD", "Preventiva": "PRV", "Sinistro": "SIN" };
const PRIORITIES = [
  ["P1", "Crítica — paragem imediata"],
  ["P2", "Alta — 24 a 48h"],
  ["P3", "Média — planeada"],
  ["P4", "Baixa — rotina / melhoria"]
];
const OCCURRENCE_STAGES = [
  ["comunicadas", "Comunicadas"],
  ["agendadas", "Agendadas"],
  ["curso", "Em curso"],
  ["concluidas", "Concluídas"],
  ["", "Todas"]
];

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
  { name: "1. Limpeza e Conservação", items: ["Estado geral de limpeza", "Danos visíveis na estrutura/chassis", "Corrosão ou fissuras", "Matrículas legíveis e fixas", "Guarda-lamas e proteções"] },
  { name: "2. Pneus e Rodas", items: ["Desgaste irregular", "Danos, cortes ou bolhas", "Pressão aparente", "Estado das jantes"] },
  { name: "3. Sinalização", items: ["Refletores", "Sinalização", "Plata TP Alvará"] },
  { name: "4. Fugas e Componentes", items: ["Tubagens e mangueiras", "Cablagens visíveis"] },
  { name: "5. Segurança e Cabina", types: ["Trator", "Camião"], items: ["Para-brisas e espelhos", "Cinto de segurança", "Colete refletor"] },
  { name: "6. Trator", types: ["Trator", "Camião"], items: ["Estado da roda suplente", "Degraus e pega-mãos"] },
  { name: "7. Semi-reboque Basculante", types: ["Semi-reboque Basculante"], items: ["Estado da caixa", "Fissuras estruturais", "Fechos da porta traseira", "Lona / cobertura"] },
  { name: "8. Porta-Máquinas", types: ["Porta-Máquinas"], items: ["Estrutura geral", "Estado das rampas", "Pontos de amarração", "Piso antiderrapante", "Estado do piso"] },
  { name: "9. Estrados", types: ["Estrados"], items: ["Estado do piso", "Estrutura geral", "Pontos de amarração", "Laterais / rebordos", "Estado do chassis"] }
];

const VISTORIA_TYPES = ["Trator", "Camião", "Semi-reboque Basculante", "Porta-Máquinas", "Estrados"];
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

// ── Modo Administrador (palavra-passe local) ─────────────────
// Gate do lado do cliente: esconde/bloqueia editar, eliminar e concluir
// para quem não introduzir a palavra-passe. Não é à prova de um utilizador
// técnico, mas evita alterações acidentais e casuais aos dados partilhados.
const ADMIN_STORAGE_KEY = "avarias-admin-unlocked";
let isAdmin = false;
try { isAdmin = sessionStorage.getItem(ADMIN_STORAGE_KEY) === "1"; } catch (e) { /* storage indisponível */ }

// Só as ações de ELIMINAR ficam reservadas ao Administrador.
// Tudo o resto (atualizar estados, concluir, editar, acrescentar) é livre.
const ADMIN_ACTIONS = new Set([
  "delete-fleet", "delete-ausencia", "delete-vistoria", "delete-entidade", "delete-fault-type",
  "reassign-vehicle",
  "meeting-event-delete", "dock-item-delete", "delete-meeting"
]);
const ADMIN_FORMS = new Set();

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function toggleAdminMode() {
  if (isAdmin) {
    isAdmin = false;
    try { sessionStorage.removeItem(ADMIN_STORAGE_KEY); } catch (e) {}
    showToast("Modo Administrador desligado.");
    render();
    return;
  }
  const expected = String(remoteConfig.adminPasswordHash || "").toLowerCase();
  if (!expected) {
    showToast("Palavra-passe de administrador não configurada.");
    return;
  }
  openAdminPasswordModal();
}

function openAdminPasswordModal() {
  const body = `
    <form data-form="admin-login" class="modal-form">
      <label class="field field--wide">Palavra-passe de administrador
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <p class="admin-login__err" hidden>Palavra-passe incorreta.</p>
      <div class="modal-form__actions">
        <button type="button" class="ghost-button" data-action="close-modal">Cancelar</button>
        <button type="submit" class="primary-button">Entrar</button>
      </div>
    </form>`;
  openModal("Modo Administrador", body);
}

async function handleAdminLogin(form) {
  const data = new FormData(form);
  const entry = String(data.get("password") || "");
  const expected = String(remoteConfig.adminPasswordHash || "").toLowerCase();
  const hash = await sha256Hex(entry);
  if (hash === expected) {
    isAdmin = true;
    try { sessionStorage.setItem(ADMIN_STORAGE_KEY, "1"); } catch (e) {}
    closeModal();
    showToast("Modo Administrador ativado.");
    render();
  } else {
    const err = form.querySelector(".admin-login__err");
    if (err) err.hidden = false;
    const inp = form.querySelector('input[name="password"]');
    if (inp) { inp.value = ""; inp.focus(); }
    showToast("Palavra-passe incorreta.");
  }
}

function requireAdmin() {
  if (isAdmin) return true;
  showToast("Ação reservada ao Administrador. Ative o modo Administrador.");
  return false;
}

function syncAdminUi() {
  document.body.classList.toggle("admin-mode", isAdmin);
  const adminBtn = document.querySelector("#admin-toggle");
  if (adminBtn) {
    adminBtn.classList.toggle("is-admin", isAdmin);
    adminBtn.title = isAdmin ? "Desligar modo Administrador" : "Ativar modo Administrador";
    const label = adminBtn.querySelector(".admin-label");
    if (label) label.textContent = isAdmin ? "Admin ✓" : "Admin";
  }
}
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
  pencil: '<svg viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'
};

let state = loadState();

document.addEventListener("click", async (event) => {
  // Apanha botões e também elementos não-botão com data-action (ex.: células do mapa de ausências).
  const button = event.target.closest("button, [data-action]");
  if (!button) return;

  const view = button.dataset.view;
  if (view) {
    // "Nova ocorrência" abre agora em janela modal (não é uma vista).
    if (view === "new") { state.avariaFromVistoria = null; openOccurrenceModal(); return; }
    state.avariaFromVistoria = null;
    // Navegação "limpa": cada separador abre sem os filtros do anterior. Os filtros
    // do Dashboard usam ações próprias (dashboard-filter/dashboard-fleet) e não passam por aqui.
    resetBrowseFilters();
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
  if (action === "month-toggle") { toggleMonth(button.dataset.key); return; }
  if (action === "toggle-admin") { await toggleAdminMode(); return; }
  if (ADMIN_ACTIONS.has(action) && !requireAdmin()) return;
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
    const stage       = button.dataset.stage || "";
    // Reset all filters first
    state.filters.search       = "";
    state.filters.status       = statusValue ? [statusValue] : [];
    state.filters.situation    = [];
    state.filters.type         = [];
    state.filters.respLog      = [];
    state.filters.company      = [];
    state.filters.workshopType = "";
    state.filters.semPrevisao  = false;
    state.filters.occurrenceStale = false;
    state.filters.occurrenceStage = stage;
    // Apply the specific filter for this card
    if (filterKey === "search")      state.filters.search       = filterValue;
    if (filterKey === "situation")   state.filters.situation    = [filterValue];
    if (filterKey === "status")      state.filters.status       = [filterValue];
    if (filterKey === "type")        state.filters.type         = [filterValue];
    if (filterKey === "workshop")    state.filters.workshopType = filterValue;
    if (filterKey === "semprevisao") state.filters.semPrevisao  = true;
    if (filterKey === "stale")       state.filters.occurrenceStale = true;
    state.currentView = "breakdowns";
    saveState();
    render();
  }
  if (action === "dashboard-fleet") {
    state.filters.fleetScope  = button.dataset.scope || "";
    state.filters.fleetSearch = "";
    state.currentView = "fleet";
    saveState();
    render();
  }
  if (action === "clear-filter") {
    setFilter(button.dataset.filter, "");
    return;
  }
  if (action === "select-breakdown") {
    state.selectedId = button.dataset.id;
    saveState();
    openDetailModal(button.dataset.id);
  }
  if (action === "fault-toggle" || action === "fault-remove" || action === "fault-add") {
    await handleFaultAction(action, button);
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
  if (action === "dock-item-edit") {
    state.dockEditId = button.dataset.id;
    updateMeetingDock();
  }
  if (action === "dock-item-edit-cancel") {
    state.dockEditId = "";
    updateMeetingDock();
  }
  if (action === "dock-item-delete") {
    deleteMeetingEvent("", button.dataset.id);
  }
  if (action === "meeting-event-edit") {
    editMeetingEventFromReport(button.dataset.mid, button.dataset.id);
  }
  if (action === "meeting-event-delete") {
    deleteMeetingEvent(button.dataset.mid, button.dataset.id);
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
  if (action === "delete-meeting") {
    await deleteMeeting(button.dataset.id);
  }
  if (action === "close-meeting-row") {
    await closeMeetingById(button.dataset.id);
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
  if (action === "reassign-vehicle") {
    await reassignBreakdownVehicle(button.dataset.id);
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
  if (action === "fleet-view") {
    state.fleetView = button.dataset.mode === "table" ? "table" : "cards";
    saveState();
    render();
  }
  if (action === "fleet-scope-clear") {
    state.filters.fleetScope = "";
    saveState();
    render();
  }
  if (action === "new-fleet-modal") {
    openFleetModal();
  }
  if (action === "new-ausencia-modal") {
    openAusenciaModal();
  }
  if (action === "fleet-logisticsresp-conjunto") {
    await applyLogisticsRespToConjunto(button.dataset.equipment);
  }
  if (action === "ausencia-prev-month") shiftAusenciaMonth(-1);
  if (action === "ausencia-next-month") shiftAusenciaMonth(1);
  if (action === "ausencia-today") {
    state.ausenciaMonth = currentMonthISO();
    const p = ausPaint();
    if (p.driver) p.days = paintInitDays(p.driver, p.type, state.ausenciaMonth);
    saveState();
    render();
  }
  if (action === "ausencia-mode") {
    state.ausenciaViewMode = button.dataset.mode === "month" ? "month" : "year";
    saveState();
    render();
  }
  if (action === "ausencia-year-prev" || action === "ausencia-year-next") {
    const y = state.ausenciaYear || new Date().getFullYear();
    state.ausenciaYear = y + (action === "ausencia-year-next" ? 1 : -1);
    saveState();
    render();
  }
  if (action === "ausencia-resp") {
    state.filters.ausenciaResp = button.dataset.resp || "";
    saveState();
    render();
  }
  if (action === "ausencia-cell") {
    openAusenciaCellDetail(button.dataset.driver || "", Number(button.dataset.month));
  }
  if (action === "ausencia-day") {
    openAusenciaDayDetail(button.dataset.date || "");
  }
  if (action === "ausencia-paint-day") {
    togglePaintDay(button.dataset.date || "");
  }
  if (action === "ausencia-paint-save") {
    await savePaint();
  }
  if (action === "ausencia-paint-cancel") {
    cancelPaint();
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
  if (action === "close-modal") {
    closeModal();
  }
  if (action === "new-entidade") {
    openEntidadeModal("");
  }
  if (action === "edit-entidade") {
    openEntidadeModal(button.dataset.id);
  }
  if (action === "delete-entidade") {
    await deleteEntidade(button.dataset.id);
  }
  if (action === "entidade-cat") {
    state.filters.entidadeCategoria = button.dataset.cat || "";
    saveState();
    render();
  }
  if (action === "audit-type") {
    state.filters.auditType = button.dataset.type || "";
    saveState();
    render();
  }
  if (action === "audit-period") {
    state.filters.auditPeriod = button.dataset.period || "";
    saveState();
    render();
  }
  if (action === "occurrence-stage") {
    state.filters.occurrenceStage = button.dataset.stage || "";
    saveState();
    render();
  }
  if (action === "definicoes-vt") {
    state.definicoesVehicleType = button.dataset.vt || "Trator";
    saveState();
    render();
  }
  if (action === "new-fault-type") {
    openFaultTypeModal("");
  }
  if (action === "edit-fault-type") {
    openFaultTypeModal(button.dataset.id);
  }
  if (action === "delete-fault-type") {
    await deleteFaultType(button.dataset.id);
  }
  if (action === "gantt-mode") {
    state.ganttMode = button.dataset.mode || "week";
    saveState();
    render();
  }
  if (action === "gantt-prev") { ganttShift(-1); saveState(); render(); }
  if (action === "gantt-next") { ganttShift(1); saveState(); render(); }
  if (action === "gantt-today") { state.ganttAnchor = todayISO(); saveState(); render(); }
  if (action === "gantt-goto-day") {
    state.ganttAnchor = button.dataset.date || todayISO();
    state.ganttMode = "day";
    saveState();
    render();
  }
});

// Fechar modal com a tecla Escape.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isModalOpen()) closeModal();
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.filter) {
    setFilter(target.dataset.filter, target.value);
  }
  if (target.id === "new-plate") {
    fillFleetMatchFromPlate(target.value, false);
  }
  if (target.id === "ausencia-driver") {
    const el = document.querySelector("#ausencia-veh-preview");
    if (el) el.innerHTML = ausenciaVehiclePreviewHtml(target.value);
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.dataset.filter) {
    setFilter(target.dataset.filter, target.value);
  }
  if (target.dataset.filterMulti) {
    toggleMultiFilter(target.dataset.filterMulti, target.value);
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
  if (target.dataset.fleetWorkshop) {
    await updateFleetWorkshop(target.dataset.equipment, target.value);
  }
  if (target.dataset.fleetPartner) {
    await updateFleetPartner(target.dataset.equipment, target.value);
  }
  if (target.dataset.fleetLogisticsresp) {
    await updateFleetLogisticsResp(target.dataset.equipment, target.value);
  }
  if (target.dataset.ausenciaId && target.dataset.ausenciaField) {
    await updateAusenciaField(target.dataset.ausenciaId, target.dataset.ausenciaField, target.value);
  }
  if (target.dataset.ausenciaPaint === "driver") {
    setPaintDriver(target.value);
  }
  if (target.dataset.ausenciaPaint === "type") {
    setPaintType(target.value);
  }
  if (target.dataset.fleetStatus) {
    await updateFleetStatus(target.dataset.equipment, target.value);
  }
  if (target.dataset.faultPriority) {
    await updateFaultTypePriority(target.dataset.id, target.value);
  }
  if (target.id === "new-description-filter") {
    repopulatePlateOptions(target.value);
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

document.addEventListener("click", (event) => {
  const clearBtn = event.target.closest("[data-filter-clear]");
  if (clearBtn) {
    event.preventDefault();
    clearMultiFilter(clearBtn.dataset.filterClear);
    return;
  }
  const summary = event.target.closest("summary[data-filter-summary]");
  if (summary) {
    event.preventDefault();
    const name = summary.dataset.filterSummary;
    openFilterMenu = openFilterMenu === name ? null : name;
    render();
    return;
  }
  if (!event.target.closest(".filter-menu") && openFilterMenu !== null) {
    openFilterMenu = null;
    render();
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (ADMIN_FORMS.has(form.dataset.form) && !requireAdmin()) {
    event.preventDefault();
    return;
  }
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
    addMeetingNote(String(data.get("type") || "note"), String(data.get("text") || ""), String(data.get("breakdownId") || ""));
  }
  if (form.dataset.form === "dock-edit") {
    event.preventDefault();
    const data = new FormData(form);
    saveMeetingNoteEdit(String(data.get("id") || ""), String(data.get("text") || ""));
  }
  if (form.dataset.form === "new-ausencia") {
    event.preventDefault();
    await handleNewAusencia(form);
  }
  if (form.dataset.form === "edit-vistoria") {
    event.preventDefault();
    await handleEditVistoria(form);
  }
  if (form.dataset.form === "entidade") {
    event.preventDefault();
    await handleSaveEntidade(form);
  }
  if (form.dataset.form === "fault-type") {
    event.preventDefault();
    await handleSaveFaultType(form);
  }
  if (form.dataset.form === "admin-login") {
    event.preventDefault();
    await handleAdminLogin(form);
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
    dockEditId: "",
    expandedMonths: [],
    meetings: [],
    dashboardDateTab: "inspectionAt",
    sourceGeneratedAt: seed.generatedAt || "",
    fleet: seed.fleet || [],
    vistorias: [],
    ausencias: [],
    entidades: [],
    faultTypes: [],
    definicoesVehicleType: "Trator",
    fleetView: "cards",
    ganttMode: "week",
    ganttAnchor: "",
    ausenciaMonth: currentMonthISO(),
    ausenciaViewMode: "year",
    ausenciaYear: new Date().getFullYear(),
    ausenciaPaint: { driver: "", type: ABSENCE_TYPES[0], days: {} },
    breakdowns,
    snapshots: seed.snapshots || [],
    audit: buildAudit(breakdowns),
    filters: {
      search: "",
      status: [],
      situation: [],
      type: [],
      respLog: [],
      company: [],
      workshopType: "",
      semPrevisao: false,
      occurrenceStale: false,
      fleetSearch: "",
      fleetScope: "",
      auditSearch: "",
      auditType: "",
      auditPeriod: "",
      vistoriaType: "",
      vistoriaResult: "",
      ausenciaSort: "date",
      ausenciaSearch: "",
      ausenciaResp: "",
      entidadeSearch: "",
      entidadeCategoria: "",
      occurrenceStage: ""
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
    interventionType: item.interventionType || "Corretiva",
    occurrenceNumber: item.occurrenceNumber || "",
    priority: item.priority || "",
    communicatedAt: item.communicatedAt || "",
    onSite: !!item.onSite,
    km: item.km ?? "",
    registeredBy: item.registeredBy || "",
    logisticsResp: item.logisticsResp || "",
    recurrentOf: item.recurrentOf || "",
    expectedEntryAt: item.expectedEntryAt || null,
    workshopExitAt: item.workshopExitAt || null,
    faults: normalizeFaults(item.faults),
    preventivePlan: normalizePreventive(item.preventivePlan),
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
  const [fleetResult, breakdownsResult, snapshotsResult, auditResult, vistoriasResult, meetingsResult, ausenciasResult, entidadesResult, faultTypesResult] = await Promise.all([
    remoteClient.from("avarias_fleet").select("*").order("equipment", { ascending: true }),
    remoteClient.from("avarias_breakdowns").select("*").order("updated_at", { ascending: false }),
    remoteClient.from("avarias_snapshots").select("*").order("date", { ascending: true }),
    remoteClient.from("avarias_audit_events").select("*").order("at", { ascending: false }),
    remoteClient.from("avarias_vistorias").select("*").order("date", { ascending: false }),
    remoteClient.from("avarias_reunioes").select("*").order("started_at", { ascending: false }),
    remoteClient.from("avarias_ausencias").select("*").order("start_at", { ascending: true }),
    remoteClient.from("avarias_entidades").select("*").order("empresa", { ascending: true }),
    remoteClient.from("avarias_tipos_avaria").select("*").order("position", { ascending: true })
  ]);

  [fleetResult, breakdownsResult, snapshotsResult, auditResult].forEach((result) => {
    if (result.error) throw result.error;
  });
  // as tabelas de vistorias/reuniões podem ainda não existir — ignora o erro silenciosamente

  // Deteta se a coluna "driver" já existe na base (migração 002). Se as linhas
  // vierem sem a chave, não a enviamos nas gravações para não partir o upsert.
  if (fleetResult.data.length) {
    remoteFleetHasDriver = Object.prototype.hasOwnProperty.call(fleetResult.data[0], "driver");
    remoteFleetHasRevision = Object.prototype.hasOwnProperty.call(fleetResult.data[0], "revision_at");
    remoteFleetHasWorkshop = Object.prototype.hasOwnProperty.call(fleetResult.data[0], "preferred_workshop");
    remoteFleetHasPartner = Object.prototype.hasOwnProperty.call(fleetResult.data[0], "partner_equipment");
    remoteFleetHasLogisticsResp = Object.prototype.hasOwnProperty.call(fleetResult.data[0], "logistics_resp");
  }
  if (breakdownsResult.data.length) {
    remoteBreakdownHasOccurrence = Object.prototype.hasOwnProperty.call(breakdownsResult.data[0], "occurrence_number");
    remoteBreakdownHasDetails = Object.prototype.hasOwnProperty.call(breakdownsResult.data[0], "communicated_at");
    remoteBreakdownHasWorkshopExit = Object.prototype.hasOwnProperty.call(breakdownsResult.data[0], "workshop_exit_at");
    remoteBreakdownHasFaults = Object.prototype.hasOwnProperty.call(breakdownsResult.data[0], "faults");
    remoteBreakdownHasPreventive = Object.prototype.hasOwnProperty.call(breakdownsResult.data[0], "preventive_plan");
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
  const localWorkshops = new Map((state.fleet || []).map((f) => [String(f.equipment), f.preferredWorkshop || ""]));
  const localPartners = new Map((state.fleet || []).map((f) => [String(f.equipment), f.partnerEquipment || ""]));
  const localLogResp = new Map((state.fleet || []).map((f) => [String(f.equipment), f.logisticsResp || ""]));
  const mapFleetRow = (row) => {
    const item = dbFleetToApp(row);
    if (!remoteFleetHasDriver) {
      const localDriver = localDrivers.get(String(item.equipment));
      if (localDriver) item.driver = localDriver;
    }
    if (!remoteFleetHasWorkshop) {
      const localWorkshop = localWorkshops.get(String(item.equipment));
      if (localWorkshop) item.preferredWorkshop = localWorkshop;
    }
    if (!remoteFleetHasPartner) {
      const localPartner = localPartners.get(String(item.equipment));
      if (localPartner) item.partnerEquipment = localPartner;
    }
    if (!remoteFleetHasLogisticsResp) {
      const localLog = localLogResp.get(String(item.equipment));
      if (localLog) item.logisticsResp = localLog;
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
    entidades: entidadesResult.error ? (state.entidades || []) : entidadesResult.data.map(dbEntidadeToApp),
    faultTypes: faultTypesResult.error ? (state.faultTypes || []) : faultTypesResult.data.map(dbFaultTypeToApp),
    breakdowns,
    snapshots: snapshotsResult.data.map(dbSnapshotToApp),
    audit: auditResult.data.length ? auditResult.data.map(dbAuditToApp) : buildAudit(breakdowns),
    filters: previousFilters
  };
  applyDriverImport();
  const recMot = reconciliarMotoristas();
  saveState();
  render();
  if (recMot.fleet.length || recMot.ausencias.length) {
    persistRemoteSafely(async () => {
      for (const f of recMot.fleet) await persistFleetRemote(f);
      for (const a of recMot.ausencias) await persistAusenciaRemote(a);
    });
  }
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
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_entidades" }, (payload) => {
      applyRemoteRow(payload, "entidades", dbEntidadeToApp);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "avarias_tipos_avaria" }, (payload) => {
      applyRemoteRow(payload, "faultTypes", dbFaultTypeToApp);
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
    if (collection === "fleet" && !remoteFleetHasRevision) {
      item.revisionAt = state.fleet[index].revisionAt || item.revisionAt;
    }
    if (collection === "fleet" && !remoteFleetHasWorkshop) {
      item.preferredWorkshop = state.fleet[index].preferredWorkshop || item.preferredWorkshop;
    }
    if (collection === "fleet" && !remoteFleetHasPartner) {
      item.partnerEquipment = state.fleet[index].partnerEquipment || item.partnerEquipment;
    }
    if (collection === "fleet" && !remoteFleetHasLogisticsResp) {
      item.logisticsResp = state.fleet[index].logisticsResp || item.logisticsResp;
    }
    if (collection === "breakdowns" && !remoteBreakdownHasOccurrence) {
      const prev = state.breakdowns[index];
      item.occurrenceNumber = prev.occurrenceNumber || item.occurrenceNumber;
      item.priority = prev.priority || item.priority;
      item.interventionType = prev.interventionType || item.interventionType;
    }
    if (collection === "breakdowns" && !remoteBreakdownHasDetails) {
      const prev = state.breakdowns[index];
      item.communicatedAt = prev.communicatedAt || item.communicatedAt;
      item.onSite = prev.onSite || item.onSite;
      item.km = prev.km || item.km;
      item.registeredBy = prev.registeredBy || item.registeredBy;
      item.logisticsResp = prev.logisticsResp || item.logisticsResp;
      item.recurrentOf = prev.recurrentOf || item.recurrentOf;
      item.expectedEntryAt = prev.expectedEntryAt || item.expectedEntryAt;
    }
    if (collection === "breakdowns" && !remoteBreakdownHasWorkshopExit) {
      item.workshopExitAt = state.breakdowns[index].workshopExitAt || item.workshopExitAt;
    }
    if (collection === "breakdowns" && !remoteBreakdownHasFaults) {
      const pf = state.breakdowns[index].faults;
      if (pf && pf.length) item.faults = pf;
    }
    if (collection === "breakdowns" && !remoteBreakdownHasPreventive) {
      item.preventivePlan = state.breakdowns[index].preventivePlan || item.preventivePlan;
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

async function persistEntidadeRemote(entidade) {
  if (!remoteStatus.ready || !remoteClient || !entidade) return;
  updateSyncStatus("A guardar entidade", "syncing", true);
  const { error } = await remoteClient
    .from("avarias_entidades")
    .upsert(appEntidadeToDb(entidade), { onConflict: "id" });
  if (error) throw error;
  updateSyncStatus("Partilhado em tempo real", "remote", true);
}

async function deleteEntidadeRemote(id) {
  if (!remoteStatus.ready || !remoteClient) return;
  const { error } = await remoteClient.from("avarias_entidades").delete().eq("id", String(id));
  if (error) throw error;
}

function appEntidadeToDb(item) {
  return {
    id: String(item.id),
    empresa: item.empresa || "",
    tipo: item.tipo || null,
    categoria: item.categoria || null,
    contacto_nome: item.contactoNome || null,
    telefone: item.telefone || null,
    email: item.email || null,
    notas: item.notas || null,
    created_at: item.createdAt || new Date().toISOString(),
    created_by: item.createdBy || remoteConfig.operator || "Utilizador"
  };
}

function dbEntidadeToApp(row) {
  return {
    id: String(row.id),
    empresa: row.empresa || "",
    tipo: row.tipo || "",
    categoria: row.categoria || "",
    contactoNome: row.contacto_nome || "",
    telefone: row.telefone || "",
    email: row.email || "",
    notas: row.notas || "",
    createdAt: row.created_at || "",
    createdBy: row.created_by || ""
  };
}

async function persistFaultTypeRemote(ft) {
  if (!remoteStatus.ready || !remoteClient || !ft) return;
  updateSyncStatus("A guardar tipo de avaria", "syncing", true);
  const { error } = await remoteClient
    .from("avarias_tipos_avaria")
    .upsert(appFaultTypeToDb(ft), { onConflict: "id" });
  if (error) throw error;
  updateSyncStatus("Partilhado em tempo real", "remote", true);
}

async function deleteFaultTypeRemote(id) {
  if (!remoteStatus.ready || !remoteClient) return;
  const { error } = await remoteClient.from("avarias_tipos_avaria").delete().eq("id", String(id));
  if (error) throw error;
}

function appFaultTypeToDb(item) {
  return {
    id: String(item.id),
    vehicle_type: item.vehicleType || null,
    grupo: item.grupo || null,
    nome: item.nome || "",
    hint: item.hint || null,
    suggested_priority: item.suggestedPriority || null,
    position: Number.isFinite(item.position) ? item.position : null,
    active: item.active !== false
  };
}

function dbFaultTypeToApp(row) {
  return {
    id: String(row.id),
    vehicleType: row.vehicle_type || "",
    grupo: row.grupo || "",
    nome: row.nome || "",
    hint: row.hint || "",
    suggestedPriority: row.suggested_priority || "",
    position: row.position ?? 0,
    active: row.active !== false
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
  if (d.includes("trator") || d.includes("tractor")) return "Trator";
  if (d.includes("camiao")) return "Camião";
  return "";
}

function fillVistoriaFromPlate(value) {
  const match = findFleetByPlate(value);
  const equipment = document.querySelector("#vistoria-equipment");
  const typeSelect = document.querySelector("#vistoria-type");
  if (equipment) equipment.value = match?.equipment ?? "";
  if (match && typeSelect) {
    const inferred = inferVistoriaType(match.description);
    if (inferred) {
      typeSelect.value = inferred;
      applyVistoriaTypeVisibility(inferred);
    }
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

function vistoriaListRow(v) {
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
            ${renderMonthGroups("vistorias", list, (v) => v.date, 9, vistoriaListRow, "vistoria", "vistorias", "Sem vistorias para estes filtros.")}
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
  saveState();
  openOccurrenceModal();
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
  // "Revisão" (só tratores) — só envia quando a coluna existe na base (migração 004).
  if (remoteFleetHasRevision) row.revision_at = item.revisionAt || null;
  // Oficina preferencial (vem das Entidades) — só envia quando a coluna existe (migração 005).
  if (remoteFleetHasWorkshop) row.preferred_workshop = item.preferredWorkshop || null;
  // Conjunto (trator+reboque) e Resp. logística por viatura — migração 009.
  if (remoteFleetHasPartner) row.partner_equipment = item.partnerEquipment || null;
  if (remoteFleetHasLogisticsResp) row.logistics_resp = item.logisticsResp || null;
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
    wheelHubReviewAt: row.wheel_hub_review_at || null,
    revisionAt: row.revision_at || null,
    preferredWorkshop: row.preferred_workshop || "",
    partnerEquipment: row.partner_equipment ? normalizeEquipment(row.partner_equipment) : "",
    logisticsResp: row.logistics_resp || ""
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
  // Ocorrências (tipo de intervenção, numeração, prioridade) — só envia quando
  // as colunas já existem na base (migração 006), para não partir o upsert.
  if (remoteBreakdownHasOccurrence) {
    row.intervention_type = item.interventionType || null;
    row.occurrence_number = item.occurrenceNumber || null;
    row.priority = item.priority || null;
  }
  // Detalhes da ocorrência (Fatia 2) — só envia quando as colunas já existem (migração 007).
  if (remoteBreakdownHasDetails) {
    row.communicated_at = item.communicatedAt || null;
    row.on_site = !!item.onSite;
    row.km = item.km || null;
    row.registered_by = item.registeredBy || null;
    row.logistics_resp = item.logisticsResp || null;
    row.recurrent_of = item.recurrentOf || null;
    row.expected_entry_at = item.expectedEntryAt || null;
  }
  // Saída de oficina (Fatia detalhe) — só envia quando a coluna existe (migração 010).
  if (remoteBreakdownHasWorkshopExit) row.workshop_exit_at = item.workshopExitAt || null;
  // Lista de avarias da ocorrência (multi-avaria) — só envia quando a coluna existe (migração 011).
  if (remoteBreakdownHasFaults) row.faults = normalizeFaults(item.faults);
  // Plano de preventiva periódica — só envia quando a coluna existe (migração 012).
  if (remoteBreakdownHasPreventive) row.preventive_plan = normalizePreventive(item.preventivePlan);
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
    interventionType: row.intervention_type || "Corretiva",
    occurrenceNumber: row.occurrence_number || "",
    priority: row.priority || "",
    communicatedAt: row.communicated_at || "",
    onSite: !!row.on_site,
    km: (row.km ?? "") === null ? "" : (row.km ?? ""),
    registeredBy: row.registered_by || "",
    logisticsResp: row.logistics_resp || "",
    recurrentOf: row.recurrent_of || "",
    expectedEntryAt: row.expected_entry_at || null,
    workshopExitAt: row.workshop_exit_at || null,
    faults: row.faults,
    preventivePlan: row.preventive_plan || null,
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

async function deleteMeetingRemote(id) {
  if (!remoteStatus.ready || !remoteClient) return;
  const { error } = await remoteClient.from("avarias_reunioes").delete().eq("id", String(id));
  if (error) throw error;
}

async function deleteMeeting(id) {
  const m = findMeetingById(id);
  if (!m) return;
  if (!window.confirm(`Eliminar a reunião de ${formatDate((m.startedAt || "").slice(0, 10))}? Esta ação não pode ser anulada.`)) return;
  state.meetings = state.meetings.filter((x) => x !== m);
  if (state.activeMeetingId === m.id) state.activeMeetingId = "";
  if (state.selectedMeetingId === m.id) { state.selectedMeetingId = ""; state.meetingView = "consult"; }
  saveState();
  showToast("Reunião eliminada.");
  render();
  await persistRemoteSafely(() => deleteMeetingRemote(id));
}

async function closeMeetingById(id) {
  const m = findMeetingById(id);
  if (!m || m.endedAt) return;
  if (!window.confirm("Encerrar esta reunião? Vai ser gerado o relatório com o resumo das atualizações.")) return;
  m.endedAt = new Date().toISOString();
  m.durationMin = Math.max(1, Math.round((new Date(m.endedAt) - new Date(m.startedAt)) / 60000));
  if (state.activeMeetingId === m.id) state.activeMeetingId = "";
  state.selectedMeetingId = m.id;
  state.meetingView = "report";
  saveState();
  showToast(`Reunião encerrada (${m.durationMin} min).`);
  render();
  await persistRemoteSafely(() => persistMeetingRemote(m));
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

// Ocorrências ativas (em curso/agendadas) para associar notas de reunião a uma viatura.
function dockOccurrenceOptions(selectedId) {
  return state.breakdowns
    .filter((b) => b.status !== "Concluido")
    .slice()
    .sort((a, b) => (a.plate || "").localeCompare(b.plate || "", "pt", { numeric: true }))
    .map((b) => `<option value="${escapeAttr(b.id)}"${String(selectedId) === String(b.id) ? " selected" : ""}>${escapeHtml(`${b.plate || "-"} · ${b.occurrenceNumber || b.interventionType || "ocorrência"}`)}</option>`)
    .join("");
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
        ${entries.length ? entries.map((e) => {
          if (state.dockEditId === e.id) {
            return `
          <form class="dock-item dock-item--edit" data-form="dock-edit">
            <input type="hidden" name="id" value="${escapeAttr(e.id)}">
            <input class="dock-edit-input" name="text" value="${escapeAttr(e.summary || "")}" autocomplete="off" required>
            <button class="dock-mini dock-mini--ok" type="submit" title="Guardar">✔️</button>
            <button class="dock-mini" type="button" data-action="dock-item-edit-cancel" title="Cancelar">✖️</button>
          </form>`;
          }
          return `
          <div class="dock-item dock-item--${e.type}${e.done ? " done" : ""}">
            ${e.type === "task"
              ? `<button class="dock-check" type="button" data-action="dock-task-toggle" data-id="${escapeAttr(e.id)}" title="Marcar concluída">${e.done ? "✅" : "⬜"}</button>`
              : `<span class="dock-ic">🗒️</span>`}
            <span class="dock-text">${(e.plate || e.equipment) ? `<span class="dock-veh-tag">🚚 ${escapeHtml(e.plate || `Equip. ${e.equipment}`)}</span> ` : ""}${escapeHtml(e.summary || "")}</span>
            <span class="dock-meta">
              <time>${escapeHtml(formatTimeOnly(e.at))}</time>
              <button class="dock-mini" type="button" data-action="dock-item-edit" data-id="${escapeAttr(e.id)}" title="Editar">✏️</button>
              <button class="dock-mini" type="button" data-action="dock-item-delete" data-id="${escapeAttr(e.id)}" title="Eliminar">🗑️</button>
            </span>
          </div>`;
        }).join("") : `<p class="dock-empty">Sem notas nem tarefas ainda. Escreve abaixo. ✍️</p>`}
      </div>
      <form class="dock-form" data-form="dock-note">
        <div class="dock-form__row">
          <select name="type" class="dock-type" aria-label="Tipo">
            <option value="note" ${type === "note" ? "selected" : ""}>Nota</option>
            <option value="task" ${type === "task" ? "selected" : ""}>Tarefa</option>
          </select>
          <select name="breakdownId" class="dock-veh" aria-label="Associar a viatura (opcional)">
            <option value="">— geral (sem viatura) —</option>
            ${dockOccurrenceOptions(state.dockNoteBreakdownId)}
          </select>
        </div>
        <div class="dock-form__row">
          <input id="dock-input" name="text" placeholder="Escrever…" autocomplete="off" required>
          <button class="dock-send" type="submit">Adicionar</button>
        </div>
        <p class="dock-form__hint">Com viatura selecionada, a nota entra no histórico dessa ocorrência.</p>
      </form>
    </div>`;
  const editInput = dock.querySelector(".dock-edit-input");
  if (editInput) {
    editInput.focus();
    editInput.setSelectionRange(editInput.value.length, editInput.value.length);
  } else {
    const log = document.querySelector("#dock-log");
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function addMeetingNote(type, text, breakdownId) {
  const m = getActiveMeeting();
  const clean = String(text || "").trim();
  if (!m || !clean) return;
  state.dockNoteType = type === "task" ? "task" : "note";
  state.dockNoteBreakdownId = breakdownId || ""; // mantém a viatura selecionada para a próxima nota
  const bd = breakdownId ? state.breakdowns.find((b) => String(b.id) === String(breakdownId)) : null;
  m.events.push({
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    type: state.dockNoteType,
    summary: clean,
    done: false,
    breakdownId: bd ? bd.id : "",
    equipment: bd ? bd.equipment : "",
    plate: bd ? bd.plate : "",
    status: bd ? bd.status : ""
  });
  // Nota associada a uma viatura → entra também no histórico da ocorrência (per-viatura, sem duplicar).
  let auditEvent = null;
  if (bd) {
    appendHistory(bd, bd.status, `[Reunião] ${clean}`, todayISO());
    auditEvent = logAudit(bd, "Reunião", clean);
  }
  saveState();
  updateMeetingDock();
  if (bd) { render(); refreshDetailModal(); }
  document.querySelector("#dock-input")?.focus();
  showToast(bd ? `Nota no histórico de ${bd.plate || bd.equipment}.` : (state.dockNoteType === "task" ? "Tarefa adicionada." : "Nota adicionada."));
  persistRemoteSafely(async () => {
    await persistMeetingRemote(m);
    if (bd) { await persistBreakdownRemote(bd); await persistAuditRemote(auditEvent); }
  });
}

// Dock arrastável pela barra de título (janela de reunião movível — FASE2 update).
(function enableDockDrag() {
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, dockEl = null;
  document.addEventListener("mousedown", (e) => {
    const head = e.target.closest(".dock-head");
    if (!head || e.target.closest("button")) return;
    dockEl = document.querySelector("#meeting-dock");
    if (!dockEl) return;
    const rect = dockEl.getBoundingClientRect();
    dockEl.style.left = rect.left + "px";
    dockEl.style.top = rect.top + "px";
    dockEl.style.right = "auto";
    dockEl.style.bottom = "auto";
    dragging = true; sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
    document.body.classList.add("dock-dragging");
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging || !dockEl) return;
    let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
    nx = Math.max(4, Math.min(window.innerWidth - 60, nx));
    ny = Math.max(4, Math.min(window.innerHeight - 40, ny));
    dockEl.style.left = nx + "px";
    dockEl.style.top = ny + "px";
  });
  document.addEventListener("mouseup", () => { dragging = false; document.body.classList.remove("dock-dragging"); });
})();

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

// Encontra uma reunião por id (a decorrer ou encerrada).
function findMeetingById(id) {
  return state.meetings.find((x) => String(x.id) === String(id)) || null;
}

// Guarda a edição do texto de uma nota/tarefa (dock da reunião a decorrer).
function saveMeetingNoteEdit(id, text) {
  const m = getActiveMeeting();
  const clean = String(text || "").trim();
  if (!m) return;
  const e = (m.events || []).find((x) => x.id === id);
  if (!e) return;
  if (!clean) { showToast("O texto não pode ficar vazio."); return; }
  e.summary = clean;
  state.dockEditId = "";
  saveState();
  updateMeetingDock();
  showToast("Atualizado.");
  persistRemoteSafely(() => persistMeetingRemote(m));
}

// Elimina um registo (nota/tarefa/nova avaria/atualização) de uma reunião.
// Não apaga a avaria em si — remove apenas o registo do relatório da reunião.
function deleteMeetingEvent(meetingId, eventId) {
  const m = meetingId ? findMeetingById(meetingId) : getActiveMeeting();
  if (!m) return;
  const e = (m.events || []).find((x) => x.id === eventId);
  if (!e) return;
  const isLog = e.type !== "note" && e.type !== "task";
  const label = e.type === "task" ? "esta tarefa" : e.type === "note" ? "esta nota" : "este registo";
  const extra = isLog ? "\n\n(Remove apenas o registo do relatório; a avaria em si não é afetada.)" : "";
  if (!window.confirm(`Eliminar ${label}?${extra}`)) return;
  m.events = (m.events || []).filter((x) => x.id !== eventId);
  if (state.dockEditId === eventId) state.dockEditId = "";
  saveState();
  updateMeetingDock();
  if (state.currentView === "meeting" && state.meetingView === "report") render();
  showToast("Eliminado.");
  persistRemoteSafely(() => persistMeetingRemote(m));
}

// Edita o texto de um registo a partir do relatório (reunião a decorrer ou encerrada).
function editMeetingEventFromReport(meetingId, eventId) {
  const m = findMeetingById(meetingId);
  if (!m) return;
  const e = (m.events || []).find((x) => x.id === eventId);
  if (!e) return;
  const next = window.prompt("Editar texto:", e.summary || "");
  if (next === null) return;
  const clean = String(next).trim();
  if (!clean) { showToast("O texto não pode ficar vazio."); return; }
  e.summary = clean;
  saveState();
  render();
  showToast("Atualizado.");
  persistRemoteSafely(() => persistMeetingRemote(m));
}

// Navegação em 2 níveis: 5 áreas, cada uma com as suas secções (redesign ARGOS).
const NAV_GROUPS = [
  { id: "dashboard", label: "Dashboard", views: [["dashboard", "Dashboard"]] },
  { id: "manutencao", label: "Manutenção", views: [["gantt", "Planeamento"], ["breakdowns", "Ocorrências"], ["meeting", "Reuniões"]] },
  { id: "frota", label: "Frota", views: [["fleet", "Viaturas"], ["fleet-inativas", "Inativas"], ["vistoria", "Vistorias"], ["ausencias", "Ausências"], ["definicoes", "Definições"]] },
  { id: "entidades", label: "Entidades", views: [["entidades", "Entidades"]] },
  { id: "analise", label: "Análise", views: [["audit", "Rastreio"]] }
];

function navGroupForView(view) {
  return NAV_GROUPS.find((g) => g.views.some(([v]) => v === view)) || NAV_GROUPS[0];
}

function renderNav() {
  const groupTabs = document.querySelector("#group-tabs");
  const subNav = document.querySelector("#subview-nav");
  if (!groupTabs) return;
  const activeGroup = navGroupForView(state.currentView);
  groupTabs.innerHTML = NAV_GROUPS.map((g) => {
    const primary = g.views[0][0];
    return `<button type="button" data-view="${escapeAttr(primary)}" class="${g === activeGroup ? "active" : ""}">${escapeHtml(g.label)}</button>`;
  }).join("");

  if (subNav) {
    if (activeGroup.views.length > 1) {
      subNav.innerHTML = activeGroup.views.map(([v, l]) =>
        `<button type="button" data-view="${escapeAttr(v)}" class="${state.currentView === v ? "active" : ""}">${escapeHtml(l)}</button>`
      ).join("");
      subNav.hidden = false;
    } else {
      subNav.innerHTML = "";
      subNav.hidden = true;
    }
  }
}

function render(focusSelector = "") {
  const metrics = getMetrics();
  document.querySelector("#data-line").textContent =
    `${state.breakdowns.length} avarias, ${state.fleet.length} viaturas, ${metrics.active} abertas`;
  updateSyncStatus(remoteStatus.label, remoteStatus.className, remoteStatus.ready);

  renderNav();

  const views = {
    dashboard: renderDashboard,
    meeting: renderMeeting,
    breakdowns: renderBreakdowns,
    gantt: renderGantt,
    new: renderNewBreakdown,
    fleet: renderFleet,
    "fleet-inativas": renderFleet,
    vistoria: renderVistoria,
    definicoes: renderDefinicoes,
    entidades: renderEntidades,
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
  syncAdminUi();
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
  ["wheelHubReviewAt", "Cubos de roda"],
  ["revisionAt", "Revisão"]
];

function renderDashboard() {
  const st = getDashboardState();
  const alerts = getImmediateAlerts();
  const ws = getWorkshopBreakdown();
  const next30 = getFleetDateAlerts()
    .filter((a) => Number.isFinite(a.days) && a.days >= 0 && a.days <= 30)
    .sort((a, b) => (a.plate || "").localeCompare(b.plate || "", "pt", { numeric: true }));
  const schedForPlate = (plate) => {
    const p = normalizePlate(plate || "");
    if (!p) return null;
    return state.breakdowns.find((b) => b.status !== "Concluido" && normalizeText(b.interventionType) === "preventiva" && normalizePlate(b.plate) === p) || null;
  };

  const stateCard = (label, value, detail, opts = {}) => {
    const cls = opts.tone ? ` dash-stat--${opts.tone}` : "";
    const body = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><em>${escapeHtml(detail)}</em>`;
    if (opts.fleetScope) {
      return `<button type="button" class="dash-stat dash-stat--btn${cls}" data-action="dashboard-fleet" data-scope="${escapeAttr(opts.fleetScope)}" title="Ver ${escapeAttr(label)}">${body}</button>`;
    }
    if (opts.view) {
      return `<button type="button" class="dash-stat dash-stat--btn${cls}" data-view="${escapeAttr(opts.view)}" title="Abrir ${escapeAttr(label)}">${body}</button>`;
    }
    if (opts.filter) {
      const attrs = Object.entries(opts.filter).map(([k, v]) => `data-${k}="${escapeAttr(v)}"`).join(" ");
      return `<button type="button" class="dash-stat dash-stat--btn${cls}" data-action="dashboard-filter" ${attrs} title="Ver ${escapeAttr(label)}">${body}</button>`;
    }
    return `<article class="dash-stat${cls}">${body}</article>`;
  };

  const alertsHtml = alerts.length
    ? alerts.map((a) => {
        const inner = `<span class="dash-alert__dot">🔴</span><span class="dash-alert__txt"><strong>${escapeHtml(String(a.count))}</strong> ${escapeHtml(a.label)}</span>`;
        if (a.view) return `<button type="button" class="dash-alert" data-view="${escapeAttr(a.view)}">${inner}<span class="dash-alert__cta">Ver →</span></button>`;
        if (a.fleetScope) return `<button type="button" class="dash-alert" data-action="dashboard-fleet" data-scope="${escapeAttr(a.fleetScope)}">${inner}<span class="dash-alert__cta">Ver →</span></button>`;
        if (a.filter) {
          const attrs = Object.entries(a.filter).map(([k, v]) => `data-${k}="${escapeAttr(v)}"`).join(" ");
          return `<button type="button" class="dash-alert" data-action="dashboard-filter" ${attrs}>${inner}<span class="dash-alert__cta">Ver →</span></button>`;
        }
        return `<div class="dash-alert dash-alert--static">${inner}</div>`;
      }).join("")
    : `<div class="dash-alert dash-alert--ok"><span class="dash-alert__dot">🟢</span><span class="dash-alert__txt">Sem alertas críticos. Tudo em ordem.</span></div>`;

  const timelineHtml = next30.length
    ? next30.map((item) => {
        const s = schedForPlate(item.plate);
        const schedTag = s
          ? `<span class="deadline-sched deadline-sched--has" title="Intervenção preventiva já criada">${escapeHtml(s.occurrenceNumber || "Agendado")}</span>`
          : `<span class="deadline-sched deadline-sched--none">Sem agendamentos criados</span>`;
        return `
        <article class="deadline-row deadline-card">
          <div>
            <strong>${escapeHtml(item.plate || "-")} · Equip. ${escapeHtml(item.equipment)}</strong>
            <span>${escapeHtml(item.label)} · ${escapeHtml(formatDate(item.date))}</span>
            ${schedTag}
          </div>
          ${renderDueBadge(item.date)}
        </article>`;
      }).join("")
    : '<p class="empty-state">Sem prazos de frota nos próximos 30 dias.</p>';

  return `
    <section class="dash">
      <div class="panel dash-block dash-block--wide">
        <div class="panel-header"><div><p class="eyebrow">Frota</p><h2>Estado atual da frota</h2><p>Fotografia operacional do momento.</p></div></div>
        <div class="dash-state-grid">
          ${stateCard("Viaturas ativas", st.totalFleet, "Total de viaturas ativas", { fleetScope: "ativas" })}
          ${stateCard("Em oficina", st.inWorkshop, "Avarias com viatura em oficina", { filter: { "filter-key": "situation", "filter-value": "Em oficina", "status-value": "" }, tone: "amber" })}
          ${stateCard("Paradas", st.stopped, "Viaturas paradas por avaria", { filter: { "filter-key": "status", "filter-value": "Parado", "status-value": "" }, tone: "red" })}
          ${stateCard("Aguarda peças", st.waitingParts, "Avarias a aguardar peças", { filter: { "filter-key": "situation", "filter-value": "Aguarda peças", "status-value": "" }, tone: "amber" })}
          ${stateCard("Disponibilidade", st.availability + "%", "Frota disponível para operar", { tone: st.availability >= 80 ? "green" : st.availability >= 60 ? "amber" : "red" })}
        </div>
      </div>

      <div class="panel dash-block">
        <div class="panel-header"><div><p class="eyebrow">Ação imediata</p><h2>Alertas imediatos</h2><p>Só o que está em incumprimento hoje.</p></div></div>
        <div class="dash-alerts">${alertsHtml}</div>
      </div>

      <div class="panel dash-block">
        <div class="panel-header"><div><p class="eyebrow">Oficina</p><h2>Situação na oficina</h2><p>Distribuição das intervenções em curso.</p></div></div>
        <div class="dash-workshop">
          ${stateCard("Interna", ws.interna, "Em oficina interna", { filter: { "filter-key": "workshop", "filter-value": "Interna", "stage": "curso" } })}
          ${stateCard("Externa", ws.externa, "Em oficina externa", { filter: { "filter-key": "workshop", "filter-value": "Externa", "stage": "curso" } })}
          ${stateCard("Aguarda peças", ws.waitingParts, "A aguardar peças", { filter: { "filter-key": "situation", "filter-value": "Aguarda peças", "stage": "curso" } })}
          ${stateCard("Sem previsão de saída", ws.semPrevisao, "Em oficina sem data de saída", { filter: { "filter-key": "semprevisao", "filter-value": "1", "stage": "curso" } })}
        </div>
      </div>

      <div class="panel dash-block dash-block--wide">
        <div class="panel-header"><div><p class="eyebrow">Planeamento</p><h2>Próximos 30 dias</h2><p>Inspeções, tacógrafos, revisões, compressor e cubos numa timeline única.</p></div></div>
        <div class="deadline-list">${timelineHtml}</div>
      </div>
    </section>
  `;
}

function getDashboardState() {
  const active = state.breakdowns.filter((b) => b.status !== "Concluido");
  const totalFleet = state.fleet.filter((f) => f.status === "Ativa").length || state.fleet.length;
  // Paradas = viaturas distintas paradas (uma viatura pode ter várias ocorrências).
  const stopped = new Set(active.filter((b) => b.status === "Parado").map((b) => normalizePlate(b.plate) || String(b.equipment))).size;
  const inWorkshop = active.filter((b) => b.situation === "Em oficina").length;
  const waitingParts = active.filter((b) => b.situation === "Aguarda peças").length;
  const availability = totalFleet ? Math.round(((totalFleet - stopped) / totalFleet) * 100) : 0;
  return { totalFleet, stopped, inWorkshop, waitingParts, availability };
}

function getImmediateAlerts() {
  const active = state.breakdowns.filter((b) => b.status !== "Concluido");
  const stopped = new Set(active.filter((b) => b.status === "Parado").map((b) => normalizePlate(b.plate) || String(b.equipment))).size;
  const inspExpired = state.fleet.filter((f) => f.inspectionAt && !isFleetNA(f.inspectionAt) && daysUntil(f.inspectionAt) < 0).length;
  const tacoExpired = state.fleet.filter((f) => f.tachographAt && !isFleetNA(f.tachographAt) && daysUntil(f.tachographAt) < 0).length;
  const stale = active.filter((b) => {
    const ref = (b.lastNoteAt || b.reportedAt || "").slice(0, 10);
    return ref && daysBetween(ref, todayISO()) > 7;
  }).length;

  const list = [];
  if (stopped) list.push({ count: stopped, label: stopped === 1 ? "viatura parada" : "viaturas paradas", filter: { "filter-key": "status", "filter-value": "Parado", "status-value": "" } });
  if (inspExpired) list.push({ count: inspExpired, label: inspExpired === 1 ? "inspeção vencida" : "inspeções vencidas", fleetScope: "inspecao-vencida" });
  if (tacoExpired) list.push({ count: tacoExpired, label: tacoExpired === 1 ? "tacógrafo vencido" : "tacógrafos vencidos", fleetScope: "tacografo-vencido" });
  if (stale) list.push({ count: stale, label: "avarias sem atualização há mais de 7 dias", filter: { "filter-key": "stale", "filter-value": "1", "status-value": "" } });
  return list;
}

function getWorkshopBreakdown() {
  const active = state.breakdowns.filter((b) => b.status !== "Concluido");
  return {
    interna: active.filter((b) => normalizeText(b.workshopType) === "interna").length,
    externa: active.filter((b) => normalizeText(b.workshopType) === "externa").length,
    waitingParts: active.filter((b) => b.situation === "Aguarda peças").length,
    semPrevisao: active.filter((b) => b.situation === "Em oficina" && !b.expectedExitAt).length
  };
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

const MONTH_NAMES_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

function monthLabelPt(iso) {
  const [y, m] = String(iso || "").slice(0, 10).split("-");
  const idx = parseInt(m, 10) - 1;
  return `${MONTH_NAMES_PT[idx] || "Sem data"} ${y || ""}`.trim();
}

function isMonthExpanded(key) {
  return (state.expandedMonths || []).includes(key);
}

function toggleMonth(key) {
  const set = new Set(state.expandedMonths || []);
  if (set.has(key)) set.delete(key); else set.add(key);
  state.expandedMonths = [...set];
  saveState();
  render();
}

// Renderiza linhas de tabela agrupadas por mês, com cada mês colapsável.
// `items` já vem ordenado (a ordem determina a ordenação dentro do mês);
// os meses são apresentados do mais recente para o mais antigo.
function renderMonthGroups(listId, items, getDate, colspan, rowRenderer, nounSingular, nounPlural, emptyText) {
  if (!items.length) {
    return `<tr><td colspan="${colspan}"><p class="empty-state">${escapeHtml(emptyText || "Sem registos.")}</p></td></tr>`;
  }
  const keys = [...new Set(items.map((it) => String(getDate(it) || "").slice(0, 7)))].sort((a, b) => b.localeCompare(a));
  return keys.map((key) => {
    const groupItems = items.filter((it) => String(getDate(it) || "").slice(0, 7) === key);
    const fullKey = `${listId}:${key}`;
    const expanded = isMonthExpanded(fullKey);
    const n = groupItems.length;
    const noun = n === 1 ? (nounSingular || "registo") : (nounPlural || "registos");
    const header = `<tr class="month-row"><td colspan="${colspan}">
      <button type="button" class="month-toggle${expanded ? " open" : ""}" data-action="month-toggle" data-key="${escapeAttr(fullKey)}" aria-expanded="${expanded}">
        <span class="month-chevron" aria-hidden="true"></span>
        <span>${escapeHtml(monthLabelPt(key + "-01"))} · ${n} ${noun}</span>
      </button></td></tr>`;
    const body = expanded ? groupItems.map(rowRenderer).join("") : "";
    return header + body;
  }).join("");
}

function meetingConsultRow(m) {
  const ended = !!m.endedAt;
  const counts = meetingCounts(m);
  return `<tr>
    <td><strong>${formatDate((m.startedAt || "").slice(0, 10))}</strong></td>
    <td>${escapeHtml(formatTimeOnly(m.startedAt))}</td>
    <td>${ended ? `${m.durationMin} min` : "—"}</td>
    <td>${ended ? '<span class="badge concluido">Encerrada</span>' : '<span class="badge circula">A decorrer</span>'}</td>
    <td>${counts.novas} novas · ${counts.updates} atualizações · ${counts.tarefas} tarefas</td>
    <td>${escapeHtml(m.operator || "-")}</td>
    <td class="row-actions">
      <button class="icon-button" type="button" data-action="select-meeting" data-id="${escapeAttr(m.id)}" title="Ver relatório"><span data-icon="eye"></span></button>
      ${!ended ? `<button class="icon-button" type="button" data-action="close-meeting-row" data-id="${escapeAttr(m.id)}" title="Encerrar reunião"><span data-icon="check"></span></button>` : ""}
      <button class="icon-button danger" type="button" data-action="delete-meeting" data-id="${escapeAttr(m.id)}" title="Eliminar reunião (Administrador)"><span data-icon="trash"></span></button>
    </td>
  </tr>`;
}

function renderMeetingConsult() {
  const past = [...state.meetings].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  const rows = renderMonthGroups("meetings", past, (m) => m.startedAt, 7, meetingConsultRow, "reunião", "reuniões", "Ainda não há reuniões registadas.");

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
            ${rows}
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
  const evActions = (e) => `
      <span class="timeline-actions">
        <button class="dock-mini" type="button" data-action="meeting-event-edit" data-mid="${escapeAttr(m.id)}" data-id="${escapeAttr(e.id)}" title="Editar">✏️</button>
        <button class="dock-mini" type="button" data-action="meeting-event-delete" data-mid="${escapeAttr(m.id)}" data-id="${escapeAttr(e.id)}" title="Eliminar">🗑️</button>
      </span>`;
  const rowsHtml = (arr) => arr.length ? arr.map((e) => `
    <article class="timeline-item">
      <time>${formatTimeOnly(e.at)} · Equip. ${escapeHtml(String(e.equipment || "-"))} · ${escapeHtml(e.plate || "-")} · ${escapeHtml(meetingEventLabel(e.type))}</time>
      <p>${escapeHtml(e.summary || "-")}</p>
      ${evActions(e)}
    </article>`).join("") : '<p class="empty-state">Sem registos.</p>';
  const evVehicle = (e) => (e.plate || e.equipment)
    ? ` · <span class="timeline-veh">🚚 ${escapeHtml(e.plate || "")}${e.equipment ? ` · Equip. ${escapeHtml(String(e.equipment))}` : ""}</span>`
    : "";
  const noteRows = (arr) => arr.length ? arr.map((e) => `
    <article class="timeline-item">
      <time>${formatTimeOnly(e.at)}${e.type === "task" ? (e.done ? " · ✅ concluída" : " · ⬜ pendente") : ""}${evVehicle(e)}</time>
      <p>${escapeHtml(e.summary || "-")}</p>
      ${evActions(e)}
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

let openFilterMenu = null;

function filterArray(name) {
  const value = state.filters[name];
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function renderMultiFilter(name, label, values) {
  const selected = filterArray(name);
  const options = values.map((value) => {
    const checked = selected.includes(value) ? "checked" : "";
    return `<label class="filter-option"><input type="checkbox" data-filter-multi="${escapeAttr(name)}" value="${escapeAttr(value)}" ${checked}><span>${escapeHtml(value)}</span></label>`;
  }).join("");
  const badge = selected.length ? ` <span class="filter-count">${selected.length}</span>` : "";
  const clear = selected.length ? `<button type="button" class="filter-clear" data-filter-clear="${escapeAttr(name)}">Limpar</button>` : "";
  return `
    <details class="filter-menu" ${openFilterMenu === name ? "open" : ""}>
      <summary data-filter-summary="${escapeAttr(name)}">${escapeHtml(label)}${badge}</summary>
      <div class="filter-menu__panel">
        ${options}
        ${clear}
      </div>
    </details>`;
}

function renderFilters(context) {
  const searchPlaceholder = context === "meeting" ? "Pesquisar equipamento, matrícula, oficina ou nota" : "Pesquisar ocorrências";
  const sortButton = context === "breakdowns" ? `
      <button class="ghost-button" type="button" data-action="toggle-breakdown-sort" title="Inverter ordenação por data de avaria">
        <span data-icon="sort"></span>
        <span>${state.breakdownsSort === "asc" ? "Mais antigas primeiro" : "Mais recentes primeiro"}</span>
      </button>` : "";
  return `
    <div class="toolbar">
      ${searchFieldHtml("search", searchPlaceholder)}
      ${renderMultiFilter("status", "Estados", options.statuses)}
      ${renderMultiFilter("situation", "Situações", options.situations)}
      ${renderMultiFilter("respLog", "Resp. LOG.", respLogEntidades().map((e) => e.empresa || e.contactoNome).filter(Boolean))}
      ${renderMultiFilter("company", "Empresas", ["CPSA", "PTSA"])}
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

function openDetailModal(id) {
  const b = state.breakdowns.find((x) => String(x.id) === String(id));
  if (!b) return;
  openModal(`Ocorrência ${b.occurrenceNumber || ""}`.trim() || "Ocorrência", `<div data-detail-modal>${renderDetail(b)}</div>`, { size: "wide" });
}

function refreshDetailModal() {
  const holder = document.querySelector("#modal-root [data-detail-modal]");
  if (!holder) return;
  const b = state.breakdowns.find((x) => String(x.id) === String(state.selectedId));
  if (b) { holder.innerHTML = renderDetail(b); hydrateIcons(); }
}

async function handleFaultAction(action, button) {
  const b = state.breakdowns.find((x) => String(x.id) === String(button.dataset.id));
  if (!b) return;
  b.faults = normalizeFaults(b.faults);
  if (action === "fault-toggle") {
    const f = b.faults.find((x) => x.id === button.dataset.fault);
    if (f) f.resolvida = !f.resolvida;
  } else if (action === "fault-remove") {
    b.faults = b.faults.filter((x) => x.id !== button.dataset.fault);
  } else if (action === "fault-add") {
    const sel = document.getElementById("detail-fault-select-" + button.dataset.id);
    const f = faultFromSelect(sel);
    if (!f || !f.tipo) { showToast("Escolha um tipo de avaria."); return; }
    if (b.faults.some((x) => normalizeText(x.tipo) === normalizeText(f.tipo))) { showToast("Essa avaria já existe."); return; }
    b.faults.push({ id: `f${Date.now()}${b.faults.length}`, tipo: f.tipo, prioridade: f.prioridade, resolvida: false });
  }
  deriveBreakdownFromFaults(b);
  const p = faultProgress(b);
  const auditEvent = logAudit(b, "Avarias", p ? `Resolução ${p.pct}% (${p.resolved}/${p.total})` : "Avarias atualizadas");
  saveState();
  render();
  refreshDetailModal();
  await persistRemoteSafely(async () => {
    await persistBreakdownRemote(b);
    await persistAuditRemote(auditEvent);
  });
}

function renderDetail(breakdown) {
  if (!breakdown) {
    return '<p class="empty-state">Sem registo selecionado.</p>';
  }

  const timeline = parseHistory(breakdown.historyNotes);
  const vehBucket = vehicleBucketForPlate(breakdown.plate);
  const typeSet = new Set(String(breakdown.type || "").split(/[;,]/).map((s) => normalizeText(s.trim())).filter(Boolean));
  const faultsSorted = normalizeFaults(breakdown.faults).slice().sort((a, b) => (FAULT_PRIO_RANK[a.prioridade] || 9) - (FAULT_PRIO_RANK[b.prioridade] || 9));
  const oficinasList = entidadesByCategoria("Oficina");
  let oficinaOpts = oficinasList.map((o) => `<option value="${escapeAttr(o.empresa)}"${normalizeText(o.empresa) === normalizeText(breakdown.workshop || "") ? " selected" : ""}>${escapeHtml(o.empresa)}</option>`).join("");
  if (breakdown.workshop && !oficinasList.some((o) => normalizeText(o.empresa) === normalizeText(breakdown.workshop))) {
    oficinaOpts += `<option value="${escapeAttr(breakdown.workshop)}" selected>${escapeHtml(breakdown.workshop)} (atual)</option>`;
  }
  return `
    <div class="detail-head">
      <div>
        <p class="eyebrow">${escapeHtml(breakdown.occurrenceNumber || "Ocorrência")} · ${escapeHtml(breakdown.interventionType || "Corretiva")}</p>
        <h2>Equip. ${escapeHtml(breakdown.equipment || "-")}</h2>
      </div>
      <div class="detail-subtitle">
        <span>${escapeHtml(breakdown.plate || "-")}</span>
        ${priorityBadge(breakdown.priority)}
        ${statusBadge(breakdown.status)}
        ${progressBadge(breakdown)}
      </div>
    </div>

    <dl class="mini-grid">
      <div><dt>Abertura</dt><dd>${formatDate(breakdown.reportedAt)}</dd></div>
      <div><dt>Comunicação</dt><dd>${breakdown.communicatedAt ? formatDate(breakdown.communicatedAt) : "-"}</dd></div>
      <div><dt>No terreno</dt><dd>${breakdown.onSite ? "Sim" : "Não"}</dd></div>
      <div><dt>Prev. entrada</dt><dd>${breakdown.expectedEntryAt ? formatDate(breakdown.expectedEntryAt) : "-"}</dd></div>
      <div><dt>Prev. saída</dt><dd>${formatDate(breakdown.expectedExitAt)}</dd></div>
      <div><dt>Entrada oficina</dt><dd>${formatDate(breakdown.workshopEntryAt)}</dd></div>
      <div><dt>Saída oficina</dt><dd>${formatDate(breakdown.workshopExitAt)}</dd></div>
      <div><dt>Km</dt><dd>${breakdown.km ? escapeHtml(String(breakdown.km)) : "-"}</dd></div>
      <div><dt>Registado por</dt><dd>${escapeHtml(breakdown.registeredBy || "-")}</dd></div>
      <div><dt>Resp. logística</dt><dd>${escapeHtml(breakdown.logisticsResp || "-")}</dd></div>
      ${breakdown.recurrentOf ? `<div><dt>Reincidente de</dt><dd>${escapeHtml(breakdown.recurrentOf)}</dd></div>` : ""}
      <div><dt>Última nota</dt><dd>${escapeHtml(breakdown.lastNote || "-")}</dd></div>
    </dl>

    <div class="detail-faults">
      <div class="detail-faults__head"><h3>Avarias ${progressBadge(breakdown)}</h3></div>
      ${faultsSorted.length ? faultsSorted.map((f) => `
        <div class="fault-item${f.resolvida ? " done" : ""}">
          <button class="fault-check" type="button" data-action="fault-toggle" data-id="${escapeAttr(breakdown.id)}" data-fault="${escapeAttr(f.id)}" title="${f.resolvida ? "Marcar por resolver" : "Marcar resolvida"}">${f.resolvida ? "✅" : "⬜"}</button>
          ${priorityBadge(f.prioridade)}
          <span class="fault-item__t">${escapeHtml(f.tipo)}</span>
          <button class="g-x" type="button" data-action="fault-remove" data-id="${escapeAttr(breakdown.id)}" data-fault="${escapeAttr(f.id)}" title="Remover avaria">×</button>
        </div>`).join("") : '<p class="empty-state">Sem avarias registadas. Adicione abaixo.</p>'}
      <div class="detail-faults__add">
        <select id="detail-fault-select-${escapeAttr(breakdown.id)}">
          <option value="" disabled selected>Escolher tipo de avaria…</option>
          ${faultTypeOptionsHtml(vehBucket)}
        </select>
        <button class="btn-sec" type="button" data-action="fault-add" data-id="${escapeAttr(breakdown.id)}">＋ Avaria</button>
      </div>
    </div>

    ${breakdown.vistoriaId ? `
      <div class="link-banner">
        <span>🔗 Origem: <strong>vistoria de ${escapeHtml(formatDate(breakdown.vistoriaDate))}</strong>${breakdown.vistoriaItem ? ` — ponto <strong>${escapeHtml(breakdown.vistoriaItem)}</strong>` : ""}.</span>
        <button class="chip-link" type="button" data-action="select-vistoria" data-id="${escapeAttr(breakdown.vistoriaId)}">Ver vistoria</button>
      </div>` : ""}

    ${renderAttachments(breakdown)}

    <div class="admin-reassign">
      <p class="admin-reassign__title">🔒 Admin · Reafetar viatura</p>
      <p class="admin-reassign__hint">Move esta ocorrência para outra matrícula. O equipamento e o motorista passam a ser os da nova viatura; o conteúdo da ocorrência mantém-se.</p>
      <div class="admin-reassign__row">
        <select data-reassign-plate aria-label="Nova matrícula de destino">
          <option value="">Escolher matrícula de destino…</option>
          ${fleetPlateOptionsHtml("", "")}
        </select>
        <button class="ghost-button" type="button" data-action="reassign-vehicle" data-id="${escapeAttr(breakdown.id)}">Reafetar</button>
      </div>
    </div>

    <form class="quick-form" data-form="quick-update">
      <div class="form-grid">
        <label class="field">
          <span>Tipo de intervenção</span>
          <select name="interventionType">
            ${INTERVENTION_TYPES.map((t) => `<option value="${escapeAttr(t)}" ${(breakdown.interventionType || "Corretiva") === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Prioridade</span>
          <select name="priority">
            <option value="" ${!breakdown.priority ? "selected" : ""}>—</option>
            ${PRIORITIES.map(([p, label]) => `<option value="${escapeAttr(p)}" ${breakdown.priority === p ? "selected" : ""}>${escapeHtml(p)} · ${escapeHtml(label)}</option>`).join("")}
          </select>
        </label>
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
          <span>Prev. entrada</span>
          <input type="date" name="expectedEntryAt" value="${escapeAttr(breakdown.expectedEntryAt || "")}">
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
          <span>Saída oficina</span>
          <input type="date" name="workshopExitAt" value="${escapeAttr(breakdown.workshopExitAt || "")}">
        </label>
        <label class="field">
          <span>Oficina</span>
          <select name="workshop">
            <option value="">—</option>
            ${oficinaOpts}
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

function breakdownListRow(item) {
  return `<tr>
    <td class="occ-cell">
      <strong>${escapeHtml(item.occurrenceNumber || "—")}</strong>
      <span>${escapeHtml(item.interventionType || "Corretiva")}</span>
      ${priorityBadge(item.priority)}
      ${progressBadge(item)}
    </td>
    <td><strong>${escapeHtml(item.equipment || "-")}</strong></td>
    <td>${escapeHtml(item.plate || "-")}</td>
    <td>${escapeHtml(getBreakdownCompany(item) || "-")}</td>
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
  </tr>`;
}

function generateOccurrenceNumber(interventionType, dateISO) {
  const prefix = INTERVENTION_PREFIX[interventionType] || "CRT";
  const year = (dateISO || todayISO()).slice(0, 4);
  let max = 0;
  for (const b of state.breakdowns) {
    const m = String(b.occurrenceNumber || "").match(/^([A-Z]{3})-(\d{4})-(\d+)$/);
    if (m && m[1] === prefix && m[2] === year) {
      const n = parseInt(m[3], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}-${year}-${String(max + 1).padStart(4, "0")}`;
}

function priorityBadge(priority) {
  if (!priority) return "";
  const cls = String(priority).toLowerCase();
  return `<span class="prio-badge prio-badge--${escapeAttr(cls)}" title="Prioridade ${escapeAttr(priority)}">${escapeHtml(priority)}</span>`;
}

function matchesOccurrenceStage(item, stage) {
  if (!stage) return true;
  if (stage === "agendadas") return item.status === "Agendado";
  if (stage === "concluidas") return item.status === "Concluido";
  const active = item.status !== "Concluido" && item.status !== "Agendado";
  // Comunicada = reportada/à espera (ainda sem entrada na oficina). Em curso = já em oficina.
  if (stage === "comunicadas") return active && item.situation !== "Em oficina";
  if (stage === "curso") return active && item.situation === "Em oficina";
  return true;
}

function renderBreakdowns() {
  const stage = state.filters.occurrenceStage || "";
  const list = sortBreakdownsByDate(getFilteredBreakdowns(false), state.breakdownsSort)
    .filter((item) => matchesOccurrenceStage(item, stage));
  return `
    <section class="page-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Registos</p>
            <h2>Ocorrências</h2>
            <p>${list.length} registos encontrados</p>
          </div>
          <div class="panel-header__actions">
            <button class="primary-button" type="button" data-view="new"><span data-icon="plus"></span><span>Nova ocorrência</span></button>
          </div>
        </div>
        <div class="chip-filters occurrence-stages">
          ${OCCURRENCE_STAGES.map(([v, l]) => {
            const active = (state.filters.occurrenceStage || "") === v;
            return `<button type="button" class="chip-filter ${active ? "active" : ""}" data-action="occurrence-stage" data-stage="${escapeAttr(v)}">${escapeHtml(l)}</button>`;
          }).join("")}
        </div>
        ${renderFilters("breakdowns")}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ocorrência</th>
                <th>Equip.</th>
                <th>Matrícula</th>
                  <th>Empresa</th>
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
              ${renderMonthGroups("breakdowns", list, (item) => item.reportedAt, 12, breakdownListRow, "ocorrência", "ocorrências", "Sem ocorrências para estes filtros.")}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

// ── PLANEAMENTO (calendário de intervenções) ───────────────────────────────

const GANTT_MODES = [["day", "Dia"], ["week", "Semana"], ["month", "Mês"]];
const GANTT_WEEKDAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function ganttAnchorISO() { return state.ganttAnchor || todayISO(); }
function ganttKeyDate(b) { return String(b.expectedEntryAt || b.reportedAt || "").slice(0, 10); }
// Dias abrangidos por uma intervenção: da entrada prevista/abertura à saída prevista.
function ganttSpanDays(b) {
  const entry = ganttKeyDate(b);
  if (!entry) return [];
  let exit = String(b.expectedExitAt || "").slice(0, 10);
  if (!exit || exit < entry) exit = entry;
  const days = [];
  let cur = entry, i = 0;
  while (cur <= exit && i < 120) { days.push(cur); cur = isoAddDays(cur, 1); i++; }
  return days;
}
function ganttActiveByDate() {
  const map = {};
  state.breakdowns.forEach((b) => {
    if (b.status === "Concluido") return;
    ganttSpanDays(b).forEach((k) => { (map[k] = map[k] || []).push(b); });
  });
  return map;
}
function isoAddDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isoMondayOf(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const dow = (d.getDay() + 6) % 7;
  return isoAddDays(iso, -dow);
}
function ganttStatusClass(status) {
  const s = normalizeText(status);
  if (s.includes("agendado")) return "gs-agendado";
  if (s.includes("pode circular")) return "gs-circular";
  if (s === "parado") return "gs-parado";
  return "gs-outro";
}
function ganttChip(b) {
  return `<button class="gantt-chip ${ganttStatusClass(b.status)}" type="button" data-action="select-breakdown" data-id="${escapeAttr(b.id)}" title="${escapeAttr(`${b.occurrenceNumber || ""} · ${b.interventionType || ""} · ${b.status || ""} · ${b.description || ""}`)}">
    <strong>${escapeHtml(b.plate || b.equipment || "-")}</strong>
    <span>${escapeHtml(b.occurrenceNumber || b.interventionType || "")}</span>
    ${priorityBadge(b.priority)}
  </button>`;
}
function ganttShift(delta) {
  const mode = state.ganttMode || "week";
  const anchor = ganttAnchorISO();
  if (mode === "day") state.ganttAnchor = isoAddDays(anchor, delta);
  else if (mode === "week") state.ganttAnchor = isoAddDays(anchor, delta * 7);
  else {
    const [y, m] = anchor.split("-").map(Number);
    const nd = new Date(y, m - 1 + delta, 1);
    state.ganttAnchor = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-01`;
  }
}

function renderGantt() {
  const mode = GANTT_MODES.some(([m]) => m === state.ganttMode) ? state.ganttMode : "week";
  const anchor = ganttAnchorISO();
  const byDate = ganttActiveByDate();
  const today = todayISO();

  let title = "";
  if (mode === "day") title = formatDate(anchor);
  else if (mode === "week") {
    const mon = isoMondayOf(anchor);
    title = `${formatDate(mon)} – ${formatDate(isoAddDays(mon, 5))}`;
  } else {
    const [y, m] = anchor.split("-").map(Number);
    title = `${MONTH_NAMES_PT[m - 1]} ${y}`;
  }

  const modeTabs = GANTT_MODES.map(([m, l]) =>
    `<button type="button" class="chip-filter ${mode === m ? "active" : ""}" data-action="gantt-mode" data-mode="${m}">${escapeHtml(l)}</button>`).join("");

  let bodyHtml = "";
  if (mode === "day") {
    const list = (byDate[anchor] || []).slice().sort((a, b) => (a.plate || "").localeCompare(b.plate || "", "pt"));
    bodyHtml = `<div class="gantt-day">${list.length ? list.map(ganttChip).join("") : '<p class="empty-state">Sem intervenções agendadas neste dia.</p>'}</div>`;
  } else if (mode === "week") {
    const mon = isoMondayOf(anchor);
    const days = Array.from({ length: 6 }, (_, i) => isoAddDays(mon, i));
    bodyHtml = `<div class="gantt-week">${days.map((d, i) => {
      const list = byDate[d] || [];
      return `<div class="gantt-col ${d === today ? "is-today" : ""}">
        <div class="gantt-col__head">${GANTT_WEEKDAYS[i]} · ${d.slice(8, 10)}/${d.slice(5, 7)}</div>
        <div class="gantt-col__body">${list.length ? list.map(ganttChip).join("") : '<span class="gantt-empty">—</span>'}</div>
      </div>`;
    }).join("")}</div>`;
  } else {
    const [y, m] = anchor.split("-").map(Number);
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const lastISO = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    let cur = isoMondayOf(first);
    const rows = [];
    while (cur <= lastISO) {
      rows.push(Array.from({ length: 6 }, (_, i) => isoAddDays(cur, i)));
      cur = isoAddDays(cur, 7);
    }
    const monthPrefix = `${y}-${String(m).padStart(2, "0")}`;
    bodyHtml = `
      <div class="gantt-month">
        <div class="gantt-month__head">${GANTT_WEEKDAYS.map((w) => `<div>${w}</div>`).join("")}</div>
        ${rows.map((week) => `<div class="gantt-month__row">${week.map((d) => {
          const list = byDate[d] || [];
          const out = d.slice(0, 7) !== monthPrefix;
          return `<div class="gantt-cell ${out ? "is-out" : ""} ${d === today ? "is-today" : ""}">
            <button class="gantt-cell__day" type="button" data-action="gantt-goto-day" data-date="${d}">${d.slice(8, 10)}</button>
            ${list.slice(0, 3).map((b) => `<button class="gantt-mini ${ganttStatusClass(b.status)}" type="button" data-action="select-breakdown" data-id="${escapeAttr(b.id)}" title="${escapeAttr(`${b.plate || ""} · ${b.occurrenceNumber || ""}`)}">${escapeHtml(b.plate || b.equipment || "-")}</button>`).join("")}
            ${list.length > 3 ? `<span class="gantt-more">+${list.length - 3}</span>` : ""}
          </div>`;
        }).join("")}</div>`).join("")}
      </div>`;
  }

  const prevAll = getFleetDateAlerts()
    .filter((a) => Number.isFinite(a.days) && a.days >= 0 && a.days <= 90)
    .sort((a, b) => (a.plate || "").localeCompare(b.plate || "", "pt", { numeric: true }));
  const isPrevTrator = (item) => {
    const f = state.fleet.find((x) => String(x.equipment) === String(item.equipment));
    return f ? isTratorFleet(f) : false;
  };
  const prevTr = prevAll.filter(isPrevTrator);
  const prevRb = prevAll.filter((x) => !isPrevTrator(x));
  const prevRow = (item) => `
    <article class="deadline-row">
      <div><strong>${escapeHtml(item.plate || "-")} · Equip. ${escapeHtml(item.equipment)}</strong><span>${escapeHtml(item.label)} · ${escapeHtml(formatDate(item.date))}</span></div>
      ${renderDueBadge(item.date)}
    </article>`;
  const prevBlock = (title, list) => `<h3 class="deadline-subhead">${escapeHtml(title)} (${list.length})</h3>${list.length ? list.map(prevRow).join("") : '<p class="empty-state">Sem preventivas nos próximos 3 meses.</p>'}`;

  return `
    <section class="page-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Manutenção</p>
            <h2>Planeamento</h2>
            <p>Intervenções em curso e agendadas (por data de entrada prevista ou de abertura).</p>
          </div>
          <div class="gantt-controls">
            <div class="chip-filters">${modeTabs}</div>
            <div class="gantt-nav">
              <button class="ghost-button" type="button" data-action="gantt-prev" title="Anterior">‹</button>
              <button class="ghost-button" type="button" data-action="gantt-today">Hoje</button>
              <button class="ghost-button" type="button" data-action="gantt-next" title="Seguinte">›</button>
            </div>
          </div>
        </div>
        <div class="gantt-title">${escapeHtml(title)}</div>
        ${bodyHtml}
      </div>
      <div class="panel">
        <div class="panel-header"><div><p class="eyebrow">Frota</p><h2>Próximas preventivas</h2><p>Inspeções, tacógrafos, revisões e aferições nos próximos 3 meses.</p></div></div>
        <div class="deadline-list">
          ${prevBlock("Tratores", prevTr)}
          ${prevBlock("Reboques e outros", prevRb)}
        </div>
      </div>
    </section>`;
}

function renderNewBreakdown() {
  const today = todayISO();
  const link = state.avariaFromVistoria;
  const selectedDesc = link?.plate ? (findFleetByPlate(link.plate)?.description || "").trim() : "";
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
          <h2>Nova ocorrência${link ? " (origem: vistoria)" : ""}</h2>
          <p>O número é gerado automaticamente pelo tipo de intervenção (ex.: CRT-${todayISO().slice(0, 4)}-0001).</p>
        </div>
      </div>
      ${banner}
      <form class="data-form" data-form="new-breakdown">
        <div class="form-grid">
          <label class="field">
            <span>Tipo de intervenção</span>
            <select name="interventionType" required>
              ${INTERVENTION_TYPES.map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span>Prioridade</span>
            <select name="priority">
              <option value="">—</option>
              ${PRIORITIES.map(([p, label]) => `<option value="${escapeAttr(p)}">${escapeHtml(p)} · ${escapeHtml(label)}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span>Descrição</span>
            <select id="new-description-filter" name="descriptionFilter">
              <option value="">Todas as descrições</option>
              ${fleetDescriptions().map((desc) => `<option value="${escapeAttr(desc)}" ${desc === selectedDesc ? "selected" : ""}>${escapeHtml(desc)}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span>Matrícula</span>
            <select id="new-plate" name="plate" required>
              <option value="">Selecione a matrícula</option>
              ${fleetPlateOptionsHtml(selectedDesc, link?.plate)}
            </select>
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
            <span data-icon="check"></span>
            <span>Gravar ocorrência</span>
          </button>
        </div>
      </form>
    </section>
  `;
}

function occurrencesForPlate(plate) {
  const p = normalizePlate(plate || "");
  if (!p) return [];
  return state.breakdowns
    .filter((b) => normalizePlate(b.plate) === p)
    .map((b) => ({
      number: b.occurrenceNumber || String(b.id),
      label: `${b.occurrenceNumber || "s/nº"} · ${b.interventionType || ""} · ${formatDate(b.reportedAt)}${b.description ? ` · ${b.description.slice(0, 28)}` : ""}`
    }));
}

let _occFaults = []; // avarias em construção na Nova ocorrência (multi-avaria)
function openOccurrenceModal() {
  const today = todayISO();
  const link = state.avariaFromVistoria || null;
  const linkPlate = link?.plate || "";
  const descPrefill = link
    ? `[Vistoria ${formatDate(link.date)}] ${link.item}${link.state ? ` (${link.state})` : ""}${link.note ? ` — ${link.note}` : ""}`
    : "";
  const oficinaOptions = (tipo) => entidadesByCategoria("Oficina")
    .filter((o) => !tipo || normalizeText(o.tipo) === normalizeText(tipo))
    .map((o) => `<option value="${escapeAttr(o.empresa)}">${escapeHtml(o.empresa)}</option>`).join("");

  const body = `
    <form class="modal-form occ-form" data-form="new-breakdown">
      <div class="occ-section">
        <p class="occ-section__title">1 · Intervenção</p>
        <div class="field-row">
          <label class="field">Tipo de intervenção *
            <select name="interventionType" required>
              ${INTERVENTION_TYPES.map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("")}
            </select>
          </label>
          <label class="field">Prioridade
            <select name="priority"><option value="">—</option>${PRIORITIES.map(([p, l]) => `<option value="${escapeAttr(p)}">${escapeHtml(p)} · ${escapeHtml(l)}</option>`).join("")}</select>
          </label>
        </div>
        <label class="field field--check"><input type="checkbox" name="recurrent" id="occ-recurrent"> <span>Ocorrência reincidente?</span></label>
        <label class="field" id="occ-recurrent-wrap" hidden>Ocorrência anterior (mesma viatura)
          <select name="recurrentOf" id="occ-recurrent-of"><option value="">— selecione a matrícula primeiro —</option></select>
        </label>
      </div>

      <div class="occ-section">
        <p class="occ-section__title">2 · Viatura</p>
        <div class="field-row">
          <label class="field">Matrícula *
            <select name="plate" id="occ-plate" required>
              <option value="">Selecione a matrícula</option>
              ${fleetPlateOptionsHtml("", linkPlate)}
            </select>
          </label>
          <label class="field">Nº equipamento
            <input id="occ-equipment" name="equipment" readonly placeholder="(pela matrícula)">
          </label>
        </div>
        <div class="field-row">
          <label class="field">Tipo de viatura
            <input id="occ-vehicletype" readonly placeholder="(pela matrícula)">
          </label>
          <label class="field">Motorista
            <input id="occ-driver" name="driver" readonly placeholder="(pela matrícula)">
          </label>
        </div>
        <label class="field">Conjunto (trator/reboque)
          <input id="occ-conjunto" name="conjunto" readonly placeholder="(atribuído se a viatura tiver conjunto)">
        </label>
        <div id="occ-preventive-wrap" hidden>
          <label class="field field--check"><input type="checkbox" name="preventivePeriodic" id="occ-preventive"> <span>Preventiva periódica?</span></label>
          <div class="field-row" id="occ-preventive-detail" hidden>
            <label class="field">Intervenção a reagendar
              <select name="preventiveField" id="occ-preventive-field"></select>
            </label>
            <label class="field">Periodicidade
              <select name="preventiveMonths" id="occ-preventive-months"><option value="12">12 meses</option><option value="24">24 meses</option></select>
            </label>
          </div>
        </div>
      </div>

      <div class="occ-section">
        <p class="occ-section__title">3 · Comunicação e oficina</p>
        <div class="field-row">
          <label class="field">Data de abertura
            <input type="date" name="reportedAt" value="${today}" required>
          </label>
          <label class="field">Data de comunicação
            <input type="date" name="communicatedAt" value="${today}">
          </label>
        </div>
        <div class="field-row">
          <label class="field">Intervenção no terreno?
            <select name="onSite" id="occ-onsite"><option value="nao">Não</option><option value="sim">Sim</option></select>
          </label>
          <label class="field">Estado inicial *
            <select name="status" required>${options.statuses.filter((s) => s !== "Concluido").map((s) => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join("")}</select>
          </label>
        </div>
        <div id="occ-workshop-fields">
          <div class="field-row">
            <label class="field">Tipo de oficina
              <select name="workshopType" id="occ-workshoptype"><option value="">—</option><option value="Interna">Interna</option><option value="Externa">Externa</option></select>
            </label>
            <label class="field">Oficina (das Entidades)
              <select name="workshop" id="occ-workshop"><option value="">—</option>${oficinaOptions("")}</select>
            </label>
          </div>
          <div class="field-row">
            <label class="field">Previsão entrada oficina
              <input type="date" name="expectedEntryAt">
            </label>
            <label class="field">Previsão saída oficina
              <input type="date" name="expectedExitAt">
            </label>
          </div>
        </div>
      </div>

      <div class="occ-section">
        <p class="occ-section__title">4 · Classificação e detalhes</p>
        <label class="field field--wide">Avarias <span class="occ-hint">(escolhe o tipo e adiciona; podes juntar várias)</span></label>
        <div class="occ-fault-add">
          <select id="occ-fault-select"><option value="" disabled selected>Selecione a matrícula primeiro</option></select>
          <button type="button" class="btn-sec" id="occ-fault-add-btn">＋ Adicionar avaria</button>
        </div>
        <div id="occ-fault-list" class="occ-fault-list"></div>
        <label class="field field--wide">Descrição
          <textarea name="description" rows="3">${escapeHtml(descPrefill)}</textarea>
        </label>
        <div class="field-row">
          <label class="field">Km
            <input type="number" name="km" min="0" placeholder="Quilómetros">
          </label>
          <label class="field">Registado por
            <input name="registeredBy" value="${escapeAttr(remoteConfig.operator || "")}">
          </label>
        </div>
        <label class="field field--wide">Resp. logística
          <input name="logisticsResp" placeholder="Ex.: Ana Fialho">
        </label>
        <label class="field field--wide">Ficheiro / fotografia
          <input type="file" name="attachments" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" multiple>
        </label>
      </div>

      ${link ? `<p class="occ-linknote">🔗 Fica ligada à vistoria de ${escapeHtml(formatDate(link.date))} — ponto ${escapeHtml(link.item)}.</p>` : ""}

      <div class="modal-form__actions">
        <button type="button" class="ghost-button" data-action="close-modal">Cancelar</button>
        <button type="submit" class="primary-button"><span data-icon="check"></span><span>Gravar ocorrência</span></button>
      </div>
    </form>`;

  openModal(link ? "Nova ocorrência (origem: vistoria)" : "Nova ocorrência", body, { size: "wide" });
  wireOccurrenceModal();
}

function renderOccFaultsList(faults) {
  if (!faults || !faults.length) return `<p class="occ-fault-empty">Sem avarias adicionadas ainda.</p>`;
  const sorted = faults.slice().sort((a, b) => (FAULT_PRIO_RANK[a.prioridade] || 9) - (FAULT_PRIO_RANK[b.prioridade] || 9));
  return sorted.map((f) => `
    <div class="occ-fault-chip">
      ${priorityBadge(f.prioridade)}
      <span class="occ-fault-chip__t">${escapeHtml(f.tipo)}</span>
      <button type="button" class="g-x" data-occ-fault-remove="${escapeAttr(f.id)}" title="Remover">×</button>
    </div>`).join("");
}

function wireOccurrenceModal() {
  const root = document.querySelector("#modal-root");
  if (!root) return;
  const plate = root.querySelector("#occ-plate");
  const equip = root.querySelector("#occ-equipment");
  const driver = root.querySelector("#occ-driver");
  const vtype = root.querySelector("#occ-vehicletype");
  const recurrentChk = root.querySelector("#occ-recurrent");
  const recurrentWrap = root.querySelector("#occ-recurrent-wrap");
  const recurrentOf = root.querySelector("#occ-recurrent-of");
  const onsite = root.querySelector("#occ-onsite");
  const workshopFields = root.querySelector("#occ-workshop-fields");
  const workshopType = root.querySelector("#occ-workshoptype");
  const workshopSel = root.querySelector("#occ-workshop");
  const faultSelect = root.querySelector("#occ-fault-select");
  const faultAddBtn = root.querySelector("#occ-fault-add-btn");
  const faultList = root.querySelector("#occ-fault-list");
  const priorityField = root.querySelector('select[name="priority"]');
  const interventionSel = root.querySelector('[name="interventionType"]');
  const prevWrap = root.querySelector("#occ-preventive-wrap");
  const prevChk = root.querySelector("#occ-preventive");
  const prevDetail = root.querySelector("#occ-preventive-detail");
  const prevField = root.querySelector("#occ-preventive-field");
  const prevMonths = root.querySelector("#occ-preventive-months");
  _occFaults = [];

  const populatePreventiveFields = () => {
    if (!prevField) return;
    prevField.innerHTML = preventiveFieldsForPlate(plate ? plate.value : "")
      .map((p) => `<option value="${escapeAttr(p.field)}">${escapeHtml(p.label)}</option>`).join("");
    if (prevMonths && prevField.value) prevMonths.value = String(preventiveMonthsFor(prevField.value));
  };
  const togglePreventiveDetail = () => {
    if (!prevDetail) return;
    prevDetail.hidden = !(prevChk && prevChk.checked);
    if (prevChk && prevChk.checked) populatePreventiveFields();
  };
  const togglePreventiveWrap = () => {
    if (!prevWrap) return;
    const isPrev = interventionSel && normalizeText(interventionSel.value) === "preventiva";
    prevWrap.hidden = !isPrev;
    if (!isPrev && prevChk) { prevChk.checked = false; togglePreventiveDetail(); }
  };

  const populateRecurrent = () => {
    if (!recurrentOf) return;
    const list = occurrencesForPlate(plate.value);
    recurrentOf.innerHTML = `<option value="">—</option>` + list.map((o) => `<option value="${escapeAttr(o.number)}">${escapeHtml(o.label)}</option>`).join("");
  };
  const populateTypes = () => {
    if (!faultSelect) return;
    faultSelect.innerHTML = plate.value
      ? `<option value="" disabled selected>Escolher tipo de avaria…</option>` + faultTypeOptionsHtml(vehicleBucketForPlate(plate.value))
      : `<option value="" disabled selected>Selecione a matrícula primeiro</option>`;
  };
  const renderFaultList = () => {
    if (faultList) faultList.innerHTML = renderOccFaultsList(_occFaults);
    if (priorityField) {
      let best = "";
      _occFaults.forEach((f) => { if (f.prioridade && (!best || FAULT_PRIO_RANK[f.prioridade] < FAULT_PRIO_RANK[best])) best = f.prioridade; });
      if (best) priorityField.value = best;
    }
  };
  const addFault = () => {
    const f = faultFromSelect(faultSelect);
    if (!f || !f.tipo) { showToast("Escolha um tipo de avaria."); return; }
    if (_occFaults.some((x) => normalizeText(x.tipo) === normalizeText(f.tipo))) { showToast("Essa avaria já foi adicionada."); return; }
    _occFaults.push({ id: `f${Date.now()}${_occFaults.length}`, tipo: f.tipo, prioridade: f.prioridade, resolvida: false });
    renderFaultList();
    if (faultSelect) faultSelect.value = "";
  };
  const fillFromPlate = () => {
    const f = findFleetByPlate(plate.value);
    if (equip) equip.value = f?.equipment || "";
    if (driver) driver.value = f?.driver || "";
    if (vtype) vtype.value = f?.description || "";
    const conj = root.querySelector("#occ-conjunto");
    if (conj) {
      const pEq = f?.partnerEquipment;
      const p = pEq ? state.fleet.find((x) => String(x.equipment) === String(pEq)) : null;
      conj.value = p ? `${p.plate || "—"} · Equip. ${p.equipment || "-"}${p.description ? ` · ${p.description}` : ""}` : "";
    }
    populateRecurrent();
    populateTypes();
    if (prevChk && prevChk.checked) populatePreventiveFields();
  };
  const toggleRecurrent = () => {
    if (recurrentWrap) recurrentWrap.hidden = !recurrentChk.checked;
    if (recurrentChk.checked) populateRecurrent();
  };
  const toggleOnSite = () => {
    if (workshopFields) workshopFields.style.display = onsite.value === "sim" ? "none" : "";
  };
  const filterOficinas = () => {
    const cur = workshopSel.value;
    const oficinas = entidadesByCategoria("Oficina").filter((o) => !workshopType.value || normalizeText(o.tipo) === normalizeText(workshopType.value));
    workshopSel.innerHTML = `<option value="">—</option>` + oficinas.map((o) => `<option value="${escapeAttr(o.empresa)}"${o.empresa === cur ? " selected" : ""}>${escapeHtml(o.empresa)}</option>`).join("");
  };

  if (plate) plate.addEventListener("change", fillFromPlate);
  if (recurrentChk) recurrentChk.addEventListener("change", toggleRecurrent);
  if (onsite) onsite.addEventListener("change", toggleOnSite);
  if (workshopType) workshopType.addEventListener("change", filterOficinas);
  if (faultAddBtn) faultAddBtn.addEventListener("click", addFault);
  if (faultList) faultList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-occ-fault-remove]");
    if (!btn) return;
    _occFaults = _occFaults.filter((f) => f.id !== btn.getAttribute("data-occ-fault-remove"));
    renderFaultList();
  });
  if (interventionSel) interventionSel.addEventListener("change", togglePreventiveWrap);
  if (prevChk) prevChk.addEventListener("change", togglePreventiveDetail);
  if (prevField) prevField.addEventListener("change", () => { if (prevMonths) prevMonths.value = String(preventiveMonthsFor(prevField.value)); });
  togglePreventiveWrap();
  if (plate && plate.value) fillFromPlate();
  renderFaultList();
}

function fleetDescriptions() {
  return [...new Set(
    state.fleet
      .filter((item) => item.plate)
      .map((item) => (item.description || "").trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, "pt"));
}

function fleetPlateOptionsHtml(descFilter, selectedPlate) {
  const filter = (descFilter || "").trim();
  const selected = normalizePlate(selectedPlate || "");
  return state.fleet
    .filter((item) => item.plate && (!filter || (item.description || "").trim() === filter))
    .map((item) => {
      const isSel = selected && normalizePlate(item.plate) === selected ? "selected" : "";
      const label = `${item.plate} · Equip. ${item.equipment || "-"}${item.description ? ` · ${item.description}` : ""}`;
      return `<option value="${escapeAttr(item.plate)}" ${isSel}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function repopulatePlateOptions(descFilter) {
  const plate = document.querySelector("#new-plate");
  const equipment = document.querySelector("#new-equipment");
  if (!plate) return;
  plate.innerHTML = `<option value="">Selecione a matrícula</option>` + fleetPlateOptionsHtml(descFilter, "");
  plate.value = "";
  if (equipment) equipment.value = "";
}

function fleetScopeLabel(scope) {
  return scope === "ativas" ? "apenas viaturas ativas"
    : scope === "inspecao-vencida" ? "inspeções vencidas"
    : scope === "tacografo-vencido" ? "tacógrafos vencidos"
    : scope;
}

function renderFleet() {
  const activeCounts = state.breakdowns.reduce((acc, item) => {
    if (item.status !== "Concluido") acc[item.equipment] = (acc[item.equipment] || 0) + 1;
    return acc;
  }, {});
  const inactiveView = state.currentView === "fleet-inativas";
  const list = getFilteredFleet().filter((item) => inactiveView ? isFleetInactive(item) : !isFleetInactive(item));
  const fleetView = state.fleetView === "table" ? "table" : "cards";
  const inactiveTotal = state.fleet.filter(isFleetInactive).length;

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Frota${inactiveView ? " · arquivo" : ""}</p>
          <h2>${inactiveView ? "Viaturas inativas" : "Viaturas ativas"}</h2>
          <p>${list.length} ${list.length === 1 ? "viatura" : "viaturas"}${inactiveView ? "" : ` · ${inactiveTotal} inativa${inactiveTotal === 1 ? "" : "s"} no arquivo`}</p>
        </div>
        <div class="panel-header__actions">
          ${inactiveView ? "" : (typeof trelloSettings !== "undefined" && trelloSettings.key) ? `<button class="ghost-button" type="button" data-action="import-drivers-trello" title="Importar o motorista de cada viatura a partir do cartão &quot;motorista associado&quot; no Trello"><span data-icon="rotate"></span><span>Importar motoristas (Trello)</span></button>` : ""}
          ${inactiveView ? "" : `<button class="primary-button" type="button" data-action="new-fleet-modal"><span data-icon="plus"></span><span>Adicionar viatura</span></button>`}
        </div>
      </div>
      ${inactiveView ? `<p class="fleet-scope-note">Viaturas marcadas como <strong>Inativa</strong> — mantidas para consulta de histórico, fora do painel de ativas. Muda o Estado para <strong>Ativa</strong> (modo admin) para as trazer de volta.</p>` : ""}
      <div class="toolbar fleet-toolbar">
        ${searchFieldHtml("fleetSearch", "Pesquisar equipamento, matrícula ou marca")}
        <div class="fleet-viewtoggle" role="group" aria-label="Modo de visualização">
          <button type="button" class="${fleetView === "cards" ? "active" : ""}" data-action="fleet-view" data-mode="cards">Cartões</button>
          <button type="button" class="${fleetView === "table" ? "active" : ""}" data-action="fleet-view" data-mode="table">Tabela</button>
        </div>
      </div>
      ${state.filters.fleetScope ? `<div class="fleet-scope-note">A filtrar: <strong>${escapeHtml(fleetScopeLabel(state.filters.fleetScope))}</strong> <button type="button" class="link-button" data-action="fleet-scope-clear">✕ limpar</button></div>` : ""}
      <datalist id="fleet-resploglist">${respLogSuggestions().map((n) => `<option value="${escapeAttr(n)}"></option>`).join("")}</datalist>
      ${fleetView === "table" ? renderFleetTable(list, activeCounts) : renderFleetCards(list, activeCounts)}
    </section>
  `;
}

function renderFleetTable(list, activeCounts) {
  return `
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
              <th>Respons.</th>
              <th>Oficina preferencial</th>
              <th>Avarias abertas</th>
              <th>Inspeção</th>
              <th>Aferição tacógrafo</th>
              <th>Revisão compressor</th>
              <th>Cubos de roda</th>
              <th>Revisão</th>
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
                <td>${renderFleetStatusColumn(item)}</td>
                <td>${renderFleetCompanyCell(item)}</td>
                <td>${renderFleetDriverCell(item)}</td>
                <td>${renderFleetLogisticsCell(item)}</td>
                <td>${renderFleetOficinaCell(item)}</td>
                <td>${activeCounts[item.equipment] || 0}</td>
                <td>${renderFleetDateCell(item, "inspectionAt", "Data de inspeção")}</td>
                <td>${renderFleetDateCell(item, "tachographAt", "Data de aferição tacógrafo")}</td>
                <td>${renderFleetDateCell(item, "compressorReviewAt", "Data de revisão compressor")}</td>
                <td>${renderFleetDateCell(item, "wheelHubReviewAt", "Data de revisão cubos de roda")}</td>
                <td>${isTratorFleet(item) ? renderFleetDateCell(item, "revisionAt", "Data de revisão") : '<span class="not-applicable" title="Só aplicável a tratores">—</span>'}</td>
                <td>
                  <button class="icon-button" type="button" data-action="delete-fleet" data-equipment="${escapeAttr(item.equipment)}" title="Remover viatura">
                    <span data-icon="trash"></span>
                  </button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>`;
}

function renderFleetCards(list, activeCounts) {
  if (!list.length) return '<p class="empty-state">Sem viaturas para esta pesquisa.</p>';
  return `<div class="fleet-grid">${list.map((item) => fleetCard(item, activeCounts[item.equipment] || 0)).join("")}</div>`;
}

function computeFleetHealth(item) {
  const eq = String(item.equipment);
  const plateN = normalizePlate(item.plate || "");
  const open = state.breakdowns.filter((b) => b.status !== "Concluido" && (String(b.equipment) === eq || (plateN && normalizePlate(b.plate) === plateN)));
  const recurrentCount = open.filter((b) => b.recurrentOf).length;
  const dateHealth = (v) => {
    if (!v || isFleetNA(v)) return { tone: "gray", word: "s/ data", penalty: 0 };
    const d = daysUntil(v);
    if (!Number.isFinite(d)) return { tone: "gray", word: "s/ data", penalty: 0 };
    if (d < 0) return { tone: "red", word: "vencida", penalty: 15 };
    if (d <= 30) return { tone: "yellow", word: "próxima", penalty: 6 };
    return { tone: "green", word: "válida", penalty: 0 };
  };
  let score = 100;
  open.forEach((b) => { score -= b.priority === "P1" ? 30 : b.priority === "P2" ? 18 : b.priority === "P3" ? 8 : b.priority === "P4" ? 4 : 12; });
  const dateFields = ["inspectionAt", "tachographAt", "compressorReviewAt", "wheelHubReviewAt"];
  if (isTratorFleet(item)) dateFields.push("revisionAt");
  dateFields.forEach((f) => {
    const p = dateHealth(item[f]).penalty;
    // Inspeção e tacógrafo são legais/bloqueantes — pesam mais.
    score -= (f === "inspectionAt" || f === "tachographAt") ? Math.round(p * 1.8) : p;
  });
  score -= recurrentCount * 6;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const insp = dateHealth(item.inspectionAt);
  const taco = dateHealth(item.tachographAt);
  const factors = [
    { label: open.length ? `${open.length} avaria${open.length > 1 ? "s" : ""} aberta${open.length > 1 ? "s" : ""}` : "Sem avarias abertas", tone: open.length ? "red" : "green" },
    { label: `Inspeção ${insp.word}`, tone: insp.tone },
    { label: `Tacógrafo ${taco.word}`, tone: taco.tone },
    { label: recurrentCount ? `${recurrentCount} reincidência${recurrentCount > 1 ? "s" : ""}` : "Sem reincidências", tone: recurrentCount ? "yellow" : "green" }
  ];
  // Um fator crítico (vermelho) impede o verde, mesmo com pontuação alta.
  const hasRed = factors.some((f) => f.tone === "red");
  const tone = hasRed ? (score >= 60 ? "amber" : "red") : (score >= 80 ? "green" : score >= 60 ? "amber" : "red");
  return { score, tone, factors };
}

function fleetCard(item, openCount) {
  const dateFields = [
    ["inspectionAt", "Inspeção"],
    ["tachographAt", "Tacógrafo"],
    ["compressorReviewAt", "Compressor"],
    ["wheelHubReviewAt", "Cubos"]
  ];
  if (isTratorFleet(item)) dateFields.push(["revisionAt", "Revisão"]);
  const badges = dateFields.map(([f, l]) => fleetCardDateBadge(item, f, l)).filter(Boolean).join("");
  const statusCls = normalizeText(item.status) === "ativa" ? "ativa" : "outro";
  const metaBits = [];
  if (item.description) metaBits.push(escapeHtml(item.description));
  const marca = item.brand || item.model;
  if (marca) metaBits.push(escapeHtml(marca) + (item.year ? ` ${escapeHtml(String(item.year))}` : ""));
  const openTag = openCount ? `<span class="fleet-open">${openCount} avaria${openCount > 1 ? "s" : ""} aberta${openCount > 1 ? "s" : ""}</span>` : "";
  const metaLine = [metaBits.join(" · "), openTag].filter(Boolean).join(" · ");
  const partner = item.partnerEquipment ? state.fleet.find((f) => String(f.equipment) === String(item.partnerEquipment)) : null;
  const conjuntoLine = item.partnerEquipment
    ? `<p class="fleet-card__conjunto">🔗 Conjunto com <strong>${escapeHtml(partner ? (partner.plate || "—") : ("Equip. " + item.partnerEquipment))}</strong>${partner ? ` · Equip. ${escapeHtml(partner.equipment || "-")}${partner.description ? ` · ${escapeHtml(partner.description)}` : ""}` : ""}</p>`
    : "";
  const health = computeFleetHealth(item);
  const healthDot = (t) => t === "red" ? "🔴" : t === "yellow" ? "🟡" : t === "green" ? "🟢" : "⚪";
  const healthHtml = `
    <div class="fleet-health fleet-health--${health.tone}">
      <div class="fleet-health__score"><strong>${health.score}%</strong><span>Saúde</span></div>
      <ul class="fleet-health__factors">${health.factors.map((f) => `<li>${healthDot(f.tone)} ${escapeHtml(f.label)}</li>`).join("")}</ul>
    </div>`;
  return `
    <article class="fleet-card">
      <header class="fleet-card__head">
        <div class="fleet-card__id">
          <strong>${escapeHtml(item.plate || "—")}</strong>
          <span>Equip. ${escapeHtml(item.equipment || "-")}</span>
        </div>
        <div class="fleet-card__head-right">
          ${item.fleetCompany ? `<span class="fleet-company-tag">${escapeHtml(item.fleetCompany)}</span>` : ""}
          <span class="fleet-status fleet-status--${statusCls}">${escapeHtml(item.status || "-")}</span>
        </div>
      </header>
      ${metaLine ? `<p class="fleet-card__meta">${metaLine}</p>` : ""}
      ${healthHtml}
      ${badges ? `<div class="fleet-card__badges">${badges}</div>` : ""}
      ${conjuntoLine}
      <div class="fleet-card__controls">
        <label class="fleet-mini"><span>Motorista</span>${renderFleetDriverCell(item)}</label>
        <label class="fleet-mini"><span>Oficina preferencial</span>${renderFleetOficinaCell(item)}</label>
        <label class="fleet-mini"><span>Resp. logística${item.partnerEquipment ? ` <button type="button" class="link-button" data-action="fleet-logisticsresp-conjunto" data-equipment="${escapeAttr(item.equipment)}" title="Aplicar o mesmo responsável ao outro veículo do conjunto">↔ conjunto</button>` : ""}</span>${renderFleetLogisticsCell(item)}</label>
        <label class="fleet-mini"><span>Conjunto (trator/reboque)</span>${renderFleetPartnerCell(item)}</label>
        <label class="fleet-mini admin-only"><span>Estado (admin)</span>${renderFleetStatusCell(item)}</label>
      </div>
      <footer class="fleet-card__foot">
        <button class="icon-button" type="button" data-action="delete-fleet" data-equipment="${escapeAttr(item.equipment)}" title="Remover viatura"><span data-icon="trash"></span></button>
      </footer>
    </article>`;
}

function fleetCardDateBadge(item, field, label) {
  const value = item[field];
  if (isFleetNA(value)) return `<span class="fleet-badge fleet-badge--empty">${escapeHtml(label)}: N/A</span>`;
  if (!value) return "";
  const due = getDueState(value);
  const dot = due.className === "red" ? "🔴" : due.className === "yellow" ? "🟡" : due.className === "green" ? "🟢" : "⚪";
  return `<span class="fleet-badge fleet-badge--${due.className}" title="${escapeAttr(label)} — ${escapeAttr(formatDate(value))}">${dot} ${escapeHtml(label)} · ${escapeHtml(due.label)}</span>`;
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

// Categoria "Trator" (pela descrição padronizada da frota).
function isTratorFleet(item) {
  return normalizeText(item.description || "").trim() === "trator";
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
  const current = (item.driver || "").trim();
  const motoristas = entidadesByCategoria("Motorista");
  const parts = [`<option value="">—</option>`];
  let matched = false;
  for (const m of motoristas) {
    const sel = normalizeText(m.empresa) === normalizeText(current);
    if (sel) matched = true;
    parts.push(`<option value="${escapeAttr(m.empresa)}"${sel ? " selected" : ""}>${escapeHtml(m.empresa)}</option>`);
  }
  // Valor atual sem correspondência a nenhuma entidade Motorista: preserva-o até ser reclassificado.
  if (current && !matched) {
    parts.push(`<option value="${escapeAttr(current)}" selected>${escapeHtml(current)} (atual)</option>`);
  }
  return `
    <select
      class="fleet-driver-input"
      data-equipment="${escapeAttr(item.equipment)}"
      data-fleet-driver="true"
      aria-label="Motorista equip. ${escapeAttr(item.equipment)}"
    >${parts.join("")}</select>
  `;
}

function renderFleetOficinaCell(item) {
  const current = (item.preferredWorkshop || "").trim();
  const oficinas = entidadesByCategoria("Oficina");
  const parts = [`<option value="">—</option>`];
  let matched = false;
  for (const o of oficinas) {
    const sel = normalizeText(o.empresa) === normalizeText(current);
    if (sel) matched = true;
    parts.push(`<option value="${escapeAttr(o.empresa)}"${sel ? " selected" : ""}>${escapeHtml(o.empresa)}</option>`);
  }
  // Valor atual que não corresponde a nenhuma entidade da categoria Oficina: preserva-o.
  if (current && !matched) {
    parts.push(`<option value="${escapeAttr(current)}" selected>${escapeHtml(current)} (atual)</option>`);
  }
  return `
    <select
      class="fleet-workshop-select"
      data-equipment="${escapeAttr(item.equipment)}"
      data-fleet-workshop="true"
      aria-label="Oficina preferencial equip. ${escapeAttr(item.equipment)}"
    >${parts.join("")}</select>
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
  render();
  await persistRemoteSafely(async () => {
    await persistFleetRemote(item);
    await persistAuditRemote(auditEvent);
  });
}

async function updateFleetWorkshop(equipment, value) {
  const item = state.fleet.find((fleetItem) => String(fleetItem.equipment) === String(equipment));
  if (!item) return;
  const next = String(value || "").trim();
  const previous = item.preferredWorkshop || "";
  if (next === previous) return;
  item.preferredWorkshop = next;
  const auditEvent = logFleetAudit(item, "preferredWorkshop", previous, next);
  saveState();
  showToast("Oficina preferencial guardada.");
  render();
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


// ── Conjunto (trator+reboque) e Resp. logística por viatura ─────────────────

// Entidades da categoria "Resp. Logística" — fonte do dropdown da Frota e do agrupamento do email.
function respLogEntidades() {
  return entidadesByCategoria("Resp. Logística");
}
function respLogEntidadeByName(name) {
  const n = normalizeText(name || "");
  if (!n) return null;
  return (state.entidades || []).find((e) =>
    normalizeText(e.categoria) === normalizeText("Resp. Logística") && normalizeText(e.empresa) === n
  ) || null;
}

function renderFleetLogisticsCell(item) {
  const resps = respLogEntidades();
  const cur = item.logisticsResp || "";
  const opts = ['<option value="">—</option>'];
  resps.forEach((e) => {
    const name = e.empresa || e.contactoNome || "";
    if (!name) return;
    opts.push(`<option value="${escapeAttr(name)}"${name === cur ? " selected" : ""}>${escapeHtml(name)}</option>`);
  });
  // Preserva valor antigo (texto livre) que não corresponda a nenhuma entidade da categoria.
  if (cur && !resps.some((e) => (e.empresa || e.contactoNome) === cur)) {
    opts.push(`<option value="${escapeAttr(cur)}" selected>${escapeHtml(cur)} (livre)</option>`);
  }
  return `
    <select
      data-equipment="${escapeAttr(item.equipment)}"
      data-fleet-logisticsresp="true"
      aria-label="Resp. logística equip. ${escapeAttr(item.equipment)}"
    >${opts.join("")}</select>`;
}

function renderFleetPartnerCell(item) {
  const cur = String(item.partnerEquipment || "");
  const others = state.fleet
    .filter((f) => String(f.equipment) !== String(item.equipment))
    .sort((a, b) => (a.plate || "").localeCompare(b.plate || "", "pt"));
  const opts = ['<option value="">— sem conjunto —</option>'].concat(
    others.map((f) => {
      const sel = String(f.equipment) === cur ? " selected" : "";
      const label = `${f.plate || "—"} · Equip. ${f.equipment || "-"}${f.description ? ` · ${f.description}` : ""}`;
      return `<option value="${escapeAttr(f.equipment)}"${sel}>${escapeHtml(label)}</option>`;
    })
  );
  if (cur && !others.some((f) => String(f.equipment) === cur)) {
    opts.push(`<option value="${escapeAttr(cur)}" selected>Equip. ${escapeHtml(cur)} (atual)</option>`);
  }
  return `
    <select
      data-equipment="${escapeAttr(item.equipment)}"
      data-fleet-partner="true"
      aria-label="Conjunto equip. ${escapeAttr(item.equipment)}"
    >${opts.join("")}</select>`;
}

function respLogSuggestions() {
  const set = new Set();
  (state.fleet || []).forEach((f) => { if (f.logisticsResp) set.add(String(f.logisticsResp).trim()); });
  (state.entidades || []).forEach((e) => { if (e.contactoNome) set.add(String(e.contactoNome).trim()); });
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, "pt"));
}

async function updateFleetPartner(equipment, partnerEquipment) {
  const item = state.fleet.find((f) => String(f.equipment) === String(equipment));
  if (!item) return;
  const newPartner = String(partnerEquipment || "").trim();
  const oldPartner = String(item.partnerEquipment || "").trim();
  if (newPartner === oldPartner) return;
  const changed = new Map();
  const byEq = (eq) => state.fleet.find((f) => String(f.equipment) === String(eq));
  const mark = (f) => { if (f) changed.set(String(f.equipment), f); };
  // Desfaz o back-link do par antigo.
  if (oldPartner) {
    const op = byEq(oldPartner);
    if (op && String(op.partnerEquipment) === String(equipment)) { op.partnerEquipment = ""; mark(op); }
  }
  if (newPartner) {
    const np = byEq(newPartner);
    if (np) {
      // Se o novo par já pertencia a outro conjunto, desfaz esse primeiro.
      const npOld = String(np.partnerEquipment || "").trim();
      if (npOld && npOld !== String(equipment)) {
        const npOldItem = byEq(npOld);
        if (npOldItem) { npOldItem.partnerEquipment = ""; mark(npOldItem); }
      }
      np.partnerEquipment = String(equipment); mark(np);
    }
  }
  item.partnerEquipment = newPartner; mark(item);
  const auditEvent = logFleetAudit(item, "partnerEquipment", oldPartner || "—", newPartner || "—");
  saveState();
  showToast(newPartner ? "Conjunto associado." : "Conjunto removido.");
  render();
  await persistRemoteSafely(async () => {
    for (const f of changed.values()) await persistFleetRemote(f);
    await persistAuditRemote(auditEvent);
  });
}

async function updateFleetLogisticsResp(equipment, value) {
  const item = state.fleet.find((f) => String(f.equipment) === String(equipment));
  if (!item) return;
  const next = String(value || "").trim();
  const previous = item.logisticsResp || "";
  if (next === previous) return;
  item.logisticsResp = next;
  const auditEvent = logFleetAudit(item, "logisticsResp", previous, next);
  saveState();
  showToast("Resp. logística guardado.");
  await persistRemoteSafely(async () => {
    await persistFleetRemote(item);
    await persistAuditRemote(auditEvent);
  });
}

async function applyLogisticsRespToConjunto(equipment) {
  const item = state.fleet.find((f) => String(f.equipment) === String(equipment));
  if (!item || !item.partnerEquipment) return;
  const partner = state.fleet.find((f) => String(f.equipment) === String(item.partnerEquipment));
  if (!partner) { showToast("O outro veículo do conjunto não foi encontrado."); return; }
  const value = item.logisticsResp || "";
  if ((partner.logisticsResp || "") === value) { showToast("O conjunto já tem o mesmo responsável."); return; }
  const previous = partner.logisticsResp || "";
  partner.logisticsResp = value;
  const auditEvent = logFleetAudit(partner, "logisticsResp", previous, value);
  saveState();
  showToast("Resp. logística aplicado ao conjunto.");
  render();
  await persistRemoteSafely(async () => {
    await persistFleetRemote(partner);
    await persistAuditRemote(auditEvent);
  });
}

function fleetStatusList() {
  return ["Ativa", "Inativa"];
}
// Inativa = qualquer estado que não seja "Ativa" (inclui valores antigos: Vendida, Abatida, Cedida, etc.).
function isFleetInactive(item) {
  return normalizeText(item && item.status) !== "ativa";
}

function openFleetModal() {
  const statuses = fleetStatusList();
  const body = `
    <form class="modal-form" data-form="new-fleet">
      <div class="field-row">
        <label class="field">Equipamento *<input name="equipment" required placeholder="N.º equipamento"></label>
        <label class="field">Matrícula *<input name="plate" required placeholder="AA-00-AA"></label>
      </div>
      <label class="field field--wide">Descrição *<input name="description" required placeholder="Ex.: Camião basculante"></label>
      <div class="field-row">
        <label class="field">Marca<input name="brand"></label>
        <label class="field">Ano<input name="year" type="number" min="1980" max="2100"></label>
      </div>
      <div class="field-row">
        <label class="field">Estado<select name="status">${statuses.map((s) => `<option value="${escapeAttr(s)}"${s === "Ativa" ? " selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select></label>
        <label class="field">Empresa<select name="fleetCompany"><option value=""></option><option value="CPSA">CPSA</option><option value="PTSA">PTSA</option></select></label>
      </div>
      <label class="field field--wide">Motorista<input name="driver" placeholder="Motorista responsável"></label>
      <div class="modal-form__actions">
        <button type="button" class="ghost-button" data-action="close-modal">Cancelar</button>
        <button type="submit" class="primary-button"><span data-icon="plus"></span><span>Criar viatura</span></button>
      </div>
    </form>`;
  openModal("Adicionar viatura", body);
}

// Estado numa coluna: texto simples fora do modo admin, dropdown Ativa/Inativa em admin.
function renderFleetStatusColumn(item) {
  const cls = normalizeText(item.status) === "ativa" ? "fleet-status--ativa" : "fleet-status--outro";
  return `<span class="fleet-status-view fleet-status ${cls}">${escapeHtml(item.status || "-")}</span><span class="admin-only">${renderFleetStatusCell(item)}</span>`;
}

function renderFleetStatusCell(item) {
  const statuses = fleetStatusList();
  const cur = item.status || "";
  const opts = statuses.map((s) => `<option value="${escapeAttr(s)}"${normalizeText(s) === normalizeText(cur) ? " selected" : ""}>${escapeHtml(s)}</option>`);
  if (cur && !statuses.some((s) => normalizeText(s) === normalizeText(cur))) opts.unshift(`<option value="${escapeAttr(cur)}" selected>${escapeHtml(cur)}</option>`);
  return `<select data-equipment="${escapeAttr(item.equipment)}" data-fleet-status="true" aria-label="Estado equip. ${escapeAttr(item.equipment)}">${opts.join("")}</select>`;
}

async function updateFleetStatus(equipment, value) {
  if (!requireAdmin()) { render(); return; }
  const item = state.fleet.find((f) => String(f.equipment) === String(equipment));
  if (!item) return;
  const previous = item.status || "";
  const next = String(value || "").trim();
  if (next === previous) return;
  item.status = next;
  const auditEvent = logFleetAudit(item, "status", previous, next);
  saveState();
  showToast("Estado da viatura guardado.");
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
    wheelHubReviewAt: null,
    revisionAt: null
  };

  state.fleet.push(item);
  state.fleet.sort((a, b) => String(a.equipment).localeCompare(String(b.equipment), undefined, { numeric: true }));
  closeModal();
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
  const allEv = allAuditEvents();
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
          ${searchFieldHtml("auditSearch", "Pesquisar evento, equipamento ou nota")}
        </div>
        <div class="audit-filters">
          <div class="chip-filters">
            ${AUDIT_TYPES.map(([v, l]) => {
              const active = (state.filters.auditType || "") === v;
              const count = v ? allEv.filter((e) => auditCategory(e) === v).length : allEv.length;
              return `<button type="button" class="chip-filter ${active ? "active" : ""}" data-action="audit-type" data-type="${escapeAttr(v)}">${escapeHtml(l)} (${count})</button>`;
            }).join("")}
          </div>
          <div class="chip-filters">
            ${AUDIT_PERIODS.map(([v, l]) => {
              const active = (state.filters.auditPeriod || "") === v;
              return `<button type="button" class="chip-filter chip-filter--period ${active ? "active" : ""}" data-action="audit-period" data-period="${escapeAttr(v)}">${escapeHtml(l)}</button>`;
            }).join("")}
          </div>
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
  breakdown.expectedEntryAt = emptyToNull(data.get("expectedEntryAt"));
  breakdown.expectedExitAt = emptyToNull(data.get("expectedExitAt"));
  breakdown.workshopEntryAt = emptyToNull(data.get("workshopEntryAt"));
  breakdown.workshopExitAt = emptyToNull(data.get("workshopExitAt"));
  breakdown.workshop = String(data.get("workshop") || "").trim();
  // "type" é derivado das avarias (multi-avaria) — não se escreve aqui.
  if (data.has("interventionType")) breakdown.interventionType = String(data.get("interventionType") || breakdown.interventionType || "Corretiva");
  if (data.has("priority")) breakdown.priority = String(data.get("priority") || "");
  breakdown.driver = String(data.get("driver") || "").trim();
  breakdown.description = String(data.get("description") || "").trim();

  let preventiveDone = null;
  if (finalStatus === "Concluido" && previous.status !== "Concluido") {
    preventiveDone = applyPreventiveOnClose(breakdown, todayISO());
  }

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
  showToast(preventiveDone ? `Concluída. Próxima agendada: ${formatDate(preventiveDone.nextDate)}.` : intent === "close" ? "Avaria concluída." : intent === "reopen" ? "Ocorrência reaberta." : "Atualização guardada.");
  render();
  refreshDetailModal();
  if (typeof syncBreakdownToTrello === "function" && trelloNote) {
    syncBreakdownToTrello(breakdown, trelloNote);
  }
  await persistRemoteSafely(async () => {
    await persistBreakdownRemote(breakdown);
    await persistAuditRemote(auditEvent);
    if (preventiveDone) { await persistFleetRemote(preventiveDone.fleetItem); await persistAuditRemote(preventiveDone.auditEvent); }
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
  const interventionType = String(data.get("interventionType") || "Corretiva");
  const priority = String(data.get("priority") || "");
  const occurrenceNumber = generateOccurrenceNumber(interventionType, reportedAt);
  const onSite = String(data.get("onSite") || "") === "sim";
  const communicatedAt = emptyToNull(data.get("communicatedAt")) || "";
  const km = String(data.get("km") || "").trim();
  const registeredBy = String(data.get("registeredBy") || remoteConfig.operator || "").trim();
  const logisticsResp = String(data.get("logisticsResp") || "").trim();
  const recurrentOf = String(data.get("recurrentOf") || "").trim();
  const preventivePeriodic = interventionType === "Preventiva" && String(data.get("preventivePeriodic") || "") !== "";
  const preventivePlan = (preventivePeriodic && data.get("preventiveField"))
    ? { field: String(data.get("preventiveField")), months: Number(data.get("preventiveMonths")) || 12 }
    : null;
  const faults = normalizeFaults(_occFaults);
  const typeStr = faults.length ? faults.map((f) => f.tipo).join("; ") : "Outro";
  const fromModal = isModalOpen();
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
    interventionType,
    occurrenceNumber,
    priority,
    communicatedAt,
    onSite,
    km,
    registeredBy,
    logisticsResp,
    recurrentOf,
    type: typeStr,
    faults,
    preventivePlan,
    status: preventivePlan ? "Agendado" : String(data.get("status") || "Parado"),
    situation: String(data.get("situation") || "").trim(),
    reportedAt,
    workshopEntryAt: emptyToNull(data.get("workshopEntryAt")),
    expectedEntryAt: onSite ? null : emptyToNull(data.get("expectedEntryAt")),
    expectedExitAt: onSite ? null : emptyToNull(data.get("expectedExitAt")),
    workshopType: onSite ? "" : String(data.get("workshopType") || ""),
    workshop: onSite ? "" : String(data.get("workshop") || ""),
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

  deriveBreakdownFromFaults(breakdown); // tipo + prioridade a partir das avarias
  state.breakdowns.unshift(breakdown);
  state.selectedId = breakdown.id;
  state.currentView = fromModal ? "breakdowns" : "meeting";
  const originNote = breakdown.vistoriaId ? ` | Origem: vistoria ${formatDate(breakdown.vistoriaDate)} (${breakdown.vistoriaItem})` : "";
  const auditEvent = logAudit(breakdown, "Nova ocorrência", `${occurrenceNumber} · ${interventionType}${priority ? ` · ${priority}` : ""} — ${attachmentNote ? `${description} | Anexos: ${attachmentNote}` : description}${originNote}`);
  recordMeetingEvent("new", breakdown, description);
  if (fromModal) closeModal();
  saveState();
  showToast(`Ocorrência ${occurrenceNumber} criada.`);
  render();
  if (typeof syncBreakdownToTrello === "function") {
    syncBreakdownToTrello(breakdown, "");
  }
  await persistRemoteSafely(async () => {
    await persistBreakdownRemote(breakdown);
    await persistAuditRemote(auditEvent);
  });
}

async function reassignBreakdownVehicle(id) {
  const breakdown = state.breakdowns.find((item) => String(item.id) === String(id));
  if (!breakdown) return;
  const sel = document.querySelector("[data-reassign-plate]");
  const newPlate = sel ? String(sel.value || "").trim() : "";
  if (!newPlate) { showToast("Escolha a matrícula de destino."); return; }
  const target = findFleetByPlate(newPlate);
  if (!target) { showToast("Matrícula não encontrada na frota."); return; }
  const oldPlate = breakdown.plate || "-";
  const oldEquip = breakdown.equipment || "-";
  if (normalizePlate(target.plate) === normalizePlate(oldPlate)) { showToast("A ocorrência já está afeta a esta viatura."); return; }
  if (!window.confirm(`Reafetar a ocorrência ${breakdown.occurrenceNumber || ""} de ${oldPlate} (equip. ${oldEquip}) para ${target.plate} (equip. ${target.equipment})?`)) return;

  breakdown.plate = target.plate;
  breakdown.equipment = target.equipment;
  breakdown.driver = target.driver || "";

  const note = `Reafetada de ${oldPlate} (equip. ${oldEquip}) para ${target.plate} (equip. ${target.equipment})`;
  appendHistory(breakdown, breakdown.status, note, todayISO());
  const auditEvent = logAudit(breakdown, "Reafetação de viatura", note);
  saveState();
  showToast(`Ocorrência reafetada à ${target.plate}.`);
  render();
  await persistRemoteSafely(async () => {
    await persistBreakdownRemote(breakdown);
    await persistAuditRemote(auditEvent);
  });
  // Mover o cartão do Trello para a lista da nova viatura (se o Trello estiver ativo).
  if (typeof reassignTrelloCard === "function") {
    reassignTrelloCard(breakdown, note);
  }
}

async function closeBreakdown(id) {
  const breakdown = state.breakdowns.find((item) => item.id === id);
  if (!breakdown || breakdown.status === "Concluido") return;
  breakdown.status = "Concluido";
  appendHistory(breakdown, "Concluido", "Concluido pela lista", todayISO());
  const auditEvent = logAudit(breakdown, "Concluída", "Concluido pela lista");
  const prev = applyPreventiveOnClose(breakdown, todayISO());
  recordMeetingEvent("close", breakdown, "Concluída pela lista");
  saveState();
  showToast(prev ? `Concluída. Próxima ${escapeHtml(prev.auditEvent.action.replace("Frota: ", ""))}: ${formatDate(prev.nextDate)}.` : "Avaria concluída.");
  render();
  if (typeof syncBreakdownToTrello === "function") {
    syncBreakdownToTrello(breakdown, "Concluído pela lista");
  }
  await persistRemoteSafely(async () => {
    await persistBreakdownRemote(breakdown);
    await persistAuditRemote(auditEvent);
    if (prev) { await persistFleetRemote(prev.fleetItem); await persistAuditRemote(prev.auditEvent); }
  });
}

function appendHistory(breakdown, status, note, date) {
  // Uma atualização = uma linha = um cartão no histórico: colapsa quebras de linha.
  const cleanNote = (note || "").trim().replace(/\s*\r?\n\s*/g, " · ") || "Atualização registada";
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
    wheelHubReviewAt: "Data revisão cubos de roda",
    revisionAt: "Data de revisão",
    preferredWorkshop: "Oficina preferencial",
    status: "Estado",
    partnerEquipment: "Conjunto",
    logisticsResp: "Resp. logística"
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

// ── MODAL (infra reutilizável) ────────────────────────────────────────────

function openModal(title, bodyHtml, opts = {}) {
  const root = document.querySelector("#modal-root");
  if (!root) return;
  const size = opts.size ? ` modal--${opts.size}` : "";
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal${size}" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="modal__head">
          <h3>${escapeHtml(title)}</h3>
          <button class="icon-button" type="button" data-action="close-modal" title="Fechar"><span data-icon="x"></span></button>
        </div>
        <div class="modal__body">${bodyHtml}</div>
      </div>
    </div>`;
  hydrateIcons();
  document.body.classList.add("modal-open");
  const overlay = root.querySelector(".modal-overlay");
  if (overlay) overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeModal(); });
  const first = root.querySelector("input, select, textarea");
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  const root = document.querySelector("#modal-root");
  if (root) root.innerHTML = "";
  document.body.classList.remove("modal-open");
  state._ausModal = null;
}

function isModalOpen() {
  const root = document.querySelector("#modal-root");
  return !!(root && root.firstElementChild);
}

// ── ENTIDADES (mini-CRM: oficinas, fornecedores, motoristas, contactos) ────

function entidadeCategoriaClass(cat) {
  const c = normalizeText(cat || "");
  if (c.includes("oficina")) return "oficina";
  if (c.includes("fornecedor")) return "fornecedor";
  if (c.includes("motorista")) return "motorista";
  if (c.includes("cliente")) return "cliente";
  if (c.includes("segurad")) return "seguradora";
  return "outro";
}

function getFilteredEntidades() {
  const term = normalizeText(state.filters.entidadeSearch || "");
  const cat = state.filters.entidadeCategoria || "";
  return state.entidades.filter((e) => {
    if (cat && e.categoria !== cat) return false;
    if (!term) return true;
    return normalizeText(`${e.empresa} ${e.categoria} ${e.tipo} ${e.contactoNome} ${e.telefone} ${e.email} ${e.notas}`).includes(term);
  });
}

// Entidades de uma categoria — usado por dropdowns de outros módulos (ex.: oficina preferencial).
function entidadesByCategoria(categoria) {
  return state.entidades
    .filter((e) => normalizeText(e.categoria) === normalizeText(categoria))
    .sort((a, b) => a.empresa.localeCompare(b.empresa, "pt"));
}

// Cruzamento automático: padroniza o campo "Motorista" (frota + ausências) para
// o nome canónico da entidade com categoria "Motorista" que corresponde (por
// texto normalizado). Idempotente e não-destrutivo: só altera quando há
// correspondência de confiança; valores sem correspondência ficam intactos.
function reconciliarMotoristas() {
  const motoristas = entidadesByCategoria("Motorista");
  const fleetChanged = [], ausChanged = [];
  if (!motoristas.length) return { fleet: fleetChanged, ausencias: ausChanged };
  const canon = new Map(motoristas.map((m) => [normalizeText(m.empresa), m.empresa]));
  (state.fleet || []).forEach((f) => {
    const c = canon.get(normalizeText(f.driver || ""));
    if (c && f.driver !== c) { f.driver = c; fleetChanged.push(f); }
  });
  (state.ausencias || []).forEach((a) => {
    const c = canon.get(normalizeText(a.driver || ""));
    if (c && a.driver !== c) { a.driver = c; ausChanged.push(a); }
  });
  return { fleet: fleetChanged, ausencias: ausChanged };
}

function renderEntidades() {
  const list = getFilteredEntidades().sort((a, b) => a.empresa.localeCompare(b.empresa, "pt"));
  const total = state.entidades.length;
  const catChips = ["", ...ENTIDADE_CATEGORIAS].map((c) => {
    const active = (state.filters.entidadeCategoria || "") === c;
    const label = c || "Todas";
    const count = c ? state.entidades.filter((e) => e.categoria === c).length : total;
    return `<button type="button" class="chip-filter ${active ? "active" : ""}" data-action="entidade-cat" data-cat="${escapeAttr(c)}">${escapeHtml(label)}${count ? ` (${count})` : ""}</button>`;
  }).join("");

  const cards = list.length
    ? list.map(entidadeCard).join("")
    : `<p class="empty-state">${total ? "Sem entidades para este filtro." : "Ainda não há entidades. Comece por adicionar as suas oficinas e fornecedores."}</p>`;

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Diretório</p>
          <h2>Entidades</h2>
          <p>Oficinas, fornecedores, motoristas e contactos — a fonte única do centro operacional.</p>
        </div>
        <div class="panel-header__actions">
          <button class="primary-button" type="button" data-action="new-entidade"><span data-icon="plus"></span><span>Nova entidade</span></button>
        </div>
      </div>
      <div class="entidade-toolbar">
        ${searchFieldHtml("entidadeSearch", "Pesquisar (empresa, contacto, telefone, email…)", "entidade-search")}
        <div class="chip-filters">${catChips}</div>
      </div>
      <div class="entidade-grid">${cards}</div>
    </section>`;
}

function entidadeCard(e) {
  const cat = entidadeCategoriaClass(e.categoria);
  const rows = [];
  if (e.contactoNome) rows.push(`<div><span class="ico">👤</span>${escapeHtml(e.contactoNome)}</div>`);
  if (e.telefone) rows.push(`<div><span class="ico">📞</span><a href="tel:${escapeAttr(e.telefone.replace(/\s+/g, ""))}">${escapeHtml(e.telefone)}</a></div>`);
  if (e.email) rows.push(`<div><span class="ico">✉️</span><a href="mailto:${escapeAttr(e.email)}">${escapeHtml(e.email)}</a></div>`);
  return `
    <article class="entidade-card entidade-card--${cat}">
      <div class="entidade-card__top">
        <div class="entidade-card__title">
          <strong>${escapeHtml(e.empresa)}</strong>
          ${e.categoria ? `<span class="entidade-cat entidade-cat--${cat}">${escapeHtml(e.categoria)}</span>` : ""}
        </div>
        ${e.tipo ? `<span class="entidade-tipo">${escapeHtml(e.tipo)}</span>` : ""}
      </div>
      ${rows.length ? `<div class="entidade-card__contact">${rows.join("")}</div>` : ""}
      ${e.notas ? `<p class="entidade-card__notes">${escapeHtml(e.notas)}</p>` : ""}
      <div class="entidade-card__actions">
        <button class="icon-button" type="button" data-action="edit-entidade" data-id="${escapeAttr(e.id)}" title="Editar"><span data-icon="pencil"></span></button>
        <button class="icon-button" type="button" data-action="delete-entidade" data-id="${escapeAttr(e.id)}" title="Eliminar"><span data-icon="trash"></span></button>
      </div>
    </article>`;
}

function openEntidadeModal(id) {
  const e = id ? state.entidades.find((x) => String(x.id) === String(id)) : null;
  const tipoOpts = ENTIDADE_TIPOS.map((t) => `<option value="${escapeAttr(t)}" ${e && e.tipo === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("");
  const catOpts = ENTIDADE_CATEGORIAS.map((c) => `<option value="${escapeAttr(c)}" ${e && e.categoria === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
  const body = `
    <form data-form="entidade" class="modal-form">
      <input type="hidden" name="id" value="${escapeAttr(e ? e.id : "")}">
      <label class="field field--wide">Empresa / Entidade *
        <input type="text" name="empresa" required value="${escapeAttr(e ? e.empresa : "")}" placeholder="Ex.: Oficinas XYZ, Lda">
      </label>
      <div class="field-row">
        <label class="field">Categoria
          <select name="categoria"><option value="">—</option>${catOpts}</select>
        </label>
        <label class="field">Tipo
          <select name="tipo"><option value="">—</option>${tipoOpts}</select>
        </label>
      </div>
      <label class="field field--wide">Nome do contacto
        <input type="text" name="contactoNome" value="${escapeAttr(e ? e.contactoNome : "")}" placeholder="Pessoa de contacto">
      </label>
      <div class="field-row">
        <label class="field">Telefone
          <input type="text" name="telefone" value="${escapeAttr(e ? e.telefone : "")}" placeholder="2xx xxx xxx / 9xx xxx xxx">
        </label>
        <label class="field">Email
          <input type="email" name="email" value="${escapeAttr(e ? e.email : "")}" placeholder="nome@dominio.pt">
        </label>
      </div>
      <label class="field field--wide">Notas / Observações
        <textarea name="notas" rows="3" placeholder="Especialidade, horário, condições, histórico…">${escapeHtml(e ? e.notas : "")}</textarea>
      </label>
      <div class="modal-form__actions">
        <button type="button" class="ghost-button" data-action="close-modal">Cancelar</button>
        <button type="submit" class="primary-button"><span data-icon="check"></span><span>Gravar entidade</span></button>
      </div>
    </form>`;
  openModal(e ? "Editar entidade" : "Nova entidade", body);
}

async function handleSaveEntidade(form) {
  const data = new FormData(form);
  const empresa = String(data.get("empresa") || "").trim();
  if (!empresa) { showToast("Indique o nome da empresa/entidade."); return; }
  const id = String(data.get("id") || "").trim();
  const existing = id ? state.entidades.find((x) => String(x.id) === id) : null;
  const item = {
    id: existing ? existing.id : `ENT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    empresa,
    tipo: String(data.get("tipo") || "").trim(),
    categoria: String(data.get("categoria") || "").trim(),
    contactoNome: String(data.get("contactoNome") || "").trim(),
    telefone: String(data.get("telefone") || "").trim(),
    email: String(data.get("email") || "").trim(),
    notas: String(data.get("notas") || "").trim(),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    createdBy: existing ? existing.createdBy : (remoteConfig.operator || "Utilizador")
  };
  if (existing) {
    state.entidades = state.entidades.map((x) => (x === existing ? item : x));
  } else {
    state.entidades.push(item);
  }
  saveState();
  closeModal();
  showToast(existing ? "Entidade atualizada." : "Entidade criada.");
  render();
  await persistRemoteSafely(() => persistEntidadeRemote(item));
}

async function deleteEntidade(id) {
  const e = state.entidades.find((x) => String(x.id) === String(id));
  if (!e) return;
  if (!window.confirm(`Eliminar a entidade "${e.empresa}"?`)) return;
  state.entidades = state.entidades.filter((x) => x !== e);
  saveState();
  render();
  await persistRemoteSafely(() => deleteEntidadeRemote(e.id));
}

// ── DEFINIÇÕES: taxonomia de tipos de avaria por tipo de viatura ───────────

const DEFINICOES_VEHICLE_TYPES = ["Trator", "Reboque"];

function faultTypesFor(vehicleType) {
  return state.faultTypes
    .filter((t) => t.active !== false && normalizeText(t.vehicleType) === normalizeText(vehicleType))
    .sort((a, b) => (a.position - b.position) || (a.grupo || "").localeCompare(b.grupo || "", "pt") || (a.nome || "").localeCompare(b.nome || "", "pt"));
}

function faultTypeGroups(vehicleType) {
  const map = new Map();
  for (const t of faultTypesFor(vehicleType)) {
    if (!map.has(t.grupo)) map.set(t.grupo, []);
    map.get(t.grupo).push(t);
  }
  return map;
}

function vehicleBucketForPlate(plate) {
  const f = findFleetByPlate(plate);
  return f && isTratorFleet(f) ? "Trator" : "Reboque";
}

// ── Multi-avaria: lista de avarias por ocorrência + % de resolução ──────────
const FAULT_PRIO_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };

function normalizeFaults(raw) {
  let arr = raw;
  if (typeof arr === "string") { try { arr = JSON.parse(arr || "[]"); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.filter((f) => f && (f.tipo || f.nome)).map((f, i) => ({
    id: String(f.id || `f${i}-${Math.random().toString(36).slice(2, 6)}`),
    tipo: String(f.tipo || f.nome || "").trim(),
    prioridade: /^P[1-4]$/.test(f.prioridade || "") ? f.prioridade : "",
    resolvida: !!f.resolvida
  }));
}

function faultProgress(breakdown) {
  const faults = normalizeFaults(breakdown && breakdown.faults);
  if (!faults.length) return null;
  const total = faults.length;
  const resolved = faults.filter((f) => f.resolvida).length;
  const pct = Math.round((resolved / total) * 100);
  const tone = pct === 0 ? "grey" : pct < 50 ? "red" : pct < 100 ? "orange" : "green";
  return { total, resolved, pct, tone };
}

// Deriva o "Tipo" (lista de avarias) e a prioridade (a mais alta por resolver) das avarias.
function deriveBreakdownFromFaults(breakdown) {
  const faults = normalizeFaults(breakdown.faults);
  breakdown.faults = faults;
  if (!faults.length) return;
  breakdown.type = faults.map((f) => f.tipo).filter(Boolean).join("; ");
  const unresolved = faults.filter((f) => !f.resolvida && f.prioridade);
  const pool = unresolved.length ? unresolved : faults.filter((f) => f.prioridade);
  let best = "";
  pool.forEach((f) => { if (!best || FAULT_PRIO_RANK[f.prioridade] < FAULT_PRIO_RANK[best]) best = f.prioridade; });
  if (best) breakdown.priority = best;
}

function progressBadge(breakdown) {
  const p = faultProgress(breakdown);
  if (!p) return "";
  return `<span class="prog-badge prog-badge--${p.tone}" title="${p.resolved} de ${p.total} avarias resolvidas">${p.pct}% resolvida</span>`;
}

// Sela um <select> de tipos de avaria e devolve o par {tipo, prioridade} escolhido.
function faultFromSelect(selectEl) {
  if (!selectEl || !selectEl.value) return null;
  const opt = selectEl.selectedOptions[0];
  return { tipo: selectEl.value, prioridade: (opt && opt.dataset.prio) || "" };
}

// ── Preventiva periódica: intervenções da Frota a reagendar ────────────────
const PREVENTIVE_FIELDS = [
  { field: "inspectionAt", label: "Inspeção", months: 12 },
  { field: "tachographAt", label: "Aferição tacógrafo", months: 24 },
  { field: "compressorReviewAt", label: "Revisão compressor", months: 12 },
  { field: "wheelHubReviewAt", label: "Cubos de roda", months: 12 },
  { field: "revisionAt", label: "Revisão", months: 12 }
];
function preventiveFieldsForPlate(plate) {
  const trator = vehicleBucketForPlate(plate) === "Trator";
  return PREVENTIVE_FIELDS.filter((p) => p.field !== "revisionAt" || trator);
}
function preventiveMonthsFor(field) {
  const p = PREVENTIVE_FIELDS.find((x) => x.field === field);
  return p ? p.months : 12;
}
function normalizePreventive(p) {
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  if (!p || !p.field || !p.months) return null;
  return { field: String(p.field), months: Number(p.months) || 12 };
}
function addMonthsISO(iso, months) {
  const src = String(iso || "").slice(0, 10);
  const base = src ? new Date(`${src}T00:00:00`) : new Date();
  if (isNaN(base.getTime())) return "";
  base.setMonth(base.getMonth() + Number(months || 0));
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")}`;
}
// Ao concluir uma preventiva periódica, agenda a próxima data dessa intervenção na Frota.
function applyPreventiveOnClose(breakdown, conclusionISO) {
  const plan = normalizePreventive(breakdown && breakdown.preventivePlan);
  if (!plan) return null;
  const plateN = normalizePlate(breakdown.plate || "");
  const fleetItem = state.fleet.find((f) => String(f.equipment) === String(breakdown.equipment) || (plateN && normalizePlate(f.plate) === plateN));
  if (!fleetItem) return null;
  const nextDate = addMonthsISO(conclusionISO || todayISO(), plan.months);
  if (!nextDate) return null;
  const prev = fleetItem[plan.field] || "";
  fleetItem[plan.field] = nextDate;
  const auditEvent = logFleetAudit(fleetItem, plan.field, prev || "-", nextDate);
  return { fleetItem, auditEvent, nextDate };
}

function faultTypeOptionsHtml(vehicleType, selectedSet) {
  const sel = selectedSet instanceof Set ? selectedSet : null;
  const isSel = (name) => (sel && sel.has(normalizeText(name))) ? " selected" : "";
  const groups = faultTypeGroups(vehicleType);
  if (!groups.size) {
    return `<option value="" disabled>Sem tipos definidos para ${escapeHtml(vehicleType)} — configure em Frota › Definições</option>` +
      options.types.map((t) => `<option value="${escapeAttr(t)}"${isSel(t)}>${escapeHtml(t)}</option>`).join("");
  }
  let html = "";
  // Grupos e itens organizados alfabeticamente (pedido ARGOS).
  const orderedGroups = [...groups.entries()].sort((a, b) => (a[0] || "").localeCompare(b[0] || "", "pt"));
  for (const [grupo, items] of orderedGroups) {
    const orderedItems = [...items].sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt"));
    html += `<optgroup label="${escapeAttr(grupo || "Outros")}">` +
      orderedItems.map((t) => `<option value="${escapeAttr(t.nome)}"${isSel(t.nome)} data-prio="${escapeAttr(t.suggestedPriority || "")}">${escapeHtml(t.nome)}${t.hint ? ` — ${escapeHtml(t.hint)}` : ""}</option>`).join("") +
      `</optgroup>`;
  }
  return html;
}

function renderDefinicoes() {
  const vt = DEFINICOES_VEHICLE_TYPES.includes(state.definicoesVehicleType) ? state.definicoesVehicleType : "Trator";
  const groups = faultTypeGroups(vt);
  const total = faultTypesFor(vt).length;
  const tabs = DEFINICOES_VEHICLE_TYPES.map((t) => {
    const count = faultTypesFor(t).length;
    return `<button type="button" class="chip-filter ${vt === t ? "active" : ""}" data-action="definicoes-vt" data-vt="${escapeAttr(t)}">${escapeHtml(t)} (${count})</button>`;
  }).join("");

  let groupsHtml = "";
  if (groups.size) {
    for (const [grupo, items] of groups) {
      groupsHtml += `
        <div class="def-group">
          <h3>${escapeHtml(grupo || "(sem grupo)")}</h3>
          <div class="def-rows">${items.map(faultTypeRow).join("")}</div>
        </div>`;
    }
  } else {
    groupsHtml = `<p class="empty-state">Sem tipos de avaria para ${escapeHtml(vt)}. Adicione o primeiro com "Novo tipo".</p>`;
  }

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Definições</p>
          <h2>Tipos de avaria & prioridades</h2>
          <p>${total} tipos para ${escapeHtml(vt)} — geríveis sem sair da app.</p>
        </div>
        <div class="panel-header__actions">
          <button class="primary-button" type="button" data-action="new-fault-type"><span data-icon="plus"></span><span>Novo tipo</span></button>
        </div>
      </div>
      <div class="entidade-toolbar">
        <div class="chip-filters">${tabs}</div>
      </div>
      <div class="def-list">${groupsHtml}</div>
    </section>`;
}

function faultTypeRow(t) {
  const prioOpts = [["", "—"], ...PRIORITIES].map(([p]) =>
    `<option value="${escapeAttr(p)}" ${t.suggestedPriority === p ? "selected" : ""}>${escapeHtml(p || "—")}</option>`).join("");
  return `
    <div class="def-row">
      <div class="def-row__main">
        <strong>${escapeHtml(t.nome)}</strong>
        ${t.hint ? `<span>${escapeHtml(t.hint)}</span>` : ""}
      </div>
      <label class="def-row__prio">Prioridade
        <select data-fault-priority="true" data-id="${escapeAttr(t.id)}">${prioOpts}</select>
      </label>
      <div class="def-row__actions">
        <button class="icon-button" type="button" data-action="edit-fault-type" data-id="${escapeAttr(t.id)}" title="Editar"><span data-icon="pencil"></span></button>
        <button class="icon-button" type="button" data-action="delete-fault-type" data-id="${escapeAttr(t.id)}" title="Eliminar"><span data-icon="trash"></span></button>
      </div>
    </div>`;
}

function openFaultTypeModal(id) {
  const t = id ? state.faultTypes.find((x) => String(x.id) === String(id)) : null;
  const vtOpts = DEFINICOES_VEHICLE_TYPES.map((v) => {
    const sel = t ? t.vehicleType === v : state.definicoesVehicleType === v;
    return `<option value="${escapeAttr(v)}" ${sel ? "selected" : ""}>${escapeHtml(v)}</option>`;
  }).join("");
  const grupos = [...new Set(state.faultTypes.map((x) => x.grupo).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt"));
  const body = `
    <form data-form="fault-type" class="modal-form">
      <input type="hidden" name="id" value="${escapeAttr(t ? t.id : "")}">
      <div class="field-row">
        <label class="field">Tipo de viatura *
          <select name="vehicleType" required>${vtOpts}</select>
        </label>
        <label class="field">Prioridade sugerida
          <select name="suggestedPriority"><option value="">—</option>${PRIORITIES.map(([p, l]) => `<option value="${escapeAttr(p)}" ${t && t.suggestedPriority === p ? "selected" : ""}>${escapeHtml(p)} · ${escapeHtml(l)}</option>`).join("")}</select>
        </label>
      </div>
      <label class="field field--wide">Grupo
        <input name="grupo" list="def-grupos" value="${escapeAttr(t ? t.grupo : "")}" placeholder="Ex.: Travagem">
        <datalist id="def-grupos">${grupos.map((g) => `<option value="${escapeAttr(g)}"></option>`).join("")}</datalist>
      </label>
      <label class="field field--wide">Tipo de avaria *
        <input name="nome" required value="${escapeAttr(t ? t.nome : "")}" placeholder="Ex.: Fricção">
      </label>
      <label class="field field--wide">Exemplos / notas
        <input name="hint" value="${escapeAttr(t ? t.hint : "")}" placeholder="Ex.: pastilhas, discos, maxilas, tambores">
      </label>
      <div class="modal-form__actions">
        <button type="button" class="ghost-button" data-action="close-modal">Cancelar</button>
        <button type="submit" class="primary-button"><span data-icon="check"></span><span>Gravar tipo</span></button>
      </div>
    </form>`;
  openModal(t ? "Editar tipo de avaria" : "Novo tipo de avaria", body);
}

async function handleSaveFaultType(form) {
  const data = new FormData(form);
  const nome = String(data.get("nome") || "").trim();
  if (!nome) { showToast("Indique o tipo de avaria."); return; }
  const id = String(data.get("id") || "").trim();
  const existing = id ? state.faultTypes.find((x) => String(x.id) === id) : null;
  const item = {
    id: existing ? existing.id : `FT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    vehicleType: String(data.get("vehicleType") || "Trator"),
    grupo: String(data.get("grupo") || "").trim(),
    nome,
    hint: String(data.get("hint") || "").trim(),
    suggestedPriority: String(data.get("suggestedPriority") || ""),
    position: existing ? existing.position : (state.faultTypes.length + 1) * 10,
    active: true
  };
  if (existing) state.faultTypes = state.faultTypes.map((x) => (x === existing ? item : x));
  else state.faultTypes.push(item);
  state.definicoesVehicleType = item.vehicleType;
  saveState();
  closeModal();
  showToast(existing ? "Tipo atualizado." : "Tipo criado.");
  render();
  await persistRemoteSafely(() => persistFaultTypeRemote(item));
}

async function updateFaultTypePriority(id, value) {
  const t = state.faultTypes.find((x) => String(x.id) === String(id));
  if (!t) return;
  t.suggestedPriority = value || "";
  saveState();
  showToast("Prioridade sugerida guardada.");
  await persistRemoteSafely(() => persistFaultTypeRemote(t));
}

async function deleteFaultType(id) {
  const t = state.faultTypes.find((x) => String(x.id) === String(id));
  if (!t) return;
  if (!window.confirm(`Eliminar o tipo de avaria "${t.nome}"?`)) return;
  state.faultTypes = state.faultTypes.filter((x) => x !== t);
  saveState();
  render();
  await persistRemoteSafely(() => deleteFaultTypeRemote(t.id));
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
    { label: "Cubos", value: f.wheelHubReviewAt },
    ...(isTratorFleet(f) ? [{ label: "Revisão", value: f.revisionAt }] : [])
  ].filter((x) => x.value && !isFleetNA(x.value));
}

// ── Campos editáveis de uma ausência (tabela + janelas dinâmicas) ──
function ausenciaDriverInput(a) {
  // Ligação direta: só motoristas afetos a equipamento na Frota (padronizados).
  const current = (a.driver || "").trim();
  const drivers = distinctFleetDrivers();
  const parts = [`<option value="">—</option>`];
  let matched = false;
  for (const d of drivers) {
    const sel = normalizeText(d) === normalizeText(current);
    if (sel) matched = true;
    parts.push(`<option value="${escapeAttr(d)}"${sel ? " selected" : ""}>${escapeHtml(d)}</option>`);
  }
  if (current && !matched) {
    parts.push(`<option value="${escapeAttr(current)}" selected>${escapeHtml(current)} (fora da frota)</option>`);
  }
  return `<select class="aus-inp" data-ausencia-id="${escapeAttr(a.id)}" data-ausencia-field="driver">${parts.join("")}</select>`;
}
function ausenciaTypeSelect(a) {
  return `<select class="aus-inp" data-ausencia-id="${escapeAttr(a.id)}" data-ausencia-field="type">${ABSENCE_TYPES.map((t) => `<option value="${escapeAttr(t)}"${normalizeText(t) === normalizeText(a.type) ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select>`;
}
function ausenciaDateInput(a, field) {
  return `<input class="aus-inp" type="date" data-ausencia-id="${escapeAttr(a.id)}" data-ausencia-field="${field}" value="${escapeAttr(a[field] || "")}">`;
}
function ausenciaNotesInput(a) {
  return `<input class="aus-inp" type="text" data-ausencia-id="${escapeAttr(a.id)}" data-ausencia-field="notes" value="${escapeAttr(a.notes || "")}" placeholder="Notas…">`;
}

// Viaturas do motorista (auto, só leitura) — para a coluna Viatura da tabela.
function ausenciaDriverVehiclesText(driver) {
  const vs = driverVehiclesWithConjunto(driver);
  if (!vs.length) return "—";
  return vs.map(({ f, conjunto }) => `${conjunto ? "🔗 " : ""}${f.plate || "—"}`).join(" · ");
}

// Linha editável de uma ausência para as janelas dinâmicas (modal).
function ausenciaEditRow(a, showDriver) {
  return `<li class="aus-edit-row">
    <div class="aus-edit-grid">
      ${showDriver ? ausenciaDriverInput(a) : ""}
      ${ausenciaTypeSelect(a)}
      ${ausenciaDateInput(a, "startAt")}
      <span class="aus-edit-arrow">→</span>
      ${ausenciaDateInput(a, "endAt")}
      <span class="aus-edit-days">${absenceDays(a)} d</span>
      <button class="icon-button" type="button" data-action="delete-ausencia" data-id="${escapeAttr(a.id)}" title="Eliminar ausência"><span data-icon="trash"></span></button>
    </div>
    ${ausenciaNotesInput(a)}
  </li>`;
}

async function updateAusenciaField(id, field, rawValue) {
  const a = state.ausencias.find((x) => String(x.id) === String(id));
  if (!a) return;
  const prev = a[field] || "";
  const next = String(rawValue ?? "").trim();
  if (field === "driver" && !next) { showToast("O motorista não pode ficar vazio."); render(); refreshAusenciaModal(); return; }
  if (field === "startAt" && a.endAt && next && next > a.endAt) { showToast("O início não pode ser depois do fim."); render(); refreshAusenciaModal(); return; }
  if (field === "endAt" && a.startAt && next && next < a.startAt) { showToast("O fim não pode ser antes do início."); render(); refreshAusenciaModal(); return; }
  if (next === prev) return;
  a[field] = next;
  const auditEvent = {
    id: `AUS-${id}-edit-${Date.now()}`, breakdownId: "", equipment: "", plate: "",
    at: new Date().toISOString(), action: "Ausência editada", status: a.type,
    note: `${a.driver} · ${field}: ${prev || "—"} → ${next || "—"}`
  };
  state.audit.unshift(auditEvent);
  saveState();
  showToast("Ausência atualizada.");
  render();
  refreshAusenciaModal();
  await persistRemoteSafely(async () => {
    await persistAusenciaRemote(a);
    await persistAuditRemote(auditEvent);
  });
}

// Re-render da janela dinâmica aberta após uma edição/eliminação.
function refreshAusenciaModal() {
  const m = state._ausModal;
  if (!m || !isModalOpen()) return;
  if (m.kind === "cell") openAusenciaCellDetail(m.driver, m.month);
  else if (m.kind === "day") openAusenciaDayDetail(m.date);
}

function renderAusencias() {
  const mode = state.ausenciaViewMode === "month" ? "month" : "year";
  const monthISO = state.ausenciaMonth || currentMonthISO();
  const list = [...state.ausencias].sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
  const monthAbs = list.filter((a) => absenceOverlapsMonth(a, monthISO));

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Ausências</p>
          <h2>${mode === "year" ? "Mapa anual de ausências" : "Calendário de ausências"}</h2>
          <p>${list.length} ausência(s) registada(s)</p>
        </div>
        <div class="panel-header__actions">
          <div class="fleet-viewtoggle" role="group" aria-label="Vista">
            <button type="button" class="${mode === "year" ? "active" : ""}" data-action="ausencia-mode" data-mode="year">Anual</button>
            <button type="button" class="${mode === "month" ? "active" : ""}" data-action="ausencia-mode" data-mode="month">Mensal</button>
          </div>
          <button class="primary-button" type="button" data-action="new-ausencia-modal"><span data-icon="plus"></span><span>Nova ausência</span></button>
        </div>
      </div>

      <datalist id="aus-drivers">${distinctFleetDrivers().map((d) => `<option value="${escapeAttr(d)}"></option>`).join("")}</datalist>
      ${renderAusenciaRespFilter()}
      ${mode === "year"
        ? renderAusenciaYear(list)
        : `${renderAusenciaCalendar(monthISO, list)}${renderAusenciaPlanning(monthAbs, monthISO)}`}
      ${renderAusenciaList(list)}
    </section>
  `;
}

// Barra de filtro por Responsável de Logística (chips).
function renderAusenciaRespFilter() {
  const resps = respLogEntidades().map((e) => e.empresa || e.contactoNome).filter(Boolean);
  const cur = state.filters.ausenciaResp || "";
  const chip = (val, label) => `<button type="button" class="chip-filter${cur === val ? " active" : ""}" data-action="ausencia-resp" data-resp="${escapeAttr(val)}">${escapeHtml(label)}</button>`;
  if (!resps.length) return "";
  return `
    <div class="ausencia-respbar">
      <span class="ausencia-respbar__lbl">Responsável de logística:</span>
      <div class="chip-filters">${chip("", "Todos")}${resps.map((r) => chip(r, r)).join("")}</div>
    </div>`;
}

const AUS_MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

// Nível de cobertura (nº de pessoas em simultâneo): 1 azul, 2 laranja, 3+ vermelho.
function ausCoverageClass(n) {
  return n >= 3 ? "lvl3" : n === 2 ? "lvl2" : n >= 1 ? "lvl1" : "";
}

function driverInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function renderAusenciaYear(allAbs) {
  const year = state.ausenciaYear || new Date().getFullYear();
  const yStr = String(year);
  const respFilter = state.filters.ausenciaResp || "";
  // Ausências que tocam neste ano (e, se filtrado, do responsável escolhido).
  const abs = allAbs.filter((a) =>
    a.startAt && a.endAt && a.startAt.slice(0, 4) <= yStr && a.endAt.slice(0, 4) >= yStr &&
    (!respFilter || driverLogisticsResp(a.driver) === respFilter)
  );

  // Contagem por dia (nº distinto de motoristas ausentes) e dias por motorista.
  const dayDrivers = {};                 // iso -> Set(driver)
  const driverDayMonth = {};             // driver -> { [month]: Set(iso) }
  abs.forEach((a) => {
    let d = new Date(`${a.startAt}T00:00:00`);
    const end = new Date(`${a.endAt}T00:00:00`);
    let guard = 0;
    while (d <= end && guard++ < 800) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (iso.slice(0, 4) === yStr) {
        (dayDrivers[iso] = dayDrivers[iso] || new Set()).add(a.driver);
        const mo = d.getMonth();
        const dm = (driverDayMonth[a.driver] = driverDayMonth[a.driver] || {});
        (dm[mo] = dm[mo] || new Set()).add(iso);
      }
      d.setDate(d.getDate() + 1);
    }
  });

  const drivers = Object.keys(driverDayMonth).sort((x, y) => x.localeCompare(y, "pt"));

  // Máximo de pessoas em simultâneo por mês (para colorir rodapé) e total de dias/mês.
  const monthMaxLevel = new Array(12).fill(0);
  const monthDriverCount = new Array(12).fill(0);
  for (let m = 0; m < 12; m++) {
    const set = new Set();
    drivers.forEach((dr) => { if (driverDayMonth[dr][m]) set.add(dr); });
    monthDriverCount[m] = set.size;
  }
  Object.keys(dayDrivers).forEach((iso) => {
    const m = Number(iso.slice(5, 7)) - 1;
    monthMaxLevel[m] = Math.max(monthMaxLevel[m], dayDrivers[iso].size);
  });

  // Alertas de cobertura: meses com 2+ pessoas em simultâneo.
  const alerts = [];
  for (let m = 0; m < 12; m++) {
    if (monthMaxLevel[m] >= 2) {
      const who = drivers.filter((dr) => driverDayMonth[dr][m]);
      const label = new Intl.DateTimeFormat("pt-PT", { month: "long" }).format(new Date(year, m, 1));
      alerts.push({ level: monthMaxLevel[m], text: `<strong>${escapeHtml(label)}</strong> — ${monthMaxLevel[m]} em simultâneo (${who.map(escapeHtml).join(", ")})` });
    }
  }
  alerts.sort((a, b) => b.level - a.level);

  const headCells = AUS_MONTHS.map((m, i) => `<th class="${i + 1 === new Date().getMonth() + 1 && year === new Date().getFullYear() ? "aus-th--now" : ""}">${m}</th>`).join("");

  const rows = drivers.length ? drivers.map((dr) => {
    let total = 0;
    const cells = [];
    for (let m = 0; m < 12; m++) {
      const days = driverDayMonth[dr][m];
      const dataAttr = `data-action="ausencia-cell" data-driver="${escapeAttr(dr)}" data-month="${m}"`;
      if (!days || !days.size) { cells.push(`<td class="aus-cell aus-cell--empty" ${dataAttr}>—</td>`); continue; }
      const count = days.size;
      total += count;
      let lvl = 0;
      days.forEach((iso) => { lvl = Math.max(lvl, dayDrivers[iso].size); });
      cells.push(`<td class="aus-cell aus-cell--${ausCoverageClass(lvl)}" ${dataAttr} title="${escapeAttr(`${dr} · ${AUS_MONTHS[m]}: ${count} dia(s) · ${lvl} em simultâneo — clicar para detalhe`)}">${count}</td>`);
    }
    const resp = driverLogisticsResp(dr);
    return `
      <tr>
        <th class="aus-name"><span class="aus-ava">${escapeHtml(driverInitials(dr))}</span><span><strong>${escapeHtml(dr)}</strong>${resp ? `<small>${escapeHtml(resp)}</small>` : ""}</span></th>
        ${cells.join("")}
        <td class="aus-total">${total}</td>
      </tr>`;
  }).join("") : `<tr><td colspan="14" class="empty-state">Sem ausências ${escapeHtml(respFilter ? "deste responsável " : "")}em ${year}.</td></tr>`;

  const footCells = [];
  for (let m = 0; m < 12; m++) {
    footCells.push(`<td class="aus-foot aus-foot--${ausCoverageClass(monthMaxLevel[m])}">${monthDriverCount[m] || "—"}</td>`);
  }

  return `
    <div class="cal-toolbar">
      <button class="ghost-button" type="button" data-action="ausencia-year-prev" aria-label="Ano anterior">‹</button>
      <strong class="cal-month">${year}</strong>
      <button class="ghost-button" type="button" data-action="ausencia-year-next" aria-label="Ano seguinte">›</button>
    </div>
    ${alerts.length ? `
      <div class="aus-alertbox">
        <strong>⚠️ Alertas de cobertura</strong>
        ${alerts.map((a) => `<p class="aus-alert aus-alert--${ausCoverageClass(a.level)}">${a.text}</p>`).join("")}
      </div>` : ""}
    <div class="aus-legend">
      <span><i class="aus-dot aus-dot--lvl1"></i> Férias / 1 pessoa</span>
      <span><i class="aus-dot aus-dot--lvl2"></i> 2 pessoas em simultâneo</span>
      <span><i class="aus-dot aus-dot--lvl3"></i> 3+ pessoas em simultâneo</span>
    </div>
    <div class="table-wrap">
      <table class="aus-matrix">
        <thead><tr><th class="aus-name">Motorista</th>${headCells}<th class="aus-total">Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th class="aus-name">Ausências/mês</th>${footCells.join("")}<td class="aus-total">${drivers.length}</td></tr></tfoot>
      </table>
    </div>`;
}

// Motoristas ausentes num dado dia (todas as ausências).
function driversAbsentOnDay(iso) {
  const set = new Set();
  (state.ausencias || []).forEach((a) => { if (a.startAt && a.endAt && iso >= a.startAt && iso <= a.endAt) set.add(a.driver); });
  return set;
}

// Ausências de um motorista que tocam num mês (month 0-11) de um ano.
function absencesForDriverMonth(driver, year, month) {
  const mEndDay = new Date(year, month + 1, 0).getDate();
  const mStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const mEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(mEndDay).padStart(2, "0")}`;
  return (state.ausencias || []).filter((a) => a.driver === driver && a.startAt && a.endAt && a.startAt <= mEnd && a.endAt >= mStart);
}

// Mini-calendário do mês com os dias de ausência realçados (colorido por cobertura).
function ausenciaMiniCalHtml(year, month, driverDaysSet) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startMon = (new Date(year, month, 1).getDay() + 6) % 7;
  const weekdays = ["S", "T", "Q", "Q", "S", "S", "D"];
  const cells = [];
  for (let i = 0; i < startMon; i++) cells.push(`<div class="aus-mini-cell aus-mini-cell--empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dow = (startMon + d - 1) % 7;
    const isWk = dow >= 5;
    if (driverDaysSet.has(d)) {
      const lvl = driversAbsentOnDay(iso).size;
      cells.push(`<div class="aus-mini-cell aus-mini-cell--${ausCoverageClass(lvl)}" title="${escapeAttr(`${lvl} pessoa(s) ausente(s) neste dia`)}">${d}</div>`);
    } else {
      cells.push(`<div class="aus-mini-cell${isWk ? " aus-mini-cell--wk" : ""}">${d}</div>`);
    }
  }
  return `
    <div class="aus-mini-grid aus-mini-grid--head">${weekdays.map((w) => `<div class="aus-mini-head">${w}</div>`).join("")}</div>
    <div class="aus-mini-grid">${cells.join("")}</div>`;
}

// Janela dinâmica: detalhe do mês de um motorista (a partir de uma célula do mapa anual).
function openAusenciaCellDetail(driver, month) {
  if (!driver || !Number.isFinite(month)) return;
  state._ausModal = { kind: "cell", driver, month };
  const year = state.ausenciaYear || new Date().getFullYear();
  const monthName = new Intl.DateTimeFormat("pt-PT", { month: "long" }).format(new Date(year, month, 1));
  const abs = absencesForDriverMonth(driver, year, month).sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));

  // Dias (nº do mês) em que o motorista está ausente neste mês/ano.
  const driverDays = new Set();
  const mEndDay = new Date(year, month + 1, 0).getDate();
  abs.forEach((a) => {
    for (let d = 1; d <= mEndDay; d++) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (iso >= a.startAt && iso <= a.endAt) driverDays.add(d);
    }
  });

  const resp = driverLogisticsResp(driver);
  const absList = abs.length
    ? abs.map((a) => ausenciaEditRow(a, false)).join("")
    : `<li class="muted">Sem ausências neste mês.</li>`;

  const vehicles = driverVehiclesWithConjunto(driver);
  const vehHtml = vehicles.length
    ? vehicles.map(({ f, conjunto }) => {
        const dues = fleetDueList(f);
        const badges = dues.length ? dues.map((x) => `<span class="plan-due">${escapeHtml(x.label)} ${renderDueBadge(x.value)}</span>`).join("") : `<span class="muted">sem datas</span>`;
        return `<div class="plan-equip"><strong>Equip. ${escapeHtml(f.equipment)}</strong> · ${escapeHtml(f.plate || "-")}${conjunto ? ` <span class="plan-conjunto">🔗 conjunto</span>` : ""} <span class="plan-oficina">🔧 disponível p/ oficina</span><div class="plan-dues">${badges}</div></div>`;
      }).join("")
    : `<p class="muted">Sem viatura associada a este motorista.</p>`;

  const body = `
    <div class="aus-detail">
      <div class="aus-detail__head">
        <span class="aus-ava">${escapeHtml(driverInitials(driver))}</span>
        <div><strong>${escapeHtml(driver)}</strong><small>${escapeHtml(monthName)} ${year} · ${driverDays.size} dia(s) de ausência${resp ? ` · Resp.: ${escapeHtml(resp)}` : ""}</small></div>
      </div>
      ${ausenciaMiniCalHtml(year, month, driverDays)}
      <div class="aus-detail__sec"><h4>Ausências</h4><ul class="aus-detail__list">${absList}</ul></div>
      <div class="aus-detail__sec"><h4>Viatura e conjunto (disponível para oficina)</h4>${vehHtml}</div>
      <div class="modal-form__actions"><button type="button" class="ghost-button" data-action="close-modal">Fechar</button></div>
    </div>`;
  openModal(`Ausências · ${monthName} ${year}`, body);
}

// Janela dinâmica: detalhe de um dia do calendário mensal (quem está ausente).
function openAusenciaDayDetail(dateISO) {
  if (!dateISO) return;
  state._ausModal = { kind: "day", date: dateISO };
  const dayAbs = (state.ausencias || []).filter((a) => a.startAt && a.endAt && dateISO >= a.startAt && dateISO <= a.endAt)
    .sort((a, b) => (a.driver || "").localeCompare(b.driver || "", "pt"));
  const dLabel = formatDate(dateISO);
  const items = dayAbs.length
    ? dayAbs.map((a) => {
        const resp = driverLogisticsResp(a.driver);
        const veh = ausenciaDriverVehiclesText(a.driver);
        return `<li class="aus-day-item">
          <div class="aus-day-item__top"><strong>${escapeHtml(a.driver)}</strong>${resp ? ` <span class="muted">· ${escapeHtml(resp)}</span>` : ""} <span class="muted">· 🚚 ${escapeHtml(veh)}</span> <span class="plan-oficina">🔧 disponível p/ oficina</span></div>
          ${ausenciaEditRow(a, false)}
        </li>`;
      }).join("")
    : `<li class="muted">Ninguém ausente neste dia.</li>`;
  const body = `
    <div class="aus-detail">
      <p class="muted">${dayAbs.length} motorista(s) ausente(s) — coordena as janelas de oficina.</p>
      <ul class="aus-detail__list aus-detail__list--day">${items}</ul>
      <div class="modal-form__actions"><button type="button" class="ghost-button" data-action="close-modal">Fechar</button></div>
    </div>`;
  openModal(`Ausências · ${dLabel}`, body);
}

function renderAusenciaCalendar(monthISO, list) {
  const { daysInMonth, year, month } = monthBounds(monthISO);
  const first = new Date(year, month - 1, 1);
  const startWeekday = (first.getDay() + 6) % 7; // 0 = Segunda
  const monthLabel = new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric" }).format(first);
  const today = todayISO();
  const weekdays = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

  const paint = ausPaint();
  const painting = !!paint.driver;
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(`<div class="cal-cell cal-cell--empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateISO = `${monthISO}-${String(d).padStart(2, "0")}`;
    const dayAbs = list.filter((a) => dateWithin(dateISO, a.startAt, a.endAt));
    const chips = dayAbs
      .map((a) => `<span class="cal-abs cal-abs--${absenceClass(a.type)}" title="${escapeAttr(`${a.driver} · ${a.type}`)}">${escapeHtml(a.driver)}</span>`)
      .join("");
    let attrs, extraCls;
    if (painting) {
      const on = !!paint.days[dateISO];
      attrs = ` data-action="ausencia-paint-day" data-date="${dateISO}"`;
      extraCls = ` cal-cell--paintable${on ? " cal-cell--painted" : ""}`;
    } else {
      attrs = dayAbs.length ? ` data-action="ausencia-day" data-date="${dateISO}"` : "";
      extraCls = dayAbs.length ? " cal-cell--has" : "";
    }
    cells.push(`<div class="cal-cell${dateISO === today ? " cal-cell--today" : ""}${extraCls}"${attrs}><span class="cal-day">${d}</span>${chips}</div>`);
  }

  const drivers = distinctFleetDrivers();
  const dirty = paintDirty(monthISO);
  const nDias = Object.keys(paint.days).length;
  const paintBar = `
    <div class="cal-paintbar${painting ? " cal-paintbar--on" : ""}">
      <label class="cal-paintbar__f">Marcar férias de:
        <select data-ausencia-paint="driver">
          <option value="">— escolher motorista —</option>
          ${drivers.map((dr) => `<option value="${escapeAttr(dr)}"${dr === paint.driver ? " selected" : ""}>${escapeHtml(dr)}</option>`).join("")}
        </select>
      </label>
      ${painting ? `<span class="cal-paintbar__hint">Clica nos dias para marcar/desmarcar — confirma na <strong>caixa vermelha</strong>.</span>` : ""}
    </div>`;

  // Caixa volante (flutuante, a vermelho) — só visível durante a marcação.
  const paintFloat = painting ? `
    <div class="cal-paint-float" role="dialog" aria-label="Marcação de férias">
      <div class="cal-paint-float__head">
        <span class="cal-paint-float__dot"></span>
        <span>A marcar <strong>${escapeHtml(paint.type)}</strong> — <strong>${escapeHtml(paint.driver)}</strong></span>
        <button class="cal-paint-float__x" type="button" data-action="ausencia-paint-cancel" aria-label="Fechar">✕</button>
      </div>
      <div class="cal-paint-float__body">
        <label class="cal-paint-float__f">Tipo
          <select data-ausencia-paint="type">${ABSENCE_TYPES.map((t) => `<option value="${escapeAttr(t)}"${normalizeText(t) === normalizeText(paint.type) ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select>
        </label>
        <span class="cal-paint-float__count"><strong>${nDias}</strong> dia(s) marcado(s)${dirty ? " · <em>por guardar</em>" : ""}</span>
      </div>
      <div class="cal-paint-float__actions">
        <button class="cal-paint-float__save" type="button" data-action="ausencia-paint-save"${dirty ? "" : " disabled"}>Guardar férias</button>
        <button class="cal-paint-float__cancel" type="button" data-action="ausencia-paint-cancel">${dirty ? "Cancelar" : "Fechar"}</button>
      </div>
    </div>` : "";

  return `
    <div class="cal-toolbar">
      <button class="ghost-button" type="button" data-action="ausencia-prev-month" aria-label="Mês anterior">‹</button>
      <strong class="cal-month">${escapeHtml(monthLabel)}</strong>
      <button class="ghost-button" type="button" data-action="ausencia-next-month" aria-label="Mês seguinte">›</button>
      <button class="link-button" type="button" data-action="ausencia-today">Hoje</button>
    </div>
    ${paintBar}
    <div class="cal-grid cal-grid--head">${weekdays.map((w) => `<div class="cal-head">${w}</div>`).join("")}</div>
    <div class="cal-grid${painting ? " cal-grid--painting" : ""}">${cells.join("")}</div>
    ${paintFloat}
  `;
}

// ── Edição rápida de férias no calendário (pintar dias) ──
function ausPaint() {
  if (!state.ausenciaPaint) state.ausenciaPaint = { driver: "", type: ABSENCE_TYPES[0], days: {} };
  return state.ausenciaPaint;
}
function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function newAusenciaId() {
  return `AUS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
// Dias (no mês) já ocupados por ausências do motorista+tipo — base da pintura.
function paintInitDays(driver, type, monthISO) {
  const days = {};
  if (!driver) return days;
  const { first, last } = monthBounds(monthISO);
  state.ausencias
    .filter((a) => a.driver === driver && normalizeText(a.type) === normalizeText(type) && a.startAt && a.endAt)
    .forEach((a) => {
      let cur = a.startAt < first ? first : a.startAt;
      const end = a.endAt > last ? last : a.endAt;
      let guard = 0;
      while (cur <= end && guard++ < 400) { days[cur] = true; cur = addDaysISO(cur, 1); }
    });
  return days;
}
function setPaintDriver(driver) {
  const monthISO = state.ausenciaMonth || currentMonthISO();
  const type = ausPaint().type || ABSENCE_TYPES[0];
  state.ausenciaPaint = { driver: driver || "", type, days: driver ? paintInitDays(driver, type, monthISO) : {} };
  saveState(); render();
}
function setPaintType(type) {
  const p = ausPaint();
  const monthISO = state.ausenciaMonth || currentMonthISO();
  const t = type || ABSENCE_TYPES[0];
  state.ausenciaPaint = { driver: p.driver || "", type: t, days: p.driver ? paintInitDays(p.driver, t, monthISO) : {} };
  saveState(); render();
}
function togglePaintDay(dateISO) {
  const p = ausPaint();
  if (!p.driver || !dateISO) return;
  if (p.days[dateISO]) delete p.days[dateISO]; else p.days[dateISO] = true;
  saveState(); render();
}
function cancelPaint() {
  state.ausenciaPaint = { driver: "", type: ABSENCE_TYPES[0], days: {} };
  saveState(); render();
}
function paintDirty(monthISO) {
  const p = ausPaint();
  if (!p.driver) return false;
  const orig = paintInitDays(p.driver, p.type, monthISO);
  return Object.keys(orig).sort().join(",") !== Object.keys(p.days).sort().join(",");
}
// Recalcula as ausências do motorista+tipo neste mês a partir dos dias pintados,
// preservando as partes que ficam fora do mês (recorta/divide quando necessário).
function reconcilePaint(driver, type, monthISO, paintedArr) {
  const { first, last } = monthBounds(monthISO);
  const painted = [...new Set(paintedArr)].filter((iso) => iso >= first && iso <= last).sort();
  const isSel = (a) => a && a.driver === driver && normalizeText(a.type) === normalizeText(type) && a.startAt && a.endAt;
  const newAus = [], toDelete = [], toPersist = [];
  state.ausencias.forEach((a) => {
    if (!isSel(a)) { newAus.push(a); return; }
    if (a.endAt < first || a.startAt > last) { newAus.push(a); return; } // fora do mês
    let touched = false;
    if (a.startAt < first) { const before = { ...a, endAt: addDaysISO(first, -1) }; newAus.push(before); toPersist.push(before); touched = true; }
    if (a.endAt > last) { const after = (a.startAt < first) ? { ...a, id: newAusenciaId(), startAt: addDaysISO(last, 1) } : { ...a, startAt: addDaysISO(last, 1) }; newAus.push(after); toPersist.push(after); touched = true; }
    if (!touched) toDelete.push(String(a.id)); // totalmente dentro do mês → substituída pela pintura
  });
  for (let i = 0; i < painted.length; i++) {
    const s = painted[i]; let e = s;
    while (i + 1 < painted.length && painted[i + 1] === addDaysISO(e, 1)) { e = painted[i + 1]; i++; }
    const item = { id: newAusenciaId(), driver, type, startAt: s, endAt: e, notes: "", createdAt: new Date().toISOString(), createdBy: (remoteConfig.operator || "Utilizador") };
    newAus.push(item); toPersist.push(item);
  }
  return { newAus, toDelete, toPersist };
}
async function savePaint() {
  const p = ausPaint();
  if (!p.driver) { showToast("Escolhe um motorista."); return; }
  const monthISO = state.ausenciaMonth || currentMonthISO();
  const { newAus, toDelete, toPersist } = reconcilePaint(p.driver, p.type, monthISO, Object.keys(p.days));
  state.ausencias = newAus;
  const monthLabel = new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric" }).format(new Date(`${monthISO}-01T00:00:00`));
  const auditEvent = { id: `AUS-paint-${Date.now()}`, breakdownId: "", equipment: "", plate: "", at: new Date().toISOString(), action: "Férias editadas no calendário", status: p.type, note: `${p.driver} · ${monthLabel} · ${Object.keys(p.days).length} dia(s)` };
  state.audit.unshift(auditEvent);
  state.ausenciaPaint = { driver: p.driver, type: p.type, days: paintInitDays(p.driver, p.type, monthISO) };
  saveState(); showToast("Férias guardadas."); render();
  await persistRemoteSafely(async () => {
    for (const id of toDelete) await deleteAusenciaRemote(id);
    for (const it of toPersist) await persistAusenciaRemote(it);
    await persistAuditRemote(auditEvent);
  });
}

// Responsável de logística de um motorista, deduzido da(s) sua(s) viatura(s).
function driverLogisticsResp(driver) {
  for (const v of fleetForDriver(driver)) {
    if (v.logisticsResp) return v.logisticsResp;
  }
  return "";
}

// Viaturas do motorista + os respetivos conjuntos (partner), sem duplicar.
function driverVehiclesWithConjunto(driver) {
  const own = fleetForDriver(driver);
  const seen = new Set();
  const out = [];
  own.forEach((f) => {
    const k = String(f.equipment);
    if (!seen.has(k)) { seen.add(k); out.push({ f, conjunto: false }); }
    if (f.partnerEquipment) {
      const p = state.fleet.find((x) => String(x.equipment) === String(f.partnerEquipment));
      if (p && !seen.has(String(p.equipment))) { seen.add(String(p.equipment)); out.push({ f: p, conjunto: true }); }
    }
  });
  return out;
}

function absencePlanCard(a) {
  const vehicles = driverVehiclesWithConjunto(a.driver);
  const equipHtml = vehicles.length
    ? vehicles.map(({ f, conjunto }) => {
        const dues = fleetDueList(f);
        const badges = dues.length
          ? dues.map((x) => `<span class="plan-due">${escapeHtml(x.label)} ${renderDueBadge(x.value)}</span>`).join("")
          : `<span class="muted">sem datas de manutenção</span>`;
        return `<div class="plan-equip"><strong>Equip. ${escapeHtml(f.equipment)}</strong> · ${escapeHtml(f.plate || "-")} <span class="muted">${escapeHtml(f.description || "")}</span>${conjunto ? ` <span class="plan-conjunto">🔗 conjunto</span>` : ""} <span class="plan-oficina">🔧 disponível p/ oficina</span><div class="plan-dues">${badges}</div></div>`;
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
}

function renderAusenciaPlanning(monthAbs, monthISO) {
  const label = new Intl.DateTimeFormat("pt-PT", { month: "long" }).format(new Date(`${monthISO}-01T00:00:00`));
  if (!monthAbs.length) {
    return `<div class="panel-sub"><h3>Janelas de manutenção</h3><p class="muted">Sem ausências em ${escapeHtml(label)}.</p></div>`;
  }
  // Agrupar as ausências por Responsável de Logística (derivado da viatura do motorista).
  const groups = new Map();
  const order = [];
  monthAbs.forEach((a) => {
    const resp = driverLogisticsResp(a.driver) || RESP_NENHUM;
    if (!groups.has(resp)) { groups.set(resp, []); order.push(resp); }
    groups.get(resp).push(a);
  });
  order.sort((x, y) => x === RESP_NENHUM ? 1 : y === RESP_NENHUM ? -1 : x.localeCompare(y, "pt"));
  const sections = order.map((resp) => `
      <div class="plan-group">
        <h4 class="plan-group__head">👤 ${escapeHtml(resp)} <span class="plan-group__n">${groups.get(resp).length}</span></h4>
        ${groups.get(resp).map(absencePlanCard).join("")}
      </div>`).join("");
  return `
    <div class="panel-sub">
      <h3>Janelas de manutenção durante ausências</h3>
      <p class="muted">Agrupadas por responsável de logística. Enquanto o motorista está ausente, a sua viatura e o respetivo conjunto (trator + reboque) ficam disponíveis para oficina.</p>
      ${sections}
    </div>`;
}

function ausenciaVehicleText(a) {
  const m = String(a.notes || "").match(/Paragem viatura:\s*(.+)$/i);
  return m ? m[1].trim() : "";
}

function ausenciaEquipKey(a) {
  const m = ausenciaVehicleText(a).match(/(\d{2,6})/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER; // sem viatura vai para o fim
}

function sortAusencias(list, key) {
  const arr = [...list];
  if (key === "driver") {
    arr.sort((a, b) => (a.driver || "").localeCompare(b.driver || "", "pt") || String(a.startAt).localeCompare(String(b.startAt)));
  } else if (key === "equipment") {
    arr.sort((a, b) => ausenciaEquipKey(a) - ausenciaEquipKey(b) || String(a.startAt).localeCompare(String(b.startAt)));
  } else {
    arr.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)) || (a.driver || "").localeCompare(b.driver || "", "pt"));
  }
  return arr;
}

function ausenciaSearchNorm(s) {
  return normalizeText(s).replace(/[^a-z0-9]/g, "");
}

function ausenciaListRow(a) {
  return `<tr>
    <td>${ausenciaDriverInput(a)}</td>
    <td class="muted">${escapeHtml(ausenciaDriverVehiclesText(a.driver))}</td>
    <td>${ausenciaTypeSelect(a)}</td>
    <td>${ausenciaDateInput(a, "startAt")}</td>
    <td>${ausenciaDateInput(a, "endAt")}</td>
    <td>${absenceDays(a)}</td>
    <td class="compact-cell">${ausenciaNotesInput(a)}</td>
    <td><button class="icon-button" type="button" data-action="delete-ausencia" data-id="${escapeAttr(a.id)}" title="Eliminar ausência"><span data-icon="trash"></span></button></td>
  </tr>`;
}

function renderAusenciaList(list) {
  if (!list.length) return `<div class="panel-sub"><p class="muted">Ainda não há ausências registadas.</p></div>`;
  const sortKey = state.filters.ausenciaSort || "date";
  const term = ausenciaSearchNorm(state.filters.ausenciaSearch || "");
  const filtered = term
    ? list.filter((a) => ausenciaSearchNorm(`${a.driver} ${a.type} ${a.notes} ${a.startAt} ${a.endAt}`).includes(term))
    : list;
  const sorted = sortAusencias(filtered, sortKey);
  return `
    <div class="panel-sub">
      <div class="panel-sub__head">
        <h3>Todas as ausências${term ? ` · ${sorted.length} resultado(s)` : ""}</h3>
        <div class="panel-sub__tools">
          ${searchFieldHtml("ausenciaSearch", "Pesquisar (matrícula, motorista, viatura…)", "ausencia-search")}
          <label class="sort-select">Ordenar por
            <select data-filter="ausenciaSort">
              <option value="date" ${sortKey === "date" ? "selected" : ""}>Data</option>
              <option value="equipment" ${sortKey === "equipment" ? "selected" : ""}>Equipamento</option>
              <option value="driver" ${sortKey === "driver" ? "selected" : ""}>Motorista</option>
            </select>
          </label>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Motorista</th><th>Viatura</th><th>Tipo</th><th>Início</th><th>Fim</th><th>Dias</th><th>Notas</th><th></th></tr></thead>
          <tbody>
            ${renderMonthGroups("ausencias", sorted, (a) => a.startAt, 8, ausenciaListRow, "ausência", "ausências", "Sem resultados para esta pesquisa.")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function shiftAusenciaMonth(delta) {
  const [y, m] = (state.ausenciaMonth || currentMonthISO()).split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.ausenciaMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  // Se estiver em modo pintura, re-sincroniza os dias para o novo mês (mantém o motorista).
  const p = ausPaint();
  if (p.driver) p.days = paintInitDays(p.driver, p.type, state.ausenciaMonth);
  saveState();
  render();
}

// Texto de identificação da viatura alocada ao motorista (+ conjunto) no modal de ausência.
function ausenciaVehiclePreviewHtml(driver) {
  if (!String(driver || "").trim()) return `<span class="muted">Escolhe o motorista para ver a viatura alocada.</span>`;
  const vehicles = driverVehiclesWithConjunto(driver);
  if (!vehicles.length) return `<span class="muted">Sem viatura associada a este motorista.</span>`;
  const parts = vehicles.map(({ f, conjunto }) => `${conjunto ? "🔗 " : ""}${f.plate || "—"} (Equip. ${f.equipment}${conjunto ? " · conjunto" : ""})`);
  const resp = driverLogisticsResp(driver);
  return `🚚 Alocado a: <strong>${parts.map(escapeHtml).join("</strong> · <strong>")}</strong>${resp ? ` · Resp.: <strong>${escapeHtml(resp)}</strong>` : ""}<br><span class="muted">O conjunto fica disponível para oficina durante a ausência.</span>`;
}

function openAusenciaModal() {
  const drivers = distinctFleetDrivers();
  const body = `
    <form class="modal-form" data-form="new-ausencia">
      <label class="field field--wide">Motorista *
        <input id="ausencia-driver" name="driver" list="ausencia-drivers" required placeholder="Nome do motorista" autocomplete="off">
        <datalist id="ausencia-drivers">${drivers.map((d) => `<option value="${escapeAttr(d)}"></option>`).join("")}</datalist>
      </label>
      <p class="ausencia-veh-preview" id="ausencia-veh-preview">${ausenciaVehiclePreviewHtml("")}</p>
      <div class="field-row">
        <label class="field">Tipo<select name="type">${ABSENCE_TYPES.map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join("")}</select></label>
        <label class="field">Início *<input type="date" name="startAt" required></label>
        <label class="field">Fim *<input type="date" name="endAt" required></label>
      </div>
      <label class="field field--wide">Notas<input name="notes" placeholder="Opcional"></label>
      <div class="modal-form__actions">
        <button type="button" class="ghost-button" data-action="close-modal">Cancelar</button>
        <button type="submit" class="primary-button"><span data-icon="plus"></span><span>Registar ausência</span></button>
      </div>
    </form>`;
  openModal("Nova ausência", body);
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
  closeModal();
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
  refreshAusenciaModal();
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
    ["wheelHubReviewAt", "Cubos de roda"],
    ["revisionAt", "Revisão"]
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

// Responsável de logística de uma ocorrência, via a viatura (equipamento/matrícula).
function breakdownResp(b) {
  const f = (b.equipment && state.fleet.find((x) => String(x.equipment) === String(b.equipment)))
    || (b.plate && findFleetByPlate(b.plate)) || null;
  return f && f.logisticsResp ? f.logisticsResp : "";
}

function getFilteredBreakdowns(activeOnly) {
  const search = normalizeText(state.filters.search);
  let list = state.breakdowns.filter((item) => !activeOnly || item.status !== "Concluido");
  const statusF = filterArray("status");
  const situationF = filterArray("situation");
  const respLogF = filterArray("respLog");
  const companyF = filterArray("company");
  if (statusF.length) list = list.filter((item) => statusF.includes(item.status));
  if (situationF.length) list = list.filter((item) => situationF.includes(item.situation));
  if (respLogF.length) list = list.filter((item) => respLogF.includes(breakdownResp(item)));
  if (companyF.length) list = list.filter((item) => companyF.includes(getBreakdownCompany(item)));
  if (state.filters.workshopType) list = list.filter((item) => normalizeText(item.workshopType) === normalizeText(state.filters.workshopType));
  if (state.filters.semPrevisao) list = list.filter((item) => item.status !== "Concluido" && item.situation === "Em oficina" && !item.expectedExitAt);
  if (state.filters.occurrenceStale) list = list.filter((item) => {
    if (item.status === "Concluido") return false;
    const ref = (item.lastNoteAt || item.reportedAt || "").slice(0, 10);
    return ref && daysBetween(ref, todayISO()) > 7;
  });
  if (search) {
    list = list.filter((item) => {
      const haystack = normalizeText(`${item.id} ${item.equipment} ${item.plate} ${item.type} ${item.status} ${item.situation} ${item.workshop} ${item.description} ${item.lastNote} ${formatAttachmentNames(item.attachments)}`);
      return haystack.includes(search);
    });
  }
  return sortedBreakdowns(list);
}

function getFilteredFleet() {
  const nohyphen = (s) => normalizeText(s).replace(/[-\s]/g, "");
  const search = nohyphen(state.filters.fleetSearch);
  const scope = state.filters.fleetScope || "";
  return state.fleet.filter((item) => {
    if (scope === "ativas" && normalizeText(item.status) !== "ativa") return false;
    if (scope === "inspecao-vencida" && !(item.inspectionAt && !isFleetNA(item.inspectionAt) && daysUntil(item.inspectionAt) < 0)) return false;
    if (scope === "tacografo-vencido" && !(item.tachographAt && !isFleetNA(item.tachographAt) && daysUntil(item.tachographAt) < 0)) return false;
    // Pesquisa tolerante ao hífen (BE09MB encontra BE-09-MB e vice-versa).
    const haystack = nohyphen(`${item.equipment} ${item.plate} ${item.description} ${item.brand} ${item.status} ${item.fleetCompany}`);
    return !search || haystack.includes(search);
  });
}

const AUDIT_TYPES = [
  ["", "Todas"],
  ["avaria", "Avarias"],
  ["frota", "Frota"],
  ["oficina", "Oficina"],
  ["reuniao", "Reuniões"],
  ["vistoria", "Vistorias"],
  ["ausencia", "Ausências"]
];

const AUDIT_PERIODS = [
  ["", "Sempre"],
  ["today", "Hoje"],
  ["week", "Esta semana"],
  ["month", "Este mês"],
  ["year", "Este ano"]
];

function auditCategory(ev) {
  const id = String(ev.id || "");
  const action = ev.action || "";
  const note = ev.note || "";
  if (id.startsWith("REUNIAO-") || action.startsWith("Reunião")) return "reuniao";
  if (id.startsWith("VISTORIA-") || action.startsWith("Vistoria:")) return "vistoria";
  if (id.startsWith("AUS-") || /aus[êe]ncia/i.test(action)) return "ausencia";
  if (action.startsWith("Frota: Oficina") || /\boficina\b|pe[çc]as/i.test(`${action} ${note}`)) return "oficina";
  if (id.startsWith("FROTA-") || action.startsWith("Frota:")) return "frota";
  return "avaria";
}

// Eventos das reuniões (notas, tarefas, conclusões) trazidos para o Rastreio.
function meetingAuditEntries() {
  const out = [];
  (state.meetings || []).forEach((m) => {
    const base = m.startedAt || m.endedAt || "";
    (m.events || []).forEach((e, i) => {
      const label = e.type === "note" ? "Nota" : e.type === "task" ? "Tarefa"
        : e.type === "close" ? "Concluída" : e.type === "reopen" ? "Reaberta"
        : e.type === "update" ? "Atualização" : (e.type || "Evento");
      out.push({
        id: `REUNIAO-${m.id}-${i}`,
        breakdownId: e.breakdownId || "",
        equipment: e.equipment || "",
        plate: e.plate || "",
        at: e.at || base || "",
        action: `Reunião · ${label}`,
        status: e.status || "",
        note: e.summary || e.text || ""
      });
    });
  });
  return out;
}

function allAuditEvents() {
  return state.audit.concat(meetingAuditEntries());
}

function auditInPeriod(ev, period) {
  if (!period) return true;
  const at = (ev.at || "").slice(0, 10);
  if (!at) return false;
  const today = todayISO();
  if (period === "today") return at === today;
  if (period === "year") return at.slice(0, 4) === today.slice(0, 4);
  if (period === "month") return at.slice(0, 7) === today.slice(0, 7);
  if (period === "week") {
    const d = new Date(`${today}T00:00:00`);
    const dow = (d.getDay() + 6) % 7; // 0 = segunda-feira
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);
    const mondayISO = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
    return at >= mondayISO && at <= today;
  }
  return true;
}

function getFilteredAudit() {
  const search = normalizeText(state.filters.auditSearch);
  const type = state.filters.auditType || "";
  const period = state.filters.auditPeriod || "";
  return allAuditEvents()
    .filter((item) => {
      if (type && auditCategory(item) !== type) return false;
      if (period && !auditInPeriod(item, period)) return false;
      const haystack = normalizeText(`${item.breakdownId} ${item.equipment} ${item.plate} ${item.action} ${item.note}`);
      return !search || haystack.includes(search);
    })
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
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

function resetBrowseFilters() {
  Object.assign(state.filters, {
    search: "", status: [], situation: [], type: [], respLog: [], company: [],
    workshopType: "", semPrevisao: false, occurrenceStale: false, occurrenceStage: "",
    fleetSearch: "", fleetScope: "",
    auditSearch: "", auditType: "", auditPeriod: "",
    entidadeSearch: "", entidadeCategoria: "",
    ausenciaSearch: "", ausenciaResp: "", vistoriaType: "", vistoriaResult: ""
  });
}

function setFilter(name, value) {
  state.filters[name] = value;
  saveState();
  render(`[data-filter="${name}"]`);
}

// Campo de pesquisa com botão "Limpar" explícito (aparece só quando há texto).
function searchFieldHtml(key, placeholder, inputClass = "") {
  const val = state.filters[key] || "";
  const cls = inputClass ? ` class="${escapeAttr(inputClass)}"` : "";
  return `
    <div class="search-field">
      <input type="search"${cls} data-filter="${escapeAttr(key)}" value="${escapeAttr(val)}" placeholder="${escapeAttr(placeholder)}">
      ${val ? `<button type="button" class="search-clear" data-action="clear-filter" data-filter="${escapeAttr(key)}" title="Limpar pesquisa">✕ Limpar</button>` : ""}
    </div>`;
}

function toggleMultiFilter(name, value) {
  const current = filterArray(name);
  state.filters[name] = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
  openFilterMenu = name;
  saveState();
  render();
}

function clearMultiFilter(name) {
  state.filters[name] = [];
  openFilterMenu = name;
  saveState();
  render();
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

// Resolve a viatura de um evento (por equipamento, senão por matrícula) e o respetivo Resp. Logística.
function eventFleet(e) {
  if (!e) return null;
  if (e.equipment) {
    const byEq = (state.fleet || []).find((f) => String(f.equipment) === String(e.equipment));
    if (byEq) return byEq;
  }
  if (e.plate) {
    const np = normalizePlate(e.plate);
    return (state.fleet || []).find((f) => normalizePlate(f.plate) === np) || null;
  }
  return null;
}
function eventResp(e) {
  const f = eventFleet(e);
  return (f && f.logisticsResp) ? f.logisticsResp : "";
}

const RESP_NENHUM = "— Sem responsável atribuído —";
// Agrupa os eventos de uma reunião por Responsável de Logística e, dentro de cada um, por viatura.
function groupMeetingEventsByResp(events) {
  const respOrder = [];
  const respMap = new Map(); // resp -> { email, vehicles: Map(key -> {label, events}) }
  (events || []).forEach((e) => {
    const resp = eventResp(e) || RESP_NENHUM;
    if (!respMap.has(resp)) {
      const ent = resp === RESP_NENHUM ? null : respLogEntidadeByName(resp);
      respMap.set(resp, { email: ent ? (ent.email || "") : "", vehicles: new Map() });
      respOrder.push(resp);
    }
    const bucket = respMap.get(resp);
    const key = e.plate ? normalizePlate(e.plate) : (e.equipment ? `eq${e.equipment}` : "geral");
    const label = e.plate
      ? `${e.plate}${e.equipment ? ` · Equip. ${e.equipment}` : ""}`
      : (e.equipment ? `Equip. ${e.equipment}` : "Geral (sem viatura)");
    if (!bucket.vehicles.has(key)) bucket.vehicles.set(key, { label, events: [] });
    bucket.vehicles.get(key).events.push(e);
  });
  respOrder.sort((a, b) => {
    if (a === RESP_NENHUM) return 1;
    if (b === RESP_NENHUM) return -1;
    return a.localeCompare(b, "pt");
  });
  return respOrder.map((resp) => {
    const bucket = respMap.get(resp);
    const vehicles = [...bucket.vehicles.values()].sort((a, b) => a.label.localeCompare(b.label, "pt", { numeric: true }));
    vehicles.forEach((v) => v.events.sort((a, b) => String(a.at).localeCompare(String(b.at))));
    return { resp, email: bucket.email, vehicles };
  });
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
        columns: ["Resp. Logística", "Hora", "Equip.", "Matrícula", "Descrição"],
        rows: novas.map((e) => [eventResp(e) || "—", formatTimeOnly(e.at), String(e.equipment || ""), e.plate || "", e.summary || ""])
      },
      {
        title: "Atualizações",
        columns: ["Resp. Logística", "Hora", "Equip.", "Matrícula", "Ação", "Resumo"],
        rows: updates.map((e) => [eventResp(e) || "—", formatTimeOnly(e.at), String(e.equipment || ""), e.plate || "", meetingEventLabel(e.type), e.summary || ""])
      },
      {
        title: "Tarefas",
        columns: ["Resp. Logística", "Hora", "Estado", "Matrícula", "Equip.", "Tarefa"],
        rows: tarefas.map((e) => [eventResp(e) || "—", formatTimeOnly(e.at), e.done ? "Concluída" : "Pendente", e.plate || "", String(e.equipment || ""), e.summary || ""])
      },
      {
        title: "Notas",
        columns: ["Resp. Logística", "Hora", "Matrícula", "Equip.", "Nota / observação"],
        rows: notas.map((e) => [eventResp(e) || "—", formatTimeOnly(e.at), e.plate || "", String(e.equipment || ""), e.summary || ""])
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
  const groups = groupMeetingEventsByResp(ev);
  const heading = (t) => `${t}\n${"─".repeat(Math.min(60, t.length))}`;
  const lines = [];
  lines.push(heading(`Relatório de Reunião — ${formatDate((meeting.startedAt || "").slice(0, 10))}`));
  if (meeting.endedAt) lines.push(`Duração: ${meeting.durationMin} min`);
  lines.push(`Operador: ${meeting.operator || "-"}`);
  lines.push(`Total de registos: ${ev.length}`);
  lines.push("");
  if (!groups.length) { lines.push("(sem registos)"); return lines.join("\n"); }
  groups.forEach((g) => {
    lines.push(heading(`👤 ${g.resp}${g.email ? ` <${g.email}>` : ""}`));
    g.vehicles.forEach((v) => {
      lines.push(`  ▸ ${v.label}`);
      v.events.forEach((e) => {
        const done = e.type === "task" ? (e.done ? "[x] " : "[ ] ") : "";
        lines.push(`      • ${done}${meetingEventLabel(e.type)} (${formatTimeOnly(e.at)}): ${e.summary || "-"}`);
      });
    });
    lines.push("");
  });
  return lines.join("\n").trimEnd();
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
  const groups = groupMeetingEventsByResp(ev);
  const dia = escapeHtml(formatDate((meeting.startedAt || "").slice(0, 10)));
  const head = `
    <div style="font-family:Arial,sans-serif;color:#111827">
      <h2 style="margin:0 0 4px">Relatório de reunião — ${dia}</h2>
      <p style="color:#6b7280;margin:0 0 12px">
        ${escapeHtml(formatTimeOnly(meeting.startedAt))}${meeting.endedAt ? ` – ${escapeHtml(formatTimeOnly(meeting.endedAt))} · ${meeting.durationMin} min` : " (a decorrer)"} · ${escapeHtml(meeting.operator || "-")} · ${ev.length} registos
      </p>`;
  if (!groups.length) return `${head}<p>(sem registos)</p></div>`;
  const sections = groups.map((g) => {
    const bodyRows = g.vehicles.map((v) => v.events.map((e, i) => `
        <tr>
          ${i === 0 ? `<td rowspan="${v.events.length}" style="vertical-align:top;font-weight:600;background:#f9fafb">${escapeHtml(v.label)}</td>` : ""}
          <td style="white-space:nowrap">${escapeHtml(formatTimeOnly(e.at))}</td>
          <td style="white-space:nowrap">${escapeHtml(meetingEventLabel(e.type))}${e.type === "task" ? (e.done ? " ✅" : " ⬜") : ""}</td>
          <td>${escapeHtml(e.summary || "-")}</td>
        </tr>`).join("")).join("");
    return `
      <h3 style="margin:18px 0 6px;padding:6px 10px;background:#0f766e;color:#fff;border-radius:4px">
        👤 ${escapeHtml(g.resp)}${g.email ? ` <span style="font-weight:400;font-size:12px">&lt;${escapeHtml(g.email)}&gt;</span>` : ""}
      </h3>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%">
        <thead><tr style="background:#e8f3f1"><th>Viatura</th><th>Hora</th><th>Tipo</th><th>Registo</th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>`;
  }).join("");
  return `${head}${sections}</div>`;
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
          "Dias cubos roda",
          "Data revisão (trator)",
          "Dias revisão"
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
          formatDueForExport(item.wheelHubReviewAt),
          isTratorFleet(item) ? fleetDateForExport(item.revisionAt) : "—",
          isTratorFleet(item) ? formatDueForExport(item.revisionAt) : "—"
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
