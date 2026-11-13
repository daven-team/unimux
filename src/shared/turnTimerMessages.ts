// The turn timer of an agent cell (shared/turnTimer.ts): how long the current turn has been working, how long the last one took.
// Registered through statusMessages.ts. Each row: English, German, Spanish, French, Portuguese. Polish is the key.
export const turnTimerMessages = {
  'skończył po {time}': ['finished after {time}', 'fertig nach {time}', 'terminó tras {time}', 'terminé après {time}', 'terminou após {time}'],
  '{name} skończył pracę po {time}': ['{name} finished after {time}', '{name} ist nach {time} fertig', '{name} terminó tras {time}', '{name} a terminé après {time}', '{name} terminou após {time}'],
  '{n} s': ['{n} s', '{n} s', '{n} s', '{n} s', '{n} s'],
  '{h} godz. {m} min': ['{h} h {m} min', '{h} Std. {m} Min.', '{h} h {m} min', '{h} h {m} min', '{h} h {m} min'],
} as const;
