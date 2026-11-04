// 1.1.4: the coordinator's delegation (Settings > Agenci, the role menu). Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const delegationMessages = {
  'Zespół AI: koordynator': ['AI team: coordinator', 'KI-Team: Koordinator', 'Equipo de IA: coordinador', 'Équipe IA : coordinateur', 'Equipa de IA: coordenador'],
  'Kiedy koordynator tworzy agentów': ['When the coordinator creates agents', 'Wann der Koordinator Agenten erstellt', 'Cuándo crea agentes el coordinador', 'Quand le coordinateur crée des agents', 'Quando o coordenador cria agentes'],
  'Sam, gdy się opłaca': ['On its own, when it pays off', 'Selbst, wenn es sich lohnt', 'Por su cuenta, cuando compensa', 'De lui-même, quand cela vaut la peine', 'Por conta própria, quando compensa'],
  'Tylko na prośbę': ['Only when asked', 'Nur auf Anfrage', 'Solo cuando se pide', 'Seulement sur demande', 'Só quando pedido'],
  'Gdy zadanie jest duże i dzieli się na niezależne części, koordynator sam tworzy zespół albo zleca części istniejącym wykonawcom. Małe zadania robi sam i zawsze mówi, co zlecił. Działa od następnego uruchomienia koordynatora.': [
    'When a task is large and splits into independent parts, the coordinator creates a team itself or hands parts to existing workers. It does small tasks itself and always says what it delegated. Applies from the coordinator\'s next start.',
    'Wenn eine Aufgabe groß ist und sich in unabhängige Teile zerlegen lässt, erstellt der Koordinator selbst ein Team oder gibt Teile an vorhandene Ausführende. Kleine Aufgaben erledigt er selbst und sagt immer, was er delegiert hat. Gilt ab dem nächsten Start des Koordinators.',
    'Cuando una tarea es grande y se divide en partes independientes, el coordinador crea un equipo por su cuenta o encarga partes a ejecutores existentes. Las tareas pequeñas las hace él mismo y siempre dice qué delegó. Se aplica desde el próximo inicio del coordinador.',
    'Quand une tâche est grande et se divise en parties indépendantes, le coordinateur crée lui-même une équipe ou confie des parties aux exécutants existants. Il fait lui-même les petites tâches et dit toujours ce qu\'il a délégué. S\'applique au prochain démarrage du coordinateur.',
    'Quando uma tarefa é grande e se divide em partes independentes, o coordenador cria uma equipa por conta própria ou entrega partes a executores existentes. As tarefas pequenas faz ele mesmo e diz sempre o que delegou. Aplica-se a partir do próximo arranque do coordenador.',
  ],
  'Koordynator tworzy agentów tylko wtedy, gdy o to poprosisz. Działa od następnego uruchomienia koordynatora.': [
    'The coordinator creates agents only when you ask for it. Applies from the coordinator\'s next start.',
    'Der Koordinator erstellt Agenten nur, wenn du darum bittest. Gilt ab dem nächsten Start des Koordinators.',
    'El coordinador crea agentes solo cuando se lo pides. Se aplica desde el próximo inicio del coordinador.',
    'Le coordinateur ne crée des agents que si vous le demandez. S\'applique au prochain démarrage du coordinateur.',
    'O coordenador só cria agentes quando lho pedes. Aplica-se a partir do próximo arranque do coordenador.',
  ],
  'Najwięcej agentów naraz': ['Most agents at once', 'Höchstens Agenten gleichzeitig', 'Máximo de agentes a la vez', 'Agents simultanés au maximum', 'Máximo de agentes em simultâneo'],
  'Ilu agentów koordynator może używać jednocześnie ({min}-{max}). Więcej agentów to szybsza praca i większe zużycie limitów.': [
    'How many agents the coordinator may use at the same time ({min}-{max}). More agents work faster and use more of your limits.',
    'Wie viele Agenten der Koordinator gleichzeitig nutzen darf ({min}-{max}). Mehr Agenten arbeiten schneller und verbrauchen mehr von deinen Limits.',
    'Cuántos agentes puede usar el coordinador a la vez ({min}-{max}). Más agentes trabajan más rápido y gastan más de tus límites.',
    'Combien d\'agents le coordinateur peut utiliser en même temps ({min}-{max}). Plus d\'agents travaillent plus vite et consomment davantage vos limites.',
    'Quantos agentes o coordenador pode usar ao mesmo tempo ({min}-{max}). Mais agentes trabalham mais depressa e gastam mais dos teus limites.',
  ],
  'Koordynator sam deleguje duże zadania (do {max} agentów)': ['The coordinator delegates large tasks on its own (up to {max} agents)', 'Der Koordinator delegiert große Aufgaben selbst (bis zu {max} Agenten)', 'El coordinador delega por su cuenta las tareas grandes (hasta {max} agentes)', 'Le coordinateur délègue lui-même les grandes tâches (jusqu\'à {max} agents)', 'O coordenador delega por conta própria as tarefas grandes (até {max} agentes)'],
  'Koordynator deleguje tylko na prośbę': ['The coordinator delegates only when asked', 'Der Koordinator delegiert nur auf Anfrage', 'El coordinador delega solo cuando se le pide', 'Le coordinateur ne délègue que sur demande', 'O coordenador só delega quando pedido'],
} as const;
