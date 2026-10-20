// Texts of the SSH terminal themes (Settings > SSH, host form). Each row: English, German, Spanish, French, Portuguese. Polish is the key.
// Theme names are product names (shared/sshThemes.ts) and are not translated.
export const sshThemeMessages = {
  'Motyw terminala SSH': ['SSH terminal theme', 'SSH-Terminal-Design', 'Tema del terminal SSH', 'Thème du terminal SSH', 'Tema do terminal SSH'],
  'Kolory terminali w komórkach SSH. Zmiana działa od razu, także w otwartych sesjach. Terminale lokalne i agenci zachowują wygląd aplikacji, a każdy host może mieć własny motyw w swoich ustawieniach.': [
    'Colours of the terminals in SSH cells. A change applies at once, open sessions included. Local terminals and agents keep the app look, and each host can have its own theme in its settings.',
    'Farben der Terminals in SSH-Zellen. Eine Änderung gilt sofort, auch für offene Sitzungen. Lokale Terminals und Agenten behalten das Aussehen der App, und jeder Host kann in seinen Einstellungen ein eigenes Design haben.',
    'Colores de los terminales en las celdas SSH. El cambio se aplica al instante, también en las sesiones abiertas. Los terminales locales y los agentes mantienen el aspecto de la aplicación, y cada host puede tener su propio tema en su configuración.',
    'Couleurs des terminaux dans les cellules SSH. Le changement s’applique immédiatement, y compris aux sessions ouvertes. Les terminaux locaux et les agents gardent l’apparence de l’application, et chaque hôte peut avoir son propre thème dans ses paramètres.',
    'Cores dos terminais nas células SSH. A alteração aplica-se de imediato, também às sessões abertas. Os terminais locais e os agentes mantêm o aspeto da aplicação, e cada host pode ter o seu próprio tema nas suas definições.',
  ],
  'Motyw terminala': ['Terminal theme', 'Terminal-Design', 'Tema del terminal', 'Thème du terminal', 'Tema do terminal'],
  'Jak w ustawieniach ({name})': ['As in Settings ({name})', 'Wie in den Einstellungen ({name})', 'Como en Ajustes ({name})', 'Comme dans les paramètres ({name})', 'Como nas definições ({name})'],
  'Motyw dla wszystkich hostów zmienisz w Ustawienia > SSH.': [
    'Change the theme of all hosts in Settings > SSH.',
    'Das Design aller Hosts änderst du unter Einstellungen > SSH.',
    'Cambia el tema de todos los hosts en Ajustes > SSH.',
    'Modifiez le thème de tous les hôtes dans Paramètres > SSH.',
    'Altere o tema de todos os hosts em Definições > SSH.',
  ],
} as const;
