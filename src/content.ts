export interface CardContent { id: string; subject: string; subtopic: string; question: string; answer: string; source: string; learning_order?: number }
export function importSql(input: unknown): string {
  if (!Array.isArray(input) || input.length > 10000) throw new Error('Expected at most 10000 cards');
  const ids = new Set<string>();
  const keys = ['id', 'subject', 'subtopic', 'question', 'answer', 'source'] as const;
  return input.map((c: Record<string, unknown>) => {
    if (!c || keys.some(k => typeof c[k] !== 'string' || !(c[k] as string).trim() || (c[k] as string).includes('\0'))) throw new Error('Every card needs id, subject, subtopic, question, answer and source');
    const card = c as unknown as CardContent;
    if (card.learning_order !== undefined && (!Number.isSafeInteger(card.learning_order) || card.learning_order < 0)) throw new Error('Invalid learning order');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(card.id) || ids.has(card.id)) throw new Error('Invalid or duplicate card ID');
    if (card.question.length > 3000 || card.answer.length > 20000 || card.source.length > 2000 || card.subject.length > 100 || card.subtopic.length > 200) throw new Error('Card text exceeds limits');
    ids.add(card.id);
    const quote = (v: string) => `'${v.replaceAll("'", "''").replaceAll('\r\n', '\n').replaceAll('\n', "' || char(10) || '")}'`;
    return `INSERT INTO cards(id,subject,subtopic,question,answer,source,learning_order) VALUES(${keys.map(k => quote(card[k])).join(',')},${card.learning_order ?? 0}) ON CONFLICT(id) DO UPDATE SET subject=excluded.subject,subtopic=excluded.subtopic,question=excluded.question,answer=excluded.answer,source=excluded.source,learning_order=excluded.learning_order;`;
  }).join('\n');
}
