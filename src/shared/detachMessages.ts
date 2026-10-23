// Tabs in their own window (1.0.6): the detached window's title bar, the strip's chips and the menu item.
// Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const detachMessages = {
  'Przenieś do nowego okna': ['Move to new window', 'In neues Fenster verschieben', 'Mover a una ventana nueva', 'Déplacer dans une nouvelle fenêtre', 'Mover para uma nova janela'],
  'Przypnij z powrotem': ['Attach back', 'Wieder andocken', 'Volver a acoplar', 'Rattacher', 'Voltar a anexar'],
  'Przypnij kartę z powrotem do głównego okna': ['Put the tab back into the main window', 'Tab zurück ins Hauptfenster bringen', 'Devolver la pestaña a la ventana principal', 'Remettre l’onglet dans la fenêtre principale', 'Devolver o separador à janela principal'],
  'Przeciągnij na główne okno, aby przypiąć z powrotem': ['Drag onto the main window to attach it back', 'Auf das Hauptfenster ziehen, um es wieder anzudocken', 'Arrastra a la ventana principal para volver a acoplarla', 'Faites glisser sur la fenêtre principale pour la rattacher', 'Arraste para a janela principal para voltar a anexar'],
  'Pokaż okno': ['Show window', 'Fenster zeigen', 'Mostrar la ventana', 'Afficher la fenêtre', 'Mostrar a janela'],
  'Ten grid jest w osobnym oknie.': ['This grid is in its own window.', 'Dieses Grid ist in einem eigenen Fenster.', 'Esta cuadrícula está en su propia ventana.', 'Cette grille est dans sa propre fenêtre.', 'Esta grelha está numa janela própria.'],
  '{name} - w osobnym oknie. Kliknij, aby je pokazać.': ['{name} - in its own window. Click to show it.', '{name} - in einem eigenen Fenster. Klicken, um es zu zeigen.', '{name} - en su propia ventana. Haz clic para mostrarla.', '{name} - dans sa propre fenêtre. Cliquez pour l’afficher.', '{name} - numa janela própria. Clique para a mostrar.'],
  'Ta karta wróciła do głównego okna.': ['This tab is back in the main window.', 'Dieser Tab ist wieder im Hauptfenster.', 'Esta pestaña volvió a la ventana principal.', 'Cet onglet est revenu dans la fenêtre principale.', 'Este separador voltou à janela principal.'],
  'Osobnych okien może być najwyżej {count}.': ['At most {count} separate windows can be open.', 'Höchstens {count} eigene Fenster sind möglich.', 'Puede haber como máximo {count} ventanas separadas.', 'Au plus {count} fenêtres séparées peuvent être ouvertes.', 'Pode haver no máximo {count} janelas separadas.'],
} as const satisfies Record<string, readonly [string, string, string, string, string]>;
