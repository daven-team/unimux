// Texts of the context meter in the card header (shared/contextUsage.ts). Each row: English, German, Spanish, French, Portuguese.
export const contextMessages = {
  'Kontekst {percent}%': ['Context {percent}%', 'Kontext {percent}%', 'Contexto {percent}%', 'Contexte {percent}%', 'Contexto {percent}%'],
  'Kontekst rozmowy: {tokens} / {window} tokenów': ['Conversation context: {tokens} / {window} tokens', 'Gesprächskontext: {tokens} / {window} Token', 'Contexto de la conversación: {tokens} / {window} tokens', 'Contexte de la conversation : {tokens} / {window} jetons', 'Contexto da conversa: {tokens} / {window} tokens'],
  'Model: {model}': ['Model: {model}', 'Modell: {model}', 'Modelo: {model}', 'Modèle : {model}', 'Modelo: {model}'],
  'Kontekst prawie pełny: agent wkrótce go skompaktuje.': ['The context is almost full: the agent will compact it soon.', 'Der Kontext ist fast voll: Der Agent komprimiert ihn bald.', 'El contexto está casi lleno: el agente lo compactará pronto.', 'Le contexte est presque plein : l’agent va bientôt le compacter.', 'O contexto está quase cheio: o agente vai compactá-lo em breve.'],
} as const satisfies Record<string, readonly [string, string, string, string, string]>;
