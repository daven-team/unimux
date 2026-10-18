// The tile rail of the left panel and dropping files and folders onto a cell.
// Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const railMessages = {
  'Panele boczne': ['Side panels', 'Seitenleisten', 'Paneles laterales', 'Panneaux latéraux', 'Painéis laterais'],
  'Kliknij ponownie, aby zwinąć panel': ['Click again to collapse the panel', 'Erneut klicken, um das Panel einzuklappen', 'Haz clic de nuevo para contraer el panel', 'Cliquez à nouveau pour réduire le panneau', 'Clique novamente para recolher o painel'],
  'Upuść, aby dodać ścieżkę': ['Drop to add the path', 'Zum Hinzufügen des Pfads ablegen', 'Suelta para añadir la ruta', 'Déposez pour ajouter le chemin', 'Largue para adicionar o caminho'],
  'Upuść, aby wkleić': ['Drop to paste', 'Zum Einfügen ablegen', 'Suelta para pegar', 'Déposez pour coller', 'Largue para colar'],
  'Komórka nie jest uruchomiona': ['The cell is not running', 'Die Zelle läuft nicht', 'La celda no está en ejecución', 'La cellule n’est pas lancée', 'A célula não está em execução'],
  'Nie dodano ścieżki: komórka nie jest uruchomiona.': [
    'Path not added: the cell is not running.',
    'Pfad nicht hinzugefügt: Die Zelle läuft nicht.',
    'Ruta no añadida: la celda no está en ejecución.',
    'Chemin non ajouté : la cellule n’est pas lancée.',
    'Caminho não adicionado: a célula não está em execução.',
  ],
  'Komórka dopiero się uruchamia - upuść ścieżkę ponownie za chwilę.': [
    'The cell is still starting - drop the path again in a moment.',
    'Die Zelle startet noch - lege den Pfad gleich noch einmal ab.',
    'La celda aún se está iniciando: suelta la ruta de nuevo en un momento.',
    'La cellule démarre encore - déposez le chemin à nouveau dans un instant.',
    'A célula ainda está a iniciar - largue o caminho novamente daqui a pouco.',
  ],
  'Pominięto elementy, których nie można dodać: {count}': [
    'Skipped items that could not be added: {count}',
    'Übersprungene Elemente, die sich nicht hinzufügen lassen: {count}',
    'Elementos omitidos que no se pueden añadir: {count}',
    'Éléments ignorés qui ne peuvent pas être ajoutés : {count}',
    'Itens ignorados que não podem ser adicionados: {count}',
  ],
  'Nie udało się dodać ścieżki.': ['The path could not be added.', 'Der Pfad konnte nicht hinzugefügt werden.', 'No se pudo añadir la ruta.', 'Le chemin n’a pas pu être ajouté.', 'Não foi possível adicionar o caminho.'],
  'Dodaj do rozmowy': ['Add to conversation', 'Zur Unterhaltung hinzufügen', 'Añadir a la conversación', 'Ajouter à la conversation', 'Adicionar à conversa'],
} as const;
