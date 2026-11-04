// Texts of the start card of an agent cell (1.1.5, CellStartCard.tsx). English, German, Spanish, French and Portuguese;
// Polish uses the source message (the key). Placeholders must match across a row.
export const startScreenMessages = {
  'Uruchamianie {name}…': ['Starting {name}…', '{name} wird gestartet…', 'Iniciando {name}…', 'Démarrage de {name}…', 'A iniciar {name}…'],
  'Wznawianie rozmowy': ['Resuming the conversation', 'Gespräch wird fortgesetzt', 'Reanudando la conversación', 'Reprise de la conversation', 'A retomar a conversa'],
  'Nie udało się uruchomić {name}': ['{name} could not start', '{name} konnte nicht gestartet werden', 'No se pudo iniciar {name}', 'Impossible de démarrer {name}', 'Não foi possível iniciar {name}'],
  'Pokaż terminal': ['Show terminal', 'Terminal anzeigen', 'Mostrar terminal', 'Afficher le terminal', 'Mostrar terminal'],
  'Kopiuj błąd': ['Copy error', 'Fehler kopieren', 'Copiar error', 'Copier l’erreur', 'Copiar erro'],
  'Ostatnie polecenia / wyjście': ['Recent commands / output', 'Letzte Befehle / Ausgabe', 'Comandos recientes / salida', 'Commandes récentes / sortie', 'Comandos recentes / saída'],
} as const satisfies Record<string, readonly [string, string, string, string, string]>;
