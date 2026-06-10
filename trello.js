const TRELLO_API_BASE = "https://api.trello.com/1";
const TRELLO_LIST_NAMES = [
  "Aguarda entrada na oficina",
  "Aguarda peças",
  "Em oficina",
  "Agendado",
  "Pode circular",
  "Concluído"
];
const trelloSettings = (window.AVARIAS_REMOTE_CONFIG || {}).trello || {};
let trelloBoardContext = null;
let trelloBoardPromise = null;

function trelloEnabled() {
  return Boolean(trelloSettings.key && trelloSettings.token);
}

async function trelloFetch(path, { method = "GET", params = {} } = {}) {
  const query = new URLSearchParams({
    ...params,
    key: trelloSettings.key,
    token: trelloSettings.token
  });
  const response = await fetch(`${TRELLO_API_BASE}${path}?${query}`, { method });
  if (!response.ok) {
    throw new Error(`Trello ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function ensureTrelloContext() {
  if (trelloBoardContext) return trelloBoardContext;
  if (!trelloBoardPromise) {
    trelloBoardPromise = (async () => {
      const boardName = trelloSettings.boardName || "Gestão de Avarias";
      const boards = await trelloFetch("/members/me/boards", { params: { fields: "name", filter: "open" } });
      let board = boards.find((item) => item.name === boardName);
      if (!board) {
        board = await trelloFetch("/boards", { method: "POST", params: { name: boardName, defaultLists: "false" } });
      }
      const existingLists = await trelloFetch(`/boards/${board.id}/lists`, { params: { fields: "name" } });
      const lists = {};
      for (const name of TRELLO_LIST_NAMES) {
        let list = existingLists.find((item) => item.name === name);
        if (!list) {
          list = await trelloFetch("/lists", { method: "POST", params: { name, idBoard: board.id, pos: "bottom" } });
        }
        lists[name] = list.id;
      }
      trelloBoardContext = { boardId: board.id, lists };
      return trelloBoardContext;
    })().catch((error) => {
      trelloBoardPromise = null;
      throw error;
    });
  }
  return trelloBoardPromise;
}

function trelloListNameFor(breakdown) {
  if (breakdown.status === "Concluido") return "Concluído";
  if (breakdown.situation && TRELLO_LIST_NAMES.includes(breakdown.situation)) return breakdown.situation;
  if (breakdown.status === "Agendado") return "Agendado";
  if (breakdown.status === "Pode circular") return "Pode circular";
  return "Aguarda entrada na oficina";
}

function trelloCardTitle(breakdown) {
  return `Equip. ${breakdown.equipment || "-"} · ${breakdown.plate || "-"} · ${breakdown.type || "Avaria"}`;
}

function trelloCardDesc(breakdown) {
  return [
    `**Avaria:** ${breakdown.id}`,
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

function trelloCardMarker(breakdownId) {
  return `**Avaria:** ${breakdownId}`;
}

async function fetchTrelloBoardCards(context) {
  return trelloFetch(`/boards/${context.boardId}/cards`, { params: { fields: "name,desc" } });
}

async function upsertTrelloCard(context, breakdown, existingCard, note) {
  const params = {
    name: trelloCardTitle(breakdown),
    desc: trelloCardDesc(breakdown),
    idList: context.lists[trelloListNameFor(breakdown)],
    due: breakdown.expectedExitAt ? `${breakdown.expectedExitAt}T17:00:00.000Z` : "null",
    dueComplete: breakdown.status === "Concluido" ? "true" : "false"
  };

  let card = existingCard;
  if (!card) {
    card = await trelloFetch("/cards", { method: "POST", params: { ...params, pos: "top" } });
  } else {
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
    const context = await ensureTrelloContext();
    const cards = await fetchTrelloBoardCards(context);
    const existing = cards.find((card) => card.desc.includes(trelloCardMarker(breakdown.id))) || null;
    await upsertTrelloCard(context, breakdown, existing, note || "");
  } catch (error) {
    console.error(error);
    showToast("Sincronização com o Trello falhou.");
  }
}

async function syncAllBreakdownsToTrello() {
  if (!trelloEnabled()) {
    showToast("Trello não configurado (falta o token em config.js).");
    return;
  }
  try {
    showToast("A sincronizar com o Trello…");
    const context = await ensureTrelloContext();
    const cards = await fetchTrelloBoardCards(context);
    const open = state.breakdowns.filter((item) => item.status !== "Concluido");
    for (const breakdown of open) {
      const existing = cards.find((card) => card.desc.includes(trelloCardMarker(breakdown.id))) || null;
      await upsertTrelloCard(context, breakdown, existing, "");
    }
    showToast(`Trello sincronizado: ${open.length} avarias abertas.`);
  } catch (error) {
    console.error(error);
    showToast("Sincronização com o Trello falhou.");
  }
}

if (trelloEnabled()) {
  document.querySelector("#trello-sync-button")?.removeAttribute("hidden");
}
