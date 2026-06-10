const TRELLO_API_BASE = "https://api.trello.com/1";
const TRELLO_TOKEN_STORAGE_KEY = "avarias-trello-token";
const trelloSettings = (window.AVARIAS_REMOTE_CONFIG || {}).trello || {};
let trelloDirectoryPromise = null;

// O token nunca vive no código público: ou vem do config (desaconselhado) ou do
// localStorage deste dispositivo, onde é guardado após ser pedido uma vez.
function getTrelloToken() {
  if (trelloSettings.token) return trelloSettings.token;
  try {
    return localStorage.getItem(TRELLO_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function trelloEnabled() {
  return Boolean(trelloSettings.key && getTrelloToken());
}

function requestTrelloToken() {
  const token = window.prompt(
    "Para ativar a sincronização com o Trello neste dispositivo, cole aqui o token de autorização (fica guardado apenas neste browser):"
  );
  if (!token || !token.trim()) return false;
  try {
    localStorage.setItem(TRELLO_TOKEN_STORAGE_KEY, token.trim());
  } catch {
    return false;
  }
  trelloDirectoryPromise = null;
  return true;
}

async function trelloFetch(path, { method = "GET", params = {} } = {}) {
  const query = new URLSearchParams({
    ...params,
    key: trelloSettings.key,
    token: getTrelloToken()
  });
  const response = await fetch(`${TRELLO_API_BASE}${path}?${query}`, { method });
  if (!response.ok) {
    throw new Error(`Trello ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// Directory de quadros e listas da conta, carregado uma vez por sessão.
async function ensureTrelloDirectory() {
  if (!trelloDirectoryPromise) {
    trelloDirectoryPromise = trelloFetch("/members/me/boards", {
      params: { filter: "open", fields: "name", lists: "open", list_fields: "name" }
    }).catch((error) => {
      trelloDirectoryPromise = null;
      throw error;
    });
  }
  return trelloDirectoryPromise;
}

// As listas das viaturas seguem o padrão "003 B | C0815 | L-170277 | Marca | Tipo | Data".
// A correspondência é feita pela matrícula e, em alternativa, pelo n.º de equipamento
// (segmento tipo "C0815"/"T0865": letras opcionais + zeros à esquerda + número).
function findTrelloVehicleList(boards, breakdown) {
  const plate = normalizePlate(breakdown.plate);
  const equipment = String(breakdown.equipment ?? "").trim();

  for (const board of boards) {
    for (const list of board.lists || []) {
      if (plate && normalizePlate(list.name).includes(plate)) {
        return { board, list };
      }
      if (equipment && listSegmentMatchesEquipment(list.name, equipment)) {
        return { board, list };
      }
    }
  }
  return null;
}

function listSegmentMatchesEquipment(listName, equipment) {
  return String(listName).split("|").some((segment) => {
    const clean = normalizeText(segment).replace(/[^a-z0-9]/g, "");
    const match = clean.match(/^[a-z]{0,2}0*(\d+)$/);
    return match && match[1] === String(Number(equipment));
  });
}

function trelloCardMarker(breakdownId) {
  return `**Avaria:** ${breakdownId}`;
}

function trelloCardTitle(breakdown) {
  const status = breakdown.status === "Concluido" ? "Concluída" : breakdown.status;
  return `🔧 Avaria ${breakdown.type || ""} · ${status}${breakdown.situation ? ` · ${breakdown.situation}` : ""}`;
}

function trelloCardDesc(breakdown) {
  return [
    trelloCardMarker(breakdown.id),
    `**Equipamento:** ${breakdown.equipment || "-"} · ${breakdown.plate || "-"}`,
    `**Estado:** ${breakdown.status}${breakdown.situation ? ` · ${breakdown.situation}` : ""}`,
    `**Data avaria:** ${breakdown.reportedAt || "-"}`,
    `**Entrada oficina:** ${breakdown.workshopEntryAt || "-"}`,
    `**Prev. saída:** ${breakdown.expectedExitAt || "-"}`,
    `**Oficina:** ${breakdown.workshop || breakdown.workshopType || "-"}`,
    `**Motorista:** ${breakdown.driver || "-"}`,
    "",
    breakdown.description || ""
  ].join("\n");
}

async function findTrelloCardOnBoard(boardId, breakdownId) {
  const cards = await trelloFetch(`/boards/${boardId}/cards`, { params: { fields: "name,desc,idList" } });
  return cards.find((card) => card.desc.includes(trelloCardMarker(breakdownId))) || null;
}

async function upsertTrelloCard(target, breakdown, existingCard, note) {
  const params = {
    name: trelloCardTitle(breakdown),
    desc: trelloCardDesc(breakdown),
    due: breakdown.expectedExitAt ? `${breakdown.expectedExitAt}T17:00:00.000Z` : "null",
    dueComplete: breakdown.status === "Concluido" ? "true" : "false"
  };

  let card = existingCard;
  if (!card) {
    card = await trelloFetch("/cards", {
      method: "POST",
      params: { ...params, idList: target.list.id, pos: "top" }
    });
  } else {
    // Não mexe na lista de um cartão existente, para respeitar movimentos manuais no Trello.
    await trelloFetch(`/cards/${card.id}`, { method: "PUT", params });
  }

  if (note) {
    await trelloFetch(`/cards/${card.id}/actions/comments`, { method: "POST", params: { text: note } });
  }
  return card;
}

async function syncBreakdownToTrello(breakdown, note) {
  if (!trelloEnabled() || !breakdown) return;
  try {
    const boards = await ensureTrelloDirectory();
    const target = findTrelloVehicleList(boards, breakdown);
    if (!target) {
      showToast(`Trello: sem lista para equip. ${breakdown.equipment || "-"} (${breakdown.plate || "-"}).`);
      return;
    }
    const existing = await findTrelloCardOnBoard(target.board.id, breakdown.id);
    await upsertTrelloCard(target, breakdown, existing, note || "");
  } catch (error) {
    console.error(error);
    showToast("Sincronização com o Trello falhou.");
  }
}

async function syncAllBreakdownsToTrello() {
  if (!trelloEnabled() && !requestTrelloToken()) {
    showToast("Sincronização com o Trello não ativada neste dispositivo.");
    return;
  }
  try {
    showToast("A sincronizar com o Trello…");
    const boards = await ensureTrelloDirectory();
    const boardCards = new Map();
    const open = state.breakdowns.filter((item) => item.status !== "Concluido");
    let synced = 0;
    const unmatched = [];

    for (const breakdown of open) {
      const target = findTrelloVehicleList(boards, breakdown);
      if (!target) {
        unmatched.push(`${breakdown.equipment || "-"} (${breakdown.plate || "-"})`);
        continue;
      }
      if (!boardCards.has(target.board.id)) {
        boardCards.set(target.board.id, await trelloFetch(`/boards/${target.board.id}/cards`, { params: { fields: "name,desc,idList" } }));
      }
      const cards = boardCards.get(target.board.id);
      const existing = cards.find((card) => card.desc.includes(trelloCardMarker(breakdown.id))) || null;
      await upsertTrelloCard(target, breakdown, existing, "");
      synced += 1;
    }

    if (unmatched.length) {
      console.warn("Avarias sem lista no Trello:", unmatched);
      showToast(`Trello: ${synced} sincronizadas, ${unmatched.length} sem lista de viatura.`);
    } else {
      showToast(`Trello sincronizado: ${synced} avarias abertas.`);
    }
  } catch (error) {
    console.error(error);
    showToast("Sincronização com o Trello falhou.");
  }
}

if (trelloSettings.key) {
  document.querySelector("#trello-sync-button")?.removeAttribute("hidden");
}
