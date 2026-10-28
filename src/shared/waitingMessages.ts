// "Czeka na Ciebie" (1.0.9): the list of cells that need the user (shared/waiting.ts, WaitingPanel.tsx).
// Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const waitingMessages = {
  'Czeka na Ciebie': ['Waiting for you', 'Wartet auf dich', 'Esperándote', 'Vous attend', 'À sua espera'],
  'Czeka na Ciebie: {n}': ['Waiting for you: {n}', 'Wartet auf dich: {n}', 'Esperándote: {n}', 'Vous attend : {n}', 'À sua espera: {n}'],
  'skończył, nieprzeczytane': ['finished, not seen yet', 'fertig, noch nicht gesehen', 'terminó, sin ver', 'terminé, pas encore vu', 'terminou, ainda não visto'],
  'teraz': ['now', 'jetzt', 'ahora', 'maintenant', 'agora'],
  '{n} min': ['{n} min', '{n} Min.', '{n} min', '{n} min', '{n} min'],
  '{n} godz.': ['{n} h', '{n} Std.', '{n} h', '{n} h', '{n} h'],
  '{n} d': ['{n} d', '{n} T.', '{n} d', '{n} j', '{n} d'],
  'Czeka od {time}': ['Waiting since {time}', 'Wartet seit {time}', 'Esperando desde las {time}', 'Attend depuis {time}', 'À espera desde as {time}'],
  'Tu pojawią się komórki, które pytają, proszą o zgodę, zgłosiły błąd albo skończyły pracę i czekają, aż do nich zajrzysz.': [
    'Cells that ask something, need a permission, report an error or finished a turn you have not looked at yet show up here.',
    'Hier erscheinen Zellen, die etwas fragen, eine Erlaubnis brauchen, einen Fehler melden oder eine Runde beendet haben, die du noch nicht angesehen hast.',
    'Aquí aparecen las celdas que preguntan algo, piden permiso, informan de un error o terminaron un turno que aún no has visto.',
    'Ici apparaissent les cellules qui posent une question, demandent une autorisation, signalent une erreur ou ont terminé un tour que vous n’avez pas encore vu.',
    'Aqui aparecem as células que perguntam algo, pedem permissão, comunicam um erro ou terminaram um turno que ainda não viu.',
  ],
  'Ukryj wyciszone': ['Hide muted', 'Stummgeschaltete ausblenden', 'Ocultar silenciadas', 'Masquer les cellules muettes', 'Ocultar silenciadas'],
  'Komórki z wyciszonymi alertami nie są liczone w plakietce.': [
    'Cells with muted alerts are not counted in the badge.',
    'Zellen mit stummgeschalteten Alarmen werden im Abzeichen nicht mitgezählt.',
    'Las celdas con alertas silenciadas no cuentan en la insignia.',
    'Les cellules aux alertes coupées ne sont pas comptées dans le badge.',
    'As células com alertas silenciados não contam no distintivo.',
  ],
  'w osobnym oknie': ['in its own window', 'in eigenem Fenster', 'en su propia ventana', 'dans sa propre fenêtre', 'na sua própria janela'],
  'Następna komórka, która czeka na Ciebie': ['Next cell waiting for you', 'Nächste Zelle, die auf dich wartet', 'Siguiente celda que te espera', 'Cellule suivante qui vous attend', 'Próxima célula à sua espera'],
  'Poprzednia komórka, która czeka na Ciebie': ['Previous cell waiting for you', 'Vorherige Zelle, die auf dich wartet', 'Celda anterior que te espera', 'Cellule précédente qui vous attend', 'Célula anterior à sua espera'],
  'Czeka na Ciebie: pokaż listę': ['Waiting for you: show the list', 'Wartet auf dich: Liste anzeigen', 'Esperándote: mostrar la lista', 'Vous attend : afficher la liste', 'À sua espera: mostrar a lista'],
  'Nic na Ciebie nie czeka.': ['Nothing is waiting for you.', 'Nichts wartet auf dich.', 'Nada te está esperando.', 'Rien ne vous attend.', 'Nada está à sua espera.'],
} as const;
