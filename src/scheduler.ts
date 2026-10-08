import { createEmptyCard, fsrs, type CardInput, type Grade } from 'ts-fsrs';

const scheduler = fsrs({ enable_fuzz: false });
export function schedule(state: string | null, rating: number, now: Date) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error('Invalid rating');
  const card = state ? JSON.parse(state) as CardInput : createEmptyCard(now);
  const result = scheduler.next(card, now, rating as Grade);
  return { state: JSON.stringify(result.card), due: result.card.due.getTime() };
}
