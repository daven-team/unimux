// Texts of SFTP (0.9.8): operation and session errors. Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const sftpMessages = {
  'Plik lub folder nie istnieje': ['The file or folder does not exist', 'Die Datei oder der Ordner existiert nicht', 'El archivo o la carpeta no existe', 'Le fichier ou le dossier n\'existe pas', 'O ficheiro ou a pasta não existe'],
  'Element o tej nazwie już istnieje': ['An item with this name already exists', 'Ein Element mit diesem Namen existiert bereits', 'Ya existe un elemento con este nombre', 'Un élément portant ce nom existe déjà', 'Já existe um item com este nome'],
  'Brak uprawnień': ['Permission denied', 'Keine Berechtigung', 'Permiso denegado', 'Autorisation refusée', 'Permissão negada'],
  'Folder nie jest pusty': ['The folder is not empty', 'Der Ordner ist nicht leer', 'La carpeta no está vacía', 'Le dossier n\'est pas vide', 'A pasta não está vazia'],
  'To nie jest folder': ['This is not a folder', 'Das ist kein Ordner', 'No es una carpeta', 'Ce n\'est pas un dossier', 'Isto não é uma pasta'],
  'W miejscu docelowym jest folder': ['There is a folder at the target', 'Am Ziel befindet sich ein Ordner', 'Hay una carpeta en el destino', 'Un dossier se trouve à la destination', 'Existe uma pasta no destino'],
  'Brak miejsca na dysku': ['Not enough disk space', 'Nicht genug Speicherplatz', 'No hay espacio suficiente en el disco', 'Espace disque insuffisant', 'Espaço em disco insuficiente'],
  'Nieprawidłowa ścieżka lub nazwa': ['Invalid path or name', 'Ungültiger Pfad oder Name', 'Ruta o nombre no válido', 'Chemin ou nom non valide', 'Caminho ou nome inválido'],
  'Brak połączenia SFTP': ['No SFTP connection', 'Keine SFTP-Verbindung', 'No hay conexión SFTP', 'Aucune connexion SFTP', 'Sem ligação SFTP'],
  'Zawartość zmieniła się od potwierdzenia - sprawdź ponownie': ['The contents changed since you confirmed - check again', 'Der Inhalt hat sich seit der Bestätigung geändert - bitte erneut prüfen', 'El contenido cambió desde la confirmación - compruébalo de nuevo', 'Le contenu a changé depuis la confirmation - vérifiez à nouveau', 'O conteúdo mudou desde a confirmação - verifique novamente'],
  'Proces SFTP został uruchomiony ponownie': ['The SFTP process was restarted', 'Der SFTP-Prozess wurde neu gestartet', 'El proceso SFTP se reinició', 'Le processus SFTP a été redémarré', 'O processo SFTP foi reiniciado'],
  'Serwer nie obsługuje tej operacji': ['The server does not support this operation', 'Der Server unterstützt diesen Vorgang nicht', 'El servidor no admite esta operación', 'Le serveur ne prend pas en charge cette opération', 'O servidor não suporta esta operação'],
  'Za dużo elementów naraz': ['Too many items at once', 'Zu viele Elemente auf einmal', 'Demasiados elementos a la vez', 'Trop d\'éléments à la fois', 'Demasiados itens de uma vez'],
  'Operacja nie powiodła się': ['The operation failed', 'Der Vorgang ist fehlgeschlagen', 'La operación ha fallado', 'L\'opération a échoué', 'A operação falhou'],
  'Serwer nie udostępnia SFTP': ['The server does not offer SFTP', 'Der Server bietet kein SFTP an', 'El servidor no ofrece SFTP', 'Le serveur ne propose pas SFTP', 'O servidor não disponibiliza SFTP'],
} as const;
