// The find widget inside one file (the code editor, the previews, diffs, tables) and in a terminal cell; the shared words (Znajdź, Zamień, Całe słowa...)
// come from the project-wide find and replace in updateMessages.ts.
// Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const findMessages = {
  'Znajdź w pliku': ['Find in file', 'In Datei suchen', 'Buscar en el archivo', 'Rechercher dans le fichier', 'Localizar no ficheiro'],
  '{current} z {total}': ['{current} of {total}', '{current} von {total}', '{current} de {total}', '{current} sur {total}', '{current} de {total}'],
  'Nieprawidłowe wyrażenie': ['Invalid expression', 'Ungültiger Ausdruck', 'Expresión no válida', 'Expression non valide', 'Expressão inválida'],
  'Poprzednie wystąpienie': ['Previous match', 'Vorheriger Treffer', 'Coincidencia anterior', 'Occurrence précédente', 'Ocorrência anterior'],
  'Następne wystąpienie': ['Next match', 'Nächster Treffer', 'Siguiente coincidencia', 'Occurrence suivante', 'Ocorrência seguinte'],
  'Zamknij wyszukiwanie': ['Close find', 'Suche schließen', 'Cerrar la búsqueda', 'Fermer la recherche', 'Fechar a pesquisa'],
  'Pokaż zamianę': ['Show replace', 'Ersetzen einblenden', 'Mostrar reemplazar', 'Afficher le remplacement', 'Mostrar substituir'],
  'Ukryj zamianę': ['Hide replace', 'Ersetzen ausblenden', 'Ocultar reemplazar', 'Masquer le remplacement', 'Ocultar substituir'],
  'Znajdź w terminalu': ['Find in terminal', 'Im Terminal suchen', 'Buscar en el terminal', 'Rechercher dans le terminal', 'Localizar no terminal'],
} as const satisfies Record<string, readonly [string, string, string, string, string]>;
